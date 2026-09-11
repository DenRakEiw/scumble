// The stdio MCP server: every command of the command core (renderer/commands.js, plus the
// commands plugins register) is one tool. Started by `Scumble --mcp`; the tool calls reach
// the editor either in this process (headless window, electron/main/bridge.js) or in the
// Scumble instance that is already running (electron/main/local.js). Stdout belongs to the
// protocol, so main.js sends every console line to stderr in this mode.
//
// Tool names: command names with "." replaced by "_" (MCP clients allow [A-Za-z0-9_-] only),
// so the film plugin's `film.apply_look` is the tool `film_apply_look`. `screenshot` answers
// with image content so the model sees the picture. Errors come back as the command core's
// message with isError, never as a protocol error.
"use strict";

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

const INSTRUCTIONS = `Scumble is a desktop image editor for AI inpainting (layers, selection by text,
filters, colour match, text layers) that renders through the user's own ComfyUI or an API
provider. You drive the editor through these tools; every tool is one editor command.

Documents are tabs: list_documents shows them, document commands take \`doc\` (an id) and
otherwise use the active tab. Typical round trip: load_image (or status to see what is
loaded) -> select_rect / select_by_text -> set_prompt -> generate (the result comes back as a
layer over the selection) -> screenshot to look at it -> set_layer(match=...) to blend the
colours -> export. Coordinates are image pixels, origin top left. Layers are addressed by id,
name, a unique part of the name, or "active". generate needs a selected recipe
(list_recipes / select_recipe) and, for local recipes, a connected ComfyUI. Always screenshot
after a change you cannot judge from numbers. Selections, layers and settings persist in the
editor between calls; the user may be looking at the same window.`;

const READ_ONLY = /^(ping|list_|status$|get_|filter_types|screenshot|describe)/;

function jsonType(t) {
    return ["string", "number", "integer", "boolean", "array"].includes(t) ? t : null;   // "object" params take anything (masks are arrays or strings)
}

function toolName(command) {
    return String(command).replace(/[^A-Za-z0-9_-]/g, "_");
}

/** One command description (commands.describe() entry) as an MCP tool. */
function toTool(c) {
    const properties = {};
    const required = [];
    for (const [k, p] of Object.entries(c.params || {})) {
        const prop = {};
        const t = jsonType(p.type);
        if (t) prop.type = t;
        let d = p.description || "";
        if (p.default !== undefined && p.default !== null && p.default !== "") d += (d ? " " : "") + `Default: ${JSON.stringify(p.default)}.`;
        if (d) prop.description = d;
        if (Array.isArray(p.enum)) prop.enum = p.enum;
        properties[k] = prop;
        if (p.required) required.push(k);
    }
    let description = c.description || "";
    if (c.needsImage) description += " Needs a loaded image.";
    if (c.plugin) description += ` (plugin ${c.plugin})`;
    const tool = {
        name: toolName(c.name),
        description,
        inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
        annotations: { readOnlyHint: READ_ONLY.test(c.name), destructiveHint: /^(close_document|remove_layer|new_canvas|new_document|load_image)$/.test(c.name), openWorldHint: false },
    };
    return tool;
}

/** Text for the model: pretty JSON while it is small, compact above 16 kB. */
function textOf(result) {
    if (result === null || result === undefined) return "ok";
    if (typeof result === "string") return result;
    const pretty = JSON.stringify(result, null, 2);
    return pretty.length > 16384 ? JSON.stringify(result) : pretty;
}

/**
 * @param backend {run(name, args), describe(), on("changed"), info()}: the Bridge (in-process)
 *                or a LocalClient (proxy); `info()` yields {mode, pid} for `ping`.
 * @param opts    {version, onClose}
 */
async function serve(backend, opts = {}) {
    const server = new Server({ name: "scumble", version: opts.version || "0.0.0" }, {
        capabilities: { tools: { listChanged: true } },
        instructions: INSTRUCTIONS,
    });
    let names = new Map();   // tool name -> command name

    async function tools() {
        const list = await backend.describe();
        names = new Map(list.map((c) => [toolName(c.name), c.name]));
        return list.map(toTool);
    }

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await tools() }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const tool = req.params.name;
        if (!names.has(tool)) await tools();
        const name = names.get(tool);
        if (!name) return { content: [{ type: "text", text: `unknown tool "${tool}" (${[...names.keys()].join(", ")})` }], isError: true };
        const args = req.params.arguments || {};
        let result;
        try { result = await backend.run(name, args); }
        catch (err) { return { content: [{ type: "text", text: String((err && err.message) || err) }], isError: true }; }
        if (name === "ping" && result && typeof result === "object" && opts.info) result.mcp = opts.info();
        if (result && typeof result === "object" && typeof result.data === "string" && /^image\//.test(result.mime || "")) {
            const { data, mime, ...rest } = result;
            return { content: [{ type: "image", data, mimeType: mime }, { type: "text", text: textOf(rest) }] };
        }
        return { content: [{ type: "text", text: textOf(result) }] };
    });

    if (typeof backend.on === "function") backend.on("changed", () => server.sendToolListChanged().catch(() => { /* client gone */ }));

    // Electron's main process never sees `data` on process.stdin when stdin is a pipe on
    // Windows (the stream ends, the bytes are lost); a read stream on fd 0 works everywhere.
    const stdin = require("node:fs").createReadStream(null, { fd: 0 });
    const transport = new StdioServerTransport(stdin, process.stdout);
    let closed = false;
    transport.onclose = () => { if (closed) return; closed = true; if (opts.onClose) opts.onClose(); };
    // the transport does not watch for the end of stdin (the client went away): close then
    stdin.on("end", () => transport.close().catch(() => { /* already closed */ }));
    stdin.on("close", () => transport.close().catch(() => { /* already closed */ }));
    await server.connect(transport);
    return server;
}

module.exports = { serve, toTool, toolName, INSTRUCTIONS };
