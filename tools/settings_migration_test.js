// electron/main/settings.js without Electron: the default of "Prompt and recipe in the PNG" (settings.embedRecipe, on
// since 0.1.32) reaches a profile that 0.1.30 or 0.1.31 wrote, and a choice the user made stays theirs.
//
//     node tools/settings_migration_test.js
//
// settings.set() writes the whole merged object, so the old default `embedRecipe: false` sits in every profile that
// saved anything since 0.1.30; get() drops it unless the switch itself wrote it (`embedRecipeChosen`, host.setEmbedRecipe).
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let failures = 0;
function check(name, ok, detail = "") {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
    if (!ok) failures++;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-settings-"));
// electron's app stood in for: only getPath("userData") is asked
const load = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === "electron") return { app: { getPath: () => dir } };
    return load.call(this, request, parent, isMain);
};
const SETTINGS = path.join(__dirname, "..", "electron", "main", "settings.js");
const fresh = (stored) => {
    if (stored === undefined) { try { fs.unlinkSync(path.join(dir, "settings.json")); } catch (_) { /* none */ } }
    else fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(stored));
    for (const k of Object.keys(require.cache)) if (k.includes(path.join("electron", "main"))) delete require.cache[k];
    return require(SETTINGS);
};

try {
    let s = fresh(undefined);
    check("a new profile has the switch on", s.get().embedRecipe === true && s.DEFAULTS.embedRecipe === true);
    s = fresh({ embedRecipe: false, recipe: "sdxl_inpaint" });
    check("the old default a 0.1.31 profile stored gives way to the new one", s.get().embedRecipe === true && s.get().recipe === "sdxl_inpaint");
    s.set({ apiSize: "x2" });
    const written = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    check("the next write stores the new default", written.embedRecipe === true && written.apiSize === "x2");
    s = fresh({ embedRecipe: false, embedRecipeChosen: true });
    check("a switch the user turned off stays off", s.get().embedRecipe === false);
    s = fresh({ embedRecipe: true });
    check("an unmarked true stays true", s.get().embedRecipe === true);
    s = fresh({ embedRecipe: false, embedRecipeChosen: true });
    s.set({ recipe: "x" });
    const again = fresh(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")));
    check("the user's off survives a write and a restart", again.get().embedRecipe === false);
} finally {
    Module._load = load;
    fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `${failures} FAILED` : "PASS");
process.exit(failures ? 1 : 0);
