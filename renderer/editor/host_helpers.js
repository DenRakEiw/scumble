// @ts-check
// helpers: LLMs, SAM2 objects, cutout, segment, depth, freeHelpers: moved out of host.js (item 56 S13, docs/PLAN_SPLIT.md), text unchanged.

import { failKind } from "./inpaint_status.js";
import { referenceName } from "./reftokens.js";
import { fusedSize, tileBoxes } from "./inpaint_edges.js";
import { DEPTH_LARGE, modelSize, roundHalfEven } from "./inpaint_depth.js";
import { INTERACTIVE } from "./inpaint_pool.js";
import { editorPool } from "./inpaint_jobs.js";
import { RUN_GOING } from "./host_util.js";

export const HostHelpersPart = {
    // ---- in-app helpers: SAM2 objects and background removal through ONNX Runtime -----------
    //
    // The main process (electron/main/onnx) holds the models; the renderer scales the
    // source to the model's 1024 × 1024 input with Canvas 2D and scales the answer back.
    // The editor asks through objectBackendAvailable() / ensureObjects() and
    // availableCutoutBackends() / cutoutLayer(); when
    // no in-app model is present, the ComfyUI helper prompts run as in the node.

    /** @type {{ models: any[], sam2?: any, matting?: any, inpaint?: any, runtime?: any, depth?: any }} */
    helpers: { models: [], sam2: null, matting: null, inpaint: null, runtime: null, depth: null },
    onHelpersChanged: null,   // set by the shell: (status) => void

    /** Ask the main process what is downloaded and refresh the editors' model lists. */
    async refreshHelpers() {
        try { this.helpers = await window.scumble.helpers.status(); } catch (err) { console.warn("helpers status", err); this.helpers = { models: [] }; }
        for (const ed of this._editors) { try { ed.refreshCutoutBackends(); } catch (_) { /* not built yet */ } }
        if (this.onHelpersChanged) { try { this.onHelpersChanged(this.helpers); } catch (err) { console.warn(err); } }
        return this.helpers;
    },

    // ---- language models on the provider keys (electron/main/llm.js) ----------------

    llms: [],   // [{ id, provider, model, label, key }] from the main process
    // settings.llm.refPictures (absent = on): an upsample shows the language model the reference images the prompt
    // names (docs/PLAN_REFS.md 26d2); main enforces the setting where the request leaves, this only saves the drawing
    llmRefPictures: true,

    /** Which API language models have a key, then refresh the editors' upsample lists. */
    async refreshLLMs() {
        try { this.llms = await window.scumble.llm.list(); } catch (err) { console.warn("llm list", err); this.llms = []; }
        for (const ed of this._editors) { try { ed.refreshSegmentBackends(); } catch (_) { /* not built yet */ } }
        return this.llms;
    },

    /** Upsample backends in the shape of the editor's UPSAMPLE_BACKENDS entries (id "app:<provider>:<model>"). */
    upsampleBackends() {
        return this.llms.filter((l) => l.key).map((l) => ({ id: "app:" + l.id, label: l.label, inApp: true, llm: l.id, needs: [] }));
    },

    /**
     * One question to an API language model with a canvas in view; { text, seconds, note, pictures }. `images`: the
     * reference pictures to show it too, [{ png, label }] (`llmPictures`); main sends at most six.
     */
    async askLLM(backend, instruction, canvas, images = []) {
        let image = null;
        if (canvas) {
            const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
            image = new Uint8Array(await blob.arrayBuffer());
        }
        try {
            return await window.scumble.llm.ask({ id: backend.llm, instruction, image, ...(images && images.length ? { images } : {}) });
        } catch (err) {
            // strip Electron's "Error invoking remote method 'llm:ask': Error: " wrapper
            throw new Error(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
        }
    },

    /**
     * Prompt upsampling through an API language model. Called by the editor's
     * upsamplePrompt() with upsamplePending set; hands the text to applyTextResult like
     * the ComfyUI path does through the InpaintCanvasTextOut event. Throws on failure
     * (the editor's catch resets the pending state).
     */
    async upsampleInApp(editor, backend, instruction, refs = []) {
        // the pictures of the references the prompt names (26d2), unless the setting keeps them back
        const images = this.llmRefPictures && refs.length ? await this.llmPictures(editor, refs) : [];
        const res = await this.askLLM(backend, instruction, await editor.promptContextCanvas(), images);
        if (!editor.upsamplePending) return;   // cancelled meanwhile
        editor.applyTextResult({ text: res.text });
        const pics = res.pictures ? `, ${res.pictures} reference picture${res.pictures === 1 ? "" : "s"}` : "";
        // "crop only": the model took no reference picture; "text only": it refused every picture and answered on the words alone
        const note = res.note ? `, ${res.note}` : "";
        editor.setStatus(editor.status.replace(/\.$/, "") + ` (${backend.label.replace(/ \(.*\)$/, "")}, ${res.seconds.toFixed(1)} s${pics}${note}).`, res.note ? "warn" : (editor.statusKind || "info"));
    },

    /**
     * The pictures of the references an upsample names (26d2): at most six, in label order, each layer drawn with its
     * mask at 512 px on its long side at most (from the tiles' thumbnails on tiles: never a full-size mirror), as PNG
     * bytes after a label with its token and name. A layer without pixels is left out. App only: the editor never
     * calls it.
     * @param {any} editor
     * @param {{ id: string, n: number, name: string }[]} refs  sorted by label
     * @returns {Promise<{ png: Uint8Array, label: string }[]>}
     */
    async llmPictures(editor, refs) {
        const out = [];
        for (const r of (refs || []).slice(0, 6)) {
            const layer = editor.layers.find((l) => l.id === r.id);
            if (!layer || !layer.px) continue;
            const s = Math.min(1, 512 / Math.max(layer.px.width, layer.px.height));
            const w = Math.max(1, Math.round(layer.px.width * s)), h = Math.max(1, Math.round(layer.px.height * s));
            const c = document.createElement("canvas");
            c.width = w;
            c.height = h;
            editor.drawLayerFitted(c.getContext("2d"), layer, 0, 0, w, h);
            const blob = await new Promise((res) => c.toBlob(res, "image/png"));
            if (blob) out.push({ png: new Uint8Array(await blob.arrayBuffer()), label: referenceName(r) });
        }
        return out;
    },

    /**
     * One call into the in-app helper models (`objects`, `segment`, `cutout`, `inpaint`, `warmInpaint`); one member, so
     * a gate can stand in for it.
     */
    helperCall(name, args) {
        const p = window.scumble.helpers[name](args);
        // the calls in flight, for the shell's fallback line (shell.js helpers.onNotice: shown again after their own lines)
        this.helperCalls = (this.helperCalls || 0) + 1;
        const done = () => {
            this.helperCalls--;
            if (!this.helperCalls) for (const fn of this.helpersIdle.splice(0)) { try { fn(); } catch (err) { console.warn(err); } }
        };
        Promise.resolve(p).then(done, done);
        return p;
    },
    helperCalls: 0,
    /** @type {Array<() => void>} */
    helpersIdle: [],

    /** Resolves once no helper call is in flight (at once when none is). */
    whenHelpersIdle() {
        return this.helperCalls ? new Promise((resolve) => this.helpersIdle.push(() => resolve(undefined))) : Promise.resolve();
    },

    presentHelpers(kind) {
        return (this.helpers.models || []).filter((m) => m.kind === kind && m.present);
    },

    /** The SAM2 model the object tool uses: the chosen one when present, else the first present. */
    sam2Model() {
        const all = this.presentHelpers("sam2");
        return all.find((m) => m.id === this.helpers.sam2) || all[0] || null;
    },

    objectsInApp() {
        return !!this.sam2Model();
    },

    /** Cutout backends in the shape of the editor's CUTOUT_BACKENDS entries (id "app:<model>"). */
    cutoutBackends() {
        return this.presentHelpers("matting").map((m) => ({ id: "app:" + m.id, label: `${m.label} (in-app)`, inApp: true, model: m.id, needs: [] }));
    },

    /** The Remove tool is in the app (LaMa in-app, PLAN_0_1_31 §5 step 3); the node has none. */
    removeSupported: true,

    /** Depth map computation is supported in Scumble (R1-S1 / R1-S3). */
    depthSupported: true,

    /**
     * @img1, @img2 in the prompt name the shown reference layers, and their numbers follow the layers through every
     * change (docs/PLAN_REFS.md); the node keeps its positional "ref N" until a node release.
     */
    refTokens: true,

    /** The app's Boxes plugin owns the boxes (plugins/boxes); the node's editor owns them itself (docs/PLAN_NODE_BOXES.md D5). */
    boxesInEditor: false,

    /** The inpaint model the Remove tool runs (LaMa): the chosen one when present, else the first present, else null. */
    removeModel() {
        const all = this.presentHelpers("inpaint");
        return all.find((m) => m.id === this.helpers.inpaint) || all[0] || null;
    },

    /**
     * Remove: the picture and the hole at the model's size (RGBA and bytes, 512²) through the in-app model ->
     * { image (RGBA 512²), size, seconds, runMs, provider, model, label }.
     */
    async removeInApp(editor, req) {
        const m = this.removeModel();
        if (!m) throw new Error("Remove needs the LaMa model: download it in Settings › Helpers (in-app models).");
        // no `helperUsed`: LaMa runs on the CPU in its own process and holds no VRAM, so a local run need not free it
        return this.helperCall("inpaint", { model: m.id, image: req.image, mask: req.mask });
    },

    /**
     * Load the Remove model ahead of the first stroke (about 9 s on the CPU): the tool asks when it is picked.
     * -> { ready, seconds, provider } or { ready: false, error }; null without a model. Never throws.
     */
    async warmRemove(editor) {
        const m = this.removeModel();
        if (!m) return null;
        try { return await this.helperCall("warmInpaint", { model: m.id }); }
        catch (err) { return { ready: false, error: String(err && err.message || err) }; }
    },

    /** What a helper looks at, as a canvas: the flattened image, or one layer on neutral grey. */
    sourceCanvas(editor, layer) {
        if (!layer) return editor.flattenToCanvas({ forRun: true });
        const c = document.createElement("canvas");
        c.width = editor.width; c.height = editor.height;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#808080";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(editor.layerPixels(layer), layer.x, layer.y, layer.w, layer.h);
        return c;
    },

    /**
     * The object tool's model input, 1024 x 1024 RGBA bytes: the flattened image, or one layer on neutral grey, squashed
     * (C6 c5 slice 6). On tiles it is read from levels: one uniform region pass at `max(1024 / W, 1024 / H)` (so no axis
     * is scaled up and filters run on an unsquashed picture), with its chains built in the mips worker, then the squash.
     * It was one or two full-resolution flattens, or a whole-layer copy, for a 4 MB input: at 15000 x 10000 over 1.7 GB of
     * canvases and mirrors each time the map was checked. On canvases it is the old picture, byte for byte.
     */
    async objectInput(editor, layer) {
        const W = editor.width, H = editor.height;
        if (!editor.tileMode) {
            if (!layer && editor.relightIdle) await editor.relightIdle();   // as sampleRegionSettled waits on tiles (F2.7)
            return this.modelInput(this.sourceCanvas(editor, layer), 1024, null);
        }
        const s = Math.min(1, Math.max(1024 / W, 1024 / H));
        if (!layer) return this.modelInput(await editor.sampleRegionSettled("image", [0, 0, W, H], s, { forRun: true }), 1024, null);
        const px = layer.px;
        const tiled = layer.kind !== "filter" && px && typeof px.primeRegion === "function" && !editor.liveStrokeOn(layer) && (!layer.maskPx || editor.tileMaskOf(layer));
        if (!tiled) return this.modelInput(this.sourceCanvas(editor, layer), 1024, null);
        const tw = Math.max(1, Math.round(W * s)), th = Math.max(1, Math.round(H * s));
        // the layer and its mask at the pass's level, in a scratch of their own (a destination-in over the grey would cut it)
        const fx = layer.w / px.width, fy = layer.h / px.height;
        const rect = [-layer.x / fx, -layer.y / fy, (W - layer.x) / fx, (H - layer.y) / fy];
        const level = editor.tileLevel(fx * s);
        const jobs = await Promise.all([px, layer.maskPx].filter(Boolean).map((q) => q.primeRegion(rect, level)));
        try {
            const scratch = document.createElement("canvas");
            scratch.width = tw; scratch.height = th;
            const x = scratch.getContext("2d");
            x.imageSmoothingEnabled = true;
            x.setTransform(s, 0, 0, s, 0, 0);
            const vp = { x: 0, y: 0, w: W, h: H, sx: s, sy: s, sample: true };
            editor.drawPixelsInto(x, layer, layer.px, vp);
            if (layer.maskPx) {
                x.globalCompositeOperation = "destination-in";
                editor.drawPixelsInto(x, layer, layer.maskPx, vp);
            }
            const c = document.createElement("canvas");
            c.width = tw; c.height = th;
            const ctx = c.getContext("2d");
            ctx.fillStyle = "#808080";
            ctx.fillRect(0, 0, tw, th);
            ctx.drawImage(scratch, 0, 0);
            return this.modelInput(c, 1024, null);
        } finally {
            for (const j of jobs) j.release();
        }
    },

    /**
     * The cutout model's input, 1024 x 1024 RGBA bytes: the layer's own pixels (no mask), squashed onto black. On tiles
     * from the layer's levels at the larger of the two squash scales (slice 6); it was a whole-layer `toCanvas()`, 572 MB
     * for a 15000 x 10000 image layer. On canvases `toCanvas()` is the layer canvas itself, as before.
     */
    async cutoutInput(editor, layer) {
        const px = layer.px;
        if (!editor.tileMode || typeof px.primeRegion !== "function") return this.modelInput(px.toCanvas(), 1024, "#000000");
        const pw = px.width, ph = px.height;
        const s = Math.min(1, Math.max(1024 / pw, 1024 / ph));
        const job = await px.primeRegion([0, 0, pw, ph], editor.tileLevel(s));
        try {
            if (layer.px !== px) return this.modelInput(layer.px.toCanvas(), 1024, "#000000");
            const c = document.createElement("canvas");
            c.width = 1024; c.height = 1024;
            const ctx = c.getContext("2d");
            ctx.fillStyle = "#000000"; ctx.fillRect(0, 0, 1024, 1024);
            ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
            ctx.setTransform(1024 / pw, 0, 0, 1024 / ph, 0, 0);
            editor.drawTilesInto(ctx, px, 0, 0, pw, ph, { x: 0, y: 0, w: pw, h: ph, sx: s, sy: s });
            return new Uint8Array(ctx.getImageData(0, 0, 1024, 1024).data.buffer);
        } finally {
            job.release();
        }
    },

    /** The key an object map and its SAM2 embedding are cached under: a hash of the model input itself. */
    async inputHash(image) {
        const d = new Uint8Array(await crypto.subtle.digest("SHA-1", image));
        let h = "";
        for (let i = 0; i < 10; i++) h += d[i].toString(16).padStart(2, "0");
        return h;
    },

    /** RGBA bytes of a source drawn (squashed) into size × size, on `background` where it is transparent. */
    modelInput(source, size, background) {
        const c = document.createElement("canvas");
        c.width = size; c.height = size;
        const ctx = c.getContext("2d");
        if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, size, size); }
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
        ctx.drawImage(source, 0, 0, size, size);
        return new Uint8Array(ctx.getImageData(0, 0, size, size).data.buffer);
    },

    /**
     * Document picture input without filter layers (or with them if skipFilters: false):
     * For depth estimation, fresh fingerprints, and other photo-derived inputs (PLAN_NIK9_BUILD.md §F5).
     * On tiles: one sampleRegionSettled pass over the whole picture at s = min(1, max(w / W, h / H)) with forRun: true,
     * drawn into a w x h canvas, then RGBA bytes.
     * On canvases: a plain draw of flattenToCanvas({ forRun: true, skipFilters }).
     */
    async pictureInput(editor, w, h, { skipFilters = true, background = null } = {}) {
        const W = editor.width, H = editor.height;
        if (!W || !H) throw new Error("empty document");
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d");
        if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, w, h); }
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
        if (editor.tileMode) {
            const s = Math.min(1, Math.max(w / W, h / H));
            const sample = await editor.sampleRegionSettled("image", [0, 0, W, H], s, { forRun: true, skipFilters });
            ctx.drawImage(sample, 0, 0, w, h);
        } else {
            if (editor.relightSettled) await editor.relightSettled();
            const flat = editor.flattenToCanvas({ forRun: true, skipFilters });
            ctx.drawImage(flat, 0, 0, w, h);
        }
        const image = new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer);
        return { image, width: w, height: h };
    },

    /**
     * The object map for the hover tool from SAM2 in-app. Called by the editor's
     * ensureObjects() with the source hash and layer; fills editor.objects through
     * applySegmentIds like the ComfyUI path does through applySegmentsFile.
     */
    async findObjects(editor, pending) {
        const model = this.sam2Model();
        if (!model) { editor.objectsPending = null; editor.setStatus("No SAM2 model is downloaded (Settings › Helpers).", "warn"); return; }
        try {
            // slice 6: the key is a hash of the model input, not of an uploaded full-resolution PNG (nothing is uploaded
            // on this path any more). Equal inputs share the map and the embedding; an undo back to the same picture too.
            const version = editor.compositeVersion;
            const image = await this.objectInput(editor, pending.layer);
            const hash = (pending.layer ? `layer:${pending.layer.id}:` : "image:") + await this.inputHash(image);
            pending = { ...pending, hash };
            const W = editor.width, H = editor.height;
            const o = editor.objects;
            if (o && o.hash === hash && o.w === W && o.h === H) { o.version = version; editor.objectsPending = null; return; }
            editor.objectsPending = { stage: "run", ...pending };
            editor.setStatus(`Finding objects with ${model.label} (in-app) ...`);
            const s = Math.min(1, 2048 / Math.max(W, H));
            const outW = Math.max(1, Math.round(W * s)), outH = Math.max(1, Math.round(H * s));
            editor.helperUsed = true;   // the ONNX sessions hold VRAM; freed before a local run like the ComfyUI helpers
            const res = await this.helperCall("objects", { model: model.id, key: `${editor.node.id}:${pending.hash}`, image, outWidth: outW, outHeight: outH });
            if (editor.objectsPending && editor.objectsPending.hash !== pending.hash) return;   // a newer request took over
            let ids;
            if (res.width === W && res.height === H) {
                ids = new Uint16Array(res.ids.buffer, res.ids.byteOffset, W * H);
            } else {
                ids = new Uint16Array(W * H);
                const sx = res.width / W, sy = res.height / H;
                for (let y = 0; y < H; y++) {
                    const row = Math.min(res.height - 1, Math.floor((y + 0.5) * sy)) * res.width, o = y * W;
                    for (let x = 0; x < W; x++) ids[o + x] = res.ids[row + Math.min(res.width - 1, Math.floor((x + 0.5) * sx))];
                }
            }
            editor.objectsPending = null;
            editor.applySegmentIds(ids, W, H, res.count, pending);
            if (editor.objects) editor.objects.version = version;   // the hover's staleness test (updateObjectHover)
            editor.setStatus(`${res.count} objects found with ${model.label} in ${res.seconds.toFixed(1)} s (${res.provider}). Hover to preview, click to select, click again to deselect (Shift adds, Alt subtracts, Shift+Alt intersects).${this.slowHelperHint(res)}`);
        } catch (err) {
            console.error(err);
            editor.objectsPending = null;
            editor.setStatus("Object detection failed: " + (err.message || err), failKind(err));
        }
    },

    /**
     * Background removal of one layer in-app. Called by the editor's cutoutLayer() with
     * cutoutPending already set; returns a grayscale canvas (white = keep) at the model
     * size that applyCutoutImage scales onto the layer.
     */
    async cutoutInApp(editor, layer, backend) {
        const model = (this.helpers.models || []).find((m) => m.id === backend.model);
        if (!model || !model.present) throw new Error(`${backend.label} is not downloaded any more (Settings › Helpers).`);
        // like the ComfyUI path: the layer's own pixels, transparent parts on black
        const image = await this.cutoutInput(editor, layer);
        editor.helperUsed = true;
        const res = await this.helperCall("cutout", { model: model.id, image });
        const c = document.createElement("canvas");
        c.width = res.size; c.height = res.size;
        const ctx = c.getContext("2d");
        const out = ctx.createImageData(res.size, res.size);
        const d = out.data;
        for (let i = 0, j = 0; i < res.alpha.length; i++, j += 4) { const a = res.alpha[i]; d[j] = a; d[j + 1] = a; d[j + 2] = a; d[j + 3] = 255; }
        ctx.putImageData(out, 0, 0);
        editor.setStatus(`${layer.name}: background removed with ${model.label} in ${res.seconds.toFixed(1)} s (${res.provider}).`);
        const hint = this.slowHelperHint(res);
        if (hint) setTimeout(() => editor.setStatus(editor.status + hint, editor.statusKind || "info"), 50);   // after applyCutoutImage's own status line
        return c;
    },

    /**
     * Cache key for SAM2 embeddings: reuses editor.objects.hash when it matches;
     * else ${editor.node.id}: + (layer ? layer:${layer.id}: : "image:") + inputHash(objectInput(editor, layer));
     * cached per compositeVersion.
     */
    async segmentKey(editor, layer) {
        const o = editor.objects;
        const matchesLayer = layer ? (o && o.layerId === layer.id) : (o && o.layerId == null);
        if (matchesLayer && o.hash && o.w === editor.width && o.h === editor.height) {
            return { key: `${editor.node.id}:${o.hash}`, image: null };
        }
        const cache = editor._segmentKeyCache;
        const layerKey = layer ? `layer:${layer.id}` : "image";
        if (cache && cache.version === editor.compositeVersion && cache.layerKey === layerKey) {
            return { key: cache.key, image: cache.image || null };
        }
        const image = await this.objectInput(editor, layer);
        const hash = (layer ? `layer:${layer.id}:` : "image:") + await this.inputHash(image);
        const key = `${editor.node.id}:${hash}`;
        editor._segmentKeyCache = { version: editor.compositeVersion, layerKey, key, image };
        return { key, image };
    },

    /**
     * Segment logits using SAM2: helpers:segment with raw: true, key, points/box in 1024 space.
     * The image is sent only when main lost the embedding.
     */
    async segmentLogits(editor, points = [], box = null, layer = null) {
        const model = this.sam2Model();
        if (!model) throw new Error("no SAM2 model is downloaded (Settings > Helpers)");
        const W = editor.width, H = editor.height;
        const pts = points.map((p) => ({ x: (p.x / W) * 1024, y: (p.y / H) * 1024, label: p.label == null ? 1 : p.label }));
        const bx = box ? [(box[0] / W) * 1024, (box[1] / H) * 1024, (box[2] / W) * 1024, (box[3] / H) * 1024] : null;
        const keyInfo = await this.segmentKey(editor, layer);
        const key = keyInfo.key;
        let res;
        try {
            res = await this.helperCall("segment", { model: model.id, key, points: pts, box: bx, raw: true });
        } catch (err) {
            // embedding gone (freed, restarted): encode again from the same source
            const image = keyInfo.image || await this.objectInput(editor, layer);
            res = await this.helperCall("segment", { model: model.id, key, image, points: pts, box: bx, raw: true });
        }
        return { logits: res.logits, n: res.n || 256, score: res.score };
    },

    /** Backward-compatibility wrapper for segmentLogits */
    async segmentPoint(editor, points, box) {
        return this.segmentLogits(editor, points, box);
    },

    /**
     * Drag a box with the Object tool: segment with SAM2 box prompt and combine into selection.
     */
    async selectBox(editor, box, { mode = "replace" } = {}) {
        if (editor.objectsPending || editor._pointPending) return;
        if (editor.providerPending && editor.providerPending.resizes) { editor.setStatus(RUN_GOING); return; }
        editor._pointPending = true;
        try {
            editor.setStatus("Segmenting what SAM2 sees in the box ...");
            const layer = editor.objects && editor.objects.layerId != null
                ? editor.layers.find((l) => l.id === editor.objects.layerId)
                : (editor.segSourceSel && editor.segSourceSel.value === "active layer" ? (editor.activeLayer ? editor.activeLayer() : null) : null);
            const res = await this.segmentLogits(editor, [], box, layer);
            await editor.selectLogits(res, { mode, label: "Object selection", layer, box });
        } catch (err) {
            console.error(err);
            editor.setStatus("Box segmentation failed: " + (err.message || err), failKind(err));
        } finally {
            editor._pointPending = false;
        }
    },

    /**
     * Object tool, click where the object map has nothing: segment with one SAM2 point
     * prompt and toggle that mask in the selection (Shift adds, Alt subtracts, Shift+Alt intersects,
     * otherwise a click on a selected pixel subtracts). Called by the editor's toggleObjectAt().
     */
    async selectPoint(editor, ix, iy, p = {}) {
        if (editor.objectsPending || editor._pointPending) return;
        // a run that resizes the document holds it: the mask would land in the old geometry
        if (editor.providerPending && editor.providerPending.resizes) { editor.setStatus(RUN_GOING); return; }
        editor._pointPending = true;
        try {
            editor.setStatus("Segmenting what is under the cursor with SAM2 ...");
            const layer = editor.objects && editor.objects.layerId != null
                ? editor.layers.find((l) => l.id === editor.objects.layerId)
                : (editor.segSourceSel && editor.segSourceSel.value === "active layer" ? (editor.activeLayer ? editor.activeLayer() : null) : null);
            const res = await this.segmentLogits(editor, [{ x: ix, y: iy, label: 1 }], null, layer);
            const x = Math.floor(ix), y = Math.floor(iy);
            const already = editor.sel.readRect(x, y, 1, 1).data[3] > 0;
            let mode;
            if (p.shift && p.alt) mode = "intersect";
            else if (p.alt) mode = "subtract";
            else if (p.shift) mode = "add";
            else mode = already ? "subtract" : "add";
            await editor.selectLogits(res, { mode, label: "Object selection", layer, point: [ix, iy] });
        } catch (err) {
            console.error(err);
            editor.setStatus("Point segmentation failed: " + (err.message || err), failKind(err));
        } finally {
            editor._pointPending = false;
        }
    },

    /** The depth model (Depth Anything V2 Small): the chosen one when present, else the first present. */
    depthModel() {
        const all = this.presentHelpers("depth");
        return all.find((m) => m.id === this.helpers.depth) || all[0] || null;
    },

    /**
     * Document input for depth estimation (delegates to pictureInput with skipFilters: true and #808080 background).
     */
    async depthInput(editor, w, h) {
        return this.pictureInput(editor, w, h, { skipFilters: true, background: "#808080" });
    },

    /**
     * Compute depth map via helperCall("depth").
     */
    async computeDepth(editor, req) {
        return this.depthInApp(editor, req);
    },

    /**
     * Run Depth Anything V2 Small helper on image:
     * -> { depth: Float32Array, min: number, max: number, ms: number, provider: string }
     */
    async depthInApp(editor, { image, width, height }) {
        const model = this.depthModel();
        if (!model) throw new Error("No depth model is downloaded (Settings › Helpers)");
        const res = await this.helperCall("depth", {
            model: model.id,
            image,
            width,
            height,
        });
        editor.helperUsed = true;
        return res;
    },

    /**
     * Document picture input cropped to a bounding box, without filter layers (or with them if skipFilters: false).
     * @param {any} editor
     * @param {{ x0: number, y0: number, x1: number, y1: number } | number[]} box
     * @param {number} w
     * @param {number} h
     * `upTo` (the Key screen's Re-key, docs/PLAN_CORRIDORKEY.md §4.5): only the layers below that index, as a filter's
     * own input reads them; nothing is hidden for the read.
     * @param {{ skipFilters?: boolean, background?: string | null, upTo?: number | null }} [opts]
     */
    async pictureInputBox(editor, box, w, h, { skipFilters = true, background = null, upTo = null } = {}) {
        const W = editor.width, H = editor.height;
        if (!W || !H) throw new Error("empty document");
        const bx0 = Array.isArray(box) ? box[0] : box.x0;
        const by0 = Array.isArray(box) ? box[1] : box.y0;
        const bx1 = Array.isArray(box) ? box[2] : box.x1;
        const by1 = Array.isArray(box) ? box[3] : box.y1;
        const bw = bx1 - bx0, bh = by1 - by0;
        if (bw <= 0 || bh <= 0) throw new Error("empty box for pictureInputBox");

        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d");
        if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, w, h); }
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
        if (editor.tileMode) {
            const s = Math.min(1, Math.max(w / bw, h / bh));
            const sample = await editor.sampleRegionSettled("image", [bx0, by0, bx1, by1], s, upTo == null ? { forRun: true, skipFilters } : { forRun: true, skipFilters, upTo });
            ctx.drawImage(sample, 0, 0, w, h);
        } else {
            if (editor.relightSettled) await editor.relightSettled();
            const flat = editor.flattenToCanvas(upTo == null ? { forRun: true, skipFilters } : { forRun: true, skipFilters, upTo });
            ctx.drawImage(flat, bx0, by0, bw, bh, 0, 0, w, h);
        }
        const image = new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer);
        return { image, width: w, height: h };
    },

    /**
     * Compute a detailed depth map by tiling and fusing or large input (PLAN_NIK9_BUILD.md R2-S7).
     * @param {any} editor
     * @param {{ grid?: number, route?: string, onProgress?: (i: number, n: number) => void, signal?: AbortSignal, global?: any }} [opts]
     */
    async depthDetail(editor, { grid = 2, route = "tiles", onProgress = null, signal = null, global = null } = {}) {
        const W = editor.width, H = editor.height;
        if (!W || !H) throw new Error("empty document");
        const model = this.depthModel();
        if (!model) throw new Error("No depth model is downloaded (Settings > Helpers)");

        if (route === "large") {
            const scale = DEPTH_LARGE / Math.max(W, H);
            const mw = Math.max(14, roundHalfEven((W * scale) / 14) * 14);
            const mh = Math.max(14, roundHalfEven((H * scale) / 14) * 14);
            const inp = await this.pictureInput(editor, mw, mh, { skipFilters: true, background: "#808080" });
            if (signal && signal.aborted) return null;
            const res = await this.computeDepth(editor, { image: inp.image, width: mw, height: mh });
            if (onProgress) onProgress(1, 1);
            if (signal && signal.aborted) return null;
            return { data: res.depth, w: mw, h: mh, fits: [], route: "large", grid: 1 };
        }

        const boxes = tileBoxes(W, H, grid);
        const n = boxes.length;
        const tiles = [];
        const [mw, mh] = modelSize(W, H);

        for (let i = 0; i < n; i++) {
            if (signal && signal.aborted) return null;
            if (onProgress) onProgress(i + 1, n);
            const box = boxes[i];
            const inp = await this.pictureInputBox(editor, box, mw, mh, { skipFilters: true, background: "#808080" });
            if (signal && signal.aborted) return null;
            const raw = await this.computeDepth(editor, { image: inp.image, width: mw, height: mh });
            editor.helperUsed = true;
            if (signal && signal.aborted) return null;
            tiles.push({
                box,
                data: raw.depth,
                w: mw,
                h: mh,
            });
        }

        const [wf, hf] = fusedSize(W, H, boxes, 518);
        const globalCopy = {
            data: global && global.data ? (global.data.slice ? global.data.slice() : new Float32Array(global.data)) : new Float32Array(wf * hf),
            w: global ? global.w : mw,
            h: global ? global.h : mh,
        };
        const tileBuffers = tiles.map((t) => t.data.buffer);
        const transfer = [globalCopy.data.buffer, ...tileBuffers];

        const fused = await editorPool().run("depth_fuse", {
            global: globalCopy,
            tiles,
            W,
            H,
            wf,
            hf,
        }, transfer, { priority: INTERACTIVE, timeout: 300000 });

        if (signal && signal.aborted) return null;

        const fusedData = fused.data instanceof Float32Array ? fused.data : new Float32Array(fused.data);
        return {
            data: fusedData,
            w: wf,
            h: hf,
            fits: fused.fits || [],
            route: "tiles",
            grid,
        };
    },

    /**
     * A GPU run that took far longer than it should: the card is most likely full with
     * ComfyUI's models (measured: 125 s instead of 1.6 s with 29 of 32 GB in use), and
     * DirectML pages through system memory. Say what helps.
     */
    slowHelperHint(res) {
        if (!res || res.seconds < 15 || res.provider === "cpu") return "";
        return this.connected
            ? " Slow: the GPU memory is probably full with ComfyUI's models; Free VRAM (also unloads them on the server) or set the helper device to CPU in Settings."
            : " Slow: the GPU memory is probably full; close what else uses it, or set the helper device to CPU in Settings.";
    },

    /**
     * Release the in-app models (VRAM); the editor's "Free VRAM" button and the pre-run free
     * call this. The button is the user asking for memory now, so the caches of every other
     * tab go too (the button's own tab released its own, compositor and GL pool included,
     * before calling here); docs/PLAN_TILES.md phase A, item 5.
     */
    async freeHelpers() {
        for (const ed of this._editors) {
            if (ed === this.editor || ed.pointer) continue;
            try { ed.releaseCaches({ deep: true, mirrors: true }); } catch (err) { console.warn(err); }
        }
        return window.scumble.helpers.free();
    },
};
