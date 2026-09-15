// What Settings › Rendering › Restart now does in the main process (docs/PLAN_BCE.md §C7, "The default,
// as built"). No Electron in here, so a plain Node test (tools/restart_test.js) can check it.
"use strict";

/**
 * The command line the restarted process gets: this one without the switches that make an agent or a
 * headless process (the same rule as parseArgs in main.js). The button is pressed in a visible window,
 * so the new process has to open one: `--mcp` again would serve a stdin nobody writes to and quit with
 * no window, `--headless` would come back invisible holding the instance lock, and `--cmd` would run
 * its command once more and exit. Everything else stays (`--tiles` / `--no-tiles`, `--user-data-dir`,
 * the dev run's ".").
 */
function relaunchArgs(argv) {
    const out = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--mcp" || a === "--headless") continue;
        if (a === "--cmd") {
            i++;   // the command's name
            if (argv[i + 1] && !argv[i + 1].startsWith("--")) i++;   // its JSON arguments
            continue;
        }
        out.push(a);
    }
    return out;
}

/**
 * How to restart: `{ install: true }` while an update has been downloaded, else `{ args }` for
 * app.relaunch. With an update waiting, a plain quit runs its installer silently without starting the
 * app afterwards (electron-updater's autoInstallOnAppQuit), and the installer kills whatever runs from
 * the install folder, the relaunched Scumble included; installing it the way the update button does
 * starts the new version once it is in. That start takes no command line: the settings decide.
 */
function restartPlan({ argv = [], updateState = null } = {}) {
    if (updateState === "downloaded") return { install: true };
    return { args: relaunchArgs(argv) };
}

module.exports = { relaunchArgs, restartPlan };
