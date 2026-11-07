// A released Rust instance is let go (K26's review of docs/PLAN_WASM_BUILD.md, the instance lifecycle of §3.2):
// px/kernels.js replaces this thread's instance after a call that grew it past `releaseMB` (and on the idle trim), and
// nothing may keep the old one, with all its memory, alive. Until K26 the first load's promise (`LOADING`) resolved to
// the first instance and was kept for good, so the first instance of every thread (the window's, each worker's)
// stayed reachable however large it had grown.
//
//     node --expose-gc tools/kernels_release_test.js
//
// It loads kernels.js as a worker does (px.wasm fetched by URL: a file URL is answered from disk here), holds the first
// instance only through a WeakRef, makes a call release it (releaseMB 0), and then asks the garbage collector until the
// WeakRef is empty. It prints PASS / FAIL and exits 1 on a failure.
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");

const ROOT = path.dirname(__dirname);
const PX_DIR = path.join(ROOT, "renderer", "editor", "px");
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`); if (!ok) failures++; };

if (typeof globalThis.gc !== "function") {
    console.log("FAIL run with node --expose-gc");
    process.exit(1);
}
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, ...rest) => {
    const s = String(u);
    return s.startsWith("file:") ? new Response(fs.readFileSync(fileURLToPath(s))) : realFetch(u, ...rest);
};
// in Node kernels.js does not load by itself (no window, no worker scope): kernelsReady() starts the load
let K = null;

// Each step in a function of its own, so no local of this file's frames keeps an instance (an async function's block
// variable stays in its context: holding the first instance there would be the test's own leak).
async function firstRef() {
    const first = await K.kernelsReady();
    if (!first) return null;
    // grow it a little, so a leak would hold real memory
    K.boxBlurs(new Float32Array(1024 * 1024), 1024, 1024, [3, 3, 4]);
    return new WeakRef(first);
}

async function another(weak) {
    const now = await K.kernelsReady();
    return !!now && now !== weak.deref();
}

async function main() {
    const weak = await firstRef();
    check("kernels.js loads px.wasm", !!weak && K.kernelsInUse() === "rust");
    if (!weak) return;
    const before = K.pxInstances();
    K.setRoute("releaseMB", 0);
    try { K.boxBlurs(new Float32Array(64), 8, 8, [1]); } finally { K.setRoute("releaseMB", null); }
    const after = K.pxInstances();
    check("the call released the instance (releaseMB 0)", after.release === before.release + 1, JSON.stringify(after));
    check("kernelsReady answers the instance in use, not the first one", await another(weak));
    // the garbage collector may need a few turns (the instance's memory is freed with it). A deref keeps its target
    // alive to the end of the job it runs in, so the collection runs in a job of its own between two derefs
    const tick = () => new Promise((r) => setTimeout(r, 25));
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
        await tick();
        globalThis.gc();
        await tick();
        gone = weak.deref() === undefined;
    }
    check("the released first instance is collected (nothing in kernels.js keeps it)", gone);
}

(async () => {
    K = await import(pathToFileURL(path.join(PX_DIR, "kernels.js")).href);
    await main();
    globalThis.fetch = realFetch;
    console.log(failures ? `FAIL (${failures})` : "PASS");
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
