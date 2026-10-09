// The .mcpb bundle without an app (docs/PLAN_MCPB.md §7): the staged manifest validates and carries the version and
// the tools, the starter finds Scumble in the right order with injected answers, its start forms are the ones
// registration.js writes, and the fallback answers the protocol over stdio when Scumble is missing.
//
//   node tools/mcpb_test.js                              the plain-Node checks (a-d)
//   node tools/mcpb_test.js --exe dist\win-unpacked\Scumble.exe   plus a real start through the starter (e)
//   node tools/mcpb_test.js --store                      plus the Store alias on this machine, when it exists
//
// Gate `mcpb` in tools/run_gates.sh runs it (with --exe when the runner has one).
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const STARTER = path.join(ROOT, "mcpb", "server", "index.js");
const starter = require(STARTER);
const build = require("./mcpb_build");
const registration = require("../electron/main/mcp/registration");

const argv = process.argv.slice(2);
const EXE = (() => { const i = argv.indexOf("--exe"); return i >= 0 ? path.resolve(argv[i + 1]) : ""; })();
const STORE = argv.includes("--store");

let failed = 0;
const checks = [];
function check(name, fn) { checks.push([name, fn]); }
function eq(a, b, what) {
    const x = JSON.stringify(a), y = JSON.stringify(b);
    if (x !== y) throw new Error(`${what || "value"}: ${x} instead of ${y}`);
}
function ok(c, what) { if (!c) throw new Error(what || "expected true"); }

// ---- a) the manifest ---------------------------------------------------------------------------

check("the_staged_manifest_validates_with_the_version_and_the_tools", () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-mcpb-stage-"));
    const m = build.stage(path.join(dest, "scumble"));
    eq(m.version, build.manifest().version, "version");
    eq(m.version, JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version, "package.json version");
    const headings = (fs.readFileSync(path.join(ROOT, "docs", "COMMANDS.md"), "utf8").match(/^### `/gm) || []).length;
    eq(m.tools.length, headings, "tool count against COMMANDS.md");
    ok(m.tools.length >= 100, `only ${m.tools.length} tools`);
    for (const t of m.tools) {
        ok(/^[A-Za-z0-9_-]+$/.test(t.name), `tool name ${t.name}`);
        ok(t.description && t.description.length > 10, `tool ${t.name} has no description`);
    }
    ok(m.tools.some((t) => t.name === "film_apply_look"), "plugin command with a dot written with _");
    ok(m.tools.some((t) => t.name === "select_by_text"), "select_by_text");
    for (const f of ["manifest.json", "server/index.js", "README.md", "icon.png", "LICENSE"]) ok(fs.existsSync(path.join(dest, "scumble", f)), `${f} staged`);
    const out = build.mcpb(["validate", path.join(dest, "scumble", "manifest.json")]);
    ok(/valid/i.test(out), "mcpb validate said: " + out.trim());
    fs.rmSync(dest, { recursive: true, force: true });
});

check("the_store_code_in_the_starter_is_the_one_registration_js_writes", () => {
    eq(starter.STORE_LAUNCH, registration.STORE_LAUNCH, "STORE_LAUNCH");
});

check("the_uninstall_guid_is_electron_builders_uuid_v5_of_the_appid", () => {
    const appId = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).build.appId;
    const ns = Buffer.from("50e065bc-3134-11e6-9bab-38c9862bdaf3".replace(/-/g, ""), "hex");   // electron-builder's namespace
    const h = crypto.createHash("sha1").update(Buffer.concat([ns, Buffer.from(appId)])).digest();
    h[6] = (h[6] & 0x0f) | 0x50;
    h[8] = (h[8] & 0x3f) | 0x80;
    const s = h.toString("hex");
    eq(starter.UNINSTALL_GUID, `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`, "guid");
});

// ---- b) the finder ----------------------------------------------------------------------------

