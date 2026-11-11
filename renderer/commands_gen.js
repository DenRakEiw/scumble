// @ts-check
// the generation settings commands: moved out of commands.js (item 56 S12, docs/PLAN_SPLIT.md), text unchanged.

import * as loraPanel from "./editor/lora_panel.js";
import { host } from "./editor/host.js";
import { MAX_LORAS } from "./editor/loras.js";
import { CROP_FILLS, CROP_KEYS, EXTEND_FILLS, P, agentRefs, clampInt, cropValue, cropView, lorasFromCall, presetSummary, refsReport, settingRow, until } from "./commands_util.js";

/** @typedef {import("./commands.js").Command} Command */

/** @satisfies {Record<string, Command>} */
export const GenCommandsPart = {
    // -- prompt and generation --
    set_prompt: {
        description: "Set the prompt (and the negative prompt, used by local chains). @img1, @img2 ... name the shown reference layers, top of the reference list first (list_layers / status give each its label); an API run sends each as the name its model knows the picture by. Pass refs {\"img1\": \"<layer id>\"} to say which layer your tokens mean: they are rewritten to that layer's label now, whatever the order is.",
        params: { text: P.str("the prompt"), negative: P.str("the negative prompt"), refs: P.obj("which layer each @img token of text and negative means: {\"img1\": \"<layer id>\", ...}") },
        async run(ed, a) {
            if (a.text != null) ed.setPromptText(agentRefs(ed, String(a.text), a.refs));
            if (a.negative != null) ed.setNegativeText(agentRefs(ed, String(a.negative), a.refs));
            ed.notifyChanged();
            return { prompt: ed.promptText, negative: ed.negativeText, ...refsReport(ed) };
        },
    },
    set_generation: {
        description: `Generation settings: mode api / local / cloud (the recipe decides what is available; select_recipe switches between the modes' recipes), seed, random seed, denoise, refine, the document's Boxes switch (boxes), and the selected recipe's LoRA rows (loras). loras replaces the rows of the LoRAs section of the selected recipe, which are kept per recipe for every document (not for this document alone): up to ${MAX_LORAS} [{ name, strength, on }], loaded in their order between the recipe's model loader and what reads the model, a switched-off row not sent; name a file of the server's list (list_loras; a name that differs only in / against \\ is taken in the server's spelling; on a Comfy Cloud recipe a file of Comfy Cloud's lists, your imports and its catalog, and a name they lack is kept as given); strength 1.0 when left out (the LoRA as trained); [] clears them (also the rows a recipe that takes none now still keeps from before). Refused with nothing changed: a recipe that takes no LoRA rows (an API provider, an upscaler, a graph without one model loader: list_recipes loras_reason), more than ${MAX_LORAS} rows, a name the server's list lacks (read again first; while the list is unread a name is kept as given). The answer's loras: the recipe's rows as stored; status loras says what a run would send.`,
        params: {
            mode: P.str("api, local or cloud (Comfy Cloud recipes)", { enum: ["api", "local", "cloud"] }), seed: P.int("a fixed seed (turns random off)"), seed_random: P.bool("a new seed per run"), denoise: P.num("0.05..1"), refine: P.bool("refine pass"), boxes: P.bool("the Boxes switch under the prompt: on, a run of a recipe that takes boxes (FLUX 3 Image, Ideogram 4, FLUX 3 Image Klein on your ComfyUI) sends the document's boxes, or the selection as one box when there are none; off, none goes and the boxes stay"),
            loras: P.arr(`the selected recipe's LoRA rows, replaced whole (at most ${MAX_LORAS}; [] clears): name (a file of list_loras), strength (default 1.0), on (default true)`, { items: { type: "object", properties: { name: { type: "string", description: "the LoRA file as the server lists it (list_loras), e.g. klein\\style.safetensors" }, strength: { type: "number", description: "1.0 is the LoRA as trained; -2..2 is the usual range" }, on: { type: "boolean", description: "false: kept in the row, not sent" } } } }),
        },
        async run(ed, a) {
            // the LoRA rows first: a refused call changes nothing (the check may read the server's list again)
            const r = host.recipe;
            const loraRows = a.loras != null ? await lorasFromCall(r, a.loras) : null;
            const g = ed.genSettings;
            if (a.mode != null) { if (!["api", "local", "cloud"].includes(a.mode)) throw new Error("mode must be api, local or cloud"); g.mode = a.mode; }
            if (a.seed != null) { g.seed = Math.max(0, Math.floor(+a.seed) || 0); g.seedRandom = false; }
            if (a.seed_random != null) g.seedRandom = !!a.seed_random;
            if (a.denoise != null) g.denoise = Math.min(1, Math.max(0.05, +a.denoise || 1));
            if (a.refine != null) g.refine = !!a.refine;
            if (a.boxes != null) g.boxes = !!a.boxes;
            if (ed.syncGenControls) ed.syncGenControls();
            ed.renderInfo(); ed.notifyChanged();
            // the Boxes overlay draws the boxes dashed while the switch is off
            if (a.boxes != null) ed.draw();
            // the rows are the recipe's, not the document's (no notifyChanged for them): every tab's LoRAs section follows
            if (loraRows) {
                await host.saveLoras(r.id, loraRows);
                try { loraPanel.renderAll(host); } catch (err) { console.warn("loras section", err); }
            }
            return { mode: g.mode, seed: g.seed, seed_random: !!g.seedRandom, denoise: g.denoise, refine: !!g.refine, boxes: !!g.boxes, loras: r ? host.loraRows(r) : [] };
        },
    },
    set_crop: {
        description: "The Generate tab's Crop section for this document (what a run sends and how its result is pasted back). context: auto sizes the surroundings from the selection (at least 512 px), manual takes set_node_params padding (pixels, the same for every tab); feather: auto grows and feathers the mask edge from the selection's size, manual blurs it by set_node_params feather. fill: how the selected area looks in the picture the model gets (green: for edit models told to fill the green area). colorMatch: the result's colours matched to the surroundings. withOriginal: with a fill, the crop before the fill goes along as one more picture. align: the result is moved onto the crop before it is pasted. paste: selection (soft edge along the selection) or crop (the whole returned rectangle). extendFill: what extend_canvas fills the new border with. Only the keys given change; the answer is every key and the pixels manual uses.",
        params: {
            context: P.str("auto or manual (manual: set_node_params padding)", { enum: ["auto", "manual"] }),
            feather: P.str("auto or manual (manual: set_node_params feather)", { enum: ["auto", "manual"] }),
            fill: P.str("how the selected area is filled in the picture the model gets", { enum: CROP_FILLS }),
            colorMatch: P.bool("match the result's colours to the surroundings"),
            extendFill: P.str("what extend_canvas fills the new border with", { enum: EXTEND_FILLS }),
            withOriginal: P.bool("with a fill: send the crop before the fill as one more picture"),
            align: P.bool("move the result onto the crop before pasting it"),
            paste: P.str("selection or crop (the whole returned rectangle)", { enum: ["selection", "crop"] }),
        },
        async run(ed, a) {
            // every value is checked before any is stored: a refused call changes nothing
            const next = {};
            for (const [k, v] of Object.entries(a || {})) {
                if (k === "doc" || v === undefined) continue;
                if (!CROP_KEYS.includes(k)) throw new Error(`unknown crop setting "${k}" (${CROP_KEYS.join(", ")})`);
                next[k] = cropValue(k, v);
            }
            Object.assign(ed.cropSettings, next);
            if (ed.syncCropControls) ed.syncCropControls();
            ed.renderInfo(); ed.draw(); ed.notifyChanged();
            return { ...cropView(ed), changed: Object.keys(next), pixels: { padding: host.nodeParams.padding, feather: host.nodeParams.feather } };
        },
    },
    set_node_params: {
        destructive: true,
        scope: "app", description: "The Inpaint Canvas node parameters every run uses: padding, target_size, feather, multiple_of.",
        params: { padding: P.int("context pixels around the selection"), target_size: P.int("long side of the crop sent to the model, 0 = own size"), feather: P.int("stitch feather in pixels"), multiple_of: P.int("crop size rounding (64 for Flux / SDXL)") },
        async run(_, a) {
            for (const k of ["padding", "target_size", "feather", "multiple_of"]) if (a[k] != null) host.setNodeParam(k, Math.max(0, Math.round(+a[k] || 0)));
            return { ...host.nodeParams };
        },
    },
    set_settings: {
        description: "Values for the recipe's Settings panel (the editable inputs of the workflow, or the provider parameters): {index or label: value}.",
        params: { values: P.obj("object of setting index (or label) -> value", { required: true }) },
        async run(ed, a) {
            const targets = host.settingTargets(ed);
            const out = {};
            for (const [k, v] of Object.entries(a.values || {})) {
                const t = targets.find((x) => String(x.index) === String(k) || (x.node.title || "").toLowerCase() === String(k).toLowerCase() || x.inputName === k);
                if (!t) throw new Error(`no setting "${k}" (${targets.map((x) => `${x.index}: ${x.node.title}`).join(", ") || "none"})`);
                ed.settings[String(t.index)] = { ...(ed.settings[String(t.index)] || {}), value: v };
                out[t.index] = v;
            }
            if (ed.settingsChanged) ed.settingsChanged();
            ed.notifyChanged();
            return { set: out, settings: targets.map((t) => ({ index: t.index, label: t.node.title, input: t.inputName, value: (ed.settings[String(t.index)] || {}).value })) };
        },
    },
    // docs/PLAN_0_1_42.md F2b: the Settings section as data, and its Preset row
    list_settings: {
        readOnly: true,
        description: "The selected recipe's Settings section for this document, as data: per row its index, label, input, kind (number, combo, boolean or string), for a number integer / min / max / step / default, for a combo its options (model files, LoRAs, samplers; at most max_options of them, options_total says how many there are), the value the document holds and valid (false: a combo value the list does not offer, a number out of range). presets: the Preset row's presets in its order (shipped with the recipe first, then the ones the user saved), each with its values by row and missing (files the server lacks); preset: the one the rows hold now. set_settings changes a row, apply_preset applies a preset. Combo options come from the connected ComfyUI (or the recipe file without one).",
        params: { filter: P.str("only the rows whose label or input contains this (any case)"), max_options: P.int("the most options listed per combo row (0: none)", { default: 200 }) },
        async run(ed, a) {
            const r = host.recipe;
            const targets = host.settingTargets(ed);
            const max = a.max_options == null || a.max_options === "" ? 200 : clampInt(a.max_options, 0, 100000, 200);
            const f = a.filter != null && String(a.filter).trim() ? String(a.filter).trim().toLowerCase() : null;
            const rows = targets.filter((t) => !f || String(t.node.title || "").toLowerCase().includes(f) || String(t.inputName).toLowerCase().includes(f)).map((t) => settingRow(ed, t, max));
            const row = host.presetRow(ed, targets);
            return {
                recipe: r ? r.id : null, provider: r && r.kind === "provider" ? r.provider : null, settings: rows,
                presets: row ? row.presets.map((p) => presetSummary(ed, targets, row, p)) : [], preset: row && row.matching ? row.matching.name : null,
            };
        },
    },
    apply_preset: {
        description: "Apply a preset of the Settings section's Preset row to this document's rows, as picking it there does: one the recipe ships (the Realism Pass's L and M) or one the user saved (list_settings lists them with their values). Refused with nothing changed when the recipe has no presets, the name is none of them, it names no row of the recipe, or the server lacks a file it names. Saving and deleting presets stay in the app.",
        params: { name: P.str("the preset's name (list_settings: presets)", { required: true }) },
        async run(ed, a) {
            const r = host.recipe;
            if (!r) throw new Error("no recipe selected");
            const rn = r.name || r.id;
            if (r.kind === "provider") throw new Error(`${rn} is an API recipe: its Settings have no presets (set_settings sets a row)`);
            const targets = host.settingTargets(ed);
            const row = host.presetRow(ed, targets);
            if (!row || !row.presets.length) throw new Error(`${rn} has no presets${row ? ": the user saves one in its Preset row" : ""}`);
            const name = String(a.name == null ? "" : a.name).trim();
            const ci = row.presets.filter((x) => x.name.toLowerCase() === name.toLowerCase());
            const p = row.presets.find((x) => x.name === name) || (ci.length === 1 ? ci[0] : null);
            if (!p) throw new Error(`no preset "${name}" for ${rn} (${row.presets.map((x) => x.name).join(", ")})`);
            const s = presetSummary(ed, targets, row, p);
            if (!s.values.some((v) => v.index != null)) throw new Error(`preset "${p.name}" names no Settings row of ${rn}: nothing changed`);
            if (s.missing.length) throw new Error(`the server lacks ${s.missing.join(", ")}, which preset "${p.name}" names: nothing changed`);
            const res = host.applyPreset(ed, targets, p);
            return { applied: p.name, shipped: !!p.shipped, rows: res ? res.rows : s.values.length, status: ed.status, settings: targets.map((t) => ({ index: t.index, label: t.node.title, input: t.inputName, value: (ed.settings[String(t.index)] || {}).value })) };
        },
    },
    upsample_prompt: {
        needsImage: true, description: "Let the language model the editor is set to rewrite the prompt with the image in view (a ComfyUI language model node, an API key for ToAPIs / OpenAI / Google / Anthropic / OpenRouter, or a local OpenAI-compatible server). @img tokens are kept: every one must name a shown reference, and `check` lists what the rewrite dropped, added or named by number instead.",
        params: { timeout: P.timeout(300) },
        async run(ed, a) {
            if (ed.upsamplePending) throw new Error("an upsampling is still running");
            const before = ed.promptText;
            await ed.upsamplePrompt();   // an API model answers before this resolves, a ComfyUI helper prompt keeps upsamplePending
            if (!ed.upsamplePending && ed.promptText === before) throw new Error(ed.status);
            const ok = await until(() => !ed.upsamplePending, clampInt(a.timeout, 5, 3600, 300) * 1000);
            if (!ok) throw new Error("upsampling timed out: " + ed.status);
            if (/failed/i.test(ed.status)) throw new Error(ed.status);
            // `previous`: Revert's text, which follows the references like the prompt when they changed meanwhile
            return { prompt: ed.promptText, previous: ed.promptBackup != null ? ed.promptBackup : before, status: ed.status, check: ed.upsampleCheck || undefined };
        },
    },
};
