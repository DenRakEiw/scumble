// LoRAs on the user's ComfyUI and Comfy Cloud (item 50, docs/PLAN_LORAS.md LR0), in plain Node, no Electron, no
// ComfyUI and no network:
//   node tools/loras_test.js
// renderer/editor/loras.js (an ES module, imported as tools/comfyprompt_test.js imports comfyprompt.js) is the API under
// test, over every graph a shipped recipe carries (the local recipes' prompt, each Comfy Cloud variant's edit graph and
// its text route's own graph), read raw and as electron/main/recipes.js normalize() serves them (loaded with electron
// stood in for), with the fixtures' node list (tools/refs/comfy_templates/object_info.json) and without one (the class
// table): the model source of each, printed with its chain, and every input that read the source's MODEL re-pointed to
// the chain's end, the recipe's own graph untouched; the rows (switched off, an empty name, five in order, the sixth
// refused); the declarations through normalize (both branches; a Cloud recipe's two routes checked by themselves); the
// fixtures (a checkpoint loader with its CLIP, flattened ids, a taken id, a Nunchaku loader, a declared source that
// reads a MODEL); missingLoras (separators, an empty list refuses nothing); comboOf on both combo forms; loraStem and
// loraWords (LR1: how the status note, the via line and the log name the LoRAs a run loaded); loraFolder, groupByFolder,
// filterNames, strengthRange and clampStrength (LR2: the LoRAs section's picker and strength); familyOf over reduced
// headers of each family, recipeFamily over every shipped graph, familyFits and the amber line, the trigger words and
// the picker's family group (LR3). tools/loras_test.py (the gate `loras`) runs this file and tools/loraheader_test.js
// first, then the queue path and the section in the app.
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
    USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-loras-test-"));
    const orig = Module._load;
    Module._load = function (request, ...rest) {
        if (request === "electron") return { app: { getPath: () => USERDATA } };
        return orig.call(this, request, ...rest);
    };
    try { return require(path.join(ROOT, "electron", "main", "recipes.js")); } finally { Module._load = orig; }
}
const rawFile = (id) => JSON.parse(fs.readFileSync(path.join(RECIPES, id + ".json"), "utf8"));
/** The inputs of a graph that read `[id, slot]`, as "node.input", sorted. */
const readersOf = (g, id, slot) => {
    const out = [];
    for (const [n, node] of Object.entries(g)) for (const [k, v] of Object.entries((node && node.inputs) || {})) if (Array.isArray(v) && String(v[0]) === String(id) && v[1] === slot) out.push(`${n}.${k}`);
    return out.sort();
};
/** console.warn caught while fn runs: [result, warnings]. */
function warnsOf(fn) {
    const warn = console.warn, said = [];
    console.warn = (...a) => said.push(a.join(" "));
    try { return [fn(), said]; } finally { console.warn = warn; }
}

/**
 * Every graph a recipe carries: [route, graph, the `r` modelSource reads]. A local recipe its prompt; a provider
 * recipe's graph variants their edit graph ({ loras, save } of the variant) and their text route's own graph (the
 * route's own `text.loras` once normalised, the variant's in a raw file).
 */
function graphsOf(r, normalised) {
    const out = [];
    if (r.prompt) out.push(["prompt", r.prompt, r]);
    for (const [id, v] of Object.entries(r.providers || {})) {
        if (!v || !v.options || !v.options.graph) continue;
        out.push([id, v.options.graph, { loras: v.loras, save: v.options.save }]);
        const t = v.text && v.text.options && v.text.options.graph ? v.text : null;
        if (t) out.push([`${id}.text`, t.options.graph, { loras: normalised ? t.loras : v.loras, save: t.options.save }]);
    }
    return out;
}

// What each shipped graph's model source is and what reads it (read from the files at a86b94e + LR0): [node, readers]
// or "none" or ["many", ids]. A recipe with a graph that is not here fails the table check.
const EXPECT = {
    "flux2_klein_local/prompt": ["unet", ["guider.model"]],
    "flux3_klein_local/prompt": ["unet", ["guider.model", "sched.model"]],
    "moss_image_local/prompt": ["unet", ["slg.model"]],
    "qwen_image_edit_2_1_local/prompt": ["unet", ["cache.model"]],
    "qwen_image_edit_2_1_turbo_local/prompt": ["unet", ["cache.model"]],
    "relight_qwen_local/prompt": ["unet", ["lora_relight.model"]],
    "realism_pass/prompt": "none",
    "rtx_vsr_local/prompt": "none",
    "upscale_model_local/prompt": "none",
    "cloud_anima_base/comfycloud": ["90:78", ["90:83.model", "90:84.on_false"]],
    "cloud_anima_preview/comfycloud": ["60:44", ["60:19.model"]],
    "cloud_boogu_image_edit/comfycloud": ["45:2", ["45:21.model", "45:33.model"]],
    "cloud_flux2_dev/comfycloud": ["68:12", ["68:89.model", "68:92.on_false"]],
    "cloud_flux2_klein_9b/comfycloud": ["75:70", ["75:63.model"]],
    "cloud_flux2_klein_9b/comfycloud.text": ["75:70", ["75:63.model"]],
    "cloud_flux2_klein_9b_multi/comfycloud": ["92:106", ["92:114.model"]],
    "cloud_ideogram_4/comfycloud": "none",   // declared false (two loaders: section 2's last check)
    "cloud_krea_2_turbo/comfycloud": ["30:10", ["30:15.model", "30:22.on_false"]],
    "cloud_mage_flow/comfycloud": ["12:1", ["12:6.model"]],
    "cloud_mage_flow_edit_turbo/comfycloud": ["12:1", ["12:6.model"]],
    "cloud_qwen_image_2_1_edit/comfycloud": ["459:451", ["459:469.model"]],
    "cloud_qwen_image_2_1_edit/comfycloud.text": ["459:451", ["459:480.model"]],
    "cloud_qwen_image_edit_2509/comfycloud": ["433:37", ["433:440.on_false", "433:89.model"]],
    "cloud_z_image_turbo/comfycloud": ["57:28", ["57:11.model"]],
    "relight/comfycloud": ["10:37", ["10:89.model"]],
};
// the patches a chain must come before (the plan's patch graphs) and the switch graphs whose two branches both re-point
const PATCH = { "qwen_image_edit_2_1_local/prompt": "QwenImage21Cache", "cloud_qwen_image_2_1_edit/comfycloud": "QwenImage21Cache", "cloud_z_image_turbo/comfycloud": "ModelSamplingAuraFlow", "moss_image_local/prompt": "SkipLayerGuidanceDiTSimple", "cloud_boogu_image_edit/comfycloud": "ModelSamplingAuraFlow" };
const SWITCH = ["cloud_anima_base/comfycloud", "cloud_flux2_dev/comfycloud", "cloud_krea_2_turbo/comfycloud", "cloud_qwen_image_edit_2509/comfycloud"];

