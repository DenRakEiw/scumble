// WaveSpeed text route: every shipped variant whose editing model sits under /edit and which has no references
// makes a new image on <id>/text-to-image, not on the bare id (BUGS.md, found 2026-10-07; those pages answer 404).
// Seedream, Qwen, Ideogram and FLUX.1 Fill name their own ids and are held to the ids that answered 200.
// Plain Node, offline:  node tools/wavespeed_text_test.js
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const orig = require("node:module")._load;
require("node:module")._load = function (request, ...rest) { return request === "electron" ? { app: { getPath: () => ROOT } } : orig.call(this, request, ...rest); };
let normalize;
try { normalize = require(path.join(ROOT, "electron", "main", "recipes.js"))._normalize; } finally { require("node:module")._load = orig; }

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}${ok || !detail ? "" : "  -> " + detail}`);
}

// Bare ids that answered 200 on wavespeed.ai/models/<id> on 2026-10-07 (the text route of these is the bare id).
const BARE_OK = new Set([
    "bytedance/seedream-v5.0-lite", "bytedance/seedream-v5.0-pro", "ideogram-ai/ideogram-v4.5",
]);

const dir = path.join(ROOT, "recipes");
let seen = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (!raw.providers || !raw.providers.wavespeed) continue;
    const n = normalize(JSON.parse(JSON.stringify(raw)));
    const v = n.providers.wavespeed;
    if (!v || !v.text) continue;
    seen++;
    const edit = String(v.model);
    const text = v.text.model;
    const bare = edit.replace(/\/(edit|inpaint|fill)$/, "");
    if (/\/edit$/.test(edit) && !BARE_OK.has(text)) {
        check(`${f}: WaveSpeed text route ${text} is <id>/text-to-image`, text === bare + "/text-to-image", text);
    } else {
        check(`${f}: WaveSpeed text route ${text} is a known id`, BARE_OK.has(text) || text !== bare || !/\/edit$/.test(edit), text);
    }
}
check("the recipes were read", seen >= 15, String(seen));

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
