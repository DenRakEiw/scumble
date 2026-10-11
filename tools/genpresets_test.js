// Generate new with presets (item 34, docs/PLAN_NEW_PRESETS.md section 8), in plain Node, no Electron:
//   node tools/genpresets_test.js
// renderer/editor/genpresets.js (an ES module, imported as tools/boxes_test.js imports renderer/editor/boxes.js) over
// the shipped recipes, loaded through electron/main/recipes.js as tools/recipes_test.js loads them: every variant with a
// text route offers at least one aspect and one size class (its own list, else the dialog's general one, read from
// renderer/shell.js GEN_ASPECTS as tools/ark_test.js reads it); FLUX 3's own aspects per host (15 on BFL, 14 on fal and
// WaveSpeed) and its classes 1k / 2k / 4k, each of which flux3.js counts the dialog's size of every aspect into; then
// the helpers: the nearest aspect, the same shape, the working canvas (2048 at most, multiples of 16), the stretch note,
// a document's preset, the opening aspect, the labels of a tier table, and recipes.js's text.aspects.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const RECIPES = path.join(ROOT, "recipes");
const PROVIDERS = path.join(ROOT, "electron", "main", "providers");
const flux3 = require(path.join(PROVIDERS, "flux3.js"));

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 400 ? s.slice(0, 400) + " ..." : s; };

// ---- recipes.js with a temporary userData folder (tools/recipes_test.js) ----------------------------------------------
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-genpresets-test-"));
function loadRecipes() {
    const orig = Module._load;
    Module._load = function (request, ...rest) {
        if (request === "electron") return { app: { getPath: () => USERDATA } };
        return orig.call(this, request, ...rest);
    };
    try { return require(path.join(ROOT, "electron", "main", "recipes.js")); } finally { Module._load = orig; }
}

// the dialog's general lists, as renderer/shell.js holds them
const SHELL = fs.readFileSync(path.join(ROOT, "renderer", "shell.js"), "utf8");
const listOf = (name) => { const m = new RegExp(`const ${name} = (\\[[^\\]]*\\]);`).exec(SHELL); return m ? JSON.parse(m[1]) : null; };
const GEN_ASPECTS = listOf("GEN_ASPECTS") || [];
const GEN_RESOLUTIONS = listOf("GEN_RESOLUTIONS") || [];
const GENERAL = GEN_ASPECTS.filter((a) => a !== "free");

