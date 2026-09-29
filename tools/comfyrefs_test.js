// @img tokens on local ComfyUI recipes (item 26 step 26e, docs/PLAN_REFS.md), in plain Node, no Electron, no ComfyUI:
//   node tools/comfyrefs_test.js
// renderer/editor/comfyrefs.js is the API under test: which picture of the canvas node's crop_image batch each encoder
// input of a graph reads (batchOf, comfySlots), what the model calls picture n and how many pictures the graph takes
// (comfyRefSpec), the pictures a run sends (comfyLayout), the inputs a run leaves out (trimSlots) and the marker
// resolver, the twin of electron/main/providers/refs.js resolveMarkers (both against tools/refs_cases.json).
// 1 shipped_specs: the two widened graphs (recipes/qwen_image_edit_2_1_local.json, recipes/flux2_klein_local.json),
//   declared and derived. 2 layout_matrix: selection x fill x Original x refine x count on both, and a guess.
//   3 trim: on JSON copies of the shipped prompts. 4 markers: the shared vectors against both resolvers, refName and
//   validRefName. 5 imported: graphs built through electron/main/recipes.js fromPrompt (loaded with the Electron stub
//   of tools/recipes_test.js), and normalize()'s check of a declared comfy `refs`.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const util = require("node:util");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const RECIPES = path.join(ROOT, "recipes");
const refsJs = require(path.join(ROOT, "electron", "main", "providers", "refs.js"));
const CASES = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "refs_cases.json"), "utf8"));

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const eq = (a, b) => util.isDeepStrictEqual(a, b);
const clone = (v) => JSON.parse(JSON.stringify(v));
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 400 ? s.slice(0, 400) + " ..." : s; };
/** The faults of an aggregate check, or nothing when there are none. */
const list = (a) => (a.length ? short(a) : "");
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
/** A section that throws is a failed check, not the end of the run: the sections after it still report. */
async function section(name, fn) {
    console.log(`\n--- ${name} ---`);
    try { await fn(); } catch (err) { check(`${name}: ran through`, false, String(err && err.stack || err).split(/\r?\n/).slice(0, 3).join(" ")); }
}
/** Run fn with console.warn captured: [its result, the warnings]. */
function quiet(fn) {
    const warn = console.warn, warned = [];
    console.warn = (...a) => warned.push(a.join(" "));
    try { return [fn(), warned]; } finally { console.warn = warn; }
}

// ---- recipes.js with a temporary userData folder (tools/recipes_test.js) ------------------------------------------
let USERDATA = "";
function loadRecipes() {
    USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-comfyrefs-test-"));
    const orig = Module._load;
    Module._load = function (request, ...rest) {
        if (request === "electron") return { app: { getPath: () => USERDATA } };
        return orig.call(this, request, ...rest);
    };
    try { return require(path.join(ROOT, "electron", "main", "recipes.js")); } finally { Module._load = orig; }
}

const rawFile = (name) => JSON.parse(fs.readFileSync(path.join(RECIPES, name), "utf8"));

// ---- imported graphs: API-format prompts as ComfyUI's Export (API) writes them -------------------------------------
const META = { file: "imported.json", date: "2026-09-29" };
/** One picture of the canvas node's crop_image batch (node "1", output 0). */
const IFB = (b) => ({ class_type: "ImageFromBatch", inputs: { image: ["1", 0], batch_index: b, length: 1 } });
const SCALE = (src) => ({ class_type: "ImageScaleToTotalPixels", inputs: { image: [src, 0], upscale_method: "lanczos", megapixels: 1, resolution_steps: 1 } });
/** A prompt around `extra`: the canvas node, the loaders and the decode its result source names. */
function graph(extra) {
    return {
        "1": { class_type: "InpaintCanvas", inputs: { padding: 64, target_size: 1024, result_source_local: ["90", 0] } },
        "3": { class_type: "VAELoader", inputs: { vae_name: "vae.safetensors" } },
        "4": { class_type: "CLIPLoader", inputs: { clip_name: "te.safetensors", type: "qwen_image", device: "default" } },
        "90": { class_type: "VAEDecode", inputs: { samples: ["80", 0], vae: ["3", 0] } },
        ...clone(extra),
    };
}
const EDIT_PLUS = {
    "10": IFB(0), "11": IFB(1), "12": IFB(2),
    "20": { class_type: "TextEncodeQwenImageEditPlus", inputs: { clip: ["4", 0], prompt: ["1", 7], vae: ["3", 0], image1: ["10", 0], image2: ["11", 0], image3: ["12", 0] } },
};
const QWEN21 = {
    "10": IFB(0), "11": IFB(1), "12": IFB(2),
    "20": { class_type: "TextEncodeQwenImage21", inputs: { clip: ["4", 0], vae: ["3", 0], prompt: ["1", 7], negative_prompt: ["1", 12], resolution: 0, "images.image_1": ["10", 0], "images.image_2": ["11", 0], "images.image_3": ["12", 0] } },
};
const CHAIN = {
    "10": IFB(0), "11": IFB(1),
    "30": SCALE("10"), "31": SCALE("11"),
    "40": { class_type: "VAEEncode", inputs: { pixels: ["30", 0], vae: ["3", 0] } },
    "41": { class_type: "VAEEncode", inputs: { pixels: ["31", 0], vae: ["3", 0] } },
    "50": { class_type: "CLIPTextEncode", inputs: { clip: ["4", 0], text: ["1", 7] } },
    "60": { class_type: "ReferenceLatent", inputs: { conditioning: ["50", 0], latent: ["40", 0] } },
    "61": { class_type: "ReferenceLatent", inputs: { conditioning: ["60", 0], latent: ["41", 0] } },
};

