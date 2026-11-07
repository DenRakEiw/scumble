// `Scumble --run` (electron/main/cli_run.js) in plain Node against a fake backend, no Electron:
//   node tools/cli_run_test.js
// The parser (an array, JSON lines, the object form, the refusals), the globs, the placeholders, the doc pinning, the
// stop / keep-going rules and the clean-up close, the output lines and the exit codes. The real run on the dev app is
// tools/cli_run_live.py (the gate `cli`), which runs this first.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cli = require(path.join(__dirname, "..", "electron", "main", "cli_run.js"));

let failed = 0, passed = 0;
function check(what, ok, detail) {
    if (ok) passed++; else failed++;
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${ok || detail === undefined ? "" : ": " + (typeof detail === "string" ? detail : JSON.stringify(detail))}`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function throws(fn, re) {
    try { fn(); return null; } catch (err) { return re.test(err.message) && err instanceof cli.PlanError ? err.message : "wrong error: " + err.message; }
}

// ---- the parser ----------------------------------------------------------------------------------------------------

{
    const p = cli.parseSteps('[{"cmd": "ping"}, {"cmd": "select_rect", "args": {"x": 1, "y": 2, "w": 3, "h": 4}}]');
    check("an array of steps", same(p, { steps: [{ cmd: "ping", args: {} }, { cmd: "select_rect", args: { x: 1, y: 2, w: 3, h: 4 } }], files: null, keepGoing: false }), p);
    const l = cli.parseSteps('{"cmd": "new_document"}\r\n\r\n  {"cmd": "load_image", "args": {"path": "a.png"}}\n{"cmd":"close_document"}\n');
    check("JSON lines, blank lines and CR LF skipped", same(l.steps.map((s) => s.cmd), ["new_document", "load_image", "close_document"]) && l.steps[1].args.path === "a.png", l);
    const one = cli.parseSteps('{"cmd": "ping"}');
    check("one step alone", same(one.steps, [{ cmd: "ping", args: {} }]), one);
    const bom = cli.parseSteps(String.fromCharCode(0xFEFF) + '[{"cmd": "ping"}]');
    check("a byte order mark is skipped", bom.steps.length === 1, bom);
    const o = cli.parseSteps(JSON.stringify({ comment: "x", files: "in/*.png", keep_going: true, steps: [{ cmd: "flip_layer", args: { axis: "x" }, comment: "mirror" }] }));
    check("the object form (files as one string, keep_going, comments)", same(o, { steps: [{ cmd: "flip_layer", args: { axis: "x" } }], files: ["in/*.png"], keepGoing: true }), o);
    const refusals = [
        ["empty input", "  \n ", /empty/],
        ["an empty array", "[]", /empty/],
        ["a step without cmd", '[{"args": {}}]', /step 1: "cmd" must name/],
        ["args as an array", '[{"cmd": "ping", "args": [1]}]', /step 1: "args" must be an object/],
        ["a parameter beside cmd", '[{"cmd": "ping"}, {"cmd": "export", "path": "x.png"}]', /step 2: unknown key "path".*args/],
        ["a bad JSON line names its line", '{"cmd": "ping"}\n\n{"cmd": oops}', /line 3 is not JSON/],
        ["a JSON line that is no object", '{"cmd": "ping"}\n[1]', /line 2: JSON lines hold one step object/],
        ["a step in JSON lines names its line", '{"cmd": "ping"}\n{"cmd": ""}', /line 2: "cmd" must name/],
        ["an unknown key of the object", '{"steps": [{"cmd": "ping"}], "file": ["a"]}', /unknown key "file"/],
        ["files not strings", '{"steps": [{"cmd": "ping"}], "files": [1]}', /"files" must be/],
        ["files empty", '{"steps": [{"cmd": "ping"}], "files": []}', /"files" must be/],
        ["steps missing", '{"files": ["a.png"]}', /"steps" must be/],
        ["keep_going not a boolean", '{"steps": [{"cmd": "ping"}], "keep_going": "yes"}', /keep_going/],
        ["a number", "42", /must be an array/],
    ];
    for (const [what, text, re] of refusals) {
        const r = throws(() => cli.parseSteps(text), re);
        check("refused: " + what, r && !r.startsWith("wrong error"), r || "not refused");
    }
}

// ---- the globs and the placeholders --------------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli_run_test_"));
const inDir = path.join(tmp, "in");
fs.mkdirSync(path.join(inDir, "sub.png"), { recursive: true });   // a folder whose name matches: never a file
for (const n of ["a10.png", "a2.png", "a1.png", "b.jpg", "A3.PNG", "notes.txt"]) fs.writeFileSync(path.join(inDir, n), "x");
{
    const win = process.platform === "win32";
    const got = cli.expandFiles(["in/*.png"], tmp).map((p) => path.basename(p));
    check("a glob against the current folder, sorted by name with numbers in order", same(got, win ? ["a1.png", "a2.png", "A3.PNG", "a10.png"] : ["a1.png", "a2.png", "a10.png"]), got);
    const q = cli.expandFiles([path.join(inDir, "a?.png")], "/elsewhere").map((p) => path.basename(p));
    check("? matches one character, an absolute pattern ignores cwd", same(q, win ? ["a1.png", "a2.png", "A3.PNG"] : ["a1.png", "a2.png"]), q);
    const mixed = cli.expandFiles(["in/b.jpg", "in/a1.png", "in/*.png"], tmp).map((p) => path.basename(p));
    check("plain paths in their order, duplicates once", mixed[0] === "b.jpg" && mixed[1] === "a1.png" && mixed.filter((x) => x === "a1.png").length === 1, mixed);
    check("every file absolute", cli.expandFiles(["in/*.jpg"], tmp).every((p) => path.isAbsolute(p)));
    const fr = [
        ["a missing plain file", ["in/none.png"], /no file .*none\.png/],
        ["a wildcard in a folder part", ["i*/a1.png"], /file name only/],
        ["a folder that does not exist", ["nowhere/*.png"], /cannot read the folder/],
        ["nothing matches", ["in/*.gif"], /no file matches/],
        ["a folder as a plain path", ["in/sub.png"], /no file/],
    ];
    for (const [what, pats, re] of fr) {
        const r = throws(() => cli.expandFiles(pats, tmp), re);
        check("refused: " + what, r && !r.startsWith("wrong error"), r || "not refused");
    }
    const v = cli.fileVars(path.join(inDir, "my.photo.JPG"), 3);
    check("the placeholders of a file", same(v, { file: path.join(inDir, "my.photo.JPG"), dir: inDir, name: "my.photo.JPG", stem: "my.photo", ext: "JPG", index: "3" }), v);
    const f = cli.fill({ path: "{dir}/{stem}_cut.{ext}", n: 4, list: ["{index}", { deep: "{name}" }], keep: "{unknown} {file", on: true }, v);
    check("filled in every string, deep; numbers, booleans and unknown names untouched",
        same(f, { path: `${inDir}/my.photo_cut.JPG`, n: 4, list: ["3", { deep: "my.photo.JPG" }], keep: "{unknown} {file", on: true }), f);
}

// ---- the run against a fake backend -------------------------------------------------------------------------------

const TABLE = [
    { name: "ping", scope: "app", params: {} },
    { name: "new_document", scope: "app", params: {} },
    { name: "open_document", scope: "app", params: {} },
    { name: "close_document", scope: "doc", params: {} },
    { name: "load_image", scope: "doc", params: { path: {} } },
    { name: "flip_layer", scope: "doc", params: {} },
    { name: "export", scope: "doc", params: { path: {} } },
    { name: "cutout_layer", scope: "doc", params: { timeout: { type: "integer", default: 300 } } },
    { name: "film.apply_look", scope: "doc", params: {} },
];

/** A backend that records every call; `fail(name, args)` true makes that call throw. */
function fakeBackend({ fail = () => false, already = false, table = TABLE } = {}) {
    let next = 7;
    const calls = [];
    return {
        calls,
        async describe() { if (table instanceof Error) throw table; return table; },
        async run(name, args) {
            calls.push({ name, args });
            if (!table.some((c) => c.name === name)) throw new Error(`unknown command "${name}"`);
            if (fail(name, args)) throw new Error(`${name} failed`);
            if (name === "new_document") return { id: next++, name: "Untitled" };
            if (name === "open_document") return { id: 3, already };
            if (name === "close_document") return { closed: args.doc };
            if (name === "ping") return undefined;
            return { ran: name };
        },
    };
}

/** A stdout that keeps the lines. */
function sink() {
    const out = { text: "", write(s, cb) { this.text += s; if (cb) cb(); return true; }, on() {} };
    out.lines = () => out.text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return out;
}
const quiet = { write() { return true; } };
let clock = 1000;
const now = () => (clock += 5);

async function run(text, { keepGoing = false, backend = fakeBackend(), cwd = tmp, readStdin } = {}) {
    const stdout = sink(), err = { text: "", write(s) { this.text += s; return true; } };
    const code = await cli.main({ source: text === null ? null : "-", keepGoing, backend, cwd, stdout, stderr: err, readStdin: readStdin || (async () => text), now });
    return { code, lines: stdout.lines(), stderr: err.text, calls: backend.calls };
}

const STEPS = (extra = []) => [
    { cmd: "new_document" },
    { cmd: "load_image", args: { path: "{file}" } },
    ...extra,
    { cmd: "export", args: { path: "out/{stem}_flipped.png" } },
    { cmd: "close_document" },
];

(async () => {
    {
        const r = await run('[{"cmd": "ping"}, {"cmd": "flip_layer", "args": {"axis": "x"}}]');
        const [a, b, sum] = r.lines;
        check("a plain array: exit 0, a line per step and a summary", r.code === 0 && r.lines.length === 3, r.lines);
        check("a step line's fields", same(Object.keys(a), ["index", "file", "cmd", "ok", "result", "ms"]) && a.index === 1 && a.file === null && a.cmd === "ping" && a.ok === true && a.result === null && typeof a.ms === "number", a);
        check("the second step's result", b.index === 2 && same(b.result, { ran: "flip_layer" }), b);
        check("the summary", same(sum, { done: true, steps: 2, failed: 0, skipped: 0, files: 0, files_failed: 0, stopped: false, ms: sum.ms }) && sum.ms > 0, sum);
        check("without new_document no doc is added", r.calls.every((c) => c.args.doc === undefined), r.calls);
    }
    {
        const plan = { files: ["in/a*.png"], steps: STEPS([{ cmd: "flip_layer", args: { axis: "x", doc: 99 } }, { cmd: "film_apply_look", args: { preset: "x" } }, { cmd: "cutout_layer" }]) };
        const r = await run(JSON.stringify(plan));
        const files = process.platform === "win32" ? 4 : 3;
        check("files x steps: every step of every file", r.code === 0 && r.lines.length === files * 7 + 1, r.lines.length);
        const first = r.calls.slice(0, 7);
        check("the file's later steps go to the document new_document opened", first[1].args.doc === 7 && first[6].name === "close_document" && first[6].args.doc === 7, first);
        check("an app command gets no doc, a step's own doc stays", first[0].args.doc === undefined && first[2].args.doc === 99, first);
        check("the next file gets its own document", r.calls[7].name === "new_document" && r.calls[8].args.doc === 8, r.calls.slice(7, 9));
        check("{file} filled with the absolute path", first[1].args.path === path.join(inDir, "a1.png"), first[1].args.path);
        check("a relative path taken against the current folder", first[5].args.path === path.join(tmp, "out", "a1_flipped.png"), first[5].args.path);
        check("the export's folder was made", fs.existsSync(path.join(tmp, "out")) && fs.statSync(path.join(tmp, "out")).isDirectory());
        check("an MCP tool name for a plugin command (film_apply_look)", first[3].name === "film.apply_look" && r.lines[3].cmd === "film.apply_look", first[3]);
        check("a timeout parameter's default sent along", first[4].name === "cutout_layer" && first[4].args.timeout === 300, first[4]);
        check("the line names its file", r.lines[0].file === path.join(inDir, "a1.png") && r.lines[7].file === path.join(inDir, "a2.png"), r.lines[7]);
        const sum = r.lines[r.lines.length - 1];
        check("the summary counts the files", sum.files === files && sum.steps === files * 7 && sum.failed === 0, sum);
        const own = await run(JSON.stringify({ files: ["in/a1.png"], steps: [{ cmd: "new_document" }, { cmd: "cutout_layer", args: { timeout: 30 } }] }));
        check("a step's own timeout stays", own.calls[1].args.timeout === 30, own.calls[1]);
    }
    {
        // a step of the first file fails: the rest of its steps go but the clean-up close, and the run stops
        const backend = fakeBackend({ fail: (n, a) => n === "flip_layer" && /a1\.png$/.test(r0.file) });
        const r0 = { file: "" };
        const orig = backend.run.bind(backend);
        backend.run = (n, a) => { if (n === "load_image") r0.file = a.path; return orig(n, a); };
        const plan = { files: ["in/a1.png", "in/a2.png"], steps: STEPS([{ cmd: "flip_layer" }, { cmd: "ping" }]) };
        const r = await run(JSON.stringify(plan), { backend });
        const names = r.lines.slice(0, -1).map((l) => `${l.cmd}:${l.ok}`);
        check("stop: exit 1", r.code === 1, r.code);
        check("stop: the failing step, then only the clean-up close", same(names, ["new_document:true", "load_image:true", "flip_layer:false", "close_document:true"]), names);
        check("stop: the failing line carries the error", r.lines[2].error === "flip_layer failed" && r.lines[2].result === undefined, r.lines[2]);
        check("stop: the clean-up close went to the file's document", r.calls[3].name === "close_document" && r.calls[3].args.doc === 7, r.calls[3]);
        check("stop: the second file never started", !r.calls.some((c) => c.args.path === path.join(inDir, "a2.png")), r.calls.length);
        const sum = r.lines[r.lines.length - 1];
        check("stop: the summary", sum.steps === 4 && sum.failed === 1 && sum.skipped === 2 + 6 && sum.files === 2 && sum.files_failed === 1 && sum.stopped === true, sum);
    }
    {
        const failA1 = (n, a) => n === "flip_layer" && a.doc === 7;
        const plan = JSON.stringify({ files: ["in/a1.png", "in/a2.png"], steps: STEPS([{ cmd: "flip_layer" }]) });
        for (const [what, opts, text] of [["--keep-going", { keepGoing: true }, plan], ['"keep_going": true', {}, plan.replace('"steps"', '"keep_going":true,"steps"')]]) {
            const r = await run(text, { ...opts, backend: fakeBackend({ fail: failA1 }) });
            const second = r.lines.filter((l) => l.file === path.join(inDir, "a2.png"));
            check(`${what}: the other file runs whole, exit still 1`, r.code === 1 && second.length === 5 && second.every((l) => l.ok), second.map((l) => l.cmd));
            const sum = r.lines[r.lines.length - 1];
            check(`${what}: the summary`, sum.failed === 1 && sum.files_failed === 1 && sum.stopped === false && sum.skipped === 1, sum);
        }
    }
    {
        // an unknown command fails at its step (the backend says so), not before the run
        const r = await run(JSON.stringify({ files: ["in/a1.png", "in/a2.png"], steps: STEPS([{ cmd: "no_such_command" }]) }), { keepGoing: true });
        const bad = r.lines.filter((l) => l.cmd === "no_such_command");
        check("an unknown command fails at its step, each file", r.code === 1 && bad.length === 2 && bad.every((l) => !l.ok && /unknown command/.test(l.error)), bad);
        check("the steps before it ran", r.lines[0].cmd === "new_document" && r.lines[0].ok && r.lines[1].cmd === "load_image" && r.lines[1].ok);
    }
    {
        // a failing new_document opens nothing: its file's close is skipped too
        const r = await run(JSON.stringify({ files: ["in/a1.png"], steps: STEPS() }), { backend: fakeBackend({ fail: (n) => n === "new_document" }) });
        check("no document opened: no clean-up close", r.code === 1 && r.calls.length === 1 && r.lines.length === 2, r.calls.map((c) => c.name));
        // a document open_document found open already is the user's: a failure does not close it
        const u = await run(JSON.stringify({ files: ["in/a1.png"], steps: [{ cmd: "open_document", args: { path: "x.scumble" } }, { cmd: "flip_layer" }, { cmd: "close_document" }] }), { backend: fakeBackend({ already: true, fail: (n) => n === "flip_layer" }) });
        check("a document that was open already is not closed after a failure", u.calls.length === 2 && u.calls[1].args.doc === 3, u.calls);
        const o = await run(JSON.stringify({ files: ["in/a1.png"], steps: [{ cmd: "open_document", args: { path: "x.scumble" } }, { cmd: "flip_layer" }, { cmd: "close_document" }] }), { backend: fakeBackend({ fail: (n) => n === "flip_layer" }) });
        check("a document open_document opened is closed after a failure", o.calls.length === 3 && o.calls[2].name === "close_document" && o.calls[2].args.doc === 3, o.calls);
        check("open_document's path taken against the current folder", o.calls[0].args.path === path.join(tmp, "x.scumble"), o.calls[0].args.path);
    }
    {
        // the run cannot start
        const nofile = await cli.main({ source: path.join(tmp, "missing.json"), backend: fakeBackend(), stdout: sink(), stderr: quiet });
        check("a missing steps file: exit 2", nofile === 2);
        const s = sink();
        const bad = await cli.main({ source: "-", backend: fakeBackend(), stdout: s, stderr: quiet, readStdin: async () => "[{oops" });
        check("bad JSON: exit 2, one line done false", bad === 2 && s.lines().length === 1 && s.lines()[0].done === false && /not JSON/.test(s.lines()[0].error), s.lines());
        const none = await run(JSON.stringify({ files: ["in/*.gif"], steps: [{ cmd: "ping" }] }));
        check("no file matches: exit 2, nothing ran", none.code === 2 && none.calls.length === 0 && /no file matches/.test(none.stderr), none);
        const empty = await cli.main({ source: "", backend: fakeBackend(), stdout: sink(), stderr: quiet });
        check("--run without a file: exit 2", empty === 2);
        const down = await run('[{"cmd": "ping"}]', { backend: fakeBackend({ table: new Error("Scumble is not running") }) });
        check("Scumble not reachable: exit 1, one line done false", down.code === 1 && down.lines.length === 1 && down.lines[0].done === false && /not running/.test(down.lines[0].error), down.lines);
        const file = path.join(tmp, "steps.json");
        fs.writeFileSync(file, '[{"cmd": "ping"}]');
        const s2 = sink();
        const fromFile = await cli.main({ source: "steps.json", backend: fakeBackend(), cwd: tmp, stdout: s2, stderr: quiet });
        check("a steps file relative to the current folder", fromFile === 0 && s2.lines().length === 2, s2.lines());
        const lines = await run('{"cmd": "new_document"}\n{"cmd": "flip_layer"}\n');
        check("JSON lines on stdin (--run -)", lines.code === 0 && lines.calls[1].args.doc === 7, lines.calls);
    }
    {
        // the examples of docs/MCP.md: they parse, run per file, and open and close a tab of their own
        const dir = path.join(__dirname, "..", "docs", "examples");
        const names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
        check("docs/examples holds the three examples", ["cutout_folder.json", "key_folder.json", "look_folder.json"].every((n) => names.includes(n)), names);
        for (const n of names) {
            let p = null;
            try { p = cli.parseSteps(fs.readFileSync(path.join(dir, n), "utf8")); } catch (err) { check(`${n} parses`, false, err.message); continue; }
            const cmds = p.steps.map((s) => s.cmd);
            check(`${n}: files, starts with new_document, ends with close_document`, p.files && cmds[0] === "new_document" && cmds[cmds.length - 1] === "close_document", cmds);
        }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`${passed} ok, ${failed} failed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); console.log("FAIL"); process.exit(1); });
