// The recipe files and the recipe importer (electron/main/recipes.js), in plain Node, no Electron:
//   node tools/recipes_test.js
// Two things are checked. First the shipped recipes in recipes/: every settings row of a variant owns its own
// slot. The editor keeps one stored value per slot (`editor.settings[String(index)]`, inpaint_canvas.js
// settingsChanged) and host.js providerParams reads every row from that one slot, so two rows at the same index
// send one value under both keys - FLUX.2 [flex] on fal sent the safety tolerance as the step count until
// 2026-09-20 (docs/BUGS.md, "What OpenRouter (item 12) found on the way"). Then importFile: a provider recipe in
// the shape every shipped one has (a `providers` map) has to import, so a user can copy a recipe, add a variant
// and bring it back in; the old one-provider shape keeps working, and a file that is neither is still refused.
// Then the reference names (docs/PLAN_REFS.md): §3 each variant's refs.name, §4 each text shape's text.refs (26f,
// Generate new with references) against the table of 26f sub-task 1 and the takes-none list, and how normalize() reads
// a hand-made text.refs (true, false, a bad field, a bad value).
// The Realism Pass (docs/PLAN_0_1_42.md R1): §5 its recipe through the graph round trip (its name pinned to
// realism.LABEL; fromGraph keeps its presets only for the Settings rows the saved graph has, task "pass" only while
// the graph holds DLSS5Settings), §7 detach refuses it, §11 normalize's task "pass" and the presets a recipe file
// ships (shippedPresets; a node id may hold colons, "57:12:unet_name").
// RTX Video Super Resolution (docs/PLAN_0_1_42.md U1): §5 fromGraph keeps its factor (with its input) and limits, §7 its
// Comfy Cloud copy runs at the factor its graph holds (fixed, with a note).
// Boxes in the prompt on the user's ComfyUI (§13): a ComfyUI recipe's `boxes` kept by normalize, a bad one warned and
// dropped, carried through Save to recipe / Save as new recipe while the graph still feeds its input the plain prompt, none
// on the Comfy Cloud copy.
// LoRAs (item 50, §14): a recipe's `loras` through Save to recipe (GRAPH_KEEPS, the model source only while the saved
// graph holds it), the Comfy Cloud copy (a field of its variant), the manifest of tools/cloud_recipes.js and its --check.
// MOSS-Image Edit (item 50 LR6, §15): its graph against the node specs of tools/refs/comfy_templates/object_info.json
// (tools/node_specs.js) as normalize serves it and as a run queues it, Comfy's template values pinned.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");

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
        // a comfy recipe's row names the node and input it drives (host.settingTargets keys it "<recipe>/<node>:<input>",
        // so two rows may share an input name on different nodes), a provider variant's the request key
        const k = String((s && (s.key !== undefined ? s.key : s.node ? `${s.node}:${s.input}` : s.input)) || "");
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
        check("a new recipe with its own id notes `id <id>`", Array.isArray(imported.notes) && imported.notes.includes("id flux2_flex_mine"), short(imported && imported.notes));
        const mineAgain = { ...mine, description: "updated mine" };
        const reimported = await recipes.importFile(fileOf(dir, "flux2_flex_mine.json", mineAgain), null);
        check("re-importing a user recipe with its own id replaces it and notes `replaced your recipe <id>`",
            !!reimported && reimported.id === "flux2_flex_mine" && reimported.description === "updated mine"
            && Array.isArray(reimported.notes) && reimported.notes.includes("replaced your recipe flux2_flex_mine"),
            short(reimported && { id: reimported.id, notes: reimported.notes }));
        const same = rawFile("flux2_flex.json");
        same.description = "my own";
        const shadowed = await recipes.importFile(fileOf(dir, "flux2_flex.json", same), null);
        const after = await recipes.list(RECIPES);
        const flex = after.filter((r) => r.id === "flux2_flex");
        check("a copy under the shipped id shadows the shipped recipe, is served once, and notes `shadows the shipped <id>`",
            flex.length === 1 && flex[0].source === "user" && flex[0].description === "my own"
            && Array.isArray(shadowed.notes) && shadowed.notes.includes("shadows the shipped flux2_flex"),
            `${flex.length} entries, source ${flex[0] && flex[0].source}, notes ${short(shadowed && shadowed.notes)}`);

        // rec-import-overwrite: files whose id comes from the filename never overwrite an existing user recipe or shadow a shipped one
        const apiPrompt = (pad) => ({
            1: { class_type: "InpaintCanvas", inputs: { padding: pad, result_source_local: ["2", 0] } },
            2: { class_type: "KSampler", inputs: {} },
        });
        const wf1 = await recipes.importFile(fileOf(dir, "workflow.json", apiPrompt(32)), null);
        const wf2 = await recipes.importFile(fileOf(dir, "workflow.json", apiPrompt(64)), null);
        const afterWf = await recipes.list(RECIPES);
        const gotWf1 = afterWf.find((r) => r.id === "workflow");
        const gotWf2 = afterWf.find((r) => r.id === "workflow_2");
        check("importing two workflow/prompt files named workflow.json gives workflow (\"workflow\") and workflow_2 (\"workflow 2\"), and keeps the first in list()",
            !!wf1 && wf1.id === "workflow" && wf1.name === "workflow" && Array.isArray(wf1.notes) && wf1.notes.includes("id workflow")
            && !!wf2 && wf2.id === "workflow_2" && wf2.name === "workflow 2" && Array.isArray(wf2.notes) && wf2.notes.includes("id workflow_2")
            && !!gotWf1 && gotWf1.prompt["1"].inputs.padding === 32
            && !!gotWf2 && gotWf2.prompt["1"].inputs.padding === 64,
            short({ wf1: wf1 && { id: wf1.id, name: wf1.name, notes: wf1.notes }, wf2: wf2 && { id: wf2.id, name: wf2.name, notes: wf2.notes } }));

        const relightWf = await recipes.importFile(fileOf(dir, "relight.json", apiPrompt(48)), null);
        const noIdRecipe = await recipes.importFile(fileOf(dir, "flux2_pro.json", { kind: "provider", name: "No id", providers: { loopback: { model: "loopback-1" } } }), null);
        const afterRel = await recipes.list(RECIPES);
        const shippedRelight = afterRel.find((r) => r.id === "relight");
        const userRelight2 = afterRel.find((r) => r.id === "relight_2");
        const shippedPro = afterRel.find((r) => r.id === "flux2_pro");
        const userPro2 = afterRel.find((r) => r.id === "flux2_pro_2");
        check("importing a prompt or id-less recipe named after a shipped recipe (relight.json, flux2_pro.json) picks _2, numbers stem-derived names, and does not shadow the shipped recipe",
            !!relightWf && relightWf.id === "relight_2" && relightWf.name === "relight 2" && Array.isArray(relightWf.notes) && relightWf.notes.includes("id relight_2")
            && !!noIdRecipe && noIdRecipe.id === "flux2_pro_2" && noIdRecipe.name === "No id" && Array.isArray(noIdRecipe.notes) && noIdRecipe.notes.includes("id flux2_pro_2")
            && !!shippedRelight && shippedRelight.source === "builtin" && !!userRelight2 && userRelight2.source === "user"
            && !!shippedPro && shippedPro.source === "builtin" && !!userPro2 && userPro2.source === "user",
            short({ relightWf: relightWf && { id: relightWf.id, name: relightWf.name }, noIdRecipe: noIdRecipe && { id: noIdRecipe.id, name: noIdRecipe.name }, shippedRelight: shippedRelight && shippedRelight.source, shippedPro: shippedPro && shippedPro.source }));

        // rec-fresh-id-ignores-file-names: a hand-named user file (custom_file.json with id my_flux) is not overwritten by custom_file.json workflow or id "custom_file"
        fs.writeFileSync(path.join(recipes.userDir(), "custom_file.json"), JSON.stringify({ kind: "provider", id: "my_flux", name: "My Flux", providers: { loopback: { model: "loopback-1" } } }), "utf8");
        const cfWf = await recipes.importFile(fileOf(dir, "custom_file.json", apiPrompt(16)), null);
        const cfOwn = await recipes.importFile(fileOf(dir, "other.json", { kind: "provider", id: "custom_file", name: "Custom file", providers: { loopback: { model: "loopback-2" } } }), null);
        const afterCf = await recipes.list(RECIPES);
        check("a user file whose stem (custom_file.json) differs from its internal id (my_flux) is not overwritten when importing custom_file.json or id custom_file",
            !!cfWf && cfWf.id === "custom_file_2" && !!cfOwn && cfOwn.id === "custom_file_3"
            && !!afterCf.find((r) => r.id === "my_flux" && r.name === "My Flux")
            && !!afterCf.find((r) => r.id === "custom_file_2") && !!afterCf.find((r) => r.id === "custom_file_3"),
            short({ cfWf: cfWf && cfWf.id, cfOwn: cfOwn && cfOwn.id }));

        // rec-own-id-slug-collapse-replaces: non-canonical explicit ids that slug to the same string get fresh ids instead of replacing each other
        const slugA = await recipes.importFile(fileOf(dir, "slug_a.json", { kind: "provider", id: "My Custom Recipe!", name: "Slug A", providers: { loopback: { model: "loopback-1" } } }), null);
        const slugB = await recipes.importFile(fileOf(dir, "slug_b.json", { kind: "provider", id: "MY-CUSTOM-RECIPE", name: "Slug B", providers: { loopback: { model: "loopback-2" } } }), null);
        const afterSlug = await recipes.list(RECIPES);
        check("two recipes with non-canonical explicit ids that slug to the same string get my_custom_recipe and my_custom_recipe_2 instead of overwriting",
            !!slugA && slugA.id === "my_custom_recipe" && Array.isArray(slugA.notes) && slugA.notes.includes("id my_custom_recipe")
            && !!slugB && slugB.id === "my_custom_recipe_2" && Array.isArray(slugB.notes) && slugB.notes.includes("id my_custom_recipe_2")
            && !!afterSlug.find((r) => r.id === "my_custom_recipe" && r.name === "Slug A")
            && !!afterSlug.find((r) => r.id === "my_custom_recipe_2" && r.name === "Slug B"),
            short({ slugA: slugA && slugA.id, slugB: slugB && slugB.id }));

        // T7: flux2_klein_local own-id shadows the shipped recipe, while an id-less flux2_klein_local.json gets flux2_klein_local_2
        const kleinNoId = { kind: "comfy", ...rawFile("flux2_klein_local.json") };
        delete kleinNoId.id;
        const kleinFresh = await recipes.importFile(fileOf(dir, "flux2_klein_local.json", kleinNoId), null);
        const kleinOwn = { kind: "comfy", ...rawFile("flux2_klein_local.json"), description: "custom klein" };
        const kleinShadow = await recipes.importFile(fileOf(dir, "flux2_klein_local.json", kleinOwn), null);
        const afterKlein = await recipes.list(RECIPES);
        const gotKlein = afterKlein.filter((r) => r.id === "flux2_klein_local");
        check("an id-less flux2_klein_local.json gets flux2_klein_local_2, while a copy with id flux2_klein_local shadows the shipped recipe",
            !!kleinFresh && kleinFresh.id === "flux2_klein_local_2"
            && !!kleinShadow && kleinShadow.id === "flux2_klein_local" && Array.isArray(kleinShadow.notes) && kleinShadow.notes.includes("shadows the shipped flux2_klein_local")
            && gotKlein.length === 1 && gotKlein[0].source === "user" && gotKlein[0].description === "custom klein",
            short({ kleinFresh: kleinFresh && kleinFresh.id, kleinShadow: kleinShadow && { id: kleinShadow.id, notes: kleinShadow.notes } }));

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

    await section("3. refs.name (docs/PLAN_REFS.md C3)", async () => {
        const recipes = loadRecipes();
        // what each model's docs call its pictures; every other provider recipe takes the default
        const WANT = {
            flux2_pro: "image {n}", flux2_flex: "image {n}", flux2_max: "image {n}", flux2_klein: "image {n}",
            nano_banana_2: "image {n}", nano_banana_2_1: "image {n}", nano_banana_2_lite: "image {n}", nano_banana_pro: "image {n}", grok_imagine: "image {n}", reve: "image {n}",
            gpt_image_2: "Image {n}", gpt_image_2_5_flare: "Image {n}", gpt_image_2_5_sunburst: "Image {n}", gpt_image_2_6_flare: "Image {n}", gpt_image_2_6_sunburst: "Image {n}",
            seedream_4_5: "Image {n}", seedream_5_lite: "Image {n}", seedream_5_pro: "Image {n}", seedream_5_5: "Image {n}", qwen_image_edit: "Image {n}", hy_image_3_5: "Image {n}",
            qwen_image_2_1: "<image{n}>", cloud_qwen_image_2_1_edit: "<image{n}>",
            // P-H3-Image (docs/PLAN_PH3.md): Pruna AI's and the node's <Picture 1>, <Picture 2> ...
            p_h3_image: "<Picture {n}>", cloud_p_h3_image: "<Picture {n}>",
        };
        // a variant whose host names the pictures its own way: Krea 3 on fal and WaveSpeed (their pages: <image-1>, <image-2>)
        const WANT_VARIANT = { "krea_3/fal": "<image-{n}>", "krea_3/wavespeed": "<image-{n}>" };
        const wrong = [];
        for (const name of fs.readdirSync(RECIPES).filter((n) => n.endsWith(".json"))) {
            const raw = rawFile(name);
            const r = recipes._normalize(JSON.parse(JSON.stringify(raw)));
            if (r.kind !== "provider") {
                if (JSON.stringify(r.refs) !== JSON.stringify(raw.refs)) wrong.push(`${r.id}: a ComfyUI recipe's refs changed`);
                continue;
            }
            const want = WANT[r.id] || "image {n}";
            for (const [pid, v] of Object.entries(r.providers)) {
                const own = WANT_VARIANT[`${r.id}/${pid}`] || want;
                if (!v.refs || v.refs.name !== own) wrong.push(`${r.id}/${pid}: ${short(v.refs)}, not ${own}`);
            }
        }
        check("every provider variant of every shipped recipe carries its refs.name", !wrong.length, wrong.join("; "));
        const warn = console.warn;
        const warned = [];
        console.warn = (...a) => warned.push(a.join(" "));
        try {
            const r = recipes._normalize({ id: "t", kind: "provider", refs: { name: "Image {n}" }, providers: { a: { model: "m" }, b: { model: "m", refs: { name: "<frame>{n0}</frame>" } }, c: { model: "m", refs: { name: "@img{n}" } }, d: { model: "m", refs: null } } });
            check("a variant without refs takes the recipe's", r.providers.a.refs.name === "Image {n}", short(r.providers.a.refs));
            check("a variant's own refs wins", r.providers.b.refs.name === "<frame>{n0}</frame>", short(r.providers.b.refs));
            check("an invalid pattern gives the default and a warning", r.providers.c.refs.name === "image {n}" && warned.some((w) => /refs\.name/.test(w)), short(r.providers.c.refs) + " " + short(warned));
            check("refs: null gives the default", r.providers.d.refs.name === "image {n}", short(r.providers.d.refs));
            const up = recipes._normalize({ id: "u", kind: "provider", task: "upscale", providers: { a: { model: "m" } } });
            check("an upscaler's variant carries the default too", up.providers.a.refs && up.providers.a.refs.name === "image {n}", short(up.providers.a.refs));
            const comfy = recipes._normalize({ id: "c", kind: "comfy", refs: { name: "<image{n}>", slots: 4 } });
            check("a valid ComfyUI refs is kept as it is", eq(comfy.refs, { name: "<image{n}>", slots: 4 }), short(comfy.refs));
        } finally {
            console.warn = warn;
        }
    });

    await section("4. text.refs (docs/PLAN_REFS.md 26f)", async () => {
        const recipes = loadRecipes();
        // which text shapes send the shown reference layers along to a new image, and through which route: the table
        // of 26f sub-task 1 (written by its patch script). {} = the text route itself takes pictures; `model` = the edit
        // route a run with references goes to where the text route takes none; `options` merged over the variant's
        const TEXT_REFS = {
            flux2_pro: { toapis: {}, bfl: {}, fal: { model: "fal-ai/flux-2-pro/edit" }, replicate: {}, wavespeed: { model: "wavespeed-ai/flux-2-pro/edit" }, openrouter: {}, comfyrouter: {}, oxen: {}, magnific: {} },
            flux2_flex: { toapis: {}, bfl: {}, fal: { model: "fal-ai/flux-2-flex/edit" }, replicate: {}, wavespeed: { model: "wavespeed-ai/flux-2-flex/edit" }, openrouter: {}, oxen: {}, magnific: {} },
            flux2_max: { bfl: {}, fal: { model: "fal-ai/flux-2-max/edit" }, replicate: {}, wavespeed: { model: "wavespeed-ai/flux-2-max/edit" }, openrouter: {}, comfyrouter: {} },
            // Oxen's own cap is 16 for every model; FLUX.2 [klein] takes four pictures (BFL)
            flux2_klein: { bfl: {}, fal: { model: "fal-ai/flux-2/klein/9b/edit" }, wavespeed: { model: "wavespeed-ai/flux-2-klein-9b/edit" }, oxen: { max: 4 } },
            // FLUX 3 Image (docs/PLAN_FLUX3.md): the text route takes the reference layers, up to ten
            flux3: { bfl: {}, openrouter: {}, comfyrouter: {}, fal: { model: "blackforestlabs/flux-3/edit-image" }, wavespeed: { model: "black-forest-labs/flux-3/image-edit" }, oxen: {} },
            gpt_image_2: { toapis: {}, openai: {}, fal: { model: "openai/gpt-image-2/edit" }, replicate: {}, wavespeed: { model: "openai/gpt-image-2/edit" }, openrouter: {}, comfyrouter: {}, oxen: {}, magnific: { model: "text-to-image/gpt-image-2-edit" } },
            gpt_image_2_5_flare: { toapis: {}, openai: {}, fal: { model: "openai/gpt-image-2.5/flare/edit" }, replicate: {}, wavespeed: { model: "openai/gpt-image-2.5-flare/edit" }, openrouter: {}, comfyrouter: {}, oxen: {}, magnific: { model: "text-to-image/gpt-image-2-5-edit" } },
            gpt_image_2_5_sunburst: { toapis: {}, openai: {}, fal: { model: "openai/gpt-image-2.5/sunburst/edit" }, replicate: {}, wavespeed: { model: "openai/gpt-image-2.5-sunburst/edit" }, openrouter: {}, comfyrouter: {}, oxen: {}, magnific: { model: "text-to-image/gpt-image-2-5-edit" } },
            // GPT Image 2.6 (2026-11-06): ToAPIs serves Sunburst only (Flare is listed as disabled)
            gpt_image_2_6_flare: { openai: {}, fal: { model: "openai/gpt-image-2.6/flare/edit" }, replicate: {}, wavespeed: { model: "openai/gpt-image-2.6-flare/edit" }, openrouter: {}, oxen: {} },
            gpt_image_2_6_sunburst: { toapis: {}, openai: {}, fal: { model: "openai/gpt-image-2.6/sunburst/edit" }, replicate: {}, wavespeed: { model: "openai/gpt-image-2.6-sunburst/edit" }, openrouter: {}, oxen: {} },
            nano_banana_2: { toapis: {}, gemini: {}, fal: { model: "fal-ai/nano-banana-2/edit", options: { aspect_ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] } }, replicate: {}, wavespeed: { model: "google/nano-banana-2/edit" }, openrouter: {}, comfyrouter: {}, oxen: {} },
            nano_banana_2_1: { toapis: {}, gemini: {}, fal: { model: "fal-ai/nano-banana-2.1/edit", options: { aspect_ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "4:1", "1:4", "8:1", "1:8"] } }, replicate: {}, wavespeed: { model: "google/nano-banana-2.1/edit" }, openrouter: {}, comfyrouter: {} },
            nano_banana_2_lite: { toapis: {}, gemini: {}, wavespeed: { model: "google/nano-banana-2-lite/edit" }, openrouter: {}, comfyrouter: {}, oxen: {} },
            nano_banana_pro: { toapis: {}, gemini: {}, fal: { model: "fal-ai/nano-banana-pro/edit", options: { aspect_ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] } }, replicate: {}, wavespeed: { model: "google/nano-banana-pro/edit" }, openrouter: {}, comfyrouter: {}, oxen: {} },
            seedream_4_5: { magnific: { model: "text-to-image/seedream-v4-5-edit" } },
            seedream_5_lite: { toapis: {}, ark: {}, fal: { model: "fal-ai/bytedance/seedream/v5/lite/edit", options: { sizing: "image_size", pixels: [3686400, 16777216] } }, replicate: {}, wavespeed: { model: "bytedance/seedream-v5.0-lite/edit" }, openrouter: {}, comfyrouter: {}, magnific: { model: "text-to-image/seedream-v5-lite-edit" } },
            seedream_5_pro: { toapis: {}, ark: {}, fal: { model: "bytedance/seedream/v5/pro/edit", options: { sizing: "image_size", pixels: [1048576, 4194304] } }, wavespeed: { model: "bytedance/seedream-v5.0-pro/edit" }, openrouter: {}, comfyrouter: {}, oxen: {}, magnific: { model: "text-to-image/seedream-v5-pro-edit" } },
            // Seedream 5.5 (early access): ModelArk alone, up to ten pictures for a new image as for an edit
            seedream_5_5: { ark: {} },
            qwen_image_edit: { toapis: {}, comfyrouter: {}, oxen: {}, wavespeed: {} },
            qwen_image_2_1: { oxen: {} },
            hy_image_3_5: { comfypartner: {} },
            grok_imagine: { fal: { model: "xai/grok-imagine-image/v2.0/edit" }, openrouter: {}, oxen: { model: "xai-grok-imagine-image-edit" } },
            // P-H3-Image on WaveSpeed: the text-to-image route takes no picture, the edit route up to nine
            p_h3_image: { wavespeed: { model: "wavespeed-ai/p-h3-image/edit" } },
            // Krea 3: fal's and WaveSpeed's text routes take no picture, their edit routes up to eight; the others' one route does
            krea_3: { fal: { model: "krea/v3/edit" }, wavespeed: { model: "krea/v3/edit" }, replicate: {}, comfycloud: {}, comfyrouter: {}, oxen: {} },
        };
        // the text shapes that make a new image from the prompt alone (26f's "None" row): text-only or inpaint-only
        // models, a single-picture edit field, a Comfy Router dialect with no input picture, Reve (its edit cap unread)
        const TAKES_NONE = {
            flux1_fill: ["bfl", "fal", "replicate", "wavespeed"], ideogram_4: ["fal", "comfyrouter", "oxen"], krea_2: ["fal", "openrouter", "comfyrouter", "oxen"],
            recraft_v4: ["fal", "openrouter"], z_image: ["fal"], z_image_turbo: ["fal", "oxen", "magnific"], mystic: ["magnific"], reve: ["wavespeed"],
            qwen_image_edit: ["fal", "replicate"], grok_imagine: ["comfyrouter"], ideogram_4_5: ["replicate", "wavespeed", "comfyrouter"],
            // Comfy Cloud's text-to-image graphs (item 35 V6 step 5): a template that takes no picture
            cloud_anima_base: ["comfycloud"], cloud_anima_preview: ["comfycloud"], cloud_flux2_klein_9b: ["comfycloud"], cloud_ideogram_4: ["comfycloud"],
            cloud_krea_2_turbo: ["comfycloud"], cloud_mage_flow: ["comfycloud"], cloud_qwen_image_2_1_edit: ["comfycloud"], cloud_z_image_turbo: ["comfycloud"],
            cloud_p_h3_image: ["comfycloud"], cloud_moss_image_edit: ["comfycloud"],
            // MiniMax's text endpoint takes no pictures (its edit endpoint up to 16)
            minimax_h3_image: ["minimax"],
        };
        const NULLS = { max: null, field: null, model: null, options: null, name: null };
        const list = await recipes.list(RECIPES);
        const wrong = [], seen = new Set(), none = [];
        let withRefs = 0, withText = 0;
        for (const r of list.filter((x) => x.kind === "provider" && x.source === "builtin")) {
            for (const [pid, v] of Object.entries(r.providers)) {
                const name = `${r.id}/${pid}`;
                const want = TEXT_REFS[r.id] && TEXT_REFS[r.id][pid];
                if (want) seen.add(name);
                if (!v.text) { if (want) wrong.push(`${name}: in the table, but the variant has no text shape`); continue; }
                withText++;
                if (want) {
                    withRefs++;
                    if (!eq(v.text.refs, { ...NULLS, ...want })) wrong.push(`${name}: text.refs ${short(v.text.refs)}, not ${short({ ...NULLS, ...want })}`);
                } else {
                    if (v.text.refs !== null) wrong.push(`${name}: text.refs ${short(v.text.refs)}, not null (takes none)`);
                    if (!(TAKES_NONE[r.id] || []).includes(pid)) none.push(name);
                }
            }
        }
        const stale = Object.entries(TEXT_REFS).flatMap(([id, rows]) => Object.keys(rows).map((pid) => `${id}/${pid}`)).filter((n) => !seen.has(n));
        check(`every shipped variant with a text shape carries the table's text.refs, normalised (${withRefs} take references of ${withText})`, !wrong.length && withRefs === 136, wrong.slice(0, 5).join(" | ") || `${withRefs} with text.refs`);
        check("every row of the table names a shipped provider variant", !stale.length, stale.join(", "));
        check("every text shape without text.refs is on the takes-none list", !none.length, none.join(", "));
        const noneStale = Object.entries(TAKES_NONE).flatMap(([id, pids]) => pids.map((pid) => `${id}/${pid}`)).filter((n) => { const [id, pid] = n.split("/"); const r = list.find((x) => x.id === id); return !r || !r.providers[pid] || !r.providers[pid].text || r.providers[pid].text.refs !== null; });
        check("every takes-none entry names a shipped text shape without text.refs", !noneStale.length, noneStale.join(", "));

        // the routes the table names: the variant's own edit model (an id the edit runs already use), another route
        // than the text one, on Magnific a route that takes references; options only where the table sets them
        const magnific = require(path.join(ROOT, "electron", "main", "providers", "magnific.js"));
        const routeBad = [];
        let routes = 0;
        for (const [id, rows] of Object.entries(TEXT_REFS)) for (const [pid, want] of Object.entries(rows)) {
            if (!want.model) continue;
            routes++;
            const r = list.find((x) => x.id === id), v = r && r.providers[pid];
            if (!v) continue;
            if (want.model !== v.model) routeBad.push(`${id}/${pid}: ${want.model} is not the variant's edit model ${v.model}`);
            if (v.text && want.model === v.text.model) routeBad.push(`${id}/${pid}: ${want.model} is the text route itself`);
            if (pid === "fal" && !/\/edit(-image)?$/.test(want.model)) routeBad.push(`${id}/${pid}: ${want.model} is no fal /edit route`);
            if (pid === "wavespeed" && !/(?:^|[/-])edit(?:[/-]|$)/.test(want.model)) routeBad.push(`${id}/${pid}: ${want.model} is no WaveSpeed edit route`);
            if (pid === "magnific") {
                const R = magnific._routes[want.model];
                if (!R || !R.refs) routeBad.push(`${id}/${pid}: ${want.model} is ${R ? "a Magnific route without refs" : "no Magnific route"}`);
            }
        }
        check(`every route the table names (${routes}) is the variant's own edit model, not its text route (fal /edit, WaveSpeed edit, a Magnific route with refs)`, !routeBad.length && routes >= 20, routeBad.join(" | "));
        const magBad = Object.entries(TEXT_REFS).filter(([, rows]) => rows.magnific).map(([id, rows]) => [id, rows.magnific.model || list.find((x) => x.id === id).providers.magnific.text.model]).filter(([, m]) => !(magnific._routes[m] && magnific._routes[m].refs)).map(([id, m]) => `${id}: ${m}`);
        check("every Magnific row sends references through a route that takes them (refs: true)", !magBad.length, magBad.join(", "));

        // recipes._normalize of hand-made variants
        const warn = console.warn;
        const warned = [];
        console.warn = (...a) => warned.push(a.join(" "));
        const textRefs = (refs) => {
            const before = warned.length;
            const r = recipes._normalize({ id: "t26f", kind: "provider", providers: { fal: { model: "fal-ai/x/edit", input: "edit", text: refs === undefined ? {} : { refs } } } });
            return { refs: r.providers.fal.text.refs, warnings: warned.slice(before) };
        };
        try {
            let x = textRefs(true);
            check("text.refs true: every field null, no warning", eq(x.refs, NULLS) && !x.warnings.length, short(x));
            x = textRefs(false);
            check("text.refs false: null (the prompt alone), no warning", x.refs === null && !x.warnings.length, short(x));
            x = textRefs(undefined);
            check("text.refs absent: null, no warning", x.refs === null && !x.warnings.length, short(x));
            x = textRefs(null);
            check("text.refs null: null, no warning", x.refs === null && !x.warnings.length, short(x));
            x = textRefs({});
            check("text.refs {}: every field null, no warning", eq(x.refs, NULLS) && !x.warnings.length, short(x));
            x = textRefs({ max: 0 });
            check("text.refs { max: 0 }: max null and a warning naming the recipe and the field", eq(x.refs, NULLS) && x.warnings.length === 1 && /t26f\/fal/.test(x.warnings[0]) && /text\.refs\.max/.test(x.warnings[0]), short(x));
            x = textRefs({ max: 2.5 });
            const x2 = textRefs({ max: "3" });
            check("text.refs max 2.5 or \"3\": max null and a warning (a whole number above 0 only)", eq(x.refs, NULLS) && x.warnings.length === 1 && eq(x2.refs, NULLS) && x2.warnings.length === 1, short({ x, x2 }));
            x = textRefs({ name: "x" });
            check("text.refs { name: \"x\" }: name null and a warning (no {n})", eq(x.refs, NULLS) && x.warnings.length === 1 && /text\.refs\.name/.test(x.warnings[0]), short(x));
            x = textRefs({ name: "@img{n}" });
            check("text.refs { name: \"@img{n}\" }: name null and a warning (checked with validRefName)", eq(x.refs, NULLS) && x.warnings.length === 1, short(x));
            const good = { name: "Image {n}", max: 3, model: "m/edit", options: { sizing: "image_size" }, field: "images" };
            x = textRefs(good);
            check("text.refs with every field valid is kept as it is, no warning", eq(x.refs, { max: 3, field: "images", model: "m/edit", options: { sizing: "image_size" }, name: "Image {n}" }) && !x.warnings.length, short(x));
            x = textRefs({ model: "  m/edit  ", field: " images " });
            check("text.refs model and field are trimmed", x.refs && x.refs.model === "m/edit" && x.refs.field === "images" && !x.warnings.length, short(x));
            x = textRefs({ model: "", field: 3, options: [1], name: "Image {n}", max: 2 });
            check("text.refs: an empty model, a number as field, an array as options each null with a warning; the valid fields kept", eq(x.refs, { ...NULLS, name: "Image {n}", max: 2 }) && x.warnings.length === 3, short(x));
            x = textRefs("yes");
            check("text.refs a string: null and a warning", x.refs === null && x.warnings.length === 1 && /t26f\/fal/.test(x.warnings[0]) && /text\.refs/.test(x.warnings[0]), short(x));
            x = textRefs(4);
            const x3 = textRefs(["a"]);
            check("text.refs a number or an array: null and a warning", x.refs === null && x.warnings.length === 1 && x3.refs === null && x3.warnings.length === 1, short({ x, x3 }));
            const off = recipes._normalize({ id: "t26f", kind: "provider", providers: { fal: { model: "fal-ai/x/edit", text: false }, comfycloud: { model: "m", text: { refs: true } } } });
            check("no text shape, no text.refs: text false, or a provider without a text route (Comfy Cloud)", off.providers.fal.text === null && off.providers.comfycloud.text === null, short({ fal: off.providers.fal.text, comfycloud: off.providers.comfycloud.text }));
            const up = recipes._normalize({ id: "u26f", kind: "provider", task: "upscale", providers: { fal: { model: "m", text: { refs: true } } } });
            check("an upscaler has no text shape, so no text.refs", up.providers.fal.text === null, short(up.providers.fal.text));
        } finally {
            console.warn = warn;
        }
    });

    // ---- 5. recipe <-> graph (item 35 V2, docs/PLAN_COMFY_VIEW.md §2.3) ------------------
    await section("5. a ComfyUI recipe as a graph and back", async () => {
        const comfy = (await recipes.list(RECIPES)).filter((r) => r.kind !== "provider" && r.source === "builtin");
        check("the shipped ComfyUI recipes are there", comfy.length >= 3, comfy.map((r) => r.id).join(", "));
        for (const r of comfy) {
            const p = recipes.toPrompt(r);
            const c = p[r.canvas].inputs;
            const res = r.result.split(":");
            const wiredResult = eq(c[r.mode === "api" ? "result" : "result_local"], [res[0], +res[1]]);
            const wiredSettings = (r.settings || []).every((s) => eq(p[s.node].inputs[s.input], [r.canvas, 12 + s.index]));
            check(`${r.id}: toPrompt wires the result and every Settings row to the canvas node`, wiredResult && wiredSettings && !eq(p, r.prompt), short(c));
            const back = recipes.fromPrompt(p, {}, { file: "graph", date: "2026-10-03" }, r);
            const sameNeeds = eq([...back.needs].sort(), [...new Set(Object.values(r.prompt).map((n) => n.class_type))].sort());
            check(`${r.id}: fromPrompt(toPrompt(r), {}, meta, r) gives the prompt, the Settings rows, the result, the mode and the canvas back`,
                eq(back.prompt, r.prompt) && eq(back.settings, r.settings) && back.result === r.result && back.mode === r.mode && back.canvas === r.canvas && sameNeeds,
                eq(back.prompt, r.prompt) ? short({ settings: back.settings, was: r.settings }) : short({ prompt: back.prompt }));
            check(`${r.id}: toPrompt leaves the recipe as it was`, !Object.values(r.prompt[r.canvas].inputs).some(Array.isArray));
        }
        const r0 = comfy[0];
        const noBase = recipes.fromPrompt(recipes.toPrompt(r0), {}, { file: "graph", date: "2026-10-03" });
        check("without the recipe it came from, the rows keep their slots and the canvas node its four parameters",
            eq(noBase.settings.map((s) => [s.index, s.node, s.input]), r0.settings.map((s) => [s.index, s.node, s.input])) && eq(noBase.prompt[r0.canvas].inputs, r0.prompt[r0.canvas].inputs), short(noBase.settings));
        check("toPrompt refuses a provider recipe and a result that names no node",
            !!(await thrown(() => recipes.toPrompt({ kind: "provider", id: "p" }))) && !!(await thrown(() => recipes.toPrompt({ ...r0, result: "nope:0" }))));

        // the Realism Pass (docs/PLAN_0_1_42.md R1): in the sweep above, and what the sweep does not look at
        const realism = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "realism.js")).href);
        const rp = comfy.find((r) => r.id === realism.RECIPE_ID);
        check("the Realism Pass is a shipped ComfyUI recipe, swept above", !!rp && rp.kind === "comfy" && rp.mode === "local", short(rp && { id: rp.id, kind: rp.kind, mode: rp.mode }));
        if (rp) {
            check("its name is exactly realism.LABEL (the user: the recipe says \"Realism Pass (Windows only, RTX only)\")", rp.name === realism.LABEL && realism.LABEL === "Realism Pass (Windows only, RTX only)", short({ name: rp.name, label: realism.LABEL }));
            check("normalize keeps its task \"pass\" and gives it no upscale factor", rp.task === "pass" && rp.factor === undefined, short({ task: rp.task, factor: rp.factor }));
            const classes = [...new Set(Object.values(rp.prompt).map((n) => n.class_type))].sort();
            check("its needs list exactly the node types of its prompt (the pack's two nodes among them)", eq([...(rp.needs || [])].sort(), classes) && realism.NODES.every((n) => classes.includes(n)), short({ needs: rp.needs, classes }));
            const p = recipes.toPrompt(rp);
            const row = (rp.settings || [])[0] || {};
            check("toPrompt: result_local on rp_enhance:0, the DLSS model preset row on the canvas node's first setting output, the template's other values kept",
                eq(p[rp.canvas].inputs.result_local, ["rp_enhance", 0]) && p[rp.canvas].inputs.result === undefined && rp.settings.length === 1
                && row.node === "rp_settings" && row.input === "dlss_model_preset" && eq(p.rp_settings.inputs.dlss_model_preset, [rp.canvas, 12 + row.index])
                && p.rp_settings.inputs.nr_style === rp.prompt.rp_settings.inputs.nr_style && eq(p.rp_enhance.inputs, rp.prompt.rp_enhance.inputs),
                short({ canvas: p[rp.canvas].inputs, settings: p.rp_settings.inputs }));
            const back = recipes.fromPrompt(p, {}, { file: "graph", date: "2026-10-04" }, rp);
            check("fromPrompt with the recipe as base: the row's label and spec (Default, J, K, L, M) and the stored L come back",
                eq(back.settings, rp.settings) && row.label === "DLSS model preset" && eq(row.spec && row.spec[0], realism.MODEL_PRESETS) && back.prompt.rp_settings.inputs.dlss_model_preset === "L",
                short({ settings: back.settings, preset: back.prompt.rp_settings.inputs.dlss_model_preset }));
            // the fields a graph does not hold come back from the recipe the window opened (GRAPH_KEEPS): task and presets too
            const workflow = { nodes: [{ id: 1, type: "InpaintCanvas" }], links: [], extra: {} };
            const over = recipes.fromGraph({ output: p, workflow, objectInfo: {}, base: rp, date: "2026-10-04" });
            const fresh = recipes.fromGraph({ output: p, workflow, objectInfo: {}, base: rp, name: "My pass", ids: [rp.id], date: "2026-10-04" });
            check("Save to recipe keeps its id, its name, its task \"pass\", its presets and its row",
                over.id === rp.id && over.name === realism.LABEL && over.task === "pass" && eq(over.presets, rp.presets) && eq(over.settings, rp.settings),
                short({ id: over.id, task: over.task, presets: over.presets }));
            check("Save as new recipe keeps the task and the presets under its own id", fresh.id === "my_pass" && fresh.task === "pass" && eq(fresh.presets, rp.presets), short({ id: fresh.id, task: fresh.task, presets: fresh.presets }));
            check("Save to recipe with its own graph: presets L and M in that order and task \"pass\", as the file ships them",
                eq(over.presets && over.presets.map((q) => q.name), ["L", "M"]) && eq(over.presets, rawFile("realism_pass.json").presets) && over.task === "pass",
                short({ task: over.task, presets: over.presets }));

            // a graph that no longer holds the pack's settings node (rp_settings gone, the pass swapped for a plain
            // scale): the row it drove is gone with it, so the presets have nothing left to set and the task is no pass
            const noPass = recipes.toPrompt(rp);
            delete noPass.rp_settings;
            noPass.rp_enhance = { class_type: "ImageScaleBy", inputs: { image: ["rp_one", 0], upscale_method: "lanczos", scale_by: 1 } };
            const plain = recipes.fromGraph({ output: noPass, workflow, objectInfo: {}, base: rp, name: "My scale", ids: [rp.id], date: "2026-10-04" });
            check("Save as new recipe from the Realism Pass with a graph without DLSS5Settings and without the preset row: no presets field, no task \"pass\"",
                plain.id === "my_scale" && !Object.prototype.hasOwnProperty.call(plain, "presets") && plain.task === undefined && plain.settings.length === 0
                && !Object.values(plain.prompt).some((n) => n.class_type === "DLSS5Settings"),
                short({ id: plain.id, task: plain.task, presets: plain.presets, settings: plain.settings }));
            const plainOver = recipes.fromGraph({ output: noPass, workflow, objectInfo: {}, base: rp, date: "2026-10-04" });
            check("Save to recipe of the Realism Pass with that graph: its id and name stay, the presets field and task \"pass\" do not",
                plainOver.id === rp.id && plainOver.name === realism.LABEL && !Object.prototype.hasOwnProperty.call(plainOver, "presets") && plainOver.task === undefined,
                short({ id: plainOver.id, task: plainOver.task, presets: plainOver.presets }));
            const plainBack = recipes._normalize(JSON.parse(JSON.stringify(plain)));
            check("that copy reads back through normalize as an ordinary ComfyUI recipe (no pass, no presets)", plainBack.task !== "pass" && plainBack.presets === undefined, short({ task: plainBack.task, presets: plainBack.presets }));

            // the settings node kept but its preset row unwired (the value typed into the node): the task stays, the presets go
            const unwired = recipes.toPrompt(rp);
            unwired.rp_settings.inputs.dlss_model_preset = "M";
            const keepTask = recipes.fromGraph({ output: unwired, workflow, objectInfo: {}, base: rp, name: "Fixed M", ids: [rp.id], date: "2026-10-04" });
            check("a graph that keeps DLSS5Settings but not the preset row: task \"pass\" kept, no presets field",
                keepTask.task === "pass" && !Object.prototype.hasOwnProperty.call(keepTask, "presets") && keepTask.settings.length === 0 && keepTask.prompt.rp_settings.inputs.dlss_model_preset === "M",
                short({ task: keepTask.task, presets: keepTask.presets, settings: keepTask.settings }));

            // a base whose presets name one row the graph keeps and one it has not: only the kept value stays, and a
            // preset left with no value at all is dropped
            const mixedBase = { ...rp, presets: [
                { name: "L", values: { "rp_settings:dlss_model_preset": "L", "rp_settings:nr_intensity": 0.5 } },
                { name: "Gone", values: { "rp_settings:nr_style": "Default", "nowhere:x": 1 } },
                { name: "M", values: { "rp_settings:dlss_model_preset": "M" } },
            ] };
            const mixed = recipes.fromGraph({ output: recipes.toPrompt(mixedBase), workflow, objectInfo: {}, base: mixedBase, date: "2026-10-04" });
            check("a base preset with one kept row and one dropped row keeps only the kept value; a preset with no kept row is dropped",
                eq(mixed.presets, [{ name: "L", values: { "rp_settings:dlss_model_preset": "L" } }, { name: "M", values: { "rp_settings:dlss_model_preset": "M" } }]) && mixed.task === "pass",
                short(mixed.presets));
            check("fromGraph leaves the base's presets as they were", mixedBase.presets[0].values["rp_settings:nr_intensity"] === 0.5 && mixedBase.presets.length === 3, short(mixedBase.presets));

            // a node id holding colons (a flattened subgraph's "57:12"): its preset key "57:12:<input>" matches its row
            const sub = JSON.parse(JSON.stringify(rp.prompt));
            sub["57:12"] = sub.rp_settings;
            delete sub.rp_settings;
            sub.rp_enhance.inputs.settings = ["57:12", 0];
            const subBase = { ...rp, prompt: sub, settings: rp.settings.map((s) => ({ ...s, node: "57:12" })), presets: [{ name: "L", values: { "57:12:dlss_model_preset": "L" } }, { name: "M", values: { "57:12:dlss_model_preset": "M" } }] };
            const subSaved = recipes.fromGraph({ output: recipes.toPrompt(subBase), workflow, objectInfo: {}, base: subBase, date: "2026-10-04" });
            check("a preset key on a node id with colons (\"57:12:dlss_model_preset\") is kept for the row of node \"57:12\"",
                eq(subSaved.presets, subBase.presets) && subSaved.settings.length === 1 && subSaved.settings[0].node === "57:12" && subSaved.task === "pass",
                short({ presets: subSaved.presets, settings: subSaved.settings }));
            await recipes.save(over);
            const listed = (await recipes.list(RECIPES)).find((r) => r.id === rp.id);
            check("the saved copy, read back through list(), is still a pass with its presets and its row", !!listed && listed.source === "user" && listed.task === "pass" && eq(listed.presets, rp.presets) && eq(listed.settings, rp.settings), short(listed && { source: listed.source, task: listed.task, presets: listed.presets }));
            await recipes.remove(rp.id);
            const builtinAgain = (await recipes.list(RECIPES)).find((r) => r.id === rp.id);
            check("removing the copy brings the shipped one back", !!builtinAgain && builtinAgain.source === "builtin");
        }

        // RTX Video Super Resolution (docs/PLAN_0_1_42.md U1): in the sweep above; its factor and limits are fields a graph
        // does not hold, so Save to recipe keeps them from the recipe the window opened (GRAPH_KEEPS)
        const rv = comfy.find((r) => r.id === "rtx_vsr_local");
        check("RTX Video Super Resolution is a shipped ComfyUI upscaler, swept above", !!rv && rv.task === "upscale" && rv.mode === "local" && rv.kind === "comfy", short(rv && { id: rv.id, task: rv.task, kind: rv.kind }));
        if (rv) {
            const workflow = { nodes: [{ id: 1, type: "InpaintCanvas" }], links: [], extra: {} };
            const date = "2026-10-04";
            const p = recipes.toPrompt(rv);
            check("toPrompt wires Quality to the canvas node's first setting output and leaves the factor's input a value of the graph",
                eq(p.rtx.inputs.quality, [rv.canvas, 13]) && p.rtx.inputs["resize_type.scale"] === 2 && p.rtx.inputs.resize_type === "scale by multiplier", short(p.rtx.inputs));
            const over = recipes.fromGraph({ output: p, workflow, objectInfo: {}, base: rv, date });
            const fresh = recipes.fromGraph({ output: p, workflow, objectInfo: {}, base: rv, name: "My RTX", ids: [rv.id], date });
            check("Save to recipe keeps its id, its task, its factor with the input and its limits",
                over.id === rv.id && over.task === "upscale" && eq(over.factor, rv.factor) && eq(over.limits, rv.limits) && over.factor.input === "rtx|resize_type.scale" && eq(over.limits, { min: 64, max: 4096, out: 8192 }),
                short({ id: over.id, task: over.task, factor: over.factor, limits: over.limits }));
            check("Save as new recipe keeps the factor and the limits under its own id", fresh.id === "my_rtx" && eq(fresh.factor, rv.factor) && eq(fresh.limits, rv.limits), short({ id: fresh.id, factor: fresh.factor, limits: fresh.limits }));
            const warned = [];
            const w0 = console.warn;
            console.warn = (...a) => { warned.push(a.join(" ")); };
            try {
                const back = recipes._normalize(JSON.parse(JSON.stringify(over)));
                check("the saved copy reads back through normalize with the factor unfixed and the limits as they were",
                    back.factor.fixed === false && back.factor.input === "rtx|resize_type.scale" && back.factor.default === 2 && eq(back.limits, rv.limits) && !warned.length, short({ factor: back.factor, limits: back.limits, warned }));
                // a graph saved with the RTX node swapped for a plain scale: the kept factor names a node no longer there,
                // so it reads back fixed (the stitch fits the answer anyway) and says so
                const swapped = recipes.toPrompt(rv);
                delete swapped.rtx;
                swapped.up = { class_type: "ImageScaleBy", inputs: { image: ["img0", 0], upscale_method: "lanczos", scale_by: 2 } };
                swapped[rv.canvas].inputs.result_local = ["up", 0];
                const gone = recipes.fromGraph({ output: swapped, workflow, objectInfo: {}, base: rv, date });
                const goneBack = recipes._normalize(JSON.parse(JSON.stringify(gone)));
                check("a graph saved without the factor's node: the factor reads back fixed, with a warning that names its input",
                    gone.result === "up:0" && goneBack.factor.fixed === true && goneBack.factor.input === undefined && warned.length === 1 && warned[0].includes("rtx|resize_type.scale"),
                    short({ result: gone.result, factor: goneBack.factor, warned }));
            } finally { console.warn = w0; }
            const um = comfy.find((r) => r.id === "upscale_model_local");
            const umSaved = um && recipes.fromGraph({ output: recipes.toPrompt(um), workflow, objectInfo: {}, base: um, date });
            check("the upscale model's Save to recipe keeps its fixed factor and its one limit (2048 px, U2)", !!umSaved && umSaved.factor && umSaved.factor.fixed === true && eq(umSaved.limits, { picture: 2048 }), short(umSaved && { factor: umSaved.factor, limits: umSaved.limits }));
            const klein = comfy.find((r) => r.id === "flux2_klein_local");
            const kSaved = klein && recipes.fromGraph({ output: recipes.toPrompt(klein), workflow, objectInfo: {}, base: klein, date });
            check("an edit recipe's Save to recipe gets no factor and no limits", !!kSaved && !Object.prototype.hasOwnProperty.call(kSaved, "factor") && !Object.prototype.hasOwnProperty.call(kSaved, "limits"), short(kSaved && { factor: kSaved.factor, limits: kSaved.limits }));
            await recipes.save(over);
            const listed = (await recipes.list(RECIPES)).find((r) => r.id === rv.id);
            check("the saved copy, read back through list(), keeps the unfixed factor and the limits", !!listed && listed.source === "user" && eq(listed.factor, rv.factor) && eq(listed.limits, rv.limits), short(listed && { source: listed.source, factor: listed.factor, limits: listed.limits }));
            await recipes.remove(rv.id);
            const builtin = (await recipes.list(RECIPES)).find((r) => r.id === rv.id);
            check("removing the copy brings the shipped one back", !!builtin && builtin.source === "builtin");
        }
    });

    // ---- 6. a graph from ComfyUI's page as a recipe (item 35 V3) --------------------------
    await section("6. the page's graph saved as a recipe", async () => {
        const all = await recipes.list(RECIPES);
        const base = all.find((r) => r.id === "flux2_klein_local");
        const output = recipes.toPrompt(base);
        output.sigmas.inputs.denoise = 0.9;   // a change made in the page
        const workflow = { nodes: [{ id: 1, type: "InpaintCanvas" }], links: [], extra: {} };
        const date = "2026-10-03";
        const over = recipes.fromGraph({ output, workflow, objectInfo: {}, base, date });
        check("Save to recipe: the same id and name, the change in the graph, the rows and their labels kept, the UI graph stored",
            over.id === base.id && over.name === base.name && over.prompt.sigmas.inputs.denoise === 0.9 && eq(over.settings, base.settings) && eq(over.workflow, workflow) && over.description === base.description && eq(over.models, base.models),
            short({ id: over.id, denoise: over.prompt.sigmas.inputs.denoise, workflow: !!over.workflow }));
        const ids = all.map((r) => r.id);
        const fresh = recipes.fromGraph({ output, workflow, objectInfo: {}, base, name: "Flux.2 Klein (ComfyUI)", ids, date });
        const again = recipes.fromGraph({ output, workflow, objectInfo: {}, base, name: "My graph", ids: [...ids, "my_graph"], date });
        check("Save as new recipe: a fresh id from the name, never a shipped one's, a description of its own",
            !ids.includes(fresh.id) && fresh.name === "Flux.2 Klein (ComfyUI)" && /Saved from ComfyUI on 2026-10-03/.test(fresh.description) && again.id === "my_graph_2", short({ fresh: fresh.id, again: again.id }));
        const noWf = recipes.fromGraph({ output, workflow: { nodes: "x" }, objectInfo: {}, base, date });
        check("a UI graph without nodes and links is not stored", noWf.workflow === undefined);
        const noCanvas = JSON.parse(JSON.stringify(output));
        delete noCanvas[base.canvas];
        check("a graph without an Inpaint Canvas node, an answer that is no prompt, a save with no recipe held, an empty name: refused",
            /no Inpaint Canvas node/.test(await thrown(() => recipes.fromGraph({ output: noCanvas, workflow, base, date })) || "")
            && /no graph Scumble can read/.test(await thrown(() => recipes.fromGraph({ output: { a: 1 }, workflow, base, date })) || "")
            && /holds no recipe/.test(await thrown(() => recipes.fromGraph({ output, workflow, base: null, date })) || "")
            && /needs a name/.test(await thrown(() => recipes.fromGraph({ output, workflow, base, name: "  ", ids, date })) || ""));
        await recipes.save(over);
        const listed = (await recipes.list(RECIPES)).find((r) => r.id === base.id);
        check("the saved copy of a shipped recipe stands in for it and keeps its graph", listed && listed.source === "user" && listed.prompt.sigmas.inputs.denoise === 0.9 && eq(listed.workflow, workflow), short(listed && listed.source));
        await recipes.remove(base.id);
        const back = (await recipes.list(RECIPES)).find((r) => r.id === base.id);
        check("removing the copy brings the shipped recipe back", back && back.source === "builtin" && back.prompt.sigmas.inputs.denoise !== 0.9);
    });

    // ---- 7. the cloud form: a ComfyUI recipe without the node (item 35 V5) ---------------
    await section("7. detach: a ComfyUI recipe without the Inpaint Canvas node", async () => {
        const comfy = (await recipes.list(RECIPES)).filter((r) => r.kind !== "provider" && r.source === "builtin");
        // refused: the Realism Pass runs on the user's own ComfyUI only (the user: "nein, kein anderes comfy cloud rezept")
        // `notes`: what detach says about the copy, in order (RTX Video Super Resolution's copy has no factor row: its
        // graph's own 2× runs, docs/PLAN_0_1_42.md U1)
        const want = { flux2_klein_local: { pictures: 4, values: ["prompt", "seed"] }, flux3_klein_local: { pictures: 4, values: ["prompt", "seed"] }, qwen_image_edit_2_1_local: { pictures: 10, values: ["negative", "prompt", "seed"] }, qwen_image_edit_2_1_turbo_local: { pictures: 10, values: ["negative", "prompt", "seed"] }, relight_qwen_local: { pictures: 1, values: ["negative", "prompt", "seed"] }, upscale_model_local: { pictures: 1, values: [] },
            moss_image_local: { pictures: 1, values: ["negative", "prompt", "seed"] },
            moss_image_edit_local: { pictures: 4, values: ["negative", "prompt", "seed"] },
            fibo2_edit_turbo_local: { pictures: 4, values: ["prompt", "seed"] },
            p_h3_image_local: { pictures: 8, values: ["prompt", "seed"] },
            rtx_vsr_local: { pictures: 1, values: [], notes: [/^the Comfy Cloud copy runs at the factor its graph holds \(2×\); change it in its graph$/] }, realism_pass: { refused: /Cloud copy/ } };
        const unlisted = comfy.map((r) => r.id).filter((id) => !want[id]);
        check("every shipped ComfyUI recipe has its row in the table", !unlisted.length, unlisted.join(", "));
        const realism = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "realism.js")).href);
        for (const r of comfy) {
            const w0 = want[r.id] || {};
            if (w0.refused) {
                const before = JSON.stringify(r);
                const err = await thrown(() => recipes.detach(r));
                check(`${r.id}: detach refuses it (${w0.refused}), in words that hold the label (${realism.LABEL}), and leaves the recipe as it was`,
                    !!err && w0.refused.test(err) && err.includes(realism.LABEL) && JSON.stringify(r) === before, err);
                const copy = JSON.parse(JSON.stringify(r));
                delete copy.task;
                check(`${r.id}: the refusal goes by task "pass": the same graph without it detaches`, !(await thrown(() => recipes.detach(copy))));
                continue;
            }
            const { recipe: d, notes, needs } = recipes.detach(r);
            const v = d.providers.comfycloud;
            const g = v.options.graph;
            const dangling = [];
            for (const [id, n] of Object.entries(g)) for (const [k, x] of Object.entries(n.inputs || {})) if (Array.isArray(x) && !g[x[0]]) dangling.push(`${id}.${k}`);
            const pics = Object.values(g).filter((n) => n.class_type === "LoadImage" && /^scumble:picture:\d+$/.test((n._meta || {}).title || ""));
            const save = Object.values(g).find((n) => n.class_type === "SaveImage");
            const res = r.result.split(":");
            const w = want[r.id] || {};
            const wantNotes = w.notes || [];
            const notesOk = notes.length === wantNotes.length && wantNotes.every((re, i) => re.test(notes[i]));
            check(`${r.id}: no Inpaint Canvas node and nothing that points at it, a SaveImage on the result`,
                !needs.includes("InpaintCanvas") && !Object.values(g).some((n) => n.class_type === "InpaintCanvas" || n.class_type === "ImageFromBatch") && !dangling.length && save && save.inputs.images[0] === res[0] && save.inputs.images[1] === +res[1],
                short({ dangling, needs }));
            check(`${r.id}: its pictures as LoadImage nodes (${w.pictures}), the run's values (${(w.values || []).join(", ") || "none"}), no mask, ${wantNotes.length ? "its note" : "no note"}`,
                v.options.pictures === w.pictures && pics.length === w.pictures && eq(Object.keys(v.options.values).sort(), w.values) && v.options.mask === false && v.input === "edit" && notesOk,
                short({ pictures: v.options.pictures, values: v.options.values, notes }));
            const n = recipes._normalize(JSON.parse(JSON.stringify(d)));
            if (r.task === "upscale") {
                // the copy has no factor row: the graph runs at what it holds (the RTX node's 2×, an upscale model's own)
                check(`${r.id}: the Comfy Cloud copy's factor is fixed, as file and as normalized`,
                    eq(d.factor, { fixed: true }) && n.task === "upscale" && n.providers.comfycloud.factor.fixed === true, short({ file: d.factor, normalized: n.providers.comfycloud.factor }));
                const rtx = Object.values(g).find((x) => x.class_type === "RTXVideoSuperResolution");
                if (r.id === "rtx_vsr_local") {
                    check(`${r.id}: its graph keeps the RTX node with its own 2× and ULTRA, Quality a row of the copy`,
                        !!rtx && rtx.inputs["resize_type.scale"] === 2 && rtx.inputs.resize_type === "scale by multiplier" && rtx.inputs.quality === "ULTRA" && eq(v.settings.map((s) => s.key), ["rtx|quality"]),
                        short({ rtx, rows: v.settings.map((s) => s.key) }));
                    check(`${r.id}: detach leaves the recipe's own factor and limits as they were`, r.factor.fixed === false && r.factor.input === "rtx|resize_type.scale" && eq(r.limits, { min: 64, max: 4096, out: 8192 }), short({ factor: r.factor, limits: r.limits }));
                }
            }
            // the copy runs without a prompt upsampler (its model is the user's file), so its rows go too
            const upNodes = r.upsampler ? [...r.upsampler.nodes, r.upsampler.switch] : [];
            const own = r.settings.filter((s) => !upNodes.includes(s.node));
            const rowsOk = v.settings.length === own.length && v.settings.every((s, i) => s.key === `${own[i].node}|${own[i].input}` && s.label === own[i].label && s.index === own[i].index);
            const cin = r.prompt[r.canvas].inputs;
            check(`${r.id}: a provider recipe on Comfy Cloud, its Settings rows keyed by node and input, the crop limits from the node`,
                n.kind === "provider" && eq(n.providerIds, ["comfycloud"]) && n.id === r.id + "_cloud" && rowsOk && n.providers.comfycloud.limits.max === (cin.target_size || 2048) && n.providers.comfycloud.limits.step === cin.multiple_of,
                short({ ids: n.providerIds, limits: n.providers.comfycloud.limits, rows: v.settings.map((s) => s.key) }));
            check(`${r.id}: the recipe itself is left as it was`, !!r.prompt[r.canvas] && r.prompt.img0 ? r.prompt.img0.class_type === "ImageFromBatch" : true);
        }
        const base = comfy.find((r) => r.id === "flux2_klein_local");
        const withMask = JSON.parse(JSON.stringify(base));
        withMask.prompt.extra = { class_type: "SetLatentNoiseMask", inputs: { samples: ["noise", 0], mask: [base.canvas, 1] } };
        withMask.prompt.vae_enc = { class_type: "VAEEncode", inputs: { pixels: [base.canvas, 0], vae: ["vae", 0] } };
        const dm = recipes.detach(withMask);
        const gm = dm.recipe.providers.comfycloud.options.graph;
        check("crop_mask becomes LoadImage + ImageToMask (a fill), crop_image used whole the crop alone with a note",
            dm.recipe.providers.comfycloud.input === "fill" && gm[gm.extra.inputs.mask[0]].class_type === "ImageToMask" && gm[gm.vae_enc.inputs.pixels[0]]._meta.title === "scumble:picture:0" && dm.notes.length === 1,
            short({ mask: gm.extra.inputs.mask, pixels: gm.vae_enc.inputs.pixels, notes: dm.notes }));
        const bad = (patch) => { const x = JSON.parse(JSON.stringify(base)); patch(x); return thrown(() => recipes.detach(x)); };
        const e1 = await bad((x) => { x.prompt.st = { class_type: "Stitch", inputs: { info: [x.canvas, 4] } }; });
        const e2 = await bad((x) => { x.prompt.img0.inputs.length = 2; });
        const e3 = await thrown(() => recipes.detach({ kind: "provider", id: "p", providers: {} }));
        check("refused: the stitch_info output, a pick of two pictures at once, a provider recipe",
            /stitch_info/.test(e1 || "") && /takes 2 pictures/.test(e2 || "") && /Only a ComfyUI recipe/.test(e3 || ""), short({ e1, e2, e3 }));
    });

    // ---- 8. a graph made for Comfy Cloud, marked by node titles (item 35 V5c) -------------
    await section("8. Comfy Cloud recipes from marked graphs", async () => {
        const date = "2026-10-03";
        const graph = () => ({
            1: { class_type: "LoadImage", inputs: { image: "cloud.png" }, _meta: { title: "Scumble crop" } },
            2: { class_type: "LoadImage", inputs: { image: "r.png" }, _meta: { title: "scumble picture 2" } },
            3: { class_type: "LoadImage", inputs: { image: "m.png" }, _meta: { title: "Scumble Mask" } },
            4: { class_type: "SetLatentNoiseMask", inputs: { samples: ["7", 0], mask: ["3", 1] } },
            5: { class_type: "CLIPTextEncode", inputs: { text: "old", clip: ["8", 0] }, _meta: { title: "Scumble prompt" } },
            6: { class_type: "KSampler", inputs: { seed: 1, model: ["8", 0], latent_image: ["4", 0] }, _meta: { title: "Scumble seed" } },
            7: { class_type: "VAEEncode", inputs: { pixels: ["1", 0], vae: ["8", 0] } },
            8: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "x.safetensors" } },
            9: { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "a" }, _meta: { title: "Scumble result" } },
            10: { class_type: "PreviewImage", inputs: { images: ["6", 0] } },
        });
        const made = recipes.fromCloudGraph({ output: graph(), workflow: { nodes: [], links: [] }, name: "My cloud graph", ids: ["my_cloud_graph"], date });
        const v = made.providers.comfycloud, g = v.options.graph;
        check("a marked graph: a Comfy Cloud recipe, the pictures retitled and emptied, picture 2 sets the count to 3, the mask a fill",
            made.kind === "provider" && made.id === "my_cloud_graph_2" && v.options.pictures === 3 && v.input === "fill" && g[1]._meta.title === "scumble:picture:0" && g[1].inputs.image === "" && g[2]._meta.title === "scumble:picture:2" && g[3]._meta.title === "scumble:mask" && v.options.save === "9",
            short({ id: made.id, pictures: v.options.pictures, save: v.options.save }));
        check("the mask's MASK output read through ImageToMask of its red channel; the prompt and the seed inputs found",
            g[g[4].inputs.mask[0]].class_type === "ImageToMask" && eq(g[g[4].inputs.mask[0]].inputs, { image: ["3", 0], channel: "red" }) && eq(v.options.values, { prompt: [["5", "text"]], seed: [["6", "seed"]] }),
            short({ mask: g[4].inputs.mask, values: v.options.values }));
        const norm = recipes._normalize(JSON.parse(JSON.stringify(made)));
        check("it normalizes as a provider recipe on comfycloud and keeps the UI graph", eq(norm.providerIds, ["comfycloud"]) && !!v.options.workflow);
        const over = recipes.fromCloudGraph({ output: graph(), base: { ...made, providers: { comfycloud: { ...v, settings: [{ index: 1, key: "8|ckpt_name", label: "Model" }, { index: 2, key: "99|gone", label: "Gone" }] } } }, date });
        check("Save to recipe on a cloud recipe: its id and name, the rows whose node is still there", over.id === made.id && over.name === made.name && eq(over.providers.comfycloud.settings.map((s) => s.key), ["8|ckpt_name"]));
        const bad = async (patch, opts = {}) => { const x = graph(); patch(x); return thrown(() => recipes.fromCloudGraph({ output: x, name: "x", date, ...opts })); };
        const e1 = await bad((x) => { delete x[1]._meta; x[7].inputs.pixels = ["2", 0]; });
        const e2 = await bad((x) => { delete x[9]._meta; x[11] = { class_type: "SaveImage", inputs: { images: ["6", 0] } }; });
        const e3 = await bad((x) => { x[12] = { class_type: "InpaintCanvas", inputs: {} }; });
        const e4 = await bad((x) => { x[5]._meta.title = "Scumble crop"; });
        const e5 = await bad(() => {}, { name: "  " });
        check("refused: no crop, two SaveImage nodes without a result title, the Inpaint Canvas node, a marked node that is no LoadImage, no name",
            /Scumble crop/.test(e1 || "") && /several SaveImage/.test(e2 || "") && /Inpaint Canvas node/.test(e3 || "") && /must be a LoadImage/.test(e4 || "") && /needs a name/.test(e5 || ""), short({ e1, e2, e3, e4, e5 }));
        check("a ComfyUI recipe is no base for a cloud graph", /no Comfy Cloud recipe/.test((await thrown(() => recipes.fromCloudGraph({ output: graph(), base: all0(), date }))) || ""));

        // importFile: an API export and a UI export of Comfy Cloud
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-cloud-import-"));
        try {
            const api = await recipes.importFile(fileOf(dir, "cloud api.json", graph()), null, { builtinDir: RECIPES });
            check("an API export without the canvas node imports as a Comfy Cloud recipe named after the file", api.kind === "provider" && api.name === "cloud api" && api.source === "user" && eq(api.providerIds, ["comfycloud"]) && api.providers.comfycloud.options.pictures === 3, short({ id: api.id, kind: api.kind }));
            const ui = {
                nodes: [
                    { id: 1, type: "LoadImage", title: "Scumble crop", mode: 0, inputs: [], outputs: [{ name: "IMAGE", type: "IMAGE", links: [1] }, { name: "MASK", type: "MASK", links: [] }], widgets_values: ["c.png", "image"] },
                    { id: 2, type: "SaveImage", mode: 0, inputs: [{ name: "images", type: "IMAGE", link: 1 }], outputs: [], widgets_values: ["scumble"] },
                ],
                links: [[1, 1, 0, 2, 0, "IMAGE"]],
            };
            const info = { LoadImage: { input: { required: { image: [["c.png"], { image_upload: true }] } } }, SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING", { default: "ComfyUI" }] } } } };
            const noInfo = await thrown(() => recipes.importFile(fileOf(dir, "cloud ui.json", ui), null, { builtinDir: RECIPES }));
            let asked = 0;
            const viaCloud = await recipes.importFile(fileOf(dir, "cloud ui.json", ui), null, { builtinDir: RECIPES, cloudObjectInfo: async () => { asked++; return info; } });
            const vg = viaCloud.providers.comfycloud.options.graph;
            check("a UI export: refused without a node list, read with Comfy Cloud's when there is one, the UI graph kept",
                /store a Comfy Cloud key/.test(noInfo || "") && asked === 1 && vg[1]._meta.title === "scumble:picture:0" && eq(vg[2].inputs, { filename_prefix: "scumble", images: ["1", 0] }) && !!viaCloud.providers.comfycloud.options.workflow,
                short({ noInfo, graph: vg }));
            const plain = await thrown(() => recipes.importFile(fileOf(dir, "plain.json", { 1: { class_type: "LoadImage", inputs: { image: "a.png" } }, 2: { class_type: "SaveImage", inputs: { images: ["1", 0] } } }), null, { builtinDir: RECIPES }));
            check("a graph with neither the canvas node nor the markers says how to mark it", /Scumble crop/.test(plain || ""), plain);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        function all0() { return JSON.parse(JSON.stringify(rawFile("flux2_klein_local.json"))); }
    });

    // ---- 9. Comfy's image-edit templates saved as they are (item 35 V6: the roles read from the graph) --------
    await section("9. Comfy's image-edit templates without titles", async () => {
        const dir = path.join(ROOT, "tools", "refs", "comfy_templates");
        const info = JSON.parse(fs.readFileSync(path.join(dir, "object_info.json"), "utf8"));
        const names = fs.readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "object_info.json").sort();
        check("the template fixtures are there (tools/template_fixtures.py)", names.length >= 20, `${names.length} templates`);
        const out = {};
        const refused = [];
        let wrongSlot = [];
        for (const n of names) {
            const wf = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
            const flat = recipes.fromWorkflow(wf, info, { file: n, date: "2026-10-03" }, { noCanvas: true }).prompt;
            // the subgraph regression: a picture never lands on a model loader or a size input (slots by name, 2026-10-03)
            for (const [id, node] of Object.entries(flat)) for (const [k, v] of Object.entries(node.inputs || {})) {
                if (Array.isArray(v) && flat[v[0]] && flat[v[0]].class_type === "LoadImage" && /Loader$|EmptyLatentImage/.test(node.class_type)) wrongSlot.push(`${n}: ${node.class_type} ${id}.${k}`);
            }
            try { out[n] = { flat, r: recipes.fromCloudGraph({ output: flat, workflow: wf, name: n, ids: [], date: "2026-10-03", promoted: recipes.promotedOf(wf) }) }; }
            catch (err) { refused.push(`${n}: ${err.message}`); }
        }
        check("no template's picture lands on a loader or a latent size (subgraph inputs by name)", !wrongSlot.length, short(wrongSlot));
        check("every template but the one with two results reads without a title; that one asks for \"Scumble result\"",
            refused.length === 1 && /instantx_inpainting/.test(refused[0]) && /several SaveImage/.test(refused[0]) && Object.keys(out).length === names.length - 1, short(refused));
        const v = (n) => out[n].r.providers.comfycloud;
        const g = (n) => v(n).options.graph;
        const title = (n, id) => (g(n)[id]._meta || {}).title;
        const q21 = "image_qwen_image_2_1_image_edit.json";
        check("Qwen Image 2.1 edit: two pictures (470 the crop, 475 the second), the prompt through the subgraph's control into the switch and the prompt writer, the negative, the seed, SaveImageAdvanced",
            v(q21).options.pictures === 2 && title(q21, "470") === "scumble:picture:0" && title(q21, "475") === "scumble:picture:1" && v(q21).options.save === "461"
            && eq(v(q21).options.values.prompt.map((x) => x.join(".")).sort(), ["459:484.on_false", "459:500.prompt"]) && eq(v(q21).options.values.negative, [["459:474", "negative_prompt"]]) && v(q21).options.values.seed.some((x) => x.join(".") === "459:458.seed"),
            short(v(q21).note));
        const k9 = "image_flux2_klein_image_edit_9b_base.json";
        check("Flux.2 Klein 9B: the bypassed second subgraph adds no node, the crop into ImageScaleToTotalPixels, prompt and seed of the live one",
            !Object.keys(g(k9)).some((id) => id.startsWith("92:")) && title(k9, "76") === "scumble:picture:0" && eq(v(k9).options.values.prompt, [["75:74", "text"]]) && eq(v(k9).options.values.seed, [["75:73", "noise_seed"]]),
            short(v(k9).note));
        const cap = "Image_capybara_v0_1_image_edit.json";
        check("Capybara: the negative encoder stays the negative (its first hop names it), the prompt the positive",
            eq(v(cap).options.values.prompt, [["103:44", "text"]]) && eq(v(cap).options.values.negative, [["103:93", "text"]]), short(v(cap).note));
        const rel = "image_qwen_image_edit_2509_relight.json";
        check("Qwen 2509 relight: the prompt goes into the text node behind the fixed trigger word, not into the concatenation",
            eq(v(rel).options.values.prompt, [["15", "value"]]) && g(rel)["14"].inputs.string_a !== "", short(v(rel).note));
        const k11 = "image_qwen_image_edit_2511.json";
        check("Qwen 2511: its second picture input becomes picture 1", v(k11).options.pictures === 2 && title(k11, "83") === "scumble:picture:1");
        const noted = Object.values(out).every(({ r }) => /^Read from the graph: crop: LoadImage/.test(r.providers.comfycloud.note) && r.providers.comfycloud.options.save);
        check("each recipe's note says what was read, beginning with the crop, and names its result", noted);
        // a title still wins: the same graph with "Scumble crop" on the second picture takes that one
        const flat = JSON.parse(JSON.stringify(out[q21].flat));
        flat["475"]._meta = { title: "Scumble crop" };
        const titled = recipes.fromCloudGraph({ output: flat, name: "t", ids: [], date: "2026-10-03" });
        check("titles win over the reading: Scumble crop on the second LoadImage makes it the crop", titled.providers.comfycloud.options.graph["475"]._meta.title === "scumble:picture:0" && /A graph made for Comfy Cloud/.test(titled.providers.comfycloud.note));
        // a control read by its label (Qwen 2509's "prompt_1" shows "negative_prompt"), the negative side alone when the
        // controls name only the prompt (Flux.2 Klein's negative encoder), an encoder's own negative field (Mage Flow)
        check("Qwen 2509: the negative through the control labelled negative_prompt", eq(v("image_qwen_image_edit_2509.json").options.values.negative, [["433:110", "prompt"]]), short(v("image_qwen_image_edit_2509.json").options.values));
        check("Flux.2 Klein 9B: the negative encoder without a control, by where its conditioning goes", eq(v(k9).options.values.negative, [["75:67", "text"]]), short(v(k9).options.values));
        check("Mage Flow: the negative field of the encoder the prompt goes into", eq(v("image_mage_flow_edit_turbo_int8.json").options.values.negative, [["12:5", "negative_prompt"]]), short(v("image_mage_flow_edit_turbo_int8.json").options.values));
        // the prompt's own encoder is never the negative (Flux.1 Kontext zeroes the prompt's conditioning for its negative)
        const kontext = {
            1: { class_type: "LoadImage", inputs: { image: "a.png" } }, 2: { class_type: "VAEEncode", inputs: { pixels: ["1", 0], vae: ["9", 0] } },
            3: { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["9", 0] } }, 4: { class_type: "ReferenceLatent", inputs: { conditioning: ["3", 0], latent: ["2", 0] } },
            5: { class_type: "FluxGuidance", inputs: { conditioning: ["4", 0], guidance: 2.5 } }, 6: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["3", 0] } },
            7: { class_type: "KSampler", inputs: { seed: 1, model: ["9", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["2", 0] } },
            8: { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["9", 0] } }, 9: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "x" } },
            10: { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "k" } },
        };
        const kv = recipes.detectRoles(kontext, [{ name: "text", label: "prompt", node: "3", input: "text" }]).values;
        check("a prompt whose conditioning is zeroed for the negative: the negative never takes the prompt's encoder", eq(kv.prompt, [["3", "text"]]) && !kv.negative, short(kv));
        // a control whose label names the role: the label decides ("text" shown as "negative_prompt")
        const twin = { ...JSON.parse(JSON.stringify(kontext)), 11: { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["9", 0] } } };
        twin[7].inputs.negative = ["11", 0];
        const tv = recipes.detectRoles(twin, [{ name: "text", label: "negative_prompt", node: "11", input: "text" }, { name: "text_1", label: "positive_prompt", node: "3", input: "text" }]).values;
        check("a control named text and labelled negative_prompt is the negative, not the prompt as well", eq(tv.prompt, [["3", "text"]]) && eq(tv.negative, [["11", "text"]]), short(tv));
        // a cloud copy saved back from the window (its titles mark only the pictures): the prompt and the seed stay wired
        const kleinRaw = (await recipes.list(RECIPES)).find((r) => r.id === "flux2_klein_local");
        const copy = recipes.detach(kleinRaw).recipe;
        const back = recipes.fromCloudGraph({ output: copy.providers.comfycloud.options.graph, base: copy, date: "2026-10-03" }).providers.comfycloud.options.values;
        const asNew = recipes.fromCloudGraph({ output: copy.providers.comfycloud.options.graph, name: "copy again", ids: [], date: "2026-10-03" }).providers.comfycloud.options.values;
        check("a cloud copy saved back (Save to recipe, Save as new recipe) keeps its prompt and seed", eq(back.prompt, copy.providers.comfycloud.options.values.prompt) && eq(back.seed, copy.providers.comfycloud.options.values.seed) && !!(asNew.prompt && asNew.seed), short({ back, asNew }));
    });

    // ---- 10. the Comfy Cloud recipes Scumble ships (item 35 V6 step 4: the user's picks of Comfy's templates) ----------
    await section("10. the shipped Comfy Cloud recipes", async () => {
        const tool = require(path.join(ROOT, "tools", "cloud_recipes.js"));
        const info = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "refs", "comfy_templates", "object_info.json"), "utf8"));
        const stale = tool.MANIFEST.filter((m) => fs.readFileSync(path.join(RECIPES, `${m.id}.json`), "utf8") !== JSON.stringify(tool.build(m, info), null, 2) + "\n").map((m) => m.id);
        check("each shipped file is what its export gives (node tools/cloud_recipes.js)", !stale.length, short(stale));
        const list = await recipes.list(RECIPES);
        // pictures of the edit graph (0: text to image alone), whether a text route goes with it, whether a negative is read
        const want = {
            cloud_boogu_image_edit: [1, false, true], cloud_flux2_klein_9b: [1, true, true], cloud_flux2_klein_9b_multi: [2, false, true], cloud_mage_flow_edit_turbo: [2, false, true],
            cloud_qwen_image_2_1_edit: [2, true, true], cloud_qwen_image_edit_2509: [2, false, true], cloud_flux2_dev: [1, false, false],
            cloud_anima_base: [0, true, true], cloud_anima_preview: [0, true, true], cloud_ideogram_4: [0, true, false], cloud_krea_2_turbo: [0, true, false],
            cloud_mage_flow: [0, true, true], cloud_z_image_turbo: [0, true, false],
            cloud_p_h3_image: [1, true, false], cloud_moss_image_edit: [1, true, true],
        };
        check("the manifest ships the fifteen", eq(tool.MANIFEST.map((m) => m.id).sort(), Object.keys(want).sort()), short(tool.MANIFEST.map((m) => m.id)));
        const bad = [];
        const graphOk = (o, pictures) => {
            const g = o && o.graph;
            const titles = g ? Object.values(g).map((n) => (n._meta || {}).title).filter((t) => /^scumble:picture:/.test(t || "")) : [];
            return !!g && o.pictures === pictures && titles.length === pictures && !!g[o.save] && /^SaveImage/.test(g[o.save].class_type) && o.values.prompt && o.values.prompt.length && o.values.seed
                && !Object.values(g).some((n) => n.class_type === "InpaintCanvas" || n.class_type === "ResolutionSelector") && o.workflow && Array.isArray(o.workflow.nodes) && Array.isArray(o.needs)
                && Object.values(g).every((n) => n.inputs && Object.keys(n.inputs).length);
        };
        for (const [id, [pictures, text, negative]] of Object.entries(want)) {
            const r = list.find((x) => x.id === id);
            const v = r && r.providers && r.providers.comfycloud;
            const ok = r && r.source === "builtin" && r.kind === "provider" && r.default === "comfycloud" && eq(r.providerIds, ["comfycloud"]) && r.family === "Comfy Cloud"
                && graphOk(v.options, pictures) && (pictures === 0 ? v.edit === false : v.edit !== false) && !!v.text === text
                && !!v.options.values.negative === negative && (pictures === 0 ? !!(v.options.values.width && v.options.values.height) : !v.options.values.width)
                && (!text || (v.text.model && Array.isArray(v.text.sizes) && v.text.refs === null && (pictures === 0 ? !v.text.options : graphOk(v.text.options, 0) && v.text.options.values.width && v.text.options.values.height)));
            if (!ok) bad.push(id);
        }
        check("all fifteen are listed as shipped Comfy Cloud recipes: pictures titled, prompt and seed read (the negative where the template has one), their SaveImage, no node without inputs, the layout kept; the text-to-image ones (alone or as an edit recipe's text route) with their size", !bad.length, short(bad));
        // what step 5 reads: a prompt behind a switch, a preview and a prompt enhancer (Krea 2), the size from a resolution
        // node that goes (Anima base), the widget values a node list does not know (Ideogram 4)
        const krea = list.find((x) => x.id === "cloud_krea_2_turbo").providers.comfycloud.options;
        check("Krea 2: the prompt through the switch, the preview and the enhancer into the text the user writes", eq(krea.values.prompt, [["30:19", "value"]]), short(krea.values));
        const anima = list.find((x) => x.id === "cloud_anima_base").providers.comfycloud.options;
        check("Anima base: the size into the latent the resolution node fed, which is gone", eq(anima.values.width, [["90:74", "width"]]) && anima.graph["90:74"].inputs.width === 1024 && !anima.graph["91"], short(anima.values));
        // every node of a shipped graph has the required inputs its class declares (a dynamic combo's chosen option
        // included: SaveImageAdvanced's format); a growing input (images.image_1) counts by its prefix, and a
        // text-to-image graph's encoder may take no picture at all
        const missing = [];
        for (const id of Object.keys(want)) {
            const vv = list.find((x) => x.id === id).providers.comfycloud;
            for (const o of [vv.options, vv.text && vv.text.options].filter(Boolean)) {
                for (const [nid, n] of Object.entries(o.graph)) {
                    const decl = info[n.class_type];
                    for (const k of Object.keys((decl && decl.input && decl.input.required) || {})) {
                        if (k in n.inputs || Object.keys(n.inputs).some((x) => x.startsWith(k + ".")) || (k === "images" && o.pictures === 0)) continue;
                        missing.push(`${id} ${nid} ${n.class_type}.${k}`);
                    }
                }
            }
        }
        check("every node of a shipped graph has its required inputs, dynamic combos read (SaveImageAdvanced's format, ResizeImageMaskNode's resize_type)", !missing.length, short(missing));
        const saveAdv = list.find((x) => x.id === "cloud_qwen_image_edit_2509").providers.comfycloud.options.graph["469"].inputs;
        const resize = list.find((x) => x.id === "cloud_boogu_image_edit").providers.comfycloud.options.graph["49"].inputs;
        check("the named widget values: SaveImageAdvanced png 8-bit sRGB, ResizeImageMaskNode by total pixels at 1 MP with lanczos",
            saveAdv.format === "png" && saveAdv["format.bit_depth"] === "8-bit" && resize.resize_type === "scale total pixels" && resize["resize_type.megapixels"] === 1 && resize.scale_method === "lanczos", short({ saveAdv, resize }));
        const qwen = list.find((x) => x.id === "cloud_qwen_image_2_1_edit").providers.comfycloud;
        check("Qwen Image 2.1 on Comfy Cloud: its pictures named <image1>, its sizes in steps of 32", qwen.refs.name === "<image{n}>" && qwen.limits.step === 32, short({ refs: qwen.refs, limits: qwen.limits }));
        const ideo = list.find((x) => x.id === "cloud_ideogram_4").providers.comfycloud.options.graph;
        check("Ideogram 4: the nodes the fixtures' node list lacks take the export's named widget values", ideo["98:156"].inputs.choice === "Default" && ideo["98:157"].inputs.cfg === 3 && ideo["98:155"].inputs.cfg === 7, short(ideo["98:156"].inputs));
        // MOSS-Image Edit (item 50, docs/PLAN_LORAS.md LR7): Comfy's image_moss_image_edit with image_moss_image_t2i as its
        // text route; both exports name every widget value, and the node list knows both MOSS classes (LR6), so the
        // required-input check above covers SkipLayerGuidanceDiTSimple and both TextEncodeMOSSImageEdit nodes
        const { specProblems } = require(path.join(ROOT, "tools", "node_specs.js"));
        const exportOf = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "refs", "comfy_cloud", f), "utf8"));
        const unnamed = [];
        for (const f of ["edit/image_moss_image_edit.json", "t2i/image_moss_image_t2i.json"]) {
            const wf = exportOf(f);
            const nodes = [...wf.nodes, ...((wf.definitions && wf.definitions.subgraphs) || []).flatMap((sg) => sg.nodes || [])];
            for (const n of nodes) if (Array.isArray(n.widgets_values) && !(n.widgets_values_named && typeof n.widgets_values_named === "object")) unnamed.push(`${f} ${n.id} ${n.type}`);
        }
        check("the MOSS exports carry widgets_values_named on every node with widget values (the edit export from frontend 1.57.1)", !unnamed.length && exportOf("edit/image_moss_image_edit.json").extra.frontendVersion === "1.57.1", short(unnamed));
        const moss = list.find((x) => x.id === "cloud_moss_image_edit").providers.comfycloud;
        const mg = moss.options.graph;
        const mpins = [
            ["8 the crop", (mg["8"]._meta || {}).title, "scumble:picture:0"], ["29.image", mg["29"].inputs.image, ["8", 0]], ["29", [mg["29"].inputs.upscale_method, mg["29"].inputs.megapixels, mg["29"].inputs.resolution_steps], ["lanczos", 1, 16]],
            ["27.image", mg["27"].inputs.image, ["29", 0]], ["28", [mg["28"].inputs.width, mg["28"].inputs.height], [["27", 0], ["27", 1]]],
            ["30.unet_name", mg["30"].inputs.unet_name, "moss_image_sft_int8_convrot.safetensors"], ["31", mg["31"].inputs, { lora_name: "moss_image_edit_lora_rank_64_bf16.safetensors", strength_model: 1, model: ["30", 0] }],
            ["32", mg["32"].inputs, { double_layers: "", single_layers: "22", start_percent: 0, end_percent: 1, model: ["31", 0] }],
            ["33", [mg["33"].inputs.clip_name, mg["33"].inputs.type], ["qwen3.5_9b_w4a8_gptq.safetensors", "moss_image"]], ["34.vae_name", mg["34"].inputs.vae_name, "flux2-vae_small.safetensors"],
            ["37", [mg["37"].inputs.model, mg["37"].inputs.positive, mg["37"].inputs.negative, mg["37"].inputs.steps, mg["37"].inputs.cfg, mg["37"].inputs.sampler_name, mg["37"].inputs.scheduler, mg["37"].inputs.denoise], [["32", 0], ["39", 0], ["36", 0], 30, 4, "euler", "normal", 1]],
        ];
        for (const e of ["36", "39"]) mpins.push([e, [mg[e].inputs.edit_format, mg[e].inputs.image_strength, mg[e].inputs["images.image_0"], mg[e].inputs.clip, mg[e].inputs.vae, "images.image_1" in mg[e].inputs], ["Moss-Image-Edit", 1, ["29", 0], ["33", 0], ["34", 0], false]]);
        const moff = mpins.filter(([, got, want]) => !eq(got, want)).map(([k, got]) => `${k}=${JSON.stringify(got)}`);
        check("cloud_moss_image_edit: the crop into LoadImage 8, scaled to 1 MP in steps of 16, the latent its size; the edit LoRA 31 at 1 between the UNETLoader and SkipLayerGuidanceDiTSimple (\"\", layer 22, 0 to 1); both encoders Moss-Image-Edit at strength 1 on images.image_0 with the CLIP and the VAE; 30 steps, CFG 4, euler / normal; no ImageCompare",
            !moff.length && moss.options.pictures === 1 && !Object.values(mg).some((n) => n.class_type === "ImageCompare") && eq(moss.options.values.prompt, [["39", "prompt"]]) && eq(moss.options.values.negative, [["36", "prompt"]]) && eq(moss.options.values.seed, [["37", "seed"]]),
            short({ moff, values: moss.options.values }));
        const mtg = moss.text.options.graph;
        const mtoff = [
            ["prompt", moss.text.options.values.prompt, [["18:17", "value"]]], ["negative", moss.text.options.values.negative, [["18:5", "text"]]], ["seed", moss.text.options.values.seed, [["18:7", "seed"]]],
            ["width", moss.text.options.values.width, [["18:6", "width"]]], ["height", moss.text.options.values.height, [["18:6", "height"]]],
            ["the enhancer's switch", [mtg["18:16"].inputs.switch, mtg["18:16"].inputs.on_true, mtg["18:16"].inputs.on_false], [true, ["18:11", 0], ["18:17", 0]]], ["the encoder reads the switch's pick", mtg["18:4"].inputs.text, ["18:13", 0]],
            ["the SLG switch off", [mtg["18:24"].inputs.switch, mtg["18:24"].inputs.on_false, mtg["18:7"].inputs.model], [false, ["18:1", 0], ["18:24", 0]]],
            ["18:7", [mtg["18:7"].inputs.steps, mtg["18:7"].inputs.cfg, mtg["18:7"].inputs.sampler_name, mtg["18:7"].inputs.scheduler], [25, 2.5, "er_sde", "simple"]],
        ].filter(([, got, want]) => !eq(got, want)).map(([k, got]) => `${k}=${JSON.stringify(got)}`);
        check("... its text route image_moss_image_t2i: the prompt into the text the enhancer reads (switch on), the negative, the seed, the size into the latent (the resolution node gone), 25 steps, CFG 2.5, er_sde / simple, the template's SLG switch off",
            !mtoff.length && moss.text.model === "MOSS-Image Edit" && moss.text.options.pictures === 0 && !Object.values(mtg).some((n) => n.class_type === "ResolutionSelector"), short(mtoff));
        // every input against its class's spec (tools/node_specs.js, as section 15 checks the local recipe); the crop's
        // LoadImage has no file until a run uploads one
        const mprobs = [...specProblems(mg, info).filter((p) => p !== "8.image=\"\" not among its options").map((p) => `edit ${p}`), ...specProblems(mtg, info).map((p) => `text ${p}`)];
        check("cloud_moss_image_edit: both graphs sound against the node specs (combos in their options, numbers in range, links to nodes of the graph, the growing input's image_0)", !mprobs.length, short(mprobs));
        check("cloud_moss_image_edit: no loras declaration (the edit LoRA is 31 in the edit graph and the text graph has none, cloud_p_h3_image's precedent), the description with the licence sentence and \"not run\"",
            moss.loras === undefined && moss.text.loras === undefined && list.find((x) => x.id === "cloud_moss_image_edit").description.includes("The edit LoRA is chinoll's Moss-Image-Edit, rehosted by Comfy-Org, whose repository card says Apache-2.0; chinoll's own repository names no licence for the weights (its code is GPL-3.0). MOSS-Image's weights are Apache-2.0.")
            && /not run on Comfy Cloud from Scumble yet/.test(list.find((x) => x.id === "cloud_moss_image_edit").description), short({ loras: moss.loras }));
    });

    // ---- 11. task "pass" and the presets a recipe file ships (docs/PLAN_0_1_42.md R1) -----------------------------
    await section("11. normalize: task \"pass\" and shipped presets", async () => {
        const comfyOf = (extra) => recipes._normalize({ id: "t_pass", kind: "comfy", mode: "local", canvas: "1", result: "2:0", prompt: { 1: { class_type: "InpaintCanvas", inputs: {} }, 2: { class_type: "KSampler", inputs: {} } }, ...extra });
        const pass = comfyOf({ task: "pass" });
        check("a ComfyUI recipe keeps task \"pass\", with no upscale factor", pass.task === "pass" && pass.factor === undefined, short({ task: pass.task, factor: pass.factor }));
        const odd = comfyOf({ task: "bogus" });
        const none = comfyOf({});
        const up = comfyOf({ task: "upscale" });
        check("an unknown task still becomes \"edit\", no task stays none, an upscaler keeps its fixed factor", odd.task === "edit" && none.task === undefined && up.task === "upscale" && !!up.factor && up.factor.fixed === true, short({ odd: odd.task, none: none.task, up: up.factor }));
        const prov = recipes._normalize({ id: "t_pass_p", kind: "provider", task: "pass", providers: { loopback: { model: "m" } } });
        check("a provider recipe has no pass: its task \"pass\" becomes \"edit\"", prov.task === "edit", prov.task);

        // shippedPresets, through normalize: each entry a name and "<node>:<input>" keys with plain values
        const presetsOf = (list) => { const r = comfyOf(list === undefined ? {} : { presets: list }); return { has: Object.prototype.hasOwnProperty.call(r, "presets"), presets: r.presets }; };
        const good = { name: "L", values: { "rp_settings:dlss_model_preset": "L" } };
        let x = presetsOf([good, { name: "M", values: { "rp_settings:dlss_model_preset": "M", "rp_settings:nr_intensity": 0.5, "rp_enhance:verify_neural_rendering": false } }]);
        check("well-formed presets come through as they are (string, number and boolean values)", eq(x.presets, [good, { name: "M", values: { "rp_settings:dlss_model_preset": "M", "rp_settings:nr_intensity": 0.5, "rp_enhance:verify_neural_rendering": false } }]), short(x));
        x = presetsOf(undefined);
        const xEmpty = presetsOf([]);
        check("no presets, or an empty list: no presets key at all", !x.has && !xEmpty.has, short({ x, xEmpty }));
        const notLists = ["L", 3, true, null, { name: "L", values: { "a:b": 1 } }].map((v) => presetsOf(v));
        check("presets that are no array (a string, a number, true, null, one preset object): the key removed", notLists.every((y) => !y.has), short(notLists));
        x = presetsOf([null, "L", 7, [good], { values: { "a:b": 1 } }, { name: "", values: { "a:b": 1 } }, { name: "   ", values: { "a:b": 1 } }, { name: 5, values: { "a:b": 1 } }, good]);
        check("entries that are no object, or have no name (missing, empty, blank, not a string), are dropped", eq(x.presets, [good]), short(x));
        x = presetsOf([{ name: "A", values: "L" }, { name: "B", values: null }, { name: "C", values: ["a:b"] }, { name: "D" }, { name: "E", values: 1 }, good]);
        check("entries whose values are no object (a string, null, an array, missing, a number) are dropped", eq(x.presets, [good]), short(x));
        x = presetsOf([{ name: "K", values: { preset: "L", "no colon": 1, ":b": 1, ":x": 1, "a:": 1, "x:": 1, "": 1, "a:b": "kept" } }]);
        check("keys that are not \"<node>:<input>\" (no colon, an empty node, an empty input, empty) are dropped, the good one kept", eq(x.presets, [{ name: "K", values: { "a:b": "kept" } }]), short(x));
        // a node id may hold colons itself (a flattened subgraph's "57:12"): the input is what follows the last colon
        x = presetsOf([{ name: "K", values: { "a:b:c": 1, "57:12:unet_name": "flux.safetensors", "57:12:": 1, "a:b": "kept" } }]);
        check("a key whose node id holds colons is kept (\"a:b:c\" = node \"a:b\", input \"c\"; \"57:12:unet_name\" = node \"57:12\", input \"unet_name\"), one ending in a colon is not",
            eq(x.presets, [{ name: "K", values: { "a:b:c": 1, "57:12:unet_name": "flux.safetensors", "a:b": "kept" } }]), short(x));
        x = presetsOf([{ name: "K", values: { "a:o": { x: 1 }, "a:arr": [1], "a:nul": null, "a:und": undefined, "a:fn": () => 1, "a:s": "s", "a:n": 2, "a:t": true } }]);
        check("object, array, null, undefined and function values are dropped; strings, numbers and booleans kept", eq(x.presets, [{ name: "K", values: { "a:s": "s", "a:n": 2, "a:t": true } }]), short(x));
        x = presetsOf([{ name: "K", values: { preset: "L", "a:o": { x: 1 } } }, { name: "Z", values: {} }]);
        check("an entry left with no value at all is dropped, and with none left the key goes", !x.has, short(x));
        x = presetsOf([good, { name: "L", values: { "rp_settings:dlss_model_preset": "M" } }, { name: " L ", values: { "a:b": 1 } }, { name: "M", values: { "a:b": 2 } }]);
        check("a later preset of a name already taken is dropped (the first wins, names trimmed)", eq(x.presets, [good, { name: "M", values: { "a:b": 2 } }]), short(x));
        x = presetsOf([{ name: "L", values: { nope: 1 } }, good]);
        check("a dropped entry takes no name: a later well-formed one of the same name is kept", eq(x.presets, [good]), short(x));
        x = presetsOf([{ name: "  L2  ", values: { "a:b": 1 } }]);
        check("a name is trimmed", eq(x.presets, [{ name: "L2", values: { "a:b": 1 } }]), short(x));
        const src = [{ name: "L", values: { "a:b": 1, bad: 2 } }];
        const srcCopy = JSON.parse(JSON.stringify(src));
        presetsOf(src);
        check("the file's own list is not changed in place", eq(src, srcCopy), short(src));

        // the shipped recipe: L and M on its one Settings row, through list() as they are in the file
        const raw = rawFile("realism_pass.json");
        const rp = (await recipes.list(RECIPES)).find((r) => r.id === "realism_pass");
        check("realism_pass: its presets come through normalize unchanged, L first, then M", !!rp && eq(rp.presets, raw.presets) && eq(rp.presets.map((p) => p.name), ["L", "M"]), short(rp && rp.presets));
        const rowKeys = new Set(((rp && rp.settings) || []).map((s) => `${s.node}:${s.input}`));
        const choices = ((rp && rp.settings) || [])[0] && rp.settings[0].spec ? rp.settings[0].spec[0] : [];
        const strays = ((rp && rp.presets) || []).flatMap((p) => Object.entries(p.values).filter(([k, v]) => !rowKeys.has(k) || !choices.includes(v)).map(([k, v]) => `${p.name}: ${k}=${v}`));
        check("realism_pass: every preset value names its Settings row and one of the row's choices; L is the prompt's own value",
            !strays.length && !!rp && rp.prompt.rp_settings.inputs.dlss_model_preset === "L" && rp.presets[0].values["rp_settings:dlss_model_preset"] === "L", short(strays));
        const once = recipes._normalize(JSON.parse(JSON.stringify(raw)));
        const twice = recipes._normalize(JSON.parse(JSON.stringify(once)));
        check("realism_pass: normalize twice gives the same recipe (a saved copy reads back the same)", eq(once, twice), short({ once: once.presets, twice: twice.presets }));
    });

    // ---- 12. the node's tail outputs (docs/PLAN_NODE_BOXES.md D2): box_prompt and elements are no setting slots ----
    await section("12. the canvas node's tail outputs box_prompt and elements", async () => {
        const META12 = { file: "graph", date: "2026-10-15" };
        const apiPrompt = (slots) => ({
            "1": { class_type: "InpaintCanvas", inputs: { padding: 64, target_size: 1024, feather: 16, multiple_of: 16, result_source: "2:0" } },
            "2": { class_type: "Flux3ImageNode", inputs: { prompt: ["1", slots.prompt], "images.image_1": ["1", 0], ...(slots.boxes != null ? { bounding_boxes: ["1", slots.boxes] } : {}), seed: ["1", slots.seed] } },
            "3": { class_type: "LoraLoader", inputs: { lora_name: ["1", slots.setting] } },
        });
        // an API prompt as the node's queuePrompt wrapper sends it: backend slots (setting_1 13, box_prompt 21, elements 22)
        let r = recipes.fromPrompt(apiPrompt({ prompt: 21, boxes: 22, seed: 10, setting: 13 }), {}, META12);
        check("fromPrompt, backend slots: box_prompt's consumer takes the plain prompt (7), elements' link goes, setting_1 stays a Settings row",
            eq(r.prompt["2"].inputs.prompt, ["1", 7]) && !("bounding_boxes" in r.prompt["2"].inputs) && r.settings.length === 1 && r.settings[0].index === 1 && r.settings[0].node === "3"
            && r.notes.some((n) => /box_prompt/.test(n)) && r.notes.some((n) => /elements/.test(n)), short({ inputs: r.prompt["2"].inputs, settings: r.settings, notes: r.notes }));
        // the page's graph: the tail outputs right after the connected settings (setting_1, the free setting_2, then the tail)
        const names = ["crop_image", "crop_mask", "image", "mask", "stitch_info", "crop_width", "crop_height", "prompt", "control_image", "denoise", "seed", "mode", "negative", "setting_1", "setting_2", "box_prompt", "elements"];
        r = recipes.fromPrompt(apiPrompt({ prompt: 15, boxes: 16, seed: 10, setting: 13 }), {}, META12, undefined, { outputNames: names });
        check("fromPrompt with the page's output names: visible slots 15 / 16 are box_prompt / elements, not settings 3 / 4",
            eq(r.prompt["2"].inputs.prompt, ["1", 7]) && !("bounding_boxes" in r.prompt["2"].inputs) && r.settings.length === 1 && r.settings[0].index === 1, short({ inputs: r.prompt["2"].inputs, settings: r.settings }));
        r = recipes.fromPrompt(apiPrompt({ prompt: 7, seed: 10, setting: 14 }), {}, META12, undefined, { outputNames: names });
        check("fromPrompt: a graph without the tail outputs reads as before (setting_2 at 14 is Settings row 2)", eq(r.prompt["2"].inputs.prompt, ["1", 7]) && r.settings.length === 1 && r.settings[0].index === 2 && !r.notes.length, short({ settings: r.settings, notes: r.notes }));
        // a UI workflow (the node's FLUX 3 example's shape): outputs by name
        const out = (name, type, links) => ({ name, type, links });
        const wf = {
            nodes: [
                { id: 1, type: "InpaintCanvas", mode: 0, inputs: [{ name: "result", type: "IMAGE", link: 5 }, { name: "result_local", type: "IMAGE", link: null }],
                    outputs: names.map((n, i) => out(n, i === 16 ? "ARRAY" : "*", i === 0 ? [1] : i === 15 ? [2] : i === 16 ? [3] : i === 13 ? [4] : [])), widgets_values: [64, 1024, 16, 16, "{}"] },
                { id: 2, type: "Flux3ImageNode", mode: 0, inputs: [{ name: "prompt", type: "STRING", widget: { name: "prompt" }, link: 2 }, { name: "images.image_1", type: "IMAGE", link: 1 }, { name: "bounding_boxes", type: "ARRAY", link: 3 }],
                    outputs: [{ name: "IMAGE", type: "IMAGE", links: [5] }], widgets_values: ["", "auto", "1K", true, 4, 42, "randomize"] },
                { id: 3, type: "LoraLoader", mode: 0, inputs: [{ name: "lora_name", type: "COMBO", widget: { name: "lora_name" }, link: 4 }], outputs: [], widgets_values: ["a.safetensors"] },
            ],
            links: [[1, 1, 0, 2, 1, "IMAGE"], [2, 1, 15, 2, 0, "STRING"], [3, 1, 16, 2, 2, "ARRAY"], [4, 1, 13, 3, 0, "*"], [5, 2, 0, 1, 0, "IMAGE"]],
        };
        const info = {
            InpaintCanvas: { input: { required: { padding: ["INT", {}], target_size: ["INT", {}], feather: ["INT", {}], multiple_of: ["INT", {}] } } },
            Flux3ImageNode: { input: { required: { prompt: ["STRING", {}], aspect_ratio: [["auto"], {}], resolution: [["1K"], {}], grounding: ["BOOLEAN", {}], seed: ["INT", {}] }, optional: { bounding_boxes: ["ARRAY", {}] } } },
            LoraLoader: { input: { required: { lora_name: [["a.safetensors"], {}] } } },
        };
        r = recipes.fromWorkflow(wf, info, META12);
        check("fromWorkflow: box_prompt's consumer takes the plain prompt, elements' link goes, setting_1 is Settings row 1",
            eq(r.prompt["2"].inputs.prompt, ["1", 7]) && !("bounding_boxes" in r.prompt["2"].inputs) && r.settings.length === 1 && r.settings[0].index === 1 && r.settings[0].node === "3"
            && r.notes.some((n) => /box_prompt/.test(n)), short({ inputs: r.prompt["2"].inputs, settings: r.settings, notes: r.notes }));
    });

    // ---- 13. boxes in the prompt on the user's ComfyUI: a recipe's `boxes` (the input the node's box_prompt goes to) ----
    await section("13. a ComfyUI recipe's boxes", async () => {
        const BOXES = { schema: "flux3", input: "say_in|string_b" };
        const warn = console.warn;
        const warned = [];
        console.warn = (...a) => warned.push(a.join(" "));
        try {
            freshUserData();
            const all = await recipes.list(RECIPES);
            const k = all.find((r) => r.id === "flux3_klein_local");
            check("flux3_klein_local keeps its boxes through list() (normalize), without a warning",
                !!k && eq(k.boxes, BOXES) && !warned.some((w) => /boxes/.test(w)), short({ boxes: k && k.boxes, warned }));
            const others = all.filter((r) => r.boxes !== undefined && r.id !== "flux3_klein_local" && r.id !== "moss_image_local").map((r) => r.id);
            check("no other shipped recipe declares boxes", !others.length, others.join(", "));
            // MOSS-Image: the layout node ComfyUI's MOSSImageLayoutPrompt is, wired to the node's elements by a run that sends boxes
            const MOSS = { schema: "moss", input: "pos|text", layout: "layout" };
            const mo = all.find((r) => r.id === "moss_image_local");
            check("moss_image_local keeps its boxes with the layout node and edit false through list(); every other ComfyUI recipe edits",
                !!mo && eq(mo.boxes, MOSS) && mo.edit === false && all.filter((r) => r.kind !== "provider" && r.id !== "moss_image_local").every((r) => r.edit === true),
                short({ boxes: mo && mo.boxes, edit: mo && mo.edit }));
            const rawM = rawFile("moss_image_local.json");
            const withMoss = (boxes, prompt) => ({ ...JSON.parse(JSON.stringify(rawM)), kind: "comfy", boxes, ...(prompt ? { prompt } : {}) });
            const filled = JSON.parse(JSON.stringify(rawM.prompt));
            filled.layout.inputs.element = ["canvas", 22];
            const badMoss = [
                ["no layout", { schema: "moss", input: "pos|text" }],
                ["a layout the graph lacks", { ...MOSS, layout: "nope" }],
                ["a layout that is no MOSSImageLayoutPrompt", { ...MOSS, layout: "pos" }],
                ["the canvas node as the layout", { ...MOSS, layout: "canvas" }],
                ["the input on the layout node itself", { ...MOSS, input: "layout|prompt" }],
            ];
            for (const [what, boxes] of badMoss) {
                const before = warned.length;
                const r = recipes._normalize(withMoss(boxes));
                const said = warned.slice(before);
                check(`a bad MOSS boxes (${what}) is dropped with a warning`, r.boxes === undefined && said.length === 1 && /^moss_image_local: boxes .*the recipe sends no boxes$/.test(said[0]), short({ boxes: r.boxes, said }));
            }
            const beforeF = warned.length;
            const fm = recipes._normalize(withMoss(MOSS, filled));
            check("a layout whose element input a link fills already is dropped with a warning", fm.boxes === undefined && warned.length - beforeF === 1 && /element input is filled/.test(warned[beforeF]), short(warned.slice(beforeF)));
            const pm = recipes.toPrompt(mo);
            const overM = recipes.fromGraph({ output: pm, workflow: { nodes: [{ id: 1, type: "InpaintCanvas" }], links: [], extra: {} }, objectInfo: {}, base: mo, date: "2026-10-22" });
            check("fromGraph (Save to recipe) keeps MOSS's boxes and edit false", eq(overM.boxes, MOSS) && overM.edit === false, short({ boxes: overM.boxes, edit: overM.edit }));
            // FLUX 3 Image Klein's prompt upsampler (0.1.50 Q9): kept by normalize, a bad one dropped, kept by Save to recipe,
            // left out of the Cloud copy
            const kk = all.find((r) => r.id === "flux3_klein_local");
            check("flux3_klein_local keeps its upsampler through list() (switch, run, show, nodes, t2i, source), no request of its own, and no shipped recipe but it, P-H3-Image and Fibo 2.0 Edit Turbo declares one",
                !!kk && kk.upsampler && kk.upsampler.switch === "up_switch" && kk.upsampler.run === "up_run" && kk.upsampler.show === "up_show" && typeof kk.upsampler.t2i === "string" && /Apache-2\.0/.test(kk.upsampler.source)
                && kk.upsampler.request === undefined
                && all.filter((r) => r.upsampler !== undefined).map((r) => r.id).sort().join(",") === "fibo2_edit_turbo_local,flux3_klein_local,p_h3_image_local", short(kk && kk.upsampler && { ...kk.upsampler, t2i: "..." }));
            // P-H3-Image (docs/PLAN_PH3.md): a TextGenerateV2 run and a request of its own, kept by normalize; Generate new's
            // drop kept; a bad request or newImage dropped with a warning; both kept by Save to recipe
            const ph = all.find((r) => r.id === "p_h3_image_local");
            const rawP = rawFile("p_h3_image_local.json");
            check("p_h3_image_local keeps its upsampler (a TextGenerateV2 run, the request's edit, picture, t2i, aspects and verbatim) and its newImage drop",
                !!ph && ph.upsampler && ph.upsampler.run === "up_run" && ph.upsampler.t2i === undefined && ph.upsampler.request
                && ["edit", "picture", "t2i", "aspects", "verbatim"].every((k) => eq(ph.upsampler.request[k], rawP.upsampler.request[k])) && Object.keys(ph.upsampler.request).length === 5
                && eq(ph.newImage, { drop: ["cond|images.image_1"] }) && all.filter((r) => r.newImage !== undefined).map((r) => r.id).join(",") === "p_h3_image_local",
                short(ph && { upsampler: ph.upsampler && { ...ph.upsampler, request: Object.keys(ph.upsampler.request || {}) }, newImage: ph.newImage }));
            const withP = (more) => ({ ...JSON.parse(JSON.stringify(rawP)), kind: "comfy", ...more });
            const UPP = rawP.upsampler;
            const badReq = [
                ["a request that is a string", { ...UPP, request: "x" }],
                ["a request with neither edit nor t2i", { ...UPP, request: { picture: "<Picture {n}>" } }],
                ["an edit without {text}", { ...UPP, request: { ...UPP.request, edit: "Edit <Picture 1>." } }],
                ["a picture without {n}", { ...UPP, request: { ...UPP.request, picture: "<Picture>" } }],
                ["aspects that are not W:H", { ...UPP, request: { ...UPP.request, aspects: ["wide"] } }],
                ["a verbatim pattern that does not compile", { ...UPP, request: { ...UPP.request, verbatim: { match: "(Edit", drop: "Edit <Picture 1>. " } } }],
                ["a verbatim drop the edit does not hold", { ...UPP, request: { ...UPP.request, verbatim: { match: "^Edit", drop: "Edit <Picture 9>. " } } }],
            ];
            for (const [what, up] of badReq) {
                const before = warned.length;
                const r = recipes._normalize(withP({ upsampler: up }));
                const said = warned.slice(before);
                check(`a bad P-H3 upsampler (${what}) is dropped with a warning`, r.upsampler === undefined && said.length === 1 && /^p_h3_image_local: upsampler .*the graph goes as it is$/.test(said[0]), short({ said }));
            }
            const badNew = [
                ["a list", ["cond|images.image_1"]],
                ["an empty drop", { drop: [] }],
                ["an input without node|", { drop: ["images.image_1"] }],
                ["a node the graph lacks", { drop: ["nope|images.image_1"] }],
                ["the canvas node", { drop: ["canvas|padding"] }],
                ["an input that holds no link", { drop: ["cond|images.image_9"] }],
            ];
            for (const [what, n] of badNew) {
                const before = warned.length;
                const r = recipes._normalize(withP({ newImage: n }));
                const said = warned.slice(before);
                check(`a bad newImage (${what}) is dropped with a warning`, r.newImage === undefined && said.length === 1 && /^p_h3_image_local: newImage .*Generate new sends the fresh canvas$/.test(said[0]), short({ said }));
            }
            const overP = recipes.fromGraph({ output: recipes.toPrompt(ph), workflow: { nodes: [{ id: 1, type: "InpaintCanvas" }], links: [], extra: {} }, objectInfo: {}, base: ph, date: "2026-11-06" });
            check("fromGraph (Save to recipe) keeps P-H3's request and newImage", !!overP.upsampler && eq(overP.upsampler.request, ph.upsampler.request) && eq(overP.newImage, ph.newImage), short({ up: overP.upsampler && overP.upsampler.run, newImage: overP.newImage }));
            const rawK = rawFile("flux3_klein_local.json");
            const withUp = (up, prompt) => ({ ...JSON.parse(JSON.stringify(rawK)), kind: "comfy", upsampler: up, ...(prompt ? { prompt } : {}) });
            const UPD = rawK.upsampler;
            const badUp = [
                ["an array", []],
                ["a switch that is no ComfySwitchNode", { ...UPD, switch: "pos" }],
                ["a run that is no TextGenerate", { ...UPD, run: "up_show" }],
                ["nodes without the run", { ...UPD, nodes: ["up_clip", "up_pics", "up_show"] }],
                ["nodes holding the prompt as typed", { ...UPD, nodes: [...UPD.nodes, "say_keep"] }],
                ["nodes holding the canvas", { ...UPD, nodes: [...UPD.nodes, "canvas"] }],
                ["a show node outside its nodes", { ...UPD, show: "decode" }],
            ];
            for (const [what, up] of badUp) {
                const before = warned.length;
                const r = recipes._normalize(withUp(up));
                const said = warned.slice(before);
                check(`a bad upsampler (${what}) is dropped with a warning`, r.upsampler === undefined && said.length === 1 && /^flux3_klein_local: upsampler .*the graph goes as it is$/.test(said[0]), short({ said }));
            }
            const overK = recipes.fromGraph({ output: recipes.toPrompt(kk), workflow: { nodes: [{ id: 1, type: "InpaintCanvas" }], links: [], extra: {} }, objectInfo: {}, base: kk, date: "2026-10-22" });
            check("fromGraph (Save to recipe) keeps the upsampler", !!overK.upsampler && overK.upsampler.run === "up_run" && overK.upsampler.t2i === kk.upsampler.t2i, short(overK.upsampler && overK.upsampler.nodes));
            const { recipe: dk } = recipes.detach(kk);
            const gk = dk.providers.comfycloud.options.graph;
            check("the Cloud copy runs the prompt as typed: no upsampler node, no switch, pos reads the wrapper",
                !["up_clip", "up_pics", "up_run", "up_show", "up_switch"].some((id) => gk[id]) && eq(gk.pos.inputs.text, ["say_keep", 0]) && dk.upsampler === undefined, short(Object.keys(gk)));
            const raw = rawFile("flux3_klein_local.json");
            const withBoxes = (boxes, more = {}) => ({ ...JSON.parse(JSON.stringify(raw)), kind: "comfy", boxes, ...more });
            const extra = recipes._normalize(withBoxes({ ...BOXES, note: "x" }));
            check("only schema and input are kept", eq(extra.boxes, BOXES), short(extra.boxes));
            const bad = [
                ["an array", []],
                ["a bare schema string", "flux3"],
                ["a schema the node does not write", { schema: "ideogram4", input: BOXES.input }],
                ["an input without node|", { schema: "flux3", input: "say_in" }],
                ["a node the graph lacks", { schema: "flux3", input: "nope|string_b" }],
                ["the canvas node itself", { schema: "flux3", input: "canvas|padding" }],
                ["an input that holds text, not the canvas's prompt", { schema: "flux3", input: "say_keep|string_b" }],
                ["an input linked to another canvas output (the seed)", { schema: "flux3", input: "noise|noise_seed" }],
                ["an input linked to another node", { schema: "flux3", input: "say_keep|string_a" }],
            ];
            for (const [what, boxes] of bad) {
                const before = warned.length;
                const r = recipes._normalize(withBoxes(boxes));
                const said = warned.slice(before);
                check(`a bad boxes (${what}) is dropped with a warning`, r.boxes === undefined && said.length === 1 && /^flux3_klein_local: boxes .*the recipe sends no boxes$/.test(said[0]), short({ boxes: r.boxes, said }));
            }
            const before = warned.length;
            const row = recipes._normalize(withBoxes(BOXES, { settings: [...raw.settings, { index: 7, node: "say_in", input: "string_b", label: "Prompt" }] }));
            const up = recipes._normalize(withBoxes(BOXES, { task: "upscale" }));
            check("boxes on an input a Settings row writes, or on an upscale recipe, are dropped with a warning each",
                row.boxes === undefined && up.boxes === undefined && warned.length - before === 2 && /Settings row/.test(warned[before]) && /task "upscale"/.test(warned[before + 1]), short(warned.slice(before)));
            // Save to recipe and Save as new recipe keep it (GRAPH_KEEPS), also when the page wired box_prompt there by hand
            const workflow = { nodes: [{ id: 1, type: "InpaintCanvas" }], links: [], extra: {} };
            const date = "2026-10-19";
            const p = recipes.toPrompt(k);
            check("toPrompt keeps say_in.string_b on the plain prompt", eq(p.say_in.inputs.string_b, ["canvas", 7]), short(p.say_in.inputs));
            const over = recipes.fromGraph({ output: p, workflow, objectInfo: {}, base: k, date });
            const fresh = recipes.fromGraph({ output: p, workflow, objectInfo: {}, base: k, name: "My Klein boxes", ids: [k.id], date });
            check("fromGraph (Save to recipe, Save as new recipe) keeps the boxes", eq(over.boxes, BOXES) && eq(fresh.boxes, BOXES) && fresh.id !== k.id, short({ over: over.boxes, fresh: fresh.boxes }));
            const byHand = JSON.parse(JSON.stringify(p));
            byHand.say_in.inputs.string_b = ["canvas", 21];
            const hand = recipes.fromGraph({ output: byHand, workflow, objectInfo: {}, base: k, date });
            check("a graph that took box_prompt into say_in.string_b is stored on the plain prompt, the boxes kept",
                eq(hand.prompt.say_in.inputs.string_b, ["canvas", 7]) && eq(hand.boxes, BOXES), short({ input: hand.prompt.say_in.inputs.string_b, boxes: hand.boxes }));
            const typed = JSON.parse(JSON.stringify(p));
            typed.say_in.inputs.string_b = "a fixed prompt";
            const gone = recipes.fromGraph({ output: typed, workflow, objectInfo: {}, base: k, date });
            const renamed = JSON.parse(JSON.stringify(p));
            renamed.say_first = renamed.say_in;
            delete renamed.say_in;
            renamed.say_keep.inputs.string_a = ["say_first", 0];
            const gone2 = recipes.fromGraph({ output: renamed, workflow, objectInfo: {}, base: k, date });
            check("a graph whose boxes input no longer takes the canvas's prompt (a typed text, the node renamed) is saved without the boxes",
                gone.boxes === undefined && gone2.boxes === undefined, short({ gone: gone.boxes, gone2: gone2.boxes }));
            await recipes.save(over);
            const listed = (await recipes.list(RECIPES)).find((r) => r.id === k.id);
            check("the saved copy, read back through list(), keeps the boxes", !!listed && listed.source === "user" && eq(listed.boxes, BOXES), short(listed && listed.boxes));
            await recipes.remove(k.id);
            // the Comfy Cloud copy has no canvas node: the prompt goes into say_in.string_b as a value and no boxes go
            const { recipe: d } = recipes.detach(k);
            const v = d.providers.comfycloud;
            check("the Comfy Cloud copy takes the prompt into say_in.string_b and declares no boxes",
                d.boxes === undefined && (v.options || {}).boxes === undefined && (v.options.values.prompt || []).some((x) => eq(x, ["say_in", "string_b"])), short({ values: v.options.values, boxes: d.boxes }));
        } finally { console.warn = warn; }
    });

    // ---- 14. where a recipe's LoRAs go (item 50, docs/PLAN_LORAS.md LR0; the splice itself: tools/loras_test.js) ----
    await section("14. a recipe's loras through Save to recipe, the Comfy Cloud copy and the generated Cloud recipes", async () => {
        const warn = console.warn;
        const warned = [];
        console.warn = (...a) => warned.push(a.join(" "));
        try {
            freshUserData();
            const all = await recipes.list(RECIPES);
            const k = all.find((r) => r.id === "flux3_klein_local");
            check("flux3_klein_local declares its family (normalize keeps it, no warning about loras)", !!k && eq(k.loras, { family: "flux3" }) && !warned.some((w) => /loras/.test(w)), short({ loras: k && k.loras, warned }));
            const workflow = { nodes: [{ id: 1, type: "InpaintCanvas" }], links: [], extra: {} };
            const date = "2026-11-06";
            const p = recipes.toPrompt(k);
            const over = recipes.fromGraph({ output: p, workflow, objectInfo: {}, base: k, date });
            const fresh = recipes.fromGraph({ output: p, workflow, objectInfo: {}, base: k, name: "My Klein LoRAs", ids: [k.id], date });
            check("fromGraph (Save to recipe, Save as new recipe) keeps loras (GRAPH_KEEPS)", eq(over.loras, { family: "flux3" }) && eq(fresh.loras, { family: "flux3" }) && fresh.id !== k.id, short({ over: over.loras, fresh: fresh.loras }));
            const declared = { ...k, loras: { model: "unet", family: "flux3" } };
            const keptModel = recipes.fromGraph({ output: recipes.toPrompt(declared), workflow, objectInfo: {}, base: declared, date });
            const renamed = JSON.parse(JSON.stringify(recipes.toPrompt(declared)));
            renamed.unet_main = renamed.unet;
            delete renamed.unet;
            for (const n of Object.values(renamed)) for (const [kk, v] of Object.entries(n.inputs || {})) if (Array.isArray(v) && v[0] === "unet") n.inputs[kk] = ["unet_main", v[1]];
            const lost = recipes.fromGraph({ output: renamed, workflow, objectInfo: {}, base: declared, date });
            const off = recipes.fromGraph({ output: p, workflow, objectInfo: {}, base: { ...k, loras: false }, date });
            check("a declared model source is kept while the saved graph holds the node, left out (the family kept) once it is renamed; false kept",
                eq(keptModel.loras, { model: "unet", family: "flux3" }) && eq(lost.loras, { family: "flux3" }) && off.loras === false, short({ kept: keptModel.loras, lost: lost.loras, off: off.loras }));
            // the Comfy Cloud copy: the declaration as a field of its variant, checked by normalize there
            const { recipe: d, notes } = recipes.detach(k);
            const v = d.providers.comfycloud;
            check("detach writes the recipe's loras into the Cloud copy's variant (not at the top)", eq(v.loras, { family: "flux3" }) && d.loras === undefined && !notes.some((n) => /LoRA/.test(n)), short({ v: v.loras, top: d.loras, notes }));
            const { recipe: dm } = recipes.detach(declared);
            const { recipe: df } = recipes.detach({ ...k, loras: false });
            const { recipe: dg, notes: notesG } = recipes.detach({ ...k, loras: { model: "up_clip", family: "flux3" } });
            check("detach: a model source the copy keeps stays, false stays, one the copy drops (an upsampler node) is left out with a note",
                eq(dm.providers.comfycloud.loras, { model: "unet", family: "flux3" }) && df.providers.comfycloud.loras === false
                && eq(dg.providers.comfycloud.loras, { family: "flux3" }) && notesG.some((n) => /LoRAs' model source "up_clip" is not in the Comfy Cloud copy/.test(n)),
                short({ dm: dm.providers.comfycloud.loras, df: df.providers.comfycloud.loras, dg: dg.providers.comfycloud.loras, notesG }));
            const before = warned.length;
            const nd = recipes._normalize(JSON.parse(JSON.stringify(dm)));
            check("the Cloud copy through normalize keeps the variant's loras without a warning", eq(nd.providers.comfycloud.loras, { model: "unet", family: "flux3" }) && warned.length === before, short({ loras: nd.providers.comfycloud.loras, said: warned.slice(before) }));
            // the generated Cloud recipes: the manifest's loras in the variant, the files what the tool writes
            const tool = require(path.join(ROOT, "tools", "cloud_recipes.js"));
            const info = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "refs", "comfy_templates", "object_info.json"), "utf8"));
            const withLoras = tool.MANIFEST.filter((m) => m.loras !== undefined).map((m) => `${m.id}=${JSON.stringify(m.loras)}`);
            const built = tool.build(tool.MANIFEST.find((m) => m.id === "cloud_ideogram_4"), info);
            check("the manifest declares loras false for cloud_ideogram_4 alone, and build writes it into providers.comfycloud", eq(withLoras, ["cloud_ideogram_4=false"]) && built.providers.comfycloud.loras === false && built.loras === undefined, short(withLoras));
            const run = require("node:child_process").spawnSync(process.execPath, [path.join(ROOT, "tools", "cloud_recipes.js"), "--check"], { encoding: "utf8" });
            check("node tools/cloud_recipes.js --check", run.status === 0 && /^ok: 15 Comfy Cloud recipes match their exports/.test(run.stdout), short((run.stdout || "") + (run.stderr || "")));
        } finally { console.warn = warn; }
    });

    // ---- 15. MOSS-Image Edit on the user's ComfyUI (item 50, docs/PLAN_LORAS.md LR6) ----------------------------------
    // The graph has not run (LR9 runs it): every node against the spec its class has in the fixtures' node list
    // (tools/node_specs.js; TextEncodeMOSSImageEdit and SkipLayerGuidanceDiTSimple written from ComfyUI 0.44.0's V3
    // schemas), as normalize serves it and in the shapes a run queues; Comfy's template values pinned
    // (tools/refs: image_moss_image_edit, the research's copy), so a value reset to the node's default shows too.
    await section("15. the MOSS-Image Edit recipe against its node specs", async () => {
        const { specProblems } = require(path.join(ROOT, "tools", "node_specs.js"));
        const R = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "comfyrefs.js")).href);
        const L = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "loras.js")).href);
        const info = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "refs", "comfy_templates", "object_info.json"), "utf8"));
        const warn = console.warn, warned = [];
        console.warn = (...a) => warned.push(a.join(" "));
        let r;
        try { r = recipes._normalize(rawFile("moss_image_edit_local.json")); } finally { console.warn = warn; }
        const g = r.prompt;
        const classes = [...new Set(Object.values(g).map((n) => n.class_type))].sort();
        check("moss_image_edit_local: a local edit recipe read without a warning; refs image {n} over 4 slots; its LoRA rows after its edit LoRA node (family moss_image); needs exactly its graph's classes, TextEncodeMOSSImageEdit (ComfyUI 0.43) among them",
            !warned.length && r.kind !== "provider" && r.mode === "local" && r.edit === true && r.task === undefined && eq(r.refs, { name: "image {n}", slots: 4 }) && eq(r.loras, { model: "lora", family: "moss_image" })
            && eq([...r.needs].sort(), classes) && r.needs.includes("TextEncodeMOSSImageEdit") && r.needs.includes("LoraLoaderModelOnly") && r.boxes === undefined && r.upsampler === undefined && r.newImage === undefined,
            short({ warned, refs: r.refs, loras: r.loras, needs: r.needs }));
        const lacking = Object.entries(g).filter(([, n]) => !info[n.class_type]).map(([id, n]) => `${id} ${n.class_type}`);
        check("every class of the graph but the canvas node's has its spec in the node list (TextEncodeMOSSImageEdit and SkipLayerGuidanceDiTSimple included)", eq(lacking, ["canvas InpaintCanvas"]), short(lacking));
        const probs = specProblems(g, info);
        check("every node: its required inputs there, every input one its class declares (images.image_0 .. image_9 of the growing input, at least one), combos in their options (model files aside, type moss_image, Moss-Image-Edit), numbers in range, links to nodes of the graph",
            !probs.length, short(probs));
        // what a run queues: the Settings rows wired to the canvas node, then the crop alone (image_1..3 left out), the
        // crop and one picture, and the user's two LoRA rows spliced after the edit LoRA
        const spec = R.comfyRefSpec(r);
        const shapes = {};
        for (const n of [1, 2, 4]) { const q = recipes.toPrompt(r); R.trimSlots(q, spec, n); shapes[`${n} picture${n > 1 ? "s" : ""}`] = q; }
        const lq = recipes.toPrompt(r);
        const spliced = L.spliceLoras(lq, r, [{ name: "moss_style.safetensors", strength: 0.8 }, { name: "moss_other.safetensors", strength: 1 }], info);
        shapes["with two LoRA rows"] = lq;
        const shapeProbs = Object.entries(shapes).flatMap(([what, q]) => specProblems(q, info).map((p) => `${what}: ${p}`));
        check("the queued shapes hold too: the crop alone, two pictures, all four, and two LoRA rows after the edit LoRA (slg on the chain's end)",
            !shapeProbs.length && !("images.image_1" in shapes["1 picture"].pos.inputs) && !("images.image_1" in shapes["1 picture"].neg.inputs) && eq(shapes["1 picture"].neg.inputs["images.image_0"], ["scale0", 0])
            && "images.image_3" in shapes["4 pictures"].pos.inputs && spliced.applied.length === 2 && eq(lq.slg.inputs.model, ["scumble_lora_2", 0]) && eq(lq.scumble_lora_1.inputs.model, ["lora", 0]), short(shapeProbs));
        // Comfy's template values (image_moss_image_edit, ComfyUI 0.43+): the node defaults differ (SLG "7, 8, 9" both,
        // KSampler 20 steps CFG 8, a megapixel step of 1), and the user's model files (SFT bf16, the int8 text encoder)
        const pins = [
            ["unet.unet_name", g.unet.inputs.unet_name, "moss_image_sft_bf16.safetensors"], ["unet.weight_dtype", g.unet.inputs.weight_dtype, "default"],
            ["lora.model", g.lora.inputs.model, ["unet", 0]], ["lora.lora_name", g.lora.inputs.lora_name, "moss_image_edit_lora_rank_64_bf16.safetensors"], ["lora.strength_model", g.lora.inputs.strength_model, 1],
            ["slg.model", g.slg.inputs.model, ["lora", 0]], ["slg.double_layers", g.slg.inputs.double_layers, ""], ["slg.single_layers", g.slg.inputs.single_layers, "22"],
            ["slg.start_percent", g.slg.inputs.start_percent, 0], ["slg.end_percent", g.slg.inputs.end_percent, 1],
            ["clip.clip_name", g.clip.inputs.clip_name, "qwen3.5_9b_int8_convrot.safetensors"], ["clip.type", g.clip.inputs.type, "moss_image"], ["vae.vae_name", g.vae.inputs.vae_name, "flux2-vae_small.safetensors"],
            ["size.image", g.size.inputs.image, ["scale0", 0]], ["latent.width", g.latent.inputs.width, ["size", 0]], ["latent.height", g.latent.inputs.height, ["size", 1]], ["latent.batch_size", g.latent.inputs.batch_size, 1],
            ["ks.model", g.ks.inputs.model, ["slg", 0]], ["ks.seed", g.ks.inputs.seed, ["canvas", 10]], ["ks.steps", g.ks.inputs.steps, 30], ["ks.cfg", g.ks.inputs.cfg, 4],
            ["ks.sampler_name", g.ks.inputs.sampler_name, "euler"], ["ks.scheduler", g.ks.inputs.scheduler, "normal"], ["ks.positive", g.ks.inputs.positive, ["pos", 0]],
            ["ks.negative", g.ks.inputs.negative, ["neg", 0]], ["ks.latent_image", g.ks.inputs.latent_image, ["latent", 0]], ["ks.denoise", g.ks.inputs.denoise, 1],
            ["decode.samples", g.decode.inputs.samples, ["ks", 0]], ["decode.vae", g.decode.inputs.vae, ["vae", 0]],
            ["pos.prompt", g.pos.inputs.prompt, ["canvas", 7]], ["neg.prompt", g.neg.inputs.prompt, ["canvas", 12]],
        ];
        for (const e of ["pos", "neg"]) {
            pins.push([`${e}.clip`, g[e].inputs.clip, ["clip", 0]], [`${e}.vae`, g[e].inputs.vae, ["vae", 0]], [`${e}.edit_format`, g[e].inputs.edit_format, "Moss-Image-Edit"], [`${e}.image_strength`, g[e].inputs.image_strength, 1]);
            for (let k = 0; k < 4; k++) pins.push([`${e}.images.image_${k}`, g[e].inputs[`images.image_${k}`], [`scale${k}`, 0]]);
        }
        for (let k = 0; k < 4; k++) {
            pins.push([`img${k}`, g[`img${k}`].inputs, { image: ["canvas", 0], batch_index: k, length: 1 }]);
            pins.push([`scale${k}`, g[`scale${k}`].inputs, { image: [`img${k}`, 0], upscale_method: "lanczos", megapixels: 1, resolution_steps: 16 }]);
        }
        const off = pins.filter(([, got, want]) => !eq(got, want)).map(([k, got]) => `${k}=${JSON.stringify(got)}`);
        check("Comfy's template values: the edit LoRA at 1 between the UNETLoader and SLG (layer 22, 0 to 1), 30 steps, CFG 4, euler / normal, both encoders Moss-Image-Edit at strength 1 with the VAE and the same four scaled pictures, the latent the crop's scaled size at 1 MP in steps of 16",
            !off.length && Object.keys(g).length === 20, short({ off, nodes: Object.keys(g).length }));
        // the Settings rows: eight slots, the edit LoRA a file row with its download link (a ComfyUI without it is refused
        // with the link before the run, issue #4's missingFilesRefusal), the Megapixels row on the edited picture alone
        const rows = r.settings.map((s) => [s.index, `${s.node}:${s.input}`, s.label]);
        const link = (file) => { for (const list of Object.values(r.models || {})) for (const row of list) { const m = /^(.*?)\s*\((https?:\/\/[^)]+)\)\s*$/.exec(String(row)); if (m && m[1] === file) return m[2]; } return null; };
        const files = [g.unet.inputs.unet_name, g.clip.inputs.clip_name, g.vae.inputs.vae_name, g.lora.inputs.lora_name];
        check("eight Settings rows on slots 1..8: Model, Text encoder, VAE, Edit LoRA, LoRA strength, Steps, CFG, Megapixels (scale0 alone); every default file has its link, the edit LoRA's in Comfy-Org's MOSS-Image repository",
            eq(rows, [[1, "unet:unet_name", "Model"], [2, "clip:clip_name", "Text encoder"], [3, "vae:vae_name", "VAE"], [4, "lora:lora_name", "Edit LoRA"], [5, "lora:strength_model", "LoRA strength"], [6, "ks:steps", "Steps"], [7, "ks:cfg", "CFG"], [8, "scale0:megapixels", "Megapixels"]])
            && files.every((f) => !!link(f)) && link(g.lora.inputs.lora_name) === "https://huggingface.co/Comfy-Org/MOSS-Image/resolve/main/loras/moss_image_edit_lora_rank_64_bf16.safetensors",
            short({ rows, links: files.map(link) }));
        check("the description: ComfyUI 0.43 or newer, the Moss-Image-Edit format on both encoders, the ai-toolkit LoRAs by an own copy, what each picture is for (LR9), run on 0.44, and the licence sentence",
            /0\.43 or newer/.test(r.description) && /both encoders in the Moss-Image-Edit format/.test(r.description) && /ai-toolkit format on both encoders: Edit in ComfyUI/.test(r.description) && /Image 1 is the scene to edit\. @img1 is a picture of the bag to place\."\): a bare/.test(r.description) && /run on ComfyUI 0\.44\./.test(r.description)
            && r.description.includes("The edit LoRA is chinoll's Moss-Image-Edit, rehosted by Comfy-Org, whose repository card says Apache-2.0; chinoll's own repository names no licence for the weights (its code is GPL-3.0). MOSS-Image's weights are Apache-2.0."));
        // the check itself: what a slip in the file would be is caught
        const bad = JSON.parse(JSON.stringify(g));
        bad.neg.inputs.edit_format = "Moss-Image-Edit v2";
        bad.pos.inputs["images.image_10"] = ["scale3", 0];
        bad.pos.inputs.image_strength = 200;
        delete bad.neg.inputs.clip;
        bad.slg.inputs.single_layers = 22;
        bad.clip.inputs.type = "moss";
        bad.ks.inputs.latent_image = ["nope", 0];
        const noPics = JSON.parse(JSON.stringify(g));
        for (let k = 0; k < 4; k++) delete noPics.neg.inputs[`images.image_${k}`];
        const caught = [...specProblems(bad, info), ...specProblems(noPics, info)].join(" | ");
        check("the spec check itself: a format outside the node's three, an eleventh picture input (images.image_10; the node grows to ten), a strength past 100, a missing clip, a layer list that is no text, an unknown CLIP type, a link to no node and an encoder with no picture are each caught",
            ["neg.edit_format=", "pos.images.image_10 unknown", "pos.image_strength=200", "neg.clip missing", "slg.single_layers is no text", "clip.type=", "ks.latent_image links", "neg.images takes at least 1 input, has 0"].every((s) => caught.includes(s)), caught);
    });

    // ---- 16. promptRequired: a recipe whose runs refuse an empty prompt (P-H3-Image) --------------------------------
    // host.promptMissing reads the field on the edit, the API edit and the API Generate new paths; here: which recipes
    // carry it, what normalize keeps, and that Save to recipe, the Comfy Cloud copy and the generated Cloud recipe keep it
    await section("16. promptRequired (P-H3-Image refuses an empty prompt)", async () => {
        const warn = console.warn;
        const warned = [];
        console.warn = (...a) => warned.push(a.join(" "));
        try {
            freshUserData();
            const all = await recipes.list(RECIPES);
            const carry = all.filter((r) => r.promptRequired !== undefined).map((r) => `${r.id}=${r.promptRequired}`).sort();
            check("the three P-H3-Image recipes carry promptRequired true and no other shipped recipe carries it",
                eq(carry, ["cloud_p_h3_image=true", "p_h3_image=true", "p_h3_image_local=true"]) && !warned.some((w) => /promptRequired/.test(w)), short({ carry, warned }));
            const n0 = warned.length;
            const yes = recipes._normalize({ id: "t_yes", kind: "comfy", prompt: {}, promptRequired: "yes" });
            const no = recipes._normalize({ id: "t_no", kind: "comfy", prompt: {}, promptRequired: false });
            const api = recipes._normalize({ id: "t_api", kind: "provider", promptRequired: true, providers: { loopback: { model: "loopback" } } });
            check("normalize: true kept (a provider recipe too, at the top), a value other than true or false dropped with a warning, false dropped quietly",
                !("promptRequired" in yes) && !("promptRequired" in no) && api.promptRequired === true
                && warned.length === n0 + 1 && /t_yes: promptRequired "yes" is no true or false/.test(warned[n0]), short({ said: warned.slice(n0) }));
            const local = all.find((r) => r.id === "p_h3_image_local");
            const workflow = { nodes: [{ id: 1, type: "InpaintCanvas" }], links: [], extra: {} };
            const saved = recipes.fromGraph({ output: recipes.toPrompt(local), workflow, objectInfo: {}, base: local, date: "2026-11-06" });
            const { recipe: d } = recipes.detach(local);
            const nd = recipes._normalize(JSON.parse(JSON.stringify(d)));
            const { recipe: k } = recipes.detach(all.find((r) => r.id === "flux3_klein_local"));
            check("Save to recipe keeps it (GRAPH_KEEPS), the Comfy Cloud copy carries it at the top through normalize, a copy of a recipe without it has none",
                saved.promptRequired === true && d.promptRequired === true && nd.promptRequired === true && k.promptRequired === undefined, short({ saved: saved.promptRequired, copy: d.promptRequired, nd: nd.promptRequired, klein: k.promptRequired }));
            const tool = require(path.join(ROOT, "tools", "cloud_recipes.js"));
            const info = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "refs", "comfy_templates", "object_info.json"), "utf8"));
            const rows = tool.MANIFEST.filter((m) => m.promptRequired).map((m) => m.id);
            const built = tool.build(tool.MANIFEST.find((m) => m.id === "cloud_p_h3_image"), info);
            check("the manifest marks cloud_p_h3_image alone, and build writes promptRequired at the recipe's top (not into the variant)",
                eq(rows, ["cloud_p_h3_image"]) && built.promptRequired === true && built.providers.comfycloud.promptRequired === undefined, short(rows));
        } finally { console.warn = warn; }
    });

    // ---- 17. recipe ids are file names (H1 S9a) -------------------------------------------------------------
    await section("17. a recipe id is a file name: made safe where recipes are read, refused at save", async () => {
        freshUserData();
        const dir = path.join(USERDATA, "recipes");
        fs.mkdirSync(dir, { recursive: true });
        const warn = console.warn, warned = [];
        console.warn = (...a) => warned.push(a.join(" "));
        try {
            const shipped = await recipes.list(RECIPES);
            check("every shipped recipe's id is letters, digits, \".\", \"_\" and \"-\"", shipped.length > 70 && shipped.every((r) => /^[A-Za-z0-9._-]+$/.test(String(r.id))), shipped.filter((r) => !/^[A-Za-z0-9._-]+$/.test(String(r.id))).map((r) => r.id).join(" "));
            const n0 = warned.length;
            const base = { kind: "provider", name: "Hand", providers: { loopback: { model: "loopback" } } };
            fileOf(dir, "hand.json", { ...rawFile("flux2_klein_local.json"), name: "Hand", id: "../settings" });
            fileOf(dir, "other file.json", { ...base, id: "other_id" });
            fileOf(dir, "my recipe.json", { ...base });
            const mine = (await recipes.list(RECIPES)).filter((r) => r.source === "user");
            const hand = mine.find((r) => r.file === "hand.json"), other = mine.find((r) => r.file === "other file.json"), nameless = mine.find((r) => r.file === "my recipe.json");
            check("a hand-written id with a path in it is read as a safe one, with a warning; a file name with a space gives a safe id too",
                hand && hand.id === ".._settings" && nameless && nameless.id === "my_recipe" && other && other.id === "other_id"
                && warned.length === n0 + 2 && /hand\.json: its id "\.\.\/settings" holds characters/.test(warned[n0]), short({ ids: mine.map((r) => r.id), said: warned.slice(n0) }));
            const { recipe: copy } = recipes.detach(hand);
            check("its Comfy Cloud copy's id has no separator either", copy && copy.id === ".._settings_cloud", short(copy && copy.id));
            const refused = await Promise.all(["../settings", "..\\settings", "a/b", "C:x", "", "x y"].map((id) => thrown(() => recipes.save({ ...base, id }))));
            check("save refuses an id outside them, and nothing lands beside the recipes folder", refused.every((m) => /letters, digits/.test(m || "")) && !fs.existsSync(path.join(USERDATA, "settings.json")), short(refused));
            const file = await recipes.save({ ...base, id: "fine_id-2.v" });
            check("a safe id is saved as <id>.json in the recipes folder", path.dirname(file) === dir && path.basename(file) === "fine_id-2.v.json" && fs.existsSync(file));
            const over = await recipes.save({ ...base, id: "other_id", name: "Saved over" });
            const reread = (await recipes.list(RECIPES)).filter((r) => r.id === "other_id");
            check("saving an id a user recipe was read from under another file name writes that file (one id, one file)",
                path.basename(over) === "other file.json" && !fs.existsSync(path.join(dir, "other_id.json")) && reread.length === 1 && reread[0].name === "Saved over", short({ over: path.basename(over), n: reread.length }));
            await recipes.remove("other_id");
            await recipes.remove("my_recipe");
            check("remove deletes the file a recipe was read from, whatever its name", !fs.existsSync(path.join(dir, "other file.json")) && !fs.existsSync(path.join(dir, "my recipe.json")) && fs.existsSync(path.join(dir, "hand.json")));
            const bad = await thrown(() => recipes.remove("../hand")), none = await thrown(() => recipes.remove("not_there"));
            check("remove refuses an unsafe id and says when no recipe of the user's has the id", /bad recipe id/.test(bad || "") && /no recipe of yours/.test(none || "") && fs.existsSync(path.join(dir, "hand.json")), short({ bad, none }));
            await recipes.remove(".._settings");
            check("the made-safe recipe can be removed by its new id (its own file goes)", !fs.existsSync(path.join(dir, "hand.json")));
        } finally { console.warn = warn; }
    });

    // ---- 18. Fibo 2.0 Edit Turbo on the user's ComfyUI -----------------------------------------------------------------
    // The graph has not run: every node against the spec its class has in the fixtures' node list (TextEncodeFibo2 from
    // ComfyUI 0.44.0's /object_info), as normalize serves it and in the shapes a run queues; Comfy's template values pinned
    // (image_fibo2_edit_turbo_pe), so a value reset to the node's default shows too.
    await section("18. the Fibo 2.0 Edit Turbo recipe against its node specs", async () => {
        const { specProblems } = require(path.join(ROOT, "tools", "node_specs.js"));
        const R = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "comfyrefs.js")).href);
        const P = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "comfyprompt.js")).href);
        const info = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "refs", "comfy_templates", "object_info.json"), "utf8"));
        const warn = console.warn, warned = [];
        console.warn = (...a) => warned.push(a.join(" "));
        let r;
        try { r = recipes._normalize(rawFile("fibo2_edit_turbo_local.json")); } finally { console.warn = warn; }
        const g = r.prompt;
        const peOnly = new Set(["TextGenerate", "PreviewAny", "ComfySwitchNode"]);
        const classes = [...new Set(Object.values(g).map((n) => n.class_type))].filter((c) => !peOnly.has(c)).sort();
        check("fibo2_edit_turbo_local: a local edit recipe read without a warning; refs <image_{n}> over 4 slots; its upsampler kept with the prompt as its request; needs the graph's classes but the three wireUpsampler answers for; no boxes, no Generate new route",
            !warned.length && r.kind !== "provider" && r.mode === "local" && r.edit === true && eq(r.refs, { name: "<image_{n}>", slots: 4 }) && eq([...r.needs].sort(), classes) && r.needs.includes("TextEncodeFibo2")
            && r.upsampler && r.upsampler.switch === "pe_switch" && r.upsampler.run === "pe_run" && r.upsampler.show === "pe_show" && eq(r.upsampler.nodes, ["pe_clip", "pe_batch", "pe_run", "pe_show"]) && eq(r.upsampler.request, { edit: "{text}" })
            && r.boxes === undefined && r.newImage === undefined && r.loras === undefined, short({ warned, refs: r.refs, needs: r.needs, up: r.upsampler && r.upsampler.nodes }));
        const lacking = Object.entries(g).filter(([, n]) => !info[n.class_type]).map(([id, n]) => `${id} ${n.class_type}`);
        check("every class of the graph but the canvas node's has its spec in the node list (TextEncodeFibo2 included)", eq(lacking, ["canvas InpaintCanvas"]), short(lacking));
        const probs = specProblems(g, info);
        check("every node: its required inputs there, every input one its class declares (images.image_1 .. of the growing input, CLIP type fibo2, the sampling mode's own inputs), numbers in range, links to nodes", !probs.length, short(probs));
        const spec = R.comfyRefSpec(r);
        const files = ["qwen3vl_4b_bf16.safetensors", "qwen3vl_8b_int8_convrot.safetensors"];
        const shapes = {};
        for (const n of [1, 2, 4]) {
            const on = JSON.parse(JSON.stringify(g));   // as host.queueGenerate has it: the rows' values written, no links to setting outputs
            R.trimSlots(on, spec, n);
            const res = P.wireUpsampler(on, r, { text: "a red coat", pictures: n, files, classes: info });
            if (!res.on) throw new Error("the enhancer did not run");
            shapes[`enhancer on, ${n} picture${n > 1 ? "s" : ""}`] = on;
        }
        const off = JSON.parse(JSON.stringify(g));
        off.pe_switch.inputs.switch = false;
        R.trimSlots(off, spec, 1);
        const offRes = P.wireUpsampler(off, r, { text: "a red coat", pictures: 1, files, classes: info });
        shapes["enhancer off"] = off;
        const shapeProbs = Object.entries(shapes).flatMap(([what, q]) => specProblems(q, info).map((p) => `${what}: ${p}`));
        const peIds = ["pe_clip", "pe_batch", "pe_run", "pe_show", "pe_switch"];
        const on1 = shapes["enhancer on, 1 picture"];
        check("the queued shapes hold: the enhancer on with one, two and four pictures (the crop always, the slots past the batch left out), its caption into the encoder; off, the canvas's prompt straight into the encoder and no enhancer node left",
            !shapeProbs.length && !offRes.on && offRes.note === null && eq(off.encode.inputs.prompt, ["canvas", 7]) && peIds.every((id) => !off[id]) && eq(on1.encode.inputs.prompt, ["pe_run", 0]) && on1.pe_run.inputs.prompt === "a red coat" && !on1.pe_switch
            && eq(on1.encode.inputs["images.image_1"], ["img0", 0]) && !("images.image_2" in on1.encode.inputs) && "images.image_4" in shapes["enhancer on, 4 pictures"].encode.inputs, short(shapeProbs));
        const sys = g.pe_run.inputs.system_prompt;
        const pins = [
            ["unet.unet_name", g.unet.inputs.unet_name, "fibo2_edit_turbo_int8_convrot.safetensors"], ["unet.weight_dtype", g.unet.inputs.weight_dtype, "default"],
            ["clip.clip_name", g.clip.inputs.clip_name, "qwen3vl_4b_bf16.safetensors"], ["clip.type", g.clip.inputs.type, "fibo2"], ["vae.vae_name", g.vae.inputs.vae_name, "flux2-vae.safetensors"],
            ["encode.clip", g.encode.inputs.clip, ["clip", 0]], ["encode.vae", g.encode.inputs.vae, ["vae", 0]], ["encode.negative_prompt", g.encode.inputs.negative_prompt, ""], ["encode.width", g.encode.inputs.width, 0], ["encode.height", g.encode.inputs.height, 0], ["encode.batch_size", g.encode.inputs.batch_size, 1],
            ["ks.model", g.ks.inputs.model, ["unet", 0]], ["ks.seed", g.ks.inputs.seed, ["canvas", 10]], ["ks.steps", g.ks.inputs.steps, 4], ["ks.cfg", g.ks.inputs.cfg, 1], ["ks.sampler_name", g.ks.inputs.sampler_name, "euler"], ["ks.scheduler", g.ks.inputs.scheduler, "simple"],
            ["ks.positive", g.ks.inputs.positive, ["encode", 0]], ["ks.negative", g.ks.inputs.negative, ["encode", 1]], ["ks.latent_image", g.ks.inputs.latent_image, ["encode", 2]], ["ks.denoise", g.ks.inputs.denoise, 1],
            ["decode.samples", g.decode.inputs.samples, ["ks", 0]], ["decode.vae", g.decode.inputs.vae, ["vae", 0]],
            ["pe_clip.clip_name", g.pe_clip.inputs.clip_name, "qwen3vl_8b_int8_convrot.safetensors"], ["pe_clip.type", g.pe_clip.inputs.type, "fibo2"],
            ["pe_run.max_length", g.pe_run.inputs.max_length, 3000], ["pe_run.sampling_mode", g.pe_run.inputs.sampling_mode, "on"], ["pe_run.temperature", g.pe_run.inputs["sampling_mode.temperature"], 0.3], ["pe_run.top_k", g.pe_run.inputs["sampling_mode.top_k"], 20],
            ["pe_run.top_p", g.pe_run.inputs["sampling_mode.top_p"], 0.95], ["pe_run.min_p", g.pe_run.inputs["sampling_mode.min_p"], 0.05], ["pe_run.repetition_penalty", g.pe_run.inputs["sampling_mode.repetition_penalty"], 1.05], ["pe_run.seed", g.pe_run.inputs["sampling_mode.seed"], 1234],
            ["pe_run.thinking", g.pe_run.inputs.thinking, false], ["pe_run.use_default_template", g.pe_run.inputs.use_default_template, true], ["pe_run.mtp", g.pe_run.inputs.mtp, "off"], ["pe_switch.switch", g.pe_switch.inputs.switch, true],
        ];
        for (let k = 0; k < 4; k++) pins.push([`encode.images.image_${k + 1}`, g.encode.inputs[`images.image_${k + 1}`], [`img${k}`, 0]], [`img${k}`, g[`img${k}`].inputs, { image: ["canvas", 0], batch_index: k, length: 1 }]);
        const offPins = pins.filter(([, got, want]) => !eq(got, want)).map(([k, got]) => `${k}=${JSON.stringify(got)}`);
        check("Comfy's template values: 4 steps, CFG 1, euler / simple, width and height 0 (the node's own trained size), the encoder's three outputs into the sampler, an empty negative, the enhancer's sampling values, the system prompt whole",
            !offPins.length && /^You are a highly skilled Creative Director for Visual Adaptation/.test(sys) && /Follow all of the rules above\.$/.test(sys) && sys.length > 11000, short({ offPins, sys: sys.length }));
        const rows = r.settings.map((s) => [s.index, `${s.node}:${s.input}`, s.label]);
        const link = (file) => { for (const list of Object.values(r.models || {})) for (const row of list) { const m = /^(.*?)\s*\((https?:\/\/[^)]+)\)\s*$/.exec(String(row)); if (m && m[1] === file) return m[2]; } return null; };
        const defaults = [g.unet.inputs.unet_name, g.clip.inputs.clip_name, g.vae.inputs.vae_name, g.pe_clip.inputs.clip_name];
        check("seven Settings rows on slots 1..7 (no negative, no megapixels); every default file has its Comfy-Org link",
            eq(rows, [[1, "unet:unet_name", "Model"], [2, "clip:clip_name", "Text encoder"], [3, "vae:vae_name", "VAE"], [4, "ks:steps", "Steps"], [5, "ks:cfg", "CFG"], [6, "pe_switch:switch", "Prompt Enhancer"], [7, "pe_clip:clip_name", "Enhancer model"]])
            && defaults.every((f) => /^https:\/\/huggingface\.co\/Comfy-Org\//.test(link(f) || "")), short({ rows, links: defaults.map(link) }));
        check("the description: not run yet, and the licence in one plain sentence",
            r.description.includes("not run yet") && r.description.includes("Licence: Bria's weights are CC BY-NC 4.0, non-commercial; commercial use needs an agreement with Bria."), short(r.description.slice(-140)));
        const bad = JSON.parse(JSON.stringify(g));
        bad.encode.inputs["images.image_17"] = ["img0", 0];
        bad.encode.inputs.width = -16;
        delete bad.encode.inputs.negative_prompt;
        bad.clip.inputs.type = "fibo";
        bad.ks.inputs.latent_image = ["nope", 0];
        bad.pe_run.inputs.sampling_mode = "maybe";
        const caught = specProblems(bad, info).join(" | ");
        check("the spec check itself: a seventeenth picture input, a negative width, a missing negative prompt, an unknown CLIP type, a link to no node and a sampling mode outside the two",
            ["encode.images.image_17 unknown", "encode.width=-16", "encode.negative_prompt missing", "clip.type=", "ks.latent_image links", "pe_run.sampling_mode="].every((s) => caught.includes(s)), caught);
    });

    if (USERDATA) fs.rmSync(USERDATA, { recursive: true, force: true });
    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + ((err && err.stack) || err)); console.log("FAIL"); process.exit(1); });
