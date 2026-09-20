// The recipe files and the recipe importer (electron/main/recipes.js), in plain Node, no Electron:
//   node tools/recipes_test.js
// Two things are checked. First the shipped recipes in recipes/: every settings row of a variant owns its own
// slot. The editor keeps one stored value per slot (`editor.settings[String(index)]`, inpaint_canvas.js
// settingsChanged) and host.js providerParams reads every row from that one slot, so two rows at the same index
// send one value under both keys - FLUX.2 [flex] on fal sent the safety tolerance as the step count until
// 2026-09-20 (docs/BUGS.md, "What OpenRouter (item 12) found on the way"). Then importFile: a provider recipe in
// the shape every shipped one has (a `providers` map) has to import, so a user can copy a recipe, add a variant
// and bring it back in; the old one-provider shape keeps working, and a file that is neither is still refused.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const RECIPES = path.join(ROOT, "recipes");
const SETTING_SLOTS = 8;   // inpaint_canvas.js SETTING_SLOTS: setting_1 .. setting_8

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 400 ? s.slice(0, 400) + " ..." : s; };

async function section(name, fn) {
    console.log(`\n--- ${name} ---`);
    await fn();
}

// ---- recipes.js with a temporary userData folder -------------------------------------
let USERDATA = "";
function loadRecipes() {
    const orig = Module._load;
    Module._load = function (request, ...rest) {
        if (request === "electron") return { app: { getPath: () => USERDATA } };
        return orig.call(this, request, ...rest);
    };
    try { return require(path.join(ROOT, "electron", "main", "recipes.js")); } finally { Module._load = orig; }
}
function freshUserData() {
    if (USERDATA) fs.rmSync(USERDATA, { recursive: true, force: true });
    USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-recipes-test-"));
    return USERDATA;
}

const rawFile = (name) => JSON.parse(fs.readFileSync(path.join(RECIPES, name), "utf8"));

/**
 * What is wrong with one list of settings rows: an index that is not a whole slot number, a slot two rows
 * share, or a key two rows share. `where` only names the list in the message.
 */
function slotFaults(rows, where) {
    const bad = [];
    const seen = new Map();
    const keys = new Map();
    for (const s of rows || []) {
        const i = s && s.index;
        // a comfy recipe's row names the node input it drives, a provider variant's the request key
        const k = String((s && (s.key !== undefined ? s.key : s.input)) || "");
        if (!Number.isInteger(i) || i < 1 || i > SETTING_SLOTS) { bad.push(`${where}: index ${JSON.stringify(i)} of ${JSON.stringify(k)} is no slot 1..${SETTING_SLOTS}`); continue; }
        if (seen.has(i)) bad.push(`${where}: slot ${i} carries both ${seen.get(i)} and ${k} - one stored value would drive both`);
        else seen.set(i, k);
        if (!k) bad.push(`${where}: the row at slot ${i} names no key`);
        else if (keys.has(k)) bad.push(`${where}: the key ${k} is on slot ${keys.get(k)} and on ${i}`);
        else keys.set(k, i);
    }
    return bad;
}

/** Write a JSON file into a scratch folder and hand back its path. */
function fileOf(dir, name, data) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
    return p;
}

async function thrown(fn) {
    try { await fn(); return null; } catch (err) { return String((err && err.message) || err); }
}