const LOCAL = "C:\\Users\\u\\AppData\\Local";
const INSTALL = "C:\\Users\\u\\AppData\\Local\\Programs\\Scumble";
const ALIAS = `${LOCAL}\\Microsoft\\WindowsApps\\scumble.exe`;
function deps(o = {}) {
    const files = new Set(o.files || []);
    const links = new Set(o.links || []);
    const regs = o.reg || {};
    const calls = { reg: [] };
    return {
        calls,
        env: o.env || {},
        platform: o.platform || "win32",
        localAppData: LOCAL,
        programFiles: "C:\\Program Files",
        exists: (p) => files.has(p),
        lstat: (p) => files.has(p) || links.has(p),
        reg: (hive, key) => { calls.reg.push(hive + "\\" + key); return regs[hive] || {}; },
    };
}
const installed = (folder = INSTALL) => [`${folder}\\Scumble.exe`, `${folder}\\resources\\app.asar`];

check("an_explicit_path_wins_and_searches_nothing", () => {
    const d = deps({ files: [...installed(), "D:\\Portable\\Scumble\\Scumble.exe"], links: [ALIAS] });
    eq(starter.find("D:\\Portable\\Scumble\\Scumble.exe", d), { exe: "D:\\Portable\\Scumble\\Scumble.exe", store: false, how: "explicit" });
    eq(d.calls.reg, [], "no registry read");
    const e = deps({ files: [...installed(), "D:\\Portable\\Scumble\\Scumble.exe"], env: { SCUMBLE_EXE: "D:\\Portable\\Scumble\\Scumble.exe" } });
    eq(starter.find("", e).how, "explicit", "from the environment");
});

check("an_explicit_path_that_is_not_there_is_reported_not_replaced", () => {
    const d = deps({ files: installed(), links: [ALIAS] });
    eq(starter.find("D:\\gone\\Scumble.exe", d), { missing: "D:\\gone\\Scumble.exe" });
    eq(starter.find("", deps({ files: installed(), env: { SCUMBLE_EXE: "D:\\gone\\Scumble.exe" } })), { missing: "D:\\gone\\Scumble.exe" }, "from the environment");
    eq(d.calls.reg, [], "no registry read");
});

check("an_empty_field_and_the_clients_placeholder_count_as_not_set", () => {
    for (const v of ["", "   ", "${user_config.scumble_exe}", undefined, null]) {
        const d = deps({ files: installed(), env: { SCUMBLE_EXE: v } });
        eq(starter.find(v, d).how, "installer", JSON.stringify(v));
    }
});

check("the_installer_by_its_registry_key_then_the_default_folders", () => {
    const loc = deps({ files: installed("D:\\Apps\\Scumble"), reg: { HKCU: { InstallLocation: "D:\\Apps\\Scumble", UninstallString: '"D:\\Apps\\Scumble\\Uninstall Scumble.exe" /currentuser' } } });
    eq(starter.find("", loc), { exe: "D:\\Apps\\Scumble\\Scumble.exe", store: false, how: "installer" }, "InstallLocation");
    eq(loc.calls.reg[0], "HKCU\\" + starter.UNINSTALL_KEY, "the key");
    const unin = deps({ files: installed("D:\\Apps\\Scumble"), reg: { HKCU: { InstallLocation: "", UninstallString: '"D:\\Apps\\Scumble\\Uninstall Scumble.exe" /currentuser' } } });
    eq(starter.find("", unin).exe, "D:\\Apps\\Scumble\\Scumble.exe", "the UninstallString's folder (InstallLocation empty, as on the author's PC)");
    const machine = deps({ files: installed("C:\\Program Files\\Scumble"), reg: { HKLM: { InstallLocation: "C:\\Program Files\\Scumble" } } });
    eq(starter.find("", machine).exe, "C:\\Program Files\\Scumble\\Scumble.exe", "HKLM");
    eq(starter.find("", deps({ files: installed() })).exe, `${INSTALL}\\Scumble.exe`, "the default folder without a key");
    const stale = deps({ files: installed(), reg: { HKCU: { UninstallString: '"D:\\old\\Uninstall Scumble.exe" /currentuser' } } });
    eq(starter.find("", stale).exe, `${INSTALL}\\Scumble.exe`, "a stale key, the default folder");
    const half = deps({ files: [`${INSTALL}\\Scumble.exe`] });
    eq(starter.find("", half), null, "an exe without resources\\app.asar is no install");
});

