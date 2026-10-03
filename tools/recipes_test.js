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

    await section("3. refs.name (docs/PLAN_REFS.md C3)", async () => {
        const recipes = loadRecipes();
        // what each model's docs call its pictures; every other provider recipe takes the default
        const WANT = {
            flux2_pro: "image {n}", flux2_flex: "image {n}", flux2_max: "image {n}", flux2_klein: "image {n}",
            nano_banana_2: "image {n}", nano_banana_2_lite: "image {n}", nano_banana_pro: "image {n}", grok_imagine: "image {n}", reve: "image {n}",
            gpt_image_2: "Image {n}", gpt_image_2_5_flare: "Image {n}", gpt_image_2_5_sunburst: "Image {n}",
            seedream_4_5: "Image {n}", seedream_5_lite: "Image {n}", seedream_5_pro: "Image {n}", qwen_image_edit: "Image {n}", hy_image_3_5: "Image {n}",
            qwen_image_2_1: "<image{n}>",
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

    if (USERDATA) fs.rmSync(USERDATA, { recursive: true, force: true });
    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + ((err && err.stack) || err)); console.log("FAIL"); process.exit(1); });
