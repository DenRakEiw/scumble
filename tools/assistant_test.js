// The assistant's plain-Node layer (docs/PLAN_ASSISTANT.md §6), no Electron and no key:
//   node tools/assistant_test.js
// Section 1 (step A0) is the MCP server: `createServer()` is the server `serve()` puts on stdio,
// and an in-process client reaches it over a transport pair. What an external agent sees must not
// change, so the last check of the section starts this file again as a child, lets it run the real
// `serve()` on the same fake backend, and compares the two tool lists byte for byte.
//
// The fixture is a hand-written describe() list covering the shapes the real commands have: an
// `object` parameter, an enum, a required parameter, a dotted plugin name, a `doc` parameter and a
// command whose result is a picture.
//
// Sections 2 to 10 run the loop in its Anthropic shape (A1); sections 11 to 15 run it on the seven
// Chat Completions providers (A2), through a scripted `fetch` that answers in each dialect's SSE.
"use strict";

const path = require("node:path");
const { EventEmitter } = require("node:events");

const ROOT = path.join(__dirname, "..");
const { createServer, serve, toTool, toolName } = require(path.join(ROOT, "electron", "main", "mcp", "server.js"));
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const policy = require(path.join(ROOT, "electron", "main", "assistant", "policy.js"));
const models = require(path.join(ROOT, "electron", "main", "assistant", "models.js"));

/** Wait until a condition holds (the loop runs while the test watches). */
async function waitFor(fn, ms = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        if (await fn()) return true;
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("waited in vain");
}

/** The tool_result blocks of the last user message: what the model will read next. */
function lastResults(history) {
    for (let i = history.length - 1; i >= 0; i--) {
        const m = history[i];
        if (m.role === "user" && Array.isArray(m.content) && m.content[0] && m.content[0].type === "tool_result") return m.content;
    }
    return [];
}

/** Where two objects differ, for a failure message that does not print both whole. */
function diffOf(got, want, at = "") {
    if (JSON.stringify(got) === JSON.stringify(want)) return null;
    if (got === null || want === null || typeof got !== "object" || typeof want !== "object") return { at, got, want };
    for (const k of new Set([...Object.keys(got), ...Object.keys(want)])) {
        const d = diffOf(got[k], want[k], at ? at + "." + k : k);
        if (d) return d;
    }
    return { at, got, want };
}

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 400 ? s.slice(0, 400) + " ..." : s; };

async function section(name, fn) {
    console.log(`\n--- ${name} ---`);
    await fn();
}

// ---- the fixture: eight commands with the shapes the real list has ----------------------
const COMMANDS = [
    { name: "ping", description: "Is the editor there.", params: {} },
    { name: "list_layers", description: "The layers of a document.", params: { doc: { type: "integer", description: "document id (default the active tab)" } } },
    {
        name: "select_rect", description: "Select a rectangle.", needsImage: true,
        params: {
            x: { type: "integer", description: "left", required: true },
            y: { type: "integer", description: "top", required: true },
            width: { type: "integer", description: "width", required: true },
            height: { type: "integer", description: "height", required: true },
            mode: { type: "string", description: "how it joins the selection", enum: ["replace", "add", "subtract"], default: "replace" },
        },
    },
    {
        name: "set_layer", description: "Change a layer.",
        params: {
            doc: { type: "integer", description: "document id (default the active tab)" },
            layer: { type: "string", description: "id, name or \"active\"", default: "active" },
            mask: { type: "object", description: "a mask: rows of bytes, or a data URL" },
            visible: { type: "boolean", description: "show it" },
            match: { type: "integer", description: "colour match 0..100" },
            match_source: { type: "string", description: "surroundings or below", enum: ["surroundings", "below"] },
        },
    },
    { name: "screenshot", description: "A JPEG of the image, base64 in `data`.", params: { max_size: { type: "integer", description: "long side", default: 1024 } } },
    { name: "film.apply_look", description: "Apply a film stock.", plugin: "film", needsImage: true, params: { preset: { type: "string", description: "stock id", required: true }, strength: { type: "number", description: "0..100" } } },
    { name: "export", description: "Write the picture to a file.", params: { path: { type: "string", description: "where to write" } } },
    { name: "boom", description: "A command that throws.", params: {} },
];

class FakeBackend extends EventEmitter {
    constructor() { super(); this.calls = []; }
    async describe() { return COMMANDS; }
    async run(name, args) {
        this.calls.push({ name, args });
        if (name === "boom") throw new Error("the command said no");
        if (name === "screenshot") return { data: "QUJD", mime: "image/jpeg", width: 1024, height: 768 };
        if (name === "ping") return { ok: true };
        return { did: name, args };
    }
    info() { return { mode: "test", pid: process.pid }; }
}

// ---- a fake editor: the commands the loop really drives, with a little state --------------
// It answers like renderer/commands.js does: list_layers top first, generate with a `layer`,
// an id that is new every time. The loop's ownership, pin and policy checks run against it.
const EDITOR_COMMANDS = [
    { name: "list_documents", description: "The open tabs.", params: {} },
    { name: "status", description: "What is loaded.", params: { doc: { type: "integer", description: "document id" } } },
    { name: "new_document", description: "A new tab.", params: {} },
    { name: "activate_document", description: "Bring a tab to the front.", params: { doc: { type: "integer", description: "document id", required: true } } },
    { name: "close_document", description: "Close a tab.", params: { doc: { type: "integer", description: "document id" } } },
    { name: "set_prompt", description: "The prompt of a document.", params: { doc: { type: "integer", description: "document id" }, prompt: { type: "string", description: "the text" } } },
    { name: "generate", description: "Render.", params: { doc: { type: "integer", description: "document id" }, timeout: { type: "integer", description: "seconds" } } },
    { name: "generate_new", description: "Render a new base image.", params: { doc: { type: "integer", description: "document id" }, timeout: { type: "integer", description: "seconds" } } },
    { name: "add_paint_layer", description: "A new paint layer.", params: { doc: { type: "integer", description: "document id" }, name: { type: "string", description: "its name" } } },
    { name: "remove_layer", description: "Remove a layer.", params: { doc: { type: "integer", description: "document id" }, layer: { type: "string", description: "id or name" } } },
    { name: "flatten", description: "Flatten every visible layer.", params: { doc: { type: "integer", description: "document id" } } },
    { name: "extend_canvas", description: "Extend or crop the canvas.", params: { doc: { type: "integer", description: "document id" }, left: { type: "integer", description: "px" }, right: { type: "integer", description: "px" } } },
    { name: "select_by_text", description: "Select by text, on ComfyUI.", params: { doc: { type: "integer", description: "document id" }, text: { type: "string", description: "what to select" }, timeout: { type: "integer", description: "seconds" } } },
    { name: "read_log", description: "The app log.", params: { limit: { type: "integer", description: "how many lines" } } },
    { name: "undo", description: "One step back.", params: { doc: { type: "integer", description: "document id" } } },
    { name: "list_commands", description: "Every command.", params: {} },
    { name: "run_action", description: "A plugin action.", params: { action: { type: "string", description: "its id" } } },
    { name: "set_status", description: "The status line.", params: { text: { type: "string", description: "the text" } } },
    { name: "ailabel_add", description: "Add the AI label.", plugin: "ailabel", params: {} },
    { name: "ailabel_remove", description: "Remove the AI label.", plugin: "ailabel", params: {} },
    { name: "ailabel_info", description: "About the AI label.", plugin: "ailabel", params: {} },
    { name: "tint.layer", description: "Tint a layer (a plugin tool with a layer but no doc).", plugin: "tint", params: { layer: { type: "string", description: "id or name" }, amount: { type: "number", description: "0..100" } } },
];

/** The commands the assistant's own list is built from: the shapes fixture plus the editor's. */
const ALL_COMMANDS = COMMANDS.concat(EDITOR_COMMANDS);

class FakeEditor extends EventEmitter {
    constructor(opts = {}) {
        super();
        this.calls = [];
        this.metas = [];
        this.n = 0;
        this.docs = [{ id: 1, name: "Untitled", width: 1200, height: 800, active: true, busy: !!opts.busy }];
        this.layers = new Map([[1, [{ id: "Lbase", name: "Base", active: true, locked: false, visible: true }]]]);
        this.throwOn = opts.throwOn || {};
        this.removeFails = !!opts.removeFails;
        this.onRun = opts.onRun || null;
    }
    newId() { return "L" + (++this.n).toString(36) + "x"; }
    layersOf(doc) { return this.layers.get(Number(doc)) || []; }
    async describe() { return ALL_COMMANDS; }
    info() { return { mode: "assistant", pid: process.pid }; }
    async run(name, args, meta) {
        this.calls.push({ name, args });
        this.metas.push(meta || null);
        if (this.onRun) await this.onRun(name, args, this);
        if (this.throwOn[name]) throw new Error(this.throwOn[name]);
        const doc = args && args.doc !== undefined ? Number(args.doc) : 1;
        switch (name) {
            case "list_documents": return { documents: this.docs };
            case "list_layers": {
                if (!this.docs.some((d) => d.id === doc)) throw new Error("no document with id " + doc);
                return { layers: this.layersOf(doc) };
            }
            case "status": return { width: 1200, height: 800, prompt: "" };
            case "new_document": { const id = this.docs.length + 1; for (const d of this.docs) d.active = false; this.docs.push({ id, name: "Untitled", width: 1200, height: 800, active: true }); this.layers.set(id, [{ id: this.newId(), name: "Base", active: true }]); return { id }; }
            case "activate_document": { for (const d of this.docs) d.active = d.id === doc; return { id: doc }; }
            case "close_document": { this.docs = this.docs.filter((d) => d.id !== doc); this.layers.delete(doc); return { closed: doc }; }
            case "add_paint_layer": { const id = this.newId(); for (const l of this.layersOf(doc)) l.active = false; this.layersOf(doc).unshift({ id, name: args.name || "Paint", active: true }); return { id, name: args.name || "Paint" }; }
            case "generate": { const id = this.newId(); for (const l of this.layersOf(doc)) l.active = false; this.layersOf(doc).unshift({ id, name: "Result 1", kind: "result", active: true }); return { layer: { id, name: "Result 1" }, seconds: 2 }; }
            case "generate_new": return { ok: true };
            case "remove_layer": {
                if (this.removeFails) return { removed: args.layer };
                this.layers.set(doc, this.layersOf(doc).filter((l) => l.id !== args.layer));
                return { removed: args.layer };
            }
            case "set_layer": return { id: args.layer, set: Object.keys(args).filter((k) => k !== "doc" && k !== "layer") };
            case "screenshot": return { data: "QUJD", mime: "image/jpeg", width: 1024, height: 683 };
            case "flatten": return { ok: true };
            case "extend_canvas": return { ok: true };
            case "select_by_text": return { found: 1 };
            case "set_prompt": return { prompt: args.prompt };
            case "read_log": return { entries: [] };
            case "undo": return { ok: true };
            case "ping": return { ok: true };
            default: return { did: name, args };
        }
    }
}

// ---- a scripted model: SSE bodies in the Anthropic shape ----------------------------------

/** A Response as postStream and readSse use it: ok, status, headers, body, text(). A chunk may be a string or bytes. */
function sseResponse(text, opts = {}) {
    const chunks = opts.chunks || [text];
    const body = new ReadableStream({
        start(controller) {
            const enc = new TextEncoder();
            for (const c of chunks) controller.enqueue(typeof c === "string" ? enc.encode(c) : new Uint8Array(c));
            controller.close();
        },
    });
    return {
        ok: opts.status === undefined || opts.status < 400,
        status: opts.status || 200,
        headers: { get: (k) => (opts.headers || {})[String(k).toLowerCase()] || null },
        body,
        text: async () => text,
    };
}

