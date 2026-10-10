// The starter inside the .mcpb bundle (docs/PLAN_MCPB.md): finds the Scumble installed on this PC and starts its MCP
// launcher, the way Help > Copy MCP registration registers it by hand. Plain Node, no dependency, no Electron API:
// it runs on the Node that ships with Claude Desktop.
//
//   node index.js [--scumble <Scumble.exe>] [--launcher <launch.js>] [--where] [-- <args for Scumble>]
//
// Scumble is looked for in this order, the first hit wins: an explicit path (--scumble, else SCUMBLE_EXE from the
// extension's settings), the GitHub installer (its uninstall registry key, then the default folders), the Microsoft
// Store copy (its execution alias). An explicit path that does not exist ends the search: the user asked for that
// file. When nothing is found the starter answers the protocol itself with one tool that says what to install.
//
// The installer and a portable copy are started as `Scumble.exe resources\app.asar\...\launch.js --mcp` in Node mode
// (ELECTRON_RUN_AS_NODE=1); the Store copy as its alias in Node mode with -e code that loads the launcher from the
// resources of whichever version the alias starts (electron/main/mcp/registration.js STORE_LAUNCH, copied here
// verbatim; tools/mcpb_test.js checks the two are equal). The launcher hands over a clean stdout, so this process
// only inherits the streams.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");

/** The code the Store alias runs in Node mode (electron/main/mcp/registration.js STORE_LAUNCH, verbatim). */
const STORE_LAUNCH = "process.argv.splice(1,0,'-e');require(require('path').join(process.resourcesPath,'app.asar','electron','main','mcp','launch.js'))";
/** The installer's uninstall key: uuid v5 of the appId app.scumble.desktop in electron-builder's namespace. */
const UNINSTALL_GUID = "7198d4e4-8820-55de-a96d-85d8f5c1ecfe";
const UNINSTALL_KEY = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${UNINSTALL_GUID}`;
const LAUNCHER = ["resources", "app.asar", "electron", "main", "mcp", "launch.js"];
const EXE = "Scumble.exe";
const ALIAS = "scumble.exe";
const RELEASES = "https://github.com/DenRakEiw/scumble/releases/latest";
const STORE_URL = "https://apps.microsoft.com/detail/9NDBTNNMXF2R";
const DOCS = "https://github.com/DenRakEiw/scumble/blob/main/docs/MCP.md";

let VERSION = "0.0.0";
try { VERSION = String(require("../manifest.json").version || VERSION); } catch (_) { /* unpacked without the manifest */ }

// ---- finding Scumble ---------------------------------------------------------------------------

/** True when `p` is set by the user: not empty, not the placeholder a client leaves when the field is empty. */
function isSet(p) {
    const s = String(p == null ? "" : p).trim();
    return s !== "" && !/^\$\{user_config\./.test(s);
}

/** The Store's execution alias or anything under a WindowsApps folder (the version folder of the package). */
function isStorePath(p) {
    return /[\\/]windowsapps[\\/]/i.test(String(p));
}

function defaultDeps(env = process.env) {
    const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return {
        env,
        platform: process.platform,
        localAppData,
        programFiles: env.ProgramFiles || "C:\\Program Files",
        /** lstat, not stat: an app execution alias answers EACCES to stat and exists to nothing else. */
        lstat: (p) => { try { fs.lstatSync(p); return true; } catch (_) { return false; } },
        exists: (p) => { try { return fs.existsSync(p); } catch (_) { return false; } },
        /** { name: value } of a registry key's string values, {} when the key is not there. */
        reg: (hive, key) => {
            const exe = path.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "reg.exe");
            const r = spawnSync(exe, ["query", `${hive}\\${key}`], { encoding: "utf8", windowsHide: true, timeout: 10000 });
            if (!r || r.status !== 0) return {};
            const out = {};
            for (const line of String(r.stdout).split(/\r?\n/)) {
                const m = /^\s*(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(line);
                if (m) out[m[1]] = m[2].trim();
            }
            return out;
        },
    };
}

/** The install folder is one with the exe and the packaged app beside it. */
function installAt(folder, deps) {
    if (!folder) return null;
    const exe = path.join(folder, EXE);
    return deps.exists(exe) && deps.exists(path.join(folder, "resources", "app.asar")) ? exe : null;
}

/** The folder of the first quoted (or bare) path in an uninstall string. */
function folderOfUninstall(s) {
    if (!s) return null;
    const m = /^\s*"([^"]+)"/.exec(s) || /^\s*(\S+\.exe)/i.exec(s);
    return m ? path.dirname(m[1]) : null;
}

/**
 * Where Scumble is: { exe, store, how } with how "explicit" | "installer" | "store", { missing } for an explicit
 * path that is not there, null when nothing was found. `explicit` is --scumble or SCUMBLE_EXE.
 */
function find(explicit, deps = defaultDeps()) {
    const given = isSet(explicit) ? String(explicit).trim() : (isSet(deps.env.SCUMBLE_EXE) ? String(deps.env.SCUMBLE_EXE).trim() : "");
    if (given) {
        if (!deps.lstat(given)) return { missing: given };
        return { exe: given, store: isStorePath(given), how: "explicit" };
    }
    if (deps.platform !== "win32") return null;
    const folders = [];
    for (const hive of ["HKCU", "HKLM"]) {
        const v = deps.reg(hive, UNINSTALL_KEY) || {};
        if (v.InstallLocation) folders.push(v.InstallLocation);
        const u = folderOfUninstall(v.UninstallString);
        if (u) folders.push(u);
    }
    folders.push(path.join(deps.localAppData, "Programs", "Scumble"), path.join(deps.programFiles, "Scumble"));
    for (const f of folders) {
        const exe = installAt(f, deps);
        if (exe) return { exe, store: false, how: "installer" };
    }
    const alias = path.join(deps.localAppData, "Microsoft", "WindowsApps", ALIAS);
    if (deps.lstat(alias)) return { exe: alias, store: true, how: "store" };
    return null;
}

/** { command, args, env } that starts the found Scumble's MCP launcher with `extra` before --mcp. */
function plan(found, extra = [], launcher = "") {
    const env = { ELECTRON_RUN_AS_NODE: "1" };
    if (found.store) return { command: found.exe, args: ["-e", STORE_LAUNCH, "--", ...extra, "--mcp"], env };
    const l = launcher || path.join(path.dirname(found.exe), ...LAUNCHER);
    return { command: found.exe, args: [l, ...extra, "--mcp"], env };
}

// ---- the answer when Scumble is missing ---------------------------------------------------------

function missingText(found) {
    const why = found && found.missing
        ? `The Scumble.exe set in this extension's settings does not exist: ${found.missing}.`
        : "No installed Scumble was found on this PC (neither the GitHub installer nor the Microsoft Store copy).";
    return [
        why,
        "Scumble is a free desktop editor for AI inpainting; this extension only starts its MCP server, so Scumble itself has to be installed.",
        `Install it from ${RELEASES} (the installer or the portable zip) or from the Microsoft Store (${STORE_URL}).`,
        "A portable copy or an install in another folder is named in this extension's settings as \"Scumble.exe\"; leave the field empty for an installed copy.",
        `Then restart the extension (or Claude Desktop). Documentation: ${DOCS}`,
    ].join(" ");
}

