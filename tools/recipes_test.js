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

    await section("3. refs.name (docs/PLAN_REFS.md C3)", async () => {
        const recipes = loadRecipes();
        // what each model's docs call its pictures; every other provider recipe takes the default
        const WANT = {
            flux2_pro: "image {n}", flux2_flex: "image {n}", flux2_max: "image {n}", flux2_klein: "image {n}",
            nano_banana_2: "image {n}", nano_banana_2_lite: "image {n}", nano_banana_pro: "image {n}", grok_imagine: "image {n}", reve: "image {n}",
            gpt_image_2: "Image {n}", gpt_image_2_5_flare: "Image {n}", gpt_image_2_5_sunburst: "Image {n}",
            seedream_4_5: "Image {n}", seedream_5_lite: "Image {n}", seedream_5_pro: "Image {n}", qwen_image_edit: "Image {n}", hy_image_3_5: "Image {n}",
            qwen_image_2_1: "<image{n}>", cloud_qwen_image_2_1_edit: "<image{n}>",
        };
        const wrong = [];
        for (const name of fs.readdirSync(RECIPES).filter((n) => n.endsWith(".json"))) {
            const raw = rawFile(name);
            const r = recipes._normalize(JSON.parse(JSON.stringify(raw)));
            if (r.kind !== "provider") {
                if (JSON.stringify(r.refs) !== JSON.stringify(raw.refs)) wrong.push(`${r.id}: a ComfyUI recipe's refs changed`);
                continue;
            }
            const want = WANT[r.id] || "image {n}";
            for (const [pid, v] of Object.entries(r.providers)) if (!v.refs || v.refs.name !== want) wrong.push(`${r.id}/${pid}: ${short(v.refs)}, not ${want}`);
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
            gpt_image_2_5_flare: { toapis: {}, openai: {}, wavespeed: { model: "openai/gpt-image-2.5-flare/edit" }, openrouter: {}, comfyrouter: {}, oxen: {}, magnific: { model: "text-to-image/gpt-image-2-5-edit" } },
            gpt_image_2_5_sunburst: { toapis: {}, openai: {}, wavespeed: { model: "openai/gpt-image-2.5-sunburst/edit" }, openrouter: {}, comfyrouter: {}, oxen: {}, magnific: { model: "text-to-image/gpt-image-2-5-edit" } },
            nano_banana_2: { toapis: {}, gemini: {}, fal: { model: "fal-ai/nano-banana-2/edit", options: { aspect_ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] } }, replicate: {}, wavespeed: { model: "google/nano-banana-2/edit" }, openrouter: {}, comfyrouter: {}, oxen: {} },
            nano_banana_2_lite: { toapis: {}, gemini: {}, wavespeed: { model: "google/nano-banana-2-lite/edit" }, openrouter: {}, comfyrouter: {}, oxen: {} },
            nano_banana_pro: { toapis: {}, gemini: {}, fal: { model: "fal-ai/nano-banana-pro/edit", options: { aspect_ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] } }, replicate: {}, wavespeed: { model: "google/nano-banana-pro/edit" }, openrouter: {}, comfyrouter: {}, oxen: {} },
            seedream_4_5: { magnific: { model: "text-to-image/seedream-v4-5-edit" } },
            seedream_5_lite: { toapis: {}, ark: {}, fal: { model: "fal-ai/bytedance/seedream/v5/lite/edit", options: { sizing: "image_size", pixels: [3686400, 16777216] } }, replicate: {}, wavespeed: { model: "bytedance/seedream-v5.0-lite/edit" }, openrouter: {}, comfyrouter: {}, magnific: { model: "text-to-image/seedream-v5-lite-edit" } },
            seedream_5_pro: { toapis: {}, ark: {}, fal: { model: "bytedance/seedream/v5/pro/edit", options: { sizing: "image_size", pixels: [1048576, 4194304] } }, wavespeed: { model: "bytedance/seedream-v5.0-pro/edit" }, openrouter: {}, comfyrouter: {}, oxen: {}, magnific: { model: "text-to-image/seedream-v5-pro-edit" } },
            qwen_image_edit: { toapis: {}, comfyrouter: {}, oxen: {}, wavespeed: {} },
            qwen_image_2_1: { oxen: {} },
            hy_image_3_5: { comfypartner: {} },
            grok_imagine: { fal: { model: "xai/grok-imagine-image/v2.0/edit" }, openrouter: {}, oxen: { model: "xai-grok-imagine-image-edit" } },
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
        check(`every shipped variant with a text shape carries the table's text.refs, normalised (${withRefs} take references of ${withText})`, !wrong.length && withRefs === 104, wrong.slice(0, 5).join(" | ") || `${withRefs} with text.refs`);
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
        const want = { flux2_klein_local: { pictures: 4, values: ["prompt", "seed"] }, qwen_image_edit_2_1_local: { pictures: 10, values: ["negative", "prompt", "seed"] }, upscale_model_local: { pictures: 1, values: [] }, realism_pass: { refused: /Cloud copy/ } };
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
            check(`${r.id}: no Inpaint Canvas node and nothing that points at it, a SaveImage on the result`,
                !needs.includes("InpaintCanvas") && !Object.values(g).some((n) => n.class_type === "InpaintCanvas" || n.class_type === "ImageFromBatch") && !dangling.length && save && save.inputs.images[0] === res[0] && save.inputs.images[1] === +res[1],
                short({ dangling, needs }));
            check(`${r.id}: its pictures as LoadImage nodes (${w.pictures}), the run's values (${(w.values || []).join(", ") || "none"}), no mask`,
                v.options.pictures === w.pictures && pics.length === w.pictures && eq(Object.keys(v.options.values).sort(), w.values) && v.options.mask === false && v.input === "edit" && !notes.length,
                short({ pictures: v.options.pictures, values: v.options.values, notes }));
            const n = recipes._normalize(JSON.parse(JSON.stringify(d)));
            const rowsOk = v.settings.length === r.settings.length && v.settings.every((s, i) => s.key === `${r.settings[i].node}|${r.settings[i].input}` && s.label === r.settings[i].label && s.index === r.settings[i].index);
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
        };
        check("the manifest ships the thirteen", eq(tool.MANIFEST.map((m) => m.id).sort(), Object.keys(want).sort()), short(tool.MANIFEST.map((m) => m.id)));
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
        check("all thirteen are listed as shipped Comfy Cloud recipes: pictures titled, prompt and seed read (the negative where the template has one), their SaveImage, no node without inputs, the layout kept; the text-to-image ones (alone or as an edit recipe's text route) with their size", !bad.length, short(bad));
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

    if (USERDATA) fs.rmSync(USERDATA, { recursive: true, force: true });
    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + ((err && err.stack) || err)); console.log("FAIL"); process.exit(1); });
