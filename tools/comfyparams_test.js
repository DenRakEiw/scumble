// The ComfyUI window's Parameters list (item 66, electron/main/comfyparams.js), in plain Node:
//   node tools/comfyparams_test.js
// listParams on a shipped recipe's graph as the page shows it, the tick / untick page script on a stand-in for
// LiteGraph (tools/fixtures/comfyview/minigraph.js), the widget values the read takes along, and the round trip
// through recipes.fromGraph (the rows the recipe gets, their labels, specs and values). The gate comfyview runs it.
"use strict";

const fs = require("fs");
const path = require("path");
const comfyparams = require("../electron/main/comfyparams.js");
const { fromGraph, toPrompt, pageValue } = require("../electron/main/recipes_graph.js");
require("./fixtures/comfyview/minigraph.js");

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}

const ROOT = path.join(__dirname, "..");
const klein = JSON.parse(fs.readFileSync(path.join(ROOT, "recipes", "flux2_klein_local.json"), "utf-8"));
klein.id = "flux2_klein_local";
const INFO = {
    Flux2Scheduler: { input: { required: { steps: ["INT", { default: 20, min: 1, max: 200 }] } } },
    ImageScaleToTotalPixels: { input: { required: { upscale_method: [["nearest-exact", "lanczos"], {}], megapixels: ["FLOAT", { default: 1, min: 0.01, max: 16, step: 0.01 }], resolution_steps: ["INT", { default: 1 }] } } },
    KSamplerSelect: { input: { required: { sampler_name: [["euler", "dpmpp_2m"], {}] } } },
    CFGGuider: { input: { required: { cfg: ["FLOAT", { default: 8, min: 0, max: 100 }] } } },
};

