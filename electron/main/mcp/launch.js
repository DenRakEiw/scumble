// Why this file exists: Electron's Windows entry point writes a CR LF to stdout before any
// JavaScript of ours runs, and the MCP stdio transport forbids anything on stdout that is not
// a protocol message. Measured on 2026-09-10: the bytes appear whatever stdout is (pipe or
// file) and whatever ELECTRON_NO_ATTACH_CONSOLE says, so they cannot be suppressed from
// inside the app; but the same executable in Node mode (ELECTRON_RUN_AS_NODE=1) prints
// nothing at all and can read the packaged asar. So this launcher runs in Node mode, spawns
// the real Electron process as a child, and hands the client a stdout that starts with `{`.
//
//   ELECTRON_RUN_AS_NODE=1 Scumble.exe resources\app.asar\electron\main\mcp\launch.js --mcp
//   ELECTRON_RUN_AS_NODE=1 electron.exe F:\canvas\electron\main\mcp\launch.js --mcp   (dev)
//   node electron\main\mcp\launch.js --mcp                                (dev, plain node)
//
// It must stay a plain Node script: no Electron API, no require of anything else in the app.
// `Scumble --mcp` keeps working directly for clients that tolerate the stray line.
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const FORWARD = process.argv.slice(2);
const CHILD_ARGS = FORWARD.length ? FORWARD : ["--mcp"];

function fail(message) {
    process.stderr.write("scumble-mcp: " + message + "\n");
    process.exit(1);
}

/** [executable, args]: the packaged exe takes the args as they are, a dev run needs the app root. */
function resolveChild() {
    const packaged = __dirname.includes("app.asar");
    if (packaged) return [process.execPath, CHILD_ARGS];
    const root = path.resolve(__dirname, "..", "..", "..");
    const base = path.basename(process.execPath).toLowerCase();
    if (base.startsWith("electron")) return [process.execPath, [root, ...CHILD_ARGS]];
    let exe;                                          // plain node: the electron package exports the binary's path
    try {
        exe = require("electron");
    } catch {
        fail("run me with electron.exe (ELECTRON_RUN_AS_NODE=1) or install the electron package");
    }
    if (typeof exe !== "string") fail("the electron package did not yield a path (are we inside Electron?)");
    return [exe, [root, ...CHILD_ARGS]];
}

const [exe, args] = resolveChild();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;                      // without this the child is a Node process too and the app never starts

let child;
try {
    child = spawn(exe, args, { env, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
} catch (e) {
    fail(`cannot start ${exe}: ${e.message}`);
}
child.on("error", (e) => fail(`cannot start ${exe}: ${e.message}`));

// The whole point: swallow the leading run of CR, LF and space, pass every later byte
// through untouched (messages after the first carry base64 image content).
let clean = false;
child.stdout.on("data", (chunk) => {
    let buf = chunk;
    if (!clean) {
        let i = 0;
        while (i < buf.length && (buf[i] === 13 || buf[i] === 10 || buf[i] === 32)) i++;
        if (i >= buf.length) return;
        clean = true;
        buf = buf.subarray(i);
    }
    process.stdout.write(buf);
});

const stdin = fs.createReadStream(null, { fd: 0 });   // the main process never sees `data` on process.stdin from a pipe on Windows
child.stdin.on("error", () => { /* the child went first; EPIPE is not news */ });
stdin.on("data", (c) => { try { child.stdin.write(c); } catch { /* gone */ } });
let ending = false;
function clientGone() {
    if (ending) return;
    ending = true;
    try { child.stdin.end(); } catch { /* gone */ }
    setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 5000).unref();
}
stdin.on("end", clientGone);
stdin.on("close", clientGone);
stdin.on("error", clientGone);

child.on("exit", (code, signal) => process.exit(code === null || code === undefined ? (signal ? 1 : 0) : code));
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { try { child.kill(); } catch { /* gone */ } });
process.on("exit", () => { try { child.kill(); } catch { /* gone */ } });
