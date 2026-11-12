// @ts-check
// runGenerate, prompt templates, brush tips, generate-new hooks, provider runs and their progress: moved out of host.js (item 56 S13, docs/PLAN_SPLIT.md), text unchanged.

import * as genpresets from "./genpresets.js";
import { bytesToImage, canvasBytes, referenceBytes, transparentPixels } from "./stitch.js";
import { refusal } from "./inpaint_status.js";
import { hasTokens, referencesRule, referencesText } from "./reftokens.js";
import { smallBoxes, smallNote } from "./boxes.js";
import { areaState, runEachArea } from "./eacharea.js";
import { runSplitLayers } from "./splitlayers.js";
import { HINT_NOTE, SUBFOLDER, api, notesKind, promptMissing, providerEdit, runIdOf, textOptions, viaLine } from "./host_util.js";

export const HostGeneratePart = {
    /**
     * "Generate new": one call to the provider's text-to-image route, no crop and no mask, and the answer becomes the
     * document's base image. The recipe variant's `text` shape says which model id does that at this provider
     * (docs/RECIPES.md). With `text.refs` the shown reference layers go along (docs/PLAN_REFS.md 26f): each @img token
     * is written as the route's name for its picture ("image 1": there is no crop before them), a variant may send them
     * to another route (`text.refs.model`), and the reference layers stay in the tab over the new base. A variant
     * without it makes pictures from the prompt alone: a token there refuses the run. `opts.refs`: the click's snapshot
     * (refSnapshot), else the references of now; `opts.prompt` / `opts.negative` replace its texts.
     */
    async runGenerate(editor, opts = {}) {
        const r = this.recipe;
        if (!r || r.kind !== "provider") throw new Error("Pick an API recipe first.");
        const t = r.text;
        if (!t || !t.model) throw new Error(`${r.providerLabel || r.provider} cannot make an image from the prompt alone for this model.`);
        const label = r.providerLabel || r.provider;
        // the answer replaces the base: not while a job would land in the picture it replaces
        const blocked = this.generateNewBlocked(editor);
        if (blocked) throw refusal(blocked);
        const width = Math.max(64, Math.round(opts.width || editor.width || 1024));
        const height = Math.max(64, Math.round(opts.height || editor.height || 1024));
        // the frame the plugins' image coordinates (the boxes) are measured in: the answer may come back at another size
        const drawnOn = { width: editor.width || 0, height: editor.height || 0 };
        // the prompt and the references of the click; a token that cannot go refuses before anything is sent
        const base = opts.refs || editor.refSnapshot();
        const snap = { ...base, prompt: opts.prompt != null ? String(opts.prompt) : base.prompt, negative: opts.negative != null ? String(opts.negative) : base.negative };
        const noWords = promptMissing(r, snap.prompt);
        if (noWords) throw refusal(noWords);
        const takes = !!(this.refTokens && t.refs);
        // a model that sends no picture: the tab's negative (which the dialog neither shows nor sends) gets its tokens
        // written as layer names, as before 26f; only the prompt's tokens refuse
        const neg = takes || !this.refTokens ? null : this.refPrompt(editor, snap, "none", { prompt: "", negative: snap.negative, who: "Generate new" });
        const named = this.refPrompt(editor, neg ? { ...snap, negative: neg.negative } : snap, "edit", { sent: takes ? snap.refIds : null, who: "Generate new" });
        if (!takes && this.refTokens && hasTokens(named.prompt)) {
            throw new Error(`${r.name || r.id} on ${label} makes new images from the prompt alone: take the @img tokens out, or pick a model that takes reference images for a new image (FLUX.2, GPT Image, Nano Banana, Seedream).`);
        }
        const refIds = takes ? snap.refIds : [];
        const tr = t.refs || {};
        // a Comfy Cloud graph's LoRA rows (item 50) go with the text route's own declaration (recipes.js text.loras)
        const cloudLoras = this.cloudLoraRows(r);
        editor.lastLoras = [];
        const token = { provider: r.provider, label, started: Date.now(), editor, runId: runIdOf() };
        editor.providerPending = token;
        this._providerRuns.add(token);
        this.notifyProviderRuns();
        const genParams = { ...this.providerParams(editor, opts.background ? { background: opts.background } : null), ...(t.fixed || {}) };
        const cutout = this.wantsTransparent(genParams);
        let res, request, references = [];
        const preNotes = [];
        try {
            // the pixels are read now, before the first await (referenceBytes)
            references = refIds.length ? await referenceBytes(editor, refIds) : [];
            const withRefs = references.length > 0;
            editor.setStatus(`Asking ${label} for a new ${width} × ${height} image${withRefs ? ` with ${references.length} reference image${references.length > 1 ? "s" : ""}` : ""}${cutout ? " on a transparent ground" : ""} ...`);
            const model = (withRefs && tr.model) || t.model;
            // the text route's own options where it has them (a Comfy Cloud recipe's text-to-image graph, item 35 V6),
            // else the variant's (textOptions: the Generate new dialog reads the same rule)
            const options = textOptions(r, withRefs);
            // the plugins' boxes (item 28 S2) when the variant takes them and the document's Boxes switch is on (S3d): a
            // new image has no selection, so the boxes come from scumble.generate sources alone, drawn on the document
            // (the frame; the new image is made at the requested size, so the fractions carry over, stretched when the
            // aspect differs)
            let boxes = [];
            const takes = !!(options && typeof options.boxes === "string");
            const held = takes && this.plugins ? this.plugins.countBoxes(editor) : 0;
            if (takes && !editor.genSettings.boxes && held) preNotes.push(`The document's ${held} box${held === 1 ? "" : "es"} did not go: the Boxes switch under the prompt is off.`);
            if (takes && editor.genSettings.boxes && this.plugins) {
                const frame = { x: 0, y: 0, w: editor.width || width, h: editor.height || height };
                const got = await this.plugins.boxes(editor, this.boxContext(editor, { mode: "new", recipe: r, provider: r.provider, model, schema: options.boxes, frame, bounds: null, sent: refIds }), []);
                boxes = got.boxes;
                preNotes.push(...got.notes);
                const small = smallNote(smallBoxes(got.boxes, [width, height]));
                if (small) preNotes.push(small);
                // the boxes are fractions of the document: an asked shape other than its own stretches them (item 34;
                // the dialog says the same under its aspect)
                const stretched = boxes.length ? genpresets.stretchNote([drawnOn.width, drawnOn.height], [width, height], genpresets.aspectsOf(r), opts.aspect || null) : "";
                if (stretched) preNotes.push(stretched);
            }
            request = {
                provider: r.provider, model, kind: "text",
                prompt: named.prompt, negative: named.negative,
                seed: opts.seed != null ? opts.seed : editor.genSettings.seed,
                width, height, aspect: opts.aspect || null,
                image: null, mask: null, maskAlpha: null, references, original: 0,
                refName: tr.name || (r.refs && r.refs.name) || null, refsMax: withRefs ? tr.max || null : null,
                fields: r.fields || null, options,
                params: genParams,
                boxes,
                ...(cloudLoras ? { loras: { rows: cloudLoras, declared: t.loras } } : {}),
            };
            res = await providerEdit(request, token);
            editor.lastLoras = Array.isArray(res.loras) ? res.loras : [];
        } catch (err) {
            this.endRun(editor, token);
            throw err;
        } finally {
            this.endRunRow(token);
        }
        // the document stays held until the new base is in (endRun)
        let c, swap;
        try {
            const img = await bytesToImage(res.bytes, res.mime);
            c = document.createElement("canvas");
            c.width = img.naturalWidth || img.width;
            c.height = img.naturalHeight || img.height;
            c.getContext("2d").drawImage(img, 0, 0);
            // the reference layers stay (they name what the prompt refers to), every other layer goes with the old base
            swap = await editor.setBaseFromCanvas(c, { keepRefs: true });
        } finally {
            this.endRun(editor, token);
        }
        // a model that rounds or tiers the size (FLUX 3's 4k tier answers 5456 x 3072 for 4096 x 2304) lands a picture of
        // another size: what the plugins keep in image coordinates follows it, as after a resize (the boxes were fractions
        // of the frame for the model, so they still are). Generate new clears the undo history, so there is no step to share
        if (drawnOn.width > 0 && drawnOn.height > 0 && (c.width !== drawnOn.width || c.height !== drawnOn.height)) {
            this.changed(editor, { geometry: { kind: "resize", m: [c.width / drawnOn.width, 0, 0, c.height / drawnOn.height, 0, 0], from: drawnOn, to: { width: c.width, height: c.height } } });
        }
        const gotAlpha = cutout && transparentPixels(c);
        const notes = [...preNotes, ...(res.notes || [])];
        const sentAs = named.pairs.map((p) => {
            const got = (res.refs || []).find((x) => x.ref === p.ref);
            return got ? `${p.label} → ${got.name}` : null;
        }).filter(Boolean);
        const kept = swap && swap.kept ? swap.kept : 0, dropped = swap && swap.dropped ? swap.dropped : 0;
        const stay = kept ? ` The reference layer${kept > 1 ? "s stay" : " stays"}${dropped ? `, ${dropped} other layer${dropped > 1 ? "s were" : " was"} replaced` : ""}.` : "";
        const sentBoxes = res.boxes > 0 ? Math.floor(res.boxes) : 0;
        editor.setStatus(`${label} answered after ${Math.round(res.seconds)} s: a new ${c.width} × ${c.height} base image${cutout ? (gotAlpha ? " with a transparent background" : " (the model returned no transparency)") : ""}.${sentAs.length ? ` Named in the prompt: ${sentAs.join(", ")}.` : ""}${sentBoxes ? ` Sent with ${sentBoxes} box${sentBoxes === 1 ? "" : "es"}.` : ""}${stay}${notes.length ? " " + notes.join(" ") : ""}`, (cutout && !gotAlpha) || notes.some((n) => !HINT_NOTE.test(String(n))) ? "warn" : "info");
        const labels = snap.labels;
        return {
            provider: r.provider, model: request.model, seconds: res.seconds, width: c.width, height: c.height, transparent: !!gotAlpha,
            prompt: res.prompt != null ? res.prompt : named.prompt, note: notes.join(" "), notes, info: res.info || null, boxes: sentBoxes,
            loras: editor.lastLoras,
            references: refIds.map((id, i) => {
                const got = (res.refs || []).find((x) => x.ref === i);
                return { label: "img" + labels.get(id), id, sentAs: got ? got.name : null };
            }),
            kept, dropped,
        };
    },

    // ---- prompt instruction templates (electron/main/prompts.js) -------------------

    promptTemplates: [],          // [{ id, name, description, use, for, body, source }]
    promptTemplateIds: { upsample: "", generate: "" },   // "" = the built-in rule

    // ---- brush tips: one library for every tab, stored as PNGs by electron/main/brushes.js ------
    brushLibrary: [],       // { id, name, canvas, spacing, source, saved } - the editors' brushTips array itself
    /** @type {Promise<any> | null} the save in flight (saveBrushTips: one at a time) */
    _brushSave: null,

    /** Load the stored tips into the shared library (once, at start). */
    async loadBrushTips() {
        if (!window.scumble || !window.scumble.brushes) return this.brushLibrary;
        let stored = [];
        try { stored = await window.scumble.brushes.list(); } catch (err) { console.warn("brush tips not loaded", err); this.brushTipsUnread = true; return this.brushLibrary; }
        for (const t of stored) {
            try {
                const img = await new Promise((resolve, reject) => {
                    const url = URL.createObjectURL(new Blob([t.png], { type: "image/png" }));
                    const im = new Image();
                    im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
                    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad tip file " + t.id)); };
                    im.src = url;
                });
                const c = document.createElement("canvas");
                c.width = img.naturalWidth; c.height = img.naturalHeight;
                c.getContext("2d").drawImage(img, 0, 0);
                this.brushLibrary.push({ id: t.id, name: t.name, canvas: c, spacing: t.spacing || 0, source: t.source || "", saved: true });
            } catch (err) { console.warn(err); }
        }
        for (const ed of this._editors) this.syncBrushTips(ed);
        return this.brushLibrary;
    },

    /** Hand an editor the shared library and the save hook (called for every new tab). */
    attachBrushTips(editor) {
        editor.brushTips = this.brushLibrary;
        editor.onBrushTips = () => this.saveBrushTips(editor);
        this.syncBrushTips(editor);
    },

    syncBrushTips(editor) {
        if (editor.brushTips !== this.brushLibrary) editor.brushTips = this.brushLibrary;
        if (editor.renderBrushTips) editor.renderBrushTips();
        if (editor.syncTipControls) editor.syncTipControls();
    },

    /**
     * Persist the library (new tips as PNG, the index always) and refresh the other tabs' selects. One save at a time:
     * main's save deletes every file its list does not hold, so two at once could delete a tip the other just wrote; a
     * save asked while one runs goes after it, with the library as it is then.
     */
    saveBrushTips(from) {
        const prev = this._brushSave || Promise.resolve();
        const run = prev.catch(() => {}).then(() => this._saveBrushTipsNow(from));
        this._brushSave = run;
        return run;
    },

    async _saveBrushTipsNow(from) {
        if (!window.scumble || !window.scumble.brushes) return null;
        // the stored list was not read this session: saving this library would delete every stored tip (brushes.js save)
        if (this.brushTipsUnread) { console.warn("brush tips: the stored list was not read, nothing is saved"); return null; }
        const tips = [], written = [];
        // over a copy: a tip removed or added while the PNGs are made does not shift this list (the next save takes it)
        for (const t of [...this.brushLibrary]) {
            let png = null;
            if (!t.saved) {
                const blob = await new Promise((resolve) => t.canvas.toBlob(resolve, "image/png"));
                png = new Uint8Array(await blob.arrayBuffer());
                written.push(t);
            }
            tips.push({ id: t.id, name: t.name, spacing: t.spacing || 0, source: t.source || "", png });
        }
        const r = await window.scumble.brushes.save(tips);
        // only the tips whose PNG went in this save are on disk now (one added meanwhile is not)
        for (const t of written) t.saved = true;
        for (const ed of this._editors) if (ed !== from) this.syncBrushTips(ed);
        return r;
    },

    async refreshPromptTemplates() {
        try { this.promptTemplates = await window.scumble.prompts.list(); }
        catch (err) { console.warn("prompt templates", err); this.promptTemplates = []; }
        return this.promptTemplates;
    },

    /** The templates that apply to a use ("upsample" / "generate") and the current recipe. */
    promptTemplatesFor(use) {
        const r = this.recipe || {};
        const hay = `${r.id || ""} ${r.name || ""} ${r.family || ""} ${r.model || ""}`.toLowerCase();
        return this.promptTemplates.filter((t) => !t.error && (t.use === "both" || t.use === use) && (!t.for.length || t.for.some((f) => hay.includes(f))));
    },

    /**
     * Fill the placeholders; the output rule is the app's, never the template's. `ctx.references`: the references the
     * prompt names (`[{ id, n, name }]`, docs/PLAN_REFS.md 26d1); with any, the token rule follows the output rule, and a
     * template without `{references}` gets the names there too.
     */
    fillPromptTemplate(tpl, ctx) {
        const refs = ctx.references || [];
        const values = {
            prompt: ctx.prompt || "", model: (this.recipe && (this.recipe.model || this.recipe.name)) || "",
            aspect: ctx.aspect || "", width: ctx.width || "", height: ctx.height || "",
            usecase: ctx.useCase || "", useCase: ctx.useCase || "", region: ctx.region || "the whole image",
            hint: ctx.hint ? ` It currently shows: ${ctx.hint}.` : "",
            references: referencesText(refs),
        };
        const src = String(tpl.body || "");
        const body = src.replace(/\{(\w+)\}/g, (all, k) => (values[k] !== undefined ? String(values[k]) : all));
        const own = refs.length ? "\n\n" + (/\{references\}/.test(src) ? "" : referencesText(refs).trim() + " ") + referencesRule(refs) : "";
        return `${body}\n\nOutput only the prompt text: no preamble, no quotes, no headings, no explanation.${own}`;
    },

    /** Called by the editor instead of its built-in rule when a template is chosen. */
    upsampleInstruction(ctx) {
        const id = this.promptTemplateIds.upsample;
        if (!id) return null;
        const tpl = this.promptTemplates.find((t) => t.id === id);
        if (!tpl || tpl.error) return null;
        return this.fillPromptTemplate(tpl, ctx);
    },

    /** Whether the editor should show the "Generate new" button at all. */
    generateNewAvailable() {
        return !!(this.shell && this.shell.openGenerateNew);
    },

    openGenerateNew(editor) {
        if (this.shell && this.shell.openGenerateNew) this.shell.openGenerateNew(editor);
    },

    /**
     * New with a model (item 34, docs/PLAN_NEW_PRESETS.md section 8): the models that make a new image with their
     * providers' aspects and size classes ({ models, pick, working(aspect, size) }, the shell's newCanvasChoices), or
     * null without the shell (the dialog then asks for width and height only). The node's host answers null.
     */
    newCanvasChoices(editor) {
        return this.shell && this.shell.newCanvasChoices ? this.shell.newCanvasChoices(editor) : null;
    },

    /**
     * New made a canvas for a preset ({ recipe, provider, aspect, size, width, height }, stored by the editor as
     * `genSettings.target`): the shell remembers it for the next New and selects the recipe (app-wide). Null after a New
     * of a size given by hand: the next New opens on "Any size".
     */
    async newCanvasChosen(editor, target) {
        if (this.shell && this.shell.newCanvasChosen) await this.shell.newCanvasChosen(editor, target);
    },

    /** Store a result patch in the mirror's output folder (where the node's stitch writes its results). */
    async uploadResult(blob, filename) {
        const form = new FormData();
        form.append("image", new File([blob], filename, { type: "image/png" }));
        form.append("subfolder", SUBFOLDER);
        form.append("type", "output");
        const resp = await api.fetchApi("/upload/image", { method: "POST", body: form });
        if (resp.status !== 200) throw new Error("storing the result failed (" + resp.status + ")");
        const data = await resp.json();
        return { filename: data.name, subfolder: data.subfolder || SUBFOLDER, type: data.type || "output" };
    },

    _providerRuns: new Set(),
    onProviderRuns: null,   // set by the shell: (runs: [{provider, label, started, editor}]) => void

    /** The title row's Cancel: stop waiting for every API run in progress (main aborts them; each says so in its tab). */
    cancelProviderRuns() {
        return this.cancelRuns(null).length;
    },

    /**
     * Cancel the runs in the title row (API runs, and the picture runs on the user's ComfyUI that hold a document: the
     * pass, an upscale of the whole picture, whose job is taken off the server), every tab's or only `editor`'s
     * (the cancel_run command, docs/PLAN_0_1_42.md F2a). Returns the tokens it cancelled.
     */
    cancelRuns(editor) {
        const runs = Array.from(this._providerRuns).filter((t) => !editor || t.editor === editor);
        for (const t of runs) t.cancelled = true;
        // Each area (eacharea.js): the areas not yet sent never go
        for (const ed of this._editors) if (ed._eachArea && (!editor || ed === editor)) ed._eachArea.cancelled = true;
        for (const t of runs) if (t.runId && window.scumble && window.scumble.providers && window.scumble.providers.cancel) window.scumble.providers.cancel(t.runId).catch(() => {});
        return runs;
    },

    /**
     * Generate each separate area of the selection on its own (item 54, eacharea.js runEachArea): the button's click and
     * the generate command's `each_area`. `confirm`: ask before an API run (the command does not).
     */
    generateEachArea(editor, opts = {}) {
        return runEachArea(this, editor, { ...opts, api });
    },

    /**
     * Split the visible picture or a layer into layers on the recipe's host with a layer mode (splitlayers.js): `opts` { recipe, layer (null:
     * the picture), prompt, count, textRecognition, size }. The new layers land above everything, in one group, one undo step.
     */
    splitLayers(editor, opts = {}) {
        return runSplitLayers(this, editor, opts, { providerEdit, canvasBytes, bytesToImage, viaLine, runIdOf });
    },

    /** Why a run of recipe `r` with this prompt is refused before anything is made (promptRequired), or "" (Each area asks it before its question). */
    promptRefusal(r, prompt) {
        return promptMissing(r, prompt);
    },

    /** The kind of a line that carries a run's notes: red when a note says something was left out (Each area's final line). */
    runNotesKind(editor, notes) {
        return notesKind(editor, notes);
    },

    /** The selection's separate areas for the status command (eacharea.js areaState): counted now when they are not. */
    selectionAreas(editor) {
        return areaState(this, editor);
    },

    /** The runs in the title row that hold `editor` (its close stops them, removeEditor). */
    runsOf(editor) {
        return Array.from(this._providerRuns).filter((t) => t.editor === editor);
    },

    /** A run's answer is in (or it failed): its timer and Cancel leave the title row, its live steps the bar. */
    endRunRow(token) {
        if (!this._providerRuns.delete(token)) return;
        if (token.live && token.editor && token.editor.runProgress) token.editor.runProgress.done(String(token.runId));
        this.notifyProviderRuns();
    },

    /**
     * A provider run's live progress (Comfy Cloud's events through main's `provider:progress`, docs/PLAN_COMFY_SDK.md
     * 3.5 and section 4): its document's bar shows it under the run's label. A frame with a status alone keeps the
     * timer; the first with a share starts the run; sampler steps (should a provider send them) go in as ComfyUI's
     * events, a share alone as `fraction` (node k of n, the running node's part). A local prompt that runs in the
     * same tab keeps the bar, the provider's run beside it (RunProgress).
     */
    providerProgress(p) {
        const id = p && p.runId ? String(p.runId) : "";
        if (!id) return;
        const token = Array.from(this._providerRuns).find((t) => t.runId === id);
        if (!token || token.cancelled) return;
        const ed = token.editor;
        if (!ed || !ed.runProgress || !this._editors.includes(ed)) return;
        if (token.promptId !== id) { token.promptId = id; this.syncRunBars(); }
        token.live = true;
        const share = p.value != null || p.nodesTotal != null;
        const stepped = p.step != null && +p.steps > 0;
        // a status alone (queued, running, the end) leaves the bar to the run's timer: a "running" taken as a start
        // would take the bar from a local prompt that runs in the same tab
        if (!share && !stepped) return;
        const rp = ed.runProgress;
        if (!rp.has(id)) this.trackRun(ed, id, +p.nodesTotal || 1);
        if (p.node != null && String(p.node) !== token.liveNode) { token.liveNode = String(p.node); rp.event("executing", { prompt_id: id, node: token.liveNode }); }
        if (stepped) rp.event("progress", { prompt_id: id, node: p.node != null ? String(p.node) : token.liveNode, value: +p.step, max: +p.steps });
        else if (share) rp.event("fraction", { prompt_id: id, value: p.value, nodes_done: p.nodesDone, nodes_total: p.nodesTotal });
    },

    /** The ids of the provider runs whose live steps a bar shows: the local ComfyUI's queue knows nothing of them. */
    liveRunIds() {
        const ids = new Set();
        for (const t of this._providerRuns) if (t.live && t.runId) ids.add(String(t.runId));
        return ids;
    },

    /**
     * A run is over: the document's slot (`providerPending`) is given back. An API run holds it past its answer until
     * the result has landed, so a second run, a turn or a Realism Pass started meanwhile does not read or land in the
     * picture before it.
     */
    endRun(editor, token) {
        if (editor.providerPending === token) editor.providerPending = null;
        this.endRunRow(token);
    },

    /**
     * Why Generate new cannot replace the document's picture now (a job would land in the picture it replaces), or "".
     * The API route (runGenerate) and the local one (the generate_new command, before its newCanvas) both ask it.
     */
    generateNewBlocked(editor) {
        // Each area (eacharea.js): its areas were cut from this picture, and the next one goes soon
        if (editor._eachArea) return "Each area is running on this document: its areas would land in the picture Generate new replaces. Wait for it, or stop it.";
        if (editor._localRuns && editor._localRuns.size) return "A render on your ComfyUI is still running: its result would land in the picture Generate new replaces. Try again when it is in.";
        if (editor.providerPending || editor.segmentPending || editor.cutoutPending || editor.objectsPending || editor._pointPending || editor._loading || editor._docSaving) {
            return "Wait for the running job to finish: it would land in the picture Generate new replaces.";
        }
        return "";
    },

    notifyProviderRuns() {
        if (this.onProviderRuns) { try { this.onProviderRuns(Array.from(this._providerRuns)); } catch (err) { console.warn(err); } }
        this.syncRunBars();
    },

    /** The status row's bar of each document: the seconds of the run it waits for (docs/PLAN_0_1_48.md S3). */
    syncRunBars() {
        const runs = Array.from(this._providerRuns);
        for (const ed of this._editors) {
            if (!ed.runProgress) continue;
            const t = runs.find((r) => r.editor === ed);
            ed.runProgress.timer(t ? { label: t.label, started: t.started, promptId: t.promptId || null } : null);
        }
    },

    // ---- the status row's bar: ComfyUI's events for the prompts a document queued (docs/PLAN_0_1_48.md S3) ----

    /** A prompt the document queued: its bar follows it; events that came before the queue answered are replayed. */
    trackRun(editor, promptId, nodes) {
        if (!editor || !editor.runProgress || !promptId || !this._editors.includes(editor)) return;
        editor.runProgress.track(promptId, nodes);
        const early = this._earlyProgress && this._earlyProgress.get(String(promptId));
        if (early) {
            this._earlyProgress.delete(String(promptId));
            for (const [type, detail] of early.events) editor.runProgress.event(type, detail);
        }
    },

    /**
     * How many nodes ComfyUI runs of an API-format prompt: the output nodes (the server's object_info says which) and
     * what they read, so a node left without a reader (a reference slot this run does not fill) is not counted. All of
     * them when the server's node list is not known.
     */
    runNodeCount(prompt) {
        const ids = Object.keys(prompt || {});
        const info = this.objectInfo;
        if (!info) return ids.length;
        const roots = ids.filter((id) => { const n = prompt[id]; const d = n && info[n.class_type]; return !!(d && d.output_node); });
        if (!roots.length) return ids.length;
        const seen = new Set(), stack = roots.slice();
        while (stack.length) {
            const id = stack.pop();
            if (seen.has(id) || !prompt[id]) continue;
            seen.add(id);
            for (const v of Object.values(prompt[id].inputs || {})) if (Array.isArray(v) && v.length === 2 && prompt[String(v[0])]) stack.push(String(v[0]));
        }
        return seen.size || ids.length;
    },

    /**
     * A tracked prompt that waits while others run can leave the queue without an event (deleted in ComfyUI's queue,
     * a lost end event): on a status with jobs left, /queue is read (at most every 2 s) and what it no longer holds
     * goes from the bars.
     */
    async checkTrackedRuns() {
        // a provider's run (Comfy Cloud) is not in this server's queue: it is left to its own end
        const live = this.liveRunIds();
        const tracked = this._editors.filter((e) => e.runProgress && (Array.from(e.runProgress.runs.keys()).some((id) => !live.has(id)) || e.runProgress.dropped.size));
        if (!tracked.length || this._checkingRuns || Date.now() - (this._runsChecked || 0) < 2000) return;
        this._checkingRuns = true;
        this._runsChecked = Date.now();
        try {
            const r = await api.fetchApi("/queue", { signal: AbortSignal.timeout(15000) });
            if (r.status !== 200) return;
            const q = await r.json();
            const held = new Set([...(q.queue_running || []), ...(q.queue_pending || [])].filter(Array.isArray).map((it) => String(it[1])));
            for (const ed of tracked) {
                for (const id of Array.from(ed.runProgress.runs.keys())) {
                    if (live.has(id)) continue;
                    // a prompt queued a moment ago may not be listed yet
                    if (!held.has(id) && Date.now() - ed.runProgress.runs.get(id).tracked > 3000) ed.runProgress.done(id);
                }
                // a prompt a lost socket or a stale "queue empty" dropped shows again while the queue holds it, however
                // long the socket was away; one the queue no longer holds is forgotten
                for (const id of Array.from(ed.runProgress.dropped.keys())) {
                    if (held.has(id)) ed.runProgress.revive(id);
                    else ed.runProgress.dropped.delete(id);
                }
            }
        } catch (_) { /* the server did not answer: the next status asks again */ } finally {
            this._checkingRuns = false;
        }
    },

    /** One of ComfyUI's progress events: to the document that waits for its prompt, or held a few seconds for one. */
    progressEvent(type, detail) {
        const id = detail && detail.prompt_id != null ? String(detail.prompt_id) : null;
        if (!id) return;
        // wants(): a prompt a stale "queue empty" or a lost socket dropped from the bar takes it back with its own events
        const ed = this._editors.find((e) => e.runProgress && e.runProgress.wants(id));
        if (ed) { ed.runProgress.event(type, detail); return; }
        // the POST's answer (the prompt id) can come after the first events of a fast prompt
        if (!this._earlyProgress) this._earlyProgress = new Map();
        const now = Date.now();
        for (const [k, v] of this._earlyProgress) if (now - v.at > 10000) this._earlyProgress.delete(k);
        let e = this._earlyProgress.get(id);
        if (!e) { if (this._earlyProgress.size >= 32) return; e = { at: now, events: [] }; this._earlyProgress.set(id, e); }
        if (e.events.length < 256) e.events.push([type, detail]);
    },

    // ---- a picture in, a picture out on the user's ComfyUI (docs/PLAN_0_1_42.md R2a; the pass, U2's upscale) ----

    /** The mirror's ensure behind a host member: a gate stubs it (window.scumble is read-only from the page). */
    async ensureRefs(refs) {
        return window.scumble.comfy.ensure(refs);
    },

    /**
     * Store a picture in the mirror's input folder and make sure the server holds it: the mirror's forward can fail with
     * a warning only, so the ensure is not optional. -> { filename, subfolder, type: "input" }
     */
    async uploadInput(blob, filename) {
        const form = new FormData();
        form.append("image", new File([blob], filename, { type: "image/png" }));
        form.append("subfolder", SUBFOLDER);
        form.append("type", "input");
        const resp = await api.fetchApi("/upload/image", { method: "POST", body: form });
        if (resp.status !== 200) throw new Error("storing the picture failed (" + resp.status + ")");
        const data = await resp.json();
        const ref = { filename: data.name, subfolder: data.subfolder || SUBFOLDER, type: "input" };
        const key = `${ref.type}/${ref.subfolder || ""}/${ref.filename}`;
        let report;
        try { report = await this.ensureRefs([ref]); } catch (err) { throw new Error(`Your ComfyUI did not take the picture: ${String((err && err.message) || err)}`); }
        if (report && report.missing && report.missing.length) throw new Error("Your ComfyUI did not take the picture.");
        if (report && report.renamed && report.renamed[key]) ref.filename = report.renamed[key];
        return ref;
    },
};