/** A stdio MCP server with one tool that explains what is missing (newline-delimited JSON-RPC, like the SDK's). */
function fallbackServer(found, input = process.stdin, output = process.stdout) {
    const text = missingText(found);
    process.stderr.write("scumble-mcpb: " + text + "\n");
    const tool = {
        name: "scumble_not_installed",
        description: "Scumble is not installed on this PC, so none of its tools are available. Call this tool for what to install and where.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    };
    const send = (msg) => output.write(JSON.stringify(msg) + "\n");
    const handle = (req) => {
        if (req.id === undefined) return;                                     // a notification (initialized, cancelled)
        const reply = (result) => send({ jsonrpc: "2.0", id: req.id, result });
        const error = (code, message) => send({ jsonrpc: "2.0", id: req.id, error: { code, message } });
        switch (req.method) {
            case "initialize":
                return reply({
                    protocolVersion: (req.params && req.params.protocolVersion) || "2025-06-18",
                    capabilities: { tools: {} },
                    serverInfo: { name: "scumble", version: VERSION },
                    instructions: text,
                });
            case "ping": return reply({});
            case "tools/list": return reply({ tools: [tool] });
            case "tools/call":
                if (!req.params || req.params.name !== tool.name) return error(-32602, `unknown tool ${req.params && req.params.name}`);
                return reply({ content: [{ type: "text", text }], isError: false });
            case "resources/list": return reply({ resources: [] });
            case "prompts/list": return reply({ prompts: [] });
            default: return error(-32601, `method not found: ${req.method}`);
        }
    };
    let rest = "";
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
        rest += chunk;
        let i;
        while ((i = rest.indexOf("\n")) >= 0) {
            const line = rest.slice(0, i).trim();
            rest = rest.slice(i + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch (_) { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); continue; }
            for (const m of Array.isArray(msg) ? msg : [msg]) handle(m);
        }
    });
    input.on("end", () => process.exit(0));
    input.on("close", () => process.exit(0));
}

