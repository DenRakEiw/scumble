// The whole picture through an upscale recipe on the user's ComfyUI (docs/PLAN_0_1_42.md U2 "Tests"), in plain Node, no
// Electron, no ComfyUI and no network:
//   node tools/comfyprompt_test.js
// renderer/editor/comfyprompt.js (an ES module, imported as tools/comfyrefs_test.js imports comfyrefs.js) is the API under
// test: wholePicturePrompt on both shipped local upscalers (recipes/rtx_vsr_local.json, recipes/upscale_model_local.json),
// read raw and as electron/main/recipes.js normalize() serves them (loaded with electron stood in for): the canvas node
// becomes InpaintCanvasLoadRef with the picture's ref and nothing else, every other node and link unchanged, a
// PreviewImage on the result, the Settings rows and the factor written, the recipe's own graph untouched; the refusal of
// a graph that reads more than the picture from the canvas node (and of the other shapes it cannot run); resultOf,
// canvasReads, wholePictureClasses; CANVAS_OUTPUTS against recipes.js's own list.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const util = require("node:util");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const RECIPES = path.join(ROOT, "recipes");

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const eq = (a, b) => util.isDeepStrictEqual(a, b);
const clone = (v) => JSON.parse(JSON.stringify(v));
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 400 ? s.slice(0, 400) + " ..." : s; };
const throws = (fn) => { try { fn(); return null; } catch (e) { return (e && e.message) || String(e); } };
async function section(name, fn) {
    console.log(`\n--- ${name} ---`);
    try { await fn(); } catch (err) { check(`${name}: ran through`, false, String(err && err.stack || err).split(/\r?\n/).slice(0, 3).join(" ")); }
}

let USERDATA = "";
function loadRecipes() {
    USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-comfyprompt-test-"));
    const orig = Module._load;
    Module._load = function (request, ...rest) {
        if (request === "electron") return { app: { getPath: () => USERDATA } };
        return orig.call(this, request, ...rest);
    };
    try { return require(path.join(ROOT, "electron", "main", "recipes.js")); } finally { Module._load = orig; }
}
const rawFile = (id) => JSON.parse(fs.readFileSync(path.join(RECIPES, id + ".json"), "utf8"));
/** Every link of a prompt as "node.input -> from:slot". */
const linksOf = (p) => {
    const out = [];
    for (const [id, n] of Object.entries(p)) for (const [k, v] of Object.entries((n && n.inputs) || {})) if (Array.isArray(v)) out.push(`${id}.${k} -> ${v[0]}:${v[1]}`);
    return out.sort();
};

