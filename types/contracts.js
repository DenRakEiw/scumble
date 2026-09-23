// @ts-check
// The contracts, stated as assignments a type checker can decide. Nothing loads this file:
// it is not shipped, not imported by the app, and its imports exist so that the checker has
// the real objects in front of it (docs/PLAN_TYPES.md, stage 2). Running it would do
// nothing either - every statement here is a binding that is never read.
//
// Each `@type` below says: this implementation answers that contract. A member that
// disappears, changes arity or changes kind is an error here, at `npm run types`, instead of
// a ReferenceError in the editor or a tool list that no longer matches docs/COMMANDS.md.

import { api, host } from "../renderer/editor/host.js";
import { commands, describe } from "../renderer/commands.js";

/** The editor's ComfyUI surface. @type {import("../renderer/editor/host.js").EditorApi} */
const _api = api;

/**
 * The 40 members the editor modules call. The node's own js/host.js has to answer the same
 * list; only tools/build_node.py --check reaches that repository, and it greps for these
 * names.
 * @type {import("../renderer/editor/host.js").EditorHost}
 */
const _host = host;

/** The command core as the MCP server, the plugins and the assistant use it. @type {import("../renderer/commands.js").CommandCore} */
const _commands = commands;

/** The command table as data: what docs/COMMANDS.md and every tool list are built from. @type {() => import("../renderer/commands.js").CommandDescriptor[]} */
const _describe = describe;

void _api; void _host; void _commands; void _describe;
