// @ts-check
// The command core: every operation the editor offers as a plain, documented function
// (name, args) -> JSON. Ported from the node's MCP bridge (ComfyUI-InpaintCanvas
// js/inpaint_bridge.js, COMMANDS + TAB_COMMANDS); the node addressed graph nodes, the app
// addresses documents (tabs). Plugins call it through the `scumble.commands` API, the MCP
// server (phase 4c) maps every entry to a tool, tests run it from the console:
//
//     const { commands } = await import("./commands.js");
//     await commands.run("status");
//     await commands.run("select_rect", { x: 10, y: 10, w: 200, h: 100, doc: 3 });
//
// Every command has `params` (a schema: type, description, default, required, enum) and a
// `description`, so `commands.describe()` is enough to build a tool list or a help page.
// Document commands take `doc` (the editor id shown in list_documents); without it the
// active tab is used. App commands (`scope: "app"`) take no document.

import { host } from "./editor/host.js";
import { VERSION, applyParams, bounds, checkParams, describe, docSummary, editorFor, findGroup, findLayer, groupSummary, layerSummary, requireImage, shotCanvas, status, touch, bindUtil } from "./commands_util.js";
import { DocCommandsPart } from "./commands_docs.js";
import { SelectCommandsPart } from "./commands_select.js";
import { GenCommandsPart } from "./commands_gen.js";
import { RunCommandsPart, bindRunCommands } from "./commands_runs.js";
import { LayerCommandsPart } from "./commands_layers.js";
import { EditCommandsPart } from "./commands_edit.js";
import { DepthCommandsPart, bindDepthCommands } from "./commands_depth.js";

// ---- the shape of a command ------------------------------------------------------------------
//
// Three consumers read this table and have to agree with it: the MCP server
// (electron/main/mcp/server.js turns every descriptor into a tool with a JSON schema), the
// assistant's policy (electron/main/assistant/policy.js decides per command name and
// parameter), and docs/COMMANDS.md. The typedefs below are that agreement written down;
// types/contracts.js is where it is checked.

/**
 * One parameter, in the subset of JSON Schema the MCP server emits.
 *
 * @typedef {Object} CommandParam
 * @property {"string" | "number" | "integer" | "boolean" | "object" | "array"} type
 * @property {string} [description]
 * @property {any} [default]
 * @property {boolean} [required]
 * @property {any[]} [enum]
 * @property {any} [items]
 * @property {number} [minimum]
 * @property {number} [maximum]
 */

/**
 * One command. `scope: "app"` means it takes no document; every other command gets the
 * editor of `args.doc`, or the active tab, as its first argument.
 *
 * @typedef {Object} Command
 * @property {string} description
 * @property {Record<string, CommandParam>} params
 * @property {"app" | "doc"} [scope]
 * @property {boolean} [needsImage]     refuse when the document has no picture
 * @property {boolean} [readOnly]       changes nothing (the MCP hint readOnlyHint); unset: false for a built-in
 * @property {boolean} [destructive]    may lose something: a document, a layer, layers merged, a crop, a file written
 *                                      over, the recipe's settings (the MCP hint destructiveHint); unset: false for a built-in
 * @property {string} [owner]           the plugin that registered it, unset for the built-ins
 * @property {(ed: any, args: any) => any} run
 */

/**
 * The table as data: what a tool list, a help page or a policy table is built from.
 *
 * @typedef {Object} CommandDescriptor
 * @property {string} name
 * @property {string} description
 * @property {"app" | "doc"} scope
 * @property {boolean} needsImage
 * @property {string | null} plugin
 * @property {boolean | null} readOnly     null: a plugin command that declares none (the MCP server judges it by its name)
 * @property {boolean | null} destructive  null: as readOnly
 * @property {Record<string, CommandParam>} params
 */

/**
 * What the shell publishes as `commands` (and the bridge, the plugins and the MCP server
 * call). `call` never throws; `run` throws with a readable message.
 *
 * @typedef {Object} CommandCore
 * @property {number} version
 * @property {() => string[]} names
 * @property {(name: string) => boolean} has
 * @property {() => CommandDescriptor[]} describe
 * @property {(name: string, args?: any) => Promise<any>} run
 * @property {(name: string, args?: any) => Promise<{ ok: boolean, result?: any, error?: string }>} call
 * @property {(name: string, def: Command, owner?: string) => void} register
 * @property {(name: string, owner?: string) => void} unregister
 */

// ---- the commands ----------------------------------------------------------------------------
//
// { description, params, scope?: "app" | "doc" (default doc), needsImage?, readOnly?, destructive?, run(ed, args) }

/** @satisfies {Record<string, Command>} */
const COMMANDS = {
    ...DocCommandsPart,
    ...SelectCommandsPart,
    ...GenCommandsPart,
    ...RunCommandsPart,
    ...LayerCommandsPart,
    ...EditCommandsPart,
    ...DepthCommandsPart,
};
bindUtil(COMMANDS);
bindRunCommands(COMMANDS);
bindDepthCommands(COMMANDS);

/** @type {CommandCore} */
export const commands = {
    version: VERSION,
    names: () => Object.keys(COMMANDS),
    has: (name) => Object.prototype.hasOwnProperty.call(COMMANDS, name),
    describe,
    /** Run one command. Throws with a readable message on any failure. */
    async run(name, args = {}) {
        const c = COMMANDS[name];
        if (!c) throw new Error(`unknown command "${name}" (${Object.keys(COMMANDS).join(", ")})`);
        const ed = editorFor(name, args);
        if (c.needsImage) requireImage(ed);
        const result = await c.run(ed, args || {});
        return result === undefined ? null : result;
    },
    /** Like run, but never throws: { ok, result } or { ok: false, error }. */
    async call(name, args) {
        try { return { ok: true, result: await this.run(name, args) }; }
        catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
    },
    /** Add a command at runtime (plugins): { description, params, scope, needsImage, run(ed, args) }. */
    register(name, def, owner) {
        if (COMMANDS[name] && !(COMMANDS[name].owner && COMMANDS[name].owner === owner)) throw new Error(`command "${name}" exists`);
        COMMANDS[name] = { ...def, owner };
    },
    unregister(name, owner) {
        if (COMMANDS[name] && COMMANDS[name].owner === owner) delete COMMANDS[name];
    },
};

host.commands = commands;

export { docSummary, layerSummary, findGroup, groupSummary, findLayer, touch, shotCanvas, bounds, status, checkParams, applyParams, describe };
