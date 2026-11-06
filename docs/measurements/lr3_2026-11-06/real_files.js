// How the user's LoRA files read through LR3's code (read-only: loraheader.headerFor opens each file for reading and
// reads its header alone). Usage: node real_files.js <worktree> <ComfyUI models dir> [folders...]
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

(async () => {
    const [wt, dir, ...folders] = process.argv.slice(2);
    const H = require(path.join(wt, "electron", "main", "loraheader.js"));
    const L = await import(pathToFileURL(path.join(wt, "renderer", "editor", "loras.js")).href);
    const recipes = ["flux2_klein_local", "flux3_klein_local", "qwen_image_edit_2_1_local", "moss_image_local"].map((id) => JSON.parse(fs.readFileSync(path.join(wt, "recipes", id + ".json"), "utf8")));
    const fams = recipes.map((r) => [r.id, L.recipeFamily(r)]);
    console.log("recipe families:", JSON.stringify(fams));
    const pick = (process.env.PICK || "").split(",").filter(Boolean);
    for (const folder of folders) {
        const root = path.join(dir, "loras", folder);
        const tally = new Map();
        for (const fn of fs.readdirSync(root)) {
            if (!fn.endsWith(".safetensors")) continue;
            const name = folder + "\\" + fn;
            const res = await H.headerFor({ url: "http://127.0.0.1:8188", hostname: "x", dir, name });
            const fam = L.familyOf(res.header, L.loraFolder(name));
            const line = fam ? fam.label : "(nothing)";
            const amber = recipes.map((r) => { const h = L.loraHint(fam, L.recipeFamily(r)); return h && h.kind === "mismatch" ? "A" : "."; }).join("");
            const key = `${line} [${amber}]`;
            tally.set(key, (tally.get(key) || 0) + 1);
            if (pick.some((p) => fn.includes(p))) {
                const size = JSON.stringify(res.header).length;
                console.log(`  ${name}: ${line} [${amber}] triggers ${JSON.stringify(L.loraTriggers(res.header))} answer ${size} B, ${res.header ? res.header.modules.length : 0} modules, meta ${JSON.stringify(res.header && res.header.metadata.ss_base_model_version)}`);
            }
        }
        console.log(`=== ${folder}`);
        for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
    }
    console.log("amber columns: " + recipes.map((r) => r.id).join(", "));
})();
