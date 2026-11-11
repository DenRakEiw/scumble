// @ts-check
// the run commands (generate_new, upscale, realism_pass, key_screen, split_layers, relight, generate, cancel_run): moved out of commands.js (item 56 S12, docs/PLAN_SPLIT.md), text unchanged.

import * as keying from "./editor/keying.js";
import { api, host } from "./editor/host.js";
import { RELIGHT_LIGHT_TYPES, RELIGHT_STYLES } from "./editor/inpaint_canvas.js";
import { LIGHT_PRESETS, RELIGHT_ROUTES, applyLightPreset, defaultLight, normalizeLights } from "./editor/inpaint_relight.js";
import { LABEL as REALISM_LABEL } from "./editor/realism.js";
import { lacksNodesText } from "./editor/comfyprompt.js";
import { refusal } from "./editor/inpaint_status.js";
import { AREA_CAP } from "./editor/eacharea.js";
import { SPLIT_COUNT_DEFAULT, SPLIT_TIERS } from "./editor/splitlayers.js";
import { P, RELIGHT_FROM_LIGHTS, RELIGHT_MODEL, agentRefs, aspectText, bounds, checkParams, clampInt, filterStepLabel, findLayer, generateEachArea, groupSummary, layerSummary, rectMask, relightModel, sizeForAspect, targetSize, touch, until, wait, writeParams, writeRelightModel, writeTarget } from "./commands_util.js";

/** @typedef {import("./commands.js").Command} Command */

let COMMANDS = null;

