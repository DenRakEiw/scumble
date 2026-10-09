// The host script tools/mcpb_utility.js forks into an Electron UtilityProcess: the shape of Claude Desktop's own
// nodeHost.js (read from its app.asar on 2026-10-09, Claude 2.31226), reduced to what the .mcpb starter sees. There
// stdin and stdout are not the process's handles: `process.stdout.write` is replaced by a function that posts
// { type: "stdout", content } to the parent over a MessagePort, `process.stdin`'s methods by those of a Readable the
// parent feeds with { type: "stdin", data } messages (one line each), and the entry point is loaded with import().
// A grandchild given stdio "inherit" therefore writes to nobody, which is what broke the first bundle.
//
//   argv: <entry point> [args for the entry point...]
"use strict";

const path = require("node:path");
const { Readable } = require("node:stream");
const { pathToFileURL } = require("node:url");
const { StringDecoder } = require("node:string_decoder");

const [entry, ...rest] = process.argv.slice(2);
let port = null;
const out = new StringDecoder("utf8"), err = new StringDecoder("utf8");
const post = (msg) => { try { port && port.postMessage(msg); } catch (_) { /* parent gone */ } };
const text = (dec, chunk) => (typeof chunk === "string" ? chunk : dec.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));

process.parentPort.once("message", (e) => {
    if (!e.data || e.data.type !== "init" || !e.ports || !e.ports[0]) { console.error("expected init with a port"); process.exit(1); }
    port = e.ports[0];
    process.stdout.write = function (chunk, enc, cb) {
        const s = text(out, chunk);
        if (s.length) post({ type: "stdout", content: s });
        const done = typeof enc === "function" ? enc : cb;
        if (done) process.nextTick(done);
        return true;
    };
    const realErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = function (chunk, enc, cb) {
        const s = text(err, chunk);
        if (s.length) post({ type: "stderr", content: s });
        return typeof enc === "function" ? realErr(chunk, enc) : realErr(chunk, enc, cb);
    };
    const fake = new Readable({ read() {} });
    for (const m of ["read", "push", "unshift", "pause", "resume", "pipe", "unpipe", "on", "once", "removeListener", "removeAllListeners", "setEncoding", "destroy", "isPaused"]) {
        if (typeof fake[m] === "function") process.stdin[m] = fake[m].bind(fake);
    }
    port.on("message", (m) => { if (m.data && m.data.type === "stdin") fake.push(m.data.data + "\n"); });
    port.start();
    process.argv = ["node.exe", entry, ...rest];
    import(pathToFileURL(path.resolve(entry)).toString()).catch((x) => { console.error("import failed: " + (x && x.stack || x)); process.exit(1); });
});
