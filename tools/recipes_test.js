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
        const want = { flux2_klein_local: { pictures: 4, values: ["prompt", "seed"] }, qwen_image_edit_2_1_local: { pictures: 10, values: ["negative", "prompt", "seed"] }, upscale_model_local: { pictures: 1, values: [] } };
        for (const r of comfy) {
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
            6: { class_type: "KSampler", inputs: { seed: 1, model: ["8", 0] }, _meta: { title: "Scumble seed" } },
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

    if (USERDATA) fs.rmSync(USERDATA, { recursive: true, force: true });
    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + ((err && err.stack) || err)); console.log("FAIL"); process.exit(1); });
