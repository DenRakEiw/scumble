// @ts-check
// queueGenerate, ensureOnServer, workflowForPng, setNodeParam, saveExport, bundle, saveAll, file refs: moved out of host.js (item 56 S13, docs/PLAN_SPLIT.md), text unchanged.

import * as comfyprompt from "./comfyprompt.js";
import * as genpresets from "./genpresets.js";
import * as realism from "./realism.js";
import { withoutSecrets } from "./redact.js";
import { refusal } from "./inpaint_status.js";
import { refName, trimSlots } from "./comfyrefs.js";
import { loraWords, spliceLoras } from "./loras.js";
import { markStep } from "./inpaint_jobs.js";
import { areaHint, areasSoon, sameRecipe } from "./eacharea.js";
import { API_SIZES, AREA_RECIPE_CHANGED, AREA_STOPPED, CLOSED_MAX, RUN_GOING, SAVE_PIECE, api, aspectOf, boxesSchema, docMeta, hashString, kleinRun, listWords, notesKind, promptMissing, sentTexts, viaLine } from "./host_util.js";

export const HostQueuePart = {
    /**
     * Fill the recipe with the editor state and queue it. Called by editor.generate(); `opts.refs` is the click's
     * reference snapshot (docs/PLAN_REFS.md C3; a caller without one gets the references of now). `opts.area` (Each
     * area, eacharea.js): one area of the selection, run instead of the selection itself (the document's selection is
     * never read for it); its `sent` and `promptId` are set once the prompt is queued.
     */
    async queueGenerate(editor, opts = {}) {
        const area = opts.area || null;
        // an area runs the recipe its click confirmed: one selected meanwhile (during generate()'s waits) is refused
        if (area && !sameRecipe(this.recipe, area.recipe)) throw refusal(AREA_RECIPE_CHANGED);
        // Generate new on a ComfyUI recipe (generate_new's local path, a fresh canvas): the size its boxes were drawn on,
        // read once whatever the run does
        const fresh = editor._newBoxes || null;
        editor._newBoxes = undefined;
        const r = this.recipe;
        if (!r) throw refusal("No recipe selected.");
        // a run whose landing resizes the document (an upscale of the whole picture, the Realism Pass above 1×) holds it:
        // a render queued now would land in the old geometry (editor.generate refuses first; this is the net)
        if (editor.providerPending && editor.providerPending.resizes) throw refusal(RUN_GOING);
        if (r.kind === "provider" && r.task === "upscale") return this.runUpscale(editor, { scope: "selection", refs: opts.refs });
        if (r.kind === "provider") return this.runProvider(editor, { refs: opts.refs, ...(area ? { area } : {}) });
        if (!r.prompt) throw refusal("No recipe selected.");
        // an area of Each area is an edit of the selection: never an upscale or the pass (eacharea.js refuses them first)
        if (area && (r.task === "upscale" || r.task === "pass" || fresh)) throw refusal(`Each area runs an edit recipe; ${r.name || r.id} is not one.`);
        // a text-to-image graph (recipes/moss_image_local.json, `edit: false`): only Generate new's fresh canvas runs it;
        // on a selection it would paint a picture made from the prompt alone into the crop
        if (r.edit === false && !fresh) throw refusal(`${r.name || r.id} makes new pictures from the prompt alone: use "Generate new", not Generate.`);
        // the generation values of the click, before anything is awaited: the result's history entry keeps them (S4)
        const clickGen = { seed: editor.genSettings.seed, mode: editor.genSettings.mode, denoise: editor.genSettings.denoise };
        // the Realism Pass (task "pass") goes out like an upscale: the box as it is, no fill, no references, no refine
        const pass = r.task === "pass";
        const upscale = r.task === "upscale" || pass;
        // An upscaler sends no reference picture and may not read the prompt at all: its tokens go as names where a
        // layer has one, and nothing refuses it. Any other recipe names each token's picture the way its graph numbers
        // the node's batch (26e): checked here against the editor now, before anything is uploaded, and again below
        // against the canvas state the node will read.
        const snap = opts.refs || editor.refSnapshot();
        // a recipe that needs words (promptRequired, P-H3-Image) refuses an empty prompt before anything is uploaded
        const noWords = upscale ? "" : promptMissing(r, snap.prompt);
        if (noWords) throw refusal(noWords);
        let texts, early = null;
        // the pass refuses before anything is uploaded: the server (§3.3), the selection, the size (§3.5)
        const support = pass ? this.realismSupport() : null;
        if (pass) {
            if (!support.ok) throw new Error(support.reason);
            const b = editor.getBounds && editor.getBounds();
            if (!b) throw refusal(`Select an area first: ${realism.LABEL} works on the selection's box (Select All for the whole picture).`);
            // the crop the node makes: the box with its context (cropRect mirrors the node's manual or auto padding, the
            // auto minimum span and the clamp to the picture), then each side to the pass's multiple the node's way
            const [, , cw, ch] = editor.cropRect();
            const tooBig = realism.fits(realism.fitSpan(cw, editor.width), realism.fitSpan(ch, editor.height));
            if (tooBig) throw refusal(tooBig, "warn");
        }
        if (upscale) {
            const p = this.refNames(editor, snap.prompt), n = this.refNames(editor, snap.negative);
            // the pass's graph reads no prompt at all, so its tokens need no note
            texts = { prompt: p.text, negative: n.text, note: !pass && (p.note || n.note) ? "Upscale sends no reference images: the prompt's @img tokens were written as layer names." : "" };
        } else {
            early = this.comfyPlan(editor, r, snap.refIds.length, null, { fresh: !!fresh });
            texts = this.refPrompt(editor, snap, "comfy", { recipe: r, comfy: early });
        }
        if (!this.connected) throw refusal("Not connected to ComfyUI.");
        const missing = (r.needs || []).filter((n) => this.objectInfo && !this.objectInfo[n]);
        if (missing.length) throw new Error(comfyprompt.lacksNodesText(r, missing));
        if (upscale && !pass && !(editor.getBounds && editor.getBounds())) throw refusal("Select an area first: an upscale model on ComfyUI sharpens the selection's box.");
        // the recipe's LoRA rows (item 50): more than five, or a file the server's list lacks, refuse here, before
        // anything is uploaded; spliced into the queued copy below
        const loraPlan = upscale ? null : await this.loraPlan(editor, r);
        // a ComfyUI upscaler that takes a factor (RTX Video Super Resolution): the one the dialog or the command asked
        // (editor.generate() takes no arguments and is shared with the node, so the factor travels on the editor, read
        // once), and the size limits on the crop the node makes, before anything is uploaded
        let factor = null;
        if (upscale && !pass) {
            const want = opts.factor !== undefined ? opts.factor : editor._comfyUpscaleFactor;
            editor._comfyUpscaleFactor = undefined;
            factor = this.upscaleFactorFor(r, want);
            const [, , cw, ch] = editor.cropRect();
            const m = Math.max(1, +(this.nodeParams && this.nodeParams.multiple_of) || 8);
            const tooBig = this.upscaleSizeRefusal(r, realism.fitSpan(cw, editor.width, m), realism.fitSpan(ch, editor.height, m), factor, "box");
            if (tooBig) throw refusal(tooBig, "warn");
        }
        // boxes in the prompt (a recipe that declares the input FLUX 3's rows go to, `boxes`): with the Boxes switch on, the
        // boxes the run sends (localBoxPlan: the document's, or the selection as one box when it holds none; on Generate
        // new the plan generate_new made before the fresh canvas replaced the picture). The Inpaint Canvas node writes the
        // rows from the canvas state into its box_prompt output, which an older node does not have: refused here, before
        // anything is uploaded, and again below on the state
        const boxSchema = upscale ? null : boxesSchema(r);
        const runRefs = upscale ? [] : snap.refIds.slice(0, early.lay.kept);
        let boxPlan = null, boxSlot = -1;
        if (boxSchema && editor.genSettings.boxes) {
            boxPlan = fresh && fresh.plan ? fresh.plan : this.localBoxPlan(editor, runRefs, { fresh: !!fresh });
            if (boxPlan.goes) {
                boxSlot = await this.boxPromptSlot();
                if (boxSlot < 0) throw refusal(comfyprompt.oldNodeBoxes(r), "warn");
            }
        }
        editor.lastUpscaleFactor = factor;
        editor.lastSentPrompt = null;
        editor.lastRunNotes = [];
        editor.lastSentBoxes = 0;
        editor.lastLoras = [];
        if (boxSchema && !editor.genSettings.boxes) {
            const held = this.plugins ? this.plugins.countBoxes(editor) : 0;
            if (held) editor.lastRunNotes.push(`The document's ${held} box${held === 1 ? "" : "es"} did not go: the Boxes switch under the prompt is off.`);
        }
        // the plan's boxes as serializeForPrompt sends them; Generate new's scaled from the picture they were drawn on to
        // the fresh canvas, as fractions of the picture as an API model's Generate new places them (another shape
        // stretches them, and the notes say so)
        let boxGiven = null, stretched = "";
        if (boxPlan) {
            boxGiven = { boxes: boxPlan.boxes ? JSON.parse(JSON.stringify(boxPlan.boxes)) : null, notes: boxPlan.notes };
            if (fresh && comfyprompt.scaleStateBoxes(boxGiven, fresh.from, [editor.width, editor.height])) {
                stretched = genpresets.stretchNote(fresh.from, [editor.width, editor.height], genpresets.aspectsOf(r), fresh.aspect || null) || "";
            }
        }
        // an upscale's canvas state carries no references (upscaleState), so none is read or uploaded for it; a reference
        // past the recipe's slots is not uploaded either
        const sopts = upscale ? { refIds: [], prompt: texts.prompt, negative: texts.negative } : { refIds: runRefs, prompt: snap.prompt, negative: snap.negative, ...(boxGiven ? { boxes: boxGiven } : {}), ...(area ? { area } : {}) };
        let state, plan = null;
        if (upscale) state = this.upscaleState(await editor.serializeForPrompt(sopts));
        else {
            // the state decides: a selection, the fill or Original changed while the references were uploaded
            const st = JSON.parse(await editor.serializeForPrompt(sopts));
            // Generate new's fresh canvas: its Original (the blank canvas before the fill) carries nothing, so the node
            // sends none (it reads the state's crop) and the plan counts none; a run on a picture keeps the user's switch
            if (fresh && st.crop && st.crop.withOriginal) st.crop = { ...st.crop, withOriginal: false };
            plan = this.comfyPlan(editor, r, (st.references || []).length, st, { fresh: !!fresh });
            st.references = (st.references || []).slice(0, plan.lay.kept);
            texts = this.refPrompt(editor, snap, "comfy", { recipe: r, comfy: plan });
            st.prompt = texts.prompt;
            st.negative = texts.negative;
            if (texts.pairs.length) st.named_refs = true;
            // the boxes as the state carries them (the plan's: `boxes` whenever the document holds some, so a list it
            // emptied never turns into the selection's box; none but the plan's on Generate new): their count, the node's
            // box_prompt for a run that sends any. The switch is the state's (turned off while the pictures went up: none go)
            const listed = Array.isArray(st.boxes), stBoxes = listed ? st.boxes.length : 0;
            if (boxPlan) editor.lastRunNotes.push(...boxPlan.dropped);
            if (boxPlan && st.gen && st.gen.boxes && (stBoxes > 0 || (!fresh && !listed && !!st.hasSelection))) {
                if (boxSlot < 0) boxSlot = await this.boxPromptSlot();
                if (boxSlot < 0) throw refusal(comfyprompt.oldNodeBoxes(r), "warn");
                editor.lastSentBoxes = stBoxes || 1;
                if (stretched && stBoxes) editor.lastRunNotes.push(stretched);
                // an @img token in a description: the name this recipe gives its picture, as the prompt names it
                // (<ref_image_1>), not the node's "image n"; a token whose picture does not go stays, and the node says so
                if (stBoxes) {
                    const ids = [...Array(plan.lay.original).fill(null), ...snap.refIds.slice(0, plan.lay.kept)];
                    const idOf = new Map([...snap.labels].map(([id, n]) => [n, id]));
                    const spec = plan.spec, pictures = plan.lay.pictures;
                    st.boxes = comfyprompt.nameBoxTokens(st.boxes, (n) => {
                        const at = idOf.has(n) ? ids.indexOf(idOf.get(n)) : -1;
                        const pic = at >= 0 ? pictures.find((x) => x.ref === at) : null;
                        return pic && pic.n ? refName(spec.name, pic.n) : null;
                    });
                }
            } else boxSlot = -1;
            state = JSON.stringify(st);
            editor.lastSentPrompt = st.prompt;
            if (snap.refIds.length > plan.lay.kept) {
                const left = snap.refIds.slice(plan.lay.kept).map((id) => "img" + snap.labels.get(id));
                editor.lastRunNotes.push(`${listWords(left)} ${left.length === 1 ? "is" : "are"} not sent: ${r.name || r.id} reads ${plan.spec.slots} picture${plan.spec.slots === 1 ? "" : "s"}.`);
            }
            if (plan.spec.guess && texts.pairs.length) editor.lastRunNotes.push("(wording guessed from the graph)");
            // a selection of several separate areas whose one crop the node scales down strongly (item 54; not for a run
            // of one area of them)
            if (!fresh && !area) {
                const areaNote = areaHint(this, editor, null);
                if (areaNote) editor.lastRunNotes.push(areaNote);
            }
        }
        if (texts.note) editor.setStatus(`${editor.status} ${texts.note}`, editor.statusKind || "info");
        // an area of Each area stopped while its pictures went up: nothing is queued for it
        const areaStop = () => { if (area && typeof area.stopped === "function" && area.stopped()) throw Object.assign(new Error(AREA_STOPPED), { kind: "cancelled", statusKind: "info" }); };
        areaStop();
        const ensured = await this.ensureOnServer(state, editor);
        if (ensured && typeof ensured.state === "string") state = ensured.state;
        const prompt = JSON.parse(JSON.stringify(r.prompt));
        const canvas = prompt[r.canvas];
        if (!canvas) throw new Error(`Recipe "${r.id}" has no canvas node "${r.canvas}".`);
        // the encoder inputs whose picture this batch does not hold are left out, so none repeats the last one
        if (plan) trimSlots(prompt, plan.spec, 1 + plan.lay.original + plan.lay.kept);
        // Generate new without pictures after the crop on a recipe whose edit graph is text to image without its crop
        // (P-H3-Image, `newImage`): the fresh canvas's white crop does not go as the picture to edit
        const refsGo = !!(plan && plan.lay.original + plan.lay.kept > 0);
        if (plan && fresh && !refsGo && r.newImage) comfyprompt.dropForNewImage(prompt, r);
        canvas.inputs = { ...(canvas.inputs || {}), ...this.nodeParams, canvas_state: state };
        // an upscaler sees the crop at its native size: the node grows the box to a multiple instead of scaling it
        if (upscale) canvas.inputs.target_size = 0;
        // the pack rounds odd sides (a 1-px black column, or a resample) and a larger multiple shrinks a whole-picture
        // crop, leaving a border without the pass: the pass's crop is even and loses at most 1 px of an odd side
        if (pass) canvas.inputs.multiple_of = realism.PASS_MULTIPLE;
        delete canvas.inputs.result; delete canvas.inputs.result_local;
        delete canvas.inputs.result_source; delete canvas.inputs.result_source_local;
        canvas.inputs[r.mode === "api" ? "result_source" : "result_source_local"] = r.result;
        {
            // a row naming a file the server lacks refuses here, before anything is queued (issue #4)
            const lacks = this.missingFilesRefusal(editor, r);
            if (lacks) throw new Error(lacks);
        }
        for (const s of r.settings || []) {
            const entry = editor.settings[String(s.index)];
            const node = prompt[s.node];
            if (entry && entry.value != null && node && node.inputs) node.inputs[s.input] = entry.value;
        }
        if (factor != null && r.factor && r.factor.input) {
            const at = r.factor.input.indexOf("|"), node = prompt[r.factor.input.slice(0, at)];
            if (node && node.inputs) node.inputs[r.factor.input.slice(at + 1)] = factor;
        }
        // the run sends boxes: the recipe's declared input takes the node's box_prompt (the prompt with FLUX 3's rows,
        // written by the node from the state's boxes) instead of the plain prompt the recipe file keeps there
        if (boxSlot >= 0 && !comfyprompt.wireBoxPrompt(prompt, r, boxSlot)) throw new Error(`${r.name || r.id}: its boxes input ${r.boxes && r.boxes.input} does not read the Inpaint Canvas node's prompt, so no box could go.`);
        // a prompt upsampler in the graph (FLUX 3 Image Klein, 0.1.50 Q9): runs when its row is on, no box goes and the
        // server has its file and nodes; Generate new without pictures after the white crop takes the text-to-image
        // guide with the canvas's aspect
        const upClips = this.objectInfo && this.objectInfo.CLIPLoader && this.objectInfo.CLIPLoader.input && this.objectInfo.CLIPLoader.input.required
            && Array.isArray(this.objectInfo.CLIPLoader.input.required.clip_name) ? this.objectInfo.CLIPLoader.input.required.clip_name[0] : null;
        const upsampled = comfyprompt.wireUpsampler(prompt, r, {
            text: texts.prompt, fresh: !!fresh, refsGo, pictures: plan ? 1 + plan.lay.original + plan.lay.kept : 1,
            aspect: fresh ? (fresh.aspect || aspectOf(editor.width, editor.height)) : null, boxes: boxSlot >= 0,
            files: Array.isArray(upClips) ? upClips.map(String) : null, classes: this.objectInfo || null,
        });
        if (upsampled.note) {
            if (plan) editor.lastRunNotes.push(upsampled.note);
            else editor.setStatus(`${editor.status} ${upsampled.note}`, editor.statusKind || "info");
        }
        // the LoRA rows (item 50, docs/PLAN_LORAS.md §3.1): a chain after the graph's model loader, every reader of its
        // MODEL re-pointed to the chain's end, in this copy only (the recipe's own graph never changes); last, so the
        // Settings rows, the boxes and the upsampler have written the graph it reads
        let lorasSent = [];
        // rows a recipe without a model source keeps (its section hidden): a plain line, nothing spliced
        if (loraPlan && loraPlan.hidden) editor.lastRunNotes.push(loraPlan.hidden);
        else if (loraPlan) {
            const spliced = spliceLoras(prompt, r, loraPlan.rows, this.objectInfo);
            lorasSent = spliced.applied;
            if (spliced.note) editor.lastRunNotes.push(spliced.note);
            if (lorasSent.length) editor.lastRunNotes.push(`LoRAs: ${loraWords(lorasSent)}.`);
        }
        editor.lastLoras = lorasSent;
        if (pass) {
            // Style and Strength are app-wide (settings.realism, the Upscale dialog's row); the DLSS model preset is the
            // recipe's own Settings row (its shipped presets L and M), so it is not taken from settings.realism here. A
            // user copy without an rp_settings node gets them in every DLSS5Settings node it holds.
            const v = this.realismValues();
            for (const node of Object.values(prompt)) {
                if (node && node.class_type === "DLSS5Settings") node.inputs = realism.passSettings(node.inputs, { style: v.style, intensity: v.intensity });
            }
        }
        areaStop();
        const res = await api.queuePrompt(0, { output: prompt, workflow: this.workflowInfo(lorasSent.length ? { loras: lorasSent } : null) });
        editor.lastPromptId = res && res.prompt_id;
        // a run of one area of several (Each area): queued, so it counts as sent; its prompt is what the run waits for
        if (area && res && res.prompt_id != null) { area.sent = true; area.promptId = res.prompt_id; }
        // the tab closed while its prompt was being queued (the uploads take a while): its result lands nowhere
        if (res && res.prompt_id && !this._editors.includes(editor)) this._closedPrompts.add(String(res.prompt_id));
        // a Klein run's files: its sampler's shape error is said as the text encoder that does not fit (0.1.50 Q1)
        const klein = res && res.prompt_id != null ? kleinRun(r, prompt) : null;
        if (upsampled.show && res && res.prompt_id != null) {
            this._upsampledRuns.set(String(res.prompt_id), upsampled.show);
            for (const id of this._upsampledRuns.keys()) { if (this._upsampledRuns.size <= 64) break; this._upsampledRuns.delete(id); }
        }
        if (klein) {
            this._kleinRuns.set(String(res.prompt_id), klein);
            for (const id of this._kleinRuns.keys()) { if (this._kleinRuns.size <= 64) break; this._kleinRuns.delete(id); }
        }
        if (pass && support.note) editor.setStatus(`${editor.status} ${support.note}`, editor.statusKind || "info");
        if (plan) {
            const named = texts.pairs.filter((p) => p.name).map((p) => `${p.label} → ${p.name}`);
            if (named.length) editor.setStatus(`${editor.status} Named in the prompt: ${named.join(", ")}.`, editor.statusKind || "info");
            const nb = editor.lastSentBoxes;
            if (nb) editor.setStatus(`${editor.status} Sent with ${nb} box${nb === 1 ? "" : "es"}.`, editor.statusKind || "info");
            if (editor.lastRunNotes.length) editor.setStatus(`${editor.status} ${editor.lastRunNotes.join(" ")}`, notesKind(editor, editor.lastRunNotes));
            if (named.length && window.scumble && window.scumble.log) {
                Promise.resolve(window.scumble.log.add({ level: "info", source: "comfy", message: `local run ${(res && res.prompt_id) || ""}: prompt as sent`, detail: editor.lastSentPrompt })).catch(() => { /* the log is optional */ });
            }
        }
        if (lorasSent.length && window.scumble && window.scumble.log) {
            Promise.resolve(window.scumble.log.add({ level: "info", source: "comfy", message: `local run ${(res && res.prompt_id) || ""}: LoRAs ${loraWords(lorasSent)}`, detail: lorasSent })).catch(() => { /* the log is optional */ });
        }
        // open until ComfyUI says the prompt ended (success, error, interrupt) or its queue is empty: a turn of the whole
        // picture waits for it, since the result lands in the geometry it was made for (PLAN_0_1_31 §7)
        if (res && res.prompt_id) (editor._localRuns || (editor._localRuns = new Set())).add(res.prompt_id);
        if (res && res.prompt_id) this.trackRun(editor, res.prompt_id, this.runNodeCount(prompt));
        // a run that took box_prompt: the node's notes on its boxes are this run's (the `executed` listener shows them);
        // any other run's are not, whatever the node wrote for a switch left on (taken out when the result lands; the
        // bound is only for prompts that never answer)
        if (boxSlot >= 0 && res && res.prompt_id != null) {
            const boxed = editor._boxPrompts || (editor._boxPrompts = new Set());
            boxed.add(String(res.prompt_id));
            while (boxed.size > 50) boxed.delete(boxed.values().next().value);
        }
        // the result's history entry keeps the prompt of the click, not the field's text when it lands (S4)
        if (res && res.prompt_id) {
            const sent = editor._sentTexts || (editor._sentTexts = new Map());
            // an upscale or the pass reads no prompt unless its recipe says so (as runUpscale records it); the seed, mode
            // and denoise of the click too, which a later click changes before this result lands
            const texts0 = upscale ? (r.usesPrompt ? { prompt: texts.prompt, negative: texts.negative, refs: null } : { prompt: "", negative: "", refs: null }) : sentTexts(snap);
            // QW5: the result names the recipe and where it ran; the seconds are counted when it lands
            sent.set(res.prompt_id, { ...texts0, ...clickGen, via: viaLine(r, "your ComfyUI", null, lorasSent), viaStarted: Date.now() });
            // taken out when the result lands; the bound is only for prompts that never answer
            while (sent.size > 500) sent.delete(sent.keys().next().value);
        }
        return res;
    },

    /**
     * The canvas state an upscale recipe on ComfyUI gets: the crop as it is (no fill, so no second "Original"
     * picture either), no reference layers and no refine pass; everything else (context, feather, paste,
     * colour match) stays the user's.
     */
    upscaleState(stateJson) {
        const s = typeof stateJson === "string" ? JSON.parse(stateJson) : { ...(stateJson || {}) };
        s.crop = { ...(s.crop || {}), fill: "none", withOriginal: false };
        s.references = [];
        if (s.gen) s.gen = { ...s.gen, refine: false };
        return JSON.stringify(s);
    },

    /** The file refs a canvas_state JSON makes the node read: base, mask, control, references. */
    stateRefs(stateJson) {
        let s = null;
        try { s = typeof stateJson === "string" ? JSON.parse(stateJson) : stateJson; } catch (_) { return []; }
        if (!s) return [];
        const refs = [];
        const add = (ref) => { if (ref && typeof ref.filename === "string") refs.push({ filename: ref.filename, subfolder: ref.subfolder || "", type: ref.type || "input" }); };
        add(s.base); add(s.mask); add(s.control);
        for (const ref of s.references || []) add(ref);
        return refs;
    },

    /** Rewrite base, mask, control and references in `stateJson` when `ensureOnServer` renamed plain refs on the server. */
    rewriteStateRefs(stateJson, renamed) {
        if (!renamed || !Object.keys(renamed).length) return stateJson;
        const isStr = typeof stateJson === "string";
        let s = null;
        try { s = isStr ? JSON.parse(stateJson) : stateJson; } catch (_) { return stateJson; }
        if (!s || typeof s !== "object") return stateJson;
        const fix = (ref) => {
            if (!ref || typeof ref.filename !== "string") return;
            const k = `${ref.type || "input"}/${ref.subfolder || ""}/${ref.filename}`;
            if (renamed[k]) ref.filename = renamed[k];
        };
        fix(s.base); fix(s.mask); fix(s.control);
        for (const ref of s.references || []) fix(ref);
        return isStr ? JSON.stringify(s) : s;
    },

    /**
     * Files live in the local mirror (electron/main/files.js); the server only has copies.
     * Before a run, upload those it lacks (a fresh server, a restarted RunPod, a cleanup).
     */
    async ensureOnServer(stateJson, editor) {
        const refs = this.stateRefs(stateJson);
        if (!refs.length) return null;
        const report = await this.ensureRefs(refs);
        if (report && report.uploaded.length && editor) editor.setStatus(`Uploaded ${report.uploaded.length} file${report.uploaded.length > 1 ? "s" : ""} to the server. Waiting for the result ...`);
        if (report && report.missing.length) throw new Error("These files are neither on the server nor in the local store: " + report.missing.join(", "));
        if (report && report.renamed && Object.keys(report.renamed).length) {
            const next = this.rewriteStateRefs(stateJson, report.renamed);
            if (typeof next === "string") report.state = next;
        }
        return report;
    },

    /** What goes into an exported PNG's tEXt chunk in place of the litegraph workflow, or null when nothing is to go in (3f). */
    workflowForPng(editor) {
        const own = editor && editor._export ? editor._export.metadata : null;
        if (!(own == null ? this.embedRecipe : own)) return null;
        // the LoRA rows a run of the selected recipe would load now (item 50): the picture's own run is not known here
        const loras = this.lorasNow(this.recipe);
        return this.workflowInfo(loras.length ? { loras } : null);
    },

    /**
     * The recipe as the app describes it: the export's tEXt chunk, and a local run's `extra_pnginfo` for a SaveImage in
     * it. The recipe's prompt goes without the inputs named like a key, a token, a secret or a password (`redact.js`,
     * the user 2026-09-27): an imported workflow carries its third-party key widgets, and the picture may travel. The
     * run itself is queued from `r.prompt` (queueGenerate), which keeps them. `extra.loras` ([{ name, strength }], item
     * 50): the LoRAs the run loaded (a local run's extra_pnginfo) or a run would load (the export), spliced into the
     * queued copy only, so `prompt` never shows them; the key is left out when there are none.
     */
    workflowInfo(extra = null) {
        const r = this.recipe;
        const loras = extra && Array.isArray(extra.loras) && extra.loras.length ? { loras: extra.loras.map((l) => ({ name: l.name, strength: l.strength })) } : {};
        return { app: "scumble", recipe: r ? r.id : null, kind: r ? r.kind || "comfy" : null, provider: (r && r.provider) || null, model: (r && r.model) || null, prompt: r ? withoutSecrets(r.prompt || null) : null, nodeParams: this.nodeParams, ...loras };
    },

    /**
     * The InpaintCanvas node's own widgets, which the litegraph node showed under the
     * editor button: crop padding, target size, feather, multiple_of. Built into the
     * editor's Generate section, stored in
     * settings.nodeParams and filled into the recipe's canvas node on every run.
     */
    buildGenerateExtras(editor, sec) {
        const grid = document.createElement("div");
        grid.className = "ipc-row4 scumble-node-params";
        /** @type {[key: string, label: string, min: number, max: number, step: number, title: string][]} */
        const fields = [
            ["padding", "Padding", 0, 4096, 8, "Pixels of context around the selection that go into the crop (ignored when Crop is set to auto context)"],
            ["target_size", "Target", 0, 8192, 8, "Long side of the crop sent to the model; 0 keeps the crop at its own size"],
            ["feather", "Feather", 0, 512, 1, "Edge feather in pixels when the result is stitched back (used when the crop's edge setting is not auto)"],
            ["multiple_of", "Multiple", 1, 256, 1, "Crop width and height are rounded to a multiple of this (64 for Flux and SDXL, 16 for SD 1.5)"],
        ];
        const inputs = {};
        for (const [key, label, min, max, step, title] of fields) {
            const lab = document.createElement("span");
            lab.textContent = label; lab.title = title;
            grid.appendChild(lab);
            const input = document.createElement("input");
            input.type = "number"; input.className = "ipc-num"; input.style.width = "64px";
            input.min = String(min); input.max = String(max); input.step = String(step); input.title = title;
            input.value = String(this.nodeParams[key]);
            input.addEventListener("keydown", (e) => e.stopPropagation());
            input.addEventListener("change", () => {
                const v = Math.min(max, Math.max(min, Math.round(+input.value || 0)));
                input.value = String(v);
                this.setNodeParam(key, v);
            });
            grid.appendChild(input);
            inputs[key] = input;
        }
        sec.appendChild(grid);
        editor._nodeParamInputs = inputs;

        // Highres fix (settings.apiSize): app-only, so it sits under the node params instead
        // of among them
        const row = document.createElement("div");
        row.className = "ipc-seg scumble-api-size";
        const lab = document.createElement("span");
        lab.textContent = "Highres fix";
        lab.title = "How far the crop's resolution is pushed up before it goes to an API provider. A local ComfyUI recipe uses Target instead.";
        row.appendChild(lab);
        const sel = document.createElement("select");
        sel.className = "ipc-sel";
        sel.style.flex = "1"; sel.style.maxWidth = "none"; sel.style.minWidth = "0";
        for (const [id, label, title] of API_SIZES) {
            const opt = document.createElement("option");
            opt.value = id; opt.textContent = label; opt.title = title;
            sel.appendChild(opt);
        }
        sel.value = this.apiSize;
        sel.title = lab.title;
        sel.addEventListener("keydown", (e) => e.stopPropagation());
        sel.addEventListener("change", () => this.setApiSize(sel.value));
        row.appendChild(sel);
        sec.appendChild(row);
        editor._apiSizeSelect = sel;
    },

    /** One value for every open editor: the node params are app settings, not per document. */
    setNodeParam(key, value) {
        this.nodeParams = { ...this.nodeParams, [key]: value };
        window.scumble.settings.set({ nodeParams: this.nodeParams }).catch((err) => console.warn("nodeParams not saved", err));
        for (const ed of this._editors) {
            if (ed._nodeParamInputs && ed._nodeParamInputs[key]) ed._nodeParamInputs[key].value = value;
            ed.renderInfo(); ed.draw();
            this.emit("crop", { editor: ed });
        }
    },

    /** Save an export (the dialog, or `exportPath`) in pieces of SAVE_PIECE; null when the dialog was cancelled. */
    async saveExport(blob, name) {
        markStep("save", "start");   // the K0a harness: the pieces read off the blob and written by main, then the finish
        const file = window.scumble.file;
        const open = await file.saveStart({ name, size: blob.size, path: this.exportPath || undefined });
        if (!open) return null;
        try {
            for (let at = 0; at < blob.size; at += SAVE_PIECE) {
                const data = new Uint8Array(await blob.slice(at, Math.min(blob.size, at + SAVE_PIECE)).arrayBuffer());
                await file.saveWrite({ id: open.id, offset: at, data });
            }
            markStep("save", "pieces", { MB: blob.size / 1048576, pieces: Math.ceil(blob.size / SAVE_PIECE) });
            const saved = await file.saveFinish({ id: open.id });
            markStep("save", "written");
            return saved;
        } catch (err) {
            // the target stays as it was; main has dropped a save whose piece or finish failed already
            file.saveAbort({ id: open.id }).catch(() => {});
            throw err;
        }
    },

    /**
     * An editor changed: autosave every open document (debounced) and refresh the tabs. `info.geometry` (the whole
     * picture was turned, cropped, extended, resized or straightened: `{ kind, m, op, from, to }`, PLAN_0_1_31 §7) goes
     * out first as a "geometry" event, for the plugins that keep image coordinates of their own.
     */
    changed(editor, info) {
        if (editor) editor._stateKey = null;      // changed since the last autosave: counts as changed until it runs (documentDirty)
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this.saveAll(), 1500);
        if (info && info.geometry) this.emit("geometry", { editor, ...info.geometry });
        // the Boxes switch counts the document's boxes: a plugin's data change and its undo come through here
        if (editor && editor.syncBoxesRow) editor.syncBoxesRow();
        // the Each area button follows the selection's separate areas (eacharea.js: counted after a short wait)
        if (editor) { try { areasSoon(this, editor); } catch (err) { console.warn("each area", err); } }
        this.emit("changed", { editor });
    },

    /**
     * The autosave bundle: every open document's state, the active one, the id counter. A document's entry also keeps
     * its .scumble file (`file`), its per-document plugin data (`plugins`) and the fields of an opened newer document
     * this app does not know (`extra`); an older app reads `id` and `state` only (docs/PLAN_DOCUMENTS.md §5.2).
     */
    bundle() {
        const docs = [];
        for (const ed of this._editors) {
            let state = "{}";
            const raw = this._rawStates.get(ed);
            if (raw != null && ed.base) this._rawStates.delete(ed);        // it holds a picture of its own now
            else if (raw != null) { docs.push({ id: ed.node.id, state: raw, ...docMeta(ed, !!(ed.docFile && ed.docFile.clean)) }); continue; }
            try { state = ed.getValue(); } catch (err) { console.warn("getValue", err); }
            if (ed.base) ed._stateKey = hashString(state);      // the dirty marker compares it with the file's (documentDirty)
            docs.push({ id: ed.node.id, state, ...docMeta(ed, !this.documentDirty(ed)) });
        }
        return { version: 2, active: this.editor ? this.editor.node.id : null, nextId: this.nextId, docs, closed: this.closed.slice(-CLOSED_MAX) };
    },

    saveAll() {
        clearTimeout(this._saveTimer);
        if (this._restoring) { this._saveTimer = setTimeout(() => this.saveAll(), 1500); return; }   // see _restoring
        try { window.scumble.state.save(JSON.stringify(this.bundle())).catch(() => {}); } catch (err) { console.warn("autosave", err); }
        if (this.onDocsChanged) { try { this.onDocsChanged(); } catch (err) { console.warn(err); } }
    },

    /**
     * Holders of file refs outside the documents that the clean-up keeps too: functions answering refs (or anything
     * referencedFileKeys walks). The assistant's "Undo this turn" record registers its own (renderer/assistant_turns.js
     * heldRefs): its snapshots put LUTs, plates, maps and fonts back with their files.
     * @type {Array<() => any>}
     */
    fileRefSources: [],

    /**
     * Every file ref ({filename, subfolder, type}) any open document mentions, as mirror keys: its state, its plugin data,
     * and what its undo and redo steps and its named snapshots hold (an undo puts those files back and uploads none of
     * them again: InpaintEditor.heldFileRefs), the closed tabs, and `fileRefSources`.
     */
    referencedFileKeys() {
        const keys = new Set();
        const walk = (v) => {
            if (!v || typeof v !== "object") return;
            if (Array.isArray(v)) { for (const x of v) walk(x); return; }
            if (typeof v.filename === "string") keys.add(`${v.type || "input"}/${v.subfolder || ""}/${v.filename}`);
            for (const x of Object.values(v)) walk(x);
        };
        for (const ed of this._editors) {
            try { walk(JSON.parse(ed.getValue())); } catch (_) { /* empty document */ }
            if (ed.base && ed.base.ref) walk(ed.base.ref);
            walk(ed.pluginData);          // a 3D layer's model file (glb plugin), and whatever else a plugin keeps per document
            walk(ed.docExtra);            // the fields of a newer document this app does not know may name files too
            // the undo and redo steps and the named snapshots: a deleted layer, a flattened or cropped base (not caught: a
            // walk that fails stops the clean-up, which then removes nothing)
            if (typeof ed.heldFileRefs === "function") walk(ed.heldFileRefs());
        }
        // the closed tabs Reopen Closed Tab can bring back
        for (const c of this.closed) {
            try { walk(JSON.parse(c.state)); } catch (_) { /* an empty state */ }
            walk(c.plugins);
            walk(c.extra);
        }
        for (const src of this.fileRefSources) walk(src());   // not caught either
        return Array.from(keys);
    },
};
