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
// Boxes in the prompt on the user's ComfyUI: localBoxSchema, boxPromptSlot by name, wireBoxPrompt on flux3_klein_local
// (only the declared input changes, the recipe's own graph untouched), oldNodeBoxes (a clone for a Registry install),
// scaleStateBoxes and newImageBoxes (Generate new), nameBoxTokens (an @img token in a description as the recipe's name).
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
                    rtx ? r.factor.input === "rtx|resize_type.scale" && eq(r.limits, { min: 64, max: 4096, out: 8192 }) : r.factor.fixed === true && eq(r.limits, { picture: 2048 }), short({ factor: r.factor, limits: r.limits }));
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

    // boxes in the prompt on the user's ComfyUI: a recipe's `boxes` (flux3_klein_local), the node's box_prompt by name,
    // the declared input rewired on a copy of the graph, the sentence of an older node, the boxes of Generate new scaled
    await section("boxes: the node's box_prompt", async () => {
        const OUTS = ["crop_image", "crop_mask", "image", "mask", "stitch_info", "crop_width", "crop_height", "prompt", "control_image", "denoise", "seed", "mode", "negative",
            "setting_1", "setting_2", "setting_3", "setting_4", "setting_5", "setting_6", "setting_7", "setting_8"];
        check("boxPromptSlot finds box_prompt by name (21 on the node of 2026-10-15, wherever it sits), -1 on an older node or no list",
            C.BOX_PROMPT === "box_prompt" && C.boxPromptSlot({ InpaintCanvas: { output_name: [...OUTS, "box_prompt", "elements"] } }) === 21
            && C.boxPromptSlot({ InpaintCanvas: { output_name: [...OUTS, "x", "box_prompt"] } }) === 22
            && C.boxPromptSlot({ InpaintCanvas: { output_name: OUTS } }) === -1 && C.boxPromptSlot({}) === -1 && C.boxPromptSlot(null) === -1);
        const k = norm("flux3_klein_local");
        const before = clone(k);
        check("flux3_klein_local declares its boxes (normalized and raw); flux2_klein_local and a provider recipe do not",
            C.localBoxSchema(k) === "flux3" && C.localBoxSchema(rawFile("flux3_klein_local")) === "flux3" && C.localBoxSchema(norm("flux2_klein_local")) === null
            && C.localBoxSchema({ kind: "provider", prompt: {}, boxes: { schema: "flux3", input: "a|b" } }) === null && C.localBoxSchema(null) === null
            && C.localBoxSchema({ ...k, boxes: { schema: "flux3", input: "nobar" } }) === null, short(k.boxes));
        const p = clone(k.prompt);
        const wired = C.wireBoxPrompt(p, k, 21);
        const diff = linksOf(p).filter((l) => !linksOf(k.prompt).includes(l));
        check("wireBoxPrompt takes say_in.string_b from box_prompt (21), every other link and the recipe's own graph as they were",
            wired && eq(p.say_in.inputs.string_b, ["canvas", 21]) && eq(diff, ["say_in.string_b -> canvas:21"]) && eq(k, before), short({ diff }));
        const p2 = clone(k.prompt);
        check("no slot, a recipe without the declaration, or an input that no longer reads the canvas node: nothing is wired",
            !C.wireBoxPrompt(p2, k, -1) && !C.wireBoxPrompt(p2, norm("flux2_klein_local"), 21) && eq(p2, k.prompt)
            && !C.wireBoxPrompt({ ...p2, say_in: { ...p2.say_in, inputs: { ...p2.say_in.inputs, string_b: "typed" } } }, k, 21));
        check("an older node's sentence names the recipe, the update (a pull for a clone, a clone for a Registry or Manager install) and the switch",
            /^FLUX 3 Image Klein \(ComfyUI\) sends the boxes through the Inpaint Canvas node's box_prompt output, .*update the Inpaint Canvas node to its current GitHub version \(a git clone: git pull in its folder under custom_nodes; installed through the Comfy Registry or the Manager: replace that folder with a git clone of https:\/\/github\.com\/DenRakEiw\/ComfyUI-InpaintCanvas\), then restart ComfyUI, or turn the Boxes switch under the prompt off\.$/.test(C.oldNodeBoxes(k)), C.oldNodeBoxes(k));
        const st = { boxes: [
            { id: "a_1", kind: "new", rect: [100, 50, 300, 250], desc: "a" },
            { id: "b_1", kind: "move", rect: [0, 0, 100, 100], src: [200, 200, 400, 300], desc: "b" },
            { id: "c_1", kind: "from", rect: [400, 400, 600, 500], src: [0.1, 0.1, 0.9, 0.9], ref: 0, desc: "c" },
        ] };
        const same = clone(st);
        check("scaleStateBoxes: the same size or no boxes leaves the state as it is",
            !C.scaleStateBoxes(same, [800, 600], [800, 600]) && eq(same, st) && !C.scaleStateBoxes({}, [800, 600], [400, 300]) && !C.scaleStateBoxes(clone(st), [0, 0], [400, 300]));
        const half = clone(st);
        const did = C.scaleStateBoxes(half, [800, 600], [400, 300]);
        check("scaleStateBoxes: rects and a move's source as fractions of the picture, a from box's source (fractions of its layer) kept",
            did && eq(half.boxes[0].rect, [50, 25, 150, 125]) && eq(half.boxes[1].src, [100, 100, 200, 150]) && eq(half.boxes[2].rect, [200, 200, 300, 250])
            && eq(half.boxes[2].src, [0.1, 0.1, 0.9, 0.9]) && half.boxes[0].src === undefined, short(half.boxes));
        // Generate new: a new picture has no source to keep, move or remove; New, Text and From boxes go
        const fresh = C.newImageBoxes([...clone(st.boxes), { id: "k_1", kind: "keep", rect: [0, 0, 10, 10], src: [0, 0, 10, 10] }, { id: "r_1", kind: "remove", rect: [0, 0, 10, 10], src: [0, 0, 10, 10] }, { id: "t_1", kind: "new", rect: [1, 1, 9, 9], text: "SALE" }]);
        check("newImageBoxes: Keep, Move and Remove left out with an API new image's note each, New, Text and From kept in order",
            eq(fresh.boxes.map((b) => b.id), ["a_1", "c_1", "t_1"]) && eq(fresh.dropped, ["b_1: a new image has no source to keep, move or remove (move).", "k_1: a new image has no source to keep, move or remove (keep).", "r_1: a new image has no source to keep, move or remove (remove)."])
            && eq(C.newImageBoxes([]), { boxes: [], dropped: [] }) && eq(C.newImageBoxes(null), { boxes: [], dropped: [] }), short(fresh));
        // an @img token in a description: the name the recipe gives that picture, as the prompt has it
        const named = [{ id: "a_1", kind: "new", rect: [0, 0, 1, 1], desc: "@img1 on the shelf, beside @img3" }, { id: "b_1", kind: "new", rect: [0, 0, 1, 1], desc: "no token" }, { id: "c_1", kind: "new", rect: [0, 0, 1, 1] }];
        const keep = clone(named);
        const out = C.nameBoxTokens(named, (n) => (n === 1 ? "<ref_image_1>" : null));
        check("nameBoxTokens: a token whose picture goes as its name, one that does not as it was, the boxes given unchanged",
            out[0].desc === "<ref_image_1> on the shelf, beside @img3" && out[1] === named[1] && out[2] === named[2] && eq(named, keep)
            && eq(C.nameBoxTokens(null, () => "x"), []) && C.nameBoxTokens([{ desc: "@img12 x" }], (n) => `<p${n}>`)[0].desc === "<p12> x", short(out));
    });

    // MOSS-Image (item 47): the boxes go as its JSON layout through ComfyUI's MOSSImageLayoutPrompt, fed by the node's
    // elements output (the one after box_prompt); the positive prompt then reads the layout node
    await section("boxes: MOSS-Image's layout", async () => {
        const m = norm("moss_image_local");
        const before = clone(m);
        check("moss_image_local declares its boxes (normalized and raw) with its layout node, and is Generate new only",
            C.localBoxSchema(m) === "moss" && C.localBoxSchema(rawFile("moss_image_local")) === "moss" && m.boxes.layout === "layout" && m.edit === false
            && C.localBoxSchema({ ...m, boxes: { schema: "moss", input: "pos|text" } }) === null, short({ boxes: m.boxes, edit: m.edit }));
        check("its layout node has no element link and nothing reads it until a run sends boxes (pos.text reads the plain prompt)",
            m.prompt.layout.class_type === "MOSSImageLayoutPrompt" && m.prompt.layout.inputs.element === undefined && eq(m.prompt.pos.inputs.text, ["canvas", 7])
            && !linksOf(m.prompt).some((l) => / -> layout:/.test(l)), short(linksOf(m.prompt)));
        const p = clone(m.prompt);
        const wired = C.wireBoxPrompt(p, m, 21);
        const diff = linksOf(p).filter((l) => !linksOf(m.prompt).includes(l)).sort();
        check("wireBoxPrompt wires layout.element to elements (22, after box_prompt 21) and pos.text to the layout, nothing else",
            wired && eq(p.layout.inputs.element, ["canvas", 22]) && eq(p.pos.inputs.text, ["layout", 0]) && eq(diff, ["layout.element -> canvas:22", "pos.text -> layout:0"]) && eq(m, before), short({ diff }));
        check("the layout's caption is the plain prompt and its pixels the latent's size",
            eq(p.layout.inputs.prompt, ["canvas", 7]) && eq(p.layout.inputs.width, ["size", 0]) && eq(p.layout.inputs.height, ["size", 1]) && eq(p.latent.inputs.width, ["size", 0]));
        const p2 = clone(m.prompt);
        check("no slot, a layout node gone, or an input that no longer reads the canvas node: nothing is wired",
            !C.wireBoxPrompt(p2, m, -1) && eq(p2, m.prompt) && !C.wireBoxPrompt({ ...clone(m.prompt), layout: undefined }, m, 21)
            && !C.wireBoxPrompt({ ...clone(m.prompt), pos: { ...p2.pos, inputs: { ...p2.pos.inputs, text: "typed" } } }, m, 21));
        check("an older node's sentence names the elements output", /^MOSS-Image \(ComfyUI\) sends the boxes through the Inpaint Canvas node's elements output, /.test(C.oldNodeBoxes(m)), C.oldNodeBoxes(m));
    });

    // FLUX 3 Image Klein's prompt upsampler (0.1.50 Q9): the switch never goes; the upsampler's nodes only when it runs
    await section("the prompt upsampler in flux3_klein_local", async () => {
        const k = norm("flux3_klein_local");
        const before = clone(k);
        const UP = "qwen3.5_9b_flux3_prompt_upsampler_w4a8.safetensors";
        const classes = { TextGenerate: {}, PreviewAny: {} };
        const files = ["qwen3vl_4b_int8_convrot.safetensors", UP];
        const upIds = ["up_clip", "up_pics", "up_run", "up_show", "up_switch"];
        check("the recipe declares its upsampler (switch, run, show, nodes, t2i) and the graph's switch takes the wrapper off and the run on",
            k.upsampler && k.upsampler.switch === "up_switch" && k.upsampler.run === "up_run" && k.upsampler.show === "up_show" && eq(k.upsampler.nodes, ["up_clip", "up_pics", "up_run", "up_show"])
            && /^You are the prompt upsampler of a text-to-image model/.test(k.upsampler.t2i) && eq(k.prompt.pos.inputs.text, ["up_switch", 0])
            && eq(k.prompt.up_switch.inputs.on_false, ["say_keep", 0]) && eq(k.prompt.up_switch.inputs.on_true, ["up_run", 0])
            && /^You are the prompt upsampler of an image-editing model/.test(k.prompt.up_run.inputs.system_prompt), short(k.upsampler && { ...k.upsampler, t2i: "..." }));
        check("ordinalNames writes <ref_image_N> as the ordinal (the crop is the first image), other text as it was",
            C.ordinalNames("put <ref_image_1> on the shelf of <ref_image_0>, like <ref_image_11>", k) === "put the second image on the shelf of the first image, like image 12"
            && C.ordinalNames("no names here", k) === "no names here" && C.ordinalNames("<ref_image_1>", { refs: { name: "image {n}" } }) === "<ref_image_1>"
            && C.ordinalNames("image 2 and image 3", { refs: { name: "image {n}" } }) === "the second image and the third image");
        // an edit: the run goes, its request is BFL's three lines with the pictures as ordinals
        const p = clone(k.prompt);
        const on = C.wireUpsampler(p, k, { text: "put <ref_image_1> on the table", files, classes });
        check("on (an edit): pos takes the run, the switch is gone, the run reads the crop batch and gets the three-line request",
            on.on && on.note === null && on.show === "up_show" && !p.up_switch && eq(p.pos.inputs.text, ["up_run", 0]) && eq(p.up_run.inputs.image, ["up_pics", 0])
            && p.up_run.inputs.prompt === "Reference images follow in order (the first image, the second image, ...).\nUser request: put the second image on the table\nOutput the caption."
            && p.up_run.inputs["sampling_mode.presence_penalty"] === 0 && !!p.up_clip && !!p.up_show && eq(k, before), short({ on, prompt: p.up_run.inputs.prompt }));
        // Generate new without pictures after the white crop: the t2i guide, the canvas line, no picture
        const pn = clone(k.prompt);
        const fresh = C.wireUpsampler(pn, k, { text: "a red fox in snow", fresh: true, refsGo: false, aspect: "16:9", files, classes });
        check("on (Generate new, no pictures): the t2i guide, TARGET CANVAS first, no image, presence penalty 1.5",
            fresh.on && pn.up_run.inputs.system_prompt === k.upsampler.t2i && pn.up_run.inputs.prompt === "TARGET CANVAS: 16:9\na red fox in snow"
            && !("image" in pn.up_run.inputs) && pn.up_run.inputs["sampling_mode.presence_penalty"] === 1.5, short(pn.up_run.inputs.prompt));
        const pr = clone(k.prompt);
        C.wireUpsampler(pr, k, { text: "<ref_image_1> in a park", fresh: true, refsGo: true, aspect: "1:1", files, classes });
        check("Generate new with pictures after the crop keeps the edit guide and the pictures",
            /image-editing model/.test(pr.up_run.inputs.system_prompt) && eq(pr.up_run.inputs.image, ["up_pics", 0]) && /User request: the second image in a park/.test(pr.up_run.inputs.prompt));
        // off: the switch row, boxes, a missing file, missing nodes
        const offCase = (o, label) => {
            const q = clone(k.prompt);
            const res = C.wireUpsampler(q, k, { text: "x", files, classes, ...o });
            const gone = upIds.every((id) => !q[id]);
            return { res, gone, wrapper: eq(q.pos.inputs.text, ["say_keep", 0]), label };
        };
        const sw = clone(k);
        sw.prompt.up_switch.inputs.switch = false;
        const qs = clone(sw.prompt);
        const rs = C.wireUpsampler(qs, sw, { text: "x", files, classes });
        check("the row off: the prompt goes through the wrapper, the upsampler's nodes and the switch are gone, no note",
            !rs.on && rs.note === null && upIds.every((id) => !qs[id]) && eq(qs.pos.inputs.text, ["say_keep", 0]) && !!qs.say_keep, short(rs));
        const b = offCase({ boxes: true });
        check("boxes going: off, with the note", !b.res.on && b.gone && b.wrapper && /stays off while boxes go/.test(b.res.note), short(b.res));
        const f = offCase({ files: ["qwen3vl_4b_int8_convrot.safetensors"] });
        check("its file not on the server: off, the note names the file and the row", !f.res.on && f.gone && f.wrapper && f.res.note.includes(UP) && /Prompt upsampler row off/.test(f.res.note), short(f.res));
        const c = offCase({ classes: { PreviewAny: {} } });
        check("TextGenerate not on the server: off, the note names it", !c.res.on && c.gone && c.wrapper && /TextGenerate node \(ComfyUI 0\.42 or newer\)/.test(c.res.note), short(c.res));
        const n = offCase({ files: null, classes: null });
        check("no node list known: it runs (the server decides)", n.res.on && !n.gone, short(n.res));
        const plain = clone(norm("flux2_klein_local").prompt);
        check("a recipe without an upsampler: nothing changes", eq(C.wireUpsampler(plain, norm("flux2_klein_local"), { text: "x" }), { on: false, note: null, show: null }) && eq(plain, norm("flux2_klein_local").prompt));
    });

    if (USERDATA) fs.rmSync(USERDATA, { recursive: true, force: true });
    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + ((err && err.stack) || err)); console.log("FAIL"); process.exit(1); });
