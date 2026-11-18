// The ComfyUI window's Save to recipe / Save as new recipe (electron/main/comfyview.js ComfyView.save), in plain Node:
//   node tools/comfyview_save_test.js
// `electron` is stubbed and save() runs on a stand-in for the window (its state fields, a scripted page read, a
// recorded saveRecipe), so what reaches main's saveRecipe is read without a window. It checks which recipe a save
// hands on as `heldId`: the held one only while the page still shows that recipe's graph (review
// main-net/save-as-new-inherits-held-recipe-across-tabs).
"use strict";

const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const orig = Module._load;
Module._load = function (request, parent, ...rest) {
    if (request === "electron") return { app: { getPath: () => ROOT, on() {} }, BaseWindow: class {}, WebContentsView: class {}, session: {}, ipcMain: { handle() {}, on() {} }, dialog: {}, shell: {} };
    return orig.call(this, request, parent, ...rest);
};
let ComfyView;
try { ({ ComfyView } = require(path.join(ROOT, "electron", "main", "comfyview.js"))); } finally { Module._load = orig; }

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}

const OUTPUT = { 1: { class_type: "InpaintCanvas", inputs: {} }, 2: { class_type: "KSampler", inputs: { steps: 20 } } };
const WORKFLOW = { nodes: [{ id: 1, type: "InpaintCanvas" }, { id: 2, type: "KSampler" }], links: [] };
const HELD = { id: "relight_qwen_local", name: "Relight" };

/**
 * A stand-in for the window as save() reads it. `page` is what the page's read answers ({ tab, tabChanged }); `over`
 * replaces state fields (loaded, loadedTab, recipe ...).
 */
function view(page, over = {}) {
    const sent = [];
    const v = {
        isOpen: true, phase: "page", pageReady: true, can: { api: true, graphData: true, read: true }, frontend: "1.58.5",
        readyGen: 1, recipe: HELD, loaded: HELD.id, loadedTab: "tab-held", saveNote: "", recipeNote: "",
        sendState() {},
        async checkReady() { return true; },
        async objectInfo() { return {}; },
        page: { webContents: { async executeJavaScript(js) {
            // the read (READ_JS answers the graph); any other script is the tab tag after a save as new
            if (/graphToPrompt/.test(js)) return { ok: true, tab: page.tab, tabChanged: !!page.tabChanged, workflow: JSON.stringify(WORKFLOW), output: JSON.stringify(OUTPUT), values: null };
            return "tab-new";
        } } },
        async saveRecipe(req) { sent.push(req); return { recipe: { id: req.name ? "new_recipe" : req.heldId, name: req.name || "Relight" }, message: "saved" }; },
        ...over,
    };
    v.sent = sent;
    v.run = (opts) => ComfyView.prototype.save.call(v, opts);
    return v;
}

async function main() {
    // 1. on the held recipe's own tab
    let v = view({ tab: "tab-held" });
    let r = await v.run({ asNew: false });
    check("Save to recipe on the held recipe's tab: saved over it (heldId, no name)", r.ok && v.sent.length === 1 && v.sent[0].heldId === HELD.id && v.sent[0].name === "", JSON.stringify([r, v.sent.map((s) => [s.heldId, s.name])]));
    v = view({ tab: "tab-held" });
    r = await v.run({ asNew: true, name: "Mine" });
    check("Save as new recipe on the held recipe's tab: the held recipe hands on its fields (heldId), the window holds the new one",
        r.ok && v.sent.length === 1 && v.sent[0].heldId === HELD.id && v.sent[0].name === "Mine" && v.recipe.id === "new_recipe" && v.loaded === "new_recipe" && v.loadedTab === "tab-new",
        JSON.stringify([r, v.sent.map((s) => [s.heldId, s.name]), v.loaded, v.loadedTab]));

    // 2. the page shows another workflow tab than the one the held recipe was loaded into
    for (const [what, page] of [["another tab", { tab: "tab-other" }], ["a tab that changed during the read", { tab: "tab-held", tabChanged: true }]]) {
        v = view(page);
        r = await v.run({ asNew: false });
        check(`Save to recipe on ${what}: refused, nothing saved`, !r.ok && v.sent.length === 0 && /another graph/.test(r.message), JSON.stringify(r));
        v = view(page);
        r = await v.run({ asNew: true, name: "Mine" });
        check(`Save as new recipe on ${what}: saved from the graph alone (no heldId)`, r.ok && v.sent.length === 1 && v.sent[0].heldId === null && v.sent[0].name === "Mine", JSON.stringify([r, v.sent.map((s) => [s.heldId, s.name])]));
    }

    // 3. the held recipe never loaded into the page (its load failed and an earlier graph stayed up)
    v = view({ tab: "tab-held" }, { loaded: null, loadedTab: null });
    r = await v.run({ asNew: true, name: "Mine" });
    check("Save as new recipe when the held recipe never loaded: no heldId", r.ok && v.sent.length === 1 && v.sent[0].heldId === null, JSON.stringify([r, v.sent.map((s) => [s.heldId, s.name])]));

    // 4. no recipe held at all: a new recipe from the graph, Save to recipe refused
    v = view({ tab: "tab-x" }, { recipe: null, loaded: null, loadedTab: null });
    r = await v.run({ asNew: true, name: "Mine" });
    const none = await view({ tab: "tab-x" }, { recipe: null, loaded: null, loadedTab: null }).run({ asNew: false });
    check("no recipe held: Save as new recipe goes without heldId, Save to recipe is refused", r.ok && v.sent[0].heldId === null && !none.ok && /holds no recipe/.test(none.message), JSON.stringify([r, none]));

    // 5. a page without tab tags (both null): the same tab as far as the window can tell, as Save to recipe reads it
    v = view({ tab: null }, { loadedTab: null });
    r = await v.run({ asNew: true, name: "Mine" });
    check("a page that tags no tab: the held recipe still hands on its fields", r.ok && v.sent[0].heldId === HELD.id, JSON.stringify(v.sent.map((s) => [s.heldId, s.name])));

    const failed = results.filter((x) => !x).length;
    console.log(`${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + ((err && err.stack) || err)); console.log("FAIL"); process.exit(1); });
