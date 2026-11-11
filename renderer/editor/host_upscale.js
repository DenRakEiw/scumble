// @ts-check
// upscale: the factor, refusals, runUpscale, landWholePicture, runComfyUpscale, the button: moved out of host.js (item 56 S13, docs/PLAN_SPLIT.md), text unchanged.

import * as comfyprompt from "./comfyprompt.js";
import { bytesToImage, canvasBytes, finishResultAsync, planFrame, prepareCropAsync } from "./stitch.js";
import { failKind, refusal } from "./inpaint_status.js";
import { CANVAS_LIMIT_WORDS, canvasFits, fitInCanvas, largestFactor } from "./inpaint_sizelimit.js";
import { RUN_GOING, answeredSeed, notesKind, providerEdit, runIdOf, upscaleWords, viaLine } from "./host_util.js";

export const HostUpscalePart = {
    /**
     * The factor a run asks for: null when the model picks its own (Recraft), else `want` held to what the
     * variant offers (its `steps`, or min..max), its default when nothing was asked.
     */
    upscaleFactorFor(r, want) {
        const f = r && r.factor;
        if (!f || f.fixed) return null;
        const n = want == null || want === "" ? f.default : +want;
        if (!Number.isFinite(n)) throw new Error(`"${want}" is no factor.`);
        if (Array.isArray(f.steps) && f.steps.length) {
            if (!f.steps.includes(n)) throw new Error(`${r.name || r.id} upscales by ${f.steps.join(", ")}, not ${n}.`);
            return n;
        }
        if (n < f.min || n > f.max) throw new Error(`${r.name || r.id} upscales by ${f.min} to ${f.max}, not ${n}.`);
        // the adapter would round it, and the size checks and the bill would then be for another factor than asked
        if (f.whole && !Number.isInteger(n)) throw new Error(`${r.name || r.id} upscales by whole factors (${f.min} to ${f.max}), not ${n}.`);
        return n;
    },

    /**
     * "" when a ComfyUI upscaler (`r.limits`: `min` the input's short side, `max` its long side, `out` the answer's
     * long side; `picture` the whole picture's long side alone, upscale_model_local's 2048, Q14) takes a w × h picture at
     * `factor` (null: the model picks its own, so `out` is not checked), else the refusal. `what` names the picture:
     * "box" (the selection with its context), "picture" (the whole one) or "sent" (the selection's box as an API
     * upscaler gets it, held to the variant's limits).
     */
    upscaleSizeRefusal(r, w, h, factor, what = "box") {
        const l = (r && r.limits) || {};
        const name = (r && (r.name || r.id)) || "The upscaler";
        const { the, smaller } = upscaleWords(w, h, what);
        if (l.min && Math.min(w, h) < l.min) return `${the}; ${name} needs at least ${l.min} px a side.`;
        const max = what === "picture" && l.picture ? Math.min(l.picture, l.max || Infinity) : l.max;
        if (max && Math.max(w, h) > max) return `${the}; ${name} takes at most ${max} px on the long side. Pick ${smaller}.`;
        return this.upscaleOutRefusal(r, w, h, factor, what);
    },

    /**
     * upscaleSizeRefusal's last rule alone, for an API upscaler (its variant's `limits.out`: RTX Video Super Resolution
     * on Comfy Cloud, 8192; docs/PLAN_0_1_42.md U3), whose input limits the crop is held to instead of refused: "" when
     * the long side of w × h times `factor` stays within `out` (or there is no `out`, or the model picks its factor).
     * The whole picture (`what` "picture") at 1× is refused on every upscaler: its answer would come back at the picture's
     * own size, which the landing cannot take (release review 2026-10-05); a fixed 1× model is only seen in its answer.
     */
    upscaleOutRefusal(r, w, h, factor, what = "box") {
        if (what === "picture" && factor != null && factor <= 1) {
            return `At 1× the whole picture would come back at its own size: upscale a selection at 1× (Select All for the whole picture), or pick a larger factor.`;
        }
        // the whole picture lands as one canvas: past it the answer would be paid for and could not land (S5)
        const area = (r && r.limits && r.limits.outPixels) || 0;
        if (what === "picture" && factor != null && !canvasFits(Math.round(w * factor), Math.round(h * factor))) {
            const best = largestFactor(w, h, r && r.factor, area);
            // 1× is refused for the whole picture by the rule above, so it is never the advice
            const fit = best != null && best > 1 && best < factor ? ` The largest factor that fits is ${best}×.` : " Upscale a selection instead, or scale the picture down first.";
            return `The picture is ${w} × ${h}; at ${factor}× it would become ${Math.round(w * factor)} × ${Math.round(h * factor)} px, ${CANVAS_LIMIT_WORDS}.${fit}`;
        }
        // the model's own area cap (limits.outPixels: Magnific Creative's 25.3 MP), which its adapter refuses too
        if (area && factor != null && Math.round(w * factor) * Math.round(h * factor) > area) {
            const { the, smaller } = upscaleWords(w, h, what);
            const best = largestFactor(w, h, r && r.factor, area);
            const fit = best != null && best < factor && !(what === "picture" && best <= 1) ? ` The largest factor that fits is ${best}×.` : "";
            // the answer rounded up and the cap down, so the answer never reads as the cap itself
            const got = Math.ceil(Math.round(w * factor) * Math.round(h * factor) / 1e5) / 10;
            const pick = fit ? `Pick a smaller factor or ${smaller}.` : `Pick ${smaller}.`;
            return `${the}; at ${factor}× the answer would be ${got} MP, more than ${(r && (r.name || r.id)) || "the model"} returns (${Math.floor(area / 1e5) / 10} MP). ${pick}${fit}`;
        }
        const out = r && r.limits && r.limits.out;
        if (!out || factor == null || Math.round(Math.max(w, h) * factor) <= out) return "";
        const { the, smaller } = upscaleWords(w, h, what);
        return `${the}; at ${factor}× the answer would pass ${out} px on the long side. Pick a smaller factor or ${smaller}.`;
    },

    /** The crop an upscale on an API variant (`limits` its EditLimits) would send now: runUpscale's plan (mode "crop"). */
    upscaleFrame(editor, limits) {
        return planFrame(editor, this.nodeParams, limits ? { ...limits, mode: "crop" } : null);
    },

    /**
     * An upscale through the selected upscale recipe (`task: "upscale"`, docs/RECIPES.md "Upscale recipes").
     * `scope` "selection": the selection's box goes out at its own size (no fill, no references) and the larger
     * answer is fitted back into it by the stitch, a result layer like Generate's: a detail pass at the
     * document's resolution. `scope` "document": the base image alone goes out, the answer becomes the new base
     * at its own size, and every layer, mask and the selection are scaled along (`resizeImage` with the new base,
     * one `canvas` undo step); a picture above the variant's `limits.max` is refused, and on either scope a picture
     * whose answer would pass the variant's `limits.out` (upscaleOutRefusal), before anything is sent.
     */
    async runUpscale(editor, opts = {}) {
        const r = this.recipe;
        if (!r || r.kind !== "provider" || r.task !== "upscale") throw new Error("Pick an upscale recipe first (Upscale shows them).");
        if (!editor.base) throw refusal("Load an image first.");
        if (editor.providerPending) throw refusal(RUN_GOING);   // as runProvider
        const scope = opts.scope === "document" ? "document" : "selection";
        const label = r.providerLabel || r.provider;
        const factor = this.upscaleFactorFor(r, opts.factor);
        const max = (r.limits && r.limits.max) || 2048;
        if (scope === "selection" && !(editor.getBounds && editor.getBounds())) throw refusal("Select an area first, or upscale the whole picture.");
        // the whole picture's answer replaces the base: not while a job would land in the old geometry (its resize lets
        // the upscale's own landing through, so the check is here, before anything is paid for)
        const blocked = scope === "document" && editor.turnBlocked ? editor.turnBlocked() : "";
        if (blocked) throw refusal(blocked);
        if (scope === "document" && Math.max(editor.width, editor.height) > max) {
            throw new Error(`The picture is ${editor.width} × ${editor.height}; ${r.name || r.id} on ${label} takes at most ${max} px on the long side. Upscale a selection instead.`);
        }
        // an answer past the variant's cap (limits.out, RTX Video Super Resolution on Comfy Cloud) is refused before anything
        // is paid: the whole picture here, the selection's box once its crop is planned (it is sent held to the limits)
        const over = scope === "document" ? this.upscaleOutRefusal(r, editor.width, editor.height, factor, "picture") : "";
        if (over) throw new Error(over);
        const params = this.providerParams(editor);
        // an upscale sends no reference picture: a token is written as its layer's name, in the request only
        // (the texts of the click's snapshot, or of now, unless the dialog or the command brings its own prompt)
        const texts = r.usesPrompt
            ? this.refPrompt(editor, opts.refs || null, "none", { prompt: opts.prompt != null ? opts.prompt : undefined, who: "Upscale" })
            : { prompt: "", negative: "", note: "" };
        const slow = /topaz/i.test(`${r.id} ${r.model}`) ? " Topaz can take several minutes; the window stays usable."
            : /precision/i.test(r.model || "") && r.provider === "magnific" ? " Magnific Precision can take several minutes; the window stays usable." : "";
        const by = factor ? `${factor}×` : "the model's own factor";
        // `resizes`: the whole picture's landing resizes the document, so a Generate or a helper job started meanwhile is
        // refused (editor.generate and the helpers' starters read it), not left to land in the old geometry
        const token = { provider: r.provider, label, started: Date.now(), editor, runId: runIdOf(), resizes: scope === "document" };
        editor.providerPending = token;
        this._providerRuns.add(token);
        this.notifyProviderRuns();
        let res, prep = null, W = editor.width, H = editor.height;
        try {
            const request = {
                provider: r.provider, model: r.model, kind: "upscale", fields: r.fields || null, options: r.options || null,
                factor, params, seed: editor.genSettings.seed,
                // the Upscale dialog's (or the command's) own prompt, else the document's
                prompt: texts.prompt, negative: r.usesPrompt ? texts.negative : "",
                mask: null, maskAlpha: null, references: [],
            };
            if (scope === "selection") {
                // the crop as it is (mode "crop", up to the model's max), without a fill or the reference layers
                prep = await prepareCropAsync(editor, this.nodeParams, { ...r.limits, mode: "crop" }, { crop: { fill: "none", withOriginal: false }, references: false });
                const boxOver = this.upscaleOutRefusal(r, prep.width, prep.height, factor, "sent");
                if (boxOver) throw new Error(boxOver);
                const [x, y, w, h] = prep.info.bbox;
                Object.assign(request, { image: prep.image, width: prep.width, height: prep.height, references: prep.references });
                editor.setStatus(`Upscaling the selection's box ${w} × ${h} at ${x}, ${y} (${prep.width} × ${prep.height} sent) by ${by} on ${label} ...${slow}`);
            } else {
                const c = document.createElement("canvas");
                c.width = W; c.height = H;
                editor.drawBaseInto(c.getContext("2d"), 0, 0, W, H);
                const image = await canvasBytes(c);
                c.width = c.height = 0;
                Object.assign(request, { image, width: W, height: H });
                editor.setStatus(`Upscaling the picture ${W} × ${H} by ${by} on ${label} ...${slow}`);
            }
            res = await providerEdit(request, token);
        } catch (err) {
            this.endRun(editor, token);
            throw err;
        } finally {
            this.endRunRow(token);
        }
        // the document stays held until the answer has landed (endRun); the whole picture's resize lets its own landing
        // through (resizeImageNow's `base`)
        // the run's notes (Comfy Router: who served it, what it left out) after the landing's own line, as Generate does
        const runNotes = Array.isArray(res.notes) ? res.notes.map(String) : [];
        const sayNotes = () => { if (runNotes.length) editor.setStatus(`${editor.status} ${runNotes.join(" ")}`, notesKind(editor, runNotes)); };
        try {
            if (scope === "selection") {
                const info = prep.info;
                const [x, y, w, h] = info.bbox;
                const fin = await finishResultAsync(editor, info, prep.sel, res.bytes, res.mime);
                const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
                const ref = await this.uploadResult(fin.blob, `n${editor.node.id}_upscale_${stamp}.png`);
                // the prompt the upscale sent, its tokens already written as layer names
                const via = viaLine(r, label, res.seconds);
                await editor.addResults([{ filename: ref.filename, subfolder: ref.subfolder, type: ref.type, x, y, width: w, height: h, align: fin.align, canvas_node: editor.node.id, provider: r.provider, seed: answeredSeed(res), via, prompt: r.usesPrompt ? texts.prompt : "", negative: r.usesPrompt ? texts.negative : "", refs: null }]);
                const got = res.info && res.info.width ? ` (${res.info.width} × ${res.info.height} came back)` : "";
                // the upscale's own line in place of addResults', ending as a result's line does with the model, the
                // route and the seconds (QW5)
                editor.setStatus(`Upscaled the selection${got}: fitted back into ${w} × ${h} as a new layer · ${via}${texts.note ? " " + texts.note : ""}`);
                sayNotes();
                return { scope, provider: r.provider, recipe: r.id, factor, seconds: res.seconds, x, y, w, h, info: res.info || null, note: texts.note, notes: runNotes };
            }
            const land = await this.landWholePicture(editor, res.bytes, res.mime, { label, seconds: res.seconds, W, H, note: texts.note });
            sayNotes();
            return { scope, provider: r.provider, recipe: r.id, factor, seconds: res.seconds, from: [W, H], width: land.width, height: land.height, answered: land.answered, info: res.info || null, note: texts.note, notes: runNotes };
        } finally {
            this.endRun(editor, token);
        }
    },

    /**
     * The whole picture's answer becomes the document's base (an API upscaler's, runUpscale; a ComfyUI upscaler's,
     * runComfyUpscale): at its own width, stretched to the document's aspect if the model rounded a side, and every
     * layer, mask and the selection scaled along through `resizeImage(nw, nh, { base })`, one `canvas` undo step. The
     * caller holds the document's run slot (providerPending) until this returns: resizeImage's `base` lets this landing
     * through, and nothing else lands in the old geometry meanwhile. `W` × `H` is the picture that went out. Throws on an
     * empty answer, one at the picture's own size, a landing wholeLandingRefusal refuses (the size changed, a job that
     * would land in the old geometry), and a resize the editor refused (its status). `gone`: the caller's closed-tab test.
     * -> { width, height, answered: [aw, ah] }
     */
    async landWholePicture(editor, bytes, mime, { label, seconds = 0, W, H, note = "", gone = () => false }) {
        const img = await bytesToImage(bytes, mime);
        const aw = img.naturalWidth || img.width, ah = img.naturalHeight || img.height;
        if (!(aw > 0 && ah > 0)) throw new Error(`${label} answered with an empty picture.`);
        let nw = aw, nh = Math.max(1, Math.round(H * aw / W));
        if (nw === W && nh === H) throw new Error(`${label} answered at the picture's own size (${aw} × ${ah}); nothing to do.`);
        // a model that picks its own factor can answer past what one canvas holds: the paid answer lands scaled to fit
        // (the user, 2026-10-13: scale it down rather than refuse it), and the line says so in red
        let fitted = "";
        if (!canvasFits(nw, nh)) {
            const [fw, fh] = fitInCanvas(nw, nh);
            fitted = ` The answer was ${aw} × ${ah}, ${CANVAS_LIMIT_WORDS}: it landed scaled to ${fw} × ${fh}.`;
            nw = fw; nh = fh;
        }
        const refused = await this.wholeLandingRefusal(editor, W, H, gone);
        if (refused) throw new Error(`${label}: ${refused}`);
        const nb = document.createElement("canvas");
        nb.width = nw; nb.height = nh;
        const nctx = nb.getContext("2d");
        nctx.imageSmoothingEnabled = true;
        nctx.imageSmoothingQuality = "high";
        nctx.drawImage(img, 0, 0, nw, nh);
        await editor.resizeImage(nw, nh, { base: nb });
        nb.width = nb.height = 0;
        if (editor.width !== nw || editor.height !== nh) throw new Error(editor.status || "the upscaled picture could not be taken");
        editor.setStatus(`${label} upscaled the picture in ${Math.round(seconds)} s: ${W} × ${H} is now ${nw} × ${nh}, every layer scaled along (Ctrl+Z takes it back).${fitted}${note ? " " + note : ""}`, fitted ? "warn" : "info");
        return { width: nw, height: nh, answered: [aw, ah], fitted: !!fitted };
    },

    /**
     * The net before a whole-picture landing resizes the document (landWholePicture; realismWhole above 1×): "" when it
     * may, else why not (the caller prefixes its label, adds nothing and changes nothing). The run held the document's
     * slot (providerPending, `resizes`), so Generate, the helpers and a turn were refused meanwhile; this catches what
     * got past that: the size changed since `W` × `H` went out, and turnBlocked's conditions without the run's own slot (a
     * helper job, a render on the user's ComfyUI, a load). A save or a held stroke is waited for (up to 30 s) first.
     * `gone`: the caller's closed-tab test (the wait ends on it).
     */
    async wholeLandingRefusal(editor, W, H, gone = () => false) {
        const t0 = Date.now();
        const busy = () => !!editor._docSaving || !!(editor.gestureHeld && editor.gestureHeld());
        while (busy() && !gone() && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 100));
        if (gone()) return "the document was closed; nothing was changed.";
        if (editor.width !== W || editor.height !== H) return `the picture's size changed while it ran (${W} × ${H} is now ${editor.width} × ${editor.height}); nothing was changed.`;
        if (editor._localRuns && editor._localRuns.size) return "a render on your ComfyUI is still running on this document: its result would land where the picture was. Nothing was changed; run it again when the render is in.";
        if (editor.segmentPending || editor.cutoutPending || editor.objectsPending || editor._pointPending || editor._loading) return "another job on this document (a selection by text, a cutout, the object tool, a load) would land where the picture was. Nothing was changed; run it again when that job is in.";
        if (busy()) return "the document stayed busy (a save, or a held stroke): nothing was changed.";
        return "";
    },

    /**
     * The whole picture through the selected upscale recipe on the user's ComfyUI (docs/PLAN_0_1_42.md U2): the base
     * alone goes out (drawn at its size, stored in the mirror and on the server, uploadInput), the recipe's graph runs
     * with the canvas node as a loader of that picture (comfyprompt.wholePicturePrompt: the Settings rows and the factor
     * written, a PreviewImage on the result), queued behind the user's jobs (comfyPictureRun), and the answer becomes the
     * new base with every layer, mask and the selection scaled along (landWholePicture, one undo step). Refused before
     * anything is drawn or sent: a graph that reads more than the picture from the canvas node, no connection, node types
     * the server lacks, a document that is busy (turnBlocked), a picture past the recipe's `limits` (the long side `max`,
     * the answer's long side `out` at the factor; an upscale model picks its own factor, so `out` is not checked), a factor
     * of 1 (upscaleOutRefusal). The document is busy like a run meanwhile (a token that `resizes`: Generate and the helper
     * jobs are refused): the title row's timer names the recipe and its Cancel takes the job off the server, or, pressed
     * while the answer is fetched, lands nothing; closing the tab ends it too and lands nothing. The landing is
     * landWholePicture's (its net: wholeLandingRefusal). The loader gives RGB: a cut-out picture comes back opaque.
     * `factor`: what the dialog or the command asked (the recipe's default when left out; null for a fixed one);
     * `deadline` (a time in ms, 0 for none): comfyPictureRun's hard end, the upload's too.
     * -> { scope: "document", recipe, factor, seconds, from, width, height, answered } (width null when the tab was closed)
     * @param {any} editor
     * @param {{ factor?: any, deadline?: number }} [opts]
     */
    async runComfyUpscale(editor, { factor: want = undefined, deadline = 0 } = {}) {
        const r = this.recipe;
        if (!r || r.kind === "provider" || r.task !== "upscale" || !r.prompt) throw new Error("Pick an upscale recipe on ComfyUI first (Upscale shows them).");
        if (!editor.base) throw refusal("Load an image first.");
        if (editor.providerPending) throw refusal(RUN_GOING);
        const label = r.name || r.id;
        const shape = comfyprompt.wholePictureRefusal(r);
        if (shape) throw new Error(shape);
        if (!this.connected) throw refusal("Not connected to ComfyUI.");
        const factor = this.upscaleFactorFor(r, want);
        // the classes this route queues: the recipe's own with the loader for the canvas node, and PreviewImage
        const missing = comfyprompt.wholePictureClasses(r).filter((n) => this.objectInfo && !this.objectInfo[n]);
        if (missing.length) throw new Error("The server lacks these node types: " + missing.join(", "));
        // the answer replaces the base: not while a job would land in the old geometry
        const blocked = editor.turnBlocked ? editor.turnBlocked() : "";
        if (blocked) throw refusal(blocked);
        const W = editor.width, H = editor.height;
        const size = this.upscaleSizeRefusal(r, W, H, factor, "picture");
        if (size) throw new Error(size);
        const by = factor != null ? `${factor}×` : "the model's own factor";
        // `resizes`: the landing resizes the document (see runUpscale)
        const token = { provider: "comfyui", label, started: Date.now(), editor, resizes: true };
        editor.providerPending = token;
        this._providerRuns.add(token);
        this.notifyProviderRuns();
        // closing the tab ends the run (its job taken off the server) and lands nothing
        let closed = false;
        const offRemoved = this.on("removed", (e) => { if (e && e.editor === editor) { closed = true; token.cancelled = true; } });
        const gone = () => closed || !this._editors.includes(editor);
        const fail = (err) => {
            const msg = String((err && err.message) || err);
            const text = err && err.kind === "error" && !msg.startsWith(label) ? `${label} failed on your ComfyUI: ${msg}` : msg;
            if (!gone()) editor.setStatus(text, failKind(err));
            return Object.assign(new Error(text), { kind: err && err.kind, statusKind: failKind(err) });
        };
        try {
            let res;
            try {
                editor.setStatus(`Upscaling the picture ${W} × ${H} by ${by} on your ComfyUI (${label}) ...`);
                const c = document.createElement("canvas");
                c.width = W; c.height = H;
                editor.drawBaseInto(c.getContext("2d"), 0, 0, W, H);
                let png;
                try { png = await canvasBytes(c); } finally { c.width = c.height = 0; }
                const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
                // the upload and the server's copy end at a Cancel and at the deadline too (a stalled forward never holds
                // the caller; the request runs on and is ignored, a stray input)
                const upload = this.uploadInput(new Blob([png], { type: "image/png" }), `n${editor.node.id}_upscale_${stamp}.png`);
                png = null;
                const ref = await new Promise((resolve, reject) => {
                    const t0 = Date.now();
                    let iv = null;
                    const done = (fn, v) => { clearInterval(iv); fn(v); };
                    iv = setInterval(() => {
                        if (token.cancelled) done(reject, Object.assign(new Error(`${label} cancelled.`), { kind: "cancelled" }));
                        else if (deadline && Date.now() > deadline) done(reject, Object.assign(new Error(`${label}: your ComfyUI did not take the picture within ${Math.round((Date.now() - t0) / 1000)} s.`), { kind: "timeout" }));
                    }, 250);
                    upload.then((v) => done(resolve, v), (err) => done(reject, err));
                });
                {
                    const lacks = this.missingFilesRefusal(editor, r);   // a file the server lacks (issue #4): refused before the queue
                    if (lacks) throw new Error(lacks);
                }
                const prompt = comfyprompt.wholePicturePrompt(r, ref, factor, editor.settings);
                res = await this.comfyPictureRun(editor, prompt, comfyprompt.WHOLE_OUTPUT, { label, token, front: false, deadline, timeoutMs: 1800000 });
                // a Cancel during the answer's fetch (comfyPictureRun stops watching the token once the job answered):
                // honoured here, so nothing lands, as cancel_run promises
                if (token.cancelled && !gone()) throw Object.assign(new Error(`${label} cancelled.`), { kind: "cancelled" });
            } finally {
                // the answer is in (or the run ended): the timer and Cancel leave the title row; the document stays held
                // until the answer has landed (endRun below)
                this.endRunRow(token);
            }
            if (gone()) return { scope: "document", recipe: r.id, factor, seconds: res.seconds, from: [W, H], width: null, height: null, answered: null };
            const land = await this.landWholePicture(editor, res.bytes, res.mime, { label, seconds: res.seconds, W, H, note: "", gone });
            return { scope: "document", recipe: r.id, factor, seconds: res.seconds, from: [W, H], width: land.width, height: land.height, answered: land.answered };
        } catch (err) {
            if (gone()) return { scope: "document", recipe: r.id, factor, seconds: 0, from: [W, H], width: null, height: null, answered: null };
            throw fail(err);
        } finally {
            offRemoved();
            this.endRun(editor, token);
        }
    },

    /** The Upscale button in the editor's top bar, next to Generate new (the app's, so the node's host needs none). */
    buildUpscaleButton(editor) {
        const top = editor.root && editor.root.querySelector(".ipc-top");
        if (!top || top.querySelector(".ipc-upscale") || !this.shell || !this.shell.openUpscale) return;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ipc-ib ipc-upscale";
        b.title = "Upscale: the selection comes back sharper at the document's resolution, or the whole picture becomes 2, 4 ... times larger with every layer scaled along. Topaz, Clarity, SeedVR2, Recraft and Magnific models, or an upscaler on your own ComfyUI.";
        b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-7 7"/><path d="M10 20H4v-6"/><path d="M4 20l7-7"/></svg><span>Upscale</span>';
        b.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); this.shell.openUpscale(editor); });
        const after = Array.from(top.querySelectorAll(".ipc-ib")).find((x) => /^Generate new/.test(x.title || ""));
        if (after) after.after(b);
        else top.insertBefore(b, top.querySelector(".ipc-grow"));
    },
};
