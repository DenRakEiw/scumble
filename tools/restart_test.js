// What Settings › Rendering › Restart now starts (electron/main/restart.js) in plain Node, no Electron:
//   node tools/restart_test.js
// Run by editor_test.py's step tile_engine_row_writes_the_setting_and_names_its_source.
"use strict";

const path = require("node:path");
const { relaunchArgs, restartPlan } = require(path.join(__dirname, "..", "electron", "main", "restart.js"));

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const dev = [".", "--remote-debugging-port=9555", "--user-data-dir=C:/p"];

const cases = [
    // [what, input, wanted plan]
    ["a plain dev run keeps its command line", { argv: dev, updateState: "dev" }, { args: dev }],
    ["the packaged app with no arguments", { argv: [], updateState: "latest" }, { args: [] }],
    ["--no-tiles stays", { argv: ["--no-tiles"], updateState: "idle" }, { args: ["--no-tiles"] }],
    ["an agent's --mcp process comes back as a window", { argv: [".", "--mcp", "--user-data-dir=C:/p"] }, { args: [".", "--user-data-dir=C:/p"] }],
    ["a --headless start comes back with its window", { argv: [".", "--headless", "--remote-debugging-port=9555", "--tiles"] }, { args: [".", "--remote-debugging-port=9555", "--tiles"] }],
    ["--cmd goes with its name and its JSON", { argv: [".", "--cmd", "export", "{\"path\":\"x.png\"}", "--no-tiles"] }, { args: [".", "--no-tiles"] }],
    ["--cmd without JSON leaves the next switch", { argv: ["--cmd", "ping", "--user-data-dir=C:/p"] }, { args: ["--user-data-dir=C:/p"] }],
    ["look-alike arguments are not the switches", { argv: ["--mcp-port=1", "--headless-ish"] }, { args: ["--mcp-port=1", "--headless-ish"] }],
    ["a downloaded update is installed instead", { argv: dev, updateState: "downloaded" }, { install: true }],
    ["an update still downloading does not install", { argv: ["--no-tiles"], updateState: "downloading" }, { args: ["--no-tiles"] }],
];

let failed = 0;
for (const [what, input, want] of cases) {
    const got = restartPlan(input);
    const ok = same(got, want);
    if (!ok) failed++;
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}: ${JSON.stringify(got)}${ok ? "" : " (wanted " + JSON.stringify(want) + ")"}`);
}
// the argument list the plan is made from is not changed
const argv = [".", "--mcp"];
relaunchArgs(argv);
if (!same(argv, [".", "--mcp"])) { failed++; console.log("[FAIL] relaunchArgs changed its input: " + JSON.stringify(argv)); }
console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
