// The editor's pixel backend, decided once per window: the tile engine or one canvas per layer
// (docs/PLAN_BCE.md §C2 "C2 as built" step b, §C7). No Electron in here, so a plain Node test
// (tools/tilemode_test.js) can check the precedence.
"use strict";

/** The backend when nothing chose one: the tile engine, in a dev run and in the packaged app alike (0.1.13). */
const DEFAULT_ON = true;

/**
 * The command line wins (`--tiles` / `--no-tiles`), then the environment (`SCUMBLE_TILES=1` / `0`),
 * then `tiles` in settings.json when it holds a boolean (the Settings › Rendering row writes it),
 * and otherwise the default. `from` names what decided: "command line", "SCUMBLE_TILES", "settings"
 * or "default". `packaged` does not change the default any more; it stays an input so the test can
 * pin that the installed app takes the same one as a dev run.
 *
 * The default is resolved here and never written: settings.set() stores the whole merged object, so a
 * computed default in settings.DEFAULTS would stick to whichever build saved first.
 */
function resolveTileMode({ argv = [], env = {}, setting, packaged = false } = {}) {
    void packaged;
    if (argv.includes("--tiles")) return { on: true, from: "command line" };
    if (argv.includes("--no-tiles")) return { on: false, from: "command line" };
    const e = env.SCUMBLE_TILES;
    if (e === "1" || e === "0") return { on: e === "1", from: "SCUMBLE_TILES" };
    if (typeof setting === "boolean") return { on: setting, from: "settings" };
    return { on: DEFAULT_ON, from: "default" };
}

module.exports = { resolveTileMode, DEFAULT_ON };
