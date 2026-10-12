// electron/main/settings.js without Electron: the default of "Prompt and recipe in the PNG" (settings.embedRecipe, on
// since 0.1.32) reaches a profile that 0.1.30 or 0.1.31 wrote, and a choice the user made stays theirs.
// Then settings.realism (the Realism Pass, docs/PLAN_0_1_42.md R1): an older profile reads the defaults, a write of
// another key keeps a stored object whole, a partial one comes back as stored and renderer/editor/realism.js
// fillValues fills it.
// Then settings.relight (docs/PLAN_RELIGHT_FIXES.md F3.6): flat, only what the user picked; a nested block an older build
// stored is dropped on read, and renderer/editor/host.js stores the picks, never its defaults.
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

// ---- settings.relight (docs/PLAN_RELIGHT_FIXES.md F3.6) ---------------------------------------------------------
// The relight panel's values are stored flat and only as the user picked them (renderer/editor/host.js relightPicked);
// the defaults stay in host.relightSettings. Until F3, DEFAULTS.relight was a nested object ({ route, magnific: {...},
// detailFromOriginal }) that nothing read, get() handed it to the renderer, and setRelightSettings stored host's whole
// object beside it: both shapes and every default on disk after the first slider move.
async function relight() {
    console.log("--- settings.relight ---");
    const { isDeepStrictEqual } = require("node:util");
    const savedWindow = global.window, savedDocument = global.document;
    let s = fresh(undefined);
    // host.js asks window.scumble.comfy.onEvent at import; its settings.set is main's set() of the profile in use
    global.window = {
        scumble: { comfy: { onEvent() {} }, helpers: { free: async () => {} }, settings: { set: async (patch) => s.set(patch) } },
        addEventListener() {}, removeEventListener() {},
    };
    global.document = { createElement: () => ({ getContext: () => ({}) }) };
    const tick = () => new Promise((r) => setTimeout(r, 0));
    try {
        const { host } = await import(pathToFileURL(path.join(__dirname, "..", "renderer", "editor", "host.js")).href);
        const defaults = { ...host.relightSettings };
        const freshHost = () => { host.relightSettings = { ...defaults }; host.relightPicked = {}; };
        const nestedKeys = (o) => Object.keys(o || {}).filter((k) => o[k] && typeof o[k] === "object");

        check("DEFAULTS.relight holds no nested object and no light type", nestedKeys(s.DEFAULTS.relight).length === 0 && !("light_type" in s.DEFAULTS.relight), JSON.stringify(s.DEFAULTS.relight));
        // a new profile: a slider move stores that value alone
        freshHost();
        host.configure({ mount: {}, relight: s.get().relight });
        host.setRelightSettings({ strength: 40 });
        await tick();
        check("a new profile stores only the value moved ({ strength: 40 })", isDeepStrictEqual(onDisk().relight, { strength: 40 }), JSON.stringify(onDisk().relight));

        // a profile written before F3, as that store wrote it: host's whole object (every default, light_type's included)
        // with the two picks, beside the nested default only that store wrote
        const nested = { route: "app", strength: 55, style: "standard", preserve_details: true, interpolate: false, detail: false, enable_hr_fix: true,
            light_type: "soft overcast daylight lighting", lora_strength: 100, steps: 4,
            magnific: { strength: 100, style: "standard", preserve: true, interpolate: false }, detailFromOriginal: true };
        const flat = { strength: 55, detail: false };
        s = fresh({ recipe: "x", relight: nested });
        check("get() drops the nested pair and the old defaults (light_type's too) and keeps the picks", isDeepStrictEqual(s.get().relight, flat), JSON.stringify(s.get().relight));
        // without the nested pair the block is F3's own store: a light type equal to the old default is a real pick
        s = fresh({ recipe: "x", relight: { light_type: "soft overcast daylight lighting", steps: 4 } });
        check("an F3 store keeps a pick equal to an old default", isDeepStrictEqual(s.get().relight, { light_type: "soft overcast daylight lighting", steps: 4 }), JSON.stringify(s.get().relight));
        s = fresh({ recipe: "x", relight: nested });
        s.set({ apiSize: "x2" });
        check("a write of another key stores relight flat", isDeepStrictEqual(onDisk().relight, flat) && onDisk().apiSize === "x2", JSON.stringify(onDisk().relight));

        // the renderer reads that profile (shell.js configure) and the user moves the strength: the picks are stored, never
        // the defaults (style, lora_strength, light_type ...) and no nested key
        s = fresh({ recipe: "x", relight: nested });
        freshHost();
        host.configure({ mount: {}, relight: s.get().relight });
        const got = host.getRelightSettings();
        check("host reads the migrated picks (strength 55, detail false), no light type and no nested key",
            got.strength === 55 && got.detail === false && got.light_type === undefined && !("magnific" in got) && !("detailFromOriginal" in got),
            JSON.stringify({ strength: got.strength, detail: got.detail, light_type: got.light_type, nested: Object.keys(got).filter((k) => k === "magnific" || k === "detailFromOriginal") }));
        host.setRelightSettings({ strength: 40 });
        await tick();
        const stored = onDisk().relight;
        const extra = Object.keys(stored).filter((k) => !(k in flat));
        check("a slider move then stores { strength 40, detail false } and nothing else", isDeepStrictEqual(stored, { strength: 40, detail: false }),
            `${JSON.stringify(stored)}${extra.length ? "  extra: " + extra.join(", ") : ""}`);

        // host's configure drops a nested value by itself (an older main, a hand-edited file)
        freshHost();
        host.configure({ mount: {}, relight: nested });
        check("configure keeps no nested object in host (magnific), the flat picks read", !("magnific" in host.relightSettings) && !("magnific" in (host.relightPicked || {})) && host.relightSettings.strength === 55,
            JSON.stringify(nestedKeys(host.relightSettings)));
    } finally {
        global.window = savedWindow;
        global.document = savedDocument;
    }
}

(async () => {
    try {
        embedRecipe();
        await realism();
        await relight();
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
