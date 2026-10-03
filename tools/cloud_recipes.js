// The Comfy Cloud recipes Scumble ships (item 35 V6 steps 4 and 5, docs/PLAN_COMFY_VIEW.md): Comfy's own templates as
// Comfy Cloud exports them (tools/refs/comfy_cloud/edit and t2i, MIT, picked by the user on 2026-10-03), read the way Save
// as new recipe reads a graph nobody titled (recipes.fromWorkflow + fromCloudGraph, the roles from the graph), written to
// recipes/<id>.json with a name and a description of their own. An image-edit template makes an edit recipe, a
// text-to-image one a recipe for Generate new alone; `text` pairs a text-to-image template with an edit recipe of the
// same model (its text route, `text.options`).
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

const SRC = path.join(ROOT, "tools", "refs", "comfy_cloud");
const INFO = path.join(ROOT, "tools", "refs", "comfy_templates", "object_info.json");
const OUT = path.join(ROOT, "recipes");
const LIVE = "Comfy's template as Comfy Cloud has it; not run on Comfy Cloud from Scumble yet.";
const SIZES = [768, 1024, 1280, 1536, 2048];   // the long sides Generate new offers (the dialog's own go to 4096)

/** The shipped ones: the export, the recipe's id, its name and what it is for. */
const MANIFEST = [
    { file: "edit/image_boogu_image_0_1_edit.json", id: "cloud_boogu_image_edit", name: "Boogu Image 0.1 Edit (Comfy Cloud)",
        about: "Boogu's 10B image editor: objects in, out or replaced, materials, backgrounds, styles and in-picture text, from one picture (the crop)." },
    { file: "edit/image_flux2_klein_image_edit_9b_base_1_image.json", id: "cloud_flux2_klein_9b", name: "Flux.2 Klein 9B base (Comfy Cloud)",
        text: "t2i/image_flux2_text_to_image_9b.json",
        about: "FLUX.2 [klein] 9B base edits the crop from the prompt, one picture; Generate new makes a new image with its text-to-image template." },
    { file: "edit/image_flux2_klein_image_edit_9b_base_multi_image.json", id: "cloud_flux2_klein_9b_multi", name: "Flux.2 Klein 9B base, two pictures (Comfy Cloud)",
        about: "FLUX.2 [klein] 9B base with a second picture: the crop and the Original or your first reference layer." },
    { file: "edit/image_mage_flow_edit_turbo_int8.json", id: "cloud_mage_flow_edit_turbo", name: "Mage Flow Edit Turbo (Comfy Cloud)",
        about: "Mage-Flow-Edit Turbo, a 4B editor in four steps: the crop and a second picture (the Original or your first reference layer)." },
    { file: "edit/image_qwen_image_2_1_image_edit.json", id: "cloud_qwen_image_2_1_edit", name: "Qwen Image 2.1 Edit (Comfy Cloud)",
        text: "t2i/image_qwen_image_2_1_t2i.json", refs: "<image{n}>", limits: { step: 32 },
        about: "Qwen Image 2.1 edits the crop with a second picture (the Original or your first reference layer); the template's prompt enhancer stays off for an edit. Generate new makes a new image with its text-to-image template." },
    { file: "edit/image_qwen_image_edit_2509.json", id: "cloud_qwen_image_edit_2509", name: "Qwen Image Edit 2509 (Comfy Cloud)",
        about: "Qwen Image Edit 2509 with its 4-step Lightning LoRA: the crop and a second picture (the Original or your first reference layer)." },
    // Comfy's "Image Edit (Flux.2 Dev)": the crop is its picture, and the new image takes the crop's size
    { file: "t2i/image_flux2_dev.json", id: "cloud_flux2_dev", name: "Flux.2 dev (Comfy Cloud)",
        about: "FLUX.2 [dev] edits the crop from the prompt (Comfy's Flux.2 dev image-edit template), one picture." },
    // text to image alone: Generate new
    { file: "t2i/image_anima_base_v1.json", id: "cloud_anima_base", name: "Anima base 1.0 (Comfy Cloud)", sizes: [768, 1024, 1280],
        about: "Anima base 1.0, a 2B anime and illustration model: a new image from the prompt (Generate new)." },
    { file: "t2i/image_anima_preview.json", id: "cloud_anima_preview", name: "Anima preview (Comfy Cloud)", sizes: [768, 1024, 1280],
        about: "The Anima preview, a 2B anime and illustration model: a new image from the prompt (Generate new)." },
    { file: "t2i/image_ideogram4_t2i.json", id: "cloud_ideogram_4", name: "Ideogram 4 (Comfy Cloud)",
        about: "Ideogram 4's open weights: a new image from the prompt, strong at lettering (Generate new)." },
    { file: "t2i/image_krea2_turbo_t2i.json", id: "cloud_krea_2_turbo", name: "Krea 2 Turbo (Comfy Cloud)",
        about: "Krea 2 Turbo with the template's prompt enhancer: a new image from the prompt (Generate new)." },
    { file: "t2i/image_mage_flow_t2i_int8.json", id: "cloud_mage_flow", name: "Mage Flow (Comfy Cloud)",
        about: "Mage-Flow, 512 to 2048 px a side: a new image from the prompt (Generate new)." },
    { file: "t2i/image_z_image_turbo.json", id: "cloud_z_image_turbo", name: "Z-Image Turbo (Comfy Cloud)",
        about: "Z-Image Turbo: a new image from the prompt in a few steps (Generate new)." },
];

/** A template export through the import path: the recipe fromCloudGraph makes of it. */
function read(file, name, info) {
    const wf = JSON.parse(fs.readFileSync(path.join(SRC, file), "utf8"));
    const flat = recipes.fromWorkflow(wf, info, { file, date: "2026-10-03" }, { noCanvas: true }).prompt;
    return recipes.fromCloudGraph({ output: flat, workflow: wf, name, ids: [], date: "2026-10-03", promoted: recipes.promotedOf(wf) });
}

function build(m, info) {
    const v = read(m.file, m.name, info).providers.comfycloud;
    const model = m.name.replace(/ \(Comfy Cloud\)$/, "");
    // a model's own name for its pictures (Qwen Image 2.1: <image1>) and its own size steps, where the reading has none
    const variant = { ...v, model, note: `Comfy's template, unchanged. ${v.note}`, ...(m.refs ? { refs: { name: m.refs } } : {}), ...(m.limits ? { limits: { ...v.limits, ...m.limits } } : {}) };
    if (variant.text) variant.text = { ...variant.text, model, sizes: m.sizes || SIZES };   // a text-to-image template
    if (m.text) {
        // the same model's text-to-image template as this recipe's text route (Generate new)
        const t = read(m.text, m.name, info).providers.comfycloud;
        variant.text = { model, options: t.options, sizes: m.sizes || SIZES };
        variant.note += ` Generate new: ${t.note}`;
    }
    const stitch = variant.edit === false ? "" : " Scumble crops and stitches.";
    return {
        id: m.id, kind: "provider", task: "edit", name: m.name, family: "Comfy Cloud",
        description: `${m.about} Runs on your Comfy Cloud key.${stitch} ${LIVE}`,
        default: "comfycloud",
        providers: { comfycloud: variant },
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
