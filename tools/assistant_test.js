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

/** A Response as postStream and readSse use it: ok, status, headers, body, text(). */
function sseResponse(text, opts = {}) {
    const chunks = opts.chunks || [text];
    const body = new ReadableStream({
        start(controller) {
            const enc = new TextEncoder();
            for (const c of chunks) controller.enqueue(enc.encode(c));
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

/** A fetch that answers the scripted streams in order and records every request. */
function scriptedFetch(streams) {
    const sent = [];
    const queue = streams.slice();
    const impl = async (url, init) => {
        sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
        const next = queue.shift();
        if (next === undefined) throw new Error("the model was called more often than the test scripted");
        if (typeof next === "function") return next(sent[sent.length - 1], sent.length);
        return sseResponse(next);
    };
    impl.sent = sent;
    impl.left = () => queue.length;
    return impl;
}

/** An Assistant wired to a fake editor and a scripted model. */
function assistantOn(editor, streams, opts = {}) {
    const { Assistant } = require(path.join(ROOT, "electron", "main", "assistant", "index.js"));
    const events = [];
    const fetchImpl = typeof streams === "function" ? streams : scriptedFetch(streams);
    const a = new Assistant({
        bridge: editor,
        keys: { get: () => (opts.key === undefined ? "test-anthropic-0000" : opts.key) },
        settings: { get: () => ({ assistant: { base: "http://127.0.0.1:5599", ...(opts.assistant || {}) } }) },
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
                users.length === 1 && users[0].content.some((p) => /stopped before it finished/.test(p.text)),
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
            check("a_stream_broken_after_its_first_byte_is_not_retried", calls === 1, `${calls} model calls, turn ${out.reason}`);
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

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + ((err && err.stack) || err)); console.log("FAIL"); process.exit(1); });
