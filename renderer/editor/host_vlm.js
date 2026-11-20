// @ts-check
// Florence-2 in the app (item 62): a caption of a layer or of the selection, from the helpers' process
// (electron/main/onnx/florence2.js). Two uses: new result, paste, cutout and reference layers get a short name
// (`autoNameLayer`, from the editor's `layerLanded` hook, which the app sets in editorBuilt and the node never does),
// and *Image › Describe Selection* / MCP `describe` (`describeArea`). App-only: the editor calls none of these members.

import { failKind } from "./inpaint_status.js";
import { isGenericName, shortName } from "./vlm_names.js";

/** Florence-2's input side: the renderer squashes the picture into it, as its own processor does. */
export const VLM_SIDE = 768;
/** At most this many automatic names wait for the model at once (a drop of many files names the first ones). */
const NAME_QUEUE_MAX = 8;
const NO_MODEL = "Describing a picture needs Florence-2: download it in Settings › Helpers.";

export const HostVlmPart = {
    /** The caption model: the chosen one when present, else the first present, else null. */
    vlmModel() {
        const all = this.presentHelpers("vlm");
        return all.find((m) => m.id === this.helpers.vlm) || all[0] || null;
    },

    /** Whether new layers get names now: Florence-2 downloaded and *Name new layers automatically* on (the default). */
    autoNameOn() {
        return !!this.vlmModel() && this.helpers.autoName !== false;
    },

    vlmJobs: 0,

    /**
     * One caption of a 768 x 768 RGBA picture. -> { text, task, steps, seconds, provider, model, label }; refuses
     * without the model. `jobId` lets `cancelDescribe` stop it (it then refuses with "cancelled").
     * @param {Uint8Array} image
     * @param {{ detailed?: boolean, jobId?: string | null, timeoutMs?: number }} [opts]
     */
    async describeImage(image, { detailed = false, jobId = null, timeoutMs = undefined } = {}) {
        const model = this.vlmModel();
        if (!model) throw new Error(NO_MODEL);
        return this.helperCall("describe", { model: model.id, image, task: detailed ? "detailed" : "caption", jobId, timeoutMs });
    },

    /** A describe job told to stop at its next decoder step. */
    cancelDescribe(jobId) {
        try { return window.scumble.helpers.cancelDescribe(jobId); } catch (_) { return false; }
    },

    vlmSeq: 0,
    vlmLoaded: false,   // Florence-2 was loaded into the helpers' process (one for every tab) since the last free

    /**
     * `describeImage` for one document, with a job id `cancelDescribes` reaches. The editor's `vlmUsed` marks that
     * Florence-2 holds VRAM, so a local Generate frees the helpers first (only that: no `/free` on ComfyUI, which
     * `helperUsed` would send).
     */
    async vlmJob(editor, image, { detailed = false, jobId = null, timeoutMs = undefined } = {}) {
        const run = { editor, jobId: jobId || "vlm" + Date.now().toString(36) + "-" + ++this.vlmSeq };
        if (!this._vlmRuns) this._vlmRuns = new Set();
        this._vlmRuns.add(run);
        // the helpers' process is one for every tab and loads Florence-2 before its first step: a local Generate in any
        // tab frees it, and a describe that was cancelled has loaded it too (review 2026-11-16 p1-lanes-bce/vlm-used-per-tab-leaks-helper-vram)
        this.vlmLoaded = true;
        try {
            const res = await this.describeImage(image, { detailed, jobId: run.jobId, timeoutMs });
            if (editor) editor.vlmUsed = true;
            return res;
        } finally {
            this._vlmRuns.delete(run);
        }
    },

    /**
     * The describe jobs of `editor` (every document's without one) stopped, a running one at its next decoder step, the
     * names still waiting never asked for: Cancel in the title row, `cancel_run` and a tab's close (`cancelRuns`).
     */
    cancelDescribes(editor) {
        if (editor) editor._vlmGen = (editor._vlmGen || 0) + 1;
        else this._vlmGenAll = (this._vlmGenAll || 0) + 1;
        for (const r of this._vlmRuns || []) if (!editor || r.editor === editor) this.cancelDescribe(r.jobId);
    },

    /**
     * A layer as Florence-2 sees it: its own pixels with its mask, fitted onto a 768 x 768 square of neutral grey (its
     * shape kept). On tiles read from the layer's levels (as the object tool's input is), on canvases its masked canvas.
     */
    async layerVlmInput(editor, layer) {
        const S = VLM_SIDE;
        const c = document.createElement("canvas");
        c.width = S; c.height = S;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#808080";
        ctx.fillRect(0, 0, S, S);
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
        const px = layer.px;
        const mask = editor.liveMask ? editor.liveMask(layer) : layer.maskPx;
        const tiled = editor.tileMode && px && typeof px.primeRegion === "function" && !editor.liveStrokeOn(layer) && (!mask || editor.tileMaskOf(layer));
        if (!(layer.w > 0 && layer.h > 0)) return new Uint8Array(ctx.getImageData(0, 0, S, S).data.buffer);
        // the layer's box fitted onto the square, centred: a 15000 x 600 strip is read near 768 px wide and its shape
        // kept, not squashed from level 0 (a 46 MB canvas on the window, or a throw above 65,535 px; review 2026-11-16
        // p1-lanes-bce/layer-vlm-input-wide-layer-level-zero-canvas)
        const s = Math.min(S / layer.w, S / layer.h);
        const dw = layer.w * s, dh = layer.h * s, ox = (S - dw) / 2, oy = (S - dh) / 2;
        if (!tiled) {
            ctx.drawImage(editor.layerPixels(layer), ox, oy, dw, dh);
            return new Uint8Array(ctx.getImageData(0, 0, S, S).data.buffer);
        }
        const fx = layer.w / px.width;
        const level = editor.tileLevel(Math.min(1, fx * s));
        const jobs = await Promise.all([px, mask].filter(Boolean).map((q) => q.primeRegion([0, 0, px.width, px.height], level)));
        try {
            const scratch = document.createElement("canvas");
            scratch.width = S; scratch.height = S;
            const x = scratch.getContext("2d");
            x.imageSmoothingEnabled = true;
            x.setTransform(s, 0, 0, s, ox - layer.x * s, oy - layer.y * s);
            const vp = { x: layer.x, y: layer.y, w: layer.w, h: layer.h, sx: Math.min(1 / fx, s), sy: Math.min(1 / fx, s), sample: true };
            editor.drawPixelsInto(x, layer, px, vp);
            if (mask) {
                x.globalCompositeOperation = "destination-in";
                editor.drawPixelsInto(x, layer, mask, vp);
            }
            ctx.drawImage(scratch, 0, 0);
            return new Uint8Array(ctx.getImageData(0, 0, S, S).data.buffer);
        } finally {
            for (const j of jobs) j.release();
        }
    },

    /**
     * A short name for a layer that just landed (`why`: "result", "paste", "cutout", "reference"), from Florence-2's
     * caption, without blocking: the jobs run one after the other, and a name lands only when the layer is still there
     * under the name it had when it landed (a name typed meanwhile is never overwritten). Only a name that says nothing
     * of the content is replaced ("Result 3", "Paste 2", "IMG_2041", "image"; `isGenericName`), a filter or text layer
     * never. No undo step: the name is written into the undo and redo steps that hold the layer under its old name too,
     * so an undo of a later edit does not bring "Result 3" back. -> a promise of the name, or null
     */
    autoNameLayer(editor, layer, why) {
        if (!editor || !layer || !layer.id || !this.autoNameOn()) return null;
        if (layer.kind === "filter" || layer.kind === "text" || !layer.px) return null;
        if (!isGenericName(layer.name)) return null;
        if (this.vlmJobs >= NAME_QUEUE_MAX) return null;
        const id = layer.id, before = layer.name;
        const gen = editor._vlmGen || 0, genAll = this._vlmGenAll || 0;
        const stopped = () => (editor._vlmGen || 0) !== gen || (this._vlmGenAll || 0) !== genAll || editor._destroyed || !this._editors.includes(editor);
        this.vlmJobs++;
        const run = async () => {
            const find = () => (stopped() ? null : editor.layers.find((l) => l.id === id) || null);
            const live = find();
            if (!live || live.name !== before || !this.autoNameOn()) return null;
            const image = await this.layerVlmInput(editor, live);
            const res = await this.vlmJob(editor, image, { detailed: false });
            const name = shortName(res && res.text);
            const now = find();
            if (!name || !now || now.name !== before) return null;
            this.renameQuietly(editor, now, before, name);
            return name;
        };
        const prev = this._vlmQueue || Promise.resolve();
        const p = prev.then(run).catch((err) => {
            const text = String((err && err.message) || err);
            console.warn(`naming ${why} layer ${before}:`, text);
            try { window.scumble.log.add({ level: "warn", source: "helpers", message: `Florence-2 could not name the layer "${before}": ${text}` }); } catch (_) { /* no log */ }
            return null;
        }).finally(() => { this.vlmJobs--; });
        this._vlmQueue = p;
        return p;
    },

    /** A layer's name changed outside the undo history (an automatic name), in the steps that hold it under `before` too. */
    renameQuietly(editor, layer, before, name) {
        layer.name = name;
        for (const snap of [...(editor.undo || []), ...(editor.redo || [])]) {
            if (!snap || !Array.isArray(snap.layers)) continue;
            for (const l of snap.layers) if (l && l.id === layer.id && l.name === before) l.name = name;
        }
        // the result history's entry for the layer (a click on it adds it again under this name)
        let hist = false;
        for (const h of editor.history || []) if (h && h.layerId === layer.id && h.name === before) { h.name = name; hist = true; }
        editor.renderLayers();
        if (hist && editor.renderHistory) editor.renderHistory();
        editor.notifyChanged();
    },

    /**
     * Describe the selected area (its bounding box), or the whole picture without a selection, as the screen shows it
     * (filter layers included), with Florence-2. `detailed`: a few sentences instead of a line; `toPrompt`: the text
     * goes into the prompt field (its own undo has the old text). The text goes to the status line too.
     * -> { text, area: "selection" | "picture", box, detailed, seconds, provider, model }
     * @param {any} editor
     * @param {{ detailed?: boolean, toPrompt?: boolean, jobId?: string | null, timeoutMs?: number }} [opts]
     */
    async describeArea(editor, { detailed = false, toPrompt = false, jobId = null, timeoutMs = undefined } = {}) {
        if (!editor || !editor.width) throw new Error("Load an image first.");
        if (!this.vlmModel()) { editor.setStatus(NO_MODEL, "warn"); throw new Error(NO_MODEL); }
        const S = VLM_SIDE;
        const b = editor.sel && editor.selectionBounds ? editor.selectionBounds() : null;
        const box = b && b[2] - b[0] >= 4 && b[3] - b[1] >= 4 ? b.map((v) => Math.round(v)) : null;
        const area = box ? "selection" : "picture";
        editor.setStatus(`Describing the ${area} with Florence-2 ...`);
        let res;
        try {
            const pic = box
                ? await this.pictureInputBox(editor, box, S, S, { skipFilters: false, background: "#808080" })
                : await this.pictureInput(editor, S, S, { skipFilters: false, background: "#808080" });
            res = await this.vlmJob(editor, pic.image, { detailed, jobId, timeoutMs });
        } catch (err) {
            const text = String((err && err.message) || err);
            editor.setStatus(text === "cancelled" ? "Describe cancelled." : "Describe failed: " + text, text === "cancelled" ? "info" : failKind(err));
            throw err;
        }
        const text = String((res && res.text) || "");
        if (toPrompt && text) editor.setPromptText(text);
        editor.setStatus(`${area === "selection" ? "Selection" : "Picture"}: ${text}${toPrompt ? " (in the prompt field)" : ""}`);
        return { text, area, box, detailed: !!detailed, seconds: res && res.seconds, provider: res && res.provider, model: res && res.model };
    },
};