async function main() {
    const L = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "loras.js")).href);
    const recipes = loadRecipes();
    const info = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "refs", "comfy_templates", "object_info.json"), "utf8"));
    const listed = await recipes.list(RECIPES);
    const byId = (id) => listed.find((r) => r.id === id);
    const ROWS2 = [{ name: "klein\\style_a.safetensors", strength: 0.8, on: true }, { name: "style_b.safetensors", strength: 1 }];

    await section("1. the module: the cap, names, the combo on both forms, the rows a run loads", () => {
        check("MAX_LORAS is 5 and the chain is LoraLoaderModelOnly (LoraLoader with a CLIP)", L.MAX_LORAS === 5 && L.LORA_MODEL_CLASS === "LoraLoaderModelOnly" && L.LORA_CLIP_CLASS === "LoraLoader");
        check("normalizeName: backslashes as slashes, the ends trimmed, the case kept, null as \"\"",
            L.normalizeName("klein\\sub\\A.safetensors") === "klein/sub/A.safetensors" && L.normalizeName(" x/y.safetensors ") === "x/y.safetensors" && L.normalizeName(null) === "" && L.normalizeName("Q\\a") !== L.normalizeName("q/a"));
        const old = { LoraLoaderModelOnly: { input: { required: { model: ["MODEL"], lora_name: [["a.safetensors", "klein\\b.safetensors", 7], {}], strength_model: ["FLOAT", {}] } } } };
        const neu = { LoraLoaderModelOnly: { input: { required: { lora_name: ["COMBO", { options: ["a.safetensors", "klein/b.safetensors"] }] } } } };
        const opt = { X: { input: { optional: { lora_name: [["o.safetensors"]] } } } };
        check("comboOf reads [[names], {}] and [\"COMBO\", { options }] (strings only), an optional input, and answers null without a list",
            eq(L.comboOf(old, "LoraLoaderModelOnly", "lora_name"), ["a.safetensors", "klein\\b.safetensors"]) && eq(L.comboOf(neu, "LoraLoaderModelOnly", "lora_name"), ["a.safetensors", "klein/b.safetensors"])
            && eq(L.comboOf(opt, "X", "lora_name"), ["o.safetensors"]) && L.comboOf(null, "LoraLoaderModelOnly", "lora_name") === null && L.comboOf(old, "Nope", "lora_name") === null
            && L.comboOf(old, "LoraLoaderModelOnly", "strength_model") === null && L.comboOf({ X: { input: { required: { lora_name: [[], {}] } } } }, "X", "lora_name") === null);
        const rows = [{ name: "a", strength: 0.8, on: true }, { name: "b", strength: 1, on: false }, { name: "", strength: 1 }, { name: "  ", strength: 1 }, { name: "c", strength: NaN },
            { name: "d", strength: "1" }, { name: 5, strength: 1 }, null, { name: "e", strength: 0.5 }];
        check("usableRows: switched on (on left out counts as on), a name, a finite number; in order", eq(L.usableRows(rows), [{ name: "a", strength: 0.8 }, { name: "e", strength: 0.5 }]) && eq(L.usableRows(null), []), short(L.usableRows(rows)));
    });

    await section("2. every shipped recipe: its model source and its chain (raw and normalised, with and without the node list)", () => {
        const seen = new Set();
        const bad = [];
        for (const normalised of [false, true]) {
            const files = fs.readdirSync(RECIPES).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
            for (const id of files) {
                const r = normalised ? byId(id) : rawFile(id);
                if (!r) { bad.push(`${id}: not listed`); continue; }
                for (const [route, g, rr] of graphsOf(r, normalised)) {
                    const key = `${id}/${route}`;
                    seen.add(key);
                    const want = EXPECT[key];
                    for (const [iname, inf] of [["node list", info], ["class table", null]]) {
                        const before = clone(g);
                        const src = L.modelSource(g, rr, inf);
                        const where = `${normalised ? "normalised" : "raw"} ${key} (${iname})`;
                        if (want === undefined) { bad.push(`${where}: not in the table (${JSON.stringify(src)})`); continue; }
                        if (want === "none") {
                            if (!("none" in src)) bad.push(`${where}: wants none, got ${JSON.stringify(src)}`);
                            const q = clone(g);
                            const out = L.spliceLoras(q, rr, ROWS2, inf);
                            if (out.applied.length || !eq(q, before) || !/^The LoRAs stayed out: /.test(out.note || "")) bad.push(`${where}: a splice without a source changed the graph or said nothing (${short(out)})`);
                            if (!normalised && inf === info) console.log(`   ${key}: none (${src.none})`);
                            continue;
                        }
                        const [node, readers] = want;
                        if (!eq(src, { node, slot: 0, clip: null })) { bad.push(`${where}: wants ${node}:0, got ${JSON.stringify(src)}`); continue; }
                        if (!eq(readersOf(g, node, 0), readers)) bad.push(`${where}: readers ${readersOf(g, node, 0)} against ${readers}`);
                        const q = clone(g);
                        const out = L.spliceLoras(q, rr, ROWS2, inf);
                        const ok = eq(g, before) && out.note === null && eq(out.applied, [{ name: ROWS2[0].name, strength: 0.8 }, { name: ROWS2[1].name, strength: 1 }])
                            && q.scumble_lora_1 && q.scumble_lora_1.class_type === "LoraLoaderModelOnly" && eq(q.scumble_lora_1.inputs, { model: [node, 0], lora_name: ROWS2[0].name, strength_model: 0.8 })
                            && q.scumble_lora_2 && eq(q.scumble_lora_2.inputs, { model: ["scumble_lora_1", 0], lora_name: ROWS2[1].name, strength_model: 1 })
                            && eq(readersOf(q, node, 0), ["scumble_lora_1.model"]) && eq(readersOf(q, "scumble_lora_2", 0), readers)
                            && Object.keys(q).length === Object.keys(g).length + 2;
                        if (!ok) bad.push(`${where}: the chain ${short({ applied: out.applied, l1: q.scumble_lora_1, l2: q.scumble_lora_2, readers: readersOf(q, "scumble_lora_2", 0) })}`);
                        if (PATCH[key] && !readers.some((x) => q[x.split(".")[0]].class_type === PATCH[key])) bad.push(`${where}: no ${PATCH[key]} after the chain`);
                        if (!normalised && inf === info) console.log(`   ${key}: source ${node}:0 (${g[node].class_type}) -> scumble_lora_1 -> scumble_lora_2 -> ${readers.join(", ")}`);
                    }
                }
            }
        }
        const missingRows = Object.keys(EXPECT).filter((k) => !seen.has(k));
        check("every graph of every shipped recipe is in the table and nothing in the table is gone", !missingRows.length && !bad.some((b) => /not in the table|not listed/.test(b)), short([...missingRows, ...bad.filter((b) => /not in the table|not listed/.test(b))]));
        check("each graph's source and its readers as the table says, both with the node list and with the class table; the chain of two after the source, every reader re-pointed to its end, the graph given untouched, nothing else added; the upscalers, the Realism Pass and Ideogram 4 (declared false) none",
            !bad.length, short(bad));
        const k = byId("flux3_klein_local");
        const q = clone(k.prompt);
        L.spliceLoras(q, k, ROWS2, info);
        check("flux3_klein_local: sched and guider both read the chain's end", eq(q.sched.inputs.model, ["scumble_lora_2", 0]) && eq(q.guider.inputs.model, ["scumble_lora_2", 0]) && eq(k.prompt.sched.inputs.model, ["unet", 0]), short({ sched: q.sched.inputs.model, guider: q.guider.inputs.model }));
        const sw = [];
        for (const key of SWITCH) {
            const [id] = key.split("/");
            const v = byId(id).providers.comfycloud;
            const g = clone(v.options.graph);
            const [node, readers] = EXPECT[key];
            L.spliceLoras(g, { loras: v.loras, save: v.options.save }, ROWS2, info);
            const swId = readers.find((x) => /\.on_false$/.test(x)).split(".")[0];
            const loraId = readers.find((x) => /\.model$/.test(x)).split(".")[0];
            if (!(g[swId].class_type === "ComfySwitchNode" && eq(g[swId].inputs.on_false, ["scumble_lora_2", 0]) && g[loraId].class_type === "LoraLoaderModelOnly" && eq(g[loraId].inputs.model, ["scumble_lora_2", 0]) && eq(g.scumble_lora_1.inputs.model, [node, 0]))) sw.push(key);
        }
        check("the switch graphs (Anima base, Flux.2 dev, Krea 2 Turbo, Qwen Image Edit 2509): the switch's on_false and the template's own LoRA both read the chain's end, so its LoRA stacks after the user's", !sw.length, short(sw));
        const up = clone(k.prompt);
        const upNodes = new Set(k.upsampler.nodes);
        L.spliceLoras(up, k, ROWS2, info);
        check("flux3_klein_local's upsampler nodes are left as they are (no MODEL there, never a source)", [...upNodes].every((id) => eq(up[id], k.prompt[id])), short([...upNodes]));
        const iv = byId("cloud_ideogram_4").providers.comfycloud;
        const two = [info, null].map((inf) => L.modelSource(iv.options.graph, { save: iv.options.save }, inf));
        console.log(`   cloud_ideogram_4/comfycloud without its declaration: ${JSON.stringify(two[0])}`);
        check("cloud_ideogram_4's graph without its declaration: two model loaders (98:23 into CFGOverride, 98:154 into model_negative), with and without the node list", two.every((s) => eq(s, { many: ["98:154", "98:23"] })), short(two));
    });

    await section("3. the rows", () => {
        const k = byId("flux2_klein_local");
        const five = [1, 2, 3, 4, 5].map((i) => ({ name: `l${i}.safetensors`, strength: i / 10, on: true }));
        const q = clone(k.prompt);
        const out = L.spliceLoras(q, k, five, info);
        const chainOk = five.every((row, i) => {
            const n = q[`scumble_lora_${i + 1}`];
            return n && n.inputs.lora_name === row.name && n.inputs.strength_model === row.strength && eq(n.inputs.model, i ? [`scumble_lora_${i}`, 0] : ["unet", 0]);
        });
        check("five rows: five nodes in their order with their strengths, the guider on the fifth", chainOk && eq(q.guider.inputs.model, ["scumble_lora_5", 0]) && out.applied.length === 5, short(out.applied));
        const six = [...five, { name: "l6.safetensors", strength: 1 }];
        const q6 = clone(k.prompt);
        const said = throws(() => L.spliceLoras(q6, k, six, info));
        check("a sixth switched-on row is refused, the graph unchanged", !!said && /At most 5 LoRAs per recipe; the rows name 6/.test(said) && eq(q6, k.prompt), said);
        const offSixth = [...five, { name: "l6.safetensors", strength: 1, on: false }];
        const q7 = clone(k.prompt);
        check("five on and a sixth switched off: the five go", L.spliceLoras(q7, k, offSixth, info).applied.length === 5 && !q7.scumble_lora_6);
        const mixed = [{ name: "a.safetensors", strength: 0.7 }, { name: "off.safetensors", strength: 1, on: false }, { name: "", strength: 1 }, { name: "nan.safetensors", strength: NaN }, { name: "b.safetensors", strength: 1.2 }];
        const qm = clone(k.prompt);
        const om = L.spliceLoras(qm, k, mixed, info);
        check("a switched-off row, an empty name and a strength that is no number go nowhere",
            eq(om.applied, [{ name: "a.safetensors", strength: 0.7 }, { name: "b.safetensors", strength: 1.2 }]) && !JSON.stringify(qm).includes("off.safetensors") && !JSON.stringify(qm).includes("nan.safetensors") && !qm.scumble_lora_3, short(om));
        const qn = clone(k.prompt);
        const none = L.spliceLoras(qn, k, [], info);
        const none2 = L.spliceLoras(qn, k, [{ name: "x.safetensors", strength: 1, on: false }], info);
        check("no usable row: nothing changes, no note", eq(qn, k.prompt) && eq(none, { applied: [], note: null }) && eq(none2, { applied: [], note: null }));
        const qc = clone(k.prompt);
        const oc = L.spliceLoras(qc, k, [{ name: "a.safetensors", strength: 250 }, { name: "b.safetensors", strength: -300 }], info);
        check("a strength outside LoraLoaderModelOnly's -100 .. 100 is clamped", eq(oc.applied.map((x) => x.strength), [100, -100]) && qc.scumble_lora_1.inputs.strength_model === 100, short(oc.applied));
        for (const [what, list] of [["[[names], {}]", [["klein\\style_a.safetensors", "style_b.safetensors"], {}]], ["[\"COMBO\", { options }]", ["COMBO", { options: ["klein\\style_a.safetensors", "style_b.safetensors"] }]]]) {
            const inf = { ...info, LoraLoaderModelOnly: { ...info.LoraLoaderModelOnly, input: { required: { ...info.LoraLoaderModelOnly.input.required, lora_name: list } } } };
            const qs = clone(k.prompt);
            const os2 = L.spliceLoras(qs, k, [{ name: "klein/style_a.safetensors", strength: 1 }, { name: "gone/x.safetensors", strength: 1 }], inf);
            check(`a name that differs from the server's only in its separators goes in the server's spelling (${what}); one the list lacks goes as typed`,
                qs.scumble_lora_1.inputs.lora_name === "klein\\style_a.safetensors" && qs.scumble_lora_2.inputs.lora_name === "gone/x.safetensors" && os2.applied[0].name === "klein\\style_a.safetensors", short(os2.applied));
        }
    });

    await section("4. the declarations through normalize (both branches)", () => {
        const raw = rawFile("moss_image_local");
        const local = (loras, more = {}) => ({ ...clone(raw), kind: "comfy", loras, ...more });
        const kept = [];
        for (const id of ["flux2_klein_local", "flux3_klein_local", "moss_image_local", "qwen_image_edit_2_1_local", "qwen_image_edit_2_1_turbo_local"]) kept.push(`${id}=${JSON.stringify(byId(id).loras)}`);
        check("the five local edit / generate recipes declare their family through list()",
            eq(kept, ['flux2_klein_local={"family":"flux2_klein"}', 'flux3_klein_local={"family":"flux3"}', 'moss_image_local={"family":"moss_image"}', 'qwen_image_edit_2_1_local={"family":"qwen_image_2_1"}', 'qwen_image_edit_2_1_turbo_local={"family":"qwen_image_2_1"}']), short(kept));
        const others = listed.filter((r) => r.loras !== undefined && !/^(flux2_klein|flux3_klein|moss_image|qwen_image_edit_2_1(_turbo)?)_local$/.test(r.id)).map((r) => r.id);
        const variants = listed.flatMap((r) => Object.entries(r.providers || {}).filter(([, v]) => v.loras !== undefined).map(([p]) => `${r.id}/${p}`));
        check("no other recipe declares loras at the top; of the variants only cloud_ideogram_4's", !others.length && eq(variants, ["cloud_ideogram_4/comfycloud"]), short({ others, variants }));
        const ideo = byId("cloud_ideogram_4").providers.comfycloud;
        check("cloud_ideogram_4: loras false on the variant and on its text route (which runs the same graph)", ideo.loras === false && ideo.text && ideo.text.loras === false && "none" in L.modelSource(ideo.options.graph, { loras: ideo.text.loras }, info), short({ v: ideo.loras, t: ideo.text && ideo.text.loras }));
        const bad = [
            ["true", true], ["an array", []], ["a string", "flux3"], ["a number", 3], ["an empty object", {}],
            ["a model the graph lacks", { model: "nope" }], ["the canvas node as the model", { model: "canvas" }], ["a model that is no string", { model: 7 }], ["an empty family", { family: "" }],
        ];
        for (const [what, decl] of bad) {
            const [r, said] = warnsOf(() => recipes._normalize(local(decl)));
            check(`a bad loras (${what}) is dropped with a warning`, r.loras === undefined && said.length === 1 && /^moss_image_local: loras .*; left out$/.test(said[0]), short({ loras: r.loras, said }));
        }
        const [part, saidP] = warnsOf(() => recipes._normalize(local({ model: "nope", family: "moss_image", note: "x" })));
        check("a model the graph lacks is left out with one warning, the family and nothing else kept", eq(part.loras, { family: "moss_image" }) && saidP.length === 1 && /names the model source "nope", which is no node of the graph/.test(saidP[0]), short({ loras: part.loras, saidP }));
        const [off, saidO] = warnsOf(() => recipes._normalize(local(false)));
        check("loras false is kept, without a warning", off.loras === false && !saidO.length && "none" in L.modelSource(off.prompt, off, info));
        // a declared source that itself reads a MODEL (the MOSS edit recipe's edit LoRA): the chain after it
        const withLora = clone(raw);
        withLora.prompt.edit_lora = { class_type: "LoraLoaderModelOnly", inputs: { model: ["unet", 0], lora_name: "moss_image_edit_lora_rank_64_bf16.safetensors", strength_model: 1 } };
        withLora.prompt.slg.inputs.model = ["edit_lora", 0];
        const [dl, saidD] = warnsOf(() => recipes._normalize({ ...withLora, kind: "comfy", loras: { model: "edit_lora", family: "moss_image" } }));
        const srcD = L.modelSource(dl.prompt, dl, info), srcD0 = L.modelSource(dl.prompt, dl, null);
        const qd = clone(dl.prompt);
        L.spliceLoras(qd, dl, ROWS2, info);
        check("a declared model that reads a MODEL is accepted: the chain after it, slg on the chain's end, the edit LoRA still on the UNETLoader",
            !saidD.length && eq(dl.loras, { model: "edit_lora", family: "moss_image" }) && eq(srcD, { node: "edit_lora", slot: 0, clip: null }) && eq(srcD0, srcD)
            && eq(qd.scumble_lora_1.inputs.model, ["edit_lora", 0]) && eq(qd.slg.inputs.model, ["scumble_lora_2", 0]) && eq(qd.edit_lora.inputs.model, ["unet", 0]), short({ srcD, slg: qd.slg.inputs.model }));
        const generic = L.modelSource(withLora.prompt, { ...withLora, loras: undefined }, info);
        check("the same graph without the declaration: the UNETLoader by the rule (the edit LoRA reads a MODEL)", eq(generic, { node: "unet", slot: 0, clip: null }), short(generic));
        const wrong = L.modelSource(raw.prompt, { ...raw, loras: { model: "clip" } }, info);
        check("a declared node whose class gives no MODEL at its first output: no LoRAs, the reason said", "none" in wrong && /gives no MODEL/.test(wrong.none), short(wrong));
        // a Comfy Cloud recipe with an edit and a text graph (they share ids such as 75:70)
        const rk = rawFile("cloud_flux2_klein_9b");
        const kf = clone(rk);
        kf.providers.comfycloud.loras = false;
        const [nf, saidF] = warnsOf(() => recipes._normalize(kf));
        const vf = nf.providers.comfycloud;
        check("cloud_flux2_klein_9b with loras false: it holds for both routes, without a warning",
            vf.loras === false && vf.text.loras === false && !saidF.length && "none" in L.modelSource(vf.options.graph, { loras: vf.loras }, info) && "none" in L.modelSource(vf.text.options.graph, { loras: vf.text.loras }, info), short({ v: vf.loras, t: vf.text.loras, saidF }));
        const km = clone(rk);
        const ge = km.providers.comfycloud.options.graph;
        ge.my_lora = { class_type: "LoraLoaderModelOnly", inputs: { model: ["75:70", 0], lora_name: "klein_edit.safetensors", strength_model: 1 } };
        ge["75:63"].inputs.model = ["my_lora", 0];
        km.providers.comfycloud.loras = { model: "my_lora", family: "flux2" };
        const [nm, saidM] = warnsOf(() => recipes._normalize(km));
        const vm = nm.providers.comfycloud;
        const se = L.modelSource(vm.options.graph, { loras: vm.loras, save: vm.options.save }, info);
        const st = L.modelSource(vm.text.options.graph, { loras: vm.text.loras, save: vm.text.options.save }, info);
        check("a declared model honoured on the edit graph that has the node, left out with a warning on the text graph that lacks it (the family kept there), the text graph then by the rule",
            eq(vm.loras, { model: "my_lora", family: "flux2" }) && eq(vm.text.loras, { family: "flux2" }) && saidM.length === 1 && /^recipe cloud_flux2_klein_9b\/comfycloud \(text\): loras names the model source "my_lora", which is no node of the graph; left out$/.test(saidM[0])
            && eq(se, { node: "my_lora", slot: 0, clip: null }) && eq(st, { node: "75:70", slot: 0, clip: null }), short({ v: vm.loras, t: vm.text.loras, saidM, se, st }));
        const qe = clone(vm.options.graph);
        L.spliceLoras(qe, { loras: vm.loras, save: vm.options.save }, ROWS2, info);
        check("... and the splice on the edit graph goes after my_lora, CFGGuider on the chain's end", eq(qe["75:63"].inputs.model, ["scumble_lora_2", 0]) && eq(qe.scumble_lora_1.inputs.model, ["my_lora", 0]) && eq(qe.my_lora.inputs.model, ["75:70", 0]), short(qe["75:63"].inputs));
        const ap = clone(rawFile("flux3"));
        const pid = Object.keys(ap.providers)[0];
        ap.providers[pid].loras = { family: "flux3" };
        const [na, saidA] = warnsOf(() => recipes._normalize(ap));
        check("loras on an API variant (no graph) is dropped with a warning: LoRAs go into Comfy Cloud graphs only", na.providers[pid].loras === undefined && saidA.length === 1 && /without a graph/.test(saidA[0]), short(saidA));
    });

    await section("5. fixtures: a checkpoint loader with its CLIP, flattened ids, a taken id, Nunchaku, two loaders", () => {
        const ckpt = {
            ckpt: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sdxl.safetensors" } },
            pos: { class_type: "CLIPTextEncode", inputs: { clip: ["ckpt", 1], text: "a" } },
            neg: { class_type: "CLIPTextEncode", inputs: { clip: ["ckpt", 1], text: "" } },
            lat: { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
            ks: { class_type: "KSampler", inputs: { model: ["ckpt", 0], positive: ["pos", 0], negative: ["neg", 0], latent_image: ["lat", 0], seed: 1, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1 } },
            dec: { class_type: "VAEDecode", inputs: { samples: ["ks", 0], vae: ["ckpt", 2] } },
            save: { class_type: "SaveImage", inputs: { images: ["dec", 0], filename_prefix: "x" } },
        };
        const ckptInfo = { ...info, CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sdxl.safetensors"], {}] } }, output: ["MODEL", "CLIP", "VAE"], output_node: false } };
        for (const [what, inf] of [["the class table", null], ["a node list with the class", ckptInfo]]) {
            const src = L.modelSource(ckpt, { result: "dec:0" }, inf);
            const q = clone(ckpt);
            const out = L.spliceLoras(q, { result: "dec:0" }, ROWS2, inf);
            const consumers = src.clip ? src.clip.consumers.map((c) => `${c.node}.${c.input}`).sort() : [];
            check(`a checkpoint loader whose CLIP feeds the text encoders (${what}): LoraLoader nodes, strength_clip = strength, the CLIP readers on [last, 1], the VAE left`,
                src.node === "ckpt" && src.slot === 0 && src.clip && src.clip.slot === 1 && eq(consumers, ["neg.clip", "pos.clip"])
                && q.scumble_lora_1.class_type === "LoraLoader" && eq(q.scumble_lora_1.inputs, { model: ["ckpt", 0], clip: ["ckpt", 1], lora_name: ROWS2[0].name, strength_model: 0.8, strength_clip: 0.8 })
                && eq(q.scumble_lora_2.inputs, { model: ["scumble_lora_1", 0], clip: ["scumble_lora_1", 1], lora_name: ROWS2[1].name, strength_model: 1, strength_clip: 1 })
                && eq(q.pos.inputs.clip, ["scumble_lora_2", 1]) && eq(q.neg.inputs.clip, ["scumble_lora_2", 1]) && eq(q.ks.inputs.model, ["scumble_lora_2", 0]) && eq(q.dec.inputs.vae, ["ckpt", 2]) && out.applied.length === 2,
                short({ src, l1: q.scumble_lora_1, pos: q.pos.inputs.clip }));
        }
        const sepClip = clone(ckpt);
        sepClip.clipl = { class_type: "CLIPLoader", inputs: { clip_name: "t5.safetensors", type: "sd3" } };
        sepClip.pos.inputs.clip = ["clipl", 0];
        sepClip.neg.inputs.clip = ["clipl", 0];
        const s2 = L.modelSource(sepClip, { result: "dec:0" }, null);
        check("a checkpoint whose CLIP nothing reads: model-only (LoraLoaderModelOnly)", eq(s2, { node: "ckpt", slot: 0, clip: null }), short(s2));
        const flat = {
            "57:12": { class_type: "UNETLoader", inputs: { unet_name: "m.safetensors", weight_dtype: "default" } },
            "57:20": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["57:12", 0], shift: 3 } },
            "57:13": { class_type: "KSampler", inputs: { model: ["57:20", 0], seed: 1 } },
            "57:14": { class_type: "VAEDecode", inputs: { samples: ["57:13", 0] } },
            "9": { class_type: "SaveImage", inputs: { images: ["57:14", 0] } },
        };
        const qf = clone(flat);
        L.spliceLoras(qf, { save: "9" }, ROWS2, null);
        check("flattened ids (57:12): the source found, the patch on the chain's end", eq(L.modelSource(flat, { save: "9" }, null), { node: "57:12", slot: 0, clip: null }) && eq(qf["57:20"].inputs.model, ["scumble_lora_2", 0]) && eq(qf.scumble_lora_1.inputs.model, ["57:12", 0]));
        const taken = clone(flat);
        taken.scumble_lora_1 = { class_type: "PrimitiveString", inputs: { value: "mine" } };
        taken["9"].inputs.extra = ["scumble_lora_1", 0];
        const qt = clone(taken);
        L.spliceLoras(qt, { save: "9" }, ROWS2, null);
        check("an id scumble_lora_1 the graph holds already: the chain takes scumble_lora_1_2 and scumble_lora_2, the graph's own node left",
            eq(qt.scumble_lora_1, taken.scumble_lora_1) && qt.scumble_lora_1_2 && eq(qt.scumble_lora_1_2.inputs.model, ["57:12", 0]) && eq(qt.scumble_lora_2.inputs.model, ["scumble_lora_1_2", 0]) && eq(qt["57:20"].inputs.model, ["scumble_lora_2", 0]), short(Object.keys(qt)));
        const nun = { dit: { class_type: "NunchakuFluxDiTLoader", inputs: { model_path: "svdq.safetensors" } }, ks: { class_type: "KSampler", inputs: { model: ["dit", 0] } }, save: { class_type: "SaveImage", inputs: { images: ["ks", 0] } } };
        const nunInfo = { ...info, NunchakuFluxDiTLoader: { input: { required: { model_path: [["svdq.safetensors"], {}] } }, output: ["MODEL"], output_node: false } };
        const n0 = L.modelSource(nun, {}, null), n1 = L.modelSource(nun, {}, nunInfo);
        check("a Nunchaku model loader: no LoRAs (its loader needs the pack's own LoRA node), with or without the node list", "none" in n0 && "none" in n1 && /pack's own LoRA node/.test(n0.none), short({ n0, n1 }));
        const vaeOnly = clone(flat);
        vaeOnly.ck = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "x.safetensors" } };
        vaeOnly["57:14"].inputs.vae = ["ck", 2];
        check("a checkpoint loader kept for its VAE beside a UNETLoader: the UNETLoader alone is the source", eq(L.modelSource(vaeOnly, { save: "9" }, null), { node: "57:12", slot: 0, clip: null }));
        const stray = clone(flat);
        stray.u2 = { class_type: "UNETLoader", inputs: { unet_name: "other.safetensors" } };
        stray.k2 = { class_type: "KSampler", inputs: { model: ["u2", 0] } };
        check("a second loader that reaches no output is not live: one source", eq(L.modelSource(stray, { save: "9" }, null), { node: "57:12", slot: 0, clip: null }));
        const two = clone(stray);
        two["9"].inputs.more = ["k2", 0];
        const t2 = L.modelSource(two, { save: "9" }, null);
        const qt2 = clone(two);
        const ot2 = L.spliceLoras(qt2, { save: "9" }, ROWS2, null);
        check("two live loaders and no declaration: many, and a splice leaves the graph with the note naming both",
            eq(t2, { many: ["57:12", "u2"] }) && eq(qt2, two) && /2 model loaders \(57:12, u2\)/.test(ot2.note || ""), short({ t2, note: ot2.note }));
        const decl = L.modelSource(two, { save: "9", loras: { model: "u2" } }, null);
        check("... a declared one of the two is taken", eq(decl, { node: "u2", slot: 0, clip: null }), short(decl));
        const noRoot = { u: { class_type: "UNETLoader", inputs: {} }, x: { class_type: "SomethingUnknown", inputs: { model: ["u", 0] } } };
        check("a graph with no result, no save and no output node: every node live", eq(L.modelSource(noRoot, {}, null), { node: "u", slot: 0, clip: null }));
        check("no graph: none", "none" in L.modelSource(null, {}, null));
    });

    await section("6. missingLoras", () => {
        const names = ["klein\\style_a.safetensors", "qwen\\NYC_Qwen.safetensors", "root.safetensors"];
        const rows = [
            { name: "klein/style_a.safetensors", strength: 1 },      // separators only: the server's spelling
            { name: "root.safetensors", strength: 1 },               // as listed
            { name: "klein\\old.safetensors", strength: 1 },         // not there
            { name: "gone.safetensors", strength: 1, on: false },    // switched off: never asked
            { name: "", strength: 1 },
        ];
        check("a name the list has in other separators gets the server's spelling, a missing one null, a listed or switched-off one nothing",
            eq(L.missingLoras(rows, names), [{ name: "klein/style_a.safetensors", server: "klein\\style_a.safetensors" }, { name: "klein\\old.safetensors", server: null }]), short(L.missingLoras(rows, names)));
        check("against an empty or unread list nothing is missing (the names go as typed)", eq(L.missingLoras(rows, []), []) && eq(L.missingLoras(rows, null), []) && eq(L.missingLoras(rows, [3, null]), []));
        const viaCombo = L.comboOf({ LoraLoaderModelOnly: { input: { required: { lora_name: ["COMBO", { options: names }] } } } }, "LoraLoaderModelOnly", "lora_name");
        check("missingLoras over the combo read through comboOf", eq(L.missingLoras(rows, viaCombo).filter((m) => !m.server).map((m) => m.name), ["klein\\old.safetensors"]));
    });

    await section("7. the base-model hint (LR3): familyOf over reduced headers, recipeFamily over every shipped graph, the amber line", () => {
        // reduced headers in electron/main/loraheader.js reduceHeader's shape (tools/loraheader_test.js makes them from files)
        const range = (n) => Array.from({ length: n }, (_, i) => i);
        const hdr = (modules, blocks = {}, width = {}, outs = {}, metadata = {}) => ({ keyCount: modules.length * 2, modules, blocks, width, outs, metadata });
        const fam = (h, folder) => { const f = L.familyOf(h, folder); return f && [f.label, f.family, f.from]; };
        const H = {
            flux1: hdr(["lora_unet_double_blocks_N_img_attn_proj", "lora_unet_double_blocks_N_img_mlp_N", "lora_unet_single_blocks_N_linear1"], { double_blocks: range(19), single_blocks: range(38) }, { double_blocks: 3072, single_blocks: 3072 }, { double_blocks: [3072, 12288], single_blocks: [3072, 21504] }, { ss_base_model_version: "flux1" }),
            flux1Diffusers: hdr(["transformer.single_transformer_blocks.N.attn.to_k", "transformer.transformer_blocks.N.attn.add_k_proj", "transformer.transformer_blocks.N.ff.net.N.proj"], { transformer_blocks: range(19), single_transformer_blocks: range(38) }, { transformer_blocks: 3072, single_transformer_blocks: 3072 }, {}, { ss_base_model_version: "sd_1.5" }),
            klein9b: hdr(["diffusion_model.double_blocks.N.img_attn.proj", "diffusion_model.single_blocks.N.linear1"], { double_blocks: range(8), single_blocks: range(24) }, { double_blocks: 4096, single_blocks: 4096 }, { double_blocks: [4096, 24576], single_blocks: [4096, 36864] }),
            klein4b: hdr(["diffusion_model.double_blocks.N.img_mlp.N", "diffusion_model.single_blocks.N.linear1"], { double_blocks: range(5), single_blocks: range(20) }, { double_blocks: 3072, single_blocks: 3072 }, { double_blocks: [3072, 18432], single_blocks: [3072, 27648] }),
            dev: hdr(["diffusion_model.double_blocks.N.img_attn.qkv"], { double_blocks: range(8), single_blocks: range(48) }, { double_blocks: 6144, single_blocks: 6144 }),
            fewBlocks: hdr(["transformer.single_transformer_blocks.N.proj_out"], { single_transformer_blocks: [5, 8, 9, 10] }, { single_transformer_blocks: 3072 }, { single_transformer_blocks: [3072] }, { ss_base_model_version: "sd_1.5" }),
            flux3: hdr(["diffusion_model.content_mode_blocks.image.N.q_proj", "diffusion_model.single_blocks.N.attn_out"], { content_mode_blocks: range(5), single_blocks: range(28) }, { content_mode_blocks: 3072, single_blocks: 3072 }, {}, { ss_base_model_version: "flux3", tags: ["Targa"] }),
            qwen2509: hdr(["diffusion_model.transformer_blocks.N.attn.add_k_proj", "diffusion_model.transformer_blocks.N.img_mod.N"], { transformer_blocks: range(60) }, { transformer_blocks: 3072 }, {}, { ss_base_model_version: "sd_1.5", tags: ["Anna"] }),
            qwen21: hdr(["transformer.transformer_blocks.N.attn.to_q", "transformer.transformer_blocks.N.img_mlp.gate_layer"], { transformer_blocks: range(32) }, { transformer_blocks: 4096 }),
            qwen21Bare: hdr(["transformer_blocks.N.attn.to_k", "transformer_blocks.N.attn.to_out.N"], { transformer_blocks: range(32) }, { transformer_blocks: 4096 }),
            addAttnLow: hdr(["transformer.transformer_blocks.N.attn.add_k_proj"], { transformer_blocks: [10, 18] }, { transformer_blocks: 3072 }),
            addAttnHigh: hdr(["transformer.transformer_blocks.N.attn.add_k_proj"], { transformer_blocks: [10, 40] }, { transformer_blocks: 3072 }),
            moss: hdr(["layers.N.proj.q", "layers.N.proj.o"], { layers: range(42) }, { layers: 3072 }, {}, {}),
            zimage: hdr(["diffusion_model.layers.N.attention.to_k", "diffusion_model.layers.N.feed_forward.w1"], { layers: range(30) }, { layers: 3840 }),
            ideogram: hdr(["diffusion_model.layers.N.attention.qkv", "diffusion_model.layers.N.adaln_modulation"], { layers: range(34) }, { layers: 4608 }),
            layersNoWidth: hdr(["diffusion_model.layers.N.attention.qkv"], { layers: range(20) }),
            sdxl: hdr(["lora_te1_text_model_encoder_layers_N_mlp_fc1", "lora_unet_input_blocks_N_N_transformer_blocks_N_attn1_to_k"], { transformer_blocks: range(10) }, {}, {}, { ss_base_model_version: "sdxl_base_v1-0" }),
            sd15: hdr(["lora_te_text_model_encoder_layers_N_mlp_fc1", "lora_unet_down_blocks_N_attentions_N_proj_in"]),
            wan: hdr(["lora_unet_blocks_N_self_attn_q"], {}, {}, {}, { ss_base_model_version: "wan" }),
        };
        const want = {
            flux1: ["looks like FLUX.1", "flux1", "keys"], flux1Diffusers: ["looks like FLUX.1", "flux1", "keys"],
            klein9b: ["looks like FLUX.2 Klein 9B", "flux2_klein_9b", "keys"], klein4b: ["looks like FLUX.2 Klein 4B", "flux2_klein_4b", "keys"],
            dev: ["looks like FLUX.2 dev", "flux2_dev", "keys"], fewBlocks: ["looks like FLUX.1 or FLUX.2 Klein 4B", null, "keys"],
            flux3: ["looks like FLUX 3", "flux3", "keys"], qwen2509: ["looks like Qwen Image (Edit 2509 / 2511)", "qwen_image", "keys"],
            qwen21: ["looks like Qwen Image 2.1", "qwen_image_2_1", "keys"], qwen21Bare: ["looks like Qwen Image 2.1", "qwen_image_2_1", "keys"],
            addAttnLow: ["looks like FLUX.1 or Qwen Image (Edit 2509 / 2511)", null, "keys"], addAttnHigh: ["looks like Qwen Image (Edit 2509 / 2511)", "qwen_image", "keys"],
            moss: ["looks like MOSS-Image", "moss_image", "keys"], zimage: ["looks like Z-Image", "z_image", "keys"], ideogram: ["looks like Ideogram 4", "ideogram4", "keys"],
            layersNoWidth: ["looks like Z-Image or Ideogram 4", null, "keys"],
            sdxl: ["looks like SDXL", "sdxl", "keys"], sd15: ["looks like SD 1.5", "sd15", "keys"], wan: ["metadata says wan", null, "metadata"],
        };
        const got = Object.fromEntries(Object.keys(want).map((k) => [k, fam(H[k], "x")]));
        const wrong = Object.keys(want).filter((k) => !eq(got[k], want[k]));
        check("familyOf by the module paths: each family, FLUX.1 against FLUX.2 by width, blocks and MLP multiples, the Qwen 2.1 / 2509 split", !wrong.length, short(wrong.map((k) => `${k}: ${JSON.stringify(got[k])}`)));
        check("... a FLUX.1 LoRA on four single blocks (60Y911's shape) names both families it fits as candidates", eq(L.familyOf(H.fewBlocks).candidates, ["flux1", "flux2_klein_4b"]) && L.familyOf(H.fewBlocks).sure === false && L.familyOf(H.flux1).sure === true);
        check("keys over metadata: anna_qwen's sd_1.5 loses, FLUX.1's diffusers file with sd_1.5 too", got.qwen2509[1] === "qwen_image" && got.flux1Diffusers[1] === "flux1");
        check("metadata over the folder: a header without modules, the value mapped or as it is",
            eq(fam({ metadata: { ss_base_model_version: "flux2_klein_9b" } }, "klein"), ["metadata says FLUX.2 Klein 9B", "flux2_klein_9b", "metadata"])
            && eq(fam({ metadata: { "modelspec.architecture": "stable-diffusion-xl-v1-base/lora" } }), ["metadata says SDXL", "sdxl", "metadata"])
            && eq(fam({ metadata: { ss_base_model_version: "SD3" } }), ["metadata says SD3", null, "metadata"]));
        check("the folder last, nothing without one", eq(fam(null, "klein"), ["in folder klein", null, "folder"]) && eq(fam({ metadata: {} }, "qwen"), ["in folder qwen", null, "folder"]) && L.familyOf(null, "") === null && L.familyOf(null) === null && L.familyOf(hdr([]), null) === null);
        // a remote server: no header is read (loraheader.headerFor, tools/loraheader_test.js), the server's /view_metadata answer and the folder are all
        const remote = L.familyOf({ metadata: L.loraMeta({ ss_base_model_version: "sd_1.5", ss_tag_frequency: JSON.stringify({ d: { Anna: 1 } }) }) }, "qwen");
        check("a remote server's anna_qwen: its metadata alone (SD 1.5), never amber under Qwen Image 2.1", remote.label === "metadata says SD 1.5" && L.loraHint(remote, "qwen_image_2_1").kind === "hint" && eq(L.loraTriggers({ metadata: L.loraMeta({ ss_tag_frequency: JSON.stringify({ d: { Anna: 1 } }) }) }), ["Anna"]));

        // the recipe's side: every shipped graph
        const RF = {
            "flux2_klein_local/prompt": "flux2_klein", "flux3_klein_local/prompt": "flux3", "moss_image_local/prompt": "moss_image",
            "qwen_image_edit_2_1_local/prompt": "qwen_image_2_1", "qwen_image_edit_2_1_turbo_local/prompt": "qwen_image_2_1", "relight_qwen_local/prompt": "qwen_image",
            "realism_pass/prompt": null, "rtx_vsr_local/prompt": null, "upscale_model_local/prompt": null,
            "cloud_anima_base/comfycloud": null, "cloud_anima_preview/comfycloud": null, "cloud_boogu_image_edit/comfycloud": null,
            "cloud_flux2_dev/comfycloud": "flux2_dev", "cloud_flux2_klein_9b/comfycloud": "flux2_klein_9b", "cloud_flux2_klein_9b/comfycloud.text": "flux2_klein_9b",
            "cloud_flux2_klein_9b_multi/comfycloud": "flux2_klein_9b", "cloud_ideogram_4/comfycloud": null, "cloud_krea_2_turbo/comfycloud": null,
            "cloud_mage_flow/comfycloud": null, "cloud_mage_flow_edit_turbo/comfycloud": null,
            "cloud_qwen_image_2_1_edit/comfycloud": "qwen_image_2_1", "cloud_qwen_image_2_1_edit/comfycloud.text": "qwen_image_2_1",
            "cloud_qwen_image_edit_2509/comfycloud": "qwen_image", "cloud_z_image_turbo/comfycloud": "z_image", "relight/comfycloud": "qwen_image",
        };
        const rf = {};
        for (const r of listed) for (const [route, g, rr] of graphsOf(r, true)) rf[`${r.id}/${route}`] = L.recipeFamily(route === "prompt" ? r : { loras: rr.loras, options: { graph: g } });
        const rfWrong = Object.keys({ ...RF, ...rf }).filter((k) => !(k in RF) || rf[k] !== RF[k]);
        check("recipeFamily over every shipped graph: the declaration, else the text encoder's type (Qwen 2.1 by its cache, FLUX.2 by its model file)", !rfWrong.length, short(rfWrong.map((k) => `${k}: ${rf[k]}`)));
        check("recipeFamily: false and an empty recipe say nothing", L.recipeFamily({ loras: false, prompt: byId("flux3_klein_local").prompt }) === null && L.recipeFamily(null) === null && L.recipeFamily({}) === null);
        check("... DualCLIPLoader's flux is FLUX.1, a checkpoint graph says nothing",
            L.recipeFamily({ prompt: { c: { class_type: "DualCLIPLoader", inputs: { type: "flux" } } } }) === "flux1" && L.recipeFamily({ prompt: { c: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "x.safetensors" } } } }) === null);

        // what fits what, and the line
        const fits = (a, b) => L.familyFits(a, b);
        check("familyFits: the same, or one a size or kind of the other; unknown on either side fits",
            fits("flux2_klein_9b", "flux2_klein") && fits("flux2_klein", "flux2_klein_9b") && fits("flux2_klein_4b", "flux2") && fits("flux3", "flux3") && fits(null, "flux3") && fits("flux1", null) && fits("anima", "anima")
            && !fits("flux2_dev", "flux2_klein") && !fits("flux1", "flux2") && !fits("flux1", "flux2_klein") && !fits("qwen_image", "qwen_image_2_1") && !fits("flux2_klein_4b", "flux2_klein_9b") && !fits("anima", "flux3"));
        const hint = (k, rfam) => L.loraHint(L.familyOf(H[k], "x"), rfam);
        const amber = hint("qwen2509", "qwen_image_2_1");
        check("the amber line: a 2509 LoRA under Qwen Image 2.1, the plan's sentence",
            amber.kind === "mismatch" && amber.text === "This LoRA looks made for Qwen Image (Edit 2509 / 2511); this recipe runs Qwen Image 2.1. ComfyUI loads it without an error and the picture may come back unchanged.", amber.text);
        check("... a FLUX.1 LoRA under FLUX.2 Klein (flux2_klein_local) and a FLUX.2 dev one: amber; a Klein 9B one: grey",
            hint("flux1", "flux2_klein").kind === "mismatch" && /looks made for FLUX\.1; this recipe runs FLUX\.2 Klein\./.test(hint("flux1", "flux2_klein").text) && hint("dev", "flux2_klein").kind === "mismatch"
            && eq(hint("klein9b", "flux2_klein"), { kind: "hint", text: "looks like FLUX.2 Klein 9B" }) && hint("klein4b", "flux2_klein").kind === "hint");
        check("... two candidates: amber only when neither fits (FLUX.1 or Klein 4B: grey under FLUX.2 Klein, amber under FLUX 3 and Klein 9B)",
            hint("fewBlocks", "flux2_klein").kind === "hint" && hint("fewBlocks", "flux3").kind === "mismatch" && hint("fewBlocks", "flux2_klein_9b").kind === "mismatch" && hint("fewBlocks", "flux1").kind === "hint");
        check("... a metadata or folder hint is never amber, a recipe without a family never",
            L.loraHint(L.familyOf({ metadata: { ss_base_model_version: "sdxl" } }), "flux3").kind === "hint" && L.loraHint(L.familyOf(null, "qwen"), "flux3").kind === "hint" && hint("qwen2509", null).kind === "hint" && L.loraHint(null, "flux3") === null);
        check("familyLabel: the table's, an unknown id as it is", L.familyLabel("flux2_klein") === "FLUX.2 Klein" && L.familyLabel("anima") === "anima" && L.familyLabel(null) === "");

        // the trigger words, the prompt, the picker's family group
        check("loraTriggers: the trigger phrase's words first, then the tags, once (any case), shorter than 40, five at most",
            eq(L.loraTriggers({ metadata: { "modelspec.trigger_phrase": "trig0r, Glowing,  ", tags: ["glowing", "red coat", "x".repeat(40), "a", "b", "c"] } }), ["trig0r", "Glowing", "red coat", "a", "b"])
            && eq(L.loraTriggers(H.flux3), ["Targa"]) && eq(L.loraTriggers(null), []) && eq(L.loraTriggers({ metadata: { tags: "Targa" } }), []));
        check("appendWord: \", <word>\" after the prompt's text, the word alone into an empty prompt",
            L.appendWord("a red mug", "Targa") === "a red mug, Targa" && L.appendWord("a red mug,  ", "Targa") === "a red mug, Targa" && L.appendWord("", "Targa") === "Targa" && L.appendWord(null, " Targa ") === "Targa" && L.appendWord("keep", "") === "keep");
        const groups = L.groupByFolder(["Flux_3\\Flux3_Targa.safetensors", "flux\\a.safetensors", "flux\\b.safetensors", "klein\\k.safetensors", "kontext\\lucma_klein.safetensors", "qwen\\anna_qwen.safetensors", "root.safetensors"]);
        const split = (rfam, hintOf) => { const s = L.familyGroups(groups, rfam, hintOf); return [s.first.map((g) => g.folder), s.rest.map((g) => g.folder)]; };
        check("familyGroups: the folders named for the recipe's family first, the rest behind Show all",
            eq(split("flux3"), [["Flux_3"], ["flux", "klein", "kontext", "qwen", ""]]) && eq(split("flux1"), [["flux", "kontext"], ["Flux_3", "klein", "qwen", ""]]), short([split("flux3"), split("flux1")]));
        const known = (n) => (n === "kontext\\lucma_klein.safetensors" ? L.familyOf(H.klein9b) : n === "flux\\a.safetensors" ? L.familyOf(H.flux1) : null);
        check("... a folder whose file's hint fits joins the family group (a Klein LoRA in kontext/); a metadata hint does not",
            eq(split("flux2_klein", known), [["klein", "kontext"], ["flux", "Flux_3", "qwen", ""]]) && eq(split("flux2_klein", (n) => (n === "flux\\a.safetensors" ? L.familyOf({ metadata: { ss_base_model_version: "flux2_klein_9b" } }) : null)), [["klein"], ["flux", "Flux_3", "kontext", "qwen", ""]]));
        check("... no family, or none of the folders fits: every group first (Qwen 2.1's recipe and a qwen/ folder of 2509 LoRAs)",
            eq(split(null), [groups.map((g) => g.folder), []]) && eq(split("qwen_image_2_1"), [groups.map((g) => g.folder), []]) && eq(split("z_image"), [groups.map((g) => g.folder), []]));
    });

    await section("8. loraStem and loraWords (LR1: the status note, the via line, the log)", () => {
        check("loraStem takes the folders (either separator) and the extension off",
            L.loraStem("Flux_3\\Flux3_Targa.safetensors") === "Flux3_Targa" && L.loraStem("klein/sub/nyc_style.safetensors") === "nyc_style" && L.loraStem("root.ckpt") === "root" && L.loraStem("no_ext") === "no_ext" && L.loraStem(null) === "");
        const words = L.loraWords([{ name: "Flux_3\\Flux3_Targa.safetensors", strength: 0.8 }, { name: "klein/nyc_style.safetensors", strength: 1 }, { name: "x.safetensors", strength: 0.855 }, { name: "y.safetensors", strength: -2 }]);
        check("loraWords: the stems with their strengths, one decimal at least, two at most", words === "Flux3_Targa 0.8, nyc_style 1.0, x 0.86, y -2.0", words);
        check("loraWords of none, of no list: \"\"", L.loraWords([]) === "" && L.loraWords(null) === "");
    });

    await section("9. the LoRAs section's helpers (LR2: the picker's groups and search, the strength's range)", () => {
        const names = ["Flux_3\\Flux3_Targa.safetensors", "klein\\nyc_style.safetensors", "Klein/sub_b.safetensors", "qwen\\NYC_Qwen.safetensors",
            "root_style.safetensors", "a\\b\\deep.safetensors", "flux\\x10.safetensors", "flux\\x9.safetensors", "", 7, null];
        check("loraFolder: the part before the last separator, the server's own spelling; \"\" at the root",
            L.loraFolder("klein\\nyc_style.safetensors") === "klein" && L.loraFolder("a\\b\\deep.safetensors") === "a\\b" && L.loraFolder("x/y.safetensors") === "x" && L.loraFolder("root.safetensors") === "" && L.loraFolder(null) === "");
        const groups = L.groupByFolder(names);
        const shape = groups.map((g) => [g.folder, g.names.length]);
        check("groupByFolder: the folders by name (any case, \\ and / one folder, spelled as the first name spells it), the root last, junk left out",
            eq(shape, [["a\\b", 1], ["flux", 2], ["Flux_3", 1], ["klein", 2], ["qwen", 1], ["", 1]]), short(shape));
        check("... each group keeps the list's own order", eq(groups.find((g) => g.folder === "flux").names, ["flux\\x10.safetensors", "flux\\x9.safetensors"]) && eq(groups.find((g) => g.folder === "klein").names, ["klein\\nyc_style.safetensors", "Klein/sub_b.safetensors"]));
        check("groupByFolder of nothing: []", eq(L.groupByFolder([]), []) && eq(L.groupByFolder(null), []));
        const f = (q) => L.filterNames(names, q);
        check("filterNames: a substring in any case, over the folder too", eq(f("nyc"), ["klein\\nyc_style.safetensors", "qwen\\NYC_Qwen.safetensors"]) && eq(f("TARGA"), ["Flux_3\\Flux3_Targa.safetensors"]) && eq(f("qwen\\"), ["qwen\\NYC_Qwen.safetensors"]), short(f("nyc")));
        check("... \"/\" and \"\\\" alike, every word of the query", eq(f("klein/nyc"), ["klein\\nyc_style.safetensors"]) && eq(f("klein\\sub"), ["Klein/sub_b.safetensors"]) && eq(f("nyc qwen"), ["qwen\\NYC_Qwen.safetensors"]) && eq(f("nyc zz"), []));
        check("... an empty query keeps every name (junk left out), in order", eq(f(""), names.slice(0, 8)) && eq(f("   "), names.slice(0, 8)) && eq(L.filterNames(null, "x"), []));
        const spec = (min, max) => ({ LoraLoaderModelOnly: { input: { required: { strength_model: ["FLOAT", { default: 1, min, max, step: 0.01 }] } } } });
        check("strengthRange: the node list's own, else ComfyUI's -100 .. 100", eq(L.strengthRange(spec(-10, 5)), { min: -10, max: 5 }) && eq(L.strengthRange(null), { min: -100, max: 100 }) && eq(L.strengthRange({ LoraLoaderModelOnly: { input: { required: {} } } }), { min: -100, max: 100 }) && eq(L.strengthRange(spec(3, -3)), { min: -100, max: 100 }));
        const c = (v, info) => L.clampStrength(v, info);
        check("clampStrength: typed text to a number in the range, 1/1000 at most; no number is null",
            c("0.85") === 0.85 && c("1,5") === 1.5 && c(" -3.5 ") === -3.5 && c("250") === 100 && c(-250) === -100 && c("9", spec(-10, 5)) === 5 && c("0.12345") === 0.123
            && c("") === null && c("abc") === null && c(null) === null && c(true) === null && c(NaN) === null && c(Infinity) === null, String([c("250"), c("9", spec(-10, 5)), c("0.12345")]));
    });

    if (USERDATA) fs.rmSync(USERDATA, { recursive: true, force: true });
    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + ((err && err.stack) || err)); console.log("FAIL"); process.exit(1); });
