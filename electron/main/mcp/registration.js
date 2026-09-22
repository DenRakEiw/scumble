// The registration an MCP client needs to start this installation's server (Help > Copy MCP
// registration). Plain Node, no Electron: main.js passes in the paths it knows, and
// tools/platform_test.js checks every platform's answer without an app.
//
// Clients get the Node-mode launcher (electron/main/mcp/launch.js), not the exe with `--mcp`:
// Electron's Windows entry point writes a CR LF to stdout before any code of ours runs and
// strict clients reject it. The exception is an AppImage: it runs from a mount point that
// changes with every start (/tmp/.mount_XXXX), so no path inside it - the launcher's included -
// survives until the client uses it. Only the AppImage file itself ($APPIMAGE) stays put, and
// Linux has no Windows console code to write the stray line, so it is registered with `--mcp`.
"use strict";

/**
 * { command, args, env } for this installation.
 * @param {{ platform: string, exe: string, launcher: string, appImage?: string }} where
 */
function server(where) {
    const appImage = where.platform === "linux" && where.appImage ? String(where.appImage) : "";
    if (appImage) return { command: appImage, args: ["--mcp"], env: {} };
    return { command: where.exe, args: [where.launcher, "--mcp"], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** The text for the clipboard: "desktop" is Claude Desktop's JSON, anything else a `claude mcp add` line. */
function registration(kind, where) {
    const s = server(where);
    if (kind === "desktop") {
        const entry = { command: s.command, args: s.args };
        if (Object.keys(s.env).length) entry.env = s.env;
        return JSON.stringify({ mcpServers: { scumble: entry } }, null, 2);
    }
    const env = Object.entries(s.env).map(([k, v]) => `-e ${k}=${v} `).join("");
    return `claude mcp add scumble ${env}-- ${[s.command, ...s.args.slice(0, -1)].map((a) => `"${a}"`).join(" ")} ${s.args[s.args.length - 1]}`;
}

module.exports = { server, registration };