/** @satisfies {Record<string, Command>} */
export const RunCommandsPart = {
    generate_new: {
        destructive: true,
        description: "Make this tab's base image from the prompt, no image needed. A local recipe renders onto a fresh canvas and is flattened into the base; an API recipe calls the model's text-to-image route. Replaces the image, the history and every layer but the reference layers, which stay; the shown ones go along where the model takes reference images for a new image (list_recipes: textRefs), each @img token written as the model's name for its picture (\"image 1\"; on a local recipe the white canvas is image 1). In an empty tab add_image_layer role reference makes a white canvas first. Without width, height and aspect it asks for the document's preset while its recipe is the selected one (new_canvas with a recipe, or the last generate_new on this picture: its aspect and size class; status generation.target), else 1024 x 1024; after the run the document keeps what was asked as its preset. With the Boxes switch on, the document's boxes go as fractions of the picture: an aspect of another shape stretches them, and the notes say so. loras_sent: the LoRAs the run loaded, [{ name, strength }] (as generate's).",
        params: {
            prompt: P.str("what to make; the tab's current prompt when left out. An @img token names a shown reference layer; a model that makes new images from the prompt alone refuses it"),
            negative: P.str("negative prompt (local chains only)"),
            refs: P.obj("which layer each @img token of prompt and negative means: {\"img1\": \"<layer id>\", ...} (as set_prompt)"),
            width: P.int("width in pixels", { default: 1024 }),
            height: P.int("height in pixels", { default: 1024 }),
            aspect: P.str("aspect ratio like 16:9; used with resolution instead of width and height"),
            resolution: P.int("long side in pixels when aspect is given", { default: 1024 }),
            seed: P.int("seed; a new random one when left out"),
            background: P.str("transparent asks an API model that supports it (the OpenAI image models, Seedream 5.5 on ModelArk; list_recipes background says which) for a cut-out on a transparent ground; the base image then keeps its alpha channel", { enum: ["auto", "opaque", "transparent"] }),
            timeout: P.timeout(600),
        },
        async run(ed, a) {
            const r = host.recipe;
            if (!r) throw new Error("no recipe selected");
            if (r.task === "pass") throw new Error(`${REALISM_LABEL} works on a picture: over the whole picture with Upscale › ${REALISM_LABEL} (realism_pass), or select an area and Generate (generate).`);
            // before anything changes: the local route's newCanvas below would wipe the document (layers, history, undo)
            // before the generate it runs refuses a busy one; the API route asks the same in runGenerate
            const blocked = host.generateNewBlocked(ed);
            if (blocked) throw new Error(blocked);
            let w = clampInt(a.width, 64, 8192, 1024), h = clampInt(a.height, 64, 8192, 1024);
            // the document's preset (item 34: new_canvas with a recipe, or the last generate_new on it) when no size is
            // given and its recipe is the selected one; else 1024 x 1024 as before
            const auto = a.width == null && a.height == null && !a.aspect ? targetSize(ed, r) : null;
            // "16x9" and "16/9" are taken as 16:9: the run and the document's preset get the one spelling the dialogs read
            let aspect = a.aspect ? aspectText(a.aspect) : null;
            let asked = a.aspect ? clampInt(a.resolution, 64, 8192, 1024) : Math.max(w, h);
            if (aspect) {
                const [aw, ah] = sizeForAspect(aspect, asked);
                w = aw; h = ah;
            } else if (auto) {
                [w, h] = auto.wh;
                aspect = auto.aspect;
                asked = auto.size;
            }
            if (a.prompt != null) ed.setPromptText(agentRefs(ed, String(a.prompt), a.refs));
            if (a.negative != null) ed.setNegativeText(agentRefs(ed, String(a.negative), a.refs));
            if (!String(ed.promptText || "").trim()) throw new Error("write a prompt first");
            if (a.seed != null) { ed.genSettings.seed = Math.abs(Math.round(+a.seed)) >>> 0; ed.genSettings.seedRandom = false; if (ed.seedInput) ed.seedInput.value = ed.genSettings.seed; }
            const t0 = Date.now();
            if (r.kind === "provider") {
                const out = await host.runGenerate(ed, { width: w, height: h, aspect, prompt: ed.promptText, negative: ed.negativeText, seed: ed.genSettings.seed, background: a.background || null });
                writeTarget(ed, r, aspect, asked);
                ed.notifyChanged();
                return { mode: "api", provider: out.provider, model: out.model, width: out.width, height: out.height, seconds: out.seconds, transparent: !!out.transparent, prompt_sent: out.prompt, references: out.references, kept: out.kept, dropped: out.dropped, notes: out.notes || [], info: out.info || null, boxes: out.boxes || 0, loras_sent: Array.isArray(out.loras) ? out.loras : [], status: ed.status };
            }
            if (a.background === "transparent" && r.kind !== "provider") throw new Error("a transparent background is an API model's parameter; this is a local ComfyUI recipe");
            // the run's token check, made before the canvas replaces the picture: the references stay, so this snapshot
            // is the run's, and the run selects the whole canvas (a token past the recipe's slots, a parked one, or one
            // that names nothing refuses here, not after the wipe); an unreachable server too
            const snap = ed.refSnapshot();
            // (the fresh canvas's Original, the blank canvas before the fill, does not go: host.comfyPlan `fresh`)
            const plan = r.task !== "upscale" ? host.comfyPlan(ed, r, snap.refIds.length, { hasSelection: true, crop: ed.cropSettings, gen: ed.genSettings }, { fresh: true }) : null;
            if (host.refTokens && plan) host.refPrompt(ed, snap, "comfy", { recipe: r, comfy: plan });
            if (!host.connected) throw new Error("Not connected to ComfyUI.");
            // the node types the recipe needs (queueGenerate's own check), and its boxes: a recipe that declares them (its
            // `boxes`) sends the document's New, Text and From boxes, measured here on the picture and the reference
            // layers they were drawn on (host.newBoxPlan); a node without box_prompt refuses them here, not after the wipe
            const missing = (r.needs || []).filter((n) => host.objectInfo && !host.objectInfo[n]);
            if (missing.length) throw new Error(lacksNodesText(r, missing));
            // the recipe's LoRA rows (item 50): more than five, or a file the server's list lacks, refuse here, not after
            // the wipe (host.loraPlan only reads, the server's list again at most; queueGenerate asks it again for the run)
            if (r.task !== "upscale") await host.loraPlan(ed, r);
            const boxPlan = plan ? await host.newBoxPlan(ed, r, snap.refIds.slice(0, plan.lay.kept)) : null;
            // local: a flat canvas of the wanted size (the reference layers stay and go along in the crop_image batch, after
            // the white crop: 26e names them), everything selected, the recipe run, then the result flattened into the
            // base; flatten keeps the reference layers. The boxes go as fractions of the picture they were drawn on, scaled
            // to the fresh canvas (host.queueGenerate reads `_newBoxes` once)
            const drawnOn = [ed.width, ed.height];
            await ed.newCanvas(`${w}x${h}`, { keepRefs: true });
            if (ed.width !== w || ed.height !== h) throw new Error(ed.status);
            ed.applyMaskToSelection(rectMask(ed, 0, 0, ed.width, ed.height), "replace");
            ed._newBoxes = { from: drawnOn, aspect, plan: boxPlan };
            let res;
            try { res = await COMMANDS.generate.run(ed, { timeout: a.timeout }); } finally { ed._newBoxes = undefined; }
            await ed.flatten();
            writeTarget(ed, r, aspect, asked);
            ed.notifyChanged();
            return { mode: "local", recipe: r.id, width: ed.width, height: ed.height, seconds: Math.round((Date.now() - t0) / 1000), result: res && res.layer ? res.layer : null, prompt_sent: res ? res.prompt_sent : null, notes: res ? res.notes || [] : [], boxes: res ? res.boxes || 0 : 0, loras_sent: res ? res.loras_sent || [] : [], status: ed.status };
        },
    },
    upscale: {
        needsImage: true, description: "Upscale with the selected upscale recipe (list_recipes: task \"upscale\"; select_recipe picks one). scope \"selection\": the selection's box goes to the upscaler at its own size and the sharper answer comes back into it at the document's resolution, as a result layer. scope \"document\": the base image goes out, the answer becomes the new base N times larger, and every layer, mask and the selection are scaled along (one undo step); on an upscale recipe on the user's ComfyUI the base goes through the recipe's graph and comes back without transparency (refused before anything is sent when the graph reads more than the picture, the picture passes the recipe's limits, or a job is going on the document). Waits for the answer; Topaz can take several minutes.",
        params: {
            scope: P.str("selection (a detail pass) or document (the whole picture larger)", { enum: ["selection", "document"], default: "selection" }),
            factor: P.num("how many times larger; the recipe's default when left out (list_recipes shows each recipe's factors); ignored by a model that picks its own"),
            prompt: P.str("guidance for the added detail, for an upscaler that takes one (list_recipes: usesPrompt true, e.g. Clarity, Magnific Creative); the document's prompt when left out, ignored by the others"),
            timeout: P.timeout(1800),
        },
        async run(ed, a) {
            const r = host.recipe;
            if (!r || r.task !== "upscale") throw new Error(`the selected recipe is no upscaler: select_recipe one with task "upscale" (${host.shell.recipes().filter((x) => x.task === "upscale").map((x) => x.id).join(", ") || "none installed"})`);
            if (ed.providerPending) throw refusal("a run is still going on this document");
            const scope = a.scope === "document" ? "document" : "selection";
            if (r.kind !== "provider") {
                // an upscaler on the user's ComfyUI. The whole picture: the base goes out alone through the recipe's graph
                // and the answer becomes the new base (host.runComfyUpscale, docs/PLAN_0_1_42.md U2); `timeout` is its hard
                // end, the queue's wait included, so the job is taken off the server when it passes
                if (scope === "document") {
                    const deadline = Date.now() + clampInt(a.timeout, 5, 3600, 1800) * 1000;
                    const out = await host.runComfyUpscale(ed, { factor: a.factor, deadline });
                    if (out.width != null) ed.notifyChanged();
                    return {
                        scope, recipe: out.recipe, provider: null, factor: out.factor, from: out.from, width: out.width, height: out.height, answered: out.answered,
                        seconds: Math.round((out.seconds || 0) * 10) / 10, info: null,
                        status: out.width != null ? ed.status : "The document was closed while the upscale ran; nothing was changed.",
                    };
                }
                // the selection: the node's stitch fits the answer back into the box, a Generate with the crop at its
                // native size
                if (!(ed.getBounds && ed.getBounds())) throw refusal("Select an area first: an upscale model on ComfyUI sharpens the selection's box.");
                // a factor (RTX Video Super Resolution) checked here, so a bad one is refused before the run starts
                const factor = host.upscaleFactorFor(r, a.factor);
                // generate() takes no arguments: the factor rides on the editor for host.queueGenerate, read once there
                ed._comfyUpscaleFactor = factor == null ? undefined : factor;
                ed.lastUpscaleFactor = null;
                let g;
                try { g = await COMMANDS.generate.run(ed, { timeout: clampInt(a.timeout, 5, 3600, 1800) }); } finally { ed._comfyUpscaleFactor = undefined; }
                const l = g.layer;
                return { scope, recipe: r.id, provider: null, factor: ed.lastUpscaleFactor ?? factor, box: l ? { x: l.x, y: l.y, w: l.w, h: l.h } : null, layer: l, seconds: g.seconds, info: null, status: ed.status };
            }
            const n0 = ed.history.length;
            const limit = clampInt(a.timeout, 5, 3600, 1800) * 1000;
            let timer = null;
            const out = await Promise.race([
                host.runUpscale(ed, { scope, factor: a.factor, prompt: a.prompt }),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("the upscale timed out: " + ed.status)), limit); }),
            ]).finally(() => clearTimeout(timer));
            ed.notifyChanged();
            if (scope === "document") return { scope, recipe: out.recipe, provider: out.provider, factor: out.factor, from: out.from, width: out.width, height: out.height, seconds: Math.round(out.seconds * 10) / 10, info: out.info, status: ed.status };
            const h = ed.history.length > n0 ? ed.history[ed.history.length - 1] : null;
            const layer = h ? ed.layers.find((l) => l.id === h.layerId) : null;
            return { scope, recipe: out.recipe, provider: out.provider, factor: out.factor, box: { x: out.x, y: out.y, w: out.w, h: out.h }, layer: layer ? layerSummary(ed, layer) : null, seconds: Math.round(out.seconds * 10) / 10, info: out.info, status: ed.status };
        },
    },
    realism_pass: {
        needsImage: true,
        description: `${REALISM_LABEL}: the whole visible picture (every visible layer with its filters and blend modes, without reference and control layers) goes once through DLSS 5 Neural Rendering on the user's own ComfyUI and comes back as a new layer named "${REALISM_LABEL}": full size, under the top run of filter layers (a film look or grain stays live above it and is not sent), no colour match, one undo step. factor 1 (the default) refines at the picture's own size. factor 1.5, 1.7 (DLSS's 1.724x Balanced), 2 or 3 also makes the document that many times larger first (the base and every layer, mask and the selection scaled along, as Resize does) and the pass layer comes at the new size, both in the same undo step; a picture whose output would pass 7680 × 4320 or 27.9 megapixels (answers near 30 megapixels sometimes came back with broken colours) is scaled down before it goes (the notes say so), so the answer and the document come back as large as DLSS allows. A second run reads the earlier pass layer with the rest and stacks its layer above it. Style, Strength and the DLSS model preset are the app's (Upscale › ${REALISM_LABEL}). Needs a ComfyUI on Windows with an RTX 30, 40 or 50 card and the ComfyUI-DLSS5-Enhancer node pack with its runtime; refused with the reason before anything is sent when the server cannot run it, a run is going on the document, at factor 1 the picture is past 7680 × 4320 or 27.9 megapixels, above 1 a job would land in the old geometry, the scaled-down picture would be under 64 px a side or not get larger (status's realism says beforehand whether factor 1 can run). Waits for the answer; \`timeout\` ends the job on the server too. changed: the picture changed while the pass ran (the layer shows it as it was). unchanged: the answer is the picture that went (the pass changed nothing on this card, compared on pieces spread over the picture; from Strength 0.25): the layer still lands and a note says so. from / width / height: the document's size before and after.`,
        params: {
            factor: P.num("1 (the default: refine at the picture's own size), 1.5, 1.7, 2 or 3: above 1 the document becomes that many times larger and the pass layer comes at the new size"),
            timeout: P.timeout(570),
        },
        async run(ed, a) {
            // an epoch time in ms, comfyPictureRun's hard end (the queue's wait included): the job is taken off the
            // server when it passes, so no race is needed here. Without `timeout` the bridge waits its own 600 s, counted
            // from before this call: the default ends the pass 30 s inside it, room for the landing and the cancel, so an
            // agent hears the pass's own sentence and no layer lands after the bridge gave up
            const deadline = Date.now() + clampInt(a.timeout, 5, 3600, 570) * 1000;
            const out = await host.realismWhole(ed, { deadline, factor: a.factor === undefined || a.factor === null ? 1 : a.factor });
            if (out.layer) ed.notifyChanged();
            return {
                layer: out.layer ? layerSummary(ed, out.layer) : null, seconds: Math.round((out.seconds || 0) * 10) / 10,
                notes: out.note ? [out.note] : [], changed: !!out.changed, unchanged: !!out.unchanged,
                factor: out.factor, from: out.from || null, width: out.width == null ? null : out.width, height: out.height == null ? null : out.height,
                // the tab was closed while the pass ran: the job was taken off the server, nothing was added
                status: out.layer ? ed.status : "The document was closed while the pass ran; nothing was added.",
            };
        },
    },
    key_screen: {
        needsImage: true,
        description: "Key green / blue screen with CorridorKey 2.0: one new layer \"Key\" lands directly above the source, its pixels the subject's own colour with the screen's spill taken out, its layer mask the matte (soft hair and motion blur), trimmed to the matte's box. A source layer is hidden in the same step; with the visible picture as the source a mid-grey Fill layer \"Grey\" goes under the key (grey: false leaves the base as it is). One undo step. route: comfyui (the default and the only route of this build) keys on the user's own ComfyUI through the CorridorKey 2.0 node pack ComfyUI-CorridorKey2.0 there (status.key.comfy says whether it is ready and why not: connected, an NVIDIA card of the RTX 30 generation (Ampere) or newer, the pack, Inpaint Canvas; ComfyUI-CorridorKey2 is refused, it downloads its models by itself; the pack's models, about 5.1 GB, are fetched once on that machine, never by Scumble, and a key without them fails naming the files): the box goes at its own size up to settings.key.cap (16 megapixels) and 8,192 px a side, else scaled by one factor and its matte refined against the full-resolution picture; it queues at the front of that ComfyUI's queue, the first key after another job there takes about 10 s more (the pack loads its models), and that job's models load again at its next run; the wait for the server is settings.key.comfyTimeout, the call's own timeout ends it too. route: app keys inside Scumble (not part of this build). The box is the selection's bounds grown by context (the whole picture, or the source layer, without a selection). hint: selection (the selection's coverage as CorridorKey's alpha hint; select_mask gives a binary one), mask (the source layer's own layer mask as a soft hint, 0.95 unless trust says otherwise: give the source a mask with set_mask first), none (the model decides). trust: how much the hint is believed (0.5 rough, 0.75 automatic, 0.95 clean). preview: the matte becomes the selection instead (one selection step), nothing is added. rekey: the active key layer's own mask is the hint (0.95) and its pixels and mask are replaced from what it was keyed from (the hidden source layer, or the picture under the key; one step); after a restart the key starts from the layer's bounds and reads the hidden layer directly below it, else the picture under it. Refused before anything is read or sent when the route cannot key (status.key says why), a run is going on the document, or no picture is loaded.",
        params: {
            route: P.enum("comfyui (your ComfyUI with a CorridorKey 2.0 node pack) or app (in Scumble, not part of this build); the default is in Scumble when its engine is ready, else your ComfyUI (status.key.route)", ["comfyui", "app"]),
            source: P.str("\"picture\" (the default: the visible picture, filters skipped) or a layer whose own pixels are keyed (id, name, a unique part, or \"active\")", { default: "picture" }),
            screen: P.enum("auto (from the box's border), green or blue", keying.SCREENS.slice(), "auto"),
            hint: P.enum("selection (the default), mask (the source layer's own mask) or none", ["selection", "mask", "none"], "selection"),
            trust: P.num("0.5 (rough, the default; 0.95 with hint mask), 0.75 (automatic) or 0.95 (clean)"),
            despill: P.num("0..1, how much of the screen's spill is taken out (default 0.5)"),
            grey: P.bool("with the visible picture as the source: a mid-grey Fill layer under the key (default true)"),
            preview: P.bool("the matte becomes the selection, nothing is added"),
            rekey: P.bool("re-key the active key layer from its own mask"),
            layer: P.layer("rekey: the key layer", { default: "active" }),
            timeout: P.timeout(300),
        },
        async run(ed, a) {
            const v = await host.loadKeyValues();
            const rekey = !!a.rekey;
            let source = "picture", layer = null;
            if (rekey) layer = findLayer(ed, a.layer || "active");
            else if (a.source != null && a.source !== "" && a.source !== "picture") { layer = findLayer(ed, a.source); source = layer.id; }
            const num = (x, d, lo, hi) => (x == null || x === "" || !Number.isFinite(+x) ? d : Math.min(hi, Math.max(lo, +x)));
            const opts = {
                route: a.route === "app" || a.route === "comfyui" ? a.route : "",
                source, layer, rekey, preview: !!a.preview,
                hint: rekey ? "mask" : a.hint === "none" ? "none" : a.hint === "mask" ? "mask" : "selection",
                screen: keying.SCREENS.slice().includes(a.screen) ? a.screen : v.screen,
                trust: keying.trustOf(num(a.trust, a.hint === "mask" ? 0.95 : v.trust, 0, 1)).value,
                despill: num(a.despill, v.despill, 0, 1),
                grey: a.grey == null ? v.greyUnderBase : !!a.grey,
            };
            const ms = clampInt(a.timeout, 5, 3600, 300) * 1000;
            // on your ComfyUI the job is given up a moment before the call's own end (its job taken off the queue)
            if (host.keyRoute(opts.route) === "comfyui") opts.deadline = Date.now() + Math.max(1000, ms - 2000);
            let timer = null;
            const out = await Promise.race([
                host.keyScreen(ed, opts),
                new Promise((_, rej) => { timer = setTimeout(() => { host.cancelRuns(ed); rej(new Error(`${keying.LABEL} timed out after ${ms / 1000} s: ${ed.status}`)); }, ms); }),
            ]).finally(() => clearTimeout(timer));
            if (out.layer) ed.notifyChanged();
            return {
                layer: out.layer ? layerSummary(ed, out.layer) : null, grey: out.grey ? out.grey.id : null, hidden: out.hidden ? out.hidden.id : null,
                seconds: Math.round((out.seconds || 0) * 10) / 10, box: out.box, matte_box: out.matteBox, workingSize: out.workingSize || null, provider: out.provider || null,
                route: out.route || "app", pack: out.pack || null, sent: out.sent || null, scaled: !!out.scaled,
                kept_percent: Math.round((out.kept || 0) * 10) / 10, preview: opts.preview, selection: opts.preview ? bounds(ed) : undefined,
                status: out.layer || opts.preview ? ed.status : "The document was closed while the key ran; nothing was added.",
            };
        },
    },
    split_layers: {
        needsImage: true,
        description: `Split the visible picture, or one layer's own pixels, into layers with Seedream's layer decomposition (a paid API run on the user's key). It runs on the recipe's chosen provider when that one has a layer mode (seedream_5_5: BytePlus ModelArk, WaveSpeedAI or Oxen.ai), else on BytePlus ModelArk (seedream_5_pro always, up to 16 layers); never on a provider without one. list_recipes layers says, per recipe, the provider, the most layers and which options it takes; seedream_5_5 makes up to 99 layers and a base. The answer lands as new layers above every existing layer, in one new group named after the source, bottom to top by the model's stacking order, its base lowest, each named by the model and placed from its box in document pixels; a layer the provider gives no box (WaveSpeedAI and Oxen.ai document none) covers the whole source (unplaced names them). One undo step takes them all back; the layers already in the document are not touched. Output is at most about 2K, so on a larger picture the layers are scaled up to the document and are lower resolution than it (scaled_up, and the status line says so). The picture must be 512 × 512 to 6000 × 6000 in area and no steeper than 16:1, else it is refused before anything is sent. cancel_run stops it like any API run. What it costs is not known to Scumble (Seedream 5.5 is not on BytePlus's public price list; WaveSpeedAI charges for every picture asked for, the count and the base). Answers { group, recipe, provider, model, seconds, size, asked (the count asked for, null where the model takes none), answered ([w, h] of the model's base), scaled_up, left_out (names of the layers that could not land: no usable box, or a failed download), unplaced (names of the layers laid over the whole source), layers ([{ the layer summary, z_index, base, description }], bottom to top), status }.`,
        params: {
            source: P.str("\"picture\" (the default: the visible picture) or a layer whose own pixels are split (id, name, a unique part, or \"active\")", { default: "picture" }),
            recipe: P.str("the recipe that splits: seedream_5_5 or seedream_5_pro. Default: the selected recipe if it can, else seedream_5_5"),
            prompt: P.str("what to separate; left out, the model finds the major elements itself"),
            count: P.int(`seedream_5_5: how many layers at most besides the base, 1..99 (default ${SPLIT_COUNT_DEFAULT}). seedream_5_pro finds its own, up to 16, and takes no count`),
            text_recognition: P.bool("seedream_5_5 on BytePlus ModelArk or Oxen.ai: text recognition on (default off); WaveSpeedAI and seedream_5_pro have no such switch"),
            size: P.enum("the output's size, a tier: auto (about the input's own, within 1K to 2K), 1K, 1.5K or 2K; Oxen.ai takes auto only", SPLIT_TIERS, "auto"),
            timeout: P.timeout(900),
        },
        async run(ed, a) {
            const layer = a.source != null && a.source !== "" && a.source !== "picture" ? findLayer(ed, a.source) : null;
            const ms = clampInt(a.timeout, 5, 3600, 900) * 1000;
            let timer = null;
            const out = await Promise.race([
                // the timeout ends with the answer: a landing can no longer be cancelled, so it must not read as a failure an agent retries and pays for again
                host.splitLayers(ed, { recipe: a.recipe || "", layer, prompt: a.prompt, count: a.count, textRecognition: !!a.text_recognition, size: a.size, timeoutMs: ms, onAnswer: () => clearTimeout(timer) }),
                new Promise((_, rej) => { timer = setTimeout(() => { host.cancelRuns(ed); rej(new Error(`Split into layers timed out after ${ms / 1000} s: ${ed.status}`)); }, ms); }),
            ]).finally(() => clearTimeout(timer));
            if (!out) return { layers: [], group: null, status: "The document was closed while the split ran; nothing was added." };
            return {
                group: groupSummary(ed, out.group), recipe: out.recipe, provider: out.provider, model: out.model, seconds: Math.round((out.seconds || 0) * 10) / 10, size: out.tier, asked: out.asked, answered: out.answered, scaled_up: out.scaledUp, left_out: out.leftOut, unplaced: out.unplaced || [],
                layers: out.layers.map((l) => ({ ...layerSummary(ed, l.layer), z_index: l.z, base: l.base, description: l.description })),
                status: ed.status,
            };
        },
    },
    relight: {
        needsImage: true,
        description: "Relight the picture: edits an existing relight layer or adds a new one. Computes the 16-bit depth map first if missing. With route 'app' (a new layer's route; an edit without route keeps the layer's and renders nothing) acts as a live non-destructive filter layer with up to 4 lights (point, sun, spot) with customizable position, distance, intensity, Kelvin temperature, and diffusion. Generative routes ('magnific', 'fal-iclight', 'fal-bria', 'comfycloud', 'comfyui') re-render lighting through cloud or local diffusion models and land as a pixel layer with detail ratio transfer. Their model values (strength, style, preserve_details, interpolate on magnific; enable_hr_fix on fal-iclight; light_type on fal-bria; lora_strength, steps on comfycloud and comfyui; detail on all) are the Relight panel's for that route: stored on the layer, in the same undo step as the other values, a route that does not read one ignores it; the panel's remembered picks for new layers stay as they are.",
        params: {
            layer: P.layer("relight filter layer to edit (default adds a new one)", { default: null }),
            lights: P.arr("array of up to 4 lights [{id, type, x, y, dist, intensity, color, diffusion, on, ...}]", { items: { type: "object" } }),
            preset: P.str(`one of the Relight panel's light presets, its lights placed on this picture (not together with lights): ${LIGHT_PRESETS.map((p) => `${p.id} (${p.label})`).join(", ")}`, { enum: LIGHT_PRESETS.map((p) => p.id) }),
            original: P.num("original light strength 0..100 % (default 100)"),
            ambient: P.num("ambient light 0..100 % (default 15)"),
            depth_scale: P.num("depth scale 5..200 % (default 50)"),
            shadows: P.num("shadow strength 0..100 % (default 60)"),
            route: P.str("relight route: 'app' (the in-app filter), 'magnific', 'fal-iclight', 'fal-bria', 'comfycloud' or 'comfyui' (a generative route renders now). Omitted: a new layer is 'app', an edited layer keeps its route and nothing renders"),
            prompt: P.str("additional prompt text for generative routes"),
            // the generative routes' model values, as the Relight panel offers them for each route (stored on the layer)
            strength: P.num("magnific: light transfer strength 0..100 % (default 100); a value in (0, 1] is a fraction (0.8 = 80 %)"),
            style: P.enum("magnific: the style", RELIGHT_STYLES),
            preserve_details: P.bool("magnific: preserve details (default true)"),
            interpolate: P.bool("magnific: interpolate from the original (default false)"),
            enable_hr_fix: P.bool("fal-iclight: the high-res fix (default true)"),
            light_type: P.enum(`fal-bria: the light type; ${RELIGHT_FROM_LIGHTS} (the default) takes it from the first light that is on`, [RELIGHT_FROM_LIGHTS, ...RELIGHT_LIGHT_TYPES]),
            lora_strength: P.num("comfycloud, comfyui: the relight LoRA's strength 0..100 % in steps of 5, as the slider (default 100); a value in (0, 1] is a fraction (0.8 = 80 %), as ComfyUI writes it"),
            steps: P.int("comfycloud, comfyui: sampling steps 1..20 (default 4)"),
            detail: P.bool("every generative route: detail from the original, the model's light laid on the original's pixels (default true; above 27.9 MP it has to be off)"),
            timeout: P.timeout(600),
        },
        async run(ed, a) {
            // a preset (QW4): the panel's lights for this picture's size, as `lights` would give them
            if (a.preset != null && a.preset !== "") {
                if (a.lights !== undefined) throw new Error("relight takes either preset or lights, not both.");
                const ids = LIGHT_PRESETS.map((p) => String(p.id));
                if (!ids.includes(String(a.preset))) throw new Error(`Unknown light preset "${a.preset}" (one of: ${ids.join(", ")})`);
                a = { ...a, lights: applyLightPreset(/** @type {any} */ (String(a.preset)), { width: ed.width, height: ed.height }) };
            }
            // the route this call names; a generative one renders below. Omitted, an edit keeps the layer's route and
            // renders nothing (the assistant's policy runs a relight without route unasked: it must never render)
            const given = a.route != null && a.route !== "" ? String(a.route) : null;
            if (given && !RELIGHT_ROUTES.includes(given)) {
                throw new Error(`Unknown relight route "${given}" (must be one of: ${RELIGHT_ROUTES.join(", ")})`);
            }
            const route = given || "app";
            // the model values, checked before anything changes
            const model = relightModel(a);
            let l;
            if (a.layer != null && a.layer !== "") {
                l = findLayer(ed, a.layer);
                if (l.kind !== "filter" || l.filter !== "relight") {
                    throw new Error(`${l.name} is not a relight filter layer`);
                }
                const raw = {};
                if (a.lights !== undefined) raw.lights = a.lights;
                if (a.original !== undefined) raw.original = a.original;
                if (a.ambient !== undefined) raw.ambient = a.ambient;
                if (a.depth_scale !== undefined) raw.depth_scale = a.depth_scale;
                if (a.shadows !== undefined) raw.shadows = a.shadows;
                // a route goes in the same step as the values, and only when it changes (a render on the layer's own
                // route pushes no empty step)
                if (given && given !== ((l.params && l.params.route) || "app")) raw.route = given;
                const vals = Object.keys(raw).length ? checkParams("relight", raw, { width: ed.width, height: ed.height }) : {};
                if (vals.lights) vals.lights = normalizeLights(raw.lights, { width: ed.width, height: ed.height });
                const keys = Object.keys(vals);
                // a model value the layer already holds is no change (an agent that sends the same ones with every render)
                const held = l.params || {};
                const modelKeys = Object.keys(model).filter((k) => RELIGHT_MODEL[k].keys.some((key) => (model[k] === undefined ? held[key] != null : held[key] !== model[k])));
                if (keys.length || modelKeys.length) {
                    const label = keys.length === 1 && !modelKeys.length && keys[0] === "route" ? "Relight route"
                        : !keys.length && modelKeys.length === 1 ? `Relight: ${RELIGHT_MODEL[modelKeys[0]].label}`
                            : modelKeys.length ? "Relight" : filterStepLabel("relight", keys);
                    ed.pushUndo({ kind: "filter", id: l.id, label });
                    if (keys.length) writeParams(ed, l, vals);
                    if (modelKeys.length) writeRelightModel(ed, l, Object.fromEntries(modelKeys.map((k) => [k, model[k]])));
                    touch(ed);
                }
            } else {
                const raw = {};
                if (a.lights !== undefined) raw.lights = a.lights;
                if (a.original !== undefined) raw.original = a.original;
                if (a.ambient !== undefined) raw.ambient = a.ambient;
                if (a.depth_scale !== undefined) raw.depth_scale = a.depth_scale;
                if (a.shadows !== undefined) raw.shadows = a.shadows;
                const vals = Object.keys(raw).length ? checkParams("relight", raw, { width: ed.width, height: ed.height }) : {};
                if (vals.lights) vals.lights = normalizeLights(raw.lights, { width: ed.width, height: ed.height });

                const hasDepth = !!(ed.maps && ed.maps.depth && (ed.maps.depth.data || ed.maps.depth.u16));
                if (!hasDepth && ed.ensureDepthMap) {
                    await ed.ensureDepthMap();
                }
                l = ed.addFilterLayer("relight");
                if (!l) throw new Error(ed.status || "Failed to add relight layer");
                if (!vals.lights && !l.params?.lights?.length) {
                    vals.lights = [defaultLight(0, { width: ed.width, height: ed.height })];
                }
                if (Object.keys(vals).length) {
                    writeParams(ed, l, vals);
                }
                if (Object.keys(model).length) writeRelightModel(ed, l, model);
                if (l.params) l.params.route = route;
                if (ed.setTool) ed.setTool("lights");
                touch(ed);
            }
            if (ed.relightSettled) await ed.relightSettled();
            const stats = (ed.belowStats ? ed.belowStats(l) : null) || l._bstats?.stats || l._relight?.stats;
            const fitStats = stats?.fit || null;
            const fit = fitStats
                ? { direction: fitStats.l0, l0: fitStats.l0, ka: fitStats.ka, kd: fitStats.kd }
                : { direction: [0, 0, 1], l0: [0, 0, 1], ka: 1, kd: 0 };
            if (route !== "app") {
                const deadline = a.timeout ? Date.now() + a.timeout * 1000 : 0;
                const rendered = await host.relightWhole(ed, l, { route, prompt: a.prompt || "", deadline });
                return {
                    layer: layerSummary(ed, rendered.layer || l),
                    lights: l.params?.lights || [],
                    fit,
                    route,
                    seconds: rendered.seconds || 0,
                    notes: rendered.note ? [rendered.note] : [],
                };
            }
            const own = (l.params && l.params.route) || "app";
            return {
                layer: layerSummary(ed, l),
                lights: l.params?.lights || [],
                fit,
                route: own,
                seconds: 0,
                notes: own !== "app" ? [`the layer's route is ${own}: nothing was rendered (route "${own}" renders it)`] : [],
            };
        },
    },
    generate: {
        needsImage: true, description: `Generate with the selected recipe: the selected area (with context) goes to the model, the answer comes back as a result layer. Waits for it. prompt_sent is the prompt as the model got it (each @img token written as that model's name for its picture; on a local ComfyUI recipe as the graph numbers the picture in the node's batch, e.g. <image3>); notes says what the route or the recipe left out (and when a selection of several separate areas goes as one crop scaled to under half its size, that each area on its own would be sharper); seed is the seed the model got, null when the route sends none (FLUX 3 Image); loras_sent the LoRAs the run loaded, [{ name, strength }] in their order (the selected recipe's switched-on rows on your ComfyUI or Comfy Cloud, set_generation loras; [] for an API run). each_area: generate each separate area of the selection on its own (status areas: 2 to ${AREA_CAP} areas; the parts whose crops would overlap are one area, specks below max(256 px, a 20,000th of the picture) outside every area are left out): the same prompt and the selected recipe, each area its own crop and run, one after another (on your ComfyUI too: the next area is queued once the one before landed), each result its own layer; an API run is charged once per area. The document's selection is not changed by it; while it runs, a turn, a crop or resize, generate_new and a plain generate on that document are refused, and on your ComfyUI it refuses to start while a render of the document is still there. timeout bounds the whole run: no area starts that the time left would not hold. It answers areas, generated (the results that landed), layers, sent (the areas that went out, charged on an API model), not_sent, still_running (an area left running on your ComfyUI when it stopped, null), cancelled, stopped (cancel, recipe: the recipe changed, time, failed, or null), failed (the error that stopped it, null), said (a cancel's words for an area that had gone out: whether it is charged), left_out, notes (the areas' run notes, once each), status and seconds; cancel_run stops the run going and the areas not yet sent.`,
        params: { timeout: P.timeout(600), each_area: P.bool(`generate each separate area of the selection on its own (2 to ${AREA_CAP} areas)`, { default: false }) },
        async run(ed, a) {
            if (a.each_area) return generateEachArea(ed, a);
            // the selection's separate areas counted before the run, so its notes can say when one crop of all of them
            // goes out strongly scaled down (an agent's selection is often made just before)
            if (ed.sel && host.selectionAreas) { try { await host.selectionAreas(ed); } catch (_) { /* the hint is optional */ } }
            const n0 = ed.history.length;
            const { wired } = host.resultInputState(ed);
            if (!wired) throw new Error("the recipe has no result output for this mode: select a recipe first");
            ed.lastSentPrompt = null;
            ed.lastRunNotes = [];
            ed.lastLoras = [];
            ed.lastPassError = null;
            // a failure of the run: the status reads Error / failed, or is the Realism Pass's sentence for the pack's error
            const failed = () => /^Error|failed/i.test(ed.status || "") || (!!ed.lastPassError && String(ed.status || "").startsWith(ed.lastPassError));
            // a refusal of this run (a token that cannot go, a missing key, ...) is said at once, not after the wait below;
            // a provider run is over when ed.generate() returns, so `seconds` counts from here
            if (ed.providerPending) throw refusal("a run is still going on this document");
            const started = Date.now(), limit = clampInt(a.timeout, 5, 3600, 600) * 1000;
            const run = await ed.generate();
            if (run && run.error) throw run.error;
            // a provider run has landed its layer when generate() returns: a sentence in its status that reads "failed"
            // (a note of the route) is no failure of the run
            if (ed.history.length <= n0 && failed()) throw new Error(ed.status);
            const t0 = Date.now();
            const provider = host.recipe && host.recipe.kind === "provider";
            let idleSince = 0;
            while (Date.now() - t0 < limit) {
                await wait(500);
                if (ed.history.length > n0) break;
                if (failed()) throw new Error(ed.status);
                if (provider) { if (!ed.providerPending) break; continue; }
                // the queue went idle without a result: the run failed elsewhere in the graph
                try {
                    const q = await (await api.fetchApi("/queue")).json();
                    const idle = !(q.queue_running || []).length && !(q.queue_pending || []).length;
                    if (idle && Date.now() - t0 > 3000) { idleSince = idleSince || Date.now(); if (Date.now() - idleSince > 2500) break; } else idleSince = 0;
                } catch (_) { /* ignore */ }
            }
            await until(() => ed.history.length > n0 || failed(), Math.max(30000, Math.min(limit - (Date.now() - t0), 180000)), 250);
            if (ed.history.length <= n0) throw new Error("no result arrived: " + (ed.status || "the run produced nothing"));
            const h = ed.history[ed.history.length - 1];
            const layer = ed.layers.find((l) => l.id === h.layerId);
            // prompt_sent: the prompt as the model got it, each @img token written as the model's name for its picture;
            // notes: what the route (or a local recipe's slots) left out; boxes: how many boxes went in the prompt
            return { layer: layer ? layerSummary(ed, layer) : null, seed: h.seed, mode: h.mode, status: ed.status, seconds: Math.round((Date.now() - started) / 100) / 10, prompt_sent: ed.lastSentPrompt, notes: ed.lastRunNotes || [], boxes: ed.lastSentBoxes || 0, loras_sent: ed.lastLoras || [] };
        },
    },
    cancel_run: {
        scope: "app",
        description: `Cancel the runs in flight, as the title row's Cancel does: API runs (generate, generate_new and upscale on an API model) and the runs on the user's ComfyUI that hold a document (realism_pass, key_screen, upscale of the whole picture with a local recipe), whose job is taken off the server; a generate each_area going stops after the run going, its areas not yet sent never go. doc: only that tab's runs; without it every tab's. A command waiting on a cancelled run (generate, generate_new, upscale, realism_pass, key_screen) ends with the cancel once the provider answered the stop (Comfy Cloud, Comfy Router: up to about 10 s), and nothing lands. A Generate with a recipe on the user's own ComfyUI is not stopped (Scumble never interrupts the user's server). cancelled: the runs (none: nothing was running), each with said: how it ended as Scumble knows it (Scumble asked the provider to stop the job; the job had already finished and is charged, its picture not kept; the job had already ended on the provider without a picture, with its status; nothing had gone to the provider; or Scumble stopped waiting and the provider may still finish and charge it, and for a Comfy Cloud job whose stop was not confirmed that Scumble keeps the job and opens its picture as a document of its own when Comfy has it), null while it has not ended; landing: runs whose answer was already in and is landing (no longer cancellable; Ctrl+Z takes the result back once it is in); ended: whether they have let go of their documents (waited for up to 25 s for an API run, 10 s for a run on the user's ComfyUI); note: those words together, and for a run that did not end in time that a provider may still finish a job it already had and charge it.`,
        params: { doc: P.int("only this tab's runs (the id from list_documents); every tab's when left out") },
        async run(_, a) {
            let ed = null;
            if (a.doc != null && a.doc !== "") {
                ed = host.editorById(a.doc);
                if (!ed) throw new Error(`no document with id ${a.doc} (open: ${host.editors().map((e) => e.node.id).join(", ") || "none"})`);
            }
            const now = Date.now();
            // a generate each_area going (item 54): its areas not yet sent stay out
            const areaRuns = (ed ? [ed] : host.editors()).filter((e) => e._eachArea).length;
            const runs = host.cancelRuns(ed);
            // a run whose answer is in has left the title row but still holds its document until its result has landed:
            // it can no longer be cancelled, so it is named as landing (and waited for), never as nothing running
            const landing = (ed ? [ed] : host.editors()).filter((e) => e.providerPending && !runs.includes(e.providerPending))
                .map((e) => ({ e, t: e.providerPending }));
            // the run ends in its own code (main aborts the request, a job on the user's ComfyUI is taken off it): wait for
            // its slot and its row in the title bar to go
            const over = () => runs.every((t) => !host._providerRuns.has(t) && !(t.editor && t.editor.providerPending === t))
                && landing.every((x) => x.e.providerPending !== x.t);
            // an API run ends once main's stop is answered: Comfy Cloud asks the job to stop within 10 s (its one retry
            // included), then ends its event stream; Comfy Router's stop has 10 s too (review G3.3), so it gets longer
            // than a run on the user's ComfyUI
            const api = (t) => !!(t.runId && t.provider && t.provider !== "comfyui");
            const ended = runs.length || landing.length ? await until(over, runs.some(api) ? 25000 : 10000, 100) : true;
            const notes = [];
            // each API run's own words from main (what Scumble knew of the job when it stopped, review G3.2); the
            // generic one only for a run that has not ended, or ended without words
            const gone = (t) => !host._providerRuns.has(t) && !(t.editor && t.editor.providerPending === t);
            for (const t of runs) if (api(t) && gone(t) && t.said) notes.push(`${t.label || t.provider}: ${t.said}`);
            if (runs.some((t) => api(t) && !(gone(t) && t.said))) notes.push("A provider may still finish a job it already had and charge it.");
            if (runs.some((t) => !api(t))) notes.push("A run on your ComfyUI has its job taken off the server.");
            if (landing.length) notes.push("A run's answer was already in and is landing: it can no longer be cancelled (Ctrl+Z takes it back once it is in).");
            if (areaRuns) notes.push("Each area: the areas not yet sent do not go.");
            if (!notes.length) notes.push("Nothing was running" + (ed ? " on this document." : "."));
            return {
                cancelled: runs.map((t) => ({ doc: t.editor && t.editor.node ? t.editor.node.id : null, provider: t.provider || null, label: t.label || t.provider || null, seconds: Math.round((now - (t.started || now)) / 100) / 10, said: gone(t) && t.said ? t.said : null })),
                landing: landing.map((x) => ({ doc: x.e.node ? x.e.node.id : null, label: x.t.label || x.t.provider || null })),
                ended,
                note: notes.join(" "),
            };
        },
    },
};

export function bindRunCommands(C) { COMMANDS = C; }