check("the_store_alias_by_lstat_after_the_installer", () => {
    const both = deps({ files: installed(), links: [ALIAS] });
    eq(starter.find("", both).how, "installer", "both: the installer");
    const store = deps({ links: [ALIAS] });
    eq(starter.find("", store), { exe: ALIAS, store: true, how: "store" });
    eq(starter.find("", deps({})), null, "nothing");
    eq(starter.find("", deps({ files: installed(), platform: "linux" })), null, "not on linux");
});

check("an_explicit_alias_or_version_folder_takes_the_store_route", () => {
    eq(starter.find(ALIAS, deps({ links: [ALIAS] })).store, true, "the alias");
    const vf = "C:\\Program Files\\WindowsApps\\DenRakEiw.Scumble_0.1.42.0_x64__eh52rqbjjrbdj\\app\\Scumble.exe";
    eq(starter.find(vf, deps({ files: [vf] })).store, true, "the version folder");
    eq(starter.find("D:\\x\\Scumble.exe", deps({ files: ["D:\\x\\Scumble.exe"] })).store, false, "anything else");
});

// ---- c) the start forms ------------------------------------------------------------------------

check("the_installer_form_is_the_registration_line", () => {
    const found = { exe: "C:\\Program Files\\Scumble\\Scumble.exe", store: false, how: "installer" };
    const reg = registration.server({ platform: "win32", exe: found.exe, launcher: "C:\\Program Files\\Scumble\\resources\\app.asar\\electron\\main\\mcp\\launch.js" });
    eq(starter.plan(found), reg, "plan against registration.js");
    eq(starter.plan(found, ["--user-data-dir=X", "--no-comfy"]).args, [reg.args[0], "--user-data-dir=X", "--no-comfy", "--mcp"], "extra args before --mcp");
    eq(starter.plan(found, [], "F:\\canvas\\electron\\main\\mcp\\launch.js").args[0], "F:\\canvas\\electron\\main\\mcp\\launch.js", "a launcher override");
});

check("the_store_form_is_the_registration_line_with_the_extra_args_after_the_dashes", () => {
    const found = { exe: ALIAS, store: true, how: "store" };
    const reg = registration.server({ platform: "win32", storeAlias: ALIAS });
    const p = starter.plan(found);
    eq(p.command, reg.command, "command");
    eq(p.env, reg.env, "env");
    eq(p.args.slice(0, 2), reg.args, "-e and the code");
    eq(p.args.slice(2), ["--", "--mcp"], "then -- and --mcp");
    eq(starter.plan(found, ["--user-data-dir=X"]).args.slice(2), ["--", "--user-data-dir=X", "--mcp"], "extra args");
});

check("the_uninstall_string_gives_its_folder", () => {
    eq(starter.folderOfUninstall('"C:\\Users\\u\\AppData\\Local\\Programs\\Scumble\\Uninstall Scumble.exe" /currentuser'), "C:\\Users\\u\\AppData\\Local\\Programs\\Scumble");
    eq(starter.folderOfUninstall("C:\\x\\Uninstall.exe /S"), "C:\\x");
    eq(starter.folderOfUninstall(""), null);
    eq(starter.folderOfUninstall(undefined), null);
});