async function main() {
    const C = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "comfyprompt.js")).href);
    const recipes = loadRecipes();
    const warn = console.warn;
    const norm = (id) => { console.warn = () => {}; try { return recipes._normalize(rawFile(id)); } finally { console.warn = warn; } };
    const REF = { filename: "n7_upscale_20261004.png", subfolder: "inpaint_canvas", type: "input" };

    await section("the names", async () => {
        check("the answer's node is scumble_out, the loader InpaintCanvasLoadRef", C.WHOLE_OUTPUT === "scumble_out" && C.LOAD_CLASS === "InpaintCanvasLoadRef");
        const src = fs.readFileSync(path.join(ROOT, "electron", "main", "recipes.js"), "utf8");
        const m = /const CANVAS_OUTPUTS = (\[[^\]]*\]);/.exec(src);
        const theirs = m ? JSON.parse(m[1]) : null;
        check("CANVAS_OUTPUTS is recipes.js's list, slot for slot", !!theirs && eq(C.CANVAS_OUTPUTS, theirs), short({ ours: C.CANVAS_OUTPUTS, theirs }));
        const cases = [["rtx:0", { node: "rtx", slot: 0 }], ["up:2", { node: "up", slot: 2 }], ["a:b:1", { node: "a:b", slot: 1 }], ["x", { node: "x", slot: 0 }], ["x:-1", null], ["x:1.5", null], [":0", null], ["", null]];
        const bad = cases.filter(([s, want]) => !eq(C.resultOf({ result: s }), want)).map(([s]) => s);
        check("resultOf reads node:slot (the last colon), a missing slot as 0, refuses a bad one", !bad.length, short(bad));
        check("resultOf without a result is null", C.resultOf({}) === null && C.resultOf(null) === null);
    });

    for (const [id, how] of [["rtx_vsr_local", "raw"], ["rtx_vsr_local", "normalized"], ["upscale_model_local", "raw"], ["upscale_model_local", "normalized"]]) {
        await section(`${id} (${how})`, async () => {
            const r = how === "raw" ? rawFile(id) : norm(id);
            const before = clone(r);
            const rtx = id === "rtx_vsr_local";
            const settings = rtx ? { 1: { value: "HIGH" } } : { 1: { value: "2xESRGAN.pth" } };
            const factor = rtx ? 3 : null;
            check("the recipe can upscale the whole picture (no refusal)", C.wholePictureRefusal(r) === "", C.wholePictureRefusal(r));
            const p = C.wholePicturePrompt(r, REF, factor, settings);
            const cv = p[r.canvas];
            check("the canvas node keeps its id and becomes InpaintCanvasLoadRef with the picture's ref and nothing else",
                cv && cv.class_type === "InpaintCanvasLoadRef" && eq(Object.keys(cv.inputs), ["ref"]) && eq(JSON.parse(cv.inputs.ref), REF), short(cv));
            const out = p.scumble_out;
            const [rn, rs] = String(r.result).split(":");
            check("a PreviewImage named scumble_out reads the recipe's result", out && out.class_type === "PreviewImage" && eq(out.inputs, { images: [rn, +rs] }), short(out));
            check("every link of the recipe is there unchanged, and the only new one is the answer's",
                eq(linksOf(p), [...linksOf(r.prompt).filter((l) => !l.startsWith(`${r.canvas}.`)), `scumble_out.images -> ${rn}:${rs}`].sort()), short({ got: linksOf(p), had: linksOf(r.prompt) }));
            check("the nodes are the recipe's and the answer's", eq(Object.keys(p).sort(), [...Object.keys(r.prompt), "scumble_out"].sort()), short(Object.keys(p)));
            // what changes besides the canvas node: the Settings row's value and the factor only
            const diffs = [];
            for (const [nid, n] of Object.entries(r.prompt)) {
                if (nid === r.canvas) continue;
                if (p[nid].class_type !== n.class_type) diffs.push(`${nid} class`);
                for (const k of new Set([...Object.keys(n.inputs || {}), ...Object.keys(p[nid].inputs || {})])) if (!eq(n.inputs[k], p[nid].inputs[k])) diffs.push(`${nid}.${k}=${JSON.stringify(p[nid].inputs[k])}`);
            }
            const want = rtx ? ['rtx.quality="HIGH"', "rtx.resize_type.scale=3"] : ['loader.model_name="2xESRGAN.pth"'];
            check("the Settings row and the factor are written, nothing else", eq(diffs.sort(), want.sort()), short(diffs));
            check("the recipe's own graph is untouched", eq(r, before));
            // without a factor (an upscale model, or the graph's own) and without settings: the graph's values
            const plain = C.wholePicturePrompt(r, REF, null, null);
            check("factor null and no settings: the graph's own values", rtx
                ? plain.rtx.inputs["resize_type.scale"] === 2 && plain.rtx.inputs.quality === "ULTRA"
                : plain.loader.inputs.model_name === "4x-UltraSharp.pth", short(rtx ? plain.rtx.inputs : plain.loader.inputs));
            const cls = C.wholePictureClasses(r);
            const wantCls = rtx ? ["ImageFromBatch", "InpaintCanvasLoadRef", "PreviewImage", "RTXVideoSuperResolution"] : ["ImageFromBatch", "ImageUpscaleWithModel", "InpaintCanvasLoadRef", "PreviewImage", "UpscaleModelLoader"];
            check("wholePictureClasses: the loader for InpaintCanvas, PreviewImage added", eq(cls, wantCls), short(cls));
            const ref2 = C.wholePicturePrompt(r, { filename: "a.png" }, null, null)[r.canvas].inputs.ref;
            check("a ref without subfolder and type goes as subfolder \"\" and type input", eq(JSON.parse(ref2), { filename: "a.png", subfolder: "", type: "input" }), ref2);
            if (how === "normalized") {
                check(rtx ? "normalized: the factor names its input, limits 64 / 4096 / 8192" : "normalized: a fixed factor, limits max 2048 (Q14: 4x answers at most 8192)",
                    rtx ? r.factor.input === "rtx|resize_type.scale" && eq(r.limits, { min: 64, max: 4096, out: 8192 }) : r.factor.fixed === true && eq(r.limits, { max: 2048 }), short({ factor: r.factor, limits: r.limits }));
            }
        });
    }

    await section("the graph reads more than the picture: refused", async () => {
        const base = norm("rtx_vsr_local");
        const withMask = clone(base);
        withMask.prompt.mask = { class_type: "MaskToImage", inputs: { mask: ["canvas", 1] } };
        const m1 = C.wholePictureRefusal(withMask);
        check("a node reading the canvas node's slot 1 (crop_mask) is refused by name",
            m1 === "RTX Video Super Resolution (ComfyUI) reads more than the picture from the canvas node (its crop_mask); it cannot upscale the whole picture.", m1);
        check("wholePicturePrompt throws the same sentence", throws(() => C.wholePicturePrompt(withMask, REF, 2, null)) === m1);
        const more = clone(base);
        more.prompt.t = { class_type: "CLIPTextEncode", inputs: { text: ["canvas", 7], clip: ["x", 0] } };
        more.prompt.s = { class_type: "Note", inputs: { a: ["canvas", 13], b: ["canvas", 7] } };
        const m2 = C.wholePictureRefusal(more);
        check("several slots are named once each, a Settings slot as \"setting n\"", /its prompt, setting 1\)/.test(m2), m2);
        const reads = C.canvasReads(more).map((x) => `${x.node}.${x.input}:${x.slot}`).sort();
        check("canvasReads lists every input that reads the canvas node", eq(reads, ["img0.image:0", "s.a:13", "s.b:7", "t.text:7"]), short(reads));
        const numeric = clone(base);
        numeric.canvas = "1";
        numeric.prompt = { "1": numeric.prompt.canvas, "2": { class_type: "ImageFromBatch", inputs: { image: [1, 0], batch_index: 0, length: 1 } }, "3": { class_type: "Up", inputs: { image: ["2", 0], m: [1, 1] } } };
        numeric.result = "3:0";
        check("a link that names the canvas node by number counts too", /its crop_mask/.test(C.wholePictureRefusal(numeric)), C.wholePictureRefusal(numeric));
        const own = clone(base);
        own.prompt.canvas.inputs.result_local = ["rtx", 0];
        check("the canvas node's own links (its result input) are no reason to refuse, and go with the node", C.wholePictureRefusal(own) === "" && eq(Object.keys(C.wholePicturePrompt(own, REF, 2, null).canvas.inputs), ["ref"]));
        const noCanvas = clone(base); noCanvas.canvas = "nope";
        check("no canvas node: refused", /has no canvas node "nope"/.test(C.wholePictureRefusal(noCanvas)), C.wholePictureRefusal(noCanvas));
        const noResult = clone(base); noResult.result = "gone:0";
        check("a result that names no node: refused", /names no result node/.test(C.wholePictureRefusal(noResult)), C.wholePictureRefusal(noResult));
        const canvasResult = clone(base); canvasResult.result = "canvas:0";
        check("the canvas node as the result: refused", /names no result node/.test(C.wholePictureRefusal(canvasResult)));
        const taken = clone(base); taken.prompt.scumble_out = { class_type: "PreviewImage", inputs: { images: ["rtx", 0] } };
        check("a graph that holds a node named scumble_out: refused", /holds a node named scumble_out/.test(C.wholePictureRefusal(taken)), C.wholePictureRefusal(taken));
        check("no recipe: refused", C.wholePictureRefusal(null) === "No recipe selected." && C.wholePictureRefusal({ id: "x" }) === "No recipe selected.");
    });

    await section("the Settings rows and the factor target", async () => {
        const r = norm("rtx_vsr_local");
        const canvasRow = clone(r);
        canvasRow.settings.push({ index: 2, node: "canvas", input: "padding", label: "Padding" });
        const p = C.wholePicturePrompt(canvasRow, REF, 2, { 1: { value: "LOW" }, 2: { value: 99 } });
        check("a row on the canvas node is not written (the loader takes only its ref)", eq(Object.keys(p.canvas.inputs), ["ref"]) && p.rtx.inputs.quality === "LOW");
        const nulls = C.wholePicturePrompt(r, REF, 4, { 1: { value: null } });
        check("a row without a value keeps the graph's; the factor goes in", nulls.rtx.inputs.quality === "ULTRA" && nulls.rtx.inputs["resize_type.scale"] === 4);
        const meta = clone(r);
        meta.prompt.canvas._meta = { title: "Inpaint Canvas" };
        check("the canvas node's _meta title is kept", eq(C.wholePicturePrompt(meta, REF, 2, null).canvas._meta, { title: "Inpaint Canvas" }));
        const fixed = norm("upscale_model_local");
        const pf = C.wholePicturePrompt(fixed, REF, 3, null);
        check("a recipe without a factor target ignores a factor", eq(pf.up.inputs, fixed.prompt.up.inputs) && eq(pf.loader.inputs, fixed.prompt.loader.inputs));
    });

    if (USERDATA) fs.rmSync(USERDATA, { recursive: true, force: true });
    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + ((err && err.stack) || err)); console.log("FAIL"); process.exit(1); });
