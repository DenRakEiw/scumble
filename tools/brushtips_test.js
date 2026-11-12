// The stored brush tips (electron/main/brushes.js) and the window's saves of them (renderer/editor/host_generate.js
// saveBrushTips), in plain Node against a temp folder: node tools/brushtips_test.js
// Review findings main-docs/brush-index-read-failure-deletes-tips and host-gen/brush-tip-saves-race (data loss):
//   1. a damaged brushes.json gives the folder's tips (not an empty list a save would then delete), moved aside;
//   2. an index another program holds makes list() reject (the window then saves nothing this session);
//   3. the index is written through a temp file (none left behind);
//   4. two saves in a row from the window (a save asked while one runs) lose no tip: the window's host part runs on
//      the real main module, its canvases' PNGs made with a delay.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const short = (x) => JSON.stringify(x).slice(0, 400);

let USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-brushtips-"));
const orig = Module._load;
Module._load = function (request, ...rest) {
    if (request === "electron") return { app: { getPath: () => USERDATA }, shell: { openPath: async () => "" } };
    return orig.call(this, request, ...rest);
};
const brushes = require(path.join(ROOT, "electron", "main", "brushes.js"));
Module._load = orig;

const tip = (id, tag) => ({ id, name: "tip " + id, spacing: 25, source: "test.abr", png: new Uint8Array(Buffer.from("PNG " + tag)) });
const fresh = () => { USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-brushtips-")); return path.join(USERDATA, "brushes"); };

async function main() {
    // 1. a damaged index: the folder's tips come back by their files, the index moved aside, and a save of them keeps all
    {
        const d = fresh();
        await brushes.save([tip("a1", "A1"), tip("b2", "B2"), tip("c3", "C3")]);
        fs.writeFileSync(path.join(d, "brushes.json"), '[{"id":"a1","na');   // a write cut short
        const warn = console.warn; console.warn = () => {};
        let got;
        try { got = await brushes.list(); } finally { console.warn = warn; }
        const aside = fs.readdirSync(d).filter((n) => n.startsWith("brushes.json.damaged-"));
        check("a damaged brushes.json: list gives the three tips of the folder (by their file names) and moves the index aside",
            got.map((t) => t.id).sort().join(",") === "a1,b2,c3" && Buffer.from(got.find((t) => t.id === "b2").png).toString() === "PNG B2" && aside.length === 1,
            short({ ids: got.map((t) => t.id), aside }));
        // what the window then does: its library is what list gave, one tip is imported, the library saved
        await brushes.save([...got.map((t) => ({ ...t, png: null })), tip("d4", "D4")]);
        const after = await brushes.list();
        check("... and a save of that library plus one new tip keeps all four files",
            after.map((t) => t.id).sort().join(",") === "a1,b2,c3,d4" && ["a1", "b2", "c3", "d4"].every((id) => fs.existsSync(path.join(d, id + ".png"))), short(after.map((t) => t.id)));
        check("the index is written through a temp file: none is left, and it parses", !fs.existsSync(path.join(d, "brushes.json.tmp")) && Array.isArray(JSON.parse(fs.readFileSync(path.join(d, "brushes.json"), "utf8"))));
    }
    // 2. an index that cannot be read (here a folder in its place; on Windows also a file another program holds): list
    // rejects, so the window's guard (brushTipsUnread) keeps it from saving a library that would delete every tip
    {
        const d = fresh();
        await brushes.save([tip("a1", "A1")]);
        fs.unlinkSync(path.join(d, "brushes.json"));
        fs.mkdirSync(path.join(d, "brushes.json"));
        let err = null;
        try { await brushes.list(); } catch (e) { err = e; }
        check("an index that cannot be read (not missing, not damaged) makes list reject", !!err && fs.existsSync(path.join(d, "a1.png")), String(err && err.code));
    }
    // 3. no index at all but tips in the folder (a crash between a PNG and the index): they are listed, not dropped
    {
        const d = fresh();
        await brushes.save([tip("a1", "A1"), tip("b2", "B2")]);
        fs.unlinkSync(path.join(d, "brushes.json"));
        const got = await brushes.list();
        check("no index but PNGs in the folder: they are listed", got.map((t) => t.id).sort().join(",") === "a1,b2", short(got.map((t) => t.id)));
        fresh();
        check("no folder at all: an empty list", (await brushes.list()).length === 0);
    }

    // 4. the window's saves on the real main module: a tip imported while a save waits for main is not lost
    {
        const d = fresh();
        const deep = () => new Proxy(function () {}, { get: (t, k) => (k === "then" ? undefined : deep()), apply: () => deep() });
        globalThis.window = globalThis;
        globalThis.document = { createElement: () => ({ getContext: () => null }), addEventListener() {} };
        globalThis.localStorage = { getItem: () => null, setItem() {} };
        globalThis.addEventListener = () => {};
        let saves = 0;
        globalThis.scumble = new Proxy({
            brushes: {
                list: () => brushes.list(),
                // main's save after an IPC hop that takes a while
                save: async (tips) => { saves++; await new Promise((r) => setTimeout(r, 60)); return brushes.save(tips); },
            },
        }, { get: (t, k) => (k in t ? t[k] : deep()) });
        const warn = console.warn, log = console.log;
        console.warn = () => {};
        const { host } = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "host.js")).href);
        console.warn = warn;
        // a canvas whose PNG takes 15 ms to make
        const canvas = (tag) => ({ toBlob: (cb) => setTimeout(() => cb(new Blob([Buffer.from("PNG " + tag)])), 15) });
        const lib = host.brushLibrary;
        lib.length = 0;
        for (let i = 0; i < 8; i++) lib.push({ id: "t" + i, name: "t" + i, canvas: canvas("T" + i), spacing: 25, source: "big.abr", saved: false });
        host._editors = host._editors || [];
        const first = host.saveBrushTips(null);
        // the first save's PNGs are made (8 x 15 ms) and it waits for main: a brush image is imported now
        await new Promise((r) => setTimeout(r, 8 * 15 + 30));
        lib.push({ id: "b9", name: "imported", canvas: canvas("B9"), spacing: 10, source: "", saved: false });
        const second = host.saveBrushTips(null);
        await Promise.all([first, second]);
        console.log = log;
        const stored = await brushes.list();
        const ids = stored.map((t) => t.id).sort().join(",");
        check("a tip imported while a save waits for main is on disk after both saves (its PNG and its index entry)",
            ids === "b9,t0,t1,t2,t3,t4,t5,t6,t7" && Buffer.from(stored.find((t) => t.id === "b9").png).toString() === "PNG B9" && fs.existsSync(path.join(d, "b9.png")),
            short({ ids, saves, flags: lib.map((t) => t.id + ":" + t.saved) }));
        check("... and every tip of the library is marked saved after them", lib.every((t) => t.saved), short(lib.map((t) => t.id + ":" + t.saved)));
    }

    fs.rmSync(USERDATA, { recursive: true, force: true });
    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + ((err && err.stack) || err)); console.log("FAIL"); process.exit(1); });
