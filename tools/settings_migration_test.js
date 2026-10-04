// electron/main/settings.js without Electron: the default of "Prompt and recipe in the PNG" (settings.embedRecipe, on
// since 0.1.32) reaches a profile that 0.1.30 or 0.1.31 wrote, and a choice the user made stays theirs.
// Then settings.realism (the Realism Pass, docs/PLAN_0_1_42.md R1): an older profile reads the defaults, a write of
// another key keeps a stored object whole, a partial one comes back as stored and renderer/editor/realism.js
// fillValues fills it.
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
const { pathToFileURL } = require("node:url");

let failures = 0;
function check(name, ok, detail = "") {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
    if (!ok) failures++;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
const onDisk = () => JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));

function embedRecipe() {
    let s = fresh(undefined);
    check("a new profile has the switch on", s.get().embedRecipe === true && s.DEFAULTS.embedRecipe === true);
    s = fresh({ embedRecipe: false, recipe: "sdxl_inpaint" });
    check("the old default a 0.1.31 profile stored gives way to the new one", s.get().embedRecipe === true && s.get().recipe === "sdxl_inpaint");
    s.set({ apiSize: "x2" });
    const written = onDisk();
    check("the next write stores the new default", written.embedRecipe === true && written.apiSize === "x2");
    s = fresh({ embedRecipe: false, embedRecipeChosen: true });
    check("a switch the user turned off stays off", s.get().embedRecipe === false);
    s = fresh({ embedRecipe: true });
    check("an unmarked true stays true", s.get().embedRecipe === true);
    s = fresh({ embedRecipe: false, embedRecipeChosen: true });
    s.set({ recipe: "x" });
    const again = fresh(onDisk());
    check("the user's off survives a write and a restart", again.get().embedRecipe === false);
}

// ---- settings.realism (docs/PLAN_0_1_42.md R1) ------------------------------------------------------------------
async function realism() {
    console.log("--- settings.realism ---");
    const R = await import(pathToFileURL(path.join(__dirname, "..", "renderer", "editor", "realism.js")).href);
    const WANT = { style: "Default", intensity: 1, preset: "L", timeout: 300 };

    let s = fresh(undefined);
    check("DEFAULTS.realism is { style Default, intensity 1, preset L, timeout 300 }, the same as realism.realismDefaults",
        eq(s.DEFAULTS.realism, WANT) && eq(s.DEFAULTS.realism, { ...R.realismDefaults }), JSON.stringify(s.DEFAULTS.realism));
    check("a new profile reads the defaults", eq(s.get().realism, WANT), JSON.stringify(s.get().realism));

    // a 0.1.41 profile: written before the key existed
    s = fresh({ recipe: "sdxl_inpaint", embedRecipe: true, nodeParams: { padding: 32, target_size: 1024, feather: 16, multiple_of: 64 } });
    check("an older settings.json without realism reads the defaults, and keeps what it stored", eq(s.get().realism, WANT) && s.get().recipe === "sdxl_inpaint" && s.get().nodeParams.padding === 32, JSON.stringify(s.get().realism));
    check("fillValues of that read is the defaults too", eq(R.fillValues(s.get().realism), WANT), JSON.stringify(R.fillValues(s.get().realism)));

    // a stored realism the user chose survives a write of another key and a restart, all four keys
    const mine = { style: "Cinematic", intensity: 0.4, preset: "M", timeout: 600 };
    s = fresh({ recipe: "realism_pass", realism: mine });
    check("a stored realism reads back as stored", eq(s.get().realism, mine), JSON.stringify(s.get().realism));
    s.set({ apiSize: "x2" });
    let written = onDisk();
    check("a write of another key keeps the stored realism whole (all four keys)", eq(written.realism, mine) && written.apiSize === "x2", JSON.stringify(written.realism));
    s.set({ recipe: "flux2_klein_local", nodeParams: { padding: 64, target_size: 1024, feather: 16, multiple_of: 64 } });
    s = fresh(onDisk());
    check("... and a second write and a restart", eq(s.get().realism, mine) && s.get().recipe === "flux2_klein_local", JSON.stringify(s.get().realism));
    check("fillValues leaves a whole, valid stored object as it is", eq(R.fillValues(s.get().realism), mine), JSON.stringify(R.fillValues(s.get().realism)));

    // an older profile without the key: a write stores the defaults, whole
    s = fresh({ recipe: "sdxl_inpaint" });
    s.set({ apiSize: "x2" });
    written = onDisk();
    check("a write to a profile without realism stores the defaults, whole", eq(written.realism, WANT), JSON.stringify(written.realism));

    // get() merges only the top level: a partial object comes back as stored, the renderer fills it per key
    const partial = { style: "Natural" };
    s = fresh({ realism: partial });
    check("a stored partial realism ({ style: \"Natural\" }) comes back from get() as stored (top-level merge only)", eq(s.get().realism, partial), JSON.stringify(s.get().realism));
    check("realism.fillValues fills it to { style Natural, intensity 1, preset L, timeout 300 }",
        eq(R.fillValues(s.get().realism), { style: "Natural", intensity: 1, preset: "L", timeout: 300 }), JSON.stringify(R.fillValues(s.get().realism)));
    s.set({ apiSize: "x2" });
    s = fresh(onDisk());
    check("the partial object survives a write of another key and a restart as it was stored (no key invented)", eq(s.get().realism, partial) && eq(onDisk().realism, partial), JSON.stringify(onDisk().realism));
}

(async () => {
    try {
        embedRecipe();
        await realism();
    } finally {
        Module._load = load;
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log(failures ? `${failures} FAILED` : "PASS");
    process.exit(failures ? 1 : 0);
})().catch((err) => {
    console.log("FAIL " + ((err && err.stack) || err));
    process.exit(1);
});