async function main() {
    freshUserData();
    const recipes = loadRecipes();

    // ---- 1. the shipped recipes: one slot per settings row -------------------------------
    await section("1. the shipped recipes", async () => {
        const files = fs.readdirSync(RECIPES).filter((n) => n.endsWith(".json")).sort();
        check("the recipes folder holds the shipped recipes", files.length >= 20, `${files.length} files`);

        const list = await recipes.list(RECIPES);
        check("every shipped file is listed, all builtin", list.length === files.length && list.every((r) => r.source === "builtin"), `${list.length} listed`);

        const bad = [];
        let rowCount = 0, variantCount = 0;
        for (const r of list) {
            if (r.kind === "provider") {
                for (const [pid, v] of Object.entries(r.providers || {})) {
                    variantCount++;
                    rowCount += (v.settings || []).length;
                    bad.push(...slotFaults(v.settings, `${r.id}/${pid}`));
                    // the text shape runs on the same stored slots; normalize() hands it the edit rows when it brings none
                    if (v.text && v.text.settings !== v.settings) bad.push(...slotFaults(v.text.settings, `${r.id}/${pid} text`));
                }
            } else {
                rowCount += (r.settings || []).length;
                bad.push(...slotFaults(r.settings, r.id));
                for (const s of r.settings || []) {
                    if (r.prompt && s.node !== undefined && !r.prompt[s.node]) bad.push(`${r.id}: settings row ${s.index} names node ${s.node}, which the prompt has not`);
                }
            }
        }
        check("every settings row of every shipped variant owns its slot, and its key", !bad.length, bad.length ? short(bad) : `${rowCount} rows in ${variantCount} provider variants and the comfy recipes`);

        // the row that was wrong until 2026-09-20, as an anchor
        const flex = rawFile("flux2_flex.json");
        const fal = (flex.providers.fal.settings || []).map((s) => [s.index, s.key]);
        check("FLUX.2 [flex] on fal: steps, guidance and safety tolerance on three slots of their own", eq(fal, [[1, "num_inference_steps"], [2, "guidance_scale"], [3, "safety_tolerance"]]), short(fal));
    });

    // ---- 2. importFile ------------------------------------------------------------------
    await section("2. importFile", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-recipes-files-"));
        freshUserData();

        // a shipped recipe, copied, with a model the app does not ship added as another OpenRouter variant
        const mine = rawFile("flux2_flex.json");
        mine.id = "flux2_flex_mine";
        mine.name = "FLUX.2 [flex] (mine)";
        mine.providers.openrouter = { ...mine.providers.openrouter, model: "black-forest-labs/flux.2-flex:free" };
        const minePath = fileOf(dir, "flux2_flex_mine.json", mine);

        const imported = await recipes.importFile(minePath, null);
        check("a provider recipe in the shipped `providers` shape imports", !!imported && imported.kind === "provider" && imported.source === "user", short(imported && { id: imported.id, kind: imported.kind, source: imported.source }));
        check("it keeps its id, its name and every variant, and the default the file names", imported && imported.id === "flux2_flex_mine" && imported.name === "FLUX.2 [flex] (mine)" && eq(imported.providerIds, Object.keys(mine.providers)) && imported.default === "bfl", short(imported && { id: imported.id, ids: imported.providerIds, def: imported.default }));
        check("the model of the variant the user added is the one in the file", imported && imported.providers.openrouter.model === "black-forest-labs/flux.2-flex:free", imported && imported.providers.openrouter.model);
        check("it is written into the user's recipes folder", fs.existsSync(path.join(recipes.userDir(), "flux2_flex_mine.json")), recipes.userDir());

        const listed = await recipes.list(RECIPES);
        const got = listed.filter((r) => r.id === "flux2_flex_mine");
        check("list() serves it once, as a user recipe beside the shipped ones", got.length === 1 && got[0].source === "user", `${got.length} entries`);
        const v = got[0] && got[0].providers && got[0].providers.openrouter;
        check("normalize() gave the imported variant its limits, its text shape and edit true", !!v && v.limits && v.limits.max === 1440 && !!v.text && v.text.model === "black-forest-labs/flux.2-flex:free" && v.edit === true, short(v && { limits: v.limits, text: v.text && v.text.model, edit: v.edit }));
        check("the imported recipe obeys the slot rule too", !listed.filter((r) => r.source === "user").flatMap((r) => Object.entries(r.providers || {}).flatMap(([pid, pv]) => slotFaults(pv.settings, `${r.id}/${pid}`))).length);

        // a copy that keeps the shipped id shadows the shipped recipe, as a copy placed in the folder by hand does
        const same = rawFile("flux2_flex.json");
        same.description = "my own";
        await recipes.importFile(fileOf(dir, "flux2_flex.json", same), null);
        const after = await recipes.list(RECIPES);
        const flex = after.filter((r) => r.id === "flux2_flex");
        check("a copy under the shipped id shadows the shipped recipe, and is served once", flex.length === 1 && flex[0].source === "user" && flex[0].description === "my own", `${flex.length} entries, source ${flex[0] && flex[0].source}`);

        // the old one-provider shape
        freshUserData();
        const old = { kind: "provider", id: "old_shape", name: "Old shape", provider: "loopback", model: "loopback-1", input: "fill", settings: [{ index: 1, key: "steps", label: "Steps", spec: ["INT", { default: 20 }] }] };
        const oldIn = await recipes.importFile(fileOf(dir, "old_shape.json", old), null);
        check("a provider recipe in the old one-provider shape still imports and normalizes to a providers map", !!oldIn && eq(oldIn.providerIds, ["loopback"]) && oldIn.providers.loopback.model === "loopback-1" && oldIn.default === "loopback", short(oldIn && { ids: oldIn.providerIds, def: oldIn.default }));

        // a comfy recipe file
        const comfy = { kind: "comfy", id: "comfy_one", name: "Comfy one", mode: "local", canvas: "1", result: "2:0", prompt: { 1: { class_type: "InpaintCanvas", inputs: {} }, 2: { class_type: "KSampler", inputs: {} } } };
        const comfyIn = await recipes.importFile(fileOf(dir, "comfy_one.json", comfy), null);
        check("a comfy recipe file still imports", !!comfyIn && comfyIn.kind === "comfy" && comfyIn.canvas === "1", short(comfyIn && { kind: comfyIn.kind, canvas: comfyIn.canvas }));

        // what stays refused
        const before = fs.readdirSync(recipes.userDir()).sort();
        const noVariants = await thrown(() => recipes.importFile(fileOf(dir, "empty_provider.json", { kind: "provider", id: "x", name: "X" }), null));
        check("a provider recipe that names no provider is refused, and says so", !!noVariants && /names no provider/.test(noVariants), noVariants);
        const emptyMap = await thrown(() => recipes.importFile(fileOf(dir, "empty_map.json", { kind: "provider", id: "x", name: "X", providers: {} }), null));
        check("an empty `providers` map is refused the same way", !!emptyMap && /names no provider/.test(emptyMap), emptyMap);
        const arrayMap = await thrown(() => recipes.importFile(fileOf(dir, "array_map.json", { kind: "provider", id: "x", name: "X", providers: [{ model: "m" }] }), null));
        check("a `providers` array is no map and is refused", !!arrayMap && /names no provider/.test(arrayMap), arrayMap);
        const notARecipe = await thrown(() => recipes.importFile(fileOf(dir, "junk.json", { hello: "world" }), null));
        check("a file that is no workflow, no prompt and no recipe keeps its own message", !!notARecipe && /neither a ComfyUI workflow/.test(notARecipe), notARecipe);
        const noCanvas = await thrown(() => recipes.importFile(fileOf(dir, "prompt.json", { 1: { class_type: "KSampler", inputs: {} } }), null));
        check("an API-format prompt without an Inpaint Canvas node keeps its own message", !!noCanvas && /no Inpaint Canvas node/.test(noCanvas), noCanvas);
        const uiWorkflow = await thrown(() => recipes.importFile(fileOf(dir, "ui.json", { nodes: [{ type: "InpaintCanvas" }] }), null));
        check("a UI-format workflow without the node definitions still asks for a connection", !!uiWorkflow && /connect to ComfyUI first/.test(uiWorkflow), uiWorkflow);
        const broken = path.join(dir, "broken.json");
        fs.writeFileSync(broken, "{ not json", "utf8");
        const badJson = await thrown(() => recipes.importFile(broken, null));
        check("a file that is no JSON is refused before anything else", !!badJson && /Not a JSON file/.test(badJson), badJson);
        check("not one refused file was written into the user's recipes folder", eq(fs.readdirSync(recipes.userDir()).sort(), before), short(fs.readdirSync(recipes.userDir()).sort()));

        fs.rmSync(dir, { recursive: true, force: true });
    });

    if (USERDATA) fs.rmSync(USERDATA, { recursive: true, force: true });
    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + ((err && err.stack) || err)); console.log("FAIL"); process.exit(1); });
