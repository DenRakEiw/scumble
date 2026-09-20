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
            layer: { type: "string", description: "id, name or \"active\"", default: "active" },
            mask: { type: "object", description: "a mask: rows of bytes, or a data URL" },
            visible: { type: "boolean", description: "show it" },
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

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + ((err && err.stack) || err)); console.log("FAIL"); process.exit(1); });
