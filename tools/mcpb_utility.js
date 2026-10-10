// The .mcpb starter inside an Electron UtilityProcess, the way Claude Desktop runs an extension with its built-in
// Node (docs/PLAN_MCPB.md; found 2026-10-09: Claude Desktop's nodeHost.js replaces process.stdout.write and
// process.stdin by messages over a MessagePort, so a starter that hands its child stdio "inherit" answers nothing and
// initialize times out after 120 s). An Electron main script: forks tools/mcpb_utility_host.js (nodeHost's shape)
// with the starter as its entry, sends initialize and a ping as stdin frames, prints the answers as JSON lines on its
// own stdout, and exits 0 when both came, 1 otherwise.
//
//   node_modules\.bin\electron tools/mcpb_utility.js --scumble <Scumble.exe> [--profile <dir>] [--starter <index.js>] [--timeout <ms>]
//
// tools/mcpb_test.js --exe runs it. The starter gets SCUMBLE_EXE and, with --profile, "-- --user-data-dir=<dir> --no-comfy".
"use strict";

const path = require("node:path");
const { app, utilityProcess, MessageChannelMain } = require("electron");

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ""; };
const SCUMBLE = arg("--scumble");
const PROFILE = arg("--profile");
const STARTER = arg("--starter") || path.join(__dirname, "..", "mcpb", "server", "index.js");   // --starter: another copy, e.g. the installed extension
const TIMEOUT = Number(arg("--timeout") || 120000);
const HOST = path.join(__dirname, "mcpb_utility_host.js");

function out(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

app.whenReady().then(() => {
    const env = { ...process.env, SCUMBLE_EXE: SCUMBLE };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = PROFILE ? ["--", `--user-data-dir=${PROFILE}`, "--no-comfy"] : [];
    const child = utilityProcess.fork(HOST, [STARTER, ...args], { stdio: "pipe", env, serviceName: "mcpb-starter" });
    const { port1, port2 } = new MessageChannelMain();
    const t0 = Date.now();
    let buf = "", stderr = "", got = 0, done = false;
    const send = (msg) => port1.postMessage({ type: "stdin", data: JSON.stringify(msg) });
    const finish = (code) => { if (done) return; done = true; out({ exit: code, got, ms: Date.now() - t0, stderr: stderr.slice(0, 2000) }); setTimeout(() => app.exit(code), 100); };
    const timer = setTimeout(() => { out({ error: "timeout", buf: buf.slice(0, 300) }); try { child.kill(); } catch (_) { /* gone */ } finish(1); }, TIMEOUT);
    child.stdout.on("data", (c) => { stderr += "[utility stdout] " + c; });
    child.stderr.on("data", (c) => { stderr += "[utility stderr] " + c; });
    port1.on("message", (e) => {
        const m = e.data || {};
        if (m.type === "stderr") { stderr += m.content; return; }
        if (m.type !== "stdout") return;
        buf += m.content;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch (_) { out({ error: "not json", line: line.slice(0, 200) }); clearTimeout(timer); child.kill(); return finish(1); }
            if (msg.id === 1) {
                got++;
                out({ initialize: msg.result && msg.result.serverInfo, ms: Date.now() - t0 });
                send({ jsonrpc: "2.0", method: "notifications/initialized" });
                send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ping", arguments: {} } });
            } else if (msg.id === 2) {
                got++;
                let ping = null;
                try { ping = JSON.parse(msg.result.content.map((c) => c.text || "").join("")); } catch (_) { /* keep null */ }
                out({ ping: ping && { app: ping.app, mode: ping.mcp && ping.mcp.mode, documents: (ping.documents || []).length }, ms: Date.now() - t0 });
                // Claude Desktop ends a server by killing the utility process; the starter's child must go with it
                clearTimeout(timer);
                child.kill();
            }
        }
    });
    port1.start();
    child.on("exit", (code) => { clearTimeout(timer); out({ utilityExit: code }); finish(got === 2 ? 0 : 1); });
    child.postMessage({ type: "init" }, [port2]);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcpb_utility", version: "0" } } });
});