// ---- main --------------------------------------------------------------------------------------

function parseArgs(argv) {
    const out = { scumble: "", launcher: "", where: false, extra: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--") { out.extra = argv.slice(i + 1); break; }
        if (a === "--scumble") out.scumble = argv[++i] || "";
        else if (a.startsWith("--scumble=")) out.scumble = a.slice(10);
        else if (a === "--launcher") out.launcher = argv[++i] || "";
        else if (a.startsWith("--launcher=")) out.launcher = a.slice(11);
        else if (a === "--where") out.where = true;
        else process.stderr.write(`scumble-mcpb: ignoring argument ${a}\n`);
    }
    return out;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const launcher = args.launcher || (isSet(process.env.SCUMBLE_LAUNCHER) ? process.env.SCUMBLE_LAUNCHER : "");
    const found = find(args.scumble);
    const ok = found && !found.missing;
    const p = ok ? plan(found, args.extra, launcher) : null;
    if (args.where) {
        process.stdout.write(JSON.stringify({ version: VERSION, found, plan: p, note: ok ? null : missingText(found) }, null, 2) + "\n");
        return;
    }
    if (!ok) { fallbackServer(found); return; }
    relay(p);
}

/**
 * Starts the launcher and relays the streams by hand: Claude Desktop runs this starter in an Electron UtilityProcess
 * with its built-in Node, where stdin and stdout are the host's own streams and no Windows handles a grandchild could
 * inherit (measured 2026-10-09: with stdio "inherit" the launcher's answers reached nobody and initialize timed out
 * after 120 s). Through process.stdin / process.stdout the bytes go wherever the host reads them.
 */
function relay(p) {
    let child;
    try {
        child = spawn(p.command, p.args, { env: { ...process.env, ...p.env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
        process.stderr.write(`scumble-mcpb: cannot start ${p.command}: ${e.message}\n`);
        process.exit(1);
    }
    child.on("error", (e) => { process.stderr.write(`scumble-mcpb: cannot start ${p.command}: ${e.message}\n`); process.exit(1); });
    child.stdout.on("data", (c) => { try { process.stdout.write(c); } catch (_) { /* the host went */ } });
    child.stderr.on("data", (c) => { try { process.stderr.write(c); } catch (_) { /* the host went */ } });
    child.stdin.on("error", () => { /* the child went first */ });
    let ending = false;
    const clientGone = () => {
        if (ending) return;
        ending = true;
        try { child.stdin.end(); } catch (_) { /* gone */ }
        setTimeout(() => { try { child.kill(); } catch (_) { /* gone */ } }, 5000).unref();
    };
    process.stdin.on("data", (c) => { try { child.stdin.write(c); } catch (_) { /* gone */ } });
    process.stdin.on("end", clientGone);
    process.stdin.on("close", clientGone);
    process.stdin.on("error", clientGone);
    process.stdin.resume();
    child.on("exit", (code, signal) => process.exit(code === null || code === undefined ? (signal ? 1 : 0) : code));
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { try { child.kill(); } catch (_) { /* gone */ } });
    process.on("exit", () => { try { child.kill(); } catch (_) { /* gone */ } });
}

module.exports = { find, plan, isSet, isStorePath, folderOfUninstall, missingText, fallbackServer, parseArgs, defaultDeps, relay, STORE_LAUNCH, UNINSTALL_GUID, UNINSTALL_KEY, LAUNCHER };

// Started as the entry point: by node, or by Claude Desktop's host, which loads the entry with import() (no
// require.main then) and puts its path into process.argv[1]. Required by a test, neither holds.
function isEntry() {
    if (require.main === module) return true;
    try { return !!process.argv[1] && path.resolve(process.argv[1]) === __filename; } catch (_) { return false; }
}

if (isEntry()) main();
