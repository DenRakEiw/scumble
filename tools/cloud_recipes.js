// The Comfy Cloud recipes Scumble ships (item 35 V6 step 4, docs/PLAN_COMFY_VIEW.md): Comfy's own templates as Comfy
// Cloud exports them (tools/refs/comfy_cloud/, MIT, picked by the user on 2026-10-03), read the way Save as new recipe
// reads a graph nobody titled (recipes.fromWorkflow + fromCloudGraph, the roles from the graph), written to
// recipes/<id>.json with a name and a description of their own.
//   node tools/cloud_recipes.js            write the recipe files
//   node tools/cloud_recipes.js --check    exit 1 when a file differs from what the exports give (recipes_test.js)
// The widget order of each node comes from the fixtures' node list (tools/refs/comfy_templates/object_info.json).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const orig = Module._load;
Module._load = function (request, ...rest) {
    if (request === "electron") return { app: { getPath: () => ROOT } };
    return orig.call(this, request, ...rest);
};
const recipes = require(path.join(ROOT, "electron", "main", "recipes.js"));
Module._load = orig;

const SRC = path.join(ROOT, "tools", "refs", "comfy_cloud", "edit");
const INFO = path.join(ROOT, "tools", "refs", "comfy_templates", "object_info.json");
const OUT = path.join(ROOT, "recipes");
const LIVE = "Comfy's template as Comfy Cloud has it; not run on Comfy Cloud from Scumble yet.";

/** The shipped ones: the export, the recipe's id, its name and what it is for. */
const MANIFEST = [
    { file: "image_boogu_image_0_1_edit.json", id: "cloud_boogu_image_edit", name: "Boogu Image 0.1 Edit (Comfy Cloud)",
        about: "Boogu's 10B image editor: objects in, out or replaced, materials, backgrounds, styles and in-picture text, from one picture (the crop)." },
    { file: "image_flux2_klein_image_edit_9b_base_1_image.json", id: "cloud_flux2_klein_9b", name: "Flux.2 Klein 9B base (Comfy Cloud)",
        about: "FLUX.2 [klein] 9B base edits the crop from the prompt, one picture." },
    { file: "image_flux2_klein_image_edit_9b_base_multi_image.json", id: "cloud_flux2_klein_9b_multi", name: "Flux.2 Klein 9B base, two pictures (Comfy Cloud)",
        about: "FLUX.2 [klein] 9B base with a second picture: the crop and the Original or your first reference layer." },
    { file: "image_mage_flow_edit_turbo_int8.json", id: "cloud_mage_flow_edit_turbo", name: "Mage Flow Edit Turbo (Comfy Cloud)",
        about: "Mage-Flow-Edit Turbo, a 4B editor in four steps: the crop and a second picture (the Original or your first reference layer)." },
    { file: "image_qwen_image_2_1_image_edit.json", id: "cloud_qwen_image_2_1_edit", name: "Qwen Image 2.1 Edit (Comfy Cloud)",
        about: "Qwen Image 2.1 edits the crop with a second picture (the Original or your first reference layer), with the template's prompt enhancer and negative prompt." },
    { file: "image_qwen_image_edit_2509.json", id: "cloud_qwen_image_edit_2509", name: "Qwen Image Edit 2509 (Comfy Cloud)",
        about: "Qwen Image Edit 2509 with its 4-step Lightning LoRA: the crop and a second picture (the Original or your first reference layer)." },
];

function build(m, info) {
    const wf = JSON.parse(fs.readFileSync(path.join(SRC, m.file), "utf8"));
    const flat = recipes.fromWorkflow(wf, info, { file: m.file, date: "2026-10-03" }, { noCanvas: true }).prompt;
    const made = recipes.fromCloudGraph({ output: flat, workflow: wf, name: m.name, ids: [], date: "2026-10-03", promoted: recipes.promotedOf(wf) });
    const v = made.providers.comfycloud;
    return {
        id: m.id, kind: "provider", task: "edit", name: m.name, family: "Comfy Cloud",
        description: `${m.about} Runs on your Comfy Cloud key; Scumble crops and stitches. ${LIVE}`,
        default: "comfycloud",
        providers: { comfycloud: { ...v, model: m.name.replace(/ \(Comfy Cloud\)$/, ""), note: `Comfy's template, unchanged. ${v.note}` } },
    };
}

function main() {
    const check = process.argv.includes("--check");
    const info = JSON.parse(fs.readFileSync(INFO, "utf8"));
    const stale = [];
    for (const m of MANIFEST) {
        const text = JSON.stringify(build(m, info), null, 2) + "\n";
        const dest = path.join(OUT, `${m.id}.json`);
        if (check) {
            if (!fs.existsSync(dest) || fs.readFileSync(dest, "utf8") !== text) stale.push(m.id);
        } else {
            fs.writeFileSync(dest, text);
            console.log(`wrote recipes/${m.id}.json`);
        }
    }
    if (check) {
        console.log(stale.length ? `stale: ${stale.join(", ")} (node tools/cloud_recipes.js)` : `ok: ${MANIFEST.length} Comfy Cloud recipes match their exports`);
        process.exit(stale.length ? 1 : 0);
    }
}

if (require.main === module) main();
module.exports = { MANIFEST, build };