(async () => {
    const gp = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "genpresets.js")).href);
    const recipes = loadRecipes();
    const list = await recipes.list(RECIPES);

    // ---- 1. every text route of the shipped recipes ------------------------------------------------------------------
    console.log("--- 1. the shipped text routes ---");
    check("shell.js GEN_ASPECTS reads ('free' first, at least 8 aspects) and GEN_RESOLUTIONS too", GEN_ASPECTS[0] === "free" && GENERAL.length >= 8 && GENERAL.every((a) => gp.parseAspect(a)) && GEN_RESOLUTIONS.length >= 5, short([GEN_ASPECTS, GEN_RESOLUTIONS]));
    const empty = [], badAspect = [], badClass = [];
    let routes = 0, own = 0;
    for (const r of list.filter((x) => x.kind === "provider")) {
        for (const [pid, v] of Object.entries(r.providers || {})) {
            if (!v.text) continue;
            routes++;
            const aspects = gp.aspectsOf(v, GENERAL), classes = gp.classesOf(v, GEN_RESOLUTIONS);
            if (gp.aspectsOf(v).length) own++;
            if (!aspects.length || !classes.length) empty.push(`${r.id}/${pid}`);
            if (aspects.some((a) => !gp.parseAspect(a)) || new Set(aspects).size !== aspects.length) badAspect.push(`${r.id}/${pid}: ${aspects.join(",")}`);
            if (classes.some((c, i) => !(c.px > 0) || (i && c.px <= classes[i - 1].px) || typeof c.label !== "string" || !c.label.includes(`${c.px} px`))) badClass.push(`${r.id}/${pid}: ${short(classes)}`);
        }
    }
    check(`every text route offers at least one aspect and one size class (${routes} routes, ${own} with an own aspect list)`, routes > 100 && !empty.length && own > 30, empty.join(", ") || `${routes} routes`);
    check("the aspects are W:H, each once", !badAspect.length, badAspect.slice(0, 3).join(" | "));
    check("the classes are smallest first, each labelled with its long side", !badClass.length, badClass.slice(0, 3).join(" | "));
    const local = gp.classesOf(null, GEN_RESOLUTIONS);
    check("a route without sizes (a recipe on ComfyUI) gets the general long sides, unnamed", eq(local.map((c) => c.px), GEN_RESOLUTIONS.slice().sort((a, b) => a - b)) && local.every((c) => c.name === null && c.label === `${c.px} px`), short(local));

    // ---- 2. FLUX 3 ---------------------------------------------------------------------------------------------------
    console.log("\n--- 2. FLUX 3: its own aspects and the 1k / 2k / 4k classes ---");
    const f3 = list.find((x) => x.id === "flux3");
    check("the FLUX 3 recipe ships with bfl, fal and wavespeed text routes", !!(f3 && f3.providers.bfl && f3.providers.bfl.text && f3.providers.fal && f3.providers.fal.text && f3.providers.wavespeed && f3.providers.wavespeed.text), "");
    if (f3) {
        const A = (pid) => gp.aspectsOf(f3.providers[pid], GENERAL);
        check("BFL: the 15 presets of flux3.js FLUX3_ASPECTS, in their order", eq(A("bfl"), flux3.FLUX3_ASPECTS) && A("bfl").length === 15, short(A("bfl")));
        check("fal and WaveSpeed: 14 (no 9:21)", A("fal").length === 14 && A("wavespeed").length === 14 && !A("fal").includes("9:21") && !A("wavespeed").includes("9:21") && eq(A("fal"), flux3.FLUX3_ASPECTS.filter((a) => a !== "9:21")), short([A("fal"), A("wavespeed")]));
        check("7:5 and 5:4, which GEN_ASPECTS lacks, are offered on BFL", A("bfl").includes("7:5") && A("bfl").includes("5:4") && !GENERAL.includes("7:5"), "");
        const wrongTier = [], labels = {};
        for (const pid of Object.keys(f3.providers)) {
            const v = f3.providers[pid];
            if (!v.text) continue;
            const classes = gp.classesOf(v, GEN_RESOLUTIONS);
            labels[pid] = classes.map((c) => c.label);
            for (const c of classes) {
                for (const a of gp.aspectsOf(v, GENERAL)) {
                    const [w, h] = gp.sizeFor(a, c.px);
                    const tier = flux3._tierOf(w, h);
                    if (String(tier).toLowerCase() !== String(c.name).toLowerCase()) wrongTier.push(`${pid} ${a} at ${c.px} (${w} x ${h}): flux3 ${tier}, class ${c.name}`);
                }
            }
        }
        check("BFL's classes are named 1k, 2k and 4k: '1k (1024 px)', '2k (2048 px)', '4k (4096 px)'", eq(labels.bfl, ["1k (1024 px)", "2k (2048 px)", "4k (4096 px)"]) && eq(labels.fal, labels.bfl) && eq(labels.wavespeed, labels.bfl), short(labels));
        check("every FLUX 3 route: flux3.js counts the dialog's size of each aspect at each class into that class", !wrongTier.length, wrongTier.slice(0, 4).join(" | ") || `${Object.keys(labels).length} routes`);
    }

    // ---- 2b. every route with a tier table: the label is the tier its adapter picks -----------------------------------
    // The adapters' own tier functions (each module's exported helper); which one a provider calls for a text run is
    // mirrored here from its request builder: OpenRouter tierByArea / tierFor by tier_unit, Oxen tierFor with the unit
    // (FLUX 3's shape where it sends one), ToAPIs sizeFor (its tier_sizes rows), Comfy Router and WaveSpeed util.js
    // tierFor on the long side, FLUX 3's hosts flux3.js tierOf.
    console.log("\n--- 2b. the size classes are named as each route counts them ---");
    const openrouter = require(path.join(PROVIDERS, "openrouter.js")), oxen = require(path.join(PROVIDERS, "oxen.js"));
    const toapis = require(path.join(PROVIDERS, "toapis.js")), util = require(path.join(PROVIDERS, "util.js"));
    const adapterTier = (pid, v, w, h, aspect) => {
        const o = v.options || {};
        const f3 = o.boxes === "flux3";
        if (pid === "openrouter" && o.tiers) return o.tier_unit === "area" ? openrouter._tierByArea(w, h, o.tiers) : openrouter._tier(w, h, o.tiers);
        if (pid === "oxen" && o.tiers && o.sizing !== "flux3") return oxen._tier(w, h, o.tiers, o.tier_unit);
        if (pid === "toapis" && o.tiers) return toapis._size({ kind: "text", width: w, height: h, aspect }, toapis._channel({ options: o, params: {}, model: v.model || "model" })).tier;
        if (f3 && (!o.tiers || o.sizing === "flux3")) return flux3._tierOf(w, h);
        if (o.tiers) return util.tierFor(Math.max(w, h), o.tiers);
        return undefined;
    };
    const misnamed = [], swept = [];
    let named = 0;
    for (const r of list.filter((x) => x.kind === "provider")) {
        for (const [pid, v] of Object.entries(r.providers || {})) {
            const o = (v && v.options) || {};
            if (!v.text || !(o.tiers || o.boxes === "flux3")) continue;
            swept.push(`${r.id}/${pid}`);
            // 1:1 (what list_recipes and a class without an aspect show) and every aspect the route offers, its widest
            // among them
            for (const aspect of [null, ...gp.aspectsOf(v, GENERAL)]) {
                for (const c of gp.classesOf(v, GEN_RESOLUTIONS, { provider: pid, aspect })) {
                    const [w, h] = gp.sizeFor(aspect || "1:1", c.px);
                    const tier = adapterTier(pid, v, w, h, aspect || "1:1");
                    named++;
                    if (tier === undefined || String(tier) !== String(c.name)) misnamed.push(`${r.id}/${pid} ${aspect || "1:1"} at ${c.px} (${w} x ${h}): adapter ${tier}, label ${c.name}`);
                }
            }
        }
    }
    check(`every route with a tier table, at 1:1 and at each of its aspects: the class's name is the tier its adapter sends (${swept.length} routes)`, swept.length >= 30 && !misnamed.length, misnamed.slice(0, 4).join(" | ") || `${named} labels`);
    const oxenPro = (list.find((x) => x.id === "flux2_pro") || { providers: {} }).providers.oxen;
    const oxLabel = (aspect) => (oxenPro ? gp.classesOf(oxenPro, GEN_RESOLUTIONS, { provider: "oxen", aspect })[0].label : null);
    check("Oxen's FLUX.2 [pro] counts the area without slack: 1024 px is 2 MP at 1:1 and 1 MP at 16:9", oxLabel(null) === "2 MP (1024 px)" && oxLabel("1:1") === "2 MP (1024 px)" && oxLabel("16:9") === "1 MP (1024 px)", short([oxLabel(null), oxLabel("16:9")]));
    const orArea = { text: { sizes: [1024, 2048] }, options: { tiers: { "1K": 1024, "2K": 2048 }, tier_unit: "area" } };
    check("OpenRouter's area tiers keep the 15 % slack (1088 x 1088 is still 1K), Oxen's do not (1 MP ends at 1,000,000 px)", gp.classesOf({ ...orArea, text: { sizes: [1088] } }, [], { provider: "openrouter" })[0].name === "1K" && openrouter._tierByArea(1088, 1088, orArea.options.tiers) === "1K" && gp.classesOf({ text: { sizes: [1008] }, options: { tiers: { "1 MP": 1000000, "2 MP": 2000000 }, tier_unit: "area" } }, [], { provider: "oxen" })[0].name === "2 MP", "");

    // ---- 3. the helpers ----------------------------------------------------------------------------------------------
    console.log("\n--- 3. the helpers ---");
    check("parseAspect: W:H with decimals; free, auto and 0:1 are no aspect", eq(gp.parseAspect("16:9"), [16, 9]) && eq(gp.parseAspect(" 2.35 : 1 "), [2.35, 1]) && gp.parseAspect("free") === null && gp.parseAspect("auto") === null && gp.parseAspect("0:1") === null && gp.parseAspect(null) === null, "");
    check("aspectsOf: text.aspects before options.ratios before options.aspect_ratios before limits.aspects; none: the fallback", eq(gp.aspectsOf({ text: { aspects: ["3:2"] }, options: { ratios: ["1:1"] } }), ["3:2"]) && eq(gp.aspectsOf({ options: { ratios: ["auto", "1:1", "1:1", "4:3"], aspect_ratios: ["2:1"] } }), ["1:1", "4:3"]) && eq(gp.aspectsOf({ options: { aspect_ratios: ["2:1"] }, limits: { aspects: ["5:4"] } }), ["2:1"]) && eq(gp.aspectsOf({ limits: { aspects: [] } }, ["1:1"]), ["1:1"]) && eq(gp.aspectsOf({ options: { text: { ratios: ["9:16"] }, ratios: ["1:1"] } }), ["9:16"]), "");
    check("nearestAspect: 2048 x 1456 is 7:5 among FLUX 3's, 1000 x 1000 is 1:1, an empty list null", gp.nearestAspect(2048, 1456, flux3.FLUX3_ASPECTS) === "7:5" && gp.nearestAspect(1000, 1000, GENERAL) === "1:1" && gp.nearestAspect(1920, 1080, GENERAL) === "16:9" && gp.nearestAspect(100, 100, []) === null && gp.nearestAspect(0, 100, GENERAL) === null, "");
    check("sameShape: within 3 % of the ratio (1024 x 576 is 16:9, 1024 x 600 is not)", gp.sameShape(1024, 576, 16, 9) && !gp.sameShape(1024, 600, 16, 9) && gp.sameShape(2048, 1456, 7, 5) && !gp.sameShape(0, 1, 1, 1), "");
    check("sizeFor: the long side on the aspect's long side, multiples of 16 (genSize's rule): 9:16 at 1536 is 864 x 1536, 7:5 at 4096 is 4096 x 2928", eq(gp.sizeFor("9:16", 1536), [864, 1536]) && eq(gp.sizeFor("7:5", 4096), [4096, 2928]) && eq(gp.sizeFor("16:9", 1024), [1024, 576]), short([gp.sizeFor("9:16", 1536), gp.sizeFor("7:5", 4096)]));
    const work = [["7:5", 4096], ["7:5", 2048], ["9:21", 4096], ["21:9", 1024], ["1:1", 3840], ["2.35:1", 1024]].map(([a, px]) => [a, px, gp.workingSize(a, px)]);
    check("workingSize: the aspect at the class's long side, at most 2048, multiples of 16 (7:5 4k: 2048 x 1456)", eq(gp.workingSize("7:5", 4096), [2048, 1456]) && eq(gp.workingSize("21:9", 1024), [1024, 432]) && work.every(([a, , [w, h]]) => Math.max(w, h) <= gp.WORKING_MAX && w % 16 === 0 && h % 16 === 0 && Math.abs(Math.log((w / h) / gp.ratioOf(a))) < 0.03), short(work));
    check("classesOf: a variant's long-side tiers name its classes ('1K (1024 px)'), an area table counts the square ('2 MP (1440 px)')", eq(gp.classesOf({ text: { sizes: [2048, 1024] }, options: { tiers: { "1K": 1024, "2K": 2048 } } }).map((c) => c.label), ["1K (1024 px)", "2K (2048 px)"]) && eq(gp.classesOf({ text: { sizes: [1024, 1440] }, options: { tiers: { "1 MP": 1048576, "2 MP": 2097152 }, tier_unit: "area" } }).map((c) => c.label), ["1 MP (1024 px)", "2 MP (1440 px)"]) && eq(gp.classesOf({ text: { sizes: [768] } }).map((c) => c.label), ["768 px"]), "");
    check("stretchNote: the boxes' shape against the asked one, named by the list and FLUX 3's shapes", gp.stretchNote([2048, 1456], [1024, 1024], [], "1:1") === "The boxes were drawn on 7:5; at 1:1 they go stretched." && gp.stretchNote([1024, 1024], [1024, 576], GENERAL) === "The boxes were drawn on 1:1; at 16:9 they go stretched.", short(gp.stretchNote([2048, 1456], [1024, 1024], [], "1:1")));
    check("stretchNote: the same shape (within 3 %), or no picture, says nothing; an unnamed shape reads W x H", gp.stretchNote([2048, 1456], [4096, 2928], [], "7:5") === "" && gp.stretchNote([0, 0], [1024, 1024]) === "" && gp.stretchNote([1000, 3000], [1024, 1024], [], "1:1") === "The boxes were drawn on 1000 \u00d7 3000; at 1:1 they go stretched.", short(gp.stretchNote([1000, 3000], [1024, 1024], [], "1:1")));
    const T = { recipe: "flux3", provider: "bfl", aspect: "7:5", size: 4096, width: 2048, height: 1456 };
    check("targetValid: only while the picture keeps the preset's size, and only with a recipe", gp.targetValid(T, { width: 2048, height: 1456 }) && !gp.targetValid(T, { width: 2048, height: 1460 }) && !gp.targetValid({ ...T, recipe: "" }, { width: 2048, height: 1456 }) && !gp.targetValid(null, { width: 2048, height: 1456 }) && !gp.targetValid(T, null), "");
    const L = ["free", "1:1", "16:9", "9:16", "7:5"];
    check("chooseAspect: the preset first; with boxes the one nearest the document; else the last choice; else nearest it; else 1:1",
        gp.chooseAspect(L, { want: "7:5", keep: "1:1", doc: [1000, 1000], boxes: true }) === "7:5"
        && gp.chooseAspect(L, { want: null, keep: "1:1", doc: [2048, 1456], boxes: true }) === "7:5"
        && gp.chooseAspect(L, { want: null, keep: "9:16", doc: [2048, 1456], boxes: false }) === "9:16"
        && gp.chooseAspect(L, { want: "free" }) === "free"
        && gp.chooseAspect(["free", "1:1", "16:9"], { want: "7:5", keep: "21:9" }) === "16:9"
        && gp.chooseAspect(["free", "4:3", "1:1"], {}) === "1:1"
        && gp.chooseAspect(["free", "4:3"], {}) === "free"
        && gp.chooseAspect([], {}) === null, "");
    check("nearestSize: the wish when offered, else the nearest, 1024 without a wish", gp.nearestSize([1024, 2048, 4096], 4096) === 4096 && gp.nearestSize([1024, 2048, 4096], 3000) === 2048 && gp.nearestSize([768, 1024, 1536], null) === 1024 && gp.nearestSize([], 1024) === null, "");
    check("shapeLabel: an aspect of the list within the slack, else W x H", gp.shapeLabel(1920, 1080, GENERAL) === "16:9" && gp.shapeLabel(1000, 900, GENERAL) === "1000 \u00d7 900", gp.shapeLabel(1000, 900, GENERAL));
    // pure ASCII (CLAUDE.md): the multiplication sign is an escape in the source
    const src = fs.readFileSync(path.join(ROOT, "renderer", "editor", "genpresets.js"), "utf8");
    check("renderer/editor/genpresets.js is pure ASCII", !/[^\x00-\x7F]/.test(src), "");

    // ---- 4. recipes.js: text.aspects ---------------------------------------------------------------------------------
    console.log("\n--- 4. recipes.js normalises text.aspects ---");
    const warn = console.warn;
    const warned = [];
    console.warn = (...a) => warned.push(a.join(" "));
    let n;
    try {
        n = recipes._normalize({ id: "t_aspects", name: "T", kind: "provider", providers: { fal: { model: "fal-ai/x/edit", text: { aspects: ["4:3", " 16 : 9 ", "4:3", "auto", "wide"] } }, bfl: { model: "flux-2-pro", text: { aspects: "16:9" } }, replicate: { model: "a/b" } } });
    } finally { console.warn = warn; }
    const ta = n && n.providers.fal.text;
    check("text.aspects goes through as W:H strings, each once; the rest dropped with a warning", !!ta && eq(ta.aspects, ["4:3", "16:9"]) && warned.filter((w) => /text\.aspects/.test(w)).length === 3, short([ta && ta.aspects, warned]));
    check("text.aspects that is not a list is ignored; a text route without it has no aspects key", !!n && n.providers.bfl.text && n.providers.bfl.text.aspects === undefined && n.providers.replicate.text && !("aspects" in n.providers.replicate.text), short(n && n.providers.bfl.text));
    check("the dialog reads a route's own text.aspects first", !!ta && eq(gp.aspectsOf(n.providers.fal, GENERAL), ["4:3", "16:9"]), "");

    fs.rmSync(USERDATA, { recursive: true, force: true });
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed} of ${results.length} checks passed`);
    console.log(passed === results.length ? "PASS" : "FAIL");
    process.exitCode = passed === results.length ? 0 : 1;
})().catch((err) => {
    console.error(err);
    try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch (_) { /* gone */ }
    console.log("FAIL");
    process.exitCode = 1;
});
