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

    /**
     * A layer as Florence-2 sees it: its own pixels with its mask, on neutral grey, squashed into 768 x 768. On tiles
     * read from the layer's levels (as the object tool's input is), on canvases its masked canvas.
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
        if (!tiled) {
            ctx.drawImage(editor.layerPixels(layer), 0, 0, S, S);
            return new Uint8Array(ctx.getImageData(0, 0, S, S).data.buffer);
        }
        // the layer's box onto the square; the levels at the scale of its longer side
        const s = Math.max(S / layer.w, S / layer.h);
        const fx = layer.w / px.width;
        const level = editor.tileLevel(Math.min(1, fx * s));
        const jobs = await Promise.all([px, mask].filter(Boolean).map((q) => q.primeRegion([0, 0, px.width, px.height], level)));
        try {
            const scratch = document.createElement("canvas");
            scratch.width = S; scratch.height = S;
            const x = scratch.getContext("2d");
            x.imageSmoothingEnabled = true;
            x.setTransform(S / layer.w, 0, 0, S / layer.h, -layer.x * S / layer.w, -layer.y * S / layer.h);
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
        this.vlmJobs++;
        const run = async () => {
            const find = () => (editor._destroyed ? null : editor.layers.find((l) => l.id === id) || null);
            const live = find();
            if (!live || live.name !== before || !this.autoNameOn()) return null;
            const image = await this.layerVlmInput(editor, live);
            const res = await this.describeImage(image, { detailed: false });
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
            res = await this.describeImage(pic.image, { detailed, jobId, timeoutMs });
        } catch (err) {
            const text = String((err && err.message) || err);
            editor.setStatus(text === "cancelled" ? "Describe cancelled." : "Describe failed: " + text, text === "cancelled" ? "info" : failKind(err));
            throw err;
        }
        editor.helperUsed = true;
        const text = String((res && res.text) || "");
        if (toPrompt && text) editor.setPromptText(text);
        editor.setStatus(`${area === "selection" ? "Selection" : "Picture"}: ${text}${toPrompt ? " (in the prompt field)" : ""}`);
        return { text, area, box, detailed: !!detailed, seconds: res && res.seconds, provider: res && res.provider, model: res && res.model };
    },
};
