// The pixel backend's precedence (electron/main/tilemode.js) in plain Node, no Electron:
//   node tools/tilemode_test.js
// Run by editor_test.py's step tile_engine_row_writes_the_setting_and_names_its_source.
"use strict";

const path = require("node:path");
const { resolveTileMode, DEFAULT_ON } = require(path.join(__dirname, "..", "electron", "main", "tilemode.js"));

const cases = [
    // [what, input, on, from]
    ["nothing set, dev run", {}, true, "default"],
    ["nothing set, packaged app", { packaged: true }, true, "default"],
    ["a setting that is not a boolean is no setting", { setting: "false", packaged: true }, true, "default"],
    ["null in settings.json", { setting: null, packaged: true }, true, "default"],
    ["the setting off", { setting: false, packaged: true }, false, "settings"],
    ["the setting on", { setting: true }, true, "settings"],
    ["SCUMBLE_TILES=1 over the setting off", { env: { SCUMBLE_TILES: "1" }, setting: false }, true, "SCUMBLE_TILES"],
    ["SCUMBLE_TILES=0 over the setting on", { env: { SCUMBLE_TILES: "0" }, setting: true, packaged: true }, false, "SCUMBLE_TILES"],
    ["SCUMBLE_TILES of another value is ignored", { env: { SCUMBLE_TILES: "yes" }, setting: false }, false, "settings"],
    ["--no-tiles over SCUMBLE_TILES=1 and the setting on", { argv: ["app", "--no-tiles"], env: { SCUMBLE_TILES: "1" }, setting: true }, false, "command line"],
    ["--tiles over SCUMBLE_TILES=0 and the setting off", { argv: ["app", "--tiles"], env: { SCUMBLE_TILES: "0" }, setting: false, packaged: true }, true, "command line"],
    ["--tiles-ish arguments are not the switch", { argv: ["app", "--scumble-tiles=0", "--tiles-from=x"], setting: false }, false, "settings"],
];

let failed = 0;
if (DEFAULT_ON !== true) { failed++; console.log("[FAIL] the default is " + DEFAULT_ON + ", not on"); }
for (const [what, input, on, from] of cases) {
    const r = resolveTileMode(input);
    const ok = r && r.on === on && r.from === from;
    if (!ok) failed++;
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}: ${JSON.stringify(r)}${ok ? "" : " (wanted " + JSON.stringify({ on, from }) + ")"}`);
}
console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