async function main() {
    // the page, as ComfyUI shows a recipe it was handed: the API prompt with the Settings rows wired to the canvas node
    const page = { app: null };
    globalThis.window = page;
    const rowValues = Object.fromEntries(klein.settings.map((s) => [`${s.node}|${s.input}`, klein.prompt[s.node].inputs[s.input]]));
    const m = globalThis.__miniGraph(toPrompt(klein), "wf-1", rowValues);
    page.app = { graph: m.graph, graphToPrompt: m.graphToPrompt };
    const read = async () => page.app.graphToPrompt();
    const run = (script) => new Function("window", "return " + script)(page);

    // 1. the list: grouped by node, the recipe's rows ticked with their setting number, linked and canvas inputs left out
    let p = await read();
    let L = comfyparams.listParams({ output: p.output, workflow: p.workflow, objectInfo: INFO });
    const find = (L, node, input) => { const n = L.nodes.find((x) => x.id === node); return n ? n.inputs.find((i) => i.name === input) || null : null; };
    const ticked = klein.settings.every((s) => { const r = find(L, s.node, s.input); return r && r.exposed && r.index === s.index; });
    check("the recipe's Settings rows show ticked, each with its setting output", ticked && L.used === klein.settings.length, JSON.stringify(L.nodes.flatMap((n) => n.inputs.filter((i) => i.exposed).map((i) => n.id + "." + i.name + "=" + i.index))));
    check("the canvas node's own inputs and inputs wired from other nodes are not offered",
        !L.nodes.some((n) => n.id === "canvas") && !find(L, "guider", "model") && !find(L, "run", "noise") && !!find(L, "guider", "cfg"));
    const mp = find(L, "scale1", "megapixels"), sn = find(L, "sampler", "sampler_name"), bs = find(L, "latent", "batch_size");
    check("kinds from the server's node list, else from the value; the value shown", mp && mp.kind === "FLOAT" && sn && sn.kind === "COMBO" && sn.value === "euler" && bs && bs.kind === "INT" && mp.label === "ImageScaleToTotalPixels · megapixels",
        JSON.stringify({ mp, sn, bs }));
    check("8 setting outputs, 6 in use, not full", L.cap === 8 && !L.full && L.canvas === "canvas", JSON.stringify({ cap: L.cap, used: L.used, full: L.full }));

    // 2. an untick takes the link away (the widget keeps its value), a tick links the lowest free setting output
    let r = run(comfyparams.exposeScript("scale0", "megapixels", false));
    check("an untick answers ok", r && r.ok === true, JSON.stringify(r));
    r = run(comfyparams.exposeScript("sampler", "sampler_name", true));
    check("a tick takes the lowest free setting output (6, freed by the untick)", r && r.ok && r.index === 6, JSON.stringify(r));
    r = run(comfyparams.exposeScript("scale1", "megapixels", true));
    check("the next tick takes 7", r && r.ok && r.index === 7, JSON.stringify(r));
    const again = run(comfyparams.exposeScript("scale1", "megapixels", true));
    check("a tick of an input already a row answers its row", again && again.ok && again.index === 7, JSON.stringify(again));
    const linked = run(comfyparams.exposeScript("guider", "model", true));
    check("an input linked from another node is refused", linked && linked.ok === false && /another node/.test(linked.error), JSON.stringify(linked));
    const none = run(comfyparams.exposeScript("nosuch", "x", true));
    check("a node the graph does not hold is refused", none && none.ok === false && /no node/.test(none.error), JSON.stringify(none));
    let threw = null;
    try { comfyparams.exposeScript("a\"b", "x", true); } catch (e) { threw = e.message; }
    check("a node id that is no plain id never reaches a script", !!threw && !comfyparams.validTarget("92:7", "steps") && !comfyparams.validTarget("x", "a\"b") && comfyparams.validTarget("12", "denoise"));
    p = await read();
    L = comfyparams.listParams({ output: p.output, workflow: p.workflow, objectInfo: INFO });
    check("the list read again: scale0 unticked (its value back), sampler 6 and scale1 7 ticked",
        find(L, "scale0", "megapixels").exposed === false && find(L, "scale0", "megapixels").value === "1" && find(L, "sampler", "sampler_name").index === 6 && find(L, "scale1", "megapixels").index === 7 && L.used === 7);

    // 3. the read takes the widgets' values along, and fromGraph gives a new row that value (not the spec's default)
    m.graph.getNodeById("scale1").widgets.find((w) => w.name === "megapixels").value = 2.5;
    const valuesText = await new Function("window", "return (async () => { const p = await window.app.graphToPrompt(); return " + comfyparams.VALUES_JS + "; })()")(page);
    const values = comfyparams.parseValues(valuesText);
    check("the read's values: the inputs wired to the canvas node, as the widgets hold them", values && values["scale1|megapixels"] === 2.5 && values["sampler|sampler_name"] === "euler" && values["sigmas|steps"] === 20 && !("scale0|megapixels" in values), valuesText);
    p = await read();
    const saved = fromGraph({ output: p.output, workflow: p.workflow, objectInfo: INFO, base: klein, ids: [], date: "2026-11-15", values });
    const row = (node, input) => saved.settings.find((s) => s.node === node && s.input === input);
    check("Save: the new rows by their setting number, the label <title> · <input>, the spec from the node list",
        row("sampler", "sampler_name") && row("sampler", "sampler_name").index === 6 && row("scale1", "megapixels").index === 7 && row("scale1", "megapixels").label === "ImageScaleToTotalPixels · megapixels"
        && JSON.stringify(row("scale1", "megapixels").spec) === JSON.stringify(INFO.ImageScaleToTotalPixels.input.required.megapixels) && JSON.stringify(row("sampler", "sampler_name").spec) === JSON.stringify([["euler"], {}]),
        JSON.stringify(saved.settings));
    check("Save: the new rows start with the page's values; the held recipe's rows keep their own",
        saved.prompt.scale1.inputs.megapixels === 2.5 && saved.prompt.sampler.inputs.sampler_name === "euler" && saved.prompt.sigmas.inputs.steps === klein.prompt.sigmas.inputs.steps && row("sigmas", "steps").label === klein.settings.find((s) => s.node === "sigmas").label);
    check("Save: the unticked row is gone, its input holds a value", !row("scale0", "megapixels") && saved.prompt.scale0.inputs.megapixels === 1 && saved.settings.length === 7);
    const noValues = fromGraph({ output: p.output, workflow: p.workflow, objectInfo: INFO, base: klein, ids: [], date: "2026-11-15" });
    check("without the page's values a new row takes the spec's default, as before", noValues.prompt.scale1.inputs.megapixels === 1);
    check("pageValue keeps plain values only", pageValue({ "a|b": 1, "a|c": Infinity, "a|d": { x: 1 }, "a|e": "x".repeat(10001) }, "a", "b") === 1 && pageValue({ "a|c": Infinity }, "a", "c") === undefined
        && pageValue({ "a|d": { x: 1 } }, "a", "d") === undefined && pageValue({ "a|e": "x".repeat(10001) }, "a", "e") === undefined && pageValue(null, "a", "b") === undefined);
    check("parseValues drops what is no plain value", JSON.stringify(comfyparams.parseValues(JSON.stringify({ a: 1, b: [1], c: null, d: true }))) === JSON.stringify({ a: 1, d: true }) && comfyparams.parseValues("[1]") === null && comfyparams.parseValues("x") === null);

    // 4. full: all eight in use, the list says so; a tick past it is refused by the page script
    for (const [n, i] of [["latent", "batch_size"]]) run(comfyparams.exposeScript(n, i, true));
    p = await read();
    L = comfyparams.listParams({ output: p.output, workflow: p.workflow, objectInfo: INFO });
    const ninth = run(comfyparams.exposeScript("scale2", "megapixels", true));
    check("all eight in use: full, a plain note, and a ninth tick refused", L.used === 8 && L.full && /All 8 setting outputs/.test(L.note) && ninth.ok === false && /every setting output/.test(ninth.error), JSON.stringify({ used: L.used, note: L.note, ninth }));

    // 5. graphs without one Inpaint Canvas node; a node inside a subgraph is counted, not offered
    const noCanvas = comfyparams.listParams({ output: { 1: { class_type: "KSampler", inputs: { denoise: 1 } } } });
    check("a graph without the node: no list, a plain note", !noCanvas.canvas && !noCanvas.nodes.length && /Inpaint Canvas node/.test(noCanvas.note));
    const two = comfyparams.listParams({ output: { a: { class_type: "InpaintCanvas", inputs: {} }, b: { class_type: "InpaintCanvas", inputs: {} } } });
    check("two Inpaint Canvas nodes: refused with a note", !two.canvas && /more than one/.test(two.note));
    const sub = comfyparams.listParams({ output: { 1: { class_type: "InpaintCanvas", inputs: {} }, "5:3": { class_type: "KSampler", inputs: { denoise: 0.5, steps: 20 } }, 4: { class_type: "KSampler", inputs: { denoise: 0.7, model: ["9", 0], latent: { x: 1 } } } } });
    check("a subgraph's inputs are counted in the note; objects and links are no widgets", sub.nodes.length === 1 && sub.nodes[0].id === "4" && sub.nodes[0].inputs.length === 1 && /2 inputs inside subgraphs/.test(sub.note), JSON.stringify(sub));
    const big = { c: { class_type: "InpaintCanvas", inputs: {} } };
    for (let i = 0; i < 450; i++) big[String(i)] = { class_type: "Primitive", inputs: { value: i } };
    const many = comfyparams.listParams({ output: big });
    check("a very large graph lists at most 400 inputs and says how many more there are", many.nodes.length === 400 && /50 more inputs/.test(many.note), many.note);

    // 6. review fixes (2026-11-15). Fan-out: one setting output feeding two inputs counts once
    const fan = {
        canvas: { class_type: "InpaintCanvas", inputs: {} },
        k1: { class_type: "KSampler", inputs: { seed: ["canvas", 13], steps: ["canvas", 14], cfg: ["canvas", 15], denoise: 1 } },
        k2: { class_type: "KSampler", inputs: { seed: ["canvas", 13], steps: ["canvas", 16], cfg: ["canvas", 17], denoise: ["canvas", 18], sampler_name: ["canvas", 19], scheduler: "normal" } },
        k3: { class_type: "CLIPTextEncode", inputs: { text: ["canvas", 7], clip: ["k1", 0] } },
    };
    const page2 = { app: null };
    const m2 = globalThis.__miniGraph(fan, "wf-2");
    page2.app = { graph: m2.graph, graphToPrompt: m2.graphToPrompt };
    const run2 = (script) => new Function("window", "return " + script)(page2);
    p = await page2.app.graphToPrompt();
    L = comfyparams.listParams({ output: p.output, workflow: p.workflow });
    check("fan-out: setting 1 feeding two seeds counts once (7 of 8 in use, not full)", L.used === 7 && !L.full && find(L, "k1", "seed").index === 1 && find(L, "k2", "seed").index === 1, JSON.stringify({ used: L.used, full: L.full }));
    const eighth = run2(comfyparams.exposeScript("k1", "denoise", true));
    check("fan-out: the one free output is taken by a tick", eighth.ok && eighth.index === 8, JSON.stringify(eighth));
    // a link from a fixed canvas output is no Settings row: a tick refuses, an untick leaves it alone
    const fixedTick = run2(comfyparams.exposeScript("k3", "text", true));
    const fixedUntick = run2(comfyparams.exposeScript("k3", "text", false));
    const kept = m2.graph.getNodeById("k3").inputs.find((i) => i.name === "text").link != null;
    check("a link from a fixed canvas output: no tick, and an untick leaves the link", fixedTick.ok === false && fixedUntick.ok === true && kept, JSON.stringify({ fixedTick, fixedUntick, kept }));
    // a page whose connect answers without linking: a plain failure, not a claimed success
    const m3 = globalThis.__miniGraph(fan, "wf-3");
    const page3 = { app: { graph: m3.graph, graphToPrompt: m3.graphToPrompt } };
    m3.canvas.connect = () => ({ id: 99 });
    const fake = new Function("window", "return " + comfyparams.exposeScript("k1", "denoise", true))(page3);
    check("a connect that links nothing is reported as a failure", fake.ok === false && /did not take the link/.test(fake.error), JSON.stringify(fake));

    // 3. a held recipe's row unticked and ticked again under another index keeps its value, label and spec
    const m4 = globalThis.__miniGraph(toPrompt(klein), "wf-4", rowValues);
    const page4 = { app: { graph: m4.graph, graphToPrompt: m4.graphToPrompt } };
    const run4 = (script) => new Function("window", "return " + script)(page4);
    run4(comfyparams.exposeScript("sigmas", "steps", false));
    const took4 = run4(comfyparams.exposeScript("scale1", "megapixels", true));
    const back = run4(comfyparams.exposeScript("sigmas", "steps", true));
    m4.graph.getNodeById("sigmas").widgets.find((w) => w.name === "steps").value = 33;
    const v4 = comfyparams.parseValues(await new Function("window", "return (async () => { const p = await window.app.graphToPrompt(); return " + comfyparams.VALUES_JS + "; })()")(page4));
    p = await page4.app.graphToPrompt();
    const re = fromGraph({ output: p.output, workflow: p.workflow, objectInfo: INFO, base: klein, ids: [], date: "2026-11-15", values: v4 });
    const steps = re.settings.find((s) => s.node === "sigmas" && s.input === "steps");
    const held = klein.settings.find((s) => s.node === "sigmas" && s.input === "steps");
    check("a held row re-ticked under another index keeps the recipe's value, label and spec", took4.index === 4 && back.index === 7 && steps && steps.index === 7
        && re.prompt.sigmas.inputs.steps === klein.prompt.sigmas.inputs.steps && steps.label === held.label && JSON.stringify(steps.spec) === JSON.stringify(held.spec !== undefined ? held.spec : INFO.Flux2Scheduler.input.required.steps),
        JSON.stringify({ took4, back, steps, value: re.prompt.sigmas.inputs.steps }));

    // 4. / 5. subgraphs: a wired row inside one is listed locked; a canvas node inside one gives no list
    const locked = comfyparams.listParams({ output: { 1: { class_type: "InpaintCanvas", inputs: {} }, "5:3": { class_type: "KSampler", inputs: { denoise: ["1", 13], steps: 20 } } } });
    const lr = find(locked, "5:3", "denoise");
    check("a row wired inside a subgraph is listed locked, its free inputs counted", lr && lr.exposed && lr.locked && !find(locked, "5:3", "steps") && locked.used === 1 && /1 input inside subgraphs is not listed/.test(locked.note), JSON.stringify(locked));
    const deep = comfyparams.listParams({ output: { "92:1": { class_type: "InpaintCanvas", inputs: {} }, 4: { class_type: "KSampler", inputs: { denoise: 1 } } } });
    check("a canvas node inside a subgraph: no list, a plain note", !deep.canvas && !deep.nodes.length && /inside a subgraph/.test(deep.note), deep.note);

    // 7. the cap keeps the wired rows
    const big2 = { c: { class_type: "InpaintCanvas", inputs: {} } };
    for (let i = 0; i < 450; i++) big2[String(i)] = { class_type: "Primitive", inputs: { value: i } };
    big2["449"].inputs.other = ["c", 13];
    const capped = comfyparams.listParams({ output: big2 });
    const lastRow = find(capped, "449", "other");
    check("past the 400-row cap a wired row is still listed", lastRow && lastRow.exposed && capped.nodes.reduce((n, x) => n + x.inputs.length, 0) === 400 && /51 more inputs/.test(capped.note), JSON.stringify({ lastRow, note: capped.note }));

    const ok = results.every(Boolean);
    console.log(ok ? "PASS" : "FAIL");
    process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); console.log("FAIL"); process.exit(1); });
