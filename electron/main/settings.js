// Settings and the autosaved editor state (autosave.js), both plain JSON files in the user data folder.
// Secrets (API keys, remote auth) never go here: they belong to keys.js (safeStorage).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const autosave = require("./autosave");

const DEFAULTS = {
    // auth: { type: "none" | "basic" | "bearer" | "header", user, header }; the secret is in keys.js
    comfy: { url: "http://127.0.0.1:8188", auth: { type: "none" } },
    recipe: "flux2_klein_local",
    recipeProviders: {},   // recipe id -> chosen provider id for model recipes with several providers
    // InpaintCanvas node widgets, filled into the recipe's canvas node on every run
    nodeParams: { padding: 64, target_size: 1024, feather: 16, multiple_of: 64 },
    // in-app helper models (electron/main/onnx): device auto|gpu|cpu, model folder (null =
    // <userData>/models, or a ComfyUI models folder), the SAM2, matting and inpaint (Remove) model ids
    helpers: { device: "auto", dir: null, sam2: "sam2_base_plus", matting: "birefnet_lite", inpaint: "lama" },
    updates: { check: true },   // check GitHub Releases at start (electron/main/updater.js)
    // exported PNGs carry the prompt, seed and recipe as text chunks (the Export section's switch; docs/PLAN_0_1_29.md 3f);
    // on unless the user turns it off (the user, 2026-09-27; off from 0.1.30 to 0.1.31)
    embedRecipe: true,
    // prompt upsampling on a local or self-hosted OpenAI-compatible server (Ollama, LM
    // Studio, vLLM, a proxy); an optional key lives in keys.js under the name "compat"
    // `models` are the rows the user added under Settings > Language models
    // (electron/main/llm_custom.js): { provider, model, label, upsample, assistant, vision }
    // `refPictures: false` keeps the reference pictures the prompt names away from the upsampling model (llm.js ask,
    // item 26 step 26d2); absent means on. It is deliberately not a default here: set() writes the whole object, so a
    // stored default could no longer be told from the user's choice (the embedRecipe trap in get() below)
    llm: { compat: { url: "", model: "" }, models: [] },
    // which prompt instruction template (electron/main/prompts.js) each use takes; "" = built in
    promptTemplates: { upsample: "", generate: "" },
    // above this many MB in the GPU process the shell releases the caches of the tabs that
    // are not in front (renderer/shell.js watchMemory); 0 switches the watch off
    memory: { gpuLimitMB: 3072, cardMinFreeMB: 2048, atlasMB: 512 },
    // the undo history's depth per document (renderer/shell.js applyHistoryDepth, docs/PLAN_0_1_31.md §2): steps, and
    // the MB of the copies brush strokes and selections keep (whole-layer steps count no bytes); the editor's own
    // defaults are the same (MAX_UNDO, MAX_UNDO_BYTES)
    history: { steps: 30, mb: 384 },
    // the in-app assistant (electron/main/assistant/index.js holds the values; docs/PLAN_ASSISTANT.md §2
    // row 27). `get()` merges only this level, so a stored `assistant` object replaces the whole default:
    // every writer writes the whole merged object
    assistant: { ...require("./assistant/index.js").DEFAULTS, noticed: {} },
    appearance: { skin: "", refused: null },  // Settings › Appearance (docs/SKINS.md); "" = the default look
    window: null,
    comfyView: null,   // the ComfyUI window (electron/main/comfyview.js): { bounds, maximized, target: "comfy" | "cloud" }
};

function file(name) {
    return path.join(app.getPath("userData"), name);
}

function readJson(name, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file(name), "utf8"));
    } catch (_) {
        return fallback;
    }
}

function writeJson(name, value) {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    const tmp = file(name + ".tmp");
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file(name));
}

let cache = null;

function get() {
    if (!cache) {
        const stored = readJson("settings.json", {});
        // 0.1.30 and 0.1.31 stored their default `embedRecipe: false` with every write (set() writes the whole object); it
        // counts as the user's only when the switch itself wrote it, which marks it (host.setEmbedRecipe, since 0.1.32)
        if (stored && stored.embedRecipe === false && !stored.embedRecipeChosen) delete stored.embedRecipe;
        cache = { ...DEFAULTS, ...stored };
    }
    return cache;
}

function set(patch) {
    cache = { ...get(), ...(patch || {}) };
    writeJson("settings.json", cache);
    return cache;
}

/** The editor's autosave bundle of the last session (a string, or null), or of an earlier generation (autosave.js). */
function loadState(gen) {
    return autosave.load(app.getPath("userData"), gen);
}

function saveState(state) {
    autosave.save(app.getPath("userData"), state);
}

module.exports = { get, set, loadState, saveState, DEFAULTS };
