// LaMa's own process (lama.js): an Electron utility process in the app (`process.parentPort`),
// a forked Node process under plain Node (`process.send`, the tests). It owns the ONNX
// session, so its load and its runs never hold the main process, and killing it never takes
// the main process along. Messages { id, type: "warm" | "run", file, image?, mask? } ->
// { id, result } or { id, error }.
"use strict";

const { engine } = require("./lama");

const eng = engine(require("onnxruntime-node"));
const port = process.parentPort || null;
const send = (m) => (port ? port.postMessage(m) : process.send(m));

async function handle(msg) {
    try {
        let result;
        if (msg.type === "warm") result = await eng.load(msg.file);
        else if (msg.type === "run") result = await eng.run(msg.file, msg.image, msg.mask);
        else throw new Error("unknown request " + msg.type);
        send({ id: msg.id, result });
    } catch (err) {
        send({ id: msg.id, error: String(err && err.message || err) });
    }
}

if (port) port.on("message", (e) => handle(e.data));
else {
    process.on("message", handle);
    process.on("disconnect", () => process.exit(0));   // the parent is gone
}
