// @ts-check
// the reference prompt and layout, the Comfy plan, boxContext, runProvider: moved out of host.js (item 56 S13, docs/PLAN_SPLIT.md), text unchanged.

import * as realism from "./realism.js";
import { finishResultAsync, prepareCropAsync } from "./stitch.js";
import { refusal } from "./inpaint_status.js";
import { hasTokens, namesFor, parse, remap, toMarkers } from "./reftokens.js";
import { comfyLayout, comfyRefSpec, refName, resolveMarkers as resolveComfyMarkers } from "./comfyrefs.js";
import { SMALL_PX, frameOf, selectionBox, smallBox, smallBoxes, smallNote } from "./boxes.js";
import { areaHint, sameRecipe } from "./eacharea.js";
import { AREA_RECIPE_CHANGED, AREA_STOPPED_API, NOT_SENT, RUN_GOING, answeredSeed, listWords, notesKind, promptMissing, providerEdit, runIdOf, sentTexts, viaLine } from "./host_util.js";

export const HostProviderPart = {
    // ---- @img tokens at send time (docs/PLAN_REFS.md C3) ------------------------------------

    /**
     * The prompt and the negative of a run with their @img tokens made fit for its route, from the click's snapshot
     * `snap` (`editor.refSnapshot()`; the texts default to its own):
     * - "edit": each token becomes a marker {@ref:i}, i = its layer's index in `sent` (the order of the request's
     *   references, null for the Original), which main turns into the route's own name for the picture; `sent` null
     *   only checks that every token can be sent. `pairs` lists [{ label, id, ref }] for the status line.
     * - "none": a run that sends no reference picture (an upscale, Generate new): each token is written as its layer's
     *   name, in the request text only; `note` says so, `who` names the run in it.
     * - "comfy": a local ComfyUI recipe (26e): `comfy` = { spec, lay } of comfyrefs.js (the recipe's names and slots, the
     *   run's batch); each token becomes the name the graph gives its picture ("<image3>", "image 3") right here, and
     *   a token for a reference past the recipe's slots refuses. `pairs` also carry that `name`.
     * A token that cannot go refuses the run with the reason and what to do.
     * @param {any} editor
     * @param {{ prompt: string, negative: string, refIds: string[], labels: Map<string, number> } | null} snap
     * @param {"edit" | "none" | "comfy"} route
     * @param {{ prompt?: string, negative?: string, sent?: (string | null)[] | null, who?: string, recipe?: any, comfy?: { spec: any, lay: any } | null }} [opts]
     * @returns {{ prompt: string, negative: string, note: string, pairs: { label: string, id: string, ref: number, name?: string | null }[] }}
     */
    refPrompt(editor, snap, route, { prompt, negative, sent = null, who = "This run", recipe = null, comfy = null } = {}) {
        const s = snap || editor.refSnapshot();
        const texts = { prompt: String(prompt != null ? prompt : s.prompt || ""), negative: String(negative != null ? negative : s.negative || "") };
        const out = { prompt: texts.prompt, negative: texts.negative, note: "", pairs: [] };
        if (!this.refTokens) return out;
        const where = (k) => (k === "negative" ? "The negative prompt" : "The prompt");
        for (const k of ["prompt", "negative"]) if (/\{@ref:/i.test(texts[k])) throw refusal(`${where(k)} holds "{@ref:", which Scumble keeps for itself: reword it.`);
        const idOf = new Map([...s.labels].map(([id, n]) => [n, id]));
        if (route === "none") {
            const replaced = [];
            for (const k of ["prompt", "negative"]) {
                const res = namesFor(texts[k], (key) => {
                    const id = key[0] === "?" ? key.slice(1) : idOf.get(+key.slice(3));
                    const l = id && editor.layers.find((x) => x.id === id);
                    return l ? l.name || "" : null;
                });
                if (res.missing.length) throw refusal(this.refError(editor, s, parse(res.missing[0])[0], k));
                out[k] = res.text;
                for (const x of res.replaced) if (!replaced.some((y) => y.token === x.token)) replaced.push(x);
            }
            if (replaced.length) {
                const tokens = listWords(replaced.map((x) => x.token)), names = listWords(replaced.map((x) => `"${x.name}"`));
                out.note = replaced.length === 1
                    ? `${who} sends no reference images: ${tokens} was written as its layer name ${names}.`
                    : `${who} sends no reference images: ${tokens} were written as their layer names ${names}.`;
            }
            return out;
        }
        // a comfy run's markers index the pictures its graph reads: the Original when it goes, then the kept references
        const lay = route === "comfy" && comfy ? comfy.lay : null;
        const ids = lay ? [...Array(lay.original).fill(null), ...s.refIds.slice(0, lay.kept)] : sent;
        for (const k of ["prompt", "negative"]) {
            // a parked token typed or pasted for a layer that has a label now names it (remap from the labels to themselves)
            texts[k] = remap(texts[k], s.labels, s.labels);
            const res = toMarkers(texts[k], s.labels, ids);
            if (res.errors.length) {
                const e = res.errors[0];
                if (lay && e.kind === "unsent") throw new Error(this.slotsError(recipe || this.recipe || {}, comfy.spec, lay, s, e.token));
                throw refusal(this.refError(editor, s, { type: "token", text: e.token, n: e.n, id: e.kind === "parked" ? e.id : undefined, kind: e.kind }, k));
            }
            out[k] = res.text;
            for (const seg of parse(texts[k])) {
                if (seg.type !== "token" || !("n" in seg)) continue;
                const id = idOf.get(seg.n), label = "@img" + seg.n;
                if (id && !out.pairs.some((p) => p.label === label)) out.pairs.push({ label, id, ref: ids ? ids.indexOf(id) : -1 });
            }
        }
        if (!lay) return out;
        // the names, as the node batches the pictures and the graph's encoder numbers them (comfyrefs.js)
        for (const k of ["prompt", "negative"]) {
            const res = resolveComfyMarkers(out[k], lay.pictures, comfy.spec.name);
            if (res.left.length || /\{@ref:/i.test(res.text) || hasTokens(res.text)) throw new Error(`${where(k)} names a picture ${(recipe || this.recipe || {}).name || "this recipe"} does not read: take the token out.`);
            out[k] = res.text;
        }
        for (const p of out.pairs) {
            const pic = lay.pictures.find((x) => x.ref === p.ref);
            p.name = pic ? refName(comfy.spec.name, pic.n) : null;
        }
        return out;
    },

    /**
     * Why a token past a local recipe's slots cannot go (26e): what the graph reads, and the three ways out.
     * @param {any} r the recipe
     * @param {{ slots: number | null }} spec
     * @param {{ original: number, kept: number }} lay
     * @param {{ refIds: string[], labels: Map<string, number> }} snap
     * @param {string} token
     */
    slotsError(r, spec, lay, snap, token) {
        const tok = String(token || "").replace(/^@img/i, "@img");
        const who = r.name || r.id || "this recipe";
        if (spec.slots === 1) return `${tok} cannot be named: ${who} reads the crop alone, its graph takes no reference picture. Take ${tok} out.`;
        const read = ["the crop", ...(lay.original ? ["the Original"] : []), ...snap.refIds.slice(0, lay.kept).map((id) => "img" + snap.labels.get(id))];
        // only the ways that make room: hiding a reference needs one that goes, Original off needs the Original
        const ways = [...(lay.kept > 0 ? ["hide a reference"] : []), ...(lay.original ? ["turn Original off"] : []), `take ${tok} out`];
        const say = ways.length === 1 ? ways[0] : `${ways.slice(0, -1).join(", ")}, or ${ways[ways.length - 1]}`;
        return `${tok} cannot be named: ${who} reads ${spec.slots} pictures (${listWords(read)}). ${say.charAt(0).toUpperCase()}${say.slice(1)}.`;
    },

    /** Why a token cannot go (refPrompt): `seg` a token segment of `parse`, `k` which text holds it. */
    refError(editor, snap, seg, k) {
        const where = k === "negative" ? "The negative prompt" : "The prompt";
        const tok = String(seg.text || "").replace(/^@img/i, "@img");
        const count = snap.labels.size;
        if (seg.kind === "unsent") return `${tok} is not among the pictures this run sends: take it out of the ${k === "negative" ? "negative prompt" : "prompt"}.`;
        if (seg.id == null) {
            const has = count === 0 ? "has none; add a reference layer first" : count === 1 ? "has @img1 only" : `has @img1 to @img${count}`;
            return `${tok} names no reference image: this document ${has}.`;
        }
        const l = editor.layers.find((x) => x.id === seg.id);
        if (!l) return `${where} names a deleted reference (${tok}): undo the delete, or take the token out.`;
        if (!editor.isReference(l)) return `${where} names "${l.name}" (${tok}), which is no longer a reference layer: make it a reference again, or take the token out.`;
        return `${where} names "${l.name}" (${tok}), a hidden reference: show it in the reference list, or take the token out.`;
    },

    /**
     * A text for a field that sends no reference picture (the Generate new and Upscale dialogs' prefill): each token
     * written as its layer's name; a token without one stays (the run then says why). `{ text, note }`.
     */
    refNames(editor, text) {
        const s = String(text == null ? "" : text);
        if (!this.refTokens || !editor || !hasTokens(s)) return { text: s, note: "" };
        const idOf = new Map([...editor.refLabels()].map(([id, n]) => [n, id]));
        const res = namesFor(s, (key) => {
            const id = key[0] === "?" ? key.slice(1) : idOf.get(+key.slice(3));
            const l = id && editor.layers.find((x) => x.id === id);
            return l ? l.name || "" : null;
        });
        return { text: res.text, note: res.replaced.length ? `The reference ${res.replaced.length === 1 ? "token is" : "tokens are"} written as layer names here: this run sends no reference images.` : "" };
    },

    /**
     * The shape of a provider request as main's `provider:layout` reads it (C3), from the recipe and the editor; `over`
     * replaces parts (`kind`, `provider`, `model`, `params`, `original`, `count` = the references including the
     * Original). runProvider builds its request from the same shape.
     */
    layoutShape(editor, over = {}) {
        // `over.recipe`: a run's own recipe, taken at the click (the list may change while its crop is made)
        const r = over.recipe || this.recipe || {};
        const original = over.original != null ? (over.original ? 1 : 0) : editor.predictOriginal();
        return {
            provider: over.provider || r.provider, model: over.model || r.model,
            kind: over.kind || (r.input === "edit" ? "edit" : "fill"),
            fields: over.fields !== undefined ? over.fields : r.fields || null, options: over.options !== undefined ? over.options : r.options || null,
            params: over.params || this.providerParams(editor),
            original, count: over.count != null ? over.count : editor.referenceLayers().length + original,
            refName: over.refName !== undefined ? over.refName : (r.refs && r.refs.name) || null,
            refsMax: over.refsMax || null,
        };
    },

    /**
     * What the chosen route calls each shown reference now (C3): `{ names: Map<layer id, name | null>, over: Set<layer
     * id> (past the route's cap), none: why no reference goes | null, local: a ComfyUI recipe, cap: the reference layers
     * the route takes | null, refuse: why a token cannot go although the pictures do | null (26c2's bar and card) }`.
     * `keep` (the editor's own refresh): also kept as `editor.refLayoutInfo`, by the last call made, not the last to
     * answer; an agent's `status` reads it without touching that. Null without a recipe. Asks main once
     * (`provider:layout`). `over.recipe`: another recipe than the tab's (the Generate new dialog's variant, which passes
     * `{ keep: false }`); `over.kind` "text": a new image from that variant's `text` shape (26f), the references
     * numbered from 1, none going along where the shape has no `refs`.
     */
    async refLayout(editor, over = {}, { keep = true } = {}) {
        const r = over.recipe || this.recipe;
        if (!r || !editor) { if (editor && keep) editor.refLayoutInfo = null; return null; }
        const seq = keep ? (editor._refLayoutSeq = (editor._refLayoutSeq || 0) + 1) : 0;
        const refs = editor.referenceLayers();
        const blank = (none, local = false) => ({ names: new Map(refs.map((l) => [l.id, null])), over: new Set(), none, local, cap: null, refuse: null });
        let info;
        const text = over.kind === "text";
        if (text) {
            // Generate new: the variant's text shape; its refs say whether the pictures go and to which route
            const t = r.kind === "provider" ? r.text : null, tr = t && t.refs;
            if (!t || !tr) over = null;
            else {
                over = {
                    ...over, recipe: r, kind: "text", provider: over.provider || r.provider, model: over.model || tr.model || t.model,
                    options: over.options !== undefined ? over.options : tr.options ? { ...(r.options || {}), ...tr.options } : r.options || null,
                    // the tab's own Settings rows (a ToAPIs Channel, say) when the dialog is on the tab's recipe and provider,
                    // as runGenerate will send them; another variant's rows go back to their defaults on Go
                    params: over.params || (this.recipe && this.recipe.id === r.id && this.recipe.provider === r.provider ? { ...this.providerParams(editor), ...(t.fixed || {}) } : { ...(t.fixed || {}) }),
                    original: 0, refName: over.refName !== undefined ? over.refName : tr.name || (r.refs && r.refs.name) || null, refsMax: tr.max || null,
                };
            }
        }
        if (text && !over) info = blank(`${r.name || r.id} makes new images from the prompt alone: the reference layers stay in the tab, none go along.`);
        else if (r.kind !== "provider" && r.task === "upscale") info = blank("An upscale sends the picture alone: reference images are left out.", true);
        else if (r.kind !== "provider" && r.task === "pass") info = blank(`${realism.LABEL} sends the picture alone: reference images are left out.`, true);
        else if (r.kind !== "provider") {
            // a local recipe: the names its graph gives the pictures of the node's batch, worked out here (comfyrefs.js)
            // `over.state`: the run a caller has in mind (Generate new's white canvas, all of it selected), else the editor now
            const { spec, lay } = this.comfyPlan(editor, r, refs.length, over.state || null, { fresh: !!over.state });
            const names = new Map(refs.map((l, k) => {
                const pic = lay.pictures.find((p) => p.role === "reference" && p.ref === lay.original + k);
                return [l.id, pic ? refName(spec.name, pic.n) : null];
            }));
            info = {
                names, over: new Set(refs.slice(lay.kept).map((l) => l.id)),
                none: spec.slots === 1 ? `${r.name || r.id} reads the crop alone: its graph takes no reference picture.` : null,
                local: true, cap: spec.slots == null ? null : Math.max(0, spec.slots - 1 - lay.original), refuse: null, guess: spec.guess,
            };
        }
        else if (r.task === "upscale") info = blank("An upscale sends the picture alone: reference images are left out.");
        else if (r.edit === false && !over.kind) info = blank(`${r.name || r.id} makes pictures from the prompt alone.`);
        else {
            const shape = this.layoutShape(editor, over);
            try {
                const ans = await window.scumble.providers.layout(shape);
                const names = new Map(refs.map((l, k) => [l.id, (ans.names && ans.names[shape.original + k]) || null]));
                const past = ans.over && ans.max != null ? Math.max(0, ans.sent - ans.max) : 0;
                const overSet = new Set(past ? refs.slice(Math.max(0, refs.length - past)).map((l) => l.id) : []);
                const none = ans.drops && [...names.values()].every((n) => n == null) ? ans.drops : null;
                // the route's pictures that are no reference layer (the crop, a mask sent as a picture, the Original)
                // come off its max
                const cap = ans.max != null ? Math.max(0, ans.max - (ans.sent - shape.count) - shape.original) : null;
                // style references and other unnumbered references (Ideogram 4.5) go without a number: a token for one refuses the run (refs.js checkPictures)
                const refuse = ans.style ? "this route sends reference images without a number (as style references or unnumbered references): take the token out to run" : null;
                info = { names, over: overSet, none, local: false, cap, refuse, style: !!ans.style };
            } catch (err) {
                info = blank(String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
            }
        }
        if (keep && editor._refLayoutSeq === seq) editor.refLayoutInfo = info;
        return info;
    },

    _comfySpecs: new WeakMap(),

    /**
     * A local recipe's names and slots (comfyrefs.js `comfyRefSpec`, kept per recipe object) and the batch a run of it
     * sends (`comfyLayout`, the node's rule): from a canvas state `st` when given (what the node will read), else from
     * the editor now. `count`: the reference layers that would go. `fresh`: Generate new's fresh canvas (generate_new's
     * local path, its dialog), whose Original, the blank canvas before the fill, carries nothing: it does not go
     * (queueGenerate leaves it out of the state the node reads too), so a recipe's `newImage` and the upsampler's
     * text-to-image guide see no picture after the crop.
     */
    comfyPlan(editor, r, count, st = null, { fresh = false } = {}) {
        let spec = this._comfySpecs.get(r);
        if (!spec) { spec = comfyRefSpec(r); this._comfySpecs.set(r, spec); }
        const cs = st ? st.crop || {} : editor.cropSettings || {};
        const gs = st ? st.gen || {} : editor.genSettings || {};
        const lay = comfyLayout(spec, {
            hasSelection: st ? !!st.hasSelection : !!(editor.getBounds && editor.getBounds()),
            fill: cs.fill || "none", withOriginal: !!cs.withOriginal && !fresh,
            refine: !!gs.refine && gs.mode === "local", count,
        });
        return { spec, lay };
    },

    /**
     * What a plugin's box source sees (scumble.generate, docs/PLUGINS.md "Generate"; docs/PLAN_BOXES.md §9): the run's
     * frame in image pixels (the crop of an edit, the document of Generate new), the selection's box, and the pictures
     * of this run as the {@ref:i} markers count them (`sent`: a null for the Original, which takes an index and has no
     * layer; then the reference layers' ids), each with the layer's frame in the picture for a from box's source.
     */
    boxContext(editor, { mode, recipe, provider, model, schema, frame, bounds, sent }) {
        const references = [];
        (sent || []).forEach((id, index) => {
            if (!id) return;
            const l = editor.layers.find((x) => x.id === id);
            references.push({ index, layerId: id, name: l ? l.name : id, frame: l ? { x: l.x || 0, y: l.y || 0, w: l.w || 0, h: l.h || 0 } : null });
        });
        // the selection's bounds are [x0, y0, x1, y1] with x1 and y1 exclusive (editor.getBounds)
        const selection = bounds ? { x: bounds[0], y: bounds[1], w: bounds[2] - bounds[0], h: bounds[3] - bounds[1] } : null;
        return { mode, recipe: recipe ? recipe.id : null, provider: provider || null, model: model || null, schema: schema || null, frame, selection, references };
    },

    /**
     * A run through an API provider: crop in the app (stitch.js), one request to the
     * main process (electron/main/providers), the answer stitched back into an RGBA
     * patch that is stored in the file mirror as a result and added like a result from
     * the node. No ComfyUI involved. `opts.refs`: the click's reference snapshot. `opts.area` (Each area, eacharea.js):
     * one area of the selection, read instead of the document's selection (its `window()`, its `bounds()` for the boxes);
     * its `sent` is set once the request goes to the provider.
     */
    async runProvider(editor, opts = {}) {
        const r = this.recipe;
        const area = opts.area || null;
        if (area && !sameRecipe(r, area.recipe)) throw refusal(AREA_RECIPE_CHANGED);
        // a Stop while the area's generate() still waited (a stroke landing, the helper models freed): this run has no
        // token yet for the Stop to cancel, so it is asked here, before anything is made or sent
        if (area && typeof area.stopped === "function" && area.stopped()) throw Object.assign(new Error(AREA_STOPPED_API), { kind: "cancelled", statusKind: "info" });
        if (!editor.base) throw refusal("Load an image first.");
        // one run per document: a second token would take the slot, and its end would clear it under the first (a Realism
        // Pass, an upscale), which then reads as idle (busy(), Close without asking, turnBlocked)
        if (editor.providerPending) throw refusal(RUN_GOING);
        const label = r.providerLabel || r.provider;
        if (r.edit === false) throw refusal(`${r.name || r.id} on ${label} makes images from the prompt alone: use "Generate new", not Generate.`);
        // the prompt and the references of the click; a token that cannot go refuses before anything is made, an empty
        // prompt where the recipe needs words (promptRequired) too
        const snap = opts.refs || editor.refSnapshot();
        const noWords = promptMissing(r, snap.prompt);
        if (noWords) throw refusal(noWords);
        this.refPrompt(editor, snap, "edit");
        // a Comfy Cloud graph's LoRA rows (item 50): main splices them; more than five refuse before anything is made
        const cloudLoras = this.cloudLoraRows(r);
        editor.lastSentPrompt = null;
        editor.lastRunNotes = [];
        editor.lastSentBoxes = 0;
        editor.lastLoras = [];   // an API run loads none; a Comfy Cloud graph's come back with main's answer
        const token = { provider: r.provider, label, started: Date.now(), editor, runId: runIdOf() };
        editor.providerPending = token;
        this._providerRuns.add(token);
        this.notifyProviderRuns();
        let res, info, sel, x, y, w, h, params = {}, named = null;
        try {
            // what the request says is read at the click, as the crop is: the window stays usable while it is made
            params = this.providerParams(editor, opts.background ? { background: opts.background } : null);
            const keepAlpha = this.wantsTransparent(params);
            const seed = editor.genSettings.seed;
            // the crop and its masks off the window: the box from the tile workers, the pixels in the stitch worker;
            // the references are the click's
            const prep = await prepareCropAsync(editor, this.nodeParams, this.cropLimits(), { refIds: snap.refIds, ...(area ? { area } : {}) });
            const references = prep.references;
            info = prep.info; sel = prep.sel;
            [x, y, w, h] = info.bbox;
            info.keepAlpha = keepAlpha;
            // main names a reference picture by its place in the request: the Original first when it goes
            const original = info.original ? 1 : 0;
            named = this.refPrompt(editor, snap, "edit", { sent: [...Array(original).fill(null), ...snap.refIds] });
            // a selection of several separate areas whose one crop goes out strongly scaled down (item 54): said before
            // the answer and kept in the run's notes (not for a run of one area of them)
            const areaNote = area ? "" : areaHint(this, editor, this.cropLimits(), Math.max(info.emitted[0], info.emitted[1]) / Math.max(1, w, h));
        editor.setStatus(`Sending crop ${w} × ${h} at ${x}, ${y} (${info.emitted[0]} × ${info.emitted[1]}${references.length ? `, ${references.length} reference${references.length > 1 ? "s" : ""}` : ""}) to ${label}${info.keepAlpha ? ", transparent background" : ""} ...${areaNote ? " " + areaNote : ""}`);
            const shape = this.layoutShape(editor, { recipe: r, params, original, count: references.length });
            // the boxes (item 28): geometry in fractions of the crop, main writes the model's rows behind the variant's
            // `options.boxes`; only while the document's Boxes switch is on (S3d)
            const preNotes = areaNote ? [areaNote] : [];
            const boxes = [];
            const takes = !!(shape.options && typeof shape.options.boxes === "string");
            const sendBoxes = takes && !!editor.genSettings.boxes;
            const held = takes && this.plugins ? this.plugins.countBoxes(editor) : 0;
            if (takes && !sendBoxes && held) preNotes.push(`The document's ${held} box${held === 1 ? "" : "es"} did not go: the Boxes switch under the prompt is off.`);
            const selBounds = sendBoxes && info.has_selection ? (area ? area.bounds() : editor.selectionBounds()) : null;
            // the plugins' boxes (S2): every scumble.generate source, in image pixels, mapped into the crop by the core
            if (sendBoxes && this.plugins) {
                const ctx = this.boxContext(editor, { mode: "edit", recipe: r, provider: shape.provider, model: shape.model, schema: shape.options.boxes, frame: frameOf(info), bounds: selBounds, sent: [...Array(original).fill(null), ...snap.refIds] });
                const got = await this.plugins.boxes(editor, ctx, []);
                boxes.push(...got.boxes);
                preNotes.push(...got.notes);
                // every box that places something, not only the selection's (S3e)
                const small = smallNote(smallBoxes(got.boxes, info.emitted));
                if (small) preNotes.push(small);
            }
            // no source holds a box for the document: the selection goes as one (S1). Boxes the crop left out are no
            // reason for it: the document still holds them
            if (sendBoxes && selBounds && !boxes.length && !held) {
                const b = selectionBox(selBounds, frameOf(info), { prompt: named.prompt, pair: named.pairs[0] || null });
                if (b) {
                    boxes.push(b);
                    if (smallBox(b.rect, info.emitted)) preNotes.push(`The selection is small for a box (under ${SMALL_PX} px a side as sent): the model may not place anything in it.`);
                }
            }
            const request = {
                provider: shape.provider, model: shape.model, kind: shape.kind, fields: shape.fields, options: shape.options,
                prompt: named.prompt, negative: named.negative, seed,
                image: prep.image, mask: prep.mask, maskAlpha: prep.maskAlpha, width: prep.width, height: prep.height, references,
                params: shape.params, original: shape.original, refName: shape.refName, boxes,
                // the preset the crop was widened to (stitch.js planFrame), which FLUX 3 sends as its aspect_ratio
                cropAspect: info.aspect || null,
                // the variant's declaration holds for its edit graph (recipes.js normalize)
                ...(cloudLoras ? { loras: { rows: cloudLoras, declared: r.loras } } : {}),
            };
            // a run of one area of several (Each area, eacharea.js): from here on it counts as sent (it may be charged),
            // unless main refuses it before its request goes out (no key, no such endpoint: NOT_SENT's words)
            if (area && !token.cancelled) area.sent = true;
            try { res = await providerEdit(request, token); } catch (err) { if (area && NOT_SENT.test(String((err && err.message) || ""))) area.sent = false; throw err; }
            editor.lastSentPrompt = res.prompt != null ? res.prompt : request.prompt;
            editor.lastRunNotes = [...preNotes, ...(res.notes || [])];
            editor.lastLoras = Array.isArray(res.loras) ? res.loras : [];
        } catch (err) {
            this.endRun(editor, token);
            throw err;
        } finally {
            this.endRunRow(token);
        }
        // the document stays held until the result has landed (endRun)
        try {
            // an adapter that knows its answer covers the crop exactly (Magnific's preset shapes, Image Expand) says so
            if (res && res.info && res.info.fit === "stretch") info.fit = "stretch";
            // the answer decoded and stitched in the stitch worker, the region (for a colour match) from the tile workers
            const fin = await finishResultAsync(editor, info, sel, res.bytes, res.mime, area);
            const { blob, align } = fin;
            const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
            const ref = await this.uploadResult(blob, `n${editor.node.id}_result_${stamp}.png`);
            editor.setStatus(`${label} answered after ${Math.round(res.seconds)} s${res.info && res.info.width ? ` (${res.info.width} × ${res.info.height})` : ""}.`);
            const cutout = info.keepAlpha ? fin.cutout : false;
            await editor.addResults([{ filename: ref.filename, subfolder: ref.subfolder, type: ref.type, x, y, width: w, height: h, align, canvas_node: editor.node.id, provider: r.provider, seed: answeredSeed(res), via: viaLine(r, label, res.seconds, res.loras), ...sentTexts(snap) }]);
            // addResults writes its own line, so the cut-out note, the names the references went as and what the route
            // left out go on afterwards
            if (info.keepAlpha) editor.setStatus(`${editor.status} ${cutout ? "The layer is a cut-out on a transparent ground." : "The model returned no transparency, so the layer is opaque."}`, editor.statusKind || (cutout ? "info" : "warn"));
            const sentAs = named.pairs.map((p) => {
                const got = (res.refs || []).find((x) => x.ref === p.ref);
                return got ? `${p.label} → ${got.name}` : null;
            }).filter(Boolean);
            if (sentAs.length) editor.setStatus(`${editor.status} Named in the prompt: ${sentAs.join(", ")}.`, editor.statusKind || "info");
            const sentBoxes = res.boxes > 0 ? Math.floor(res.boxes) : 0;
            editor.lastSentBoxes = sentBoxes;
            if (sentBoxes) editor.setStatus(`${editor.status} Sent with ${sentBoxes} box${sentBoxes === 1 ? "" : "es"}.`, editor.statusKind || "info");
            if (editor.lastRunNotes.length) editor.setStatus(`${editor.status} ${editor.lastRunNotes.join(" ")}`, notesKind(editor, editor.lastRunNotes));
            return { provider: r.provider, seconds: res.seconds, x, y, w, h, transparent: !!info.keepAlpha, cutout, prompt: editor.lastSentPrompt, refs: res.refs || [], pairs: named.pairs, notes: editor.lastRunNotes, info: res.info || null, boxes: sentBoxes, loras: editor.lastLoras };
        } finally {
            this.endRun(editor, token);
        }
    },
};