/** The SSE text of an Anthropic answer: text, thinking and tool calls, as the API sends them. */
function anthropicStream(parts, opts = {}) {
    const out = [];
    const push = (event, data) => out.push("event: " + event + "\n" + "data: " + JSON.stringify(data) + "\n\n");
    push("message_start", { type: "message_start", message: { usage: { input_tokens: opts.input || 100, cache_read_input_tokens: opts.cacheRead || 0, cache_creation_input_tokens: opts.cacheWrite || 0, output_tokens: 1 } } });
    parts.forEach((part, index) => {
        if (part.type === "text") {
            push("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
            for (const piece of part.pieces || [part.text]) push("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: piece } });
            push("content_block_stop", { type: "content_block_stop", index });
        } else if (part.type === "thinking") {
            push("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
            push("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: part.text } });
            push("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: part.signature } });
            push("content_block_stop", { type: "content_block_stop", index });
        } else if (part.type === "tool_use") {
            push("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: part.id, name: part.name, input: {} } });
            const json = part.raw !== undefined ? part.raw : JSON.stringify(part.input || {});
            for (const piece of splitJson(json)) push("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: piece } });
            push("content_block_stop", { type: "content_block_stop", index });
        }
    });
    push("message_delta", {
        type: "message_delta",
        delta: { stop_reason: opts.stop || (parts.some((p) => p.type === "tool_use") ? "tool_use" : "end_turn"), ...(opts.stopDetails ? { stop_details: opts.stopDetails } : {}) },
        usage: { output_tokens: opts.output || 20, output_tokens_details: { thinking_tokens: opts.thinking || 0 } },
    });
    push("message_stop", { type: "message_stop" });
    return out.join("");
}

function splitJson(json) {
    if (json.length < 4) return [json];
    const at = Math.floor(json.length / 2);
    return [json.slice(0, at), json.slice(at)];
}

// ---- a scripted model: SSE bodies in the Chat Completions shape ---------------------------

/**
 * The SSE text of a Chat Completions answer as a dialect sends it: a role chunk, text and
 * reasoning deltas (`reasoning_content`, `reasoning` or `reasoning_details`), tool calls in
 * fragments by index or whole in one delta (`whole`, with `object` for an arguments object,
 * `noIndex` for a server that sends none), a raw chunk of the test's own, `finish_reason` and
 * usage in the last chunk with choices (`usageWhere: "last"`), in a last chunk with `choices: []`
 * (`"empty"`, Moonshot) or in both (`"both"`), `: keep-alive` comments (DeepSeek), an error chunk
 * (OpenRouter) and `data: [DONE]`.
 */
function chatStream(parts, opts = {}) {
    const chunks = [];
    const push = (obj) => chunks.push("data: " + JSON.stringify(obj) + "\n\n");
    const wrap = (delta, extra = {}) => ({ id: opts.id || "chatcmpl-1", object: "chat.completion.chunk", created: 1700000000, model: opts.model || "m", choices: [{ index: 0, delta, finish_reason: null, ...extra }] });
    push(wrap({ role: "assistant", content: "" }));
    let hasCalls = false;
    let next = 0;
    for (const part of parts) {
        if (part.type === "text") {
            for (const piece of part.pieces || [part.text]) push(wrap({ content: piece }));
        } else if (part.type === "reasoning") {
            const field = part.field || opts.reasoningField || "reasoning_content";
            if (field === "reasoning_details") push(wrap({ reasoning_details: part.details }));
            else for (const piece of part.pieces || [part.text]) push(wrap({ [field]: piece }));
        } else if (part.type === "tool_call") {
            hasCalls = true;
            const index = part.index !== undefined ? part.index : next++;
            const json = part.raw !== undefined ? part.raw : JSON.stringify(part.input || {});
            const head = { index, id: part.id, type: "function", function: { name: part.name, arguments: "" } };
            if (part.noIndex) delete head.index;
            if (part.id === undefined) delete head.id;
            if (part.whole) {
                head.function.arguments = part.object ? part.input : json;
                push(wrap({ tool_calls: [head] }));
            } else {
                push(wrap({ tool_calls: [head] }));
                for (const piece of splitJson(json)) {
                    const frag = { index, function: { arguments: piece } };
                    if (part.noIndex) delete frag.index;
                    push(wrap({ tool_calls: [frag] }));
                }
            }
        } else if (part.type === "raw") {
            push(part.chunk);
        }
        if (opts.keepAlive) chunks.push(": keep-alive\n\n");
    }
    const finish = opts.finish || (hasCalls ? "tool_calls" : "stop");
    const usage = opts.usage || { prompt_tokens: 100, completion_tokens: 20 };
    const where = opts.usageWhere || "last";
    if (where === "last") push({ ...wrap({}, { finish_reason: finish }), usage });
    else if (where === "choice") push(wrap({}, { finish_reason: finish, usage }));
    else {
        push(wrap({}, { finish_reason: finish }));
        const last = { id: opts.id || "chatcmpl-1", object: "chat.completion.chunk", choices: [], usage };
        if (where === "both") last.choices = [{ index: 0, delta: {}, finish_reason: null, usage }];
        push(last);
    }
    if (opts.errorChunk) push(opts.errorChunk);
    if (!opts.noDone) chunks.push("data: [DONE]\n\n");
    return chunks.join("");
}

/**
 * A fetch that answers the scripted streams in order and records every request. A GET (no body)
 * is answered by `gets(url)` when that gives something, else with an empty `{data: []}` list; the
 * GETs are recorded in `impl.got`.
 */
function scriptedFetch(streams, gets) {
    const sent = [];
    const got = [];
    const queue = streams.slice();
    const impl = async (url, init) => {
        if (!init || init.body === undefined) {
            got.push({ url: String(url), headers: (init && init.headers) || {} });
            const answer = gets ? gets(String(url)) : null;
            if (answer) return answer;
            return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: [] }), text: async () => "{\"data\":[]}" };
        }
        sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
        const next = queue.shift();
        if (next === undefined) throw new Error("the model was called more often than the test scripted");
        if (typeof next === "function") return next(sent[sent.length - 1], sent.length);
        return sseResponse(next);
    };
    impl.sent = sent;
    impl.got = got;
    impl.left = () => queue.length;
    return impl;
}


// ---- a scripted model: SSE bodies in the OpenAI Responses and Gemini shapes ----------------

/**
 * The SSE text of a Responses answer. `parts` are `{type:"reasoning", id?, encrypted}`,
 * `{type:"text", text, pieces?}` and `{type:"function_call", id, callId, name, input|raw}`, in
 * the order the model would emit them. `opts.status` is "completed" (the default), "incomplete"
 * or "failed"; `opts.noEnd` leaves the terminal event out altogether.
 */
function responsesStream(parts, opts = {}) {
    const out = [];
    let seq = 0;
    const ev = (type, data) => out.push("event: " + type + "\n" + "data: " + JSON.stringify({ ...data, type, sequence_number: seq++ }) + "\n\n");
    const items = [];
    ev("response.created", { response: { id: "resp_1", object: "response", status: "in_progress", output: [] } });
    for (const part of parts) {
        const at = items.length;
        if (part.type === "reasoning") {
            const item = { type: "reasoning", id: part.id || "rs_1", encrypted_content: part.encrypted || "enc-1", summary: [] };
            ev("response.output_item.added", { output_index: at, item });
            ev("response.output_item.done", { output_index: at, item });
            items.push(item);
        } else if (part.type === "text" || part.type === "refusal") {
            const id = part.id || "msg_1";
            ev("response.output_item.added", { output_index: at, item: { type: "message", id, status: "in_progress", role: "assistant", content: [] } });
            if (part.type === "text") {
                for (const piece of part.pieces || [part.text]) ev("response.output_text.delta", { item_id: id, output_index: at, content_index: 0, delta: piece });
                ev("response.output_text.done", { item_id: id, output_index: at, content_index: 0, text: part.text });
            }
            const content = part.type === "text"
                ? [{ type: "output_text", text: part.text, annotations: [] }]
                : [{ type: "refusal", refusal: part.refusal || "I cannot help with that." }];
            const item = { type: "message", id, status: "completed", role: "assistant", content };
            ev("response.output_item.done", { output_index: at, item });
            items.push(item);
        } else if (part.type === "function_call") {
            const id = part.id || "fc_1";
            const args = part.raw !== undefined ? part.raw : JSON.stringify(part.input || {});
            ev("response.output_item.added", { output_index: at, item: { type: "function_call", id, call_id: part.callId, name: part.name, arguments: "", status: "in_progress" } });
            for (const piece of splitJson(args)) ev("response.function_call_arguments.delta", { item_id: id, output_index: at, delta: piece });
            ev("response.function_call_arguments.done", { item_id: id, output_index: at, arguments: args });
            const item = { type: "function_call", id, call_id: part.callId, name: part.name, arguments: args, status: "completed" };
            ev("response.output_item.done", { output_index: at, item });
            items.push(item);
        }
    }
    if (opts.noEnd) return out.join("");
    const usage = opts.usage || { input_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 } };
    if (opts.status === "failed") {
        ev("response.failed", { response: { id: "resp_1", status: "failed", error: { code: "server_error", message: "it broke" } } });
    } else if (opts.status === "incomplete") {
        ev("response.incomplete", { response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage, output: items } });
    } else {
        ev("response.completed", { response: { id: "resp_1", object: "response", status: "completed", output: items, usage } });
    }
    return out.join("");
}

/**
 * The SSE text of a Gemini answer: one chunk per part, as `streamGenerateContent?alt=sse` sends
 * them. `parts` are `{type:"signature", signature}`, `{type:"text", text, pieces?}` and
 * `{type:"function_call", id, name, args}`; `opts.finish` is the finishReason (default STOP),
 * `opts.noFinish` leaves it out, `opts.block` is a promptFeedback block.
 */
function geminiStream(parts, opts = {}) {
    const out = [];
    const chunks = [];
    for (const part of parts) {
        if (part.type === "signature") chunks.push({ text: "", thoughtSignature: part.signature });
        else if (part.type === "text") for (const piece of part.pieces || [part.text]) chunks.push({ text: piece });
        else if (part.type === "function_call") chunks.push({ functionCall: { id: part.id, name: part.name, args: part.args || {} } });
    }
    const usage = opts.usage || { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 125 };
    const slots = chunks.length ? chunks : [null];
    slots.forEach((part, i) => {
        const candidate = { content: { role: "model", parts: part ? [part] : [] }, index: 0 };
        const msg = { candidates: [candidate], modelVersion: "gemini-3.8-flash", responseId: "r1" };
        if (i === slots.length - 1) {
            if (!opts.noFinish) candidate.finishReason = opts.finish || "STOP";
            if (opts.block) msg.promptFeedback = { blockReason: opts.block };
            msg.usageMetadata = usage;
        }
        out.push("data: " + JSON.stringify(msg) + "\n\n");
    });
    return out.join("");
}

/** An Assistant on one of the two A3 families (the key row and the model of that provider). */
function familyOn(editor, streams, provider, model, opts = {}) {
    return assistantOn(editor, streams, {
        ...opts,
        keys: { [provider]: `test-${provider}-0000` },
        assistant: { model: `${provider}:${model}`, ...(opts.assistant || {}) },
    });
}

/**
 * An Assistant wired to a fake editor and a scripted model. `opts.key` is the key of every row,
 * `opts.keys` a key per row (a row it lacks has none); `opts.settings` the rest of the settings
 * file (`llm.compat.url`, `toapis.base`); `opts.gets` answers the scripted fetch's GETs.
 */
function assistantOn(editor, streams, opts = {}) {
    const { Assistant } = require(path.join(ROOT, "electron", "main", "assistant", "index.js"));
    const events = [];
    const fetchImpl = typeof streams === "function" ? streams : scriptedFetch(streams, opts.gets);
    const keyOf = (row) => {
        if (opts.keys) return opts.keys[row] === undefined ? "" : opts.keys[row];
        return opts.key === undefined ? "test-anthropic-0000" : opts.key;
    };
    const a = new Assistant({
        bridge: editor,
        keys: { get: keyOf },
        settings: { get: () => ({ ...(opts.settings || {}), assistant: { base: "http://127.0.0.1:5599", ...(opts.assistant || {}) } }) },
        emit: (e) => events.push(e),
        fetchImpl,
        sleep: async () => {},
        createServer, Client, InMemoryTransport,
        version: "0.0.0-test",
        statFile: opts.statFile,
        now: opts.now,
        log: opts.log,
    });
    return { a, events, fetchImpl };
}

/** Answer the ask card that the turn is waiting on, once it appears. */
function answerAsks(a, events, decide) {
    const seen = new Set();
    const timer = setInterval(() => {
        for (const e of events) {
            if (e.type !== "ask" || seen.has(e.call)) continue;
            seen.add(e.call);
            a.answer(e.call, typeof decide === "function" ? decide(e) : !!decide);
        }
    }, 1);
    return () => clearInterval(timer);
}

/** A client connected to createServer() over a transport pair. */
async function connected(backend, opts = {}) {
    const server = createServer(backend, { version: "0.0.0-test", info: () => backend.info(), ...opts });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "assistant-test", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return { server, client, close: async () => { await client.close(); await server.close(); } };
}

// ---- the child that runs the real serve() on the same fixture ---------------------------
if (process.argv.includes("--serve-fixture")) {
    // serve() takes fd 0 and process.stdout: that is the whole point of this mode
    serve(new FakeBackend(), { version: "0.0.0-test", info: () => ({ mode: "test", pid: process.pid }) })
        .catch((err) => { process.stderr.write(String((err && err.stack) || err)); process.exit(1); });
    return;
}

async function main() {
    // ---- 1. the server ------------------------------------------------------------------
    await section("1. the server (A0)", async () => {
        const backend = new FakeBackend();
        const { client, close } = await connected(backend);

        const listed = (await client.listTools()).tools;
        const want = COMMANDS.map(toTool);
        check("create_server_over_memory_lists_what_to_tool_makes",
            eq(listed.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })), want),
            `${listed.length} tools`);
        check("a dotted plugin command is one tool name", listed.some((t) => t.name === "film_apply_look" && /\(plugin film\)/.test(t.description)) && toolName("film.apply_look") === "film_apply_look");
        check("the shapes survive: required, enum, a default in the text, an object parameter",
            eq(listed.find((t) => t.name === "select_rect").inputSchema.required, ["x", "y", "width", "height"])
            && eq(listed.find((t) => t.name === "select_rect").inputSchema.properties.mode.enum, ["replace", "add", "subtract"])
            && /Default: "replace"\./.test(listed.find((t) => t.name === "select_rect").inputSchema.properties.mode.description)
            && listed.find((t) => t.name === "set_layer").inputSchema.properties.mask.type === undefined,
            short(listed.find((t) => t.name === "select_rect").inputSchema.properties.mode));

        const shot = await client.callTool({ name: "screenshot", arguments: { max_size: 512 } });
        check("call_tool_maps_an_image_result_to_image_content",
            shot.content.length === 2 && shot.content[0].type === "image" && shot.content[0].mimeType === "image/jpeg"
            && shot.content[0].data === "QUJD" && shot.content[1].type === "text" && /"width": 1024/.test(shot.content[1].text)
            && !/QUJD/.test(shot.content[1].text) && !shot.isError,
            short(shot.content.map((c) => c.type)));

        const pinged = await client.callTool({ name: "ping", arguments: {} });
        check("ping carries the backend's own info", /"mode": "test"/.test(pinged.content[0].text), short(pinged.content[0].text));

        const boom = await client.callTool({ name: "boom", arguments: {} });
        check("a_thrown_command_comes_back_as_is_error", boom.isError === true && boom.content[0].text === "the command said no", short(boom.content[0].text));

        const unknown = await client.callTool({ name: "not_a_tool", arguments: {} });
        check("an unknown tool is an error result, not a protocol error", unknown.isError === true && /unknown tool "not_a_tool"/.test(unknown.content[0].text), short(unknown.content[0].text));
        await close();
    });

    // ---- the changed listener ------------------------------------------------------------
    await section("1b. the changed listener", async () => {
        const backend = new FakeBackend();
        const before = backend.listenerCount("changed");
        let peak = 0;
        for (let i = 0; i < 20; i++) {
            const s = await connected(backend);
            peak = Math.max(peak, backend.listenerCount("changed"));
            await s.close();
        }
        check("the_changed_listener_is_detached_on_close", backend.listenerCount("changed") === before && peak === before + 1,
            `${before} before, ${peak} while one session was open, ${backend.listenerCount("changed")} after twenty`);

        // and it still does its work while the session is open
        const s = await connected(backend);
        const seen = new Promise((resolve) => { s.client.fallbackNotificationHandler = (n) => { if (n.method === "notifications/tools/list_changed") resolve(true); }; });
        backend.emit("changed");
        const got = await Promise.race([seen, new Promise((r) => setTimeout(() => r(false), 2000))]);
        check("a changed backend tells the client while the session is open", got === true);
        await s.close();
    });

    // ---- serve() against createServer() ---------------------------------------------------
    await section("1c. serve() and createServer()", async () => {
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [path.join(ROOT, "tools", "assistant_test.js"), "--serve-fixture"],
            cwd: ROOT,
        });
        const client = new Client({ name: "assistant-test-stdio", version: "0" }, { capabilities: {} });
        await client.connect(transport);
        const overStdio = (await client.listTools()).tools;
        const info = client.getServerVersion();
        const instructions = client.getInstructions();
        await client.close();

        const backend = new FakeBackend();
        const mem = await connected(backend);
        const overMemory = (await mem.client.listTools()).tools;
        const memInfo = mem.client.getServerVersion();
        const memInstructions = mem.client.getInstructions();
        await mem.close();

        check("serve_and_create_server_list_the_same_tools", eq(overStdio, overMemory), `${overStdio.length} tools over stdio, ${overMemory.length} in memory`);
        check("and the same server name, version and instructions", eq(info, memInfo) && instructions === memInstructions && /^Scumble is a desktop image editor/.test(instructions || ""),
            short({ info, len: (instructions || "").length }));
    });

    // ---- 2. what the family is sent (A1: Anthropic) --------------------------------------
    await section("2. the family's shapes", async () => {
        const editor = new FakeEditor();
        const { a } = assistantOn(editor, [anthropicStream([{ type: "text", text: "done" }])]);
        await a.connect();
        const chat = await a.newChat();

        const served = (await a.client.listTools()).tools.map((t) => t.name).sort();
        const mine = [...chat.names].sort();
        const missing = served.filter((n) => !mine.includes(n));
        check("tools_are_the_mcp_list_minus_the_exclusion_set_without_annotations",
            eq(missing.sort(), [...policy.EXCLUDED].sort()) && chat.tools.every((t) => t.annotations === undefined && t.input_schema),
            `${mine.length} of ${served.length}, missing: ${missing.join(", ")}`);

        const blind = await (async () => {
            // a model whose list says it takes no image (a free OpenRouter id, §2 row 34); the
            // family stays the one A1 built, so this is the rule, not the adapter
            const b = assistantOn(editor, []);
            await b.a.connect();
            const t = b.a.target();
            b.a.target = () => ({ ...t, model: { ...t.model, vision: false } });
            const c = await b.a.newChat();
            await b.a.close();
            return c;
        })();
        check("a_model_without_vision_gets_no_screenshot_tool", !blind.names.has("screenshot") && blind.names.has("list_layers") && /cannot see the picture/.test(blind.system),
            `${blind.names.size} tools`);

        const NAME_RULES = {
            anthropic: /^[a-zA-Z0-9_-]{1,128}$/,
            deepseek: /^[a-zA-Z0-9_-]{1,128}$/,
            moonshot: /^[a-zA-Z_][a-zA-Z0-9-_]{0,127}$/,
            zai: /^[a-zA-Z0-9_-]{1,64}$/,
            openai: /^[a-zA-Z0-9_-]{1,64}$/,
            gemini: /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/,
        };
        const bad = [];
        for (const t of chat.tools) for (const [family, re] of Object.entries(NAME_RULES)) if (!re.test(t.name)) bad.push(`${t.name} fails ${family}`);
        check("every_tool_name_passes_each_familys_rule", !bad.length, bad.join("; ") || `${chat.tools.length} names against six rules`);

        // the golden body: a history with text, a call, an image result, an error result and thinking
        const history = [
            chat.adapter.userMessage("Open documents (1):\n> #1 \"Untitled\", 1200 x 800, active", "look at it"),
            { role: "assistant", content: [
                { type: "thinking", thinking: "I should look.", signature: "sig-abc" },
                { type: "text", text: "Looking." },
                { type: "tool_use", id: "call_1", name: "screenshot", input: { max_size: 1024 } },
                { type: "tool_use", id: "call_2", name: "remove_layer", input: { doc: 1, layer: "Lbase" } },
            ] },
            ...chat.adapter.resultsMessages(
                [{ id: "call_1" }, { id: "call_2" }],
                [
                    { content: [{ type: "image", data: "QUJD", mimeType: "image/jpeg" }, { type: "text", text: "{\"width\": 1024}" }] },
                    { content: [{ type: "text", text: "refused by Scumble: removes a layer you made" }], isError: true },
                ],
            ),
        ];
        const body = chat.adapter._bodyFor(chat, history);
        const golden = {
            model: "claude-sonnet-5",
            max_tokens: 32000,
            stream: true,
            system: [{ type: "text", text: chat.system }],
            tools: chat.tools,
            messages: [
                history[0],
                history[1],
                { role: "user", content: [
                    { type: "tool_result", tool_use_id: "call_1", content: [
                        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
                        { type: "text", text: "{\"width\": 1024}" },
                    ] },
                    { type: "tool_result", tool_use_id: "call_2", content: [{ type: "text", text: "refused by Scumble: removes a layer you made" }], is_error: true },
                ] },
            ],
            cache_control: { type: "ephemeral" },
            output_config: { effort: "medium" },
        };
        check("a_history_with_a_screenshot_has_the_golden_shape", eq(body, golden), short(diffOf(body, golden)));
        check("the image is in the tool_result, and the error result carries is_error",
            body.messages[2].content[0].content[0].source.data === "QUJD" && body.messages[2].content[1].is_error === true);

        const keys = Object.keys(body);
        check("no_sampling_parameter_is_sent",
            !keys.some((k) => ["temperature", "top_p", "top_k", "tool_choice", "parallel_tool_calls", "n", "frequency_penalty", "presence_penalty", "thinking"].includes(k)),
            keys.join(", "));
        await a.close();
    });

    // ---- 3. the loop ---------------------------------------------------------------------
    await section("3. the loop", async () => {
        {
            const editor = new FakeEditor();
            const { a, events } = assistantOn(editor, [
                anthropicStream([{ type: "tool_use", id: "c1", name: "list_layers", input: { doc: 1 } }]),
                anthropicStream([{ type: "text", text: "One layer, the base." }]),
            ]);
            const out = await a.send("what is in the picture?");
            const ran = editor.calls.filter((c) => c.name === "list_layers").length;
            check("one_call_then_text", out.reason === "end" && out.steps === 1 && ran >= 2 && events.some((e) => e.type === "assistant:text" && /One layer/.test(e.text)),
                `${out.reason}, ${out.steps} step, ${ran} list_layers`);
            const at = a.chat.history.findIndex((m) => m.role === "user" && Array.isArray(m.content) && m.content[0] && m.content[0].type === "tool_result");
            check("every call is answered right after the answer that made it",
                at === 2 && a.chat.history[1].role === "assistant" && a.chat.history[at].content[0].tool_use_id === "c1",
                a.chat.history.map((m) => m.role + ":" + (Array.isArray(m.content) ? m.content.map((c) => c.type).join("+") : "?")).join(" | "));
            await a.close();
        }
        {
            const editor = new FakeEditor();
            const { a } = assistantOn(editor, [
                anthropicStream([
                    { type: "tool_use", id: "c1", name: "add_paint_layer", input: { doc: 1, name: "A" } },
                    { type: "tool_use", id: "c2", name: "add_paint_layer", input: { doc: 1, name: "B" } },
                ]),
                anthropicStream([{ type: "text", text: "Two layers." }]),
            ]);
            const out = await a.send("add two layers");
            const names = editor.calls.filter((c) => c.name === "add_paint_layer").map((c) => c.args.name);
            const results = a.chat.history.find((m) => m.role === "user" && Array.isArray(m.content) && m.content[0] && m.content[0].type === "tool_result");
            check("two_calls_in_one_answer_run_in_order_and_answer_in_one_message",
                eq(names, ["A", "B"]) && out.steps === 2 && results.content.length === 2 && eq(results.content.map((c) => c.tool_use_id), ["c1", "c2"]),
                `${names.join(", ")}; ${results.content.length} results in one message`);
            check("the chat owns the layers it made", a.chat.owned.get("1").size === 2, [...a.chat.owned.get("1")].join(", "));
            await a.close();
        }
        {
            const editor = new FakeEditor();
            const { a } = assistantOn(editor, [
                anthropicStream([{ type: "tool_use", id: "c1", name: "not_a_tool", input: {} }]),
                anthropicStream([{ type: "text", text: "sorry" }]),
            ]);
            await a.send("do something odd");
            const result = lastResults(a.chat.history)[0];
            check("an_unknown_tool_is_an_error_result", result.is_error === true && /not one of your tools/.test(result.content[0].text), short(result.content[0].text));
            await a.close();
        }
        {
            const editor = new FakeEditor();
            const { a } = assistantOn(editor, [
                anthropicStream([{ type: "tool_use", id: "c1", name: "ailabel_add", input: {} }]),
                anthropicStream([{ type: "text", text: "ok" }]),
            ]);
            await a.send("add the ai label");
            const result = lastResults(a.chat.history)[0];
            check("a_tool_outside_the_chats_list_is_refused", result.is_error === true && /not one of your tools/.test(result.content[0].text)
                && !editor.calls.some((c) => c.name === "ailabel_add"), short(result.content[0].text));
            await a.close();
        }
        {
            const editor = new FakeEditor();
            const { a, fetchImpl } = assistantOn(editor, [
                anthropicStream([
                    { type: "thinking", text: "The user wants a layer.", signature: "sig-xyz" },
                    { type: "tool_use", id: "c1", name: "add_paint_layer", input: { doc: 1 } },
                ]),
                anthropicStream([{ type: "text", text: "added" }]),
            ]);
            await a.send("add a layer");
            const second = fetchImpl.sent[1].body.messages;
            const assistantMsg = second.find((m) => m.role === "assistant");
            check("thinking_blocks_go_back_unchanged",
                assistantMsg.content[0].type === "thinking" && assistantMsg.content[0].thinking === "The user wants a layer." && assistantMsg.content[0].signature === "sig-xyz",
                short(assistantMsg.content[0]));
            await a.close();
        }
        {
            const editor = new FakeEditor();
            const { a } = assistantOn(editor, [
                anthropicStream([{ type: "tool_use", id: "c1", name: "add_paint_layer", input: { doc: 1 } }], { stop: "max_tokens" }),
            ]);
            const out = await a.send("add a layer");
            const result = lastResults(a.chat.history)[0];
            check("a_cut_off_answer_runs_no_tool", out.reason === "cut" && !editor.calls.some((c) => c.name === "add_paint_layer")
                && /the answer was cut off/.test(result.content[0].text), `${out.reason}`);
            await a.close();
        }
        {
            const editor = new FakeEditor({ throwOn: { flatten: "no image loaded" } });
            const { a, events } = assistantOn(editor, [
                anthropicStream([{ type: "tool_use", id: "c1", name: "flatten", input: { doc: 1 } }]),
                anthropicStream([{ type: "tool_use", id: "c2", name: "flatten", input: { doc: 1 } }]),
                anthropicStream([{ type: "tool_use", id: "c3", name: "flatten", input: { doc: 1 } }]),
                anthropicStream([{ type: "text", text: "I give up." }]),
            ]);
            const stop = answerAsks(a, events, true);
            await a.send("flatten it");
            stop();
            const tried = editor.calls.filter((c) => c.name === "flatten").length;
            const last = lastResults(a.chat.history)[0];
            check("the_same_failing_call_is_not_run_a_third_time", tried === 2 && /failed twice/.test(last.content[0].text), `${tried} tries; ${short(last.content[0].text)}`);
            await a.close();
        }
        {
            const editor = new FakeEditor({ throwOn: { list_documents: "the window reloaded" } });
            const { a } = assistantOn(editor, []);
            await a.connect();
            a.chat = await a.newChat();
            const before = JSON.stringify(a.chat.history);
            const out = await a.send("hello");
            check("a_failed_read_at_send_leaves_the_history_unchanged", out.reason === "error" && JSON.stringify(a.chat.history) === before, `${out.reason}: ${out.detail}`);
            await a.close();
        }
        {
            const editor = new FakeEditor();
            const { a } = assistantOn(editor, [
                anthropicStream([{ type: "tool_use", id: "c1", name: "add_paint_layer", input: { doc: 7 } }]),
                anthropicStream([{ type: "text", text: "no such tab" }]),
            ]);
            await a.send("add a layer to tab 7");
            const result = lastResults(a.chat.history)[0];
            check("a_failed_pre_call_read_answers_that_call", result.is_error === true && /could not read the document/.test(result.content[0].text), short(result.content[0].text));
            await a.close();
        }
        {
            const editor = new FakeEditor();
            const { a, events } = assistantOn(editor, [
                anthropicStream([{ type: "tool_use", id: "c1", name: "close_document", input: { doc: 1 } }]),
                anthropicStream([{ type: "text", text: "closed" }]),
            ]);
            const stop = answerAsks(a, events, true);
            const out = await a.send("close the tab");
            stop();
            const after = editor.calls.slice(editor.calls.findIndex((c) => c.name === "close_document"));
            // the assistant closing the pin does not end the turn; it only drops the pin, so a
            // later call has to pass `doc` itself (§3)
            check("close_document_gets_no_after_read", !after.some((c) => c.name === "list_layers") && out.reason === "end", `${out.reason}; after: ${after.map((c) => c.name).join(", ")}`);
            await a.close();
        }
        {
            const editor = new FakeEditor({ removeFails: true });
            editor.layers.get(1).unshift({ id: "Lmine", name: "Result 1", active: true, locked: true });
            const { a, events } = assistantOn(editor, [
                anthropicStream([{ type: "tool_use", id: "c1", name: "remove_layer", input: { doc: 1, layer: "Lmine" } }]),
                anthropicStream([{ type: "text", text: "it stayed" }]),
            ]);
            const stop = answerAsks(a, events, true);
            await a.send("remove the result");
            stop();
            const result = lastResults(a.chat.history)[0];
            check("a_layer_still_there_after_remove_layer_is_reported_not_removed", /not removed; the layer may be locked/.test(result.content[0].text), short(result.content[0].text));
            await a.close();
        }
        {
            const editor = new FakeEditor();
            const { a } = assistantOn(editor, [anthropicStream([{ type: "text", text: "hello" }])]);
            await a.send("hello");
            check("the_state_note_reads_no_status", !editor.calls.some((c) => c.name === "status"), editor.calls.map((c) => c.name).join(", "));
            const note = a.chat.history[0].content[0].text;
            check("the state note names the open documents and the pinned one", /Open documents \(1\)/.test(note) && /> #1/.test(note), short(note));
            await a.close();
        }
        {
            const editor = new FakeEditor();
            const { a } = assistantOn(editor, [
                anthropicStream([{ type: "tool_use", id: "c1", name: "add_paint_layer", raw: "{not json", input: {} }]),
                anthropicStream([{ type: "text", text: "sorry" }]),
            ]);
            await a.send("add a layer");
            const result = lastResults(a.chat.history)[0];
            check("bad_json_arguments_come_back_as_an_error", result.is_error === true && /not valid JSON/.test(result.content[0].text), short(result.content[0].text));
            await a.close();
        }
    });

    // ---- 10. the stream ------------------------------------------------------------------
    await section("10. the stream", async () => {
        const { readSse } = require(path.join(ROOT, "electron", "main", "assistant", "sse.js"));
        const collect = async (text, chunks) => {
            const out = [];
            const res = sseResponse(text, chunks ? { chunks } : {});
            const done = await readSse(res.body, { onEvent: (e) => out.push(e), idleMs: 0 });
            return { out, done };
        };

        const one = anthropicStream([{ type: "text", text: "hello" }]);
        const whole = await collect(one);
        let sameEverywhere = true;
        for (let at = 1; at < one.length; at++) {
            const cut = await collect(one, [one.slice(0, at), one.slice(at)]);
            if (!eq(cut.out, whole.out)) { sameEverywhere = false; check("cut at " + at + " differs", false, short(cut.out.slice(0, 2))); break; }
        }
        check("a_stream_cut_at_every_byte_offset_rebuilds_the_same_message", sameEverywhere, `${one.length} offsets, ${whole.out.length} events each`);

        const withComments = ": keep-alive\n\n" + one + ": keep-alive\n\n";
        const kept = await collect(withComments);
        check("keep_alive_comments_are_skipped", eq(kept.out, whole.out), `${kept.out.length} events`);

        const crlf = one.replace(/\n/g, "\r\n");
        const read = await collect(crlf);
        check("crlf_lines_are_read", eq(read.out, whole.out), `${read.out.length} events`);

        const noBlank = await collect("data: {\"a\":1}\n\ndata: {\"b\":2}\n");
        const noNewline = await collect("data: {\"a\":1}\n\ndata: {\"b\":2}");
        check("a_last_event_without_a_blank_line_is_read",
            noBlank.out.length === 2 && eq(noBlank.out[1], { event: "message", data: "{\"b\":2}" })
            && noNewline.out.length === 2 && eq(noNewline.out[1], { event: "message", data: "{\"b\":2}" }),
            `${noBlank.out.length} with a newline, ${noNewline.out.length} without one`);

        const withDone = "data: {\"a\":1}\n\ndata: [DONE]\n\ndata: {\"b\":2}\n\n";
        const ended = await collect(withDone);
        check("done_ends_the_stream", ended.out.length === 1 && ended.done.done === true, short(ended.out));

        {
            const editor = new FakeEditor();
            const broken = anthropicStream([{ type: "text", text: "hi" }]).split("event: message_delta")[0]
                + "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"overloaded\"}}\n\n";
            const { a } = assistantOn(editor, [broken]);
            const out = await a.send("hello");
            check("a_mid_stream_error_ends_the_call", out.reason === "error" && /overloaded/.test(out.detail), `${out.reason}: ${out.detail}`);
            await a.close();
        }
        {
            const editor = new FakeEditor();
            const { a, events } = assistantOn(editor, [anthropicStream([{ type: "text", text: "", pieces: ["Hel", "lo ", "there"] }])]);
            await a.send("hello");
            const deltas = events.filter((e) => e.type === "text_delta").map((e) => e.text);
            check("text_deltas_reach_the_panel_before_the_end", eq(deltas, ["Hel", "lo ", "there"]), deltas.join("|"));
            await a.close();
        }
        {
            // the idle watchdog, on a stream that never ends
            let release;
            const stuck = new ReadableStream({ start(controller) { const enc = new TextEncoder(); controller.enqueue(enc.encode(": hello\n\n")); release = () => controller.close(); } });
            const t0 = Date.now();
            let message = "";
            try { await readSse(stuck, { idleMs: 120, onEvent: () => {} }); } catch (err) { message = err.message; }
            try { release(); } catch (_) { /* the reader closed it when the watchdog fired */ }
            check("an_idle_stream_ends_after_its_watchdog", /sent nothing for/.test(message) && Date.now() - t0 < 3000, `${message} after ${Date.now() - t0} ms`);
        }
    });

    // ---- 4. stop, caps and timeouts -------------------------------------------------------
    await section("4. stop, caps and timeouts", async () => {
        {
            // Stop while a tool call is in flight: every open call still gets an answer
            const editor = new FakeEditor();
            let release;
            const held = new Promise((r) => { release = r; });
            editor.onRun = async (name) => { if (name === "add_paint_layer") await held; };
            const { a } = assistantOn(editor, [
                anthropicStream([
                    { type: "tool_use", id: "c1", name: "add_paint_layer", input: { doc: 1 } },
                    { type: "tool_use", id: "c2", name: "add_paint_layer", input: { doc: 1 } },
                ]),
            ]);
            const turn = a.send("add two layers");
            await waitFor(() => editor.calls.some((c) => c.name === "add_paint_layer"));
            a.stop();
            release();
            const out = await turn;
            const answered = lastResults(a.chat.history);
            check("stop_during_a_tool_call_answers_every_call",
                out.reason === "stopped" || answered.length === 2,
                `${out.reason}, ${answered.length} results`);
            await a.close();
        }
        {
            // Stop in the middle of a stream: nothing is appended, and the next text carries the note.
            // The body hands over its first chunk and then waits, so the stream is open at the stop.
            const editor = new FakeEditor();
            const one = anthropicStream([{ type: "text", text: "thinking about it" }]);
            let opened = null;
            const held = new Promise((r) => { opened = r; });
            let stopping = true;
            const { a } = assistantOn(editor, async () => {
                if (!stopping) return sseResponse(one);
                const body = new ReadableStream({
                    async start(controller) {
                        const enc = new TextEncoder();
                        controller.enqueue(enc.encode(one.slice(0, 60)));
                        opened();
                        await held;
                        controller.close();
                    },
                });
                return { ok: true, status: 200, headers: { get: () => null }, body, text: async () => one };
            });
            await a.connect();
            a.chat = await a.newChat();
            const turn = a.send("hello");
            await held;
            a.stop();
            const out = await turn;
            const assistantMessages = a.chat.history.filter((m) => m.role === "assistant").length;
            check("stop_mid_stream_appends_nothing_and_the_next_text_carries_the_note",
                out.reason === "stopped" && assistantMessages === 0 && a.chat.stopped === true,
                `${out.reason}, ${assistantMessages} assistant messages`);

            stopping = false;
            a.deps.fetchImpl = scriptedFetch([anthropicStream([{ type: "text", text: "ok" }])]);
            await a.send("carry on");
            const users = a.chat.history.filter((m) => m.role === "user");
            check("the next user text joins the pending message with the note",
                users.length === 1 && users[0].content.filter((p) => /stopped before it finished/.test(p.text || "")).length === 1,
                `${users.length} user messages`);
            await a.close();
        }
        {
            // the step cap: every call still answered, the history valid
            const editor = new FakeEditor();
            const streams = [];
            for (let i = 0; i < 5; i++) streams.push(anthropicStream([{ type: "tool_use", id: "s" + i, name: "add_paint_layer", input: { doc: 1 } }]));
            const { a } = assistantOn(editor, streams, { assistant: { maxSteps: 3 } });
            const out = await a.send("add layers until I say stop");
            const last = a.chat.history[a.chat.history.length - 1];
            check("the_step_cap_ends_the_turn_with_a_valid_history",
                out.reason === "cap" && out.steps === 3 && last.role === "user" && last.content[0].type === "tool_result",
                `${out.reason} after ${out.steps} steps`);
            await a.close();
        }
        {
            const editor = new FakeEditor();
            const { a } = assistantOn(editor, [anthropicStream([{ type: "text", text: "hi" }])], { assistant: { base: "http://127.0.0.1:5599" } });
            check("a_partial_assistant_setting_keeps_the_defaults", a.settings().maxSteps === 25 && a.settings().keepImages === 3 && a.settings().maxTokens === 32000,
                JSON.stringify(a.settings()));
            await a.close();
        }
        {
            // the timeouts a call is sent with
            const editor = new FakeEditor();
            const { a, events } = assistantOn(editor, [
                anthropicStream([{ type: "tool_use", id: "c1", name: "generate", input: { doc: 1 } }]),
                anthropicStream([{ type: "tool_use", id: "c2", name: "generate", input: { doc: 1, timeout: 1e9 } }]),
                anthropicStream([{ type: "text", text: "done" }]),
            ]);
            await a.connect();
            const seen = [];
            const real = a.client.callTool.bind(a.client);
            a.client.callTool = (req, schema, opts) => { seen.push({ name: req.name, args: req.arguments, timeout: opts && opts.timeout }); return real(req, schema, opts); };
            const stop = answerAsks(a, events, true);
            await a.send("render it twice");
            stop();
            const gen = seen.filter((x) => x.name === "generate");
            check("a_generate_gets_a_timeout_above_the_bridges_limit",
                gen.length === 2 && gen.every((g) => g.timeout >= (120 + 600 + 600) * 1000),
                gen.map((g) => `${g.args.timeout}s -> ${g.timeout}ms`).join(", "));
            check("a_huge_timeout_is_clamped_to_3600", gen[1].args.timeout === 3600, String(gen[1].args.timeout));
            await a.close();
        }
        {
            // the user closes the pinned document while the turn runs
            const editor = new FakeEditor();
            editor.onRun = async (name) => { if (name === "add_paint_layer") { editor.docs = []; editor.layers.clear(); } };
            const { a } = assistantOn(editor, [
                anthropicStream([{ type: "tool_use", id: "c1", name: "add_paint_layer", input: { doc: 1 } }, { type: "tool_use", id: "c2", name: "add_paint_layer", input: { doc: 1 } }]),
            ]);
            const out = await a.send("add two layers");
            const answers = lastResults(a.chat.history);
            check("a_closed_pinned_document_ends_the_turn",
                out.reason === "closed" && answers.length === 2 && /was closed/.test(answers[1].content[0].text),
                `${out.reason}: ${short(answers.map((x) => x.content[0].text))}`);
            await a.close();
        }
    });

    // ---- 5. retries -----------------------------------------------------------------------
    await section("5. retries", async () => {
        const { postStream } = require(path.join(ROOT, "electron", "main", "assistant", "http.js"));
        const run = async (answers, opts = {}) => {
            const tries = [];
            const waits = [];
            const impl = async () => {
                const next = answers[Math.min(tries.length, answers.length - 1)];
                tries.push(next);
                return sseResponse(next.body || "", { status: next.status, headers: next.headers });
            };
            let err = null;
            try {
                await postStream("http://127.0.0.1:5599/v1/messages", {}, { a: 1 }, {
                    fetchImpl: impl, sleep: async (ms) => waits.push(ms), key: "test-k", keys: ["test-k"], ...opts,
                });
            } catch (e) { err = e; }
            return { tries: tries.length, waits, err };
        };

        const r429 = await run([{ status: 429, headers: { "retry-after": "3" } }, { status: 200 }]);
        check("a_429_with_retry_after_is_retried", r429.tries === 2 && r429.waits[0] === 3000 && !r429.err, `${r429.tries} tries, waited ${r429.waits}`);

        const r529 = await run([{ status: 529 }, { status: 200 }]);
        check("a_529_is_retried", r529.tries === 2 && r529.waits[0] === 2000, `${r529.tries} tries, waited ${r529.waits}`);

        const r400 = await run([{ status: 400, body: "bad request" }]);
        check("a_400_is_not_retried", r400.tries === 1 && /HTTP 400/.test(r400.err.message), r400.err && r400.err.message);

        const r402 = await run([{ status: 402, body: "no credit" }]);
        check("a_402_is_not_retried", r402.tries === 1 && /HTTP 402/.test(r402.err.message), r402.err && r402.err.message);

        const zai = await run([{ status: 429, body: JSON.stringify({ error: { code: "1113" } }) }], { noRetry: (status, body) => /"1113"|"1301"/.test(String(body)) });
        check("a_z_ai_empty_balance_is_not_retried", zai.tries === 1, `${zai.tries} tries`);

        const moon = await run([{ status: 429, body: JSON.stringify({ error: { type: "exceeded_current_quota_error" } }) }], { noRetry: (status, body) => /exceeded_current_quota_error/.test(String(body)) });
        check("a_moonshot_empty_balance_is_not_retried", moon.tries === 1, `${moon.tries} tries`);

        const overloaded = await run([{ status: 429, body: JSON.stringify({ error: { type: "engine_overloaded_error" } }) }, { status: 200 }], { noRetry: (status, body) => /exceeded_current_quota_error/.test(String(body)) });
        check("a_moonshot_overload_is_retried", overloaded.tries === 2, `${overloaded.tries} tries`);

        const capped = await run([{ status: 429, headers: { "retry-after": "120" } }]);
        check("a_retry_after_above_a_minute_is_not_waited_out", capped.tries === 1 && /asked to wait 120 s/.test(capped.err.message), capped.err && capped.err.message);

        {
            // a stream that breaks after its first byte is not retried: the model call is over
            const editor = new FakeEditor();
            const head = anthropicStream([{ type: "text", text: "hi" }]).slice(0, 120);
            let calls = 0;
            const { a } = assistantOn(editor, async () => { calls++; return sseResponse(head); });
            const out = await a.send("hello");
            check("a_stream_broken_after_its_first_byte_is_not_retried", calls === 1 && out.reason === "error" && /before the answer was finished/.test(out.detail) && a.chat.history.length === 1,
                `${calls} model calls, turn ${out.reason}: ${out.detail}, ${a.chat.history.length} messages`);
            await a.close();
        }
        {
            // a tool call that throws is never run again by the loop
            const editor = new FakeEditor({ throwOn: { add_paint_layer: "the editor said no" } });
            const { a } = assistantOn(editor, [
                anthropicStream([{ type: "tool_use", id: "c1", name: "add_paint_layer", input: { doc: 1 } }]),
                anthropicStream([{ type: "text", text: "it failed" }]),
            ]);
            await a.send("add a layer");
            check("a_tool_call_is_never_retried", editor.calls.filter((c) => c.name === "add_paint_layer").length === 1,
                `${editor.calls.filter((c) => c.name === "add_paint_layer").length} attempts`);
            await a.close();
        }
    });

    // ---- 6. the policy and the pin --------------------------------------------------------
    await section("6. the policy and the pin", async () => {
        const facts = (extra = {}) => ({
            tools: new Set(ALL_COMMANDS.map((c) => c.name.replace(/[^A-Za-z0-9_-]/g, "_")).filter((n) => !policy.EXCLUDED.has(n))),
            owned: new Set(["Lmine"]),
            layers: [
                { id: "Lmine", name: "Result 1", active: true },
                { id: "Lyours", name: "Sketch", active: false },
                { id: "Llocked", name: "Locked", active: false, locked: true },
                { id: "Lbase", name: "Base", active: false },
            ],
            ...extra,
        });
        const act = (name, args, extra) => policy.decide({ name, args: args || {} }, facts(extra)).action;
        const rows = [
            ["ping", {}, "auto"], ["list_layers", {}, "auto"], ["status", {}, "auto"], ["screenshot", {}, "auto"],
            ["select_rect", { x: 1, y: 1, width: 10, height: 10 }, "auto"], ["select_point", {}, "auto"],
            ["select_by_text", { text: "sky" }, "ask"],
            ["set_prompt", { prompt: "a cat" }, "auto"], ["set_generation", {}, "auto"], ["set_settings", {}, "auto"],
            ["add_paint_layer", {}, "auto"], ["add_filter", {}, "auto"], ["add_text", {}, "auto"],
            ["set_layer", { layer: "Lmine", opacity: 50 }, "auto"],
            ["set_layer", { layer: "Lyours", opacity: 50 }, "ask"],
            ["set_layer", { layer: "Lmine", match: 60, match_source: "below" }, "auto"],
            ["set_layer", { layer: "Lyours", match: 60 }, "ask"],
            ["set_layer", { layer: "Lyours", x: 10 }, "auto"],
            ["set_layer", { layer: "Llocked", x: 10 }, "ask"],
            ["set_layer", { layer: "Lmine", locked: false }, "ask"],
            ["set_layer", { layer: "Lmine", locked: true }, "auto"],
            ["set_text", { layer: "Lmine", text: "hi" }, "auto"],
            ["set_text", { layer: "Lyours", text: "hi" }, "ask"],
            ["set_text", { layer: "Llocked", text: "hi" }, "ask"],
            ["set_filter", { layer: "Lyours", params: { amount: 3 } }, "auto"],
            ["remove_layer", { layer: "Lmine" }, "auto"],
            ["remove_layer", { layer: "Lyours" }, "ask"],
            ["merge_down", { layer: "Lmine" }, "ask"],
            ["flatten", {}, "ask"],
            ["extend_canvas", { left: 100 }, "ask"],
            ["extend_canvas", { left: -100 }, "ask"],
            ["glb_edit", { layer: "Lmine", depth_layer: false }, "auto"],
            ["glb_edit", { layer: "Lyours", depth_layer: false }, "ask"],
            ["add_image_layer", { filename: "x.png" }, "auto"],
            ["add_image_layer", { path: "C:/x.png" }, "ask"],
            ["cutout_layer", {}, "ask"], ["upsample_prompt", {}, "ask"],
            ["generate", {}, "ask"], ["generate_new", {}, "ask"],
            ["load_image", {}, "ask"], ["new_canvas", {}, "ask"], ["close_document", {}, "ask"],
            ["new_document", {}, "auto"], ["activate_document", { doc: 2 }, "auto"],
            ["undo", {}, "ask"], ["redo", {}, "ask"],
            ["select_recipe", { id: "x" }, "ask"], ["set_node_params", {}, "ask"],
            ["set_brush", { size: 20 }, "auto"], ["set_brush", { spacing: 30 }, "ask"],
            ["compare", {}, "auto"], ["film_apply_look", { preset: "x" }, "auto"], ["film_add_point", {}, "auto"],
            ["a_user_plugins_tool", {}, "ask"],
        ];
        const wrong = [];
        for (const [name, args, want] of rows) {
            const f = facts();
            f.tools.add(name);
            const got = policy.decide({ name, args }, f).action;
            if (got !== want) wrong.push(`${name}(${JSON.stringify(args)}): ${got}, wanted ${want}`);
        }
        check("every_row_of_the_table", !wrong.length, wrong.join("; ") || `${rows.length} rows`);

        check("a_busy_document_refuses_a_run", policy.decide({ name: "generate", args: {} }, facts({ busy: true })).action === "refuse");
        check("export_without_a_path_is_refused", policy.decide({ name: "export", args: {} }, facts()).action === "refuse");
        check("an_export_whose_extension_disagrees_is_refused",
            policy.decide({ name: "export", args: { path: "C:/a.jpg", format: "png" } }, facts({ file: { ext: ".jpg", exists: false } })).action === "refuse"
            && policy.decide({ name: "export", args: { path: "C:/a.png", format: "png" } }, facts({ file: { ext: ".png", exists: false } })).action === "ask");
        check("screenshot_max_size_is_clamped", eq(policy.clamp({ name: "screenshot", args: { max_size: 4096, quality: 0.99 } }).args, { max_size: 1024, quality: 0.85 }));
        {
            const readOnly = ["ping", "list_documents", "list_recipes", "list_plugins", "list_layers", "list_brush_tips", "status", "get_state", "filter_types", "screenshot"];
            const f = facts();
            for (const n of readOnly) f.tools.add(n);
            const asks = readOnly.filter((n) => policy.decide({ name: n, args: {} }, f).action !== "auto");
            check("read_only_hinted_tools_never_ask", !asks.length, asks.join(", ") || `${readOnly.length} tools`);
        }
        check("every_excluded_name_is_a_live_tool_and_none_is_sent",
            [...policy.EXCLUDED].every((n) => ALL_COMMANDS.some((c) => c.name.replace(/[^A-Za-z0-9_-]/g, "_") === n)),
            [...policy.EXCLUDED].join(", "));

        const steps = [
            ["add_paint_layer", {}, "layers"], ["add_filter", {}, "layers"], ["generate", {}, "layers"],
            ["set_layer", { match: 60 }, "match"], ["set_layer", { match: 60, match_source: "below" }, "match"],
            ["set_layer", { match: 60, opacity: 50 }, "layers"], ["set_layer", { x: 10 }, null],
            ["set_filter", { params: { a: 1 } }, "filter"], ["set_filter", { type: "blur", params: { a: 1 } }, null],
            ["set_text", { text: "x" }, "text"], ["set_prompt", { prompt: "x" }, null],
            ["list_layers", {}, null], ["screenshot", {}, null],
        ];
        const badSteps = [];
        for (const [name, args, want] of steps) {
            const got = policy.undoStep({ name, args }, { layers: facts().layers });
            if (got !== want) badSteps.push(`${name}: ${got}, wanted ${want}`);
        }
        check("undo_steps_are_named_for_the_calls_that_push_none", !badSteps.length, badSteps.join("; ") || `${steps.length} calls`);

        {
            // the leading example: three regions, one ask each, and the match on the chat's own result
            const editor = new FakeEditor();
            const { a, events } = assistantOn(editor, [
                anthropicStream([{ type: "tool_use", id: "c1", name: "select_rect", input: { doc: 1, x: 10, y: 10, width: 50, height: 50 } }]),
                anthropicStream([{ type: "tool_use", id: "c2", name: "set_prompt", input: { doc: 1, prompt: "a red door" } }]),
                anthropicStream([{ type: "tool_use", id: "c3", name: "generate", input: { doc: 1 } }]),
                anthropicStream([{ type: "tool_use", id: "c4", name: "screenshot", input: { doc: 1 } }]),
                anthropicStream([{ type: "tool_use", id: "c5", name: "set_layer", input: { doc: 1, layer: "active", match: 70, match_source: "surroundings" } }]),
                anthropicStream([{ type: "text", text: "Done: one result, matched." }]),
            ]);
            const stop = answerAsks(a, events, true);
            const out = await a.send("inpaint the marked area on its own layer and match the colours");
            stop();
            const asked = events.filter((e) => e.type === "ask").map((e) => e.name);
            const result = editor.layers.get(1).find((l) => l.kind === "result");
            const matched = editor.calls.find((c) => c.name === "set_layer");
            check("the_leading_example_asks_only_for_generate", eq(asked, ["generate"]) && out.reason === "end", asked.join(", ") || "nothing asked");
            check("the_call_sends_the_id_the_policy_decided_on", matched && matched.args.layer === result.id, matched && matched.args.layer);
            check("a_layer_reference_is_resolved_to_an_id_before_the_policy", matched.args.layer !== "active");
            await a.close();
        }
        {
            // a declined call skips the rest of its step
            const editor = new FakeEditor();
            const { a, events } = assistantOn(editor, [
                anthropicStream([
                    { type: "tool_use", id: "c1", name: "flatten", input: { doc: 1 } },
                    { type: "tool_use", id: "c2", name: "add_paint_layer", input: { doc: 1 } },
                ]),
                anthropicStream([{ type: "text", text: "understood" }]),
            ]);
            const stop = answerAsks(a, events, false);
            await a.send("flatten and add a layer");
            stop();
            const answers = lastResults(a.chat.history);
            check("a_declined_call_skips_the_rest_of_its_step",
                /the user declined/.test(answers[0].content[0].text) && /skipped: an earlier call/.test(answers[1].content[0].text)
                && !editor.calls.some((c) => c.name === "add_paint_layer"),
                short(answers.map((x) => x.content[0].text)));
            await a.close();
        }
        {
            // the pin: a document tool gets it, new_document moves it, and after a close a call needs doc
            const editor = new FakeEditor();
            const { a, events } = assistantOn(editor, [
                anthropicStream([{ type: "tool_use", id: "c1", name: "add_paint_layer", input: {} }]),
                anthropicStream([{ type: "tool_use", id: "c2", name: "new_document", input: {} }]),
                anthropicStream([{ type: "tool_use", id: "c3", name: "add_paint_layer", input: {} }]),
                anthropicStream([{ type: "text", text: "two tabs" }]),
            ]);
            const stop = answerAsks(a, events, true);
            await a.send("add a layer, then a new tab with a layer");
            stop();
            const added = editor.calls.filter((c) => c.name === "add_paint_layer");
            check("a_document_tool_gets_the_pinned_doc", added[0].args.doc === 1, JSON.stringify(added[0].args));
            check("new_document_moves_the_pin", added[1].args.doc === 2, JSON.stringify(added[1].args));
            await a.close();
        }
        {
            const editor = new FakeEditor();
            const { a, events } = assistantOn(editor, [
                anthropicStream([{ type: "tool_use", id: "c1", name: "close_document", input: { doc: 1 } }]),
                anthropicStream([{ type: "tool_use", id: "c2", name: "add_paint_layer", input: {} }]),
                anthropicStream([{ type: "text", text: "no tab" }]),
            ]);
            const stop = answerAsks(a, events, true);
            await a.send("close the tab and add a layer");
            stop();
            const answers = lastResults(a.chat.history);
            check("after_closing_the_pin_a_call_without_doc_is_refused", /was closed; pass doc/.test(answers[0].content[0].text), short(answers[0].content[0].text));
            await a.close();
        }
        {
            // ownership rule (c) on its own: an id an earlier read of this chat saw is never the
            // chat's, even when the tool names it and it is new against this call's own read. That
            // is the layer the user deleted and brought back with Ctrl+Z while the turn ran.
            const editor = new FakeEditor();
            editor.layersOf(1).unshift({ id: "Lghost", name: "Sketch", active: false });
            const ghost = { id: "Lghost", name: "Sketch", active: false };
            editor.onRun = async (name, args, ed) => {
                if (name === "add_paint_layer") ed.layersOf(1).push(ghost);       // the user pressed Ctrl+Z
            };
            const { a } = assistantOn(editor, [
                anthropicStream([{ type: "tool_use", id: "c0", name: "list_layers", input: { doc: 1 } }]),
                anthropicStream([{ type: "tool_use", id: "c1", name: "add_paint_layer", input: { doc: 1 } }]),
                anthropicStream([{ type: "text", text: "added" }]),
            ]);
            await a.connect();
            const real = editor.run.bind(editor);
            editor.run = async (name, args, meta) => {
                const out = await real(name, args, meta);
                if (name === "add_paint_layer") {
                    editor.layers.set(1, editor.layersOf(1).filter((l) => l.id !== out.id));   // the layer it made is gone again
                    return { id: "Lghost", name: "Sketch" };                                   // and it names the restored one
                }
                return out;
            };
            // the first read sees Lghost; then the user deletes it, before the call
            const removeGhost = async () => { editor.layers.set(1, editor.layersOf(1).filter((l) => l.id !== "Lghost")); };
            const realRun = editor.run;
            let first = true;
            editor.run = async (name, args, meta) => {
                const out = await realRun(name, args, meta);
                if (name === "list_layers" && first) { first = false; await removeGhost(); }
                return out;
            };
            await a.send("look, then add a layer");
            const owned = [...a.setOf(a.chat.owned, 1)];
            check("a_layer_the_reads_had_seen_is_not_owned", !owned.includes("Lghost"), owned.join(", ") || "owns nothing");
            await a.close();
        }
        {
            // Stop that lands after the stream finished but before the loop goes on: still nothing
            // is appended, and the turn ends stopped
            const editor = new FakeEditor();
            const one = anthropicStream([{ type: "tool_use", id: "c1", name: "add_paint_layer", input: { doc: 1 } }]);
            let a2 = null;
            const { a } = assistantOn(editor, async () => {
                if (a2 && a2.turn) a2.turn.stopped = true;          // the user pressed Stop as the last byte arrived
                return sseResponse(one);
            });
            a2 = a;
            const out = await a.send("add a layer");
            check("a_stop_right_after_the_stream_appends_nothing",
                out.reason === "stopped" && !a.chat.history.some((m) => m.role === "assistant") && !editor.calls.some((c) => c.name === "add_paint_layer"),
                `${out.reason}, ${a.chat.history.length} messages`);
            await a.close();
        }
        {
            // a layer the user brought back with undo is not the chat's
            const editor = new FakeEditor();
            editor.onRun = async (name, args, ed) => {
                if (name === "undo") ed.layersOf(1).unshift({ id: "Lrestored", name: "Back again", active: true });
            };
            const { a, events } = assistantOn(editor, [
                anthropicStream([{ type: "tool_use", id: "c1", name: "undo", input: { doc: 1 } }]),
                anthropicStream([{ type: "text", text: "undone" }]),
            ]);
            const stop = answerAsks(a, events, true);
            await a.send("undo");
            stop();
            check("a_layer_restored_by_undo_is_not_owned", !a.setOf(a.chat.owned, 1).has("Lrestored"), [...a.setOf(a.chat.owned, 1)].join(", ") || "owns nothing");
            await a.close();
        }
    });

    // ---- 7. images ------------------------------------------------------------------------
    await section("7. images", async () => {
        const editor = new FakeEditor();
        const { a, fetchImpl } = assistantOn(editor, [
            anthropicStream([{ type: "tool_use", id: "c1", name: "screenshot", input: { doc: 1 } }]),
            anthropicStream([{ type: "text", text: "I see it." }]),
        ]);
        await a.send("look at it");
        const results = lastResults(a.chat.history)[0];
        check("a screenshot goes into the tool_result as an image block",
            results.content[0].type === "image" && results.content[0].source.media_type === "image/jpeg" && results.content[0].source.data === "QUJD",
            short(results.content.map((c) => c.type)));
        check("the second request carries the image", JSON.stringify(fetchImpl.sent[1].body).includes("QUJD"));

        // pruning: only at a user message, and only above 2 x keepImages
        const many = [];
        for (let i = 0; i < 8; i++) many.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i, content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "IMG" + i } }] }] });
        const pruned = a.chat.adapter.prune(JSON.parse(JSON.stringify(many)), 3);
        const left = JSON.stringify(pruned).match(/IMG\d/g) || [];
        check("old_screenshots_are_detached_only_at_a_user_message", left.length === 3 && eq(left, ["IMG5", "IMG6", "IMG7"]), left.join(", "));
        const kept = a.chat.adapter.prune(JSON.parse(JSON.stringify(many)), 0);
        check("with_keep_images_0_every_screenshot_stays", (JSON.stringify(kept).match(/IMG\d/g) || []).length === 8);
        const mixed = JSON.parse(JSON.stringify(many));
        mixed[0].content[0].content.push({ type: "text", text: "{\"width\": 1024}" });
        check("count_images_counts_the_images_alone", a.chat.adapter.countImages(mixed) === 8 && a.chat.adapter.countImages(pruned) === 3,
            `${a.chat.adapter.countImages(mixed)} with a text part, ${a.chat.adapter.countImages(pruned)} after pruning`);
        await a.close();

        {
            // a request over the cap is not sent
            const editor2 = new FakeEditor();
            const { a: a2, fetchImpl: f2 } = assistantOn(editor2, [anthropicStream([{ type: "text", text: "hi" }])]);
            await a2.connect();
            a2.chat = await a2.newChat();
            a2.chat.history.push({ role: "user", content: [{ type: "text", text: "x".repeat(25 * 1024 * 1024) }] });
            const out = await a2.send("and now?");
            check("a_request_over_24_mb_is_not_sent", out.reason === "full" && f2.sent.length === 0, `${out.reason}: ${out.detail}`);
            await a2.close();
        }
    });

    // ---- 8. keys --------------------------------------------------------------------------
    await section("8. keys", async () => {
        const http = require(path.join(ROOT, "electron", "main", "assistant", "http.js"));
        const editor = new FakeEditor();
        const { a, fetchImpl } = assistantOn(editor, [anthropicStream([{ type: "text", text: "hi" }])]);
        await a.send("hello");
        const headers = fetchImpl.sent[0].headers;
        check("each_family_sends_the_key_in_its_header_only",
            headers["x-api-key"] === "test-anthropic-0000" && headers["anthropic-version"] === "2023-06-01"
            && !headers.Authorization && !JSON.stringify(fetchImpl.sent[0].body).includes("test-anthropic-0000"),
            Object.keys(headers).join(", "));
        check("the_loopback_base_keeps_each_providers_path", fetchImpl.sent[0].url === "http://127.0.0.1:5599/v1/messages", fetchImpl.sent[0].url);
        await a.close();

        check("the_base_accepts_loopback_only",
            http.loopbackBase("http://127.0.0.1:5599") === "http://127.0.0.1:5599"
            && http.loopbackBase("https://api.anthropic.com") === null
            && http.loopbackBase("http://127.0.0.1:5599/path") === null
            && http.loopbackBase("http://10.0.0.5:5599") === null);

        {
            const editor2 = new FakeEditor();
            const { a: a2, fetchImpl: f2 } = assistantOn(editor2, [anthropicStream([{ type: "text", text: "hi" }])], { key: "sk-ant-real-key-000" });
            let message = "";
            try { await a2.send("hello"); } catch (err) { message = err.message; }
            check("a_real_key_never_goes_to_the_test_base", /test keys only/.test(message) && f2.sent.length === 0, message);
            await a2.close();
        }
        {
            const editor3 = new FakeEditor();
            const { a: a3, fetchImpl: f3 } = assistantOn(editor3, [anthropicStream([{ type: "text", text: "hi" }])], { assistant: { base: "" } });
            let message = "";
            try { await a3.send("hello"); } catch (err) { message = err.message; }
            check("a_test_key_never_goes_to_a_real_host", /test key goes to the test endpoint only/.test(message) && f3.sent.length === 0, message);
            let direct = "";
            try { await http.postStream("https://api.anthropic.com/v1/messages", {}, {}, { key: "test-k", fetchImpl: async () => { direct = "sent"; } }); } catch (err) { direct = err.message; }
            check("http.js refuses it on its own too", /test key goes to the test endpoint only/.test(direct), direct);
            await a3.close();
        }
        {
            const editor4 = new FakeEditor();
            const { a: a4 } = assistantOn(editor4, [], { key: "" });
            let message = "";
            try { await a4.send("hello"); } catch (err) { message = err.message; }
            check("a_missing_key_names_the_provider_and_where_to_add_it", /No API key for Anthropic\. Add it under Settings . API providers\./.test(message), message);
            await a4.close();
        }
        check("an_error_that_echoes_the_key_is_scrubbed",
            http.scrub("HTTP 401: bad key test-anthropic-0000 (test-anthropic-0000)", ["test-anthropic-0000"]) === "HTTP 401: bad key <key> (<key>)");
        check("compat_base_follows_llm_js",
            http.compatBase("http://localhost:11434") === "http://localhost:11434/v1"
            && http.compatBase("http://localhost:1234/v1/") === "http://localhost:1234/v1"
            && http.compatBase("http://x/v2") === "http://x/v2");
    });

    // ---- 9. cost --------------------------------------------------------------------------
    await section("9. cost", async () => {
        const usage = { input: 1000000, cacheRead: 1000000, cacheWrite: 0, output: 1000000, reasoning: 500000 };
        const sonnet = models.costOf("anthropic", "claude-sonnet-5", usage);
        check("usage_is_normalised_and_priced", Math.abs(sonnet.amount - (2 + 10 + 0.2)) < 1e-9, JSON.stringify(sonnet));

        const peak = models.costOf("deepseek", "deepseek-flash", { input: 1000000, output: 0 }, Date.UTC(2026, 8, 21, 2, 0));    // a Monday, 02:00 UTC
        const off = models.costOf("deepseek", "deepseek-flash", { input: 1000000, output: 0 }, Date.UTC(2026, 8, 21, 12, 0));
        check("deepseek_is_priced_by_the_hour", Math.abs(peak.amount - 0.3) < 1e-9 && Math.abs(off.amount - 0.15) < 1e-9 && /peak price/.test(peak.note),
            `${peak.amount} at peak, ${off.amount} off peak`);

        const short_ = models.costOf("openai", "gpt-5.6-terra", { input: 100000, output: 1000 });
        const long = models.costOf("openai", "gpt-5.6-terra", { input: 300000, output: 1000 });
        check("openai_long_context_is_priced_above_272k",
            Math.abs(short_.amount - (0.1 * 2 + 0.001 * 12)) < 1e-9 && Math.abs(long.amount - (0.3 * 4 + 0.001 * 18)) < 1e-9,
            `${short_.amount} short, ${long.amount} long`);

        const or = models.costOf("openrouter", "anthropic/claude-sonnet-5", { input: 100, output: 10, cost: 0.0123 });
        check("openrouter_takes_usage_cost", or.amount === 0.0123 && /as OpenRouter reported/.test(or.note), JSON.stringify(or));

        const moon = models.costOf("moonshot", "kimi-k3", { input: 1000000, output: 0, cacheWrite: 500000 });
        check("moonshot_cache_writes_are_counted", Math.abs(moon.amount - 3) < 1e-9 && /cache writes are billed, price not published/.test(moon.note), JSON.stringify(moon));

        const unknown = models.costOf("anthropic", "claude-nope-9", usage);
        check("an_unknown_model_has_no_price", unknown.amount === null && /no published price/.test(unknown.note), JSON.stringify(unknown));

        const local = models.costOf("compat", "llama", usage);
        check("a local model costs nothing", local.amount === 0 && local.note === "local");
    });

    // ---- 11. the Chat Completions dialects: the shapes (A2) -------------------------------
    const CHAT = [
        { provider: "openrouter", model: "anthropic/claude-sonnet-5", key: "test-or-0000", path: "/api/v1/chat/completions" },
        { provider: "deepseek", model: "deepseek-flash", key: "test-ds-0000", path: "/chat/completions" },
        { provider: "moonshot", model: "kimi-k3", key: "test-ms-0000", path: "/v1/chat/completions" },
        { provider: "zai", model: "glm-5.3-flash", key: "test-zai-0000", path: "/api/paas/v4/chat/completions" },
        { provider: "toapis", model: "claude-sonnet-5", key: "test-toapis-0000", path: "/v1/chat/completions" },
        { provider: "wavespeed", model: "anthropic/claude-sonnet-5", key: "test-ws-0000", path: "/v1/chat/completions" },
        { provider: "compat", model: "llama3.2-vision", key: "", path: "/v1/chat/completions" },
    ];
    const LOCAL = { llm: { compat: { url: "http://127.0.0.1:11434" } } };
    /** An Assistant on one Chat Completions provider, the test base in front of it. */
    const chatOn = (editor, streams, p, extra = {}) => assistantOn(editor, streams, {
        key: p.key, ...extra,
        assistant: { model: `${p.provider}:${p.model}`, ...(extra.assistant || {}) },
        settings: { ...LOCAL, ...(extra.settings || {}) },
    });
    const orHosts = require(path.join(ROOT, "electron", "main", "providers", "openrouter.js"));
    /** The reasoning part of a scripted answer, in the dialect's field. */
    const reasoningPart = (p, text) => (p.provider === "openrouter"
        ? { type: "reasoning", field: "reasoning_details", details: [{ type: "reasoning.text", text, format: "unknown", index: 0 }] }
        : { type: "reasoning", text });

    await section("11. the Chat Completions dialects: the shapes", async () => {
        const chatAdapter = require(path.join(ROOT, "electron", "main", "assistant", "chat.js"));
        const note = "Open documents (1):\n> #1 \"Untitled\", 1200 x 800, active";
        const IMAGE = { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } };
        const bad = [];
        for (const p of CHAT) {
            const editor = new FakeEditor();
            const { a } = chatOn(editor, [], p);
            await a.connect();
            const chat = await a.newChat();
            chat.ignore = ["alibaba", "baidu"];

            // the tools: function objects with the MCP schema as parameters, strict:false on Moonshot only
            const served = (await a.client.listTools()).tools.filter((t) => !policy.EXCLUDED.has(t.name));
            const shape = chat.tools.every((t) => t.type === "function" && t.function.name && typeof t.function.description === "string"
                && eq(t.function.parameters, served.find((s) => s.name === t.function.name).inputSchema) && t.annotations === undefined && t.function.annotations === undefined);
            const strict = p.provider === "moonshot" ? chat.tools.every((t) => t.function.strict === false) : chat.tools.every((t) => t.function.strict === undefined);
            if (!shape || !strict || chat.tools.length !== served.length) bad.push(`${p.provider}: tools`);

            // the golden body: text, a call, an image result, an error result and the dialect's reasoning field
            const reasoning = p.provider === "openrouter"
                ? { reasoning_details: [{ type: "reasoning.text", text: "I should look.", format: "anthropic-claude-v1", index: 0 }] }
                : { reasoning_content: "I should look." };
            const history = [
                chat.adapter.userMessage(note, "look at it"),
                { role: "assistant", content: "Looking.", ...reasoning, tool_calls: [
                    { id: "call_1", type: "function", function: { name: "screenshot", arguments: "{\"max_size\":1024}" } },
                    { id: "call_2", type: "function", function: { name: "remove_layer", arguments: "{\"doc\":1,\"layer\":\"Lbase\"}" } },
                ] },
                ...chat.adapter.resultsMessages(
                    [{ id: "call_1" }, { id: "call_2" }],
                    [
                        { content: [{ type: "image", data: "QUJD", mimeType: "image/jpeg" }, { type: "text", text: "{\"width\": 1024}" }] },
                        { content: [{ type: "text", text: "refused by Scumble: removes a layer you made" }], isError: true },
                    ],
                    chat,
                ),
            ];
            const tail = p.provider === "moonshot"
                ? [
                    { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "{\"width\": 1024}" }, IMAGE] },
                    { role: "tool", tool_call_id: "call_2", content: "Error: refused by Scumble: removes a layer you made" },
                ]
                : [
                    { role: "tool", tool_call_id: "call_1", content: "{\"width\": 1024}\nThe screenshot follows in the next message." },
                    { role: "tool", tool_call_id: "call_2", content: "Error: refused by Scumble: removes a layer you made" },
                    { role: "user", content: [{ type: "text", text: "Screenshot from call call_1" }, IMAGE] },
                ];
            const messages = [
                { role: "system", content: chat.system },
                { role: "user", content: [{ type: "text", text: note }, { type: "text", text: "look at it" }] },
                history[1],
                ...tail,
            ];
            const TOP = {
                openrouter: { model: "anthropic/claude-sonnet-5", messages, tools: chat.tools, stream: true, max_tokens: 32000,
                    reasoning: { effort: "medium" }, session_id: chat.id, provider: { data_collection: "deny", ignore: ["alibaba", "baidu"] }, cache_control: { type: "ephemeral" } },
                deepseek: { model: "deepseek-flash", messages, tools: chat.tools, stream: true, max_tokens: 32000,
                    thinking: { type: "enabled" }, reasoning_effort: "high", stream_options: { include_usage: true } },
                moonshot: { model: "kimi-k3", messages, tools: chat.tools, stream: true, max_completion_tokens: 32000,
                    reasoning_effort: "high", stream_options: { include_usage: true } },
                zai: { model: "glm-5.3-flash", messages, tools: chat.tools, stream: true, max_tokens: 32000,
                    thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "high", tool_stream: true },
                toapis: { model: "claude-sonnet-5", messages, tools: chat.tools, stream: true, max_tokens: 32000, stream_options: { include_usage: true } },
                wavespeed: { model: "anthropic/claude-sonnet-5", messages, tools: chat.tools, stream: true, max_tokens: 32000, stream_options: { include_usage: true } },
                compat: { model: "llama3.2-vision", messages, tools: chat.tools, stream: true, max_tokens: 32000, stream_options: { include_usage: true } },
            };
            const body = chat.adapter._bodyFor(chat, history);
            check(`${p.provider}_history_with_a_screenshot_has_the_golden_shape`, eq(body, TOP[p.provider]), short(diffOf(body, TOP[p.provider])));
            const keys = Object.keys(body);
            if (keys.some((k) => ["temperature", "top_p", "top_k", "tool_choice", "parallel_tool_calls", "n", "frequency_penalty", "presence_penalty", "seed", "logprobs"].includes(k))) bad.push(`${p.provider}: ${keys.join(",")}`);
            await a.close();
        }
        check("chat_tools_are_function_objects_with_strict_false_on_moonshot_only", !bad.some((b) => /tools/.test(b)), bad.join("; ") || `${CHAT.length} dialects`);
        check("no_sampling_parameter_is_sent_on_any_dialect", !bad.some((b) => !/tools/.test(b)), bad.join("; ") || `${CHAT.length} bodies`);

        {
            // Kimi K2.6 takes the other thinking switch of the same provider
            const editor = new FakeEditor();
            const { a } = chatOn(editor, [], { provider: "moonshot", model: "kimi-k2.6", key: "test-ms-0000" });
            await a.connect();
            const chat = await a.newChat();
            const body = chat.adapter._bodyFor(chat, []);
            check("kimi_k2_6_sends_its_own_thinking_switch", eq(body.thinking, { type: "enabled", keep: "all" }) && body.reasoning_effort === undefined && body.max_completion_tokens === 32000,
                short({ thinking: body.thinking, reasoning_effort: body.reasoning_effort }));
            await a.close();
        }
        {
            // the top-level cache_control goes to anthropic/* models on OpenRouter and to no other
            const bodies = {};
            for (const model of ["google/gemini-3.8-flash", "openai/gpt-5.6-terra", "anthropic/claude-opus-5"]) {
                const editor = new FakeEditor();
                const { a } = chatOn(editor, [], { provider: "openrouter", model, key: "test-or-0000" });
                await a.connect();
                const chat = await a.newChat();
                bodies[model] = chat.adapter._bodyFor(chat, []).cache_control;
                await a.close();
            }
            check("openrouter_cache_control_goes_to_anthropic_models_only",
                bodies["google/gemini-3.8-flash"] === undefined && bodies["openai/gpt-5.6-terra"] === undefined && eq(bodies["anthropic/claude-opus-5"], { type: "ephemeral" }), short(bodies));
        }
        {
            // a text-only result, an empty result and a long one
            const msgs = chatAdapter.resultsMessages([{ id: "a" }, { id: "b" }, { id: "c" }], [
                { content: [{ type: "text", text: "{\"ok\":true}" }] },
                { content: [] },
                { content: [{ type: "text", text: "x".repeat(40000) }] },
            ], { dialect: {} });
            check("text_results_are_plain_strings_and_an_empty_one_says_ok",
                msgs.length === 3 && msgs[0].content === "{\"ok\":true}" && msgs[1].content === "ok" && /cut after 32000 characters/.test(msgs[2].content) && msgs[2].content.length < 32100,
                `${msgs.length} messages, ${msgs[2].content.length} chars`);
            const only = chatAdapter.resultsMessages([{ id: "a" }], [{ content: [{ type: "image", data: "QUJD", mimeType: "image/jpeg" }] }], { dialect: { imagesInToolMessage: true } });
            check("an_image_only_result_still_carries_text_inline", only.length === 1 && eq(only[0].content, [{ type: "text", text: "ok" }, IMAGE]), short(only[0].content));
        }
    });

    // ---- 12. the dialects run the loop ----------------------------------------------------
    await section("12. the dialects run the loop", async () => {
        const chatAdapter = require(path.join(ROOT, "electron", "main", "assistant", "chat.js"));
        {
            const wrong = [];
            for (const p of CHAT) {
                orHosts._resetHosts();
                const editor = new FakeEditor();
                const { a, events, fetchImpl } = chatOn(editor, [
                    chatStream([reasoningPart(p, "hm"), { type: "tool_call", id: "c1", name: "list_layers", input: { doc: 1 } }]),
                    chatStream([{ type: "text", text: "One layer." }]),
                ], p);
                const out = await a.send("what is in the picture?");
                const second = fetchImpl.sent[1] && fetchImpl.sent[1].body.messages;
                const asst = second && second.find((m) => m.role === "assistant");
                const tool = second && second.find((m) => m.role === "tool");
                const back = p.provider === "openrouter"
                    ? eq(asst && asst.reasoning_details, [{ type: "reasoning.text", text: "hm", format: "unknown", index: 0 }]) && asst.reasoning_content === undefined
                    : asst && asst.reasoning_content === "hm" && asst.reasoning_details === undefined;
                const ok = out.reason === "end" && out.steps === 1 && fetchImpl.sent.length === 2
                    && fetchImpl.sent[0].url === "http://127.0.0.1:5599" + p.path
                    && asst && asst.content === "" && eq(asst.tool_calls, [{ id: "c1", type: "function", function: { name: "list_layers", arguments: "{\"doc\":1}" } }])
                    && tool && tool.tool_call_id === "c1" && /"layers"/.test(tool.content) && second.indexOf(tool) === second.indexOf(asst) + 1
                    && back && events.some((e) => e.type === "assistant:text" && /One layer/.test(e.text))
                    && a.chat.usage.input === 200 && a.chat.usage.output === 40
                    && (p.provider !== "compat" || events.filter((e) => e.type === "note").length === 1)
                    && (p.provider === "compat" || !events.some((e) => e.type === "note"));
                if (!ok) wrong.push(`${p.provider}: ${out.reason} ${out.detail} url=${fetchImpl.sent[0] && fetchImpl.sent[0].url} asst=${short(asst)} tool=${short(tool)} usage=${short(a.chat.usage)}`);
                await a.close();
            }
            check("every_chat_dialect_runs_the_loop", !wrong.length, wrong.join(" | ") || `${CHAT.length} dialects, one call then text each`);
        }
        {
            // DeepSeek: reasoning_content on every assistant message of the chat, earlier turns included
            const p = CHAT[1];
            const editor = new FakeEditor();
            const { a, fetchImpl } = chatOn(editor, [
                chatStream([{ type: "reasoning", text: "r1" }, { type: "tool_call", id: "c1", name: "list_layers", input: { doc: 1 } }]),
                chatStream([{ type: "reasoning", pieces: ["r", "2"] }, { type: "text", text: "done" }]),
                chatStream([{ type: "text", text: "ok" }]),                  // no reasoning came
                chatStream([{ type: "text", text: "still here" }]),
            ], p);
            await a.send("look");
            await a.send("thanks");
            await a.send("again");
            const asst = fetchImpl.sent[3].body.messages.filter((m) => m.role === "assistant");
            check("reasoning_content_goes_back_on_every_assistant_message",
                asst.length === 3 && asst[0].reasoning_content === "r1" && asst[0].tool_calls.length === 1 && asst[1].reasoning_content === "r2" && asst[1].content === "done"
                && asst[2].reasoning_content === "" && asst[2].content === "ok",
                asst.map((m) => JSON.stringify(m.reasoning_content)).join(", "));
            await a.close();
        }
        {
            // OpenRouter: reasoning_details as they came, in order, an encrypted block included
            const p = CHAT[0];
            const editor = new FakeEditor();
            const d1 = [{ type: "reasoning.text", text: "I ", format: "anthropic-claude-v1", index: 0 }];
            const d2 = [{ type: "reasoning.text", text: "look.", format: "anthropic-claude-v1", index: 0 }, { type: "reasoning.encrypted", data: "[REDACTED]", id: "rs_1", format: "openai-responses-v1", index: 1 }];
            const d3 = [{ type: "reasoning.encrypted", data: "ENCRYPTEDBYTES", id: "rs_1", format: "openai-responses-v1", index: 1 }];
            const { a, fetchImpl } = chatOn(editor, [
                chatStream([
                    { type: "reasoning", field: "reasoning_details", details: d1 },
                    { type: "reasoning", field: "reasoning_details", details: d2 },
                    { type: "reasoning", field: "reasoning_details", details: d3 },
                    { type: "tool_call", id: "c1", name: "list_layers", input: { doc: 1 } },
                ]),
                chatStream([{ type: "text", text: "ok" }]),
            ], p);
            await a.send("look");
            const asst = fetchImpl.sent[1].body.messages.find((m) => m.role === "assistant");
            check("openrouter_reasoning_details_go_back_unmodified", eq(asst.reasoning_details, [...d1, ...d2, ...d3]) && asst.reasoning_content === undefined && asst.reasoning === undefined,
                short(asst.reasoning_details));
            await a.close();
        }
        {
            // ToAPIs ("any"): whatever reasoning field came goes back
            const p = CHAT[4];
            const editor = new FakeEditor();
            const { a, fetchImpl } = chatOn(editor, [
                chatStream([{ type: "reasoning", field: "reasoning", text: "thinking..." }, { type: "tool_call", id: "c1", name: "list_layers", input: { doc: 1 } }]),
                chatStream([{ type: "text", text: "ok" }]),
            ], p);
            await a.send("look");
            const asst = fetchImpl.sent[1].body.messages.find((m) => m.role === "assistant");
            check("a_gateway_sends_back_whichever_reasoning_field_came", asst.reasoning === "thinking..." && asst.reasoning_content === undefined, short(asst));
            await a.close();
            const details = [{ type: "reasoning.encrypted", data: "ENC", id: "rs_9", format: "openai-responses-v1", index: 0 }];
            const back = [];
            for (const q of [CHAT[4], CHAT[6]]) {
                const ed = new FakeEditor();
                const { a: b, fetchImpl: f } = chatOn(ed, [
                    chatStream([{ type: "reasoning", field: "reasoning_details", details }, { type: "tool_call", id: "c1", name: "list_layers", input: { doc: 1 } }]),
                    chatStream([{ type: "text", text: "ok" }]),
                ], q);
                await b.send("look");
                back.push(f.sent[1].body.messages.find((m) => m.role === "assistant").reasoning_details);
                await b.close();
            }
            check("a_gateway_sends_back_reasoning_details_as_they_came", back.length === 2 && back.every((d) => eq(d, details)), short(back));
        }
        {
            // two calls whose fragments interleave, by index
            const p = CHAT[1];
            const editor = new FakeEditor();
            const wrap = (delta) => ({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] });
            const raw = (delta) => ({ type: "raw", chunk: wrap(delta) });
            const { a, fetchImpl } = chatOn(editor, [
                chatStream([
                    raw({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "add_paint_layer", arguments: "" } }] }),
                    raw({ tool_calls: [{ index: 1, id: "c2", type: "function", function: { name: "add_paint_layer", arguments: "" } }] }),
                    raw({ tool_calls: [{ index: 0, function: { arguments: "{\"doc\":1," } }] }),
                    raw({ tool_calls: [{ index: 1, function: { arguments: "{\"doc\":1,\"na" } }] }),
                    raw({ tool_calls: [{ index: 0, function: { arguments: "\"name\":\"A\"}" } }] }),
                    raw({ tool_calls: [{ index: 1, function: { arguments: "me\":\"B\"}" } }] }),
                ]),
                chatStream([{ type: "text", text: "two" }]),
            ], p);
            const out = await a.send("two layers");
            const names = editor.calls.filter((c) => c.name === "add_paint_layer").map((c) => c.args.name);
            const tools = fetchImpl.sent[1].body.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
            check("tool_call_fragments_are_joined_by_index", eq(names, ["A", "B"]) && out.steps === 2 && eq(tools, ["c1", "c2"]), `${names.join(",")}; ${tools.join(",")}`);
            await a.close();
        }
        {
            // Z.ai without tool_stream: the whole call in one delta, and arguments as an object
            const p = CHAT[3];
            const editor = new FakeEditor();
            const { a, fetchImpl } = chatOn(editor, [
                chatStream([{ type: "tool_call", id: "c1", name: "add_paint_layer", input: { doc: 1, name: "W" }, whole: true }]),
                chatStream([{ type: "tool_call", id: "c2", name: "add_paint_layer", input: { doc: 1, name: "O" }, whole: true, object: true }]),
                chatStream([{ type: "text", text: "done" }]),
            ], p);
            const out = await a.send("layers");
            const names = editor.calls.filter((c) => c.name === "add_paint_layer").map((c) => c.args.name);
            const replay = fetchImpl.sent[2].body.messages.filter((m) => m.role === "assistant").map((m) => m.tool_calls[0].function.arguments);
            check("a_whole_call_in_one_delta_is_taken_and_an_arguments_object_as_it_is",
                eq(names, ["W", "O"]) && out.steps === 2 && eq(replay, ["{\"doc\":1,\"name\":\"W\"}", "{\"doc\":1,\"name\":\"O\"}"]), `${names.join(",")}; ${replay.join(" ")}`);
            await a.close();
        }
        {
            // a local server that sends neither id nor index
            const p = CHAT[6];
            const editor = new FakeEditor();
            const { a, fetchImpl } = chatOn(editor, [
                chatStream([{ type: "tool_call", id: undefined, name: "list_layers", input: { doc: 1 }, noIndex: true }]),
                chatStream([{ type: "text", text: "ok" }]),
            ], p);
            const out = await a.send("look");
            const msgs = fetchImpl.sent[1].body.messages;
            const asst = msgs.find((m) => m.role === "assistant");
            const tool = msgs.find((m) => m.role === "tool");
            check("a_call_without_an_id_gets_one_that_its_result_names",
                out.steps === 1 && asst.tool_calls.length === 1 && asst.tool_calls[0].id && tool.tool_call_id === asst.tool_calls[0].id
                && msgs.filter((m) => m.role === "tool").length === 1 && editor.calls.some((c) => c.name === "list_layers" && c.args.doc === 1),
                `${asst.tool_calls.length} calls: ${asst.tool_calls[0].id} / ${tool.tool_call_id}`);
            await a.close();
        }
        {
            // a plugin tool that takes a layer but no doc: the reference is resolved, no doc is injected
            const p = CHAT[3];
            const editor = new FakeEditor();
            const { a, events } = chatOn(editor, [
                chatStream([{ type: "tool_call", id: "c1", name: "tint_layer", input: { layer: "Base", amount: 40 } }]),
                chatStream([{ type: "text", text: "tinted" }]),
            ], p);
            const stopAsks = answerAsks(a, events, true);
            const out = await a.send("tint the base");
            stopAsks();
            const call = editor.calls.find((c) => c.name === "tint.layer");
            check("a_layer_reference_is_resolved_for_a_tool_without_doc", out.reason === "end" && call && call.args.layer === "Lbase" && call.args.doc === undefined && call.args.amount === 40, short(call && call.args));
            await a.close();
        }
        {
            const p = CHAT[1];
            const editor = new FakeEditor();
            const { a, fetchImpl } = chatOn(editor, [
                chatStream([
                    { type: "tool_call", id: "c1", name: "add_paint_layer", raw: "{\"doc\": 1," },
                    { type: "tool_call", id: "c2", name: "add_paint_layer", raw: "[1]" },
                    { type: "tool_call", id: "c3", name: "add_paint_layer", raw: "\"doc\"" },
                ]),
                chatStream([{ type: "text", text: "oops" }]),
            ], p);
            await a.send("add");
            const tools = fetchImpl.sent[1].body.messages.filter((m) => m.role === "tool");
            check("bad_json_arguments_come_back_as_an_error_on_chat",
                tools.length === 3 && tools.every((t) => /^Error: the arguments were not valid JSON/.test(t.content)) && !editor.calls.some((c) => c.name === "add_paint_layer"),
                tools.map((t) => short(t.content)).join(" | "));
            await a.close();
        }
        {
            const p = CHAT[2];
            const editor = new FakeEditor();
            const { a, fetchImpl } = chatOn(editor, [
                chatStream([{ type: "tool_call", id: "c1", name: "add_paint_layer", input: { doc: 1 } }], { finish: "length" }),
            ], p);
            const out = await a.send("add");
            const tool = a.chat.history.find((m) => m.role === "tool");
            check("a_cut_off_chat_answer_runs_no_tool", out.reason === "cut" && !editor.calls.some((c) => c.name === "add_paint_layer") && tool && /Error: not run: the answer was cut off/.test(tool.content) && fetchImpl.sent.length === 1,
                `${out.reason}; ${short(tool && tool.content)}`);
            await a.close();
        }
        {
            const filtered = await (async () => { const { a } = chatOn(new FakeEditor(), [chatStream([{ type: "text", text: "no" }], { finish: "content_filter" })], CHAT[4]); const o = await a.send("x"); await a.close(); return o; })();
            const sensitive = await (async () => { const { a } = chatOn(new FakeEditor(), [chatStream([], { finish: "sensitive" })], CHAT[3]); const o = await a.send("x"); await a.close(); return o; })();
            check("content_filter_and_z_ai_sensitive_are_refusals", filtered.reason === "refusal" && sensitive.reason === "refusal", `${filtered.reason}, ${sensitive.reason}`);
        }
        {
            const runs = [];
            const orError = { id: "x", choices: [{ index: 0, delta: {}, finish_reason: "error" }], error: { code: 502, message: "Provider returned error" } };
            for (const [p, opts, want] of [
                [CHAT[0], { errorChunk: orError, noDone: true }, /Provider returned error/],
                [CHAT[3], { finish: "network_error" }, /network error/],
                [CHAT[1], { finish: "insufficient_system_resource" }, /insufficient_system_resource/],
                [CHAT[1], { finish: "aborted" }, /aborted/],
                [CHAT[3], { finish: "model_context_window_exceeded" }, /context window/],
            ]) {
                const editor = new FakeEditor();
                const { a } = chatOn(editor, [chatStream([{ type: "text", text: "partial" }], opts)], p);
                const out = await a.send("hello");
                runs.push({ p: p.provider, out, history: a.chat.history.length });
                if (out.reason !== "error" || !want.test(out.detail) || a.chat.history.length !== 1) runs.push(`WRONG ${p.provider}: ${out.reason} ${out.detail} (${a.chat.history.length} messages)`);
                await a.close();
            }
            check("a_mid_stream_error_ends_the_chat_call_and_appends_nothing", !runs.some((r) => typeof r === "string"), runs.filter((r) => typeof r === "string").join("; ") || "OpenRouter error chunk, Z.ai network_error, DeepSeek insufficient_system_resource, Z.ai context window");
        }
        {
            const editor = new FakeEditor();
            const { a } = chatOn(editor, ["data: [DONE]\n\n"], CHAT[1]);
            const out = await a.send("hello");
            check("an_empty_chat_stream_is_an_error", out.reason === "error" && /empty/.test(out.detail) && a.chat.history.length === 1, `${out.reason}: ${out.detail}`);
            await a.close();
        }
        {
            // the connection closes before the finish_reason: nothing of the half answer is pushed, no half call runs
            const wrap = (delta) => "data: " + JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] }) + "\n\n";
            const textOnly = wrap({ role: "assistant", content: "" }) + wrap({ content: "Let me " });
            const inCall = textOnly + wrap({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "add_paint_layer", arguments: "{\"doc\":1," } }] });
            const runs = [];
            const editor = new FakeEditor();
            for (const body of [textOnly, inCall]) {
                const { a } = chatOn(editor, [body], CHAT[3]);
                const out = await a.send("hello");
                runs.push(`${out.reason}: ${out.detail} (${a.chat.history.length} messages)`);
                if (out.reason !== "error" || !/before the answer was finished/.test(out.detail) || a.chat.history.length !== 1) runs.push("WRONG");
                await a.close();
            }
            check("a_chat_stream_that_breaks_before_its_finish_reason_pushes_nothing", !runs.includes("WRONG") && !editor.calls.some((c) => c.name === "add_paint_layer"), runs.join(" | "));
        }
        {
            // a refusal that still carries calls answers them, so the next request is valid
            const editor = new FakeEditor();
            const { a, fetchImpl } = chatOn(editor, [
                chatStream([{ type: "tool_call", id: "c1", name: "add_paint_layer", input: { doc: 1 } }], { finish: "content_filter" }),
                chatStream([{ type: "text", text: "ok" }]),
            ], CHAT[4]);
            const out = await a.send("add");
            const tool = a.chat.history.find((m) => m.role === "tool");
            const out2 = await a.send("and now?");
            const msgs = fetchImpl.sent[1].body.messages;
            const at = msgs.findIndex((m) => m.role === "assistant" && m.tool_calls);
            check("a_refused_answer_with_calls_answers_them", out.reason === "refusal" && tool && /Error: not run: the answer was refused/.test(tool.content)
                && !editor.calls.some((c) => c.name === "add_paint_layer") && out2.reason === "end" && at >= 0 && msgs[at + 1].role === "tool" && msgs[at + 1].tool_call_id === "c1",
                `${out.reason}; ${short(tool && tool.content)}; then ${out2.reason}`);
            await a.close();
        }
        {
            // a server without index: two whole calls with neither id nor index are two calls; fragments that repeat an id are one
            const wrap = (delta) => ({ type: "raw", chunk: { id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] } });
            const editor = new FakeEditor();
            const { a } = chatOn(editor, [
                chatStream([
                    wrap({ tool_calls: [{ type: "function", function: { name: "add_paint_layer", arguments: "{\"doc\":1,\"name\":\"A\"}" } }] }),
                    wrap({ tool_calls: [{ type: "function", function: { name: "add_paint_layer", arguments: "{\"doc\":1,\"name\":\"B\"}" } }] }),
                ]),
                chatStream([
                    wrap({ tool_calls: [{ id: "k1", type: "function", function: { name: "add_paint_layer", arguments: "" } }] }),
                    wrap({ tool_calls: [{ id: "k1", function: { arguments: "{\"doc\":1," } }] }),
                    wrap({ tool_calls: [{ id: "k1", function: { arguments: "\"name\":\"C\"}" } }] }),
                ]),
                chatStream([{ type: "text", text: "three" }]),
            ], CHAT[6]);
            const out = await a.send("layers");
            const names = editor.calls.filter((c) => c.name === "add_paint_layer").map((c) => c.args.name);
            const asst = a.chat.history.filter((m) => m.role === "assistant" && m.tool_calls);
            check("a_server_without_index_gets_its_calls_split_and_joined_right",
                eq(names, ["A", "B", "C"]) && out.steps === 3 && asst.length === 2 && asst[0].tool_calls.length === 2 && asst[1].tool_calls.length === 1 && asst[1].tool_calls[0].id === "k1",
                `${names.join(",")}; ${asst.map((m) => m.tool_calls.length).join("/")}`);
            await a.close();
        }
        {
            const editor = new FakeEditor();
            const { a, fetchImpl } = chatOn(editor, [
                chatStream([{ type: "tool_call", id: "c1", name: "add_paint_layer", input: [1, 2], whole: true, object: true }]),
                chatStream([{ type: "text", text: "oops" }]),
            ], CHAT[3]);
            await a.send("add");
            const tool = fetchImpl.sent[1].body.messages.find((m) => m.role === "tool");
            check("an_arguments_array_is_bad_json_too", /^Error: the arguments were not valid JSON/.test(tool.content) && !editor.calls.some((c) => c.name === "add_paint_layer"), short(tool.content));
            await a.close();
        }
        {
            // a refusal streamed as delta.refusal (OpenAI models through a gateway), with a plain stop
            const wrap = (delta) => ({ type: "raw", chunk: { id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] } });
            const editor = new FakeEditor();
            const { a } = chatOn(editor, [chatStream([wrap({ refusal: "I can't " }), wrap({ refusal: "help with that." })], { finish: "stop" })], CHAT[0]);
            const out = await a.send("hello");
            check("a_refusal_delta_ends_the_turn_as_a_refusal", out.reason === "refusal" && /help with that/.test(out.detail), `${out.reason}: ${out.detail}`);
            await a.close();
        }
        {
            // delta.content as an array of parts (some local servers)
            const wrap = (delta) => ({ type: "raw", chunk: { id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] } });
            const editor = new FakeEditor();
            const { a, events } = chatOn(editor, [chatStream([wrap({ content: [{ type: "text", text: "Hel" }] }), wrap({ content: [{ type: "text", text: "lo" }] })])], CHAT[6]);
            await a.send("hi");
            const text = events.filter((e) => e.type === "assistant:text").map((e) => e.text).join("");
            check("content_parts_in_a_delta_are_read_as_text", text === "Hello" && a.chat.history[1].content === "Hello", text);
            await a.close();
        }
        {
            const editor = new FakeEditor();
            const { a, events } = chatOn(editor, [chatStream([{ type: "text", text: "a" }]), chatStream([{ type: "text", text: "b" }])], CHAT[6]);
            await a.send("one");
            await a.send("two");
            check("the_context_note_comes_once_per_chat", events.filter((e) => e.type === "note").length === 1 && /64k/.test(events.find((e) => e.type === "note").text), `${events.filter((e) => e.type === "note").length} notes`);
            await a.close();
        }
        {
            // DeepSeek's keep-alive comments change nothing
            const parts = [{ type: "reasoning", text: "r" }, { type: "text", pieces: ["Hel", "lo"] }, { type: "tool_call", id: "c1", name: "list_layers", input: { doc: 1 } }];
            const run = async (opts) => {
                const editor = new FakeEditor();
                const { a, fetchImpl } = chatOn(editor, [chatStream(parts, opts), chatStream([{ type: "text", text: "ok" }])], CHAT[1]);
                const out = await a.send("look");
                const asst = fetchImpl.sent[1].body.messages.find((m) => m.role === "assistant");
                await a.close();
                return { out: out.reason, asst, usage: a.chat.usage };
            };
            const plain = await run({});
            const kept = await run({ keepAlive: true });
            check("keep_alive_comments_are_skipped_on_chat", eq(plain, kept) && plain.asst.content === "Hello", short(kept.asst));
        }
        {
            // Moonshot: usage in a last chunk with choices: [], or in both places
            const results = [];
            for (const where of ["last", "empty", "both", "choice"]) {
                const editor = new FakeEditor();
                const { a } = chatOn(editor, [chatStream([{ type: "text", text: "hi" }], { usageWhere: where, usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 } } })], CHAT[2]);
                await a.send("hello");
                results.push(`${where}: ${JSON.stringify(a.chat.usage)}`);
                if (!(a.chat.usage.input === 60 && a.chat.usage.cacheRead === 30 && a.chat.usage.cacheWrite === 10 && a.chat.usage.output === 20)) results.push("WRONG");
                await a.close();
            }
            check("usage_is_read_from_either_last_chunk", !results.includes("WRONG"), results.join(" | "));
        }
        {
            // text deltas reach the panel as they arrive
            const editor = new FakeEditor();
            const { a, events } = chatOn(editor, [chatStream([{ type: "text", pieces: ["Hel", "lo ", "there"] }])], CHAT[3]);
            await a.send("hi");
            const deltas = events.filter((e) => e.type === "text_delta").map((e) => e.text);
            check("chat_text_deltas_reach_the_panel_before_the_end", eq(deltas, ["Hel", "lo ", "there"]), deltas.join("|"));
            await a.close();
        }
        {
            // the same answer in one chunk and cut at every byte offset (UTF-8 inside) gives the same message
            const editor = new FakeEditor();
            const { a } = chatOn(editor, [], CHAT[1]);
            await a.connect();
            const chat = await a.newChat();
            const text = chatStream([
                { type: "reasoning", pieces: ["Zwölf ", "Boxkämpfer"] },
                { type: "text", pieces: ["Héllo ", "\u{1F5BC} wörld"] },
                { type: "tool_call", id: "c1", name: "set_prompt", input: { doc: 1, prompt: "über \u{1F3A8}" } },
            ], { usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60 } });
            const bytes = Buffer.from(text, "utf8");
            const run = async (chunks) => {
                const res = await chat.adapter.stream(chat, [chat.adapter.userMessage("", "x")], { fetchImpl: async () => sseResponse(text, { chunks }) });
                return JSON.stringify({ m: res.messages, c: res.calls, s: res.stop, u: res.usage, t: res.text });
            };
            const whole = await run([bytes]);
            let same = true;
            for (let at = 1; at < bytes.length; at++) {
                const cut = await run([bytes.subarray(0, at), bytes.subarray(at)]);
                if (cut !== whole) { same = false; check("chat stream cut at " + at + " differs", false, short(cut)); break; }
            }
            const parsed = JSON.parse(whole);
            check("a_chat_stream_cut_at_every_byte_offset_rebuilds_the_same_message",
                same && parsed.m[0].reasoning_content === "Zwölf Boxkämpfer" && parsed.t === "Héllo \u{1F5BC} wörld" && parsed.c[0].args.prompt === "über \u{1F3A8}" && parsed.u.input === 60 && parsed.u.cacheRead === 40,
                `${bytes.length} offsets`);
            await a.close();
        }
    });

    // ---- 13. images on Chat Completions ---------------------------------------------------
    await section("13. images on Chat Completions", async () => {
        const chatAdapter = require(path.join(ROOT, "electron", "main", "assistant", "chat.js"));
        {
            const editor = new FakeEditor();
            const { a, fetchImpl } = chatOn(editor, [
                chatStream([{ type: "tool_call", id: "c1", name: "screenshot", input: {} }]),
                chatStream([{ type: "text", text: "I see it." }]),
            ], CHAT[2]);
            await a.send("look");
            const msgs = fetchImpl.sent[1].body.messages;
            const tool = msgs.find((m) => m.role === "tool");
            const users = msgs.filter((m) => m.role === "user");
            check("moonshot_images_go_into_the_tool_message",
                Array.isArray(tool.content) && tool.content.some((c) => c.type === "image_url" && c.image_url.url === "data:image/jpeg;base64,QUJD") && tool.content.some((c) => c.type === "text" && /1024/.test(c.text))
                && users.length === 1 && msgs[msgs.length - 1].role === "tool",
                short(tool.content));
            await a.close();
        }
        {
            const editor = new FakeEditor();
            const { a, fetchImpl } = chatOn(editor, [
                chatStream([{ type: "tool_call", id: "c1", name: "screenshot", input: {} }, { type: "tool_call", id: "c2", name: "list_layers", input: { doc: 1 } }]),
                chatStream([{ type: "text", text: "I see it." }]),
            ], CHAT[1]);
            await a.send("look");
            const msgs = fetchImpl.sent[1].body.messages;
            const tools = msgs.filter((m) => m.role === "tool");
            const last = msgs[msgs.length - 1];
            check("images_follow_the_tool_messages_elsewhere",
                tools.length === 2 && typeof tools[0].content === "string" && /The screenshot follows in the next message/.test(tools[0].content) && !/follows/.test(tools[1].content)
                && last.role === "user" && eq(last.content, [{ type: "text", text: "Screenshot from call c1" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } }])
                && msgs.indexOf(last) === msgs.indexOf(tools[1]) + 1 && !JSON.stringify(tools).includes("QUJD"),
                msgs.map((m) => m.role).join(" "));
            await a.close();
        }
        {
            // the local server refuses the picture: once more without it, and no screenshot afterwards
            const lines = [];
            const editor = new FakeEditor();
            let n = 0;
            const answers = [
                () => sseResponse(chatStream([{ type: "tool_call", id: "c1", name: "screenshot", input: {} }])),
                () => sseResponse(JSON.stringify({ error: { message: "image input is not supported by this model", type: "invalid_request_error" } }), { status: 400 }),
                () => sseResponse(chatStream([{ type: "text", text: "blind" }])),
                () => sseResponse(chatStream([{ type: "tool_call", id: "c2", name: "screenshot", input: {} }, { type: "tool_call", id: "c3", name: "add_paint_layer", input: { doc: 1 } }])),
                () => sseResponse(chatStream([{ type: "text", text: "still blind" }])),
            ];
            const sent = [];
            const impl = async (url, init) => { sent.push(JSON.parse(init.body)); return answers[n++](); };
            const { a, events } = chatOn(editor, impl, CHAT[6], { log: { record: (e) => lines.push(e.message) } });
            const out1 = await a.send("look");
            const out2 = await a.send("look again");
            const third = JSON.stringify(sent[2]);
            const tool2 = a.chat.history.find((m) => m.role === "tool" && m.tool_call_id === "c2");
            const tool3 = a.chat.history.find((m) => m.role === "tool" && m.tool_call_id === "c3");
            check("a_refused_image_turns_screenshot_off_for_the_chat",
                out1.reason === "end" && out2.reason === "end" && sent.length === 5 && a.chat.noImages === true
                && !third.includes("image_url") && third.includes(chatAdapter.REFUSED) && JSON.stringify(sent[1]).includes("QUJD")
                && editor.calls.filter((c) => c.name === "screenshot").length === 1 && /does not take images/.test(tool2.content)
                && lines.some((l) => /refused the picture/.test(l)),
                `${out1.reason}/${out2.reason}, ${sent.length} requests, noImages=${a.chat.noImages}, ${short(tool2 && tool2.content)}`);
            check("after_a_refused_picture_every_other_tool_still_runs",
                editor.calls.filter((c) => c.name === "add_paint_layer").length === 1 && tool3 && /"id"/.test(tool3.content) && out2.steps === 1
                && events.some((e) => e.type === "call" && e.call === "c2" && e.action === "refuse" && /does not take images/.test(e.reason)),
                `${out2.steps} steps; ${short(tool3 && tool3.content)}`);
            await a.close();
        }
        {
            // the fallback is the local server's alone: a gateway that names the image in a 400 ends the turn, pictures kept
            const editor = new FakeEditor();
            let n = 0;
            const answers = [
                () => sseResponse(chatStream([{ type: "tool_call", id: "c1", name: "screenshot", input: {} }])),
                () => sseResponse(JSON.stringify({ error: { message: "image input is not supported by this model" } }), { status: 400 }),
            ];
            const { a } = chatOn(editor, async () => answers[n++](), CHAT[4]);
            const out = await a.send("look");
            check("the_image_fallback_is_the_local_servers_alone", out.reason === "error" && n === 2 && a.chat.noImages === undefined && JSON.stringify(a.chat.history).includes("QUJD"), `${out.reason}: ${out.detail}; ${n} requests`);
            await a.close();
        }
        {
            // a second refusal after the strip is the turn's error, not another try
            const editor = new FakeEditor();
            let n = 0;
            const answers = [
                () => sseResponse(chatStream([{ type: "tool_call", id: "c1", name: "screenshot", input: {} }])),
                () => sseResponse(JSON.stringify({ error: { message: "image input is not supported" } }), { status: 400 }),
                () => sseResponse(JSON.stringify({ error: { message: "image input is not supported" } }), { status: 400 }),
                () => sseResponse(JSON.stringify({ error: { message: "image input is not supported" } }), { status: 400 }),
            ];
            const { a } = chatOn(editor, async () => answers[n++](), CHAT[6]);
            const out = await a.send("look");
            check("a_second_refusal_after_the_strip_is_not_tried_again", out.reason === "error" && n === 3 && /HTTP 400/.test(out.detail), `${out.reason}: ${out.detail}; ${n} requests`);
            await a.close();
        }
        {
            // the strict rule: only a 400 / 413 / 415 / 422 that names the image; a 401 with the word keeps the pictures
            const editor = new FakeEditor();
            let n = 0;
            const answers = [
                () => sseResponse(chatStream([{ type: "tool_call", id: "c1", name: "screenshot", input: {} }])),
                () => sseResponse(JSON.stringify({ error: { message: "bad key for image models" } }), { status: 401 }),
            ];
            const { a } = chatOn(editor, async () => answers[n++](), CHAT[6]);
            const out = await a.send("look");
            check("only_a_4xx_that_names_the_image_is_the_fallback",
                out.reason === "error" && n === 2 && a.chat.noImages === undefined && JSON.stringify(a.chat.history).includes("QUJD"), `${out.reason}: ${out.detail}; ${n} requests`);
            await a.close();
        }
        {
            // the fallback needs a picture in the history: a 400 naming the image before any screenshot is a plain error
            const editor = new FakeEditor();
            let n = 0;
            const { a } = chatOn(editor, async () => { n++; return sseResponse(JSON.stringify({ error: { message: "model does not support images" } }), { status: 400 }); }, CHAT[6]);
            const out = await a.send("hello");
            check("the_image_fallback_needs_a_picture_in_the_history", out.reason === "error" && n === 1 && a.chat.noImages === undefined && /HTTP 400/.test(out.detail), `${out.reason}: ${out.detail}; ${n} requests`);
            await a.close();
        }
        {
            // the strict rule is llm.js's: a 400 about an unsupported parameter is no image refusal; one about a content part is
            const run = async (message) => {
                const editor = new FakeEditor();
                let n = 0;
                const answers = [
                    () => sseResponse(chatStream([{ type: "tool_call", id: "c1", name: "screenshot", input: {} }])),
                    () => sseResponse(JSON.stringify({ error: { message } }), { status: 400 }),
                    () => sseResponse(chatStream([{ type: "text", text: "blind" }])),
                ];
                const { a } = chatOn(editor, async () => answers[n++](), CHAT[6]);
                const out = await a.send("look");
                await a.close();
                return { reason: out.reason, n, off: a.chat.noImages === true, kept: JSON.stringify(a.chat.history).includes("QUJD") };
            };
            const param = await run("Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.");
            const part = await run("Invalid content part");
            check("only_a_400_that_names_the_picture_is_an_image_refusal",
                param.reason === "error" && param.n === 2 && !param.off && param.kept && part.reason === "end" && part.n === 3 && part.off && !part.kept,
                `${JSON.stringify(param)} / ${JSON.stringify(part)}`);
        }
        {
            // pruning in batches: nothing until more than twice keepImages are attached, then down to keepImages
            const shots = (n, from) => Array.from({ length: n }, (_, i) => ({ type: "tool_call", id: "s" + (from + i), name: "screenshot", input: {} }));
            const editor = new FakeEditor();
            const { a, fetchImpl } = chatOn(editor, [
                chatStream(shots(5, 1)), chatStream([{ type: "text", text: "five" }]),
                chatStream(shots(2, 6)), chatStream([{ type: "text", text: "seven" }]),
                chatStream([{ type: "text", text: "eight" }]),
            ], CHAT[1]);
            await a.send("look five times");
            await a.send("look twice more");            // 5 attached at this user message: nothing is pruned
            const second = (JSON.stringify(fetchImpl.sent[2].body.messages).match(/"type":"image_url"/g) || []).length;
            await a.send("done?");                      // 7 attached: all but the last 3 become stubs
            const third = JSON.stringify(fetchImpl.sent[4].body.messages);
            const left = (third.match(/"type":"image_url"/g) || []).length;
            const stubs = third.split(chatAdapter.STUB).length - 1;
            check("pruning_starts_above_twice_keep_images_and_prunes_to_keep_images", second === 5 && left === 3 && stubs === 4,
                `${second} attached at the second message, ${left} at the third, ${stubs} stubs`);
            await a.close();
        }
        {
            // pruning: all but the last 3 screenshots become a text stub, in both places
            const build = (chat) => { const h = []; for (let i = 1; i <= 8; i++) h.push(...chatAdapter.resultsMessages([{ id: "c" + i }], [{ content: [{ type: "image", data: "IMG" + i, mimeType: "image/jpeg" }] }], chat)); return h; };
            const left = (h) => (JSON.stringify(h).match(/IMG\d/g) || []);
            const follow = build({ dialect: { imagesInToolMessage: false } });
            chatAdapter.prune(follow, 3);
            const inline = build({ dialect: { imagesInToolMessage: true } });
            chatAdapter.prune(inline, 3);
            const stubs = (h) => JSON.stringify(h).split(chatAdapter.STUB).length - 1;
            check("old_chat_screenshots_are_detached_only_at_a_user_message",
                eq(left(follow), ["IMG6", "IMG7", "IMG8"]) && stubs(follow) === 5 && eq(left(inline), ["IMG6", "IMG7", "IMG8"]) && stubs(inline) === 5,
                `${left(follow).join(",")} / ${left(inline).join(",")}`);
            const all = build({ dialect: {} });
            chatAdapter.prune(all, 0);
            check("with_keep_images_0_every_chat_screenshot_stays", left(all).length === 8);
        }
        {
            // a Gemini model through a gateway takes Google's cap
            const big = "x".repeat(19 * 1024 * 1024);
            const run = async (q) => {
                const editor = new FakeEditor();
                const { a, fetchImpl } = chatOn(editor, [chatStream([{ type: "text", text: "ok" }])], q);
                await a.connect();
                a.chat = await a.newChat();
                a.chat.history.push(a.chat.adapter.userMessage("", big));
                const out = await a.send("hello");
                await a.close();
                return `${q.provider}:${q.model} ${out.reason} (${fetchImpl.sent.length} sent)`;
            };
            const got = [
                await run({ provider: "openrouter", model: "google/gemini-3.8-flash", key: "test-or-0000" }),
                await run({ provider: "wavespeed", model: "google/gemini-3.8-flash", key: "test-ws-0000" }),
                await run({ provider: "toapis", model: "gemini-3.8-flash", key: "test-toapis-0000" }),
                await run({ provider: "openrouter", model: "anthropic/claude-sonnet-5", key: "test-or-0000" }),
                await run({ provider: "toapis", model: "claude-sonnet-5", key: "test-toapis-0000" }),
            ];
            check("a_gemini_model_on_any_provider_caps_at_18_mb",
                got.slice(0, 3).every((g) => /full \(0 sent\)/.test(g)) && got.slice(3).every((g) => /end \(1 sent\)/.test(g)), got.join("; "));
        }
    });

    // ---- 14. keys and hosts on Chat Completions -------------------------------------------
    await section("14. keys and hosts on Chat Completions", async () => {
        const http = require(path.join(ROOT, "electron", "main", "assistant", "http.js"));
        const KEYS = { anthropic: "test-ant-1", openrouter: "test-or-1", deepseek: "test-ds-1", moonshot: "test-ms-1", zai: "test-zai-1", toapis: "test-toapis-1", wavespeed: "test-ws-1", compat: "test-compat-1" };
        {
            const wrong = [];
            for (const p of CHAT) {
                orHosts._resetHosts();
                const editor = new FakeEditor();
                const { a, fetchImpl } = chatOn(editor, [chatStream([{ type: "text", text: "hi" }])], p, { keys: KEYS });
                await a.send("hello");
                const req = fetchImpl.sent[0];
                const others = Object.entries(KEYS).filter(([row]) => row !== p.provider).map(([, k]) => k);
                const all = JSON.stringify(req);
                if (req.headers.Authorization !== "Bearer " + KEYS[p.provider] || req.headers["content-type"] !== "application/json" || Object.keys(req.headers).length !== 2
                    || others.some((k) => all.includes(k)) || JSON.stringify(req.body).includes(KEYS[p.provider])
                    || req.url !== "http://127.0.0.1:5599" + p.path) wrong.push(`${p.provider}: ${req.url} ${Object.keys(req.headers).join(",")} ${req.headers.Authorization}`);
                await a.close();
            }
            check("each_provider_takes_its_own_key_row_in_the_bearer_header_only", !wrong.length, wrong.join("; ") || `${CHAT.length} providers`);
            check("the_loopback_base_keeps_each_chat_providers_path", !wrong.length, wrong.join("; ") || CHAT.map((p) => p.path).join(" "));
        }
        {
            const editor = new FakeEditor();
            const { a, fetchImpl } = chatOn(editor, [chatStream([{ type: "text", text: "hi" }])], CHAT[6], { keys: { compat: "" } });
            const out = await a.send("hello");
            check("the_local_server_needs_no_key", out.reason === "end" && fetchImpl.sent[0].headers.Authorization === undefined && fetchImpl.sent[0].url === "http://127.0.0.1:5599/v1/chat/completions"
                && eq(Object.keys(fetchImpl.sent[0].headers), ["content-type"]),
                `${out.reason}; ${Object.keys(fetchImpl.sent[0].headers).join(",")}`);
            await a.close();
        }
        {
            const editor = new FakeEditor();
            const { a } = chatOn(editor, [], CHAT[6], { settings: { llm: { compat: { url: "" } } } });
            let message = "";
            try { await a.send("hello"); } catch (err) { message = err.message; }
            check("a_local_server_without_a_url_says_where_to_set_one", /No endpoint URL\. Set one under Settings . Local \/ OpenAI-compatible endpoint\./.test(message), message);
            await a.close();
        }
        {
            let direct = "";
            let sentTo = "";
            const impl = async (url) => { sentTo = String(url); return sseResponse("data: [DONE]\n\n"); };
            try { await http.postStream("http://127.0.0.1:11434/v1/chat/completions", {}, {}, { key: "lm-studio", localOk: true, fetchImpl: impl }); } catch (err) { direct = err.message; }
            let refused = "";
            try { await http.postStream("http://127.0.0.1:11434/v1/chat/completions", {}, {}, { key: "lm-studio", fetchImpl: impl }); } catch (err) { refused = err.message; }
            let testKey = "";
            try { await http.postStream("https://llm.example.com/v1/chat/completions", {}, {}, { key: "test-x", localOk: true, fetchImpl: impl }); } catch (err) { testKey = err.message; }
            check("the_compat_key_goes_to_the_compat_url_only",
                direct === "" && sentTo === "http://127.0.0.1:11434/v1/chat/completions" && /test keys only/.test(refused) && /test key goes to the test endpoint only/.test(testKey),
                `localOk: ${direct || "sent"}; without: ${refused}; test key: ${testKey}`);
            const chatAdapter = require(path.join(ROOT, "electron", "main", "assistant", "chat.js"));
            const editor = new FakeEditor();
            const { a, fetchImpl } = chatOn(editor, [chatStream([{ type: "text", text: "hi" }])], CHAT[6], { keys: { compat: "lm-studio" }, assistant: { base: "" }, settings: { llm: { compat: { url: "http://localhost:1234" } } } });
            const out = await a.send("hello");
            check("a_real_compat_key_reaches_the_saved_local_url", out.reason === "end" && fetchImpl.sent[0].url === "http://localhost:1234/v1/chat/completions" && fetchImpl.sent[0].headers.Authorization === "Bearer lm-studio",
                `${out.reason} ${out.detail}; ${fetchImpl.sent[0] && fetchImpl.sent[0].url}`);
            const editor2 = new FakeEditor();
            const { a: a2, fetchImpl: f2 } = chatOn(editor2, [chatStream([{ type: "text", text: "hi" }])], CHAT[1], { keys: { deepseek: "sk-real-deepseek-key" }, assistant: { base: "" }, settings: { llm: { compat: { url: "http://localhost:1234" } } } });
            let refusedReal = "";
            try { await a2.send("hello"); } catch (err) { refusedReal = err.message; }
            // the real key would go to api.deepseek.com: the scripted fetch answers, so the request must not have been refused by the key rule
            check("only_the_local_server_lifts_the_loopback_rule", refusedReal === "" && f2.sent[0].url === "https://api.deepseek.com/chat/completions" && chatAdapter.family === "chat", refusedReal || f2.sent[0].url);
            await a.close(); await a2.close();
        }
        {
            // a loopback base from another setting (settings.toapis.base) takes no real key either, and the turn says so
            const editor = new FakeEditor();
            const { a, fetchImpl } = chatOn(editor, [chatStream([{ type: "text", text: "hi" }])], CHAT[4], { keys: { toapis: "sk-real-toapis-000" }, assistant: { base: "" }, settings: { toapis: { base: "http://127.0.0.1:9911" } } });
            const out = await a.send("hello");
            check("a_real_key_never_reaches_a_loopback_gateway_base", out.reason === "error" && /test keys only/.test(out.detail) && fetchImpl.sent.length === 0, `${out.reason}: ${out.detail}; ${fetchImpl.sent.length} sent`);
            await a.close();
        }
        {
            // the adapter scrubs the key itself where a server's text enters an error: the JSON answer and the error chunk
            const chatAdapter = require(path.join(ROOT, "electron", "main", "assistant", "chat.js"));
            const { PROVIDERS } = require(path.join(ROOT, "electron", "main", "assistant", "providers.js"));
            const fake = { id: "c1", model: "glm-5.3-flash", system: "s", tools: [], maxTokens: 10, idleMs: 0, dialect: PROVIDERS.zai.dialect, base: "http://127.0.0.1:5599/api/paas/v4", key: "test-zai-0000" };
            const json = JSON.stringify({ error: { code: "1002", message: "token test-zai-0000 is invalid" } });
            let m1 = "";
            try { await chatAdapter.stream(fake, [], { fetchImpl: async () => sseResponse(json, { headers: { "content-type": "application/json" } }) }); } catch (err) { m1 = err.message; }
            const chunk = { id: "x", choices: [{ index: 0, delta: {}, finish_reason: "error" }], error: { code: 401, message: "bad key test-zai-0000" } };
            let m2 = "";
            try { await chatAdapter.stream(fake, [], { fetchImpl: async () => sseResponse(chatStream([], { errorChunk: chunk, noDone: true })) }); } catch (err) { m2 = err.message; }
            check("the_adapter_scrubs_the_key_from_a_json_answer_and_an_error_chunk", /<key>/.test(m1) && !/test-zai-0000/.test(m1) && /<key>/.test(m2) && !/test-zai-0000/.test(m2), `${m1} | ${m2}`);
        }
        {
            const editor = new FakeEditor();
            const { a } = chatOn(editor, [], CHAT[1], { keys: {} });
            let message = "";
            try { await a.send("hello"); } catch (err) { message = err.message; }
            check("a_missing_chat_key_names_the_provider_and_where_to_add_it", /No API key for DeepSeek\. Add it under Settings . API providers\./.test(message), message);
            await a.close();
        }
        {
            // the adapter refuses on its own, below send()'s check: a real key never reaches the test base, a test key never a real host
            const chatAdapter = require(path.join(ROOT, "electron", "main", "assistant", "chat.js"));
            const { PROVIDERS } = require(path.join(ROOT, "electron", "main", "assistant", "providers.js"));
            let sent = 0;
            const fetchImpl = async () => { sent++; return sseResponse(chatStream([{ type: "text", text: "hi" }])); };
            const fake = (over) => ({ id: "c1", model: "deepseek-flash", system: "s", tools: [], maxTokens: 10, idleMs: 0, dialect: PROVIDERS.deepseek.dialect, ...over });
            let real = "";
            try { await chatAdapter.stream(fake({ base: "http://127.0.0.1:5599", key: "sk-real-000000" }), [], { fetchImpl }); } catch (err) { real = err.message; }
            let test = "";
            try { await chatAdapter.stream(fake({ base: "https://api.deepseek.com", key: "test-ds-0000" }), [], { fetchImpl }); } catch (err) { test = err.message; }
            check("the_adapter_itself_keeps_the_key_rule", /test keys only/.test(real) && /test key goes to the test endpoint only/.test(test) && sent === 0, `${real} | ${test} | ${sent} sent`);
        }
        {
            orHosts._resetHosts();
            const editor = new FakeEditor();
            const providers = { data: [
                { slug: "alibaba", headquarters: "CN", datacenters: ["CN", "SG"] },
                { slug: "nebius", headquarters: "NL", datacenters: ["FI"] },
                { slug: "tencent-cloud", headquarters: "US", datacenters: ["CN", "US"] },
                { slug: "lower-case", headquarters: "cn" },
            ] };
            const gets = (url) => (/\/api\/v1\/providers$/.test(url) ? { ok: true, status: 200, json: async () => providers } : null);
            const { a, fetchImpl } = chatOn(editor, [
                chatStream([{ type: "tool_call", id: "c1", name: "list_layers", input: { doc: 1 } }]),
                chatStream([{ type: "text", text: "ok" }]),
            ], CHAT[0], { gets });
            await a.send("look");
            const bodies = fetchImpl.sent.map((r) => r.body);
            const ignore = bodies[0].provider.ignore;
            check("openrouter_ignores_the_hosts_in_china",
                ["alibaba", "tencent-cloud", "lower-case", ...orHosts.CHINA_HOSTS].every((h) => ignore.includes(h)) && !ignore.includes("nebius")
                && eq(ignore, [...ignore].sort()) && bodies.every((b) => eq(b.provider, { data_collection: "deny", ignore }) && b.session_id === a.chat.id)
                && fetchImpl.got.filter((g) => /\/api\/v1\/providers$/.test(g.url)).length === 1 && fetchImpl.got[0].url === "http://127.0.0.1:5599/api/v1/providers",
                `${ignore.join(",")}; ${fetchImpl.got.length} GET`);
            const headers = fetchImpl.sent[0].headers;
            check("openrouter_sends_no_attribution_header", !Object.keys(headers).some((h) => /referer|x-title|x-openrouter/i.test(h)) && headers.Authorization === "Bearer test-or-0000", Object.keys(headers).join(", "));
            await a.close();

            orHosts._resetHosts();
            const editor2 = new FakeEditor();
            const { a: a2, fetchImpl: f2 } = chatOn(editor2, [
                chatStream([{ type: "tool_call", id: "c1", name: "list_layers", input: { doc: 1 } }]),
                chatStream([{ type: "text", text: "ok" }]),
            ], CHAT[0], { gets: () => ({ ok: false, status: 500, json: async () => ({}) }) });
            await a2.send("hello");
            const hostGets = f2.got.filter((g) => /\/api\/v1\/providers$/.test(g.url)).length;
            check("when_the_host_list_cannot_be_read_the_dated_list_is_sent_and_it_is_asked_once_per_chat",
                f2.sent.length === 2 && f2.sent.every((r) => eq(r.body.provider.ignore, [...orHosts.CHINA_HOSTS].sort())) && f2.sent[0].body.provider.ignore.length >= 4 && hostGets === 1,
                `${f2.sent[0].body.provider.ignore.join(",")}; ${hostGets} GET for ${f2.sent.length} model calls`);
            await a2.close();
            orHosts._resetHosts();
        }
        {
            // the final answers: plain words, one request, the turn ends "error"
            const cases = [
                ["a_deepseek_402_says_the_balance_is_empty", CHAT[1], { status: 402, body: JSON.stringify({ error: { message: "Insufficient Balance" } }) }, /^the DeepSeek balance is empty$/],
                ["an_openrouter_402_is_final", CHAT[0], { status: 402, body: JSON.stringify({ error: { code: 402, message: "Insufficient credits" } }) }, /OpenRouter credits/],
                ["a_moonshot_empty_balance_is_final", CHAT[2], { status: 429, body: JSON.stringify({ error: { type: "exceeded_current_quota_error", message: "Your account is suspended" } }) }, /^the Moonshot balance is empty$/],
                ["a_moonshot_daily_limit_is_final", CHAT[2], { status: 429, body: JSON.stringify({ error: { type: "rate_limit_reached_error", message: "Your account reached max request TPD: 1500000, please try again after 1 day" } }) }, /daily token limit.*next day/],
                ["a_z_ai_empty_balance_is_final", CHAT[3], { status: 429, body: JSON.stringify({ error: { code: "1113", message: "Insufficient account balance" } }) }, /^the Z.ai balance is empty$/],
                ["a_z_ai_sensitive_answer_is_final", CHAT[3], { status: 400, body: JSON.stringify({ error: { code: "1301", message: "unsafe" } }) }, /sensitive/],
                ["a_z_ai_too_long_request_is_final", CHAT[3], { status: 400, body: JSON.stringify({ error: { code: 1261, message: "too long" } }) }, /too long for Z.ai/],
            ];
            for (const [name, p, answer, want] of cases) {
                const editor = new FakeEditor();
                let n = 0;
                // the fetch also answers OpenRouter's GET of the host list, which is not a model call
                const { a } = chatOn(editor, async (url, init) => { if (init && init.body !== undefined) n++; return sseResponse(answer.body, { status: answer.status, headers: { "retry-after": "1" } }); }, p);
                const out = await a.send("hello");
                check(name, out.reason === "error" && n === 1 && want.test(out.detail) && a.chat.history.length === 1, `${out.reason}: ${out.detail} (${n} requests)`);
                await a.close();
            }
            const retried = [
                ["a_moonshot_overload_is_retried_by_the_adapter", CHAT[2], JSON.stringify({ error: { type: "engine_overloaded_error", message: "busy" } })],
                ["a_moonshot_rpm_limit_is_retried", CHAT[2], JSON.stringify({ error: { type: "rate_limit_reached_error", message: "Your account reached max request RPM: 3, please try again after 1 seconds" } })],
                ["a_z_ai_rate_limit_is_retried", CHAT[3], JSON.stringify({ error: { code: "1302", message: "too many requests" } })],
            ];
            for (const [name, p, body] of retried) {
                const editor = new FakeEditor();
                let n = 0;
                const { a } = chatOn(editor, async () => (++n === 1 ? sseResponse(body, { status: 429 }) : sseResponse(chatStream([{ type: "text", text: "ok" }]))), p);
                const out = await a.send("hello");
                check(name, out.reason === "end" && n === 2, `${out.reason}: ${out.detail} (${n} requests)`);
                await a.close();
            }
        }
        {
            // an answer that is not a stream (Z.ai reports some errors as HTTP 200 JSON)
            const editor = new FakeEditor();
            const json = JSON.stringify({ error: { code: "1113", message: "Insufficient balance" } });
            const { a } = chatOn(editor, async () => sseResponse(json, { headers: { "content-type": "application/json" } }), CHAT[3]);
            const out = await a.send("hello");
            check("a_json_answer_is_not_read_as_a_stream", out.reason === "error" && /the Z.ai balance is empty/.test(out.detail), `${out.reason}: ${out.detail}`);
            await a.close();
        }
        {
            const editor = new FakeEditor();
            const { a } = chatOn(editor, async () => sseResponse(JSON.stringify({ error: { message: "key test-ds-0000 is invalid" } }), { status: 401 }), CHAT[1]);
            const out = await a.send("hello");
            check("a_chat_error_that_echoes_the_key_is_scrubbed", out.reason === "error" && /<key>/.test(out.detail) && !/test-ds-0000/.test(out.detail), out.detail);
            await a.close();
        }
    });

    // ---- 15. cost on Chat Completions -----------------------------------------------------
    await section("15. cost on Chat Completions", async () => {
        const chatAdapter = require(path.join(ROOT, "electron", "main", "assistant", "chat.js"));
        const u = chatAdapter._usageOf;
        const deepseek = u({ prompt_tokens: 1000, prompt_cache_hit_tokens: 300, prompt_cache_miss_tokens: 700, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 10 } });
        const moonshot = u({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 300, cache_write_tokens: 200 } });
        const openrouter = u({ prompt_tokens: 1000, completion_tokens: 50, cost: 0.0123, prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 5 } });
        const zai = u({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 250 } });
        const plain = u({ prompt_tokens: 1000, completion_tokens: 50 });
        const odd = u({ prompt_tokens: 1000, completion_tokens: 50, cost: "n/a" });
        check("chat_usage_is_normalised_per_dialect",
            eq(deepseek, { input: 700, cacheRead: 300, cacheWrite: 0, output: 50, reasoning: 10 })
            && eq(moonshot, { input: 500, cacheRead: 300, cacheWrite: 200, output: 50, reasoning: 0 })
            && eq(openrouter, { input: 900, cacheRead: 100, cacheWrite: 0, output: 50, reasoning: 5, cost: 0.0123 })
            && eq(zai, { input: 750, cacheRead: 250, cacheWrite: 0, output: 50, reasoning: 0 })
            && eq(plain, { input: 1000, cacheRead: 0, cacheWrite: 0, output: 50, reasoning: 0 }) && eq(odd, plain) && eq(u(null), plain && { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }),
            [deepseek, moonshot, openrouter, zai].map((x) => JSON.stringify(x)).join(" "));
        const peak = Date.UTC(2026, 8, 21, 2, 0, 0);   // a Monday, 02:00 UTC
        const ds = models.costOf("deepseek", "deepseek-flash", deepseek, peak);
        const ms = models.costOf("moonshot", "kimi-k3", moonshot);
        const or = models.costOf("openrouter", "anthropic/claude-sonnet-5", openrouter);
        const local = models.costOf("compat", "llama3.2-vision", plain);
        check("chat_usage_is_priced_per_dialect",
            Math.abs(ds.amount - (700 * 0.30 + 50 * 1.20 + 300 * 0.006) / 1e6) < 1e-12 && /peak/.test(ds.note)
            && Math.abs(ms.amount - (500 * 3 + 50 * 15 + 300 * 0.30) / 1e6) < 1e-12 && /cache writes are billed, price not published/.test(ms.note)
            && or.amount === 0.0123 && local.amount === 0,
            [ds, ms, or, local].map((x) => JSON.stringify(x)).join(" "));
        {
            // the chat's running total takes the cost OpenRouter reported
            const editor = new FakeEditor();
            const { a } = chatOn(editor, [chatStream([{ type: "text", text: "hi" }], { usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.002 } })], CHAT[0]);
            await a.send("hello");
            check("an_openrouter_chat_sums_usage_cost", Math.abs(a.chat.usage.cost - 0.002) < 1e-12 && a.chat.usage.input === 10, JSON.stringify(a.chat.usage));
            await a.close();
        }
    });


    // ---- 16. the door between the window and the loop (A4) --------------------------------
    await section("16. in the app: the start guard, the meta, the log line (A4)", async () => {
        const naptime = (ms) => new Promise((r) => setTimeout(r, ms));
        const slow = (editor, ms = 60) => { editor.describe = async () => { await naptime(ms); return ALL_COMMANDS; }; return editor; };
        {
            // connect() and newChat() are renderer round trips: the guard has to hold across them
            const editor = slow(new FakeEditor());
            const { a, events } = assistantOn(editor, [
                anthropicStream([{ type: "text", text: "one" }]),
                anthropicStream([{ type: "text", text: "two" }]),
            ]);
            const first = a.begin("hello");
            let second = null;
            try { await a.begin("again"); } catch (err) { second = err.message; }
            const started = await first;
            await waitFor(() => a.turn === null);
            const starts = events.filter((e) => e.type === "turn:start");
            check("two_sends_in_the_start_window_do_not_start_two_turns",
                second === "a turn is running" && starts.length === 1 && starts[0].turn === started.turn && a.turn === null,
                `${second}; ${starts.length} turn:start`);
            await a.close();
        }
        {
            // Stop while the turn is starting: it must not run on unstoppable
            const editor = slow(new FakeEditor());
            const { a, events } = assistantOn(editor, [anthropicStream([{ type: "text", text: "one" }])]);
            const p = a.send("hello");
            const stopped = a.stop();
            const out = await p;
            check("a_stop_while_the_turn_starts_ends_it",
                stopped === true && out.reason === "stopped" && out.steps === 0 && events.filter((e) => e.type === "turn:start").length === 1,
                `stop=${stopped}, ${out.reason}, ${out.steps} steps`);
            await a.close();
        }
        {
            // a Stop that hit a start which then failed must not stop the turn after it
            const editor = new FakeEditor();
            editor.describe = async () => { await new Promise((r) => setTimeout(r, 60)); throw new Error("the window reloaded"); };
            const { a } = assistantOn(editor, [anthropicStream([{ type: "text", text: "second" }])]);
            const failed = await a.send("hello").then(() => null, (err) => err.message);
            a.stop();
            editor.describe = async () => ALL_COMMANDS;
            const out = await a.send("again");
            check("a_stop_on_a_start_that_failed_does_not_stop_the_next_turn",
                /reloaded/.test(String(failed)) && out.reason === "end" && a.stopStarting === false,
                `${failed} then ${out.reason}`);
            await a.close();
        }
        {
            // reset() has to wait for a turn that has no turnDone yet
            const editor = slow(new FakeEditor());
            const { a } = assistantOn(editor, [anthropicStream([{ type: "text", text: "one" }])]);
            const p = a.send("hello").catch(() => "gone");
            await a.reset();
            const after = { turn: a.turn, chat: a.chat, starting: a.starting };
            await p;
            check("reset_waits_for_a_turn_that_is_starting",
                after.turn === null && after.chat === null && !after.starting,
                JSON.stringify({ turn: after.turn, chat: !!after.chat, starting: !!after.starting }));
            await a.close();
        }
        {
            // the Bridge is called with the command name, the policy's sets hold tool names
            const editor = new FakeEditor();
            const { a } = assistantOn(editor, []);
            const backend = a.backendFor();
            await backend.run("film.looks", {});
            await backend.run("glb.info", {});
            await backend.run("tint.layer", { layer: "L1" });
            await backend.run("screenshot", {});
            const [looks, info, tint, shot] = editor.metas;
            check("a_plugin_read_takes_no_wait_and_no_undo_step",
                looks.wait === false && looks.turn === undefined && looks.undo === undefined
                && info.wait === false && tint.wait === true && shot.wait === "soft",
                `film.looks wait=${looks.wait}, glb.info wait=${info.wait}, tint.layer wait=${tint.wait}, screenshot wait=${shot.wait}`);
            const same = ["film.looks", "glb.info", "tint.layer", "ailabel_add", "set_layer"].every((n) => toolName(n) === String(n).replace(/[^A-Za-z0-9_-]/g, "_"));
            check("the_assistants_tool_name_rule_is_the_servers", same, "the server's toolName and the loop's own agree");
            await a.close();
        }
        {
            // a turn that only read leaves nothing for "Undo this turn" (A7)
            const editor = new FakeEditor();
            const { a } = assistantOn(editor, [
                anthropicStream([{ type: "tool_use", id: "c1", name: "list_layers", input: { doc: 1 } }]),
                anthropicStream([{ type: "text", text: "one layer" }]),
                anthropicStream([{ type: "tool_use", id: "c2", name: "add_paint_layer", input: { doc: 1, name: "A" } }]),
                anthropicStream([{ type: "text", text: "added" }]),
            ]);
            await a.send("what is there?");
            const afterRead = a.lastTurn;
            await a.send("add a layer");
            const afterWrite = a.lastTurn;
            check("a_read_only_turn_leaves_no_last_turn",
                afterRead === null && afterWrite && afterWrite.steps === 1 && eq(afterWrite.docs, [1]),
                `${JSON.stringify(afterRead)} then ${JSON.stringify(afterWrite && afterWrite.docs)}`);
            await a.close();
        }
        {
            // the log line: the field the app's log reads, not one it drops
            const lines = [];
            const editor = new FakeEditor();
            const { a } = assistantOn(editor, [], { log: { record: (e) => lines.push(e) } });
            a.record("a line from the assistant");
            const src = require("node:fs").readFileSync(path.join(ROOT, "electron", "main", "log.js"), "utf8");
            const reads = /function record\(\{[^}]*\bmessage\b/.test(src);
            check("the_assistant_log_line_carries_the_field_the_log_reads",
                lines.length === 1 && lines[0].message === "a line from the assistant" && lines[0].source === "assistant" && reads,
                `${JSON.stringify(lines[0])}; log.js reads message: ${reads}`);
            await a.close();
        }
        {
            // state() answers the panel at once, even when the renderer is not ready yet
            const editor = new FakeEditor();
            const { a } = assistantOn(editor, [anthropicStream([{ type: "text", text: "hi" }])]);
            await a.send("hello");
            editor.ready = false;
            a.toolsDirty = true;
            const t0 = Date.now();
            const s = await a.state();
            const took = Date.now() - t0;
            check("state_does_not_wait_for_a_renderer_that_is_not_ready",
                took < 200 && s.toolsChanged === null && a.toolsDirty === true,
                `${took} ms, toolsDirty still ${a.toolsDirty}`);
            editor.ready = true;
            await a.state();
            check("the_tool_diff_is_read_when_the_renderer_is_ready_again", a.toolsDirty === false, `toolsDirty ${a.toolsDirty}`);
            a.toolsChanged = { added: ["x"], removed: [] };
            a.toolsDirty = true;
            await a.reset();
            check("reset_leaves_no_tool_diff_of_the_old_chat", a.toolsChanged === null && a.toolsDirty === false, JSON.stringify(a.toolsChanged));
            await a.close();
        }
        {
            // the OpenRouter list belongs to the base it came from
            const editor = new FakeEditor();
            const { a, fetchImpl } = assistantOn(editor, []);
            await a.openrouterModels();
            await a.openrouterModels();
            const once = fetchImpl.got.length;
            a.settings = () => ({ base: "http://127.0.0.1:5600", model: "anthropic:claude-sonnet-5" });
            await a.openrouterModels().catch(() => {});
            check("the_openrouter_list_is_read_again_for_another_base",
                once === 1 && fetchImpl.got.length === 2 && /5599/.test(fetchImpl.got[0].url) && /5600/.test(fetchImpl.got[1].url),
                `${fetchImpl.got.length} GETs: ${fetchImpl.got.map((g) => g.url).join(", ")}`);
            await a.close();
        }
        {
            // the local server's key follows the same rule as a turn's key (§2 row 27)
            const settings = { llm: { compat: { url: "http://127.0.0.1:11434/v1" } } };
            const auth = async (base, key) => {
                const { a, fetchImpl } = assistantOn(new FakeEditor(), [], { settings, assistant: { base }, keys: { compat: key } });
                await a.compatModels();
                await a.close();
                return (fetchImpl.got[0].headers || {}).Authorization || null;
            };
            const testReal = await auth("http://127.0.0.1:5599", "sk-real-0000");
            const testTest = await auth("http://127.0.0.1:5599", "test-compat-0000");
            const ownReal = await auth("", "sk-real-0000");
            const ownTest = await auth("", "test-compat-0000");
            check("the_local_servers_key_follows_the_key_rule",
                testReal === null && testTest === "Bearer test-compat-0000" && ownReal === "Bearer sk-real-0000" && ownTest === null,
                `test base: ${testReal} / ${testTest}; the user's own URL: ${ownReal} / ${ownTest}`);
        }
    });


    // ---- 17. OpenAI Responses and Gemini (A3) ---------------------------------------------
    await section("17. OpenAI Responses and Gemini (A3)", async () => {
        const responses = require(path.join(ROOT, "electron", "main", "assistant", "responses.js"));
        const gemini = require(path.join(ROOT, "electron", "main", "assistant", "gemini.js"));
        const OPENAI = ["openai", "gpt-5.6-terra"];
        const GEMINI = ["gemini", "gemini-3.8-flash"];

        // ---- the golden bodies
        {
            const editor = new FakeEditor();
            const { a } = familyOn(editor, [], ...OPENAI);
            await a.connect();
            const chat = await a.newChat();
            const history = [
                chat.adapter.userMessage("Open documents (1):", "look at it"),
                { type: "reasoning", id: "rs_1", encrypted_content: "enc-1", summary: [] },
                { type: "function_call", id: "fc_1", call_id: "call_1", name: "screenshot", arguments: "{}", status: "completed" },
                ...chat.adapter.resultsMessages([{ id: "call_1", name: "screenshot" }],
                    [{ content: [{ type: "image", data: "QUJD", mimeType: "image/jpeg" }, { type: "text", text: "{\"width\": 1024}" }] }]),
            ];
            const body = chat.adapter._bodyFor(chat, history);
            check("responses_sends_the_familys_body",
                eq(Object.keys(body).sort(), ["include", "input", "instructions", "max_output_tokens", "model", "prompt_cache_key", "reasoning", "store", "stream", "tools"])
                && body.store === false && body.stream === true && body.model === "gpt-5.6-terra"
                && body.instructions === chat.system && body.input === history && body.max_output_tokens === 32000
                && body.prompt_cache_key === chat.id && eq(body.reasoning, { effort: "medium" })
                && eq(body.include, ["reasoning.encrypted_content"])
                && body.tools[0].type === "function" && typeof body.tools[0].name === "string" && body.tools[0].strict === false
                && body.tools[0].parameters && body.tools[0].annotations === undefined
                && body.tool_choice === undefined && body.parallel_tool_calls === undefined && body.previous_response_id === undefined
                && body.temperature === undefined,
                `${Object.keys(body).join(", ")}; ${body.tools.length} tools`);
            check("a_screenshot_goes_into_function_call_output",
                history[3].type === "function_call_output" && history[3].call_id === "call_1"
                && Array.isArray(history[3].output) && history[3].output[0].type === "input_text"
                && history[3].output[1].type === "input_image" && history[3].output[1].image_url === "data:image/jpeg;base64,QUJD"
                && history[3].output[1].detail === "auto",
                short(history[3]));
            await a.close();
        }
        {
            const editor = new FakeEditor();
            const { a } = familyOn(editor, [], ...GEMINI);
            await a.connect();
            const chat = await a.newChat();
            const history = [
                chat.adapter.userMessage("Open documents (1):", "look at it"),
                { role: "model", parts: [{ text: "", thoughtSignature: "ts-1" }, { functionCall: { id: "call_1", name: "screenshot", args: {} } }] },
                ...chat.adapter.resultsMessages([{ id: "call_1", rawId: "call_1", name: "screenshot" }],
                    [{ content: [{ type: "image", data: "QUJD", mimeType: "image/jpeg" }, { type: "text", text: "{\"width\": 1024}" }] }]),
            ];
            const body = chat.adapter._bodyFor(chat, history);
            const fr = (((history[2] || {}).parts || [])[0] || {}).functionResponse || { response: {}, parts: [] };
            check("gemini_sends_the_familys_body",
                eq(Object.keys(body).sort(), ["contents", "generationConfig", "systemInstruction", "tools"])
                && eq(body.systemInstruction, { parts: [{ text: chat.system }] }) && body.contents === history
                && body.generationConfig.maxOutputTokens === 32000
                && eq(body.generationConfig.thinkingConfig, { thinkingLevel: "medium" })
                && body.tools.length === 1 && Array.isArray(body.tools[0].functionDeclarations)
                && body.tools[0].functionDeclarations[0].parametersJsonSchema
                && body.tools[0].functionDeclarations.every((d) => d.parameters === undefined && d.annotations === undefined)
                && body.toolConfig === undefined && body.safetySettings === undefined,
                `${Object.keys(body).join(", ")}; ${body.tools[0].functionDeclarations.length} declarations`);
            check("a_screenshot_goes_into_function_response_parts",
                history[2].role === "user" && fr.id === "call_1" && fr.name === "screenshot"
                && ((fr.parts || [])[0] || {}).inlineData && fr.parts[0].inlineData.mimeType === "image/jpeg"
                && fr.parts[0].inlineData.data === "QUJD" && fr.parts[0].inlineData.displayName === "screenshot-call_1-0"
                && eq(fr.response.screenshot, { $ref: "screenshot-call_1-0" }) && fr.response.width === 1024,
                short(history[2]));
            await a.close();
        }

        // ---- the loop, and the replay each family needs
        {
            const editor = new FakeEditor();
            const { a, events, fetchImpl } = familyOn(editor, [
                responsesStream([
                    { type: "reasoning", encrypted: "enc-1" },
                    { type: "function_call", callId: "call_1", name: "list_layers", input: { doc: 1 } },
                ]),
                responsesStream([{ type: "reasoning", id: "rs_2", encrypted: "enc-2" }, { type: "text", text: "One layer.", pieces: ["One ", "layer."] }]),
            ], ...OPENAI);
            const out = await a.send("what is in the picture?");
            const sent = fetchImpl.sent[1].body.input;
            const first = fetchImpl.sent[0].body;
            check("responses_runs_the_loop",
                out.reason === "end" && out.steps === 1 && fetchImpl.sent.length === 2
                && fetchImpl.sent[0].url === "http://127.0.0.1:5599/v1/responses"
                && fetchImpl.sent[0].headers.Authorization === "Bearer test-openai-0000"
                && first.input.length === 1 && first.input[0].content[0].type === "input_text"
                && events.some((e) => e.type === "assistant:text" && /One layer/.test(e.text))
                && a.chat.usage.input === 200 && a.chat.usage.output === 40 && a.chat.usage.reasoning === 10,
                `${out.reason}, ${out.steps} step, ${fetchImpl.sent.length} requests`);
            check("reasoning_items_go_back_with_store_false",
                eq(sent[1], { type: "reasoning", id: "rs_1", encrypted_content: "enc-1", summary: [] })
                && eq(sent[2], { type: "function_call", id: "fc_1", call_id: "call_1", name: "list_layers", arguments: "{\"doc\":1}", status: "completed" })
                && sent[3].type === "function_call_output" && sent[3].call_id === "call_1" && /"layers"/.test(sent[3].output)
                && fetchImpl.sent[1].body.store === false,
                sent.map((i) => i.type).join(" | "));
            await a.close();
        }
        {
            const editor = new FakeEditor();
            const { a, events, fetchImpl } = familyOn(editor, [
                geminiStream([
                    { type: "signature", signature: "ts-1" },
                    { type: "function_call", id: "call_1", name: "list_layers", args: { doc: 1 } },
                ]),
                geminiStream([{ type: "text", text: "One layer.", pieces: ["One ", "layer."] }]),
            ], ...GEMINI);
            const out = await a.send("what is in the picture?");
            const contents = fetchImpl.sent[1].body.contents;
            const model = contents[1];
            check("gemini_runs_the_loop",
                out.reason === "end" && out.steps === 1 && fetchImpl.sent.length === 2
                && fetchImpl.sent[0].url === "http://127.0.0.1:5599/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse"
                && fetchImpl.sent[0].headers["x-goog-api-key"] === "test-gemini-0000"
                && contents[0].role === "user" && contents[0].parts[0].text
                && events.some((e) => e.type === "assistant:text" && /One layer/.test(e.text))
                && a.chat.usage.input === 200 && a.chat.usage.output === 40 && a.chat.usage.reasoning === 10,
                `${out.reason}, ${out.steps} step, ${fetchImpl.sent.length} requests`);
            check("thought_signatures_go_back_unchanged",
                model.role === "model" && model.parts.length === 2
                && eq(model.parts[0], { text: "", thoughtSignature: "ts-1" })
                && eq(model.parts[1], { functionCall: { id: "call_1", name: "list_layers", args: { doc: 1 } } })
                && contents[2].role === "user" && contents[2].parts[0].functionResponse.id === "call_1",
                short(model.parts));
            const second = a.chat.history[a.chat.history.length - 1];
            check("streamed_gemini_parts_are_never_merged",
                second.role === "model" && second.parts.length === 2 && eq(second.parts.map((p) => p.text), ["One ", "layer."]),
                short(second.parts));
            await a.close();
        }

        // ---- images: in the result, and pruned at the next user message
        {
            const editor = new FakeEditor();
            // pruning runs at a new user message once more than twice `keepImages` are attached
            const { a, fetchImpl } = familyOn(editor, [
                responsesStream([{ type: "function_call", id: "fc_1", callId: "c1", name: "screenshot", input: {} }]),
                responsesStream([{ type: "text", text: "seen" }]),
                responsesStream([{ type: "function_call", id: "fc_2", callId: "c2", name: "screenshot", input: {} }]),
                responsesStream([{ type: "text", text: "seen again" }]),
                responsesStream([{ type: "function_call", id: "fc_3", callId: "c3", name: "screenshot", input: {} }]),
                responsesStream([{ type: "text", text: "seen once more" }]),
                responsesStream([{ type: "text", text: "nothing new" }]),
            ], ...OPENAI, { assistant: { keepImages: 1 } });
            await a.send("look");
            await a.send("look again");
            await a.send("once more");
            await a.send("and now?");
            const last = fetchImpl.sent[6].body.input.filter((i) => i.type === "function_call_output");
            const images = last.map((i) => (Array.isArray(i.output) ? i.output.filter((p) => p.type === "input_image").length : 0));
            check("old_screenshots_are_pruned_on_responses",
                last.length === 3 && eq(images, [0, 0, 1])
                && Array.isArray(last[0].output) && last[0].output.some((p) => p.type === "input_text" && p.text === responses.STUB),
                `images per result: ${images.join(", ")}`);
            await a.close();
        }
        {
            const editor = new FakeEditor();
            const { a, fetchImpl } = familyOn(editor, [
                geminiStream([{ type: "function_call", id: "c1", name: "screenshot", args: {} }]),
                geminiStream([{ type: "text", text: "seen" }]),
                geminiStream([{ type: "function_call", id: "c2", name: "screenshot", args: {} }]),
                geminiStream([{ type: "text", text: "seen again" }]),
                geminiStream([{ type: "function_call", id: "c3", name: "screenshot", args: {} }]),
                geminiStream([{ type: "text", text: "seen once more" }]),
                geminiStream([{ type: "text", text: "nothing new" }]),
            ], ...GEMINI, { assistant: { keepImages: 1 } });
            await a.send("look");
            await a.send("look again");
            await a.send("once more");
            await a.send("and now?");
            const results = fetchImpl.sent[6].body.contents
                .flatMap((c) => (c.parts || []).filter((p) => p.functionResponse).map((p) => p.functionResponse));
            check("old_screenshots_are_pruned_on_gemini",
                results.length === 3 && results.slice(0, 2).every((r) => r.parts === undefined && r.response.screenshot_removed === gemini.STUB)
                && results[2].parts && results[2].parts[0].inlineData.data === "QUJD"
                && eq(results[2].response.screenshot, { $ref: results[2].parts[0].inlineData.displayName }),
                `${results.length} results, kept: ${results.map((r) => (r.parts ? 1 : 0)).join("")}`);
            await a.close();
        }

        // ---- the ends of a turn
        {
            const rows = [];
            for (const [name, streams, want] of [
                ["responses_cut", [responsesStream([{ type: "text", text: "half" }], { status: "incomplete" })], "cut"],
                ["responses_refusal", [responsesStream([{ type: "refusal", refusal: "no" }])], "refusal"],
                ["gemini_cut", [geminiStream([{ type: "text", text: "half" }], { finish: "MAX_TOKENS" })], "cut"],
                ["gemini_refusal", [geminiStream([{ type: "text", text: "" }], { finish: "SAFETY" })], "refusal"],
            ]) {
                const editor = new FakeEditor();
                const openai = name.startsWith("responses");
                const { a } = familyOn(editor, streams, ...(openai ? OPENAI : GEMINI));
                const out = await a.send("go");
                if (out.reason !== want) rows.push(`${name}: ${out.reason} (want ${want})`);
                await a.close();
            }
            check("a_cut_and_a_refusal_end_the_turn_on_both_families", !rows.length, rows.join("; ") || "cut and refusal on both");
        }
        {
            const rows = [];
            for (const [name, body, family] of [
                ["responses", responsesStream([{ type: "text", text: "half" }], { noEnd: true }), OPENAI],
                ["gemini", geminiStream([{ type: "text", text: "half" }], { noFinish: true }), GEMINI],
            ]) {
                const editor = new FakeEditor();
                const { a } = familyOn(editor, [body], ...family);
                const out = await a.send("go");
                const pushed = a.chat.history.length;
                if (out.reason !== "error" || !/ended before the answer was finished/.test(out.detail) || pushed !== 1) {
                    rows.push(`${name}: ${out.reason} ${out.detail} (${pushed} messages)`);
                }
                await a.close();
            }
            check("a_stream_that_ends_early_pushes_nothing_on_both_families", !rows.length, rows.join("; ") || "one user message each, nothing of the answer");
        }



        // ---- what this family sends back when the call carried no id, and what a result that is
        //      not an object looks like in a `response`, which has to be a struct
        {
            const editor = new FakeEditor();
            const { a, fetchImpl } = familyOn(editor, [
                geminiStream([{ type: "function_call", name: "list_layers", args: { doc: 1 } }]),
                geminiStream([{ type: "text", text: "one layer" }]),
            ], ...GEMINI);
            const out = await a.send("look");
            const answered = fetchImpl.sent[1].body.contents
                .flatMap((c) => (c.parts || []).filter((p) => p.functionResponse).map((p) => p.functionResponse));
            check("a_call_without_an_id_is_answered_without_one",
                out.reason === "end" && out.steps === 1 && answered.length === 1
                && answered[0].id === undefined && answered[0].name === "list_layers" && answered[0].response.layers,
                short(answered[0]));
            const scalarList = gemini._answerOf("[1, 2, 3]", false);
            const object = gemini._answerOf("{\"layers\": []}", false);
            const plain = gemini._answerOf("ok", false);
            const error = gemini._answerOf("refused by Scumble", true);
            check("a_response_is_always_a_struct",
                eq(scalarList, { result: [1, 2, 3] }) && eq(object, { layers: [] })
                && eq(plain, { result: "ok" }) && eq(error, { error: "refused by Scumble" }),
                [scalarList, object, plain, error].map((x) => JSON.stringify(x)).join(" "));
            await a.close();
        }

        // ---- the loop's own rules, on both families: Stop, the ask, the caps, a retry
        {
            const rows = [];
            for (const [name, family, make] of [
                ["responses", OPENAI, () => responsesStream([{ type: "function_call", callId: "c1", name: "add_paint_layer", input: { doc: 1 } }])],
                ["gemini", GEMINI, () => geminiStream([{ type: "function_call", id: "c1", name: "add_paint_layer", args: { doc: 1 } }])],
            ]) {
                const editor = new FakeEditor();
                let live = null;
                const { a } = familyOn(editor, async () => {
                    if (live && live.turn) live.turn.stopped = true;     // Stop as the last byte arrives
                    return sseResponse(make());
                }, ...family);
                live = a;
                const out = await a.send("add a layer");
                const answered = a.chat.history.some((m) => m.role === "model" || m.type === "function_call");
                if (out.reason !== "stopped" || answered || editor.calls.some((c) => c.name === "add_paint_layer")) {
                    rows.push(`${name}: ${out.reason}, ${a.chat.history.length} messages`);
                }
                await a.close();
            }
            check("a_stop_appends_nothing_on_both_families", !rows.length, rows.join("; ") || "nothing appended, nothing run");
        }
        {
            const rows = [];
            for (const [name, family, streams] of [
                ["responses", OPENAI, [
                    responsesStream([{ type: "function_call", callId: "c1", name: "flatten", input: { doc: 1 } }]),
                    responsesStream([{ type: "text", text: "as you wish" }]),
                ]],
                ["gemini", GEMINI, [
                    geminiStream([{ type: "function_call", id: "c1", name: "flatten", args: { doc: 1 } }]),
                    geminiStream([{ type: "text", text: "as you wish" }]),
                ]],
            ]) {
                const editor = new FakeEditor();
                const { a, events, fetchImpl } = familyOn(editor, streams, ...family);
                const stop = answerAsks(a, events, false);               // the user declines
                const out = await a.send("flatten it");
                stop();
                const asked = events.filter((e) => e.type === "ask" && e.name === "flatten").length;
                const second = fetchImpl.sent[1].body;
                const answer = name === "responses"
                    ? (second.input.find((i) => i.type === "function_call_output") || {}).output
                    : JSON.stringify(((second.contents.find((c) => (c.parts || []).some((p) => p.functionResponse)) || { parts: [] })
                        .parts.find((p) => p.functionResponse) || {}).functionResponse);
                if (out.reason !== "end" || asked !== 1 || editor.calls.some((c) => c.name === "flatten") || !/declined/.test(String(answer))) {
                    rows.push(`${name}: ${out.reason}, ${asked} asks, answer ${short(answer)}`);
                }
                await a.close();
            }
            check("a_declined_call_is_answered_on_both_families", !rows.length, rows.join("; ") || "flatten asked, declined, answered as an error result");
        }
        {
            // the provider's own request cap: Gemini's 18 MB, not the adapter's 24
            const editor = new FakeEditor();
            const { a } = familyOn(editor, [geminiStream([{ type: "text", text: "never sent" }])], ...GEMINI);
            await a.connect();
            a.chat = await a.newChat();
            a.chat.history.push({ role: "user", parts: [{ text: "x".repeat(19 * 1024 * 1024) }] });
            const out = await a.send("and now?");
            check("the_request_cap_is_the_providers_on_gemini",
                out.reason === "full" && /19 MB|18 MB|too long/.test(out.detail) && gemini.REQUEST_CAP === 18 * 1024 * 1024,
                `${out.reason}: ${out.detail}`);
            await a.close();
        }
        {
            // a 429 before the first byte is retried on both families, with the same rule
            const rows = [];
            for (const [name, family, body] of [
                ["responses", OPENAI, () => responsesStream([{ type: "text", text: "second try" }])],
                ["gemini", GEMINI, () => geminiStream([{ type: "text", text: "second try" }])],
            ]) {
                const editor = new FakeEditor();
                let n = 0;
                const { a } = familyOn(editor, async () => {
                    n++;
                    if (n === 1) return sseResponse("{\"error\":{\"message\":\"slow down\"}}", { status: 429, headers: { "retry-after": "0" } });
                    return sseResponse(body());
                }, ...family);
                const out = await a.send("go");
                if (out.reason !== "end" || n !== 2) rows.push(`${name}: ${out.reason} after ${n} requests`);
                await a.close();
            }
            check("a_429_is_retried_on_both_families", !rows.length, rows.join("; ") || "one retry each, then the answer");
        }



        // ---- the answers that never come back by waiting (the live checkpoint of 2026-09-20
        //      found this: a capped Google project answers 429, and the retries asked three
        //      more times before the user saw anything)
        {
            const rows = [];
            const CAP = JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Your project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/spend to manage your project spend cap." } });
            const RATE = JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for quota metric 'Generate requests per minute'." } });
            const QUOTA = JSON.stringify({ error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } });
            const BADKEY = JSON.stringify({ error: { message: "Incorrect API key provided: key_QW****cF.", type: "invalid_request_error", code: "invalid_api_key" } });
            const ANTH = JSON.stringify({ type: "error", error: { type: "authentication_error", message: "API key is invalid." } });
            for (const [name, family, body, status, wantFinal, words] of [
                ["gemini spending cap", GEMINI, CAP, 429, true, /spending cap/],
                ["gemini rate limit", GEMINI, RATE, 429, false, null],
                ["openai no credit", OPENAI, QUOTA, 429, true, /no credit left/],
                ["openai bad key", OPENAI, BADKEY, 401, true, /not valid/],
                ["anthropic bad key", ["anthropic", "claude-sonnet-5"], ANTH, 401, true, /Anthropic key is not valid/],
            ]) {
                const editor = new FakeEditor();
                let n = 0;
                const { a } = familyOn(editor, async () => {
                    n++;
                    if (n > 3 && !wantFinal) return sseResponse(geminiStream([{ type: "text", text: "after the wait" }]));
                    return sseResponse(body, { status, headers: { "retry-after": "0" } });
                }, ...family);
                const out = await a.send("go");
                const tried = n;
                const ok = wantFinal
                    ? (out.reason === "error" && tried === 1 && words.test(out.detail) && !/HTTP|\{/.test(out.detail))
                    : (out.reason === "end" && tried === 4);
                if (!ok) rows.push(`${name}: ${out.reason} after ${tried} requests: ${short(out.detail)}`);
                await a.close();
            }
            check("a_final_answer_is_not_retried_and_reads_as_words", !rows.length,
                rows.join(" | ") || "the spending cap and the empty account end at once; a rate limit is retried");
        }

        // ---- the loop itself adds the text of a stopped turn in the family's own shape
        {
            const rows = [];
            for (const [name, family, again] of [
                ["responses", OPENAI, () => responsesStream([{ type: "text", text: "ok" }])],
                ["gemini", GEMINI, () => geminiStream([{ type: "text", text: "ok" }])],
            ]) {
                const editor = new FakeEditor();
                let live = null;
                let n = 0;
                const sent = [];
                const { a } = familyOn(editor, async (url, init) => {
                    sent.push(JSON.parse(init.body));
                    n++;
                    if (n === 1) { if (live && live.turn) live.turn.stopped = true; return sseResponse(again()); }
                    return sseResponse(again());
                }, ...family);
                live = a;
                const first = await a.send("first");
                const out = await a.send("second");
                const body = sent[1];
                const pending = name === "responses" ? body.input[0] : body.contents[0];
                const parts = name === "responses" ? pending.content : pending.parts;
                const shapes = parts.map((p) => (name === "responses" ? p.type : (typeof p.text === "string" ? "text" : "?")));
                const ok = first.reason === "stopped" && out.reason === "end"
                    && parts.length === 4 && shapes.every((t) => t === (name === "responses" ? "input_text" : "text"))
                    && parts[parts.length - 1].text === "second"
                    && (name === "responses" ? body.input.length : body.contents.length) === 1;   // the two texts are one pending message
                if (!ok) rows.push(`${name}: ${first.reason}/${out.reason}, ${shapes.join(",")}`);
                await a.close();
            }
            check("the_loop_adds_the_stopped_turns_text_in_the_familys_shape", !rows.length,
                rows.join("; ") || "one pending user message each, four parts of the family's own kind");
        }

        // ---- the text of a stopped turn joins the pending user message in the family's own shape
        {
            const editor = new FakeEditor();
            const { a } = familyOn(editor, [
                responsesStream([{ type: "function_call", callId: "c1", name: "list_layers", input: { doc: 1 } }]),
                responsesStream([{ type: "text", text: "ok" }]),
            ], ...OPENAI);
            await a.send("first");
            a.chat.history.push(a.chat.adapter.userMessage(null, "pending"));
            const before = a.chat.history.length;
            (a.chat.adapter.appendUserText)(a.chat.history[a.chat.history.length - 1], "note", "more");
            const item = a.chat.history[a.chat.history.length - 1];
            check("the_pending_user_message_takes_the_familys_own_parts",
                a.chat.history.length === before && item.type === "message" && item.role === "user"
                && item.content.length === 3 && item.content.every((p) => p.type === "input_text")
                && item.content[2].text === "more",
                short(item.content));
            const ed2 = new FakeEditor();
            const g = familyOn(ed2, [geminiStream([{ type: "text", text: "ok" }])], ...GEMINI);
            await g.a.send("first");
            const content = g.a.chat.adapter.userMessage(null, "pending");
            g.a.chat.adapter.appendUserText(content, "note", "more");
            check("the_pending_gemini_content_takes_text_parts",
                content.role === "user" && content.parts.length === 3 && content.parts.every((p) => typeof p.text === "string")
                && content.parts[2].text === "more",
                short(content.parts));
            await a.close();
            await g.a.close();
        }
    });


    // ---- 18. the panel's one rule that a test can hold it to (A5) --------------------------
    await section("18. the panel writes no markup (A5)", async () => {
        const fs = require("node:fs");
        const src = fs.readFileSync(path.join(ROOT, "renderer", "assistant.js"), "utf8");
        // The model's answer, a layer name, a log line and a tool result all end up in the panel.
        // Every one of them is somebody else's text, so none of it may be written as markup.
        const banned = [/\.innerHTML\s*=/, /\.outerHTML\s*=/, /insertAdjacentHTML/, /document\.write/, /\bnew Function\b/, /dangerously/i];
        const hits = banned.filter((re) => re.test(src)).map((re) => String(re));
        check("no_markup_writes", !hits.length, hits.join(", ") || `${src.length} bytes of renderer/assistant.js, none of them markup`);
        check("the_panel_builds_its_nodes",
            /createElement\(/.test(src) && /textContent/.test(src) && /createTextNode/.test(src),
            "createElement, textContent and createTextNode are how it builds");
    });

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + ((err && err.stack) || err)); console.log("FAIL"); process.exit(1); });