check("parse_args", () => {
    eq(starter.parseArgs(["--scumble", "D:\\a.exe", "--where", "--", "--user-data-dir=X", "--no-comfy"]), { scumble: "D:\\a.exe", launcher: "", where: true, extra: ["--user-data-dir=X", "--no-comfy"] });
    eq(starter.parseArgs(["--scumble=D:\\a.exe", "--launcher=L"]), { scumble: "D:\\a.exe", launcher: "L", where: false, extra: [] });
});

// ---- d) the fallback and e) a real start, both over stdio ------------------------------------------

/**
 * Runs the starter as a process, sends the requests one by one (each waits for its answer), returns the answers
 * and what else stdout carried. Closes stdin at the end and waits for the exit.
 */
function session(env, args, requests, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [STARTER, ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        let out = "", err = "";
        const answers = [];
        let waiting = null;
        const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* gone */ } reject(new Error(`timeout; stdout so far: ${out.slice(0, 300)}; stderr: ${err.slice(0, 300)}`)); }, timeoutMs);
        child.stdout.on("data", (c) => {
            out += c.toString("utf8");
            let i;
            while ((i = out.indexOf("\n")) >= 0) {
                const line = out.slice(0, i).trim();
                out = out.slice(i + 1);
                if (!line) continue;
                let msg;
                try { msg = JSON.parse(line); } catch (e) { clearTimeout(timer); child.kill(); return reject(new Error(`not JSON on stdout: ${line.slice(0, 120)}`)); }
                if (msg.id !== undefined && waiting && msg.id === waiting.id) { const w = waiting; waiting = null; answers.push(msg); w.resolve(); }
            }
        });
        child.stderr.on("data", (c) => { err += c.toString("utf8"); });
        child.on("error", (e) => { clearTimeout(timer); reject(e); });
        child.on("exit", (code) => { clearTimeout(timer); resolve({ answers, stderr: err, code }); });
        (async () => {
            try {
                for (const r of requests) {
                    if (r.id !== undefined) {
                        await new Promise((res) => { waiting = { id: r.id, resolve: res }; child.stdin.write(JSON.stringify(r) + "\n"); });
                    } else {
                        child.stdin.write(JSON.stringify(r) + "\n");
                    }
                }
                child.stdin.end();
            } catch (e) { clearTimeout(timer); child.kill(); reject(e); }
        })();
    });
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcpb_test", version: "0" } } };
const INITED = { jsonrpc: "2.0", method: "notifications/initialized" };
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

check("the_fallback_answers_the_protocol_with_one_tool_naming_the_missing_path", async () => {
    const gone = "D:\\nowhere\\Scumble.exe";
    const r = await session({ SCUMBLE_EXE: gone }, [], [INIT, INITED, LIST, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "scumble_not_installed", arguments: {} } }, { jsonrpc: "2.0", id: 4, method: "ping" }, { jsonrpc: "2.0", id: 5, method: "nope" }]);
    eq(r.answers.map((a) => a.id), [1, 2, 3, 4, 5], "every request answered");
    const init = r.answers[0].result;
    eq(init.serverInfo.name, "scumble", "serverInfo");
    eq(init.protocolVersion, "2025-06-18", "the client's protocol version echoed");
    ok(init.instructions.includes(gone), "instructions name the path");
    eq(r.answers[1].result.tools.map((t) => t.name), ["scumble_not_installed"], "one tool");
    eq(r.answers[1].result.tools[0].annotations.readOnlyHint, true, "read-only");
    const text = r.answers[2].result.content[0].text;
    ok(text.includes(gone) && text.includes("github.com/DenRakEiw/scumble/releases") && text.includes("apps.microsoft.com"), "the call's text: " + text);
    eq(r.answers[3].result, {}, "ping");
    eq(r.answers[4].error.code, -32601, "unknown method");
    ok(r.stderr.includes(gone), "stderr names the path once");
    eq(r.code, 0, "exit 0 when stdin closes");
});

