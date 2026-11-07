// The local command socket (electron/main/local.js), in plain Node: the line splitter and a real server and client on
// a pipe of their own (a temporary user data folder, so never a running Scumble's):
//   node tools/local_test.js
// H1 S6 (docs/research/review_external_2026-11-07/verified.json): the part of a line not ended yet is kept as chunks
// and only each new chunk is searched, so a 64 MB line in 64 KB chunks takes well under a second (the old splitter
// copied and searched the whole buffer again per chunk); a line longer than the cap ends the reading once: the server
// answers why and closes that connection (and keeps serving others), the client rejects what it waits for. The gate
// mcp runs it first.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { LocalServer, LocalClient, MAX_LINE, _lines: lines } = require("../electron/main/local.js");

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}

/** A socket stand-in: `feed(chunk)` emits it as data, unless destroyed. */
function fakeSocket() {
    const s = new EventEmitter();
    s.destroyed = false;
    s.setEncoding = () => {};
    s.destroy = () => { s.destroyed = true; };
    s.feed = (c) => { if (!s.destroyed) s.emit("data", c); };
    return s;
}

async function main() {
    // ---- 1. the splitter ----------------------------------------------------------------------------------------
    {
        const s = fakeSocket(), got = [];
        lines(s, (m) => got.push(m));
        s.feed('{"a":1}\n{"b":'); s.feed("2"); s.feed('}\r\n\n  \n{"c":3}'); s.feed("\n"); s.feed("not json\n"); s.feed('{"d":4}\n{"e"'); s.feed(":5}\n");
        check("lines across chunks, several in one chunk, CR LF, blank lines and a line that is no JSON (skipped)",
            JSON.stringify(got) === JSON.stringify([{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }, { e: 5 }]), JSON.stringify(got));
    }
    {
        const s = fakeSocket(), got = [];
        let too = 0;
        const max = 16;
        lines(s, (m) => got.push(m), { max, onTooLong: () => too++ });
        const exact = '{"x":"' + "y".repeat(max - 8) + '"}';   // max characters before its newline
        s.feed(exact.slice(0, 5)); s.feed(exact.slice(5) + "\n");
        s.feed('{"z":"' + "w".repeat(max) + '"}\n{"after":1}\n');
        s.feed('{"later":1}\n');
        check("a line of the cap's length is read; one longer ends the reading once, nothing after it is read",
            exact.length === max && got.length === 1 && got[0].x.length === max - 8 && too === 1, JSON.stringify({ got: got.length, too }));
        const s2 = fakeSocket();
        lines(s2, () => {}, { max });
        s2.feed("a".repeat(10)); s2.feed("b".repeat(10));
        check("a line that never ends is cut at the cap (no newline needed); without onTooLong the socket is destroyed", s2.destroyed);
    }
    {
        const s = fakeSocket();
        let got = null;
        lines(s, (m) => { got = m; });
        const piece = "x".repeat(64 * 1024);
        const n = 1024;   // 64 MB
        const t0 = Date.now();
        s.feed('{"big":"');
        for (let i = 0; i < n; i++) s.feed(piece);
        s.feed('"}\n');
        const ms = Date.now() - t0;
        check("a 64 MB line in 64 KB chunks: linear, well under a second's worth of copying", got && got.big.length === piece.length * n && ms < 3000, `${ms} ms`);
        check("the cap is just under V8's longest string", MAX_LINE === 500 * 1024 * 1024 && MAX_LINE < 2 ** 29 - 24);
    }

    // ---- 2. a real server and client --------------------------------------------------------------------------
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-local-test-"));
    const bridge = new EventEmitter();
    bridge.ready = true;
    bridge.run = async (name, args) => (name === "echo" ? args : name === "big" ? { s: "q".repeat(args.n) } : { name });
    bridge.describe = async () => ({ commands: [] });
    const umask0 = process.umask();
    const server = new LocalServer(bridge, { maxLine: 1024 * 1024 });
    server.listen(userData);
    check("listen leaves the process's umask as it was", process.umask() === umask0, `${umask0.toString(8)} -> ${process.umask().toString(8)}`);
    await new Promise((r) => (server.server.listening ? r() : server.server.once("listening", r)));
    try {
        const c = await LocalClient.connect(userData);
        const pong = await c.ping();
        const half = "m".repeat(512 * 1024);
        const echo = await c.run("echo", { half });
        check("a request and its answer (half a MB of argument) go through", pong && pong.pid === process.pid && echo.half === half);

        // a request line over the server's cap: the reason as an answer without an id, the connection closed
        const net = require("node:net");
        const raw = net.createConnection(server.path);
        await new Promise((r) => raw.once("connect", r));
        let heard = "";
        raw.setEncoding("utf8");
        raw.on("data", (d) => { heard += d; });
        const closed = new Promise((r) => raw.once("close", r));
        raw.write('{"id":7,"cmd":"run","name":"echo","args":{"s":"');
        for (let i = 0; i < 20; i++) raw.write("z".repeat(64 * 1024));   // 1.25 MB, past the 1 MB cap
        raw.on("error", () => {});
        await Promise.race([closed, new Promise((r) => setTimeout(r, 5000))]);
        let said = null;
        try { said = JSON.parse(heard.trim().split("\n")[0]); } catch (_) { said = heard.slice(0, 200); }
        check("a request line past the cap: the server says why (id null) and closes that connection", raw.destroyed && said && said.id === null && said.ok === false && /longer than 1 MB/.test(said.error), JSON.stringify(said));
        const still = await c.run("echo", { k: 1 });
        const c2 = await LocalClient.connect(userData);
        const fresh = await c2.ping();
        check("the other connections and new ones are served on", still.k === 1 && fresh.ready === true);

        // an answer over the client's cap: what it waits for is rejected with why, the client is closed
        const small = await LocalClient.connect(userData, 2000, { maxLine: 4096 });
        let why = "";
        try { await small.run("big", { n: 10000 }); } catch (err) { why = err.message; }
        check("an answer past the client's cap rejects its call and closes the client", /answer was longer than/.test(why) && small.closed, why);
        c.close(); c2.close();
    } finally {
        server.close();
        fs.rmSync(userData, { recursive: true, force: true });
    }

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + ((err && err.stack) || err)); console.log("FAIL"); process.exit(1); });