async function main() {
    const C = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "comfyrefs.js")).href);
    const recipes = loadRecipes();
    /** A shipped recipe as list() serves it: normalize()d. */
    const shipped = (name) => quiet(() => recipes._normalize(rawFile(name)));
    const [QWEN, qWarn] = shipped("qwen_image_edit_2_1_local.json");
    const [KLEIN, kWarn] = shipped("flux2_klein_local.json");
    const qSpec = C.comfyRefSpec(QWEN), kSpec = C.comfyRefSpec(KLEIN);

    // ---- 1. the shipped specs ---------------------------------------------------------------------------------------
    await section("1. shipped_specs", async () => {
        check("REF_NAME_DEFAULT is refs.js's, \"image {n}\"", C.REF_NAME_DEFAULT === refsJs.REF_NAME_DEFAULT && C.REF_NAME_DEFAULT === "image {n}", C.REF_NAME_DEFAULT);
        check("normalize() keeps both shipped refs as declared, without a warning", eq(QWEN.refs, { name: "<image{n}>", slots: 10 }) && eq(KLEIN.refs, { name: "image {n}", slots: 4 }) && !qWarn.length && !kWarn.length, short({ q: QWEN.refs, k: KLEIN.refs, warned: [...qWarn, ...kWarn] }));

        // Qwen Image 2.1: images.image_1..10 of `encode` read batches 0..9
        check("Qwen 2.1: <image{n}>, 10 slots, not a guess", qSpec.name === "<image{n}>" && qSpec.slots === 10 && qSpec.guess === false, short({ ...qSpec, trim: undefined }));
        const qTrim = range(1, 10).map((k) => ({ node: "encode", input: `images.image_${k}`, batch: k - 1 }));
        check("Qwen 2.1: trim is encode.images.image_1..10 reading batches 0..9, in that order (10 entries)", eq(qSpec.trim, qTrim), short(qSpec.trim));
        const qSlots = C.comfySlots(QWEN.prompt, QWEN.canvas);
        check("Qwen 2.1: comfySlots numbers each input by its rank, which is its batch + 1", qSlots.length === 10 && qSlots.every((s, i) => s.cls === "TextEncodeQwenImage21" && s.node === "encode" && s.batch === i && s.num === i + 1), short(qSlots));
        const qBare = clone(QWEN);
        delete qBare.refs;
        const qDerived = C.comfyRefSpec(qBare);
        check("Qwen 2.1 without refs: the identity trace derives the same spec (name, 10 slots, not a guess, the same trim)", eq(qDerived, qSpec), short({ ...qDerived, trim: qDerived.trim && qDerived.trim.length }));

        // Flux.2 Klein: a ReferenceLatent chain of four on each of pos and neg
        check("Klein: image {n}, 4 slots, not a guess", kSpec.name === "image {n}" && kSpec.slots === 4 && kSpec.guess === false, short({ ...kSpec, trim: undefined }));
        const kTrim = [];
        for (let b = 0; b < 4; b++) kTrim.push({ node: `ref_pos${b}`, input: "latent", batch: b }, { node: `ref_neg${b}`, input: "latent", batch: b });
        check("Klein: trim holds a ref_pos and a ref_neg latent per batch 0..3 (8 entries, pos first)", eq(kSpec.trim, kTrim), short(kSpec.trim));
        const kSlots = C.comfySlots(KLEIN.prompt, KLEIN.canvas);
        check("Klein: each ReferenceLatent's number is its place in its conditioning chain, which is its batch + 1", kSlots.length === 8 && kSlots.every((s) => s.cls === "ReferenceLatent" && s.input === "latent" && s.num === s.batch + 1 && s.node.endsWith(String(s.batch))), short(kSlots));
        check("Klein: batchOf follows VAEEncode.pixels and ImageScaleToTotalPixels.image back to img2 (batch 2)", C.batchOf(KLEIN.prompt, "canvas", ["enc2", 0]) === 2 && C.batchOf(KLEIN.prompt, "canvas", ["scale3", 0]) === 3 && C.batchOf(KLEIN.prompt, "canvas", ["img0", 0]) === 0);
        const kBare = clone(KLEIN);
        delete kBare.refs;
        const kDerived = C.comfyRefSpec(kBare);
        check("Klein without refs: the identity trace derives the same spec", eq(kDerived, kSpec), short({ ...kDerived, trim: kDerived.trim && kDerived.trim.length }));

        const before = JSON.stringify(QWEN) + JSON.stringify(KLEIN);
        C.comfyRefSpec(QWEN); C.comfyRefSpec(KLEIN);
        check("comfyRefSpec leaves the recipe as it was", JSON.stringify(QWEN) + JSON.stringify(KLEIN) === before);
    });

    // ---- 2. the pictures a run sends ---------------------------------------------------------------------------------
    await section("2. layout_matrix", async () => {
        const guessSpec = { name: "image {n}", slots: null, guess: true, trim: null };
        // one slot, the crop's: nothing else fits, and a picture no slot reads has the field crop_image[b]
        const oneSpec = { name: "image {n}", slots: 1, guess: false, trim: [{ node: "enc", input: "image1", batch: 0 }] };
        const specs = [
            ["Qwen 2.1", qSpec, (b) => `encode.images.image_${b + 1}`],
            ["Klein", kSpec, (b) => `ref_pos${b}.latent`],
            ["a guess (slots null)", guessSpec, (b) => `crop_image[${b}]`],
            ["a one-slot spec", oneSpec, (b) => (b === 0 ? "enc.image1" : `crop_image[${b}]`)],
        ];
        const KEYS = ["role", "ref", "field", "n"];
        for (const [label, spec, fieldOf] of specs) {
            const faults = { original: [], kept: [], pictures: [], rest: [] };
            let runs = 0;
            for (const hasSelection of [false, true]) for (const fill of ["none", "green"]) for (const withOriginal of [false, true]) for (const refine of [false, true]) for (const count of [0, 1, 3, 12]) {
                runs++;
                const run = { hasSelection, fill, withOriginal, refine, count };
                const tag = `sel ${+hasSelection} ${fill} orig ${+withOriginal} refine ${+refine} count ${count}`;
                const lay = C.comfyLayout(spec, run);
                const original = hasSelection && fill !== "none" && withOriginal && !refine ? 1 : 0;
                const kept = spec.slots == null ? count : Math.max(0, Math.min(count, spec.slots - 1 - original));
                const want = [["crop", undefined, fieldOf(0), 1]];
                if (original) want.push(["original", 0, fieldOf(1), 2]);
                for (let k = 0; k < kept; k++) want.push(["reference", original + k, fieldOf(1 + original + k), 2 + original + k]);
                if (lay.original !== original) faults.original.push(`${tag}: ${lay.original}`);
                if (lay.kept !== kept || typeof lay.drops !== "number" || lay.drops !== count - kept) faults.kept.push(`${tag}: kept ${lay.kept} drops ${JSON.stringify(lay.drops)}, want ${kept} / ${count - kept}`);
                const got = (lay.pictures || []).map((p) => KEYS.map((key) => p[key]));
                const extra = (lay.pictures || []).filter((p) => Object.keys(p).some((key) => !KEYS.includes(key)) || (p.role === "crop" && p.ref !== undefined));
                if (!eq(got, want) || extra.length) faults.pictures.push(`${tag}: ${short(got)}`);
                if (lay.max !== spec.slots || lay.style !== false || lay.guess !== spec.guess) faults.rest.push(`${tag}: max ${lay.max} style ${lay.style} guess ${lay.guess}`);
            }
            check(`${label}: original is 1 only with a selection, a fill, Original on and no refine pass (${runs} runs)`, !faults.original.length, list(faults.original));
            check(`${label}: kept = min(count, slots - 1 - original), never negative, drops the rest as a number`, !faults.kept.length, list(faults.kept));
            check(`${label}: crop n 1, Original ref 0 n 2, reference k ref original + k n 2 + original + k, each field the slot that reads its batch`, !faults.pictures.length, list(faults.pictures));
            check(`${label}: max is the spec's slots, style false, guess the spec's`, !faults.rest.length, list(faults.rest));
        }

        // the plan's examples, literally
        const fillOrig = { hasSelection: true, fill: "green", withOriginal: true, refine: false };
        let lay = C.comfyLayout(kSpec, { ...fillOrig, count: 3 });
        check("Klein with the Original and 3 references keeps 2 and drops 1: crop, Original, img1, img2 on ref_pos0..3", lay.kept === 2 && lay.drops === 1 && lay.original === 1 && eq(lay.pictures, [
            { role: "crop", field: "ref_pos0.latent", n: 1 },
            { role: "original", ref: 0, field: "ref_pos1.latent", n: 2 },
            { role: "reference", ref: 1, field: "ref_pos2.latent", n: 3 },
            { role: "reference", ref: 2, field: "ref_pos3.latent", n: 4 },
        ]), short(lay));
        lay = C.comfyLayout(qSpec, { ...fillOrig, count: 1 });
        check("Qwen 2.1 with the Original and 1 reference: the reference is picture 3 on encode.images.image_3", lay.pictures.length === 3 && lay.pictures[2].ref === 1 && lay.pictures[2].n === 3 && lay.pictures[2].field === "encode.images.image_3" && lay.drops === 0, short(lay.pictures));
        lay = C.comfyLayout(qSpec, { ...fillOrig, refine: true, count: 1 });
        check("a refine pass leaves the Original out: the one reference is ref 0, picture 2", lay.original === 0 && lay.pictures.length === 2 && lay.pictures[1].role === "reference" && lay.pictures[1].ref === 0 && lay.pictures[1].n === 2, short(lay.pictures));
        lay = C.comfyLayout(qSpec, { hasSelection: false, fill: "none", withOriginal: false, refine: false, count: 12 });
        check("Qwen 2.1 with 12 references and no Original keeps 9 and drops 3; the last is picture 10 on encode.images.image_10", lay.kept === 9 && lay.drops === 3 && lay.pictures.length === 10 && lay.pictures[9].n === 10 && lay.pictures[9].field === "encode.images.image_10" && lay.max === 10, short({ kept: lay.kept, drops: lay.drops, last: lay.pictures[lay.pictures.length - 1] }));
        lay = C.comfyLayout(guessSpec, { ...fillOrig, count: 12 });
        check("a guess (slots null) keeps every reference: 12 kept, none dropped, max null, fields crop_image[b]", lay.kept === 12 && lay.drops === 0 && lay.max === null && lay.guess === true && lay.pictures.length === 14 && lay.pictures[13].field === "crop_image[13]", short({ kept: lay.kept, drops: lay.drops, max: lay.max, last: lay.pictures[13] }));
        lay = C.comfyLayout(qSpec, { ...fillOrig, fill: "", count: 1 });
        check("an empty fill counts as none: no Original", lay.original === 0 && lay.pictures.length === 2, short(lay.pictures));
    });

    // ---- 3. trimSlots ------------------------------------------------------------------------------------------------
    await section("3. trim", async () => {
        const imageKeys = (p) => Object.keys(p.encode.inputs).filter((k) => /^images\.image_\d+$/.test(k));
        const other = (p) => { const o = { ...p.encode.inputs }; for (const k of imageKeys(p)) delete o[k]; return o; };
        const qOther = other(QWEN.prompt);

        let p = clone(QWEN.prompt), removed = C.trimSlots(p, qSpec, 1);
        check("Qwen 2.1, length 1: removes encode.images.image_2..10 and keeps image_1", eq(removed, range(2, 10).map((k) => `encode.images.image_${k}`)) && eq(imageKeys(p), ["images.image_1"]) && eq(p.encode.inputs["images.image_1"], ["img0", 0]), short({ removed, kept: imageKeys(p) }));
        check("Qwen 2.1, length 1: the encoder's other inputs are untouched", eq(other(p), qOther), short(other(p)));
        p = clone(QWEN.prompt); removed = C.trimSlots(p, qSpec, 3);
        check("Qwen 2.1, length 3: keeps image_1..3, removes image_4..10", eq(removed, range(4, 10).map((k) => `encode.images.image_${k}`)) && eq(imageKeys(p), ["images.image_1", "images.image_2", "images.image_3"]), short({ removed, kept: imageKeys(p) }));
        p = clone(QWEN.prompt); removed = C.trimSlots(p, qSpec, 0);
        check("Qwen 2.1, length 0: batch 0 is never removed (image_1 stays)", eq(imageKeys(p), ["images.image_1"]) && removed.length === 9, short({ removed, kept: imageKeys(p) }));
        p = clone(QWEN.prompt); removed = C.trimSlots(p, qSpec, 10);
        check("Qwen 2.1, length 10: nothing removed, the prompt is as it was", removed.length === 0 && eq(p, QWEN.prompt), short(removed));
        p = clone(QWEN.prompt); C.trimSlots(p, qSpec, 2); removed = C.trimSlots(p, qSpec, 2);
        check("a second trim of the same prompt removes nothing more", removed.length === 0 && imageKeys(p).length === 2, short(removed));

        let k = clone(KLEIN.prompt);
        removed = C.trimSlots(k, kSpec, 2);
        check("Klein, length 2: removes the latent of ref_pos2, ref_neg2, ref_pos3 and ref_neg3 only", eq(removed, ["ref_pos2.latent", "ref_neg2.latent", "ref_pos3.latent", "ref_neg3.latent"]), short(removed));
        check("Klein, length 2: ref_pos0/1 and ref_neg0/1 keep their latent", ["ref_pos0", "ref_neg0", "ref_pos1", "ref_neg1"].every((id) => eq(k[id].inputs.latent, KLEIN.prompt[id].inputs.latent)) && ["ref_pos2", "ref_neg2", "ref_pos3", "ref_neg3"].every((id) => !("latent" in k[id].inputs)));
        check("Klein, length 2: the chain stays linked (ref_pos3.conditioning is still [\"ref_pos2\", 0], ref_neg3's [\"ref_neg2\", 0])", eq(k.ref_pos3.inputs.conditioning, ["ref_pos2", 0]) && eq(k.ref_neg3.inputs.conditioning, ["ref_neg2", 0]) && eq(k.ref_pos2.inputs.conditioning, ["ref_pos1", 0]), short(k.ref_pos3.inputs));
        const kWant = clone(KLEIN.prompt);
        for (const id of ["ref_pos2", "ref_neg2", "ref_pos3", "ref_neg3"]) delete kWant[id].inputs.latent;
        check("Klein, length 2: nothing else in the prompt changed (the guider, the unused img/scale/enc nodes stay)", eq(k, kWant));
        k = clone(KLEIN.prompt); removed = C.trimSlots(k, kSpec, 0);
        check("Klein, length 0: batch 0 is never removed (ref_pos0 and ref_neg0 keep their latent)", eq(k.ref_pos0.inputs.latent, ["enc0", 0]) && eq(k.ref_neg0.inputs.latent, ["enc0", 0]) && removed.length === 6, short(removed));

        const guess = { name: "image {n}", slots: null, guess: true, trim: null };
        p = clone(QWEN.prompt); removed = C.trimSlots(p, guess, 1);
        k = clone(KLEIN.prompt); const removedK = C.trimSlots(k, guess, 1);
        check("a spec with trim null removes nothing", removed.length === 0 && removedK.length === 0 && eq(p, QWEN.prompt) && eq(k, KLEIN.prompt), short([removed, removedK]));
        check("the shipped recipes' own prompts were never touched", eq(QWEN.prompt, rawFile("qwen_image_edit_2_1_local.json").prompt) && eq(KLEIN.prompt, rawFile("flux2_klein_local.json").prompt));
    });

    // ---- 4. markers, refName, validRefName -----------------------------------------------------------------------------
    await section("4. markers", async () => {
        const vectors = CASES.markers || [];
        check("tools/refs_cases.json holds the marker vectors", vectors.length >= 7, `${vectors.length} vectors`);
        vectors.forEach((v, i) => {
            const want = { text: v.out, left: v.left, refs: v.refs };
            const a = C.resolveMarkers(v.text, v.pictures, v.pattern);
            const b = refsJs.resolveMarkers(v.text, v.pictures, v.pattern);
            const what = `vector ${i + 1} (${String(v._comment || "").slice(0, 60)})`;
            check(`${what}: comfyrefs.resolveMarkers`, eq(a, want), short(a));
            check(`${what}: refs.js resolveMarkers`, eq(b, want), short(b));
        });

        // the comfy layouts through the resolver: what the Info panel and the queued state say
        let lay = C.comfyLayout(qSpec, { hasSelection: true, fill: "green", withOriginal: true, refine: false, count: 1 });
        let r = C.resolveMarkers("put {@ref:1} there", lay.pictures, qSpec.name);
        check("Qwen 2.1 with the Original and 1 reference: {@ref:1} becomes <image3>", r.text === "put <image3> there" && eq(r.refs, [{ ref: 1, name: "<image3>" }]) && !r.left.length, short(r));
        lay = C.comfyLayout(kSpec, { hasSelection: true, fill: "green", withOriginal: true, refine: true, count: 1 });
        r = C.resolveMarkers("{@ref:0}", lay.pictures, kSpec.name);
        check("Klein on a refine pass: {@ref:0} becomes image 2", r.text === "image 2" && !r.left.length, short(r));
        lay = C.comfyLayout(kSpec, { hasSelection: true, fill: "green", withOriginal: true, refine: false, count: 3 });
        r = C.resolveMarkers("{@ref:3} and {@ref:2}", lay.pictures, kSpec.name);
        check("Klein with the Original and 3 references: the dropped one stays a marker (absent), the kept one is image 4", r.text === "{@ref:3} and image 4" && eq(r.left, [{ ref: 3, why: "absent" }]), short(r));

        check("refName(\"<image{n}>\", 3) is <image3>", C.refName("<image{n}>", 3) === "<image3>", C.refName("<image{n}>", 3));
        check("refName(\"<frame>{n0}</frame>\", 3) is <frame>2</frame>", C.refName("<frame>{n0}</frame>", 3) === "<frame>2</frame>", C.refName("<frame>{n0}</frame>", 3));
        check("refName(\"bad\", 2) takes the default: image 2", C.refName("bad", 2) === "image 2", C.refName("bad", 2));
        const names = [["image {n}", 4], ["Picture {n}", 1], ["{n}{n0}", 5], ["@img{n}", 2], [undefined, 7]];
        const nameDiff = names.filter(([pat, n]) => C.refName(pat, n) !== refsJs.nameOf(pat, n)).map(([pat, n]) => `${pat} ${n}: ${C.refName(pat, n)} / ${refsJs.nameOf(pat, n)}`);
        check("refName agrees with refs.js nameOf", !nameDiff.length, list(nameDiff));

        const patterns = [
            ["image {n}", true], ["Image {n}", true], ["<image{n}>", true], ["{n0}", true], ["x", false], ["@img{n}", false],
            ["a{b}{n}", false], ["", false], ["x".repeat(37) + "{n}", true], ["x".repeat(38) + "{n}", false],
            ["{n}{n0}", true], ["{N}", false], [null, false], [3, false],
        ];
        const disagree = patterns.filter(([s]) => C.validRefName(s) !== refsJs.validRefName(s)).map(([s]) => short(s));
        check(`validRefName agrees with refs.js on ${patterns.length} patterns`, !disagree.length, list(disagree));
        const wrong = patterns.filter(([s, want]) => C.validRefName(s) !== want).map(([s, want]) => `${short(s)} (${s && s.length} chars): ${!want}`);
        check("validRefName: {n} or {n0}, no @ or stray brace, 1-40 characters (the 40-character one passes, the 41-character one not)", !wrong.length, list(wrong));
    });

    // ---- 5. imported graphs and normalize() ------------------------------------------------------------------------------
    await section("5. imported", async () => {
        /** A graph through fromPrompt, given an id, a declared refs and normalize(): [recipe, warnings]. */
        const imported = (extra, refs) => {
            const r = recipes.fromPrompt(graph(extra), {}, META);
            r.id = "imported";
            r.name = "Imported";
            if (refs !== undefined) r.refs = refs;
            return quiet(() => recipes._normalize(r));
        };
        const specOf = (extra, refs) => { const [r, warned] = imported(extra, refs); return { r, spec: C.comfyRefSpec(r), warned }; };

        let { r, spec } = specOf(EDIT_PLUS);
        check("fromPrompt keeps the canvas id and the crop_image links, and adds no refs", r.kind === "comfy" && r.canvas === "1" && eq(r.prompt["10"].inputs.image, ["1", 0]) && !("refs" in r), short({ kind: r.kind, canvas: r.canvas, refs: r.refs }));
        check("TextEncodeQwenImageEditPlus image1..3 <- batches 0..2: Picture {n}, 3 slots, not a guess", spec.name === "Picture {n}" && spec.slots === 3 && spec.guess === false, short({ ...spec, trim: undefined }));
        check("EditPlus: trim is 20.image1..3 on batches 0..2", eq(spec.trim, [{ node: "20", input: "image1", batch: 0 }, { node: "20", input: "image2", batch: 1 }, { node: "20", input: "image3", batch: 2 }]), short(spec.trim));

        ({ spec } = specOf(QWEN21));
        check("TextEncodeQwenImage21 images.image_1..3 <- batches 0..2: <image{n}>, 3 slots, not a guess", spec.name === "<image{n}>" && spec.slots === 3 && spec.guess === false && spec.trim && spec.trim.length === 3, short(spec));
        const shuffled = clone(QWEN21);
        const inp = shuffled["20"].inputs;
        shuffled["20"].inputs = { clip: inp.clip, "images.image_3": inp["images.image_3"], vae: inp.vae, "images.image_1": inp["images.image_1"], prompt: inp.prompt, "images.image_2": inp["images.image_2"] };
        ({ spec } = specOf(shuffled));
        check("Qwen 2.1 with the image inputs written out of order: numbered by k, still <image{n}> with 3 slots", spec.name === "<image{n}>" && spec.slots === 3 && eq(spec.trim && spec.trim.map((t) => t.input), ["images.image_1", "images.image_2", "images.image_3"]), short(spec));

        ({ spec } = specOf(CHAIN));
        check("a ReferenceLatent chain of 2 (latent <- VAEEncode <- ImageScaleToTotalPixels <- ImageFromBatch): image {n}, 2 slots, not a guess", spec.name === "image {n}" && spec.slots === 2 && spec.guess === false && eq(spec.trim, [{ node: "60", input: "latent", batch: 0 }, { node: "61", input: "latent", batch: 1 }]), short(spec));
        const swapped = clone(CHAIN);
        swapped["60"].inputs.latent = ["41", 0];
        swapped["61"].inputs.latent = ["40", 0];
        ({ spec } = specOf(swapped));
        check("a ReferenceLatent chain whose first link reads batch 1: no identity, a guess, no trim, no slots", spec.guess === true && spec.trim === null && spec.slots === null && spec.name === "image {n}", short(spec));

        ({ spec } = specOf({ "20": { class_type: "SomeApiNode", inputs: { images: ["1", 0], prompt: ["1", 7] } } }));
        check("the whole batch into one API node: image {n}, slots null, a guess, trim null", spec.name === "image {n}" && spec.slots === null && spec.guess === true && spec.trim === null, short(spec));
        ({ spec } = specOf({ ...EDIT_PLUS, "70": { class_type: "PreviewImage", inputs: { images: ["1", 0] } } }));
        check("a traceable EditPlus graph with another node reading the whole batch: a guess, slots null, trim null", spec.name === "image {n}" && spec.slots === null && spec.guess === true && spec.trim === null, short(spec));

        const gap = { "10": IFB(0), "13": IFB(3), "20": { class_type: "TextEncodeQwenImage21", inputs: { clip: ["4", 0], vae: ["3", 0], prompt: ["1", 7], "images.image_1": ["10", 0], "images.image_2": ["13", 0] } } };
        ({ r, spec } = specOf(gap));
        check("images.image_2 <- batch 3 (image_1 <- batch 0): a guess, trim null, slots null", spec.guess === true && spec.trim === null && spec.slots === null && spec.name === "image {n}", short(spec));
        check("trimSlots on that graph removes nothing", C.trimSlots(clone(r.prompt), spec, 1).length === 0);

        const linked = { ...clone(EDIT_PLUS), "11": { class_type: "ImageFromBatch", inputs: { image: ["1", 0], batch_index: ["15", 0], length: 1 } }, "15": { class_type: "PrimitiveInt", inputs: { value: 1 } } };
        ({ r, spec } = specOf(linked));
        check("an ImageFromBatch with a linked batch_index is not traced (batchOf null)", C.batchOf(r.prompt, "1", ["11", 0]) === null && C.batchOf(r.prompt, "1", ["20", 0]) === null, String(C.batchOf(r.prompt, "1", ["11", 0])));
        check("so that EditPlus graph is a guess, trim null", spec.guess === true && spec.trim === null && spec.slots === null, short(spec));

        // batchOf on its own: what ends a trace
        const bp = graph({
            "10": IFB(0),
            "11": { class_type: "ImageFromBatch", inputs: { image: ["1", 0], batch_index: 1, length: 2 } },
            "12": { class_type: "ImageFromBatch", inputs: { image: ["1", 1], batch_index: 1, length: 1 } },
            "13": { class_type: "ImageFromBatch", inputs: { image: ["1", 0], batch_index: -1, length: 1 } },
            "14": { class_type: "ImageFromBatch", inputs: { image: ["1", 0], batch_index: 1.5, length: 1 } },
            "15": { class_type: "ImageFromBatch", inputs: { image: ["5", 0], batch_index: 1, length: 1 } },
            "5": { class_type: "LoadImage", inputs: { image: "x.png" } },
            "16": { class_type: "ImageBlend", inputs: { image1: ["10", 0], image: ["10", 0], pixels: ["10", 0] } },
        });
        let chainIn = "10";
        for (let i = 1; i <= 9; i++) { bp[`s${i}`] = SCALE(chainIn); chainIn = `s${i}`; }
        const got = {
            plain: C.batchOf(bp, "1", ["10", 0]), numericCanvas: C.batchOf(bp, 1, ["10", 0]), length2: C.batchOf(bp, "1", ["11", 0]),
            output1: C.batchOf(bp, "1", ["12", 0]), negative: C.batchOf(bp, "1", ["13", 0]), fraction: C.batchOf(bp, "1", ["14", 0]),
            otherSource: C.batchOf(bp, "1", ["15", 0]), twoLinked: C.batchOf(bp, "1", ["16", 0]), missing: C.batchOf(bp, "1", ["404", 0]),
            notALink: C.batchOf(bp, "1", "10"), depth8: C.batchOf(bp, "1", ["s8", 0]), depth9: C.batchOf(bp, "1", ["s9", 0]),
        };
        const wantB = { plain: 0, numericCanvas: 0, length2: null, output1: null, negative: null, fraction: null, otherSource: null, twoLinked: null, missing: null, notALink: null, depth8: 0, depth9: null };
        check("batchOf: a literal batch_index >= 0, length 1, crop_image output 0, one linked input per step, at most 8 steps", eq(got, wantB), short(got));

        // a declared refs on an imported graph
        let warned;
        ({ spec } = specOf(QWEN21, { name: "<image{n}>", slots: 8 }));
        check("a declared slots larger than the traced k is lowered to k (8 -> 3)", spec.slots === 3 && spec.guess === false, short(spec));
        ({ spec } = specOf(QWEN21, { slots: 2 }));
        check("a declared slots below k wins (2 of 3), the name still derived", spec.slots === 2 && spec.name === "<image{n}>" && spec.guess === false, short(spec));
        ({ spec } = specOf(EDIT_PLUS, { name: "Pic {n}" }));
        check("a declared name wins over the derived one (Pic {n} over Picture {n}), not a guess, the trim stays", spec.name === "Pic {n}" && spec.guess === false && spec.slots === 3 && spec.trim && spec.trim.length === 3, short(spec));
        ({ spec } = specOf({ "20": { class_type: "SomeApiNode", inputs: { images: ["1", 0] } } }, { name: "img_{n0}", slots: 5 }));
        check("a declared refs on an untraceable graph: its name and slots, not a guess, trim null", spec.name === "img_{n0}" && spec.slots === 5 && spec.guess === false && spec.trim === null, short(spec));

        // normalize(): the comfy refs check
        [r, warned] = quiet(() => recipes._normalize({ id: "c1", kind: "comfy", refs: { name: "x", slots: 99 } }));
        check("normalize: refs { name: \"x\", slots: 99 } is deleted, with a warning naming the recipe", !("refs" in r) && warned.length === 1 && /recipe c1/.test(warned[0]), short(warned));
        [r, warned] = quiet(() => recipes._normalize({ id: "c2", kind: "comfy", refs: { name: "<image{n}>", slots: 99 } }));
        check("normalize: refs { name: \"<image{n}>\", slots: 99 } keeps the name, slots null, with a warning", eq(r.refs, { name: "<image{n}>", slots: null }) && warned.length === 1 && /refs\.slots/.test(warned[0]), short({ refs: r.refs, warned }));
        [r, warned] = quiet(() => recipes._normalize({ id: "c3", kind: "comfy", refs: { name: "<image{n}>", slots: 4 } }));
        check("normalize: refs { name: \"<image{n}>\", slots: 4 } is kept as it is, no warning", eq(r.refs, { name: "<image{n}>", slots: 4 }) && !warned.length, short({ refs: r.refs, warned }));
        const more = [
            [{ slots: 16 }, { slots: 16 }, 0], [{ slots: 17 }, { slots: null }, 1], [{ slots: 0 }, { slots: null }, 1], [{ slots: 2.5 }, { slots: null }, 1],
            [{ slots: null }, { slots: null }, 0], ["junk", undefined, 1], [[{ name: "image {n}" }], undefined, 1], [null, null, 0], [{ name: "@img{n}" }, undefined, 1],
        ];
        const bad = [];
        for (const [refs, want, warns] of more) {
            const [n, w] = quiet(() => recipes._normalize({ id: "c4", kind: "comfy", refs }));
            if (!eq(n.refs, want) || w.length !== warns || (want === undefined && "refs" in n)) bad.push(`${short(refs)} -> ${short(n.refs)}, ${w.length} warnings`);
        }
        check("normalize: slots 1-16 kept, anything else null with a warning; a refs that is no object or has a bad name deleted with a warning", !bad.length, list(bad));
        [r, warned] = quiet(() => recipes._normalize({ id: "c5", kind: "comfy" }));
        check("normalize: a comfy recipe without refs gets none", !("refs" in r) && !warned.length);
    });

    if (USERDATA) fs.rmSync(USERDATA, { recursive: true, force: true });
    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + ((err && err.stack) || err)); console.log("FAIL"); process.exit(1); });