check("the_fallback_says_nothing_was_found_when_the_search_is_empty", () => {
    const t = starter.missingText(null);
    ok(t.startsWith("No installed Scumble was found"), t);
    ok(starter.missingText({ missing: "X" }).includes("does not exist: X"), "explicit");
});

check("where_prints_json_and_starts_nothing", () => {
    const r = spawnSync(process.execPath, [STARTER, "--where"], { env: { ...process.env, SCUMBLE_EXE: "D:\\nowhere\\Scumble.exe" }, encoding: "utf8", windowsHide: true, timeout: 30000 });
    eq(r.status, 0, "exit: " + r.stderr);
    const w = JSON.parse(r.stdout);
    eq(w.found, { missing: "D:\\nowhere\\Scumble.exe" }, "found");
    eq(w.plan, null, "no plan");
    ok(w.note.includes("D:\\nowhere\\Scumble.exe"), "the note");
    const here = spawnSync(process.execPath, [STARTER, "--where", "--scumble", "D:\\a\\Scumble.exe"], { env: { ...process.env, SCUMBLE_EXE: "" }, encoding: "utf8", windowsHide: true, timeout: 30000 });
    eq(JSON.parse(here.stdout).found.missing, "D:\\a\\Scumble.exe", "--scumble over the environment");
});

if (EXE) {
    check("a_real_start_through_the_starter_lists_the_tools_headless", async () => {
        ok(fs.existsSync(EXE), `${EXE} exists`);
        const profile = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-mcpb-profile-"));
        const isElectron = path.basename(EXE).toLowerCase().startsWith("electron");
        const env = { SCUMBLE_EXE: EXE };
        if (isElectron) env.SCUMBLE_LAUNCHER = path.join(ROOT, "electron", "main", "mcp", "launch.js");
        const r = await session(env, ["--", `--user-data-dir=${profile}`, "--no-comfy"],
            [INIT, INITED, LIST, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ping", arguments: {} } }], 180000);
        eq(r.answers.map((a) => a.id), [1, 2, 3], "answers");
        eq(r.answers[0].result.serverInfo.name, "scumble", "serverInfo");
        const names = r.answers[1].result.tools.map((t) => t.name);
        ok(names.length >= 100, `${names.length} tools`);
        ok(names.includes("select_by_text") && names.includes("export"), "the real tools");
        const text = r.answers[2].result.content.map((c) => c.text || "").join("");
        const ping = JSON.parse(text);
        eq(ping.mcp.mode, "headless", "mode");
        eq(r.code, 0, "exit 0 after stdin closed");
        fs.rmSync(profile, { recursive: true, force: true });
    });
}

if (STORE) {
    check("the_store_alias_on_this_machine_answers_through_the_starter", async () => {
        const alias = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "scumble.exe");
        ok(starter.defaultDeps().lstat(alias), `no alias at ${alias}`);
        const profile = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-mcpb-store-"));
        const r = await session({ SCUMBLE_EXE: alias }, ["--", `--user-data-dir=${profile}`, "--no-comfy"],
            [INIT, INITED, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ping", arguments: {} } }], 180000);
        const ping = JSON.parse(r.answers[1].result.content.map((c) => c.text || "").join(""));
        eq(ping.app, "scumble", "the app: " + JSON.stringify(ping).slice(0, 200));
        eq(ping.mcp && ping.mcp.mode, "headless", "mode");
        console.log(`    the Store copy answered (app version ${ping.version || "not in ping"}), mode ${ping.mcp.mode}`);
        eq(r.code, 0, "exit 0 after stdin closed");
        fs.rmSync(profile, { recursive: true, force: true });
    });
}

(async () => {
    for (const [name, fn] of checks) {
        try { await fn(); console.log("[ok] " + name); } catch (err) { failed++; console.log("[FAIL] " + name + ": " + err.message); }
    }
    console.log(failed ? `mcpb_test: ${failed} FAILED` : "mcpb_test: PASS");
    process.exit(failed ? 1 : 0);
})();
