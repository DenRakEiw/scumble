// Inpaint Canvas - layered canvas editor for ComfyUI.
//
// The node itself only shows a thumbnail and a button. The editor opens as a
// full-window overlay so it never fights litegraph for pointer or wheel
// events. Responsibilities of this file:
//   * the editor (layers, selection tools, paint tools, transform, pan/zoom, undo,
//     control layers, reference layers, layer masks / cutouts, outpainting, result history)
//   * persisting the canvas state in the workflow (widget value)
//   * on queue: flatten visible layers + selection mask (+ control layers), upload
//     them, and put a small JSON into the prompt as `canvas_state`
//   * strip the `result` back-link from the prompt (it would be a cycle) and
//     pass its source as `result_source`
//   * receive stitched results from the backend and add them as layers

import { api, host } from "./host.js";
import { loadFontList } from "./inpaint_text.js";
import { setKernels, kernelsMode, liquifyDab } from "./px/kernels.js";
import { LayerPixels, canvasOf, displayCanvasIfMade, deprecatedPixels } from "./inpaint_pixels.js";
import { pngPartsOf, readPngParts } from "./inpaint_png.js";
import { releaseBoxBuffers } from "./inpaint_boxstack.js";
import { TIFF_EXT, tiffPlan, readTiffBand, readTiffBands } from "./inpaint_tiff.js";
import { pixelsBackend, isTilePixels, scratchStats, TILE_SIZE, MIP_LEVELS, chainScheduler } from "./inpaint_tiles.js";
import { JOB_TIMINGS, STEP_MARKS, workerCall, editorPool, buildLayered, measureGen, pendingJobs, resetPool } from "./inpaint_jobs.js";
import { buildEditorModal } from "./inpaint_modal.js";
import { encodeCanvas, canvasToBlob, partsUsable, encodeTilePixels, encodeBands } from "./inpaint_encode.js";
import { uploadBlob, uploadCanvas, uploadPixels } from "./inpaint_upload.js";
import { LAYERED_EXT } from "./inpaint_layered.js";
import { THEME } from "./inpaint_theme.js";
import { labelMap, remap } from "./reftokens.js";
import { BLEND_MODES } from "./blend_modes.js";
import { pxCalls, kernelRoutes, setRoute as setKernelRoute, pxTimed, pxSplit, pxInstances } from "./px/kernels.js";
import { statusKindFor, failKind } from "./inpaint_status.js";
import { RunProgress } from "./inpaint_progress.js";
import { BRUSH_MAX, CURSOR_CLASSES, HANDLE_PX, MAX_UNDO, MAX_UNDO_BYTES, NODE_CLASS, REF_DEFAULTS, REF_FITS, RELIGHT_LIGHT_TYPES, RELIGHT_STYLES, RULER_PX, RUN_GOING_TEXT, SEL_BOX_MAX_PX, SIDE_DEFAULT_PX, SIDE_MAX_SHARE, SIDE_MIN_PX, STITCH_CLASS, TAIL_OUTPUTS, brushSizeToSlider, sliderToBrushSize, editorTileMode, hostText, makeCanvas } from "./inpaint_consts.js";
import { DISSOLVE_CLIP_SHADER, DISSOLVE_SHADER } from "./inpaint_shaders.js";
import { el, icon, iconButton, miniButton, numberInput, selectGrouped, selectInput, setFieldText } from "./inpaint_dom.js";
import { CROP_DEFAULTS, FIXED_OUTPUTS, GEN_DEFAULTS, SETTING_SLOTS, UPSAMPLE_CASES, isSettingOutput, linkOf, randomSeed, settingIndex } from "./inpaint_backends.js";
import { STYLE, injectStyle } from "./inpaint_style.js";
import { hugePngSize, imageFileSize, loadImageEl, pixelsFromTiff, pixelsOffThread, viewUrl, bindLoad } from "./inpaint_load.js";
import { PanelsPart } from "./inpaint_ed_panels.js";
import { LayersPart } from "./inpaint_ed_layers.js";
import { HistoryPanelPart } from "./inpaint_ed_histpanel.js";
import { TextPart } from "./inpaint_ed_text.js";
import { installParts } from "./inpaint_parts.js";
import { TipsPart } from "./inpaint_ed_tips.js";
import { HealPart, bindHeal } from "./inpaint_ed_heal.js";
import { LiquifyPart, bindLiquify } from "./inpaint_ed_liquify.js";
import { ShapePart, bindShape } from "./inpaint_ed_shape.js";
import { SelectPart, bindSelect } from "./inpaint_ed_select.js";
import { StackPart, bindStack } from "./inpaint_ed_stack.js";
import { SegmentPart } from "./inpaint_ed_segment.js";
import { MasksPart } from "./inpaint_ed_masks.js";
import { GeometryPart } from "./inpaint_ed_geometry.js";
import { PointerPart } from "./inpaint_ed_pointer.js";
import { DepthPart } from "./inpaint_ed_depth.js";
import { FiltersPart } from "./inpaint_ed_filters.js";
import { HistoryPart } from "./inpaint_ed_history.js";
import { PersistPart } from "./inpaint_ed_persist.js";
import { ExportPart, bindExport } from "./inpaint_ed_export.js";
import { OpenPart, bindOpen } from "./inpaint_ed_open.js";
import { StrokesPart, bindStrokes } from "./inpaint_ed_strokes.js";
import { DisplayPart, bindDisplay } from "./inpaint_ed_display.js";
import { CompositePart, bindComposite } from "./inpaint_ed_composite.js";
import { MatchPart } from "./inpaint_ed_match.js";
import { DrawPart } from "./inpaint_ed_draw.js";
import { RelightPart } from "./inpaint_ed_relight.js";

// ---------------------------------------------------------------------------
// the editor
// ---------------------------------------------------------------------------

// Copy in one tab, paste in another: the clipboard belongs to the module, not to an editor.
let CLIPBOARD = null;

class InpaintEditor {

    get clipboard() { return CLIPBOARD; }

    set clipboard(v) { CLIPBOARD = v; }

    /** The selection's canvas under its old name, for one release: use `sel` (MaskPixels). */
    get selection() {
        deprecatedPixels("editor.selection", "editor.sel");
        return this.sel ? this.sel.toCanvas() : null;
    }

    set selection(canvas) {
        deprecatedPixels("editor.selection", "editor.sel");
        this.sel = canvas ? this.pixels.Mask.fromCanvas(canvas) : null;
    }

    constructor(node) {
        this.node = node;
        // decided once, for the editor's life: every pixels object this editor makes (layers, masks,
        // the selection, the base, undo copies) is of this backend, so they can be blitted, cloned
        // and restored into each other (docs/PLAN_BCE.md §C2 step b)
        const mode = editorTileMode();
        this.tileMode = mode.on;
        this.tileModeFrom = mode.from;
        this.pixels = pixelsBackend(this.tileMode);   // { Layer, Mask, tiles }
        this.width = 0;
        this.height = 0;
        this.base = null;            // { ref, px }: the file in the mirror and its pixels (this.basePx)
        this.layers = [];            // { id, name, kind, role, blend, ref, px (LayerPixels), x, y, w, h, opacity, visible, dirty,
                                     //   maskPx (MaskPixels, alpha = visible) | null, maskRef, maskDirty, maskEdit }
        this.activeLayerId = null;   // null = base
        this.layerSel = new Set();   // Ctrl / Shift + click in the layer list: the layers selected with the active one (PLAN_0_1_31 §6.1)
        this.layerAnchorId = null;   // where a Shift + click range starts
        this.groups = [];            // { id, name, visible, locked, collapsed, parent }: folders of layers (PLAN_0_1_31 §6.5); a layer's `group` names its innermost
        this.activeGroupId = null;   // the group whose header row was clicked (its layers are the selection)
        this._solo = null;           // { ids, visible }: the layers shown alone, and what was visible before the first solo
        this.sel = null;             // MaskPixels WxH (red, alpha = selected); null before an image is loaded
        this._relightPending = new Set();
        this._relightMarches = 0;    // relight_shadow marches in flight over all layers (`relightMarching`, the K0b harness)
        this.history = [];           // { key, ref, x, y, w, h, prompt, layerId, thumb }
        this.view = { scale: 1, x: 0, y: 0, angle: 0 };
        this.guides = { x: [], y: [] };
        // what the whole-document operations add up to since the document was opened (PLAN_0_1_31 §7: turns, crops,
        // extends, resizes, straightens), as one map from the picture then to the picture now: an undo step and a snapshot
        // keep theirs, so a restore maps what no step holds (the results history, the saved selections) by the difference
        this.docXf = [1, 0, 0, 1, 0, 0];
        // the Canvas tool's pending frame (PLAN_0_1_31 §7, 23b: `frame()`), its aspect preset and the lines over it
        this.canvasFrame = null;
        this.frameAspect = "free";
        this.frameCustom = [4, 3];
        this.frameAspectFlip = false;
        this.frameStraighten = false;
        let overlay = "thirds";
        try { overlay = localStorage.getItem("ipc.cropOverlay") || "thirds"; } catch (_) { /* no storage */ }
        this.frameOverlay = ["thirds", "golden", "grid", "diagonal", "none"].includes(overlay) ? overlay : "thirds";
        let showRulers = false, showGrid = false, gridSize = 64;
        try { showRulers = localStorage.getItem("ipc.rulers") === "1"; showGrid = localStorage.getItem("ipc.grid") === "1"; gridSize = +localStorage.getItem("ipc.gridSize") || 64; } catch (_) { /* no storage */ }
        this.showRulers = showRulers;
        this.showGrid = showGrid;
        this.gridSize = gridSize;
        this.tool = "select";
        this.brushSize = 40;
        this.brushTips = [];        // imported tips: { id, name, canvas, spacing }
        this.brushTipId = "";       // "" = the built-in round tip
        this.brushTipSpacing = 0.25;
        this.onBrushTips = null;    // the host may set this to persist imported tips
        this.hardness = 1;
        this.eraseHardness = 0.5;       // the eraser is soft by default, like Krita's Eraser Soft
        try {
            const h = parseFloat(localStorage.getItem("ipc.hardness")), e = parseFloat(localStorage.getItem("ipc.eraseHardness"));
            if (h >= 0 && h <= 1) this.hardness = h;
            if (e >= 0 && e <= 1) this.eraseHardness = e;
        } catch (_) { /* no storage */ }
        this.brushOpacity = 1;
        this.brushFlow = 1;             // below 1 the stroke builds up where its stamps overlap (flowStamps)
        // the pen: its pressure curve and the stabiliser's string in screen pixels (0 off), kept like the hardness
        this.pressureCurve = "linear";
        this.stabiliser = 0;
        try {
            const pc = localStorage.getItem("ipc.pressureCurve"), st = +localStorage.getItem("ipc.stabiliser");
            if (pc === "soft" || pc === "hard" || pc === "linear") this.pressureCurve = pc;
            if (st > 0 && st <= 100) this.stabiliser = st;
        } catch (_) { /* no storage */ }
        this.color = "#ff3b30";
        this.fillEnclosed = true;
        this.promptText = "";
        this.cropSettings = { ...CROP_DEFAULTS };
        this.upsampleSettings = { useCase: "auto", backend: "auto" };
        this.genSettings = { ...GEN_DEFAULTS, seed: randomSeed() };
        this.negativeText = "";
        this.settings = {};             // {"1": {value, type, label}, ...} for the setting_n outputs
        this.refSettings = { ...REF_DEFAULTS };   // reference_images batch: long side, fit
        this.cutoutSettings = { backend: "auto" };
        this.cutoutPending = null;      // {layer, backend} while a background removal runs
        this.promptBackup = null;
        this.upsampleCheck = null;      // the last upsample's token check when it found something ({ dropped, invented, literals }, 26d1)
        // @img1, @img2 in the prompt name the shown reference layers (docs/PLAN_REFS.md C2): the labels they had at the
        // last change, by layer id, so the next change can rewrite them; null until the first document
        this.refMap = null;
        this._remapTargets = new Set();   // fields outside the editor whose text names references (addRemapTarget)
        this.refLayoutInfo = null;      // the app's reference layout for the chosen route: the name each reference goes as
        this.lastSentPrompt = null;     // the prompt main sent in the last provider run, the names written in
        this.lastRunNotes = [];         // what the last run's route declared it left out
        this.lastRunError = null;       // why the last Generate click was refused (commands.generate throws it)
        this.selectionLabel = "";       // what the selection is, when it came from "Select by text"
        this.undo = [];
        this.redo = [];
        this.historyGen = 0;            // bumped by every change an undo that is still loading its step must not run over
        this.maxUndo = MAX_UNDO;        // the history's depth: steps and bytes (the app's Settings › Memory sets them)
        this.maxUndoBytes = MAX_UNDO_BYTES;
        this.undoTrimmed = false;       // older steps were dropped since the last clear: the list's first row is not the start
        this.snapshots = [];            // named snapshots: [{ name, at, snap }] (turn snapshots, tiles only; not saved)
        this.selectionDirty = true;
        this.selectionLoose = false;   // cachedBounds is a superset of the selection, made exact on the next getBounds()
        this.selectionDataUrl = null;
        this.cachedBounds = null;
        this.compositeVersion = 0;      // bumped whenever the composite changes (filter caches key on it)
        this.pixelVersion = 0;          // bumped whenever a source canvas changed (the scene cache keys on it)
        this.pyramids = new WeakMap();  // source canvas -> cached downscaled levels for drawing
        this._pyramidBudget = Infinity; // new levels allowed in this frame (drawScene sets it to 1)
        this._pyramidPending = false;
        this.sceneCanvas = null;        // last composited view; overlays are drawn on top of it every frame
        this.sceneSig = null;
        this.viewCanvas = null;         // the visible region, composited at screen resolution
        this.viewPass = null;           // {x, y, w, h, sx, sy} while a region is being composited
        this.flatCache = null;          // {version, key, canvas} for eyedropper / clone / bucket / wand
        this.undoBytes = 0;
        this.selectionEncoded = false;  // the selection PNG in selectionDataUrl is up to date
        this.selectionSeq = 0;
        this.uploaded = this.makeUploaded();
        this.filterCounter = 0;
        this.filterPreview = null;      // id of the filter layer whose slider is being dragged (low-res preview)
        this.hideLightHandles = false;  // view toggle: hide 3D light handles and overlays on canvas
        this.seenResults = new Set();
        this.layerCounter = 0;
        this.paintCounter = 0;
        this.pointer = null;
        this.lassoPoints = null;
        this.polyPoints = null;         // polygon selection in progress: [[x, y], ...]
        this.shapePoints = null;        // polygon / polyline / bezier shape in progress: [{x, y, hx, hy}, ...]
        this.shapeDrag = null;          // the bezier handle being pulled right now
        this.polyMode = "replace";
        this.hover = null;
        this.objects = null;            // {hash, w, h, ids: Uint16Array, count, layerId}
        this.objectsPending = null;
        this.objectShapeCache = new Map();
        this.hoverObjectId = 0;
        this.hoverObjectCanvas = null;
        this.depthPending = null;
        this.rangePending = null;
        this.showDepthMap = false;
        this.maps = {};
        this.mapsVersion = 0;
        this._mapUndoPending = null;
        this.rangeLimit = {
            source: host.depthSupported !== false ? "depth" : "luma",
            lo: 0,
            hi: 0.3,
            fLo: 0.05,
            fHi: 0.05,
            invert: false,
            color: "#ffffff",
            tol: 30,
        };
        this.rangeMode = "replace";
        this._rangeTint = null;
        this.mapView = null;
        this.maskView = null;   // null | { id: string, mode: "overlay" | "alone" | "effect" }
        this.maskClip = null;   // null | { id: string } (layer whose mask was copied in mask menu)
        this._pendingPick = null;
        this._pendingPickTarget = null;
        this.geometrySeq = 0;
        let selDisplay = "ants";
        try { selDisplay = localStorage.getItem("ipc.selectionDisplay") || "ants"; } catch (_) { /* no storage */ }
        this.selectionDisplay = selDisplay === "tint" ? "tint" : "ants";   // marching ants (default) or red tint
        this.status = "No image loaded.";
        this.statusKind = "";
        // the status row's bar: the hosts feed it the runs of this document (docs/PLAN_0_1_48.md S3)
        this.runProgress = new RunProgress((s) => this.renderRunProgress(s));
        this.isOpen = false;

        injectStyle();
        this.buildNodeWidget();
        this.buildModal();
    }

    // ---- node widget (thumbnail + button) --------------------------------

    buildNodeWidget() {
        const root = el("div", "ipc-node");
        this.nodeRoot = root;
        const thumbWrap = el("div", "ipc-thumb");
        this.thumb = document.createElement("canvas");
        this.thumb.width = 4; this.thumb.height = 4;
        thumbWrap.appendChild(this.thumb);
        this.thumbHint = el("div", "ipc-hint", "No image yet.\nOpen the editor to load one.");
        thumbWrap.appendChild(this.thumbHint);
        thumbWrap.addEventListener("click", (e) => { e.stopPropagation(); this.open(); });
        thumbWrap.addEventListener("pointerdown", (e) => e.stopPropagation());
        root.appendChild(thumbWrap);

        const openBtn = el("button", "ipc-open");
        openBtn.type = "button";
        openBtn.innerHTML = icon("edit") + "<span>Open editor</span>";
        openBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
        openBtn.addEventListener("click", (e) => { e.stopPropagation(); this.open(); });
        root.appendChild(openBtn);

        this.nodeStatus = el("div", "ipc-status", this.status);
        root.appendChild(this.nodeStatus);

        root.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); });
        root.addEventListener("drop", (e) => {
            e.preventDefault(); e.stopPropagation();
            const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => f.type.startsWith("image/") || TIFF_EXT.test(f.name || ""));
            if (!files.length) return;
            // no base yet or Ctrl held: (re)load the base; otherwise every file becomes a new image layer
            if (!this.width || e.ctrlKey) this.loadFile(files[0]);
            else this.addImageLayers(files, e.shiftKey ? "reference" : "none", e.shiftKey ? {} : { place: "fit" });
        });
        root.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

        this.thumbObserver = new ResizeObserver(() => this.drawThumb());
        this.thumbObserver.observe(thumbWrap);
    }

    drawThumb() {
        const wrap = this.thumb.parentElement;
        if (!wrap) return;
        const rect = wrap.getBoundingClientRect();
        if (!this.base || rect.width < 4 || rect.height < 4) {
            this.thumb.width = 4; this.thumb.height = 4;
            this.thumbHint.style.display = this.base ? "none" : "flex";
            return;
        }
        this.thumbHint.style.display = "none";
        const dpr = window.devicePixelRatio || 1;
        const s = Math.min(rect.width / this.width, rect.height / this.height, 1) * dpr;
        const w = Math.max(1, Math.round(this.width * s));
        const h = Math.max(1, Math.round(this.height * s));
        if (this.thumb.width !== w || this.thumb.height !== h) {
            this.thumb.width = w; this.thumb.height = h;
        }
        this.thumb.style.width = (w / dpr) + "px";
        this.thumb.style.height = (h / dpr) + "px";
        const ctx = this.thumb.getContext("2d");
        ctx.setTransform(w / this.width, 0, 0, h / this.height, 0, 0);
        ctx.clearRect(0, 0, this.width, this.height);
        // one composite of the whole image at thumbnail scale, from the pyramid: no second full-size pass
        const prev = this.viewPass;
        this.viewPass = { x: 0, y: 0, w: this.width, h: this.height, sx: w / this.width, sy: h / this.height, display: true };
        try {
            this.drawComposite(ctx);
        } finally {
            this.viewPass = prev;
        }
        if (this.sel && !this.selectionHasNoTiles()) {
            ctx.globalAlpha = 0.45;
            this.drawSelectionInto(ctx, w / this.width);
            ctx.globalAlpha = 1;
        }
        // a display pass of its own (C6 b): the chains it asked for are watched even when the screen's pass asked for none
        this.watchChains();
    }

    /** The selection is on tiles and holds none: nothing to draw, and no display mirror to make for it. */
    selectionHasNoTiles() {
        return isTilePixels(this.sel) && this.sel.tileCount === 0;
    }

    /**
     * The level a view at `scale` (destination pixels per source pixel) draws a tile store from: the
     * one whose cells are at least as dense as the destination, clamped to the mips a tile carries.
     */
    tileLevel(scale) {
        return scale > 0 && Number.isFinite(scale) ? Math.max(0, Math.min(MIP_LEVELS, Math.floor(-Math.log2(scale)))) : 0;
    }

    /**
     * Draw the part of a tile store the view shows into `ctx`, which carries the transform from image
     * coordinates to the destination (docs/PLAN_BCE.md §C3): the region canvas at the view's level,
     * built from the tiles' mips, instead of a display mirror of the whole thing and a Skia pyramid on
     * it. `x, y, w, h` is where the pixels sit in the image. False when there is nothing to draw from
     * (no tile of the region), which is a draw of nothing.
     */
    drawTilesInto(ctx, px, x, y, w, h, vp) {
        const fx = w / px.width, fy = h / px.height;
        const level = this.tileLevel(fx * vp.sx);
        // a pass for the screen (or the navigator) may show a stale picture of tiles whose mips are in the worker (C6 b);
        // any other pass (a sample the wand floods, a flattened preview) reads exact mips
        const display = !!(vp.screen || vp.display);
        const rc = px.regionCanvas([(vp.x - x) / fx, (vp.y - y) / fy, (vp.x + vp.w - x) / fx, (vp.y + vp.h - y) / fy], level, display);
        if (!rc) return false;
        // the canvas holds whole tiles, its last row and column the clamp past the pixels' own edge
        const sw = Math.min(rc.canvas.width, (px.width - rc.x) / rc.f);
        const sh = Math.min(rc.canvas.height, (px.height - rc.y) / rc.f);
        if (!(sw > 0) || !(sh > 0)) return false;
        ctx.drawImage(rc.canvas, 0, 0, sw, sh, x + rc.x * fx, y + rc.y * fy, sw * rc.f * fx, sh * rc.f * fy);
        return true;
    }

    /**
     * Draw the selection mask over the image rectangle it covers, into a context that already carries
     * the transform from image to screen coordinates. On tiles it is the part of the mask the view
     * shows, at the view's level, straight from the tiles (docs/PLAN_BCE.md §C3): no display mirror of
     * the whole selection, no GPU copy of one and no pyramid. On canvases it is the pyramid's level,
     * as it always was. `scale` is the destination pixels per image pixel.
     *
     * `region` is the image rectangle to cover ({ x, y, w, h }); the whole image when it is null,
     * which is what the navigator's thumbnail wants. `display` false reads exact levels, for a picture that is
     * not the screen (C6 c5: the prompt context, `screenshot`): a display read may show coarse cells of tiles whose
     * chains are still in the worker, and asks for them as screen chains, whose landing redraws the screen.
     */
    drawSelectionInto(ctx, scale, region = null, display = true) {
        if (this.selectionHasNoTiles()) return;
        if (!isTilePixels(this.sel)) {
            ctx.drawImage(this.displaySource(this.sel, scale, true), 0, 0, this.width, this.height);
            return;
        }
        const level = this.tileLevel(scale);
        const r = region || { x: 0, y: 0, w: this.width, h: this.height };
        // the screen's callers (the ants, the tint, the navigator, a live stroke's clip) draw with display (C6 b)
        const rc = this.sel.regionCanvas([r.x, r.y, r.x + r.w, r.y + r.h], level, display);
        if (!rc) return;
        // the canvas holds whole tiles, its last row and column the clamp past the image's edge: the
        // draw is cropped to the image, which is what the whole-image draw of the other path covers
        const sw = Math.min(rc.canvas.width, (this.width - rc.x) / rc.f);
        const sh = Math.min(rc.canvas.height, (this.height - rc.y) / rc.f);
        if (!(sw > 0) || !(sh > 0)) return;
        ctx.drawImage(rc.canvas, 0, 0, sw, sh, rc.x, rc.y, sw * rc.f, sh * rc.f);
    }

    /**
     * Draw a layer's mask over the layer's rectangle or region, into a context that already carries
     * the transform from image to screen coordinates. Modelled on drawSelectionInto.
     */
    drawMaskInto(ctx, layer, scale, region = null, display = true) {
        if (!layer || !layer.maskPx) return;
        const maskPx = layer.maskPx;
        const isFilter = layer.kind === "filter";
        const lx = isFilter ? 0 : layer.x;
        const ly = isFilter ? 0 : layer.y;
        const lw = isFilter ? this.width : layer.w;
        const lh = isFilter ? this.height : layer.h;
        const fx = lw / maskPx.width, fy = lh / maskPx.height;
        if (!isTilePixels(maskPx)) {
            ctx.drawImage(this.displaySource(maskPx, scale * fx, display), lx, ly, lw, lh);
            return;
        }
        const level = this.tileLevel(scale * fx);
        const r = region || { x: lx, y: ly, w: lw, h: lh };
        const rc = maskPx.regionCanvas([(r.x - lx) / fx, (r.y - ly) / fy, (r.x + r.w - lx) / fx, (r.y + r.h - ly) / fy], level, display);
        if (!rc) return;
        const sw = Math.min(rc.canvas.width, (maskPx.width - rc.x) / rc.f);
        const sh = Math.min(rc.canvas.height, (maskPx.height - rc.y) / rc.f);
        if (!(sw > 0) || !(sh > 0)) return;
        ctx.drawImage(rc.canvas, 0, 0, sw, sh, lx + rc.x * fx, ly + rc.y * fy, sw * rc.f * fx, sh * rc.f * fy);
    }

    // ---- modal -------------------------------------------------------------

    /** The dialog itself: inpaint_modal.js builds it, one function per panel. */
    buildModal() {
        buildEditorModal(this);
    }

    buildSubbar() {
        const bar = el("div", "ipc-subbar");
        bar.hidden = true;
        this.subbar = bar;
        this.subModeButtons = {};
        const modes = [
            ["scale", "transform", "Move / scale: drag inside to move, corners keep aspect (Shift: free), edges scale one axis"],
            ["rotate", "rotate", "Rotate around the center (Shift snaps to 15°)"],
            ["distort", "distort", "Distort: drag the four corners freely (perspective)"],
            ["warp", "warp", "Warp: drag grid points to bend the layer"],
        ];
        for (const [id, ic, title] of modes) {
            const b = iconButton(ic, title, () => this.setTransformMode(id), id[0].toUpperCase() + id.slice(1));
            this.subModeButtons[id] = b;
            bar.appendChild(b);
        }
        bar.appendChild(el("span", "ipc-sep"));
        const gridLab = el("label", null, "Grid");
        this.warpGridSel = selectInput(["3", "4", "5", "6"], "4", "Warp grid size");
        this.warpGridSel.addEventListener("change", () => { if (this.pending && this.pending.mode === "warp") { this.cancelPending(); this.startPending("warp"); } });
        gridLab.appendChild(this.warpGridSel);
        bar.appendChild(gridLab);
        const angleLab = el("label", null, "Angle");
        this.angleInput = numberInput(0, -360, 360, "Rotation in degrees", 60);
        this.angleInput.step = 1;
        this.angleInput.addEventListener("input", () => { if (this.pending && this.pending.mode === "rotate") { this.pending.angle = (+this.angleInput.value || 0) * Math.PI / 180; this.draw(); } });
        angleLab.appendChild(this.angleInput);
        bar.appendChild(angleLab);
        bar.appendChild(el("span", "ipc-sep"));
        this.applyBtn = iconButton("check", "Apply the transform (Enter)", () => this.applyPending(), "Apply");
        this.applyBtn.classList.add("ipc-primary");
        bar.appendChild(this.applyBtn);
        this.cancelBtn = iconButton("close", "Cancel the transform (Esc)", () => this.cancelPending(), "Cancel");
        bar.appendChild(this.cancelBtn);
        // numeric geometry and one-click operations, shown in scale mode
        this.geoBox = el("span", "ipc-geo");
        this.geoInputs = {};
        for (const [k, title] of [["x", "Left edge"], ["y", "Top edge"], ["w", "Width"], ["h", "Height"]]) {
            const lab = el("label", null, k.toUpperCase());
            const inp = numberInput(0, -99999, 99999, `${title} of the layer in image pixels`, 62);
            inp.addEventListener("change", () => this.setLayerGeometry());
            inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } });
            this.geoInputs[k] = inp;
            lab.appendChild(inp);
            this.geoBox.appendChild(lab);
        }
        this.geoBox.appendChild(el("span", "ipc-sep"));
        this.geoBox.appendChild(iconButton("flipH", "Flip horizontally", () => this.flipLayer("h")));
        this.geoBox.appendChild(iconButton("flipV", "Flip vertically", () => this.flipLayer("v")));
        this.geoBox.appendChild(iconButton("rotCCW", "Rotate 90° counter-clockwise", () => this.rotateLayer90(-1)));
        this.geoBox.appendChild(iconButton("rotCW", "Rotate 90° clockwise", () => this.rotateLayer90(1)));
        this.geoBox.appendChild(iconButton("center", "Centre the layer on the canvas", () => this.centerLayer()));
        bar.appendChild(this.geoBox);
        // align and distribute: the selected layers to the box around them, or to the canvas (one layer: the canvas)
        this.alignBox = el("span", "ipc-geo");
        this.alignSep = this.alignBox.appendChild(el("span", "ipc-sep"));
        for (const [how, ic, title] of [["left", "alignLeft", "Align left edges"], ["hcenter", "alignHCenter", "Align horizontal centres"], ["right", "alignRight", "Align right edges"], ["top", "alignTop", "Align top edges"], ["vcenter", "alignVCenter", "Align vertical centres"], ["bottom", "alignBottom", "Align bottom edges"]]) {
            this.alignBox.appendChild(iconButton(ic, title, () => this.alignLayers(how, { to: this.alignToSel.value.toLowerCase() })));
        }
        this.distButtons = [
            iconButton("distH", "Distribute horizontally: equal gaps between the layers", () => this.distributeLayers("x", { to: this.alignToSel.value.toLowerCase() })),
            iconButton("distV", "Distribute vertically: equal gaps between the layers", () => this.distributeLayers("y", { to: this.alignToSel.value.toLowerCase() })),
        ];
        for (const b of this.distButtons) this.alignBox.appendChild(b);
        const toLab = el("label", null, "To");
        this.alignToSel = selectInput(["Selection", "Canvas"], "Selection", "Align and distribute within the box around the selected layers, or within the canvas");
        this.alignToSel.addEventListener("change", () => this.updateSubbar());
        toLab.appendChild(this.alignToSel);
        this.alignBox.appendChild(toLab);
        bar.appendChild(this.alignBox);
        this.subHint = el("span", "ipc-hint", "");
        bar.appendChild(this.subHint);
        for (const type of ["pointerdown", "pointermove", "pointerup", "wheel"]) bar.addEventListener(type, (e) => e.stopPropagation());
        this.viewEl.appendChild(bar);
        this.transformMode = "scale";
        this.updateSubbar();
    }

    /** Options of the bucket, gradient and eyedropper tools (a second bar in the subbar's place). */
    buildOptsBar() {
        const bar = el("div", "ipc-subbar");
        bar.hidden = true;
        this.optsBar = bar;
        this.fillOpts = { tolerance: 32, contiguous: true, sample: "image" };
        this.gradientOpts = { type: "linear", to: "transparent" };
        this.removeOpts = { sample: "image" };
        this.patchOpts = { mode: "source", blend: 100 };
        this.moveOpts = { mode: "move", blend: "edge" };
        this.liquifyOpts = { mode: "push", strength: 50, showFreeze: true };
        // the brush settings move from the top bar into this bar and show for the tools that use them
        const moveCtl = (labelEl, forTools) => { if (!labelEl) return; labelEl.dataset.for = forTools; bar.appendChild(labelEl); };
        moveCtl(this.sizeCtl && this.sizeCtl.input.parentElement, "select deselect paint erase smudge tone clone heal remove liquify");
        moveCtl(this.hardCtl && this.hardCtl.input.parentElement, "paint erase smudge tone clone heal remove liquify");
        // one call: a second one for "shape" overwrote the list and hid the slider for the brushes (e0c00a7 to 0.1.31)
        moveCtl(this.opacCtl && this.opacCtl.input.parentElement, "paint erase clone heal bucket gradient shape");
        moveCtl(this.flowCtl && this.flowCtl.input.parentElement, "paint erase");
        moveCtl(this.colorLabel, "paint bucket gradient shape");
        moveCtl(this.tipLabel, "paint erase smudge tone clone heal");
        for (const e of this.tipOnlyEls || []) moveCtl(e, "paint erase");
        this.syncTipControls();
        const row = (cls, ...nodes) => { const lab = el("label", null); lab.dataset.for = cls; for (const n of nodes) lab.appendChild(typeof n === "string" ? el("span", null, n) : n); bar.appendChild(lab); return lab; };
        const tol = document.createElement("input");
        tol.type = "range"; tol.min = 0; tol.max = 255; tol.value = this.fillOpts.tolerance; tol.title = "Tolerance: how different a colour may be to count as the same area (0..255 per channel)";
        const tolVal = el("span", null, String(this.fillOpts.tolerance));
        tol.addEventListener("input", () => { this.fillOpts.tolerance = +tol.value; tolVal.textContent = tol.value; });
        row("bucket wand", "Tolerance", tol, tolVal);
        const cont = document.createElement("input");
        cont.type = "checkbox"; cont.checked = true; cont.title = "Contiguous: only the connected area under the cursor; off fills every similar colour of the image";
        cont.addEventListener("change", () => { this.fillOpts.contiguous = cont.checked; });
        row("bucket wand", cont, "Contiguous");
        const sample = selectInput(["image", "layer"], "image", "What the fill looks at: the visible image (all layers) or the active layer alone");
        sample.addEventListener("change", () => { this.fillOpts.sample = sample.value; });
        row("bucket eyedropper wand", "Sample", sample);
        // item 58: the eyedropper takes the pixel under the cursor or the mean of the 3 x 3 / 5 x 5 around it (pickColor;
        // Alt+click with the paint brush too), kept like the pressure curve; Point unless the user chose otherwise
        this.eyedropperSize = 1;
        try { const n = +localStorage.getItem("ipc.eyedropperSize"); if (n === 3 || n === 5) this.eyedropperSize = n; } catch (_) { /* no storage */ }
        const dsize = selectInput([{ value: "1", label: "Point" }, { value: "3", label: "3 × 3" }, { value: "5", label: "5 × 5" }], String(this.eyedropperSize),
            "Size: the one pixel under the cursor, or the average of the 3 × 3 or 5 × 5 pixels around it, so grain or noise does not hand you a stray pixel's colour");
        dsize.addEventListener("change", () => {
            this.eyedropperSize = +dsize.value === 3 || +dsize.value === 5 ? +dsize.value : 1;
            try { localStorage.setItem("ipc.eyedropperSize", String(this.eyedropperSize)); } catch (_) { /* ignore */ }
            this.root.focus({ preventScroll: true });
        });
        this.eyedropperSizeSel = dsize;
        row("eyedropper", "Size", dsize);
        const gtype = selectInput(["linear", "radial"], "linear", "Gradient shape");
        gtype.addEventListener("change", () => { this.gradientOpts.type = gtype.value; });
        row("gradient", "Type", gtype);
        const gto = selectInput(["transparent", "white", "black"], "transparent", "What the colour fades to");
        gto.addEventListener("change", () => { this.gradientOpts.to = gto.value; });
        row("gradient", "To", gto);
        this.shapeOpts = { kind: "rectangle", fill: true, stroke: false, width: 4, radius: 0, color: "#000000" };
        const skind = selectInput(["rectangle", "ellipse", "polygon", "polyline", "bezier", "freehand"], "rectangle",
            "What the shape tool draws. Rectangle, ellipse and freehand are dragged; polygon, polyline and Bezier are clicked point by point.");
        skind.addEventListener("change", () => { this.cancelShape(); this.shapeOpts.kind = skind.value; this.updateOptsBar(); this.draw(); });
        row("shape", "Kind", skind);
        const sfill = document.createElement("input");
        sfill.type = "checkbox"; sfill.checked = true; sfill.title = "Fill the shape with the paint colour";
        sfill.addEventListener("change", () => { this.shapeOpts.fill = sfill.checked; });
        this.shapeFillRow = row("shape", sfill, "Fill");
        const sstroke = document.createElement("input");
        sstroke.type = "checkbox"; sstroke.title = "Draw the outline as well, in its own colour";
        sstroke.addEventListener("change", () => { this.shapeOpts.stroke = sstroke.checked; this.updateOptsBar(); });
        this.shapeStrokeRow = row("shape", sstroke, "Outline");
        const swidth = document.createElement("input");
        swidth.type = "number"; swidth.className = "ipc-num"; swidth.min = 1; swidth.max = 500; swidth.value = this.shapeOpts.width;
        swidth.style.width = "56px"; swidth.title = "Outline width in image pixels";
        swidth.addEventListener("change", () => { this.shapeOpts.width = Math.max(1, Math.min(500, +swidth.value || 1)); swidth.value = this.shapeOpts.width; });
        this.shapeWidthRow = row("shape", "Width", swidth);
        const scolor = document.createElement("input");
        scolor.type = "color"; scolor.value = this.shapeOpts.color; scolor.title = "Outline colour (the fill uses the paint colour)";
        scolor.addEventListener("input", () => { this.shapeOpts.color = scolor.value; });
        this.shapeColorRow = row("shape", scolor);
        const sradius = document.createElement("input");
        sradius.type = "number"; sradius.className = "ipc-num"; sradius.min = 0; sradius.max = 4096; sradius.value = 0;
        sradius.style.width = "56px"; sradius.title = "Corner radius of the rectangle, in image pixels";
        sradius.addEventListener("change", () => { this.shapeOpts.radius = Math.max(0, +sradius.value || 0); sradius.value = this.shapeOpts.radius; });
        this.shapeRadiusRow = row("shape", "Radius", sradius);
        this.smudgeOpts = { strength: 60, sample: "layer", length: 0, finger: false, mode: "smudge" };
        this.cloneOpts = { sample: "image", aligned: true, angle: 0, scale: 100, flipX: false, flipY: false, overlay: true };
        const str = document.createElement("input");
        str.type = "range"; str.min = 1; str.max = 100; str.value = this.smudgeOpts.strength; str.title = "Strength: how much of the picked-up paint is dragged along";
        const strVal = el("span", null, this.smudgeOpts.strength + "%");
        str.addEventListener("input", () => { this.smudgeOpts.strength = +str.value; strVal.textContent = str.value + "%"; });
        const smode = selectInput(["smudge", "blur", "sharpen"], "smudge", "Mode: smudge drags the paint along; blur softens and sharpen crisps what the brush passes over, as much as the strength says (Length and Finger are the smudge's)");
        smode.addEventListener("change", () => { this.smudgeOpts.mode = smode.value; this.root.focus({ preventScroll: true }); this.updateOptsBar(); });
        this.smudgeModeSel = smode;
        row("smudge", "Mode", smode);
        row("smudge", "Strength", str, strVal);
        // the pen (PLAN_0_1_31 §4 step 5): how its pressure maps to size, and a stabiliser for a steady line
        const pcurve = selectInput(["linear", "soft", "hard"], this.pressureCurve, "Pressure: how a pen's pressure sizes the brush. Soft reaches full size with a light hand, hard needs a firm one");
        pcurve.addEventListener("change", () => { this.pressureCurve = pcurve.value; try { localStorage.setItem("ipc.pressureCurve", pcurve.value); } catch (_) { /* ignore */ } this.root.focus({ preventScroll: true }); });
        row("paint erase smudge tone clone heal liquify", "Pressure", pcurve);
        const stab = document.createElement("input");
        stab.type = "range"; stab.min = 0; stab.max = 60; stab.value = this.stabiliser;
        stab.title = "Stabiliser: the brush follows the cursor on a string this many screen pixels long, so a trembling hand draws a calm line (0: off). The release finishes the line to the cursor";
        const stabVal = el("span", null, this.stabiliser ? this.stabiliser + "px" : "off");
        stab.addEventListener("input", () => { this.stabiliser = +stab.value; stabVal.textContent = this.stabiliser ? this.stabiliser + "px" : "off"; try { localStorage.setItem("ipc.stabiliser", String(this.stabiliser)); } catch (_) { /* ignore */ } });
        row("paint erase smudge tone clone heal liquify", "Stabiliser", stab, stabVal);
        const slen = document.createElement("input");
        slen.type = "range"; slen.min = 0; slen.max = 100; slen.value = this.smudgeOpts.length;
        slen.title = "Length: how much of the picked-up paint the brush keeps from dab to dab. 0 leaves it where it is laid down; towards 100 it goes on to the end of the stroke";
        const slenVal = el("span", null, this.smudgeOpts.length + "%");
        slen.addEventListener("input", () => { this.smudgeOpts.length = +slen.value; slenVal.textContent = slen.value + "%"; });
        row("smudge", "Length", slen, slenVal);
        const ssample = selectInput(["layer", "below", "image"], "layer", "What the smudge picks up: the active layer alone, the layers up to it (below), or the visible image (all layers), smudged into the active layer. On the base it always takes the image and paints into a new layer");
        ssample.addEventListener("change", () => { this.smudgeOpts.sample = ssample.value; this.root.focus({ preventScroll: true }); });
        this.smudgeSampleSel = ssample;
        row("smudge", "Sample", ssample);
        const sfinger = document.createElement("input");
        sfinger.type = "checkbox"; sfinger.title = "Finger painting: every stroke starts with the paint colour on the brush";
        sfinger.addEventListener("change", () => { this.smudgeOpts.finger = sfinger.checked; });
        row("smudge", sfinger, "Finger");
        // dodge / burn / sponge (PLAN_0_1_31 §4 step 9): GIMP's curves, Photoshop's options; the smudge's stroke engine
        this.toneOpts = { mode: "dodge", range: "midtones", exposure: 50, protect: true, vibrance: true, sample: "layer" };
        const tmode = selectInput(["dodge", "burn", "saturate", "desaturate"], "dodge", "Dodge lightens, burn darkens; saturate and desaturate are the sponge. Alt while pressing swaps dodge and burn, saturate and desaturate, for that stroke");
        tmode.addEventListener("change", () => { this.toneOpts.mode = tmode.value; this.root.focus({ preventScroll: true }); this.updateOptsBar(); });
        this.toneModeSel = tmode;
        row("tone", "Mode", tmode);
        const trange = selectInput(["shadows", "midtones", "highlights"], "midtones", "Range: which tones dodge and burn act on most");
        trange.addEventListener("change", () => { this.toneOpts.range = trange.value; this.root.focus({ preventScroll: true }); });
        this.toneRangeRow = row("tone", "Range", trange);
        const texp = document.createElement("input");
        texp.type = "range"; texp.min = 1; texp.max = 100; texp.value = this.toneOpts.exposure;
        texp.title = "Exposure: how strongly one stroke lightens, darkens or changes the saturation. A stroke does not build up over itself; paint again to go further";
        const texpVal = el("span", null, this.toneOpts.exposure + "%");
        texp.addEventListener("input", () => { this.toneOpts.exposure = +texp.value; texpVal.textContent = texp.value + "%"; });
        this.toneExpName = el("span", null, "Exposure");
        row("tone", this.toneExpName, texp, texpVal);
        const tprotect = document.createElement("input");
        tprotect.type = "checkbox"; tprotect.checked = true;
        tprotect.title = "Protect tones: the curve moves the brightest channel and the other two keep their share of it, so colours keep their hue (a strong highlights dodge or shadows burn can still clip). Off: each channel on its own, as GIMP does";
        tprotect.addEventListener("change", () => { this.toneOpts.protect = tprotect.checked; });
        this.toneProtectRow = row("tone", tprotect, "Protect tones");
        const tvib = document.createElement("input");
        tvib.type = "checkbox"; tvib.checked = true;
        tvib.title = "Vibrance: dull colours gain more saturation than vivid ones";
        tvib.addEventListener("change", () => { this.toneOpts.vibrance = tvib.checked; });
        this.toneVibranceRow = row("tone", tvib, "Vibrance");
        const tsample = selectInput(["layer", "below", "image"], "layer", "What the brush works from: the active layer alone, the layers up to it (below), or the visible image (all layers), written into the active layer. On the base it always takes the image and paints into a new layer");
        tsample.addEventListener("change", () => { this.toneOpts.sample = tsample.value; this.root.focus({ preventScroll: true }); });
        this.toneSampleSel = tsample;
        row("tone", "Sample", tsample);
        const csample = selectInput(["image", "layer"], "image", "Where the copied pixels come from: the visible image (all layers) or the active layer alone");
        csample.addEventListener("change", () => { this.cloneOpts.sample = csample.value; });
        row("clone heal", "Sample", csample);
        const rsample = selectInput(["image", "layer"], "image", "What Remove fills from: the visible image (all layers) or the active layer alone. The fill goes into the active layer; on the base it always takes the image and paints into a new layer");
        rsample.addEventListener("change", () => { this.removeOpts.sample = rsample.value; this.root.focus({ preventScroll: true }); });
        this.removeSampleSel = rsample;
        row("remove", "Sample", rsample);
        const pmode = selectInput(["source", "destination"], "source", "Source: the selection is repaired with what lies where you drag it. Destination: what is selected is copied to where you drag it");
        pmode.addEventListener("change", () => { this.patchOpts.mode = pmode.value; this.updateOptsBar(); this.root.focus({ preventScroll: true }); });
        this.patchModeSel = pmode;
        row("patch", "Mode", pmode);
        const pblend = document.createElement("input");
        pblend.type = "range"; pblend.min = 0; pblend.max = 100; pblend.value = 100;
        pblend.title = "Blend: at 100 % the patch takes on the colour and light around it; at 0 % its texture is copied as it is";
        const pblendVal = el("span", null, "100%");
        pblend.addEventListener("input", () => { this.patchOpts.blend = +pblend.value; pblendVal.textContent = pblend.value + "%"; });
        pblend.addEventListener("change", () => this.root.focus({ preventScroll: true }));
        row("patch", "Blend", pblend, pblendVal);
        const mmode = selectInput(["move", "extend"], "move", "Move: the selection lands where you let go and LaMa fills where it was. Extend: a copy lands there and the original stays");
        mmode.addEventListener("change", () => { this.moveOpts.mode = mmode.value; if (mmode.value === "move") this.warmRemove(); this.updateOptsBar(); this.root.focus({ preventScroll: true }); });
        this.moveModeSel = mmode;
        row("contentmove", "Mode", mmode);
        const mblend = selectInput(["edge", "all"], "edge", "Edge: a band inside the selection's edge takes on the new place, what you moved stays exactly as it was. All: the whole piece takes on the new place's colour and light (an object moved into shade darkens)");
        mblend.addEventListener("change", () => { this.moveOpts.blend = mblend.value; this.root.focus({ preventScroll: true }); });
        this.moveBlendSel = mblend;
        row("contentmove", "Blend", mblend);
        // liquify (PLAN_0_1_31 §5 step 5): the mode, how strongly a dab moves the picture, and Restore all
        const lmode = selectInput(["push", "grow", "shrink", "swirlcw", "swirlccw", "restore", "freeze", "thaw"], "push", "Push drags the picture along with the brush; grow and shrink swell or pinch what is under it, swirl turns it, restore brings back what the session started from; freeze paints what should stay where it is (red) and thaw frees it again. Grow, shrink, swirl and restore keep working while the button is held still. Alt while pressing reverses grow / shrink, the swirl, and freeze / thaw");
        for (const o of lmode.options) o.textContent = { swirlcw: "swirl ↻", swirlccw: "swirl ↺" }[o.value] || o.value;   // clockwise, counter-clockwise
        lmode.addEventListener("change", () => { this.liquifyOpts.mode = lmode.value; this.updateOptsBar(); this.root.focus({ preventScroll: true }); });
        this.liquifyModeSel = lmode;
        row("liquify", "Mode", lmode);
        const lstr = document.createElement("input");
        lstr.type = "range"; lstr.min = 1; lstr.max = 100; lstr.value = this.liquifyOpts.strength;
        lstr.title = "Strength: how far a dab moves the picture (push: at 100 % the picture under the brush's centre follows the cursor all the way)";
        const lstrVal = el("span", null, this.liquifyOpts.strength + "%");
        lstr.addEventListener("input", () => { this.liquifyOpts.strength = +lstr.value; lstrVal.textContent = lstr.value + "%"; });
        lstr.addEventListener("change", () => this.root.focus({ preventScroll: true }));
        row("liquify", "Strength", lstr, lstrVal);
        row("liquify", iconButton("undo", "Restore all: the active layer as it was when the Liquify session began (inside the selection, when there is one). One undo step",
            () => { this.liquifyRestoreAll(); this.root.focus({ preventScroll: true }); }, "Restore all"));
        // the freeze's three controls in one row: icon buttons, so the bar stays one line
        const lshow = document.createElement("input");
        lshow.type = "checkbox"; lshow.checked = true; lshow.title = "Show the frozen parts of the active layer in red while Liquify is the tool";
        lshow.addEventListener("change", () => { this.liquifyOpts.showFreeze = lshow.checked; this.draw(); this.root.focus({ preventScroll: true }); });
        row("liquify", "Freeze", lshow,
            iconButton("close", "Clear freeze: every part of the active layer free to move again", () => { this.liquifyClearFreeze(); this.root.focus({ preventScroll: true }); }),
            iconButton("invert", "Invert freeze: what was frozen is free, and the rest of the active layer frozen", () => { this.liquifyInvertFreeze(); this.root.focus({ preventScroll: true }); }));
        const aligned = document.createElement("input");
        aligned.type = "checkbox"; aligned.checked = true; aligned.title = "Aligned: the offset between source and brush stays the same for every stroke; off starts every stroke at the source point again";
        aligned.addEventListener("change", () => { this.cloneOpts.aligned = aligned.checked; });
        row("clone heal", aligned, "Aligned");
        // the source turned, scaled and mirrored against where it lands (PLAN_0_1_31 §4 step 4)
        const numIn = (min, max, value, title, set) => {
            const n = document.createElement("input");
            n.type = "number"; n.className = "ipc-num"; n.min = min; n.max = max; n.value = value; n.style.width = "52px"; n.title = title;
            n.addEventListener("change", () => { const v = Math.max(min, Math.min(max, Math.round(+n.value || 0))); n.value = v; set(v); this.draw(); });
            return n;
        };
        this.cloneAngleInput = numIn(-180, 180, 0, "Angle: the source turned by this many degrees where it lands", (v) => { this.cloneOpts.angle = v; });
        row("clone heal", "Angle", this.cloneAngleInput, "\u00b0");
        this.cloneScaleInput = numIn(10, 400, 100, "Scale: the source this big where it lands, in percent", (v) => { this.cloneOpts.scale = v; });
        row("clone heal", "Scale", this.cloneScaleInput, "%");
        const flip = (key, title) => {
            const c = document.createElement("input");
            c.type = "checkbox"; c.title = title;
            c.addEventListener("change", () => { this.cloneOpts[key] = c.checked; this.draw(); });
            return c;
        };
        row("clone heal", flip("flipX", "Mirror the source left to right"), "Flip H");
        row("clone heal", flip("flipY", "Mirror the source top to bottom"), "Flip V");
        const ghost = document.createElement("input");
        ghost.type = "checkbox"; ghost.checked = true; ghost.title = "Overlay: show what the brush would copy under it, half transparent (while the source is in view)";
        ghost.addEventListener("change", () => { this.cloneOpts.overlay = ghost.checked; this.draw(); });
        row("clone heal", ghost, "Overlay");
        // the Canvas tool's frame (PLAN_0_1_31 §7, 23b): the aspect, the angle, the straighten line, the lines, apply
        const asp = selectInput(["free", "original", "1:1", "4:3", "3:2", "16:9", "5:4", "custom"], this.frameAspect,
            "The frame's aspect: choosing one fits the largest such frame into the (turned) picture; X turns it on its side");
        // S: the keys (Enter, X, Esc) go back to the editor after a pick
        asp.addEventListener("change", () => { this.frameAspect = asp.value; this.frameAspectFlip = false; this.fitFrameToAspect(); this.root.focus({ preventScroll: true }); });
        this.frameAspectSel = asp;
        row("canvas", "Aspect", asp);
        const cw = numberInput(this.frameCustom[0], 1, 100000, "Custom aspect: width", 48), chh = numberInput(this.frameCustom[1], 1, 100000, "Custom aspect: height", 48);
        const setCustom = () => { this.frameCustom = [Math.max(1, +cw.value || 1), Math.max(1, +chh.value || 1)]; if (this.frameAspect === "custom") this.fitFrameToAspect(); };
        cw.addEventListener("change", setCustom); chh.addEventListener("change", setCustom);
        this.frameCustomRow = row("canvas", cw, ":", chh);
        row("canvas", iconButton("rotCW", "Turn the aspect on its side (X)", () => { this.swapFrameAspect(); this.setStatus(this.frameStatus()); }));
        const ang = numberInput(0, -45, 45, "The picture's angle in degrees (clockwise); the frame fits inside the turned picture", 56);
        ang.step = 0.1;
        ang.addEventListener("change", () => this.setFrameAngle(+ang.value || 0));
        ang.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.setFrameAngle(+ang.value || 0); this.root.focus({ preventScroll: true }); this.applyFrame(); } });
        const rng = document.createElement("input");
        rng.type = "range"; rng.min = -45; rng.max = 45; rng.step = 0.1; rng.value = 0;
        rng.title = "Turn the picture: the frame fits inside it (drag outside the frame on the canvas does the same)";
        rng.addEventListener("input", () => this.setFrameAngle(+rng.value || 0));
        rng.addEventListener("change", () => this.root.focus({ preventScroll: true }));
        this.frameAngleInput = ang; this.frameAngleRange = rng;
        row("canvas", "Angle", rng, ang);
        this.frameStraightenBtn = iconButton("ruler", "Straighten: draw a line along something that should be level or plumb (Ctrl+drag on the canvas does the same)", () => {
            this.frameStraighten = !this.frameStraighten;
            this.syncFrameControls();
            this.setStatus(this.frameStraighten ? "Draw a line along something that should be level or plumb." : this.frameStatus());
        }, "Straighten");
        row("canvas", this.frameStraightenBtn);
        const ov = selectInput(["thirds", "golden", "grid", "diagonal", "none"], this.frameOverlay, "Lines over the frame to compose by");
        ov.addEventListener("change", () => { this.frameOverlay = ov.value; try { localStorage.setItem("ipc.cropOverlay", ov.value); } catch (_) { /* no storage */ } this.draw(); this.root.focus({ preventScroll: true }); });
        row("canvas", "Lines", ov);
        row("canvas", iconButton("check", "Apply the frame (Enter, or a double click inside it)", () => this.applyFrame(), "Apply"));
        row("canvas", iconButton("close", "Reset the frame (Esc)", () => { this.resetFrame(); this.setStatus(this.frameStatus()); }, "Reset"));
        this.optsHint = el("span", "ipc-hint", "");
        bar.appendChild(this.optsHint);
        for (const type of ["pointerdown", "pointermove", "pointerup", "wheel"]) bar.addEventListener(type, (e) => e.stopPropagation());
        this.viewEl.appendChild(bar);
    }

    updateOptsBar() {
        if (!this.optsBar) return;
        const tool = this.tool;
        const on = ["select", "deselect", "paint", "erase", "bucket", "gradient", "eyedropper", "smudge", "tone", "clone", "heal", "remove", "patch", "contentmove", "liquify", "wand", "shape", "canvas"].includes(tool);
        this.optsBar.hidden = !on;
        if (!on) return;
        for (const lab of this.optsBar.querySelectorAll("label")) lab.hidden = !(lab.dataset.for || "").split(" ").includes(tool);
        if (tool === "shape") {
            const o = this.shapeOpts, open = o.kind === "polyline";
            this.shapeFillRow.hidden = open;                       // an open line has nothing to fill
            this.shapeStrokeRow.hidden = open;
            this.shapeWidthRow.hidden = !(o.stroke || open);
            this.shapeColorRow.hidden = !(o.stroke || open);
            this.shapeRadiusRow.hidden = o.kind !== "rectangle";
        }
        if (tool === "tone") {
            const sponge = this.toneOpts.mode === "saturate" || this.toneOpts.mode === "desaturate";
            this.toneRangeRow.hidden = sponge;
            this.toneProtectRow.hidden = sponge;
            this.toneVibranceRow.hidden = this.toneOpts.mode !== "saturate";
            this.toneExpName.textContent = sponge ? "Amount" : "Exposure";
        }
        const shapeHints = {
            rectangle: "Drag a rectangle; Shift keeps it square, Alt draws from the centre",
            ellipse: "Drag an ellipse; Shift keeps it a circle, Alt draws from the centre",
            polygon: "Click the corners, click the first point or press Enter to close",
            polyline: "Click the corners, press Enter to finish the line",
            bezier: "Click a point, or drag while clicking to curve the line; Enter finishes",
            freehand: "Draw with the cursor held down",
        };
        if (tool === "canvas") this.syncFrameControls();
        const hints = { canvas: "Edges crop or extend, outside turns, Ctrl+drag straightens; Enter or a double click applies, Esc resets", shape: shapeHints[this.shapeOpts.kind] || "", select: "Paint to select, Alt subtracts", deselect: "Paint to deselect", paint: "Alt+click picks a colour, Shift+click draws a line", erase: "Shift+click draws a line", wand: "Click to select the similar area; Shift adds, Alt subtracts, Shift+Alt intersects", bucket: "Click to fill; Shift+F fills the whole selection", gradient: "Drag from the colour to where it should have faded", eyedropper: "Click to pick a colour", smudge: this.smudgeOpts && this.smudgeOpts.mode === "blur" ? "Paint over what should soften" : this.smudgeOpts && this.smudgeOpts.mode === "sharpen" ? "Paint over what should crisp up; a little goes a long way" : "Drag across an edge to soften it", tone: this.toneHint(), remove: "Brush over what should go: it is filled from its surroundings when you let go", patch: this.patchOpts.mode === "destination" ? "Lasso what to copy, then drag the selection to where the copy should go" : "Lasso the spot, then drag the selection to where the picture is right", contentmove: this.moveOpts.mode === "extend" ? "Lasso what to copy, then drag it: the copy blends in where you let go" : "Lasso the object, then drag it: it blends in where you let go, and its old place is filled", liquify: this.liquifyHint(), clone: this.cloneSource ? "Paint to copy from the source (Alt+click moves it)" : "Alt+click sets the source point", heal: this.cloneSource ? "Paint to repair with the source's texture (Alt+click moves it)" : "Alt+click sets the source point" };
        this.optsHint.textContent = hints[tool] || "";
    }

    updateSubbar() {
        if (!this.subbar) return;
        const on = this.tool === "transform";
        this.subbar.hidden = !on;
        if (!on) return;
        const mode = this.pending ? this.pending.mode : this.transformMode;
        for (const [id, b] of Object.entries(this.subModeButtons)) b.classList.toggle("ipc-active", id === mode);
        const pending = !!this.pending;
        this.applyBtn.hidden = !pending;
        this.cancelBtn.hidden = !pending;
        this.warpGridSel.parentElement.hidden = mode !== "warp";
        this.angleInput.parentElement.hidden = mode !== "rotate";
        if (this.pending && this.pending.mode === "rotate") this.angleInput.value = Math.round(this.pending.angle * 180 / Math.PI);
        const active = this.activeLayer();
        if (this.geoBox) {
            this.geoBox.hidden = !(mode === "scale" && active && !pending && !this.multiSelected());
            if (!this.geoBox.hidden && document.activeElement && !this.geoBox.contains(document.activeElement)) for (const k of ["x", "y", "w", "h"]) this.geoInputs[k].value = Math.round(active[k]);
        }
        const many = !pending && this.multiSelected() ? this.selectedLayers().length : 0;
        if (this.alignBox) {
            const movable = this.alignTargets().length;
            this.alignBox.hidden = !(mode === "scale" && !pending && movable);
            this.alignToSel.parentElement.hidden = movable < 2;
            this.alignSep.hidden = !!(this.geoBox && this.geoBox.hidden);   // the bar's own separator stands before it then
            const toCanvas = movable < 2 || this.alignToSel.value === "Canvas";
            for (const b of this.distButtons) b.disabled = movable < (toCanvas ? 2 : 3);
        }
        this.subHint.textContent = !active ? "Select a layer first" : many ? `${many} layers selected: drag moves them, the handles scale them together, arrow keys nudge` : (pending ? (mode === "rotate" ? "Drag outside to rotate (Shift snaps), handles scale, inside moves. Enter applies, Esc cancels" : "Enter applies, Esc cancels") : (mode === "scale" ? "Drag outside a corner to rotate, arrow keys nudge" : "Click a mode to start"));
    }

    open() {
        if (this.isOpen) return;
        this.isOpen = true;
        host.mount(this.root);
        // While the editor is open every shortcut belongs to it. The listener sits
        // on window in the capture phase so ComfyUI's own handlers (workflow undo on
        // Ctrl+Z, keybindings) never see the keys; otherwise Ctrl+Z would undo the
        // whole workflow state and reset the canvas.
        this._docKey = (e) => {
            if (!this.isOpen || !host.isActive(this)) return;
            const t = e.target;
            if (this.askOpen) return;   // the question dialog has its own keys
            if (t && t.closest && t.closest("dialog[open]")) return;   // a key inside an open <dialog> (a host settings dialog, a plugin's) stays with the dialog: Escape has to reach its native close
            if (t && t.closest && t.closest("[data-own-keys]")) return;   // a host's own floating panel (a shadow root's host: its keys arrive retargeted to it) keeps its keys, as a dialog does
            if (document.querySelector("dialog:modal")) return;        // the rest of the page is inert under a modal dialog (the app's questions)
            const inField = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
            if (e.key === "Escape") {
                if (this.tipPicker && this.tipPicker.isOpen) { e.stopImmediatePropagation(); e.preventDefault(); this.closeTipPicker(); return; }
                // the prompt field's picker or swap menu goes first; a second Escape leaves the field
                if (this.promptField && this.promptField.popupOpen()) { e.stopImmediatePropagation(); e.preventDefault(); this.promptField.closePopups(); return; }
                if (t === this.promptInput) return;
                e.stopImmediatePropagation(); e.preventDefault();
                if (this._pendingPick) {
                    this._pendingPick = null;
                    this._pendingPickTarget = null;
                    if (this._pickResolve) { const r = this._pickResolve; this._pickResolve = null; r(null); }
                    this.draw();
                    this.setStatus("Pick cancelled.");
                }
                else if (this.rangePending) {
                    this.cancelRange();
                }
                else if (this._rangeTint) {
                    this.setRangePreview(null);
                }
                else if (this.pointer && this.pointer.kind === "patchdrag") { const p = this.pointer; this.pointer = null; this.patchDone(p); this.draw(); this.setStatus(`${p.tool === "contentmove" ? "Move" : "Patch"} cancelled.`); }
                else if (this.pointer && this.pointer.kind === "liquify" && !this.pointer.healing) { const p = this.pointer; this.pointer = null; this.liquifyDrop(p, "Liquify cancelled."); }
                else if (this.pending) this.cancelPending();
                else if (this.polyPoints) { this.polyPoints = null; this.draw(); this.setStatus("Polygon cancelled."); }
                else if (this.shapePoints) { this.cancelShape(); this.draw(); this.setStatus("Shape cancelled."); }
                else if (this.tool === "canvas" && this.pointer && ["frame", "framemove", "framerotate", "straighten"].includes(this.pointer.kind)) {
                    const o = this.pointer.orig;
                    this.pointer = null;
                    this.canvasFrame = o && o.base === this.base ? { ...o } : null;
                    this.syncFrameControls(); this.draw(); this.setStatus("The frame is back where it was.");
                }
                else if (this.tool === "canvas" && this.framePending()) { this.resetFrame(); this.setStatus("Canvas frame reset."); }
                else if (this.flyout) this.closeFlyout();
                else if (this.textEdit) this.endTextEdit(false);
                else if (this.compare) { this.compare = null; if (this.compareBtn) this.compareBtn.classList.remove("ipc-on"); this.draw(); this.setStatus("Compare ended."); }
                else if (this.tool === "lights" && this.isRelightActive()) {
                    const l = this.activeLayer();
                    if (l && l._selectedLightId) {
                        l._deselected = true;
                        l._selectedLightId = null;
                        this.renderLayers();
                        this.draw();
                        this.setStatus("Light deselected.");
                    }
                }
                else if (this.boxes && this.boxes.key(e, "escape")) { /* the Boxes tool let go of its box */ }
                else if (!host.pluginKey(this, e, "escape")) host.onEscape(this);
                return;
            }
            // a key from inside the tip popover (a button there after Tab) is never an editor shortcut
            if (this.tipPicker && this.tipPicker.isOpen && t && this.tipPicker.el.contains(t)) return;
            if (inField) return;   // typing in the editor's own fields: their handlers stop propagation themselves
            e.stopImmediatePropagation();
            // a heal stroke blending in a worker is still the gesture (`healBlend`): its commit reads the selection and the
            // layer as they are, so a shortcut waits for it as a press does (Ctrl+Z waits for it through `trackEdit`)
            if (this.pointer && this.pointer.healing && !((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z")) {
                e.preventDefault();
                this.setStatus(this.heldWord(this.pointer));
                return;
            }
            this.onKey(e);
        };
        window.addEventListener("keydown", this._docKey, true);
        this._docKeyUp = (e) => {
            // the key that started it: AltGr+ß types \ only while AltGr is down, and it may come up first
            if (this.peekHold && (e.key === "\\" || (this.peekCode && e.code === this.peekCode))) { this.peekHold = false; this.peekCode = null; this.peekBase = false; if (this.peekBtn) this.peekBtn.classList.remove("ipc-toggle-on"); this.draw(); }
        };
        window.addEventListener("keyup", this._docKeyUp, true);
        this.setPromptText(this.promptText, { history: "reset" });
        this.refreshSegmentBackends();
        this.syncRefControls();
        loadFontList().then(() => { if (this.isOpen && this.layers.some((l) => l.kind === "text")) this.renderLayers(); }).catch(() => {});
        this.root.focus({ preventScroll: true });
        this.applyStoredSideWidth();
        this.resizeCanvas();
        this.fitView();
        this.renderLayers();
        this.renderHistory();
        this.renderInfo();
    }

    close() {
        if (!this.isOpen) return;
        if (this.pending) this.cancelPending();
        // a heal still blending in a worker lands as its quick heal (the worker's answer finds the pointer gone); a Remove
        // waiting for the model lands nothing (its stroke is only the mark of the hole)
        const hp = this.pointer;
        // a liquify stroke, dragged or baking, lands nothing either (the field goes back with it, the source is let go)
        if (hp && hp.kind === "liquify") { this.pointer = null; this.liquifyDrop(hp, null); }
        else if (hp && hp.healing) { this.pointer = null; if (hp.remove) this.dropStroke(hp); else this.commitLayerPaint(hp); }
        this.endLiquify();
        this.liqFreezes = null;
        this.isOpen = false;
        if (this.antsTimer) { clearInterval(this.antsTimer); this.antsTimer = null; }
        this.pointer = null;
        this.lassoPoints = null;
        if (this._docKey) window.removeEventListener("keydown", this._docKey, true);
        this._docKey = null;
        if (this._docKeyUp) window.removeEventListener("keyup", this._docKeyUp, true);
        this._docKeyUp = null;
        if (this.textEdit) this.endTextEdit(true);
        this.closeFlyout();
        this.dropFlyoutListener();
        this.closeAsk();
        this.closeTipPicker();   // its window listener and preview slices go with the editor (8c14eee)
        // a relight nudge or wheel burst still in its 300 ms is dropped, not committed: its timer and flush, the snapshot it
        // would have pushed (the layer's next edit would take it as its own "before") and its preview
        for (const l of this.layers || []) {
            if (!l || !(l._flushNudge || l._flushWheel || l._nudgeRelightTimer || l._wheelRelightTimer || l._nudgePending || l._wheelPending)) continue;
            clearTimeout(l._nudgeRelightTimer);
            clearTimeout(l._wheelRelightTimer);
            l._nudgeRelightTimer = l._wheelRelightTimer = null;
            l._flushNudge = l._flushWheel = null;
            l._nudgePending = l._wheelPending = l._wheelLabel = null;
            if (this.filterPreview === l.id) this.filterPreview = null;
        }
        if (this.promptField) this.promptField.closePopups();
        clearTimeout(this._autosave);
        this.compare = null;
        this.peekBase = false;
        this.flatCache = null;
        this.sceneCanvas = null;
        this.sceneSig = null;
        this.root.remove();
        this.drawThumb();
        this.notifyChanged();
        this.syncLayers().catch((err) => console.error(err));
    }

    bindEvents() {
        const root = this.root;
        const stop = (e) => e.stopPropagation();
        for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "keyup"]) {
            root.addEventListener(type, stop);
        }
        root.addEventListener("contextmenu", (e) => e.preventDefault());
        root.addEventListener("click", (e) => {
            const t = e.target;
            if (this.askOpen) return;   // the dialog just focused its input; do not pull the focus back to the canvas
            // a button inside the prompt field (a chip's chevron) keeps the field's focus
            if (t && t.closest && t.closest("button") && !t.closest("input, select, textarea, [contenteditable]")) this.root.focus({ preventScroll: true });
        });
        root.addEventListener("wheel", (e) => {
            if (e.target !== this.canvas) { e.stopPropagation(); return; }
            e.preventDefault();
            e.stopPropagation();
            this.onWheel(e);
        }, { passive: false });
        // Keys are handled by the window capture listener (see open()); here we
        // only keep them from bubbling to the graph canvas.
        root.addEventListener("keydown", (e) => { this._loadNote = null; e.stopPropagation(); });
        // the user acts: a load's note (setValue) stops riding on the next lines
        root.addEventListener("pointerdown", () => { this._loadNote = null; }, true);
        root.addEventListener("paste", (e) => {
            if (this.promptInput && e.target && this.promptInput.contains(e.target)) return;
            const items = e.clipboardData && e.clipboardData.items;
            if (!items) return;
            for (const item of items) {
                if (item.type.startsWith("image/")) {
                    e.preventDefault(); e.stopPropagation();
                    // no base yet: the image becomes the base; otherwise it lands as a new layer at the origin (Krita: paste as new layer)
                    if (this.width) this.addImageLayers([item.getAsFile()], "none", { place: "origin" });
                    else this.loadFile(item.getAsFile());
                    return;
                }
            }
        });
        this.viewEl.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = e.ctrlKey && this.width ? "move" : "copy"; this.viewEl.classList.add("ipc-dropping"); });
        this.viewEl.addEventListener("dragleave", (e) => { if (!this.viewEl.contains(e.relatedTarget)) this.viewEl.classList.remove("ipc-dropping"); });
        this.viewEl.addEventListener("drop", (e) => {
            e.preventDefault(); e.stopPropagation();
            this.viewEl.classList.remove("ipc-dropping");
            const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => f.type.startsWith("image/") || LAYERED_EXT.test(f.name || "") || TIFF_EXT.test(f.name || ""));
            if (!files.length) return;
            // No image yet, or Ctrl held: the file becomes (replaces) the base. Otherwise each file is a new
            // image layer centred on the drop point (Shift: reference layers), like dropping into Krita.
            if (!this.width || e.ctrlKey) { this.loadFile(files[0]); return; }
            if (e.shiftKey) { this.addImageLayers(files, "reference"); return; }
            this.addImageLayers(files, "none", { place: "at", at: this.toImage(e) });
        });
        this.canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
        this.canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
        this.canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
        this.canvas.addEventListener("pointercancel", (e) => this.onPointerUp(e));
        this.canvas.addEventListener("pointerleave", () => { this.hover = null; this.hoverObjectId = 0; this.hoverObjectCanvas = null; this.draw(); });
    }

    /**
     * A question inside the editor: Electron has no window.prompt (it throws
     * "prompt() is not supported"), and a native dialog would block the canvas.
     * Resolves with the entered text, with true for a plain confirm, or with null
     * when the question was cancelled.
     *
     * `fields` makes a form: number boxes ({ key, label, value, min, max, disabled }), selects ({ key, label,
     * type: "select", options: [{ value, label, group }], value, hidden, disabled, wide }; options with a group go in an
     * optgroup of that name, a `wide` field takes a row of its own) and note lines ({ key, type: "note", text, hidden }).
     * The answer is then an object: a number per number box, a string per select (hidden ones too), no notes.
     * `linked` offers to tie exactly two number boxes by their ratio (a disabled box is not tied). `onChange(key, values,
     * set)` runs after a select is changed or a number box is typed in: `values` the answer as it is now,
     * `set(key, { options, value, hidden, disabled, text })` changes a field without calling onChange again.
     */
    ask({ title = "", message = "", value = null, fields = null, linked = false, ok = "OK", cancel = "Cancel", danger = false, onChange = null } = {}) {
        return new Promise((resolve) => {
            const wrap = el("div", "ipc-ask");
            const box = el("div", "ipc-askbox");
            if (title) box.appendChild(el("div", "ipc-asktitle", title));
            if (message) box.appendChild(el("div", "ipc-askmsg", message));
            let input = null;
            const nums = [];        // the number boxes, in order
            const ctls = [];        // every control that answers: number boxes and selects, in order
            const parts = new Map();   // key -> { kind, cell, ctl }
            // the ratio tie (two number boxes): its hooks stay no-ops without one
            let tied = () => false, retie = () => {}, syncLink = () => {};
            // a select's value: `want` when it is one of the options, else the first option
            const pickOption = (sel, want) => {
                const v = want == null ? "" : String(want);
                sel.value = v;
                if (sel.selectedIndex < 0 && sel.options.length) sel.selectedIndex = 0;
            };
            const fillSelect = (sel, options, want) => {
                sel.textContent = "";
                let group = null;
                for (const raw of options || []) {
                    const o = raw && typeof raw === "object" ? raw : { value: raw, label: raw };
                    const opt = document.createElement("option");
                    opt.value = String(o.value == null ? "" : o.value);
                    opt.textContent = String(o.label != null ? o.label : opt.value);
                    if (o.group) {
                        if (!group || group.label !== String(o.group)) { group = document.createElement("optgroup"); group.label = String(o.group); sel.appendChild(group); }
                        group.appendChild(opt);
                    } else {
                        group = null;
                        sel.appendChild(opt);
                    }
                }
                pickOption(sel, want);
            };
            if (fields && fields.length) {
                // one labelled box per field (a number box or a select), notes between them; two number boxes can be
                // tied by their ratio
                const grid = el("div", "ipc-askfields");
                for (const f of fields) {
                    const kind = f.type === "select" ? "select" : f.type === "note" ? "note" : "number";
                    if (kind === "note") {
                        const note = el("div", "ipc-asknote", f.text != null ? String(f.text) : "");
                        note.hidden = !!f.hidden;
                        grid.appendChild(note);
                        parts.set(f.key, { kind, cell: note, ctl: null });
                        continue;
                    }
                    const cell = el("div", "ipc-askfield" + (f.wide ? " ipc-askwide" : ""));
                    cell.appendChild(el("span", null, f.label || f.key));
                    let ctl;
                    if (kind === "select") {
                        ctl = document.createElement("select");
                        ctl.className = "ipc-askinput";
                        fillSelect(ctl, f.options, f.value);
                    } else {
                        ctl = document.createElement("input");
                        ctl.type = "number";
                        ctl.className = "ipc-askinput";
                        ctl.value = String(f.value != null ? f.value : "");
                        if (f.min != null) ctl.min = String(f.min);
                        if (f.max != null) ctl.max = String(f.max);
                        nums.push(ctl);
                    }
                    ctl.dataset.key = f.key;
                    ctl.disabled = !!f.disabled;
                    cell.hidden = !!f.hidden;
                    cell.appendChild(ctl);
                    grid.appendChild(cell);
                    ctls.push(ctl);
                    parts.set(f.key, { kind, cell, ctl });
                }
                box.appendChild(grid);
                if (nums.length === 2 && linked) {
                    const lab = el("label", "ipc-asklink");
                    const link = document.createElement("input");
                    link.type = "checkbox";
                    link.checked = linked === "on";   // true only offers the tie; "on" starts with it
                    lab.appendChild(link);
                    lab.appendChild(el("span", null, "Keep the ratio"));
                    box.appendChild(lab);
                    // the ratio of the two values: taken at the start; with onChange (a dialog whose fields the caller
                    // changes, New with a model) also when the tie is ticked and when set() changes them while they are
                    // not tied (a disabled box is not tied). A plain dialog (the two-number New, the node's, SVG import)
                    // keeps the ratio it opened with
                    let ratio = 1;
                    retie = () => { const a = +nums[0].value, b = +nums[1].value; if (a > 0 && b > 0) ratio = b / a; };
                    retie();
                    tied = () => link.checked && !nums[0].disabled && !nums[1].disabled;
                    syncLink = () => { const off = nums[0].disabled || nums[1].disabled; link.disabled = off; lab.classList.toggle("ipc-off", off); };
                    syncLink();
                    const tie = (from, to, factor) => () => {
                        if (!tied()) return;
                        const v = +from.value;
                        if (v > 0) to.value = String(Math.max(1, Math.round(v * factor())));
                    };
                    nums[0].addEventListener("input", tie(nums[0], nums[1], () => ratio));
                    nums[1].addEventListener("input", tie(nums[1], nums[0], () => (ratio ? 1 / ratio : 1)));
                    if (typeof onChange === "function") link.addEventListener("change", () => { if (link.checked) retie(); });
                }
            } else if (value != null) {
                input = document.createElement("input");
                input.type = "text";
                input.className = "ipc-askinput";
                input.value = String(value);
                box.appendChild(input);
            }
            const row = el("div", "ipc-askrow");
            const cancelBtn = el("button", "ipc-ib", cancel);
            const okBtn = el("button", "ipc-ib " + (danger ? "ipc-danger" : "ipc-primary"), ok);
            cancelBtn.type = "button";
            okBtn.type = "button";
            row.appendChild(el("span", "ipc-grow"));
            row.appendChild(cancelBtn);
            row.appendChild(okBtn);
            box.appendChild(row);
            wrap.appendChild(box);
            // the answer: an object for fields (numbers for number boxes, strings for selects), the string for a text
            // input, true otherwise
            const answer = () => {
                if (!ctls.length) return input ? input.value : true;
                const out = {};
                for (const c of ctls) out[c.dataset.key] = c.tagName === "SELECT" ? c.value : +c.value;
                return out;
            };
            // a field changed by the caller (onChange): its options, value, text, hidden and disabled state
            const set = (key, patch = {}) => {
                const p = parts.get(key);
                if (!p || !patch) return;
                if (p.kind === "note") {
                    if (patch.text != null) p.cell.textContent = String(patch.text);
                } else {
                    const wasOff = p.ctl.disabled;
                    if (p.kind === "select" && patch.options) fillSelect(p.ctl, patch.options, patch.value != null ? patch.value : p.ctl.value);
                    else if (patch.value != null) {
                        if (p.kind === "select") pickOption(p.ctl, patch.value);
                        else p.ctl.value = String(patch.value);
                    }
                    if (patch.disabled != null) p.ctl.disabled = !!patch.disabled;
                    // the tie takes the new values as its ratio unless it holds them (a box enabled again joins it anew)
                    if (p.kind === "number" && (patch.value != null || wasOff !== p.ctl.disabled) && (!tied() || (wasOff && !p.ctl.disabled))) retie();
                }
                if (patch.hidden != null) p.cell.hidden = !!patch.hidden;
                syncLink();
            };
            if (typeof onChange === "function") {
                const fire = (key) => {
                    try { onChange(key, answer(), set); } catch (err) { console.error(err); }
                };
                // after the tie's own listeners, so onChange sees both values
                for (const c of ctls) c.addEventListener(c.tagName === "SELECT" ? "change" : "input", () => fire(c.dataset.key));
            }
            const finish = (val) => {
                if (this.askOpen !== wrap) return;
                this.askOpen = null;
                if (this._askFinish === finish) this._askFinish = null;
                window.removeEventListener("keydown", onKey, true);
                wrap.remove();
                try { this.root.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
                resolve(val);
            };
            const onKey = (e) => {
                // a question no longer on the page (its editor closed or destroyed) takes no key: it lets go of the window
                if (this._destroyed || !wrap.isConnected) {
                    window.removeEventListener("keydown", onKey, true);
                    if (this.askOpen === wrap) finish(null);
                    return;
                }
                if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); finish(null); }
                else if (e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); finish(answer()); }
            };
            cancelBtn.addEventListener("click", () => finish(null));
            okBtn.addEventListener("click", () => finish(answer()));
            wrap.addEventListener("pointerdown", (e) => { if (e.target === wrap) finish(null); });
            this.askOpen = wrap;
            // close() and destroy() answer an open question with null: its window listener closes over the editor
            this._askFinish = finish;
            window.addEventListener("keydown", onKey, true);
            this.root.appendChild(wrap);
            // the first number box that can be typed in, else the first select, else the text input or OK
            const usable = (c) => !c.disabled && !c.closest("[hidden]");
            const firstNum = nums.find(usable);
            const firstSel = ctls.find((c) => c.tagName === "SELECT" && usable(c));
            if (firstNum) { firstNum.focus(); firstNum.select(); }
            else if (firstSel) firstSel.focus();
            else if (input) { input.focus(); input.select(); }
            else okBtn.focus();
        });
    }

    /**
     * The status line. `opts` gives its kind: "error" or "warn" (red, five blinks, then steady red until the next
     * line; no blink under reduced motion), "info" (plain whatever the text says), or { kind }; left out, the text
     * decides (inpaint_status.js statusKindOf). `status` stays the plain text, `statusKind` the kind ("" for a plain line).
     */
    setStatus(text, opts) {
        let kind = statusKindFor(text, opts);
        // a load that left layers out (setValue) says so on the plain lines written right after it too (LOAD_NOTE_LINES)
        const carry = this._loadNote;
        if (carry && Date.now() > carry.until) this._loadNote = null;
        else if (carry && !kind && !String(text).includes(carry.note)) {
            text = `${text} ${carry.note}`;
            kind = "warn";
            if (--carry.lines <= 0) this._loadNote = null;
        }
        this.status = text;
        this.statusKind = kind;
        for (const node of [this.statusEl, this.nodeStatus]) {
            if (!node) continue;
            // the same line again while it still blinks (a caller that repeats itself) keeps its blink going
            const again = kind && node.textContent === String(text) && node.classList.contains("ipc-status-blink");
            node.textContent = text;
            node.classList.toggle("ipc-status-error", !!kind);
            if (again) continue;
            node.classList.remove("ipc-status-blink");
            if (!kind) continue;
            // the five pulses are over: drop the class, or a hidden tab shown again (display: none and back) would blink anew
            if (!node._blinkEnds) {
                node._blinkEnds = true;
                node.addEventListener("animationend", (e) => { if (e.animationName === "ipc-status-blink") node.classList.remove("ipc-status-blink"); });
            }
            // every error line blinks anew, the same text after its blink too: the class comes back after a style flush
            void node.offsetWidth;
            node.classList.add("ipc-status-blink");
        }
    }

    /**
     * The status row's bar from a RunProgress state (null: hidden): the fill at the fraction, or a busy sweep without
     * one (still under reduced motion), and the label beside it (the node k of n, a sampler's step, the seconds).
     */
    renderRunProgress(s) {
        const box = this.runEl;
        if (!box) return;
        box.hidden = !s;
        if (!s) return;
        const busy = s.fraction == null;
        box.classList.toggle("ipc-run-busy", busy);
        this.runFill.style.width = busy ? "" : `${Math.round(Math.max(0, Math.min(1, s.fraction)) * 1000) / 10}%`;
        if (this.runLabel.textContent !== s.label) this.runLabel.textContent = s.label;
        box.title = s.label;
    }

    // ---- geometry ----------------------------------------------------------

    resizeCanvas() {
        if (!this.isOpen) return;
        const rect = this.viewEl.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(rect.width * dpr);
        const h = Math.round(rect.height * dpr);
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
            if (this.width && this._fitted !== false) this.fitView(); else this.draw();
        }
    }

    toCanvasPx(e) {
        const rect = this.canvas.getBoundingClientRect();
        return [
            (e.clientX - rect.left) * (this.canvas.width / rect.width),
            (e.clientY - rect.top) * (this.canvas.height / rect.height),
        ];
    }

    toImage(e) {
        const [cx, cy] = this.toCanvasPx(e);
        return this.canvasToImage(cx, cy);
    }

    /** Device pixel on the canvas -> image coordinate (the view may be rotated). */
    canvasToImage(cx, cy) {
        const a = -(this.view.angle || 0), c = Math.cos(a), s = Math.sin(a);
        const dx = cx - this.view.x, dy = cy - this.view.y;
        return [(dx * c - dy * s) / this.view.scale, (dx * s + dy * c) / this.view.scale];
    }

    /** Image coordinate -> device pixel on the canvas. */
    imageToScreen(ix, iy) {
        const a = this.view.angle || 0, c = Math.cos(a), s = Math.sin(a);
        const x = ix * this.view.scale, y = iy * this.view.scale;
        return [this.view.x + x * c - y * s, this.view.y + x * s + y * c];
    }

    /** Set a context's transform to the view (optionally shifted by device pixels). */
    applyViewTransform(ctx, dx = 0, dy = 0) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.translate(this.view.x + dx, this.view.y + dy);
        if (this.view.angle) ctx.rotate(this.view.angle);
        ctx.scale(this.view.scale, this.view.scale);
    }

    /** The straighten preview's angle in radians: the pending frame's, in the Canvas tool only (null otherwise). */
    viewTilt() {
        if (this.tool !== "canvas") return null;
        const f = this.frame();
        return f && f.angle ? f.angle * Math.PI / 180 : null;
    }

    /** Compose the straighten preview onto a context in image coordinates: the picture turned about its centre. */
    applyTilt(ctx) {
        const t = this.viewTilt();
        if (!t) return;
        ctx.translate(this.width / 2, this.height / 2);
        ctx.rotate(t);
        ctx.translate(-this.width / 2, -this.height / 2);
    }

    /**
     * The Canvas tool's frame, level over the (turned) picture: outside it darkened, a border it adds tinted, the chosen
     * lines inside it, its outline and handles, its size and angle, and the straighten line while it is drawn.
     */
    drawCanvasFrame(ctx) {
        const f = this.frameOrCanvas(), s = this.view.scale, W = this.width, H = this.height;
        ctx.save();
        const corners = [[0, 0], [this.canvas.width, 0], [0, this.canvas.height], [this.canvas.width, this.canvas.height]].map(([x, y]) => this.canvasToImage(x, y));
        const vx0 = Math.min(...corners.map((c) => c[0])), vy0 = Math.min(...corners.map((c) => c[1]));
        const vx1 = Math.max(...corners.map((c) => c[0])), vy1 = Math.max(...corners.map((c) => c[1]));
        if (this.framePending()) {
            ctx.fillStyle = "rgba(0,0,0,0.5)";
            ctx.beginPath(); ctx.rect(vx0, vy0, vx1 - vx0, vy1 - vy0); ctx.rect(f.x, f.y, f.w, f.h); ctx.fill("evenodd");
        }
        if (!f.angle && (f.x < 0 || f.y < 0 || f.x + f.w > W || f.y + f.h > H)) {
            // what an extend adds (the new border the model will fill)
            ctx.save();
            ctx.beginPath(); ctx.rect(f.x, f.y, f.w, f.h); ctx.clip();
            ctx.fillStyle = "rgba(124,199,255,0.22)";
            ctx.beginPath(); ctx.rect(f.x, f.y, f.w, f.h); ctx.rect(0, 0, W, H); ctx.fill("evenodd");
            ctx.restore();
        }
        this.drawFrameOverlay(ctx, f, s);
        ctx.lineWidth = 1 / s;
        ctx.strokeStyle = "#7cc7ff";
        ctx.setLineDash([6 / s, 4 / s]);
        ctx.strokeRect(f.x, f.y, f.w, f.h);
        ctx.setLineDash([]);
        const r = HANDLE_PX / s / 2;
        const handles = this.layerHandles({ x: f.x, y: f.y, w: f.w, h: f.h });
        ctx.fillStyle = "#7cc7ff";
        for (const name of ["nw", "ne", "sw", "se"]) { const [hx, hy] = handles[name]; ctx.fillRect(hx - r, hy - r, r * 2, r * 2); }
        ctx.fillStyle = "#1e1e1e";
        for (const name of ["n", "s", "w", "e"]) { const [hx, hy] = handles[name]; ctx.beginPath(); ctx.arc(hx, hy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
        ctx.font = `${12 / s}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const label = (txt, x, y) => { const w = ctx.measureText(txt).width + 10 / s; ctx.fillStyle = "rgba(0,0,0,0.65)"; ctx.fillRect(x - w / 2, y - 8 / s, w, 16 / s); ctx.fillStyle = "#fff"; ctx.fillText(txt, x, y); };
        if (!f.angle) {
            const v = this.extendValues(), sg = (n) => (n > 0 ? "+" : "") + n;
            if (v.top) label(sg(v.top), W / 2, -v.top / 2);
            if (v.bottom) label(sg(v.bottom), W / 2, H + v.bottom / 2);
            if (v.left) label(sg(v.left), -v.left / 2, H / 2);
            if (v.right) label(sg(v.right), W + v.right / 2, H / 2);
        }
        label(`${f.w} × ${f.h}${f.angle ? `  ${f.angle}°` : ""}`, f.x + f.w / 2, f.y - 14 / s);
        const p = this.pointer;
        if (p && p.kind === "straighten") {
            const [x0, y0] = p.start, [x1, y1] = p.cur;
            ctx.lineWidth = 2 / s;
            ctx.strokeStyle = "rgba(0,0,0,0.6)";
            ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
            ctx.lineWidth = 1 / s;
            ctx.strokeStyle = "#ffd24a";
            ctx.setLineDash([5 / s, 3 / s]);
            ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
            ctx.setLineDash([]);
            const phi = Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI, off = phi - 90 * Math.round(phi / 90);
            label(`${Math.round(-off * 10) / 10}°`, x1, y1 - 14 / s);
        }
        ctx.restore();
    }

    /** The lines over the frame to compose by: thirds, the golden section, a grid, or Photoshop's diagonals. */
    drawFrameOverlay(ctx, f, s) {
        const kind = this.frameOverlay || "thirds";
        if (kind === "none") return;
        const lines = [], X = (t) => f.x + f.w * t, Y = (t) => f.y + f.h * t;
        if (kind === "thirds" || kind === "golden") {
            for (const t of kind === "thirds" ? [1 / 3, 2 / 3] : [0.381966, 0.618034]) lines.push([X(t), f.y, X(t), f.y + f.h], [f.x, Y(t), f.x + f.w, Y(t)]);
        } else if (kind === "grid") {
            // a round step of at least 32 px on the screen, from the frame's corner
            const want = 32 * (window.devicePixelRatio || 1) / s, mag = Math.pow(10, Math.floor(Math.log10(want)));
            const step = [1, 2, 5, 10].map((k) => k * mag).find((v) => v >= want);
            for (let x = f.x + step; x < f.x + f.w; x += step) lines.push([x, f.y, x, f.y + f.h]);
            for (let y = f.y + step; y < f.y + f.h; y += step) lines.push([f.x, y, f.x + f.w, y]);
        } else if (kind === "diagonal") {
            const m = Math.min(f.w, f.h);
            lines.push([f.x, f.y, f.x + m, f.y + m], [f.x + f.w, f.y, f.x + f.w - m, f.y + m], [f.x, f.y + f.h, f.x + m, f.y + f.h - m], [f.x + f.w, f.y + f.h, f.x + f.w - m, f.y + f.h - m]);
        }
        ctx.save();
        ctx.beginPath(); ctx.rect(f.x, f.y, f.w, f.h); ctx.clip();
        for (const [w, c] of [[3 / s, "rgba(0,0,0,0.4)"], [1 / s, "rgba(255,255,255,0.75)"]]) {
            ctx.lineWidth = w; ctx.strokeStyle = c;
            ctx.beginPath();
            for (const [a, b, c2, d] of lines) { ctx.moveTo(a, b); ctx.lineTo(c2, d); }
            ctx.stroke();
        }
        ctx.restore();
    }

    /** Rotate the view about the middle of the canvas (Krita's 4 / 6 keys). */
    rotateView(delta) {
        if (!this.width) return;
        const qx = this.canvas.width / 2, qy = this.canvas.height / 2;
        const c = Math.cos(delta), s = Math.sin(delta);
        const vx = this.view.x - qx, vy = this.view.y - qy;
        this.view.x = qx + vx * c - vy * s;
        this.view.y = qy + vx * s + vy * c;
        this.view.angle = ((this.view.angle || 0) + delta) % (Math.PI * 2);
        if (Math.abs(this.view.angle) < 1e-9) this.view.angle = 0;
        this._fitted = false;
        this.draw();
        this.setStatus(this.view.angle ? `View rotated ${Math.round(this.view.angle * 180 / Math.PI)}° (5 resets).` : "View rotation reset.");
    }

    /** Zoom to a scale about the middle of the canvas (1 = one image pixel per device pixel). */
    zoomTo(ns) {
        if (!this.width) return;
        const qx = this.canvas.width / 2, qy = this.canvas.height / 2;
        this.view.x = qx - (qx - this.view.x) * (ns / this.view.scale);
        this.view.y = qy - (qy - this.view.y) * (ns / this.view.scale);
        this.view.scale = ns;
        this._fitted = false;
        this.draw();
        this.setStatus(`Zoom ${Math.round(ns * 100)} %.`);
    }

    fitView() {
        if (!this.width || !this.canvas.width) return;
        const pad = 24;
        const s = Math.max(0.01, Math.min((this.canvas.width - pad * 2) / this.width, (this.canvas.height - pad * 2) / this.height));
        this.view.scale = s;
        this.view.angle = 0;
        this.view.x = (this.canvas.width - this.width * s) / 2;
        this.view.y = (this.canvas.height - this.height * s) / 2;
        this._fitted = true;
        this.draw();
    }

    onWheel(e) {
        if (!this.width) return;
        if (this.tool === "lights" && this.isRelightActive()) {
            const [ix, iy] = this.toImage(e);
            const layer = this.activeLayer();
            const hit = this.hitLight(layer, ix, iy);
            if (hit && hit.light) {
                if (e.preventDefault) e.preventDefault();
                const l = hit.light;
                layer._deselected = false;
                layer._selectedLightId = l.id;
                const dir = Math.sign(-e.deltaY || 0);
                if (dir !== 0) {
                    // a wheel burst is a step of its own, as a nudge burst is (onKey); one still open ends first
                    if (!layer._wheelPending) {
                        if (typeof layer._flushNudge === "function") layer._flushNudge();
                        layer._wheelPending = this.snapshot({ kind: "filter", id: layer.id });
                        layer._wheelLabel = e.shiftKey ? "Relight: Intensity" : "Relight: Diffusion";
                    }
                    if (e.shiftKey) {
                        l.intensity = Math.max(0, Math.min(300, Math.round((l.intensity || 100) + dir * 5)));
                    } else {
                        l.diffusion = Math.max(0, Math.min(100, Math.round((l.diffusion != null ? l.diffusion : 30) + dir * 2)));
                    }
                    this.filterPreview = layer.id;
                    this.ensureRelightMaps(layer, { quick: true });
                    this.markFilterChanged(layer);
                    this.renderLayers();
                    this.draw();
                    if (layer._wheelRelightTimer) clearTimeout(layer._wheelRelightTimer);
                    const flushWheel = () => {
                        if (layer._wheelRelightTimer) { clearTimeout(layer._wheelRelightTimer); layer._wheelRelightTimer = null; }
                        layer._flushWheel = null;
                        const snap = layer._wheelPending, label = layer._wheelLabel || "Relight: Diffusion";
                        layer._wheelPending = null;
                        layer._wheelLabel = null;
                        if (this.filterPreview === layer.id) this.filterPreview = null;
                        if (!this.layers || !this.layers.includes(layer)) return;   // the layer left the document (an undo replaced it)
                        if (snap) this.pushUndoSnapshot(snap, { label, fromDebounce: true });
                        this.ensureRelightMaps(layer, { quick: false });
                        this.markFilterChanged(layer);
                        this.renderLayersUnlessEditing();
                        this.draw();
                    };
                    layer._flushWheel = flushWheel;
                    layer._wheelRelightTimer = setTimeout(flushWheel, 300);
                    return;
                }
            }
        }
        const [cx, cy] = this.toCanvasPx(e);
        const factor = Math.exp(-e.deltaY * 0.0015);
        const ns = Math.min(40, Math.max(0.02, this.view.scale * factor));
        this.view.x = cx - (cx - this.view.x) * (ns / this.view.scale);
        this.view.y = cy - (cy - this.view.y) * (ns / this.view.scale);
        this.view.scale = ns;
        this._fitted = false;
        this.drawSoon();
    }

    // ---- layers: lookup ----------------------------------------------------

    activeLayer() {
        return this.layers.find((l) => l.id === this.activeLayerId) || null;
    }

    /**
     * The selected layers in stack order (bottom first): the active one and those Ctrl / Shift + clicked with it. A
     * selection counts only while it holds the active layer, so every path that sets `activeLayerId` to a layer outside
     * it (a new layer, a pick on the canvas, an undo) falls back to that one layer without clearing anything.
     */
    selectedLayers() {
        const active = this.activeLayer();
        if (!active) return [];
        if (this.layerSel.size < 2 || !this.layerSel.has(active.id)) return [active];
        const sel = this.layers.filter((l) => this.layerSel.has(l.id) && !this.isReference(l));
        return sel.length > 1 ? sel : [active];
    }

    multiSelected() { return this.selectedLayers().length > 1; }

    /** Select layers by id (the first given, or `active`, becomes the active one); an empty list selects the base. */
    selectLayers(ids, { active = null } = {}) {
        const known = new Set(this.layers.map((l) => l.id));
        const list = [...new Set(ids)].filter((id) => known.has(id));
        if (this.pending) this.cancelPending();
        this.activeLayerId = active && list.includes(active) ? active : (list[0] || null);
        this.layerSel = new Set(list.length > 1 ? list : []);
        this.layerAnchorId = this.activeLayerId;
        this.renderLayers(); this.updateSubbar(); this.draw();
        return this.selectedLayers();
    }

    /** A click on a layer row: plain selects it alone, Ctrl toggles it in the selection, Shift selects the range from the anchor. */
    clickLayerRow(layer, e) {
        if (this.pending) this.cancelPending();
        this.activeGroupId = null;
        const ctrl = e && (e.ctrlKey || e.metaKey);
        if (e && e.shiftKey && this.layerAnchorId && this.layerAnchorId !== layer.id && !this.isReference(layer)) {
            const rows = this.layers.filter((l) => !this.isReference(l));
            const a = rows.findIndex((l) => l.id === this.layerAnchorId), b = rows.indexOf(layer);
            if (a >= 0 && b >= 0) {
                this.layerSel = new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((l) => l.id));
                this.activeLayerId = layer.id;
                this.renderLayers(); this.updateSubbar(); this.draw();
                return;
            }
        }
        if (ctrl && !this.isReference(layer)) {
            const sel = new Set(this.selectedLayers().map((l) => l.id));
            if (sel.has(layer.id) && sel.size > 1) {
                sel.delete(layer.id);
                if (this.activeLayerId === layer.id) this.activeLayerId = [...sel].pop();
            } else {
                sel.add(layer.id);
                this.activeLayerId = layer.id;
            }
            this.layerSel = sel.size > 1 ? sel : new Set();
            this.layerAnchorId = layer.id;
        } else {
            this.activeLayerId = layer.id;
            this.layerSel = new Set();
            this.layerAnchorId = layer.id;
        }
        this.renderLayers(); this.updateSubbar(); this.draw();
    }

    /**
     * The layers a move or scale takes together, and the box around them: null unless more than one layer is selected.
     * Filter layers (they cover the canvas) and locked ones stay where they are.
     */
    groupBox() {
        if (!this.multiSelected()) return null;
        const layers = this.selectedLayers().filter((l) => l.kind !== "filter" && !this.isLocked(l));
        if (!layers.length) return null;
        const x0 = Math.min(...layers.map((l) => l.x)), y0 = Math.min(...layers.map((l) => l.y));
        const x1 = Math.max(...layers.map((l) => l.x + l.w)), y1 = Math.max(...layers.map((l) => l.y + l.h));
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, layers };
    }

    /** Map every layer of a group gesture from the box it started in to the box the gesture has dragged. */
    applyGroupBox(p) {
        const o = p.orig, b = p.layer;
        const sx = b.w / o.w, sy = b.h / o.h;
        for (const g of p.group) {
            const l = g.layer;
            const x0 = b.x + (g.x - o.x) * sx, y0 = b.y + (g.y - o.y) * sy;
            const x1 = b.x + (g.x + g.w - o.x) * sx, y1 = b.y + (g.y + g.h - o.y) * sy;
            l.x = Math.round(x0); l.y = Math.round(y0);
            l.w = Math.max(1, Math.round(x1) - l.x); l.h = Math.max(1, Math.round(y1) - l.y);
        }
    }

    isControl(layer) {
        return !!(layer.role && layer.role !== "none" && layer.role !== "reference");
    }

    isReference(layer) {
        return layer.role === "reference";
    }

    /** Visible reference layers in panel order (top of the list = reference 1). */
    referenceLayers() {
        return this.layers.filter((l) => this.isReference(l) && l.visible && l.px).reverse();
    }

    /** The label of each shown reference by layer id: top of the list = 1, what @img1 names. */
    refLabels() {
        return labelMap(this.referenceLayers());
    }

    /**
     * What a run sends, read at the click (docs/PLAN_REFS.md C3): the prompt, the negative, the shown references by id
     * (top first) and their labels. A reference hidden while the crop is made still goes; one deleted refuses.
     */
    refSnapshot() {
        const refs = this.referenceLayers();
        return { prompt: this.promptText || "", negative: this.negativeText || "", refIds: refs.map((l) => l.id), labels: labelMap(refs) };
    }

    /** The reference layers of a snapshot, in its order; no ids: the shown ones now. */
    refLayersFor(ids) {
        if (!ids) return this.referenceLayers();
        return ids.map((id) => {
            const l = this.layers.find((x) => x.id === id);
            if (!l || !this.isReference(l) || !l.px) throw new Error("A reference layer was deleted while the run was being prepared: press Generate again.");
            return l;
        });
    }

    /**
     * 1 when a run would send the Original (the crop before the fill) as the first reference picture, as planCrop decides
     * it: a selection, a fill, "Original" on, and no refine pass (a local run's refine sends no fill). `local`: the run is
     * a local one whatever the mode switch says.
     */
    predictOriginal({ local = false } = {}) {
        const cs = this.cropSettings || {};
        const refine = !!this.genSettings.refine && (local || this.genSettings.mode === "local");
        return this.getBounds && this.getBounds() && cs.fill && cs.fill !== "none" && cs.withOriginal && !refine ? 1 : 0;
    }

    /**
     * Every reference layer, top first, as the prompt field and agents describe it (C4): label null for one that is
     * hidden (or has no pixels), `sentAs` the name the chosen route gives its picture (`refLayoutInfo`, null unknown),
     * `over` past the route's cap. `info`: another route's layout than the tab's (the Generate new dialog's, 26f).
     */
    refDescriptors(info = this.refLayoutInfo) {
        const labels = this.refLabels();
        return this.layers.filter((l) => this.isReference(l)).reverse().map((l) => ({
            id: l.id, label: labels.get(l.id) || null, name: l.name || "", visible: !!l.visible, thumb: null,
            sentAs: info && info.names && labels.has(l.id) ? info.names.get(l.id) || null : null,
            over: !!(info && info.over && labels.has(l.id) && info.over.has(l.id)),
        }));
    }

    /**
     * The shown references changed (added, deleted, moved, hidden or shown, a role change, a merge, an undo of a layers
     * step): every @img token of the prompt, the negative, Revert's text, a running upsample's text and the registered
     * fields is rewritten from the labels of the last change to the labels now, by layer id, so a token keeps naming
     * its picture. A token whose layer has no label now waits as @img?<id>. Called at the site of the change, before
     * its first render (renderReferences counts a change nobody reported). `alias`: a merge, the absorbed layer's id to
     * the survivor's, whose label its tokens take. `restore`: setValue, which runs while `_loading` holds the others off.
     */
    refsMutated({ alias = null, restore = false } = {}) {
        if (!host.refTokens || (this._loading && !restore)) return;
        const after = this.refLabels(), before = this.refMap || after;
        let target = after;
        if (alias) {
            target = new Map(after);
            for (const [from, to] of alias) if (after.has(to)) target.set(from, after.get(to));
        }
        const r = (t) => (t ? remap(t, before, target) : t);
        const p = r(this.promptText);
        // the field's undo too when the text stays the same: an older state may name a reference that moved
        if (p !== this.promptText || this.promptField) this.setPromptText(p, { keepCaret: true, history: r });
        const n = r(this.negativeText);
        if (n !== this.negativeText) this.setNegativeText(n);
        this.remapOthers(r);
        this.refMap = after;
    }

    /**
     * The labels read again where the prompt came back together with the layers (a turn snapshot) or the layers went
     * (a new picture): nothing the snapshot holds is rewritten. `carry`: what it does not hold (Revert's text, a running
     * upsample's, the registered fields) is remapped from the labels before to the ones now.
     */
    refsRebuilt({ carry = false } = {}) {
        if (!host.refTokens) { this.refMap = null; return; }
        const after = this.refLabels();
        if (carry && this.refMap) {
            const before = this.refMap;
            this.remapOthers((t) => (t ? remap(t, before, after) : t));
        }
        this.refMap = after;
    }

    /** Revert's text, a running upsample's text and the registered fields through a remap. */
    remapOthers(r) {
        if (this.promptBackup != null) this.promptBackup = r(this.promptBackup);
        if (this.upsamplePending) {
            // the answer still to come is in the numbering of the click: it goes through every remap since (26d1)
            const p = this.upsamplePending, prev = p.carry;
            p.previous = r(p.previous);
            p.carry = prev ? (t) => r(prev(t)) : r;
        }
        // every registered field gets the remap, its text unchanged too: its own undo is mapped and it redraws (the
        // Generate new dialog's bar follows a hide or an add from an agent)
        for (const f of this._remapTargets) f.setText(r(f.value), { keepCaret: true, history: r });
    }

    /**
     * A field outside the editor whose text names this document's references (the Generate new dialog's prompt): it is
     * remapped with the prompt. `field` has `value` and `setText(text, { keepCaret, history })`, called at every remap
     * (with the same text too, so the field can map its undo and redraw). Returns the dispose.
     */
    addRemapTarget(field) {
        this._remapTargets.add(field);
        return () => this._remapTargets.delete(field);
    }

    /**
     * The prompt set from code (Upsample, Revert, an agent, a remap, a restore). `keepCaret`: the caret stays after the
     * same word when the field has the focus. `history` is for the prompt field's own undo (docs/PLAN_REFS.md C4:
     * "push", "reset" or a text-to-text function); the textarea keeps none of its own. The field normalises the text
     * (line breaks, the tokens' prefix), and `promptText` takes what it holds, so the two never differ.
     */
    setPromptText(text, { keepCaret = false, history = "push" } = {}) {
        if (this.promptField) {
            this.promptField.setText(text, { keepCaret, history });
            this.promptText = this.promptField.el.value;
            return;
        }
        this.promptText = String(text == null ? "" : text);
        setFieldText(this.promptInput, this.promptText, keepCaret);
    }

    /**
     * What the prompt field draws its chips, its picker and its bar from (docs/PLAN_REFS.md C4): every reference layer,
     * top first, hidden ones with label null, each with a 32 px thumbnail; from the chosen route's layout
     * (`refLayoutInfo`, 26c2) the cap on reference layers, why none goes (`none`), a ComfyUI recipe (`local`: its
     * pictures go in the crop_image batch, named as its graph numbers them, 26e), why a token cannot go although the
     * pictures do (`refuse`); `reason` says why a parked token's layer has no descriptor, `show` shows a hidden
     * reference as its eye does. `info`: another route's layout than the tab's (the Generate new dialog's, 26f). A
     * reference can be added to an empty tab too: it gets a white canvas, which Generate new then replaces (26f).
     */
    refContext(info = this.refLayoutInfo) {
        const byId = new Map(this.layers.map((l) => [l.id, l]));
        const refs = this.refDescriptors(info).map((d) => ({ ...d, thumb: this.refAvatar(byId.get(d.id)) }));
        const local = !!(info && info.local);
        return {
            refs, cap: info && info.cap != null ? info.cap : null, none: (info && info.none) || null, local,
            refuse: (info && info.refuse) || null,
            canAdd: !!this.width || !!host.refTokens,
            reason: (id) => (byId.has(id) ? "no longer a reference: make it a reference again to send it" : "deleted: an undo brings it back"),
            show: (id) => this.showReference(id),
        };
    }

    /**
     * A hidden reference shown, as its eye in the reference list shows it (no undo step): its parked tokens come back as
     * @img<n> (refsMutated). The swap menu's "Show <name>".
     */
    showReference(id) {
        const layer = this.layers.find((l) => l.id === id);
        if (!layer || !this.isReference(layer) || layer.visible) return false;
        layer.visible = true;
        this.uploaded.baseHash = null;
        this.refsMutated();
        this.renderLayers(); this.renderInfo(); this.draw(); this.drawThumb(); this.notifyChanged();
        return true;
    }

    /**
     * The chosen route's layout of the shown references read again (`host.refLayout`, which keeps it as
     * `refLayoutInfo`), 120 ms after the last call, and the prompt field drawn from it: the names on the hover card and
     * in the picker, the cap in the bar, an over or none chip. A later call wins over an answer still on its way.
     */
    refreshRefLayout() {
        if (!host.refTokens || !this.promptField || this._destroyed) return;
        clearTimeout(this._refLayTimer);
        this._refLayTimer = setTimeout(async () => {
            const seq = this._refLaySeq = (this._refLaySeq || 0) + 1;
            try { await host.refLayout(this); } catch (_) { /* the chips stay as they are */ }
            if (seq !== this._refLaySeq || this._destroyed || !this.promptField) return;
            this.promptField.refresh();
            this.renderInfoRows();
        }, 120);
    }

    /**
     * Pictures added as reference layers for the prompt field (its picker's "+ Add reference", the bar's "+", a paste
     * or a drop on it): the new references' ids, top first. Never a base: in an empty tab the app makes a white canvas
     * first (Generate new replaces it and keeps the references, 26f); the node's editor only says so.
     * @param {File[]} files
     * @returns {Promise<string[]>}
     */
    async addReferencesForPrompt(files) {
        if (!this.width && !host.refTokens) { this.setStatus("Load an image first: a reference goes beside a picture."); return []; }
        const before = new Set(this.layers.map((l) => l.id));
        await this.addImageLayers(Array.from(files || []), "reference", { blank: true });
        return this.layers.filter((l) => !before.has(l.id) && this.isReference(l)).reverse().map((l) => l.id);
    }

    /** A reference's picture for the prompt field's hover card, fitted into the canvas's own size. */
    refPreview(id, canvas) {
        const layer = this.layers.find((l) => l.id === id);
        if (!layer || !canvas) return;
        const css = Math.round(canvas.width / ((typeof window !== "undefined" && window.devicePixelRatio) || 1));
        canvas.style.width = canvas.style.height = `${css}px`;
        this.drawLayerThumb(canvas, layer);
    }

    /**
     * A reference's picture for its chip: 32 × 32, cover-cropped, as a PNG data URL. Kept on the layer for the pixels
     * and the live mask it was drawn from (a rotation replaces the pixels, the mask switch changes the live mask), and
     * dropped when either changes in place (markLayerChanged, markMaskChanged, redrawThumbsOf). A 32 px canvas stays in
     * software: no GPU readback.
     */
    refAvatar(layer) {
        if (!layer || !layer.px || !layer.px.width || !layer.px.height) return null;
        // held weakly: a replaced layer's pixels must not live on in the cache
        const mask = this.liveMask(layer), got = layer._refAvatar;
        if (got && got.px.deref() === layer.px && (got.mask ? got.mask.deref() : null) === mask) return got.url;
        const c = document.createElement("canvas");
        c.width = c.height = 32;
        const s = Math.max(32 / layer.px.width, 32 / layer.px.height);
        const w = layer.px.width * s, h = layer.px.height * s;
        try {
            this.drawLayerFitted(c.getContext("2d"), layer, (32 - w) / 2, (32 - h) / 2, w, h);
            layer._refAvatar = { url: c.toDataURL("image/png"), px: new WeakRef(layer.px), mask: mask ? new WeakRef(mask) : null };
        } catch (_) { return null; }
        return layer._refAvatar.url;
    }

    /** The negative prompt set from code, as setPromptText. */
    setNegativeText(text, { keepCaret = false } = {}) {
        this.negativeText = String(text == null ? "" : text);
        setFieldText(this.negativeInput, this.negativeText, keepCaret);
    }

    /** Layer `layer` becomes a reference, an image layer or a control (one undo step); a new reference goes below the others. */
    setLayerRole(layer, role) {
        role = role || "none";
        if (!layer || (layer.role || "none") === role) return;
        this.pushUndo({ kind: "layers", label: "Layer role" });
        const was = this.isReference(layer);
        layer.role = role;
        layer.exportRef = null;
        // below the lowest reference, so it takes the next number and none of the others moves
        if (host.refTokens && !was && this.isReference(layer)) {
            const rest = this.layers.filter((l) => l !== layer);
            const j = rest.findIndex((l) => this.isReference(l));
            if (j >= 0) { rest.splice(j, 0, layer); this.layers = rest; }
        }
        this.uploaded.baseHash = null;
        this.uploaded.controlHash = null;
        this.refsMutated();
        this.renderLayers(); this.renderInfo(); this.draw(); this.drawThumb(); this.notifyChanged();
    }

    /** One place up (dir +1) or down in the reference list: past the next reference, not the next layer of the stack. */
    moveReference(layer, dir) {
        const refs = this.layers.filter((l) => this.isReference(l));
        const i = refs.indexOf(layer);
        const other = i < 0 ? null : refs[i + (dir > 0 ? 1 : -1)];
        if (!other) return;
        this.reorderLayer(layer.id, other.id, dir > 0);
    }

    /**
     * The layer's pixels as they are composited: the canvas with the in-progress
     * stroke and, when the layer has a transparency mask, multiplied by it. The
     * masked result is cached until pixels or mask change.
     * `display`: the caller only draws the result right away (the screen, the pyramid, the
     * compositor, thumbnails, a composite being built): an unmasked layer then hands out its
     * display canvas (`canvasOf`, the same canvas every frame, synced from the writes) instead of
     * a `toCanvas()` copy, which on tiles would be a whole-layer copy per frame and a new key for
     * every identity cache. Anything that keeps the canvas (an upload, an encode, a worker job)
     * leaves it false (docs/PLAN_BCE.md §C2 step b).
     */
    layerPixels(layer, display = false) {
        if (!this.liveMask(layer)) return this.layerWithStroke(layer, display);
        const p = this.pointer;
        const live = !!(p && (p.kind === "layerpaint" || p.kind === "maskpaint") && p.layer === layer);
        if (!live && layer._masked && layer._maskedValid) return layer._masked;
        const base = this.layerWithStroke(layer, true);   // drawn into the masked cache right here
        // during a mask stroke on this layer the mask's live preview, otherwise the mask's own
        // pixels (drawn through maskPx below); maskWithStroke would hand those back as a canvas
        const mask = p && p.kind === "maskpaint" && p.layer === layer ? this.maskWithStroke(layer) : null;
        const drawMask = (ctx, w, h) => { if (mask) ctx.drawImage(mask, 0, 0, w, h); else layer.maskPx.drawTo(ctx, 0, 0, w, h); };
        let out;
        if (live) {
            // the live copy is rebuilt inside the dab's rectangle only; destination-in would
            // clear everything outside the drawn part, so the box is a clip region
            let fresh = false;
            if (!this.maskedPreview || this.maskedPreview.width !== base.width || this.maskedPreview.height !== base.height) { this.maskedPreview = makeCanvas(base.width, base.height); this.maskedPreview._livePreview = true; fresh = true; }
            if (p.maskedOf !== this.maskedPreview) { p.maskedOf = this.maskedPreview; fresh = true; }
            out = this.maskedPreview;
            const box = fresh ? null : this.takeDirty(p, "dirtyMasked", layer, base);
            if (fresh) p.dirtyMasked = null;
            if (fresh || box) {
                const [x, y, w, h] = box ? [box[0], box[1], box[2] - box[0], box[3] - box[1]] : [0, 0, out.width, out.height];
                const ctx = out.getContext("2d");
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.beginPath();
                ctx.rect(x, y, w, h);
                ctx.clip();
                ctx.globalCompositeOperation = "source-over";
                ctx.globalAlpha = 1;
                ctx.clearRect(x, y, w, h);
                ctx.drawImage(base, x, y, w, h, x, y, w, h);
                ctx.globalCompositeOperation = "destination-in";
                drawMask(ctx, out.width, out.height);
                ctx.restore();
            }
            return out;
        }
        if (!layer._masked || layer._masked.width !== base.width || layer._masked.height !== base.height) layer._masked = makeCanvas(base.width, base.height);
        out = layer._masked;
        const ctx = out.getContext("2d");
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, out.width, out.height);
        ctx.drawImage(base, 0, 0);
        ctx.globalCompositeOperation = "destination-in";
        drawMask(ctx, out.width, out.height);
        ctx.globalCompositeOperation = "source-over";
        layer._maskedValid = true;
        this.touchSource(out);
        return out;
    }

    /** The layer's mask with the in-progress mask stroke applied (white = visible), as a canvas to draw from; `display` as in layerPixels. */
    maskWithStroke(layer, display = false) {
        const p = this.pointer;
        if (!p || p.kind !== "maskpaint" || p.layer !== layer) return layer.maskPx ? (display ? canvasOf(layer.maskPx) : layer.maskPx.toCanvas()) : null;
        const target = layer.maskPx;
        let fresh = false;
        if (!this.maskPreview || this.maskPreview.width !== target.width || this.maskPreview.height !== target.height) {
            this.maskPreview = makeCanvas(target.width, target.height);
            this.maskPreview._livePreview = true;
            fresh = true;
        }
        if (p.maskPreviewOf !== this.maskPreview) { p.maskPreviewOf = this.maskPreview; fresh = true; }
        const box = fresh ? null : this.takeDirty(p, "dirtyMask", layer, target);
        if (fresh) p.dirtyMask = null;
        if (fresh || box) this.refreshStrokePreview(this.maskPreview, target, p, box, p.erase ? "destination-out" : "source-over");
        return this.maskPreview;
    }

    /** Handles of a layer: corners (nw, ne, sw, se) and edge midpoints (n, e, s, w). */
    layerHandles(l) {
        return {
            nw: [l.x, l.y], ne: [l.x + l.w, l.y], sw: [l.x, l.y + l.h], se: [l.x + l.w, l.y + l.h],
            n: [l.x + l.w / 2, l.y], s: [l.x + l.w / 2, l.y + l.h], w: [l.x, l.y + l.h / 2], e: [l.x + l.w, l.y + l.h / 2],
        };
    }

    /** Which handle of the active layer is under image point (ix, iy)? */
    handleAt(ix, iy) {
        const l = (!this.pending && this.groupBox()) || this.activeLayer();
        if (!l) return null;
        const r = HANDLE_PX / this.view.scale;
        const handles = this.layerHandles(l);
        for (const name of ["nw", "ne", "sw", "se", "n", "s", "w", "e"]) {
            const [cx, cy] = handles[name];
            if (Math.abs(ix - cx) <= r && Math.abs(iy - cy) <= r) return name;
        }
        return null;
    }

    updateTransformCursor(ix, iy) {
        const cls = this.viewEl.classList;
        cls.remove(...CURSOR_CLASSES);
        const l = this.activeLayer();
        if (!l) return;
        let h = null, rot = false;
        if (this.pending) {
            if (this.pending.mode !== "rotate") return;
            const [lx, ly] = this.toLayerLocal(l, this.pending.angle, ix, iy);
            h = this.handleAt(lx, ly);
            rot = !h && (lx < l.x || lx > l.x + l.w || ly < l.y || ly > l.y + l.h);
        } else {
            h = this.handleAt(ix, iy);
            rot = !h && !this.multiSelected() && this.rotateZoneAt(l, ix, iy);   // a group turns one layer at a time: no rotate zone
        }
        this.setHandleCursor(h, rot);
    }

    setHandleCursor(h, rot = false) {
        const cls = this.viewEl.classList;
        cls.remove(...CURSOR_CLASSES);
        if (rot) cls.add("ipc-rotate");
        else if (h === "n" || h === "s") cls.add("ipc-scale-y");
        else if (h === "e" || h === "w") cls.add("ipc-scale-x");
        else if (h === "ne" || h === "sw") cls.add("ipc-scale-ne");
        else if (h) cls.add("ipc-scale");
    }

    updateCanvasCursor(ix, iy) {
        const h = this.canvasHandleAt(ix, iy), f = this.frameOrCanvas();
        const inside = ix >= f.x && ix <= f.x + f.w && iy >= f.y && iy <= f.y + f.h;
        // a handle scales, inside moves, outside turns; the straighten line draws with the tool's own cursor
        const drawLine = this.frameStraighten;
        this.setHandleCursor(drawLine ? null : h, !drawLine && !h && !inside);
        this.viewEl.classList.toggle("ipc-move", !drawLine && !h && inside);
    }

    showPane(id) {
        if (!this.panes || !this.panes[id]) id = "image";
        for (const [k, pane] of Object.entries(this.panes)) pane.hidden = k !== id;
        for (const [k, b] of Object.entries(this.tabButtons)) b.classList.toggle("ipc-active", k === id);
        try { localStorage.setItem("ipc.pane", id); } catch (_) { /* ignore */ }
    }

    // ---- tool groups (flyouts) ----------------------------------------------------------------

    refreshGroupButton(g) {
        if (!g.btn || g.menu) return;
        const it = g.items.find((i) => i.tool === g.current) || g.items[0];
        g.btn.innerHTML = icon(it.tool) + '<span class="ipc-tri"></span>';
        g.btn.title = it.title + "\nHover, right-click or hold for the other tools of this group.";
        g.btn.classList.toggle("ipc-active", this.tool === it.tool);
    }

    openFlyout(g, anchor) {
        if (this.flyout && this.flyout.group === g) { clearTimeout(this._flyClose); return; }
        this.closeFlyout();
        const fly = el("div", "ipc-flyout");
        const add = (iconName, label, key, title, onClick, active, toggled) => {
            const b = iconButton(iconName, title, onClick, label);
            if (key) b.appendChild(el("span", "ipc-key", key));
            if (active) b.classList.add("ipc-active");
            if (toggled) b.classList.add("ipc-toggle-on");
            fly.appendChild(b);
            return b;
        };
        for (const it of g.items) add(it.tool, it.label, it.key, it.title, () => { this.setTool(it.tool); this.closeFlyout(); }, this.tool === it.tool, false);
        if (g.items.length && g.actions.length) fly.appendChild(el("div", "ipc-sep"));
        for (const a of g.actions) {
            if (a.sep) { fly.appendChild(el("div", "ipc-sep")); continue; }
            const b = add(a.icon, a.label, a.key, a.title, () => {
                a.onClick();
                if (a.toggle) b.classList.toggle("ipc-toggle-on", !!a.toggle()); else this.closeFlyout();
            }, false, a.toggle ? !!a.toggle() : false);
            if (a.disabled) b.disabled = true;
        }
        fly.addEventListener("pointerenter", () => clearTimeout(this._flyClose));
        fly.addEventListener("pointerleave", (e) => { if (!(g.btn && g.btn.contains(e.relatedTarget))) this.scheduleFlyoutClose(); });
        for (const type of ["pointerdown", "pointerup", "click", "wheel", "contextmenu"]) fly.addEventListener(type, (e) => e.stopPropagation());
        this.root.appendChild(fly);
        const an = anchor || (g && g.btn);
        const r = an && typeof an.getBoundingClientRect === "function" ? an.getBoundingClientRect() : { right: 0, left: 0, top: 0, bottom: 0, width: 0, height: 0 };
        const rr = this.root.getBoundingClientRect();
        let left = r.right - rr.left + 6;
        // an anchor at the right edge (a row of the side panel): the flyout opens to its left
        if (left + fly.offsetWidth > rr.width - 4) left = Math.max(4, r.left - rr.left - fly.offsetWidth - 6);
        fly.style.left = `${left}px`;
        const top = Math.min(r.top - rr.top, rr.height - fly.offsetHeight - 8);
        fly.style.top = `${Math.max(4, top)}px`;
        this.flyout = { el: fly, group: g };
        if (!this._flyDocDown) {
            this._flyDocDown = (e) => {
                const t = e.target instanceof Node ? e.target : null;
                if (this.flyout && (!t || (!this.flyout.el.contains(t) && !(this.flyout.group && this.flyout.group.btn && this.flyout.group.btn.contains(t))))) this.closeFlyout();
            };
            window.addEventListener("pointerdown", this._flyDocDown, true);
        }
    }

    scheduleFlyoutClose() {
        clearTimeout(this._flyClose);
        this._flyClose = setTimeout(() => this.closeFlyout(), 160);
    }

    /**
     * The window's capturing pointerdown listener the first flyout adds (openFlyout, openChoiceList: a press outside
     * closes the flyout). It closes over the editor, so one left on the window kept a closed tab's editor with all its
     * pixels for the rest of the session; close() and destroy() take it off, and the next flyout adds it again.
     */
    dropFlyoutListener() {
        if (this._flyDocDown) window.removeEventListener("pointerdown", this._flyDocDown, true);
        this._flyDocDown = null;
    }

    /** An open question (ask) answered with null, as Cancel does: its capturing keydown listener on the window goes. */
    closeAsk() {
        const finish = this._askFinish;
        this._askFinish = null;
        if (typeof finish === "function") finish(null);
    }

    closeFlyout() {
        clearTimeout(this._flyClose);
        if (!this.flyout) return;
        const cur = this.flyout;
        this.flyout = null;
        if (typeof cur.onClose === "function") {
            try { cur.onClose(); } catch (e) { console.error("flyout onClose failed", e); }
        }
        cur.el.remove();
    }

    // ---- view: rulers, grid, guides, before/after, compare, on-canvas text ----------------------

    /**
     * The side panel's width in CSS pixels (item 17), clamped to 310 px .. 60 % of the editor's body; null = the
     * default. A variable on the document, so every tab (and the node's editor) shows the same width; `save` keeps it
     * in localStorage like the rulers. The picture is refitted (resizeCanvas) if it was fitted. Returns the width set.
     */
    setSideWidth(w, { save = true } = {}) {
        const body = this.sidePanel && this.sidePanel.parentElement;
        // a hidden or closed tab's body has no box: the window stands in for it
        const room = (body && body.getBoundingClientRect().width) || window.innerWidth;
        const max = Math.max(SIDE_MIN_PX, Math.floor(room * SIDE_MAX_SHARE));
        const px = w == null || !Number.isFinite(+w) ? SIDE_DEFAULT_PX : Math.round(Math.min(max, Math.max(SIDE_MIN_PX, +w)));
        document.documentElement.style.setProperty("--ipc-side-w", px + "px");
        this.resizeCanvas();   // at once: the ResizeObserver waits for a rendering step, which a hidden window does not take
        if (save) {
            try {
                if (px === SIDE_DEFAULT_PX) localStorage.removeItem("ipc.sideWidth"); else localStorage.setItem("ipc.sideWidth", String(px));
            } catch (_) { /* no storage */ }
        }
        return px;
    }

    /** The width kept by setSideWidth, put back on the document (not clamped to this window: the panel's max-width does that). */
    applyStoredSideWidth() {
        let w = 0;
        try { w = Math.round(+localStorage.getItem("ipc.sideWidth") || 0); } catch (_) { /* no storage */ }
        document.documentElement.style.setProperty("--ipc-side-w", (w >= SIDE_MIN_PX ? w : SIDE_DEFAULT_PX) + "px");
    }

    toggleRulers() {
        this.showRulers = !this.showRulers;
        try { localStorage.setItem("ipc.rulers", this.showRulers ? "1" : "0"); } catch (_) { /* ignore */ }
        if (this.rulersBtn) this.rulersBtn.classList.toggle("ipc-toggle-on", this.showRulers);
        this.draw();
        this.setStatus(this.showRulers ? "Rulers on. Drag guides out of them." : "Rulers off.");
    }

    toggleGrid() {
        this.showGrid = !this.showGrid;
        try { localStorage.setItem("ipc.grid", this.showGrid ? "1" : "0"); } catch (_) { /* ignore */ }
        if (this.gridBtn) this.gridBtn.classList.toggle("ipc-toggle-on", this.showGrid);
        this.draw();
    }

    /** Guide near a device pixel (within 5 css px), or null. */
    guideAt(cx, cy) {
        const th = 5 * (window.devicePixelRatio || 1);
        const g = this.guides || { x: [], y: [] };
        for (let i = 0; i < g.x.length; i++) { const [sx] = this.imageToScreen(g.x[i], 0); if (Math.abs(sx - cx) <= th && !this.view.angle) return { axis: "x", index: i }; }
        for (let i = 0; i < g.y.length; i++) { const [, sy] = this.imageToScreen(0, g.y[i]); if (Math.abs(sy - cy) <= th && !this.view.angle) return { axis: "y", index: i }; }
        return null;
    }

    /** Everything drawn on top of the scene: grid, guides, compare divider, rulers, the text editor's position. */
    drawOverlays() {
        if (!this.isOpen || !this.base) return;
        const ctx = this.ctx;
        const W = this.canvas.width, H = this.canvas.height;
        const dpr = window.devicePixelRatio || 1;
        const s = this.view.scale;
        this.applyViewTransform(ctx);
        if (this.showGrid) {
            let step = Math.max(1, this.gridSize || 64);
            while (step * s < 8 * dpr) step *= 2;
            ctx.save();
            ctx.strokeStyle = "rgba(255,255,255,0.22)";
            ctx.lineWidth = 1 / s;
            ctx.beginPath();
            for (let x = 0; x <= this.width; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, this.height); }
            for (let y = 0; y <= this.height; y += step) { ctx.moveTo(0, y); ctx.lineTo(this.width, y); }
            ctx.stroke();
            ctx.restore();
        }
        const g = this.guides || { x: [], y: [] };
        const p = this.pointer;
        if (g.x.length || g.y.length || (p && p.kind === "guide" && p.pos != null)) {
            ctx.save();
            ctx.strokeStyle = "#7cc7ff";
            ctx.lineWidth = 1 / s;
            ctx.beginPath();
            for (const gx of g.x) { ctx.moveTo(gx, -1e5); ctx.lineTo(gx, 1e5); }
            for (const gy of g.y) { ctx.moveTo(-1e5, gy); ctx.lineTo(1e5, gy); }
            ctx.stroke();
            if (p && p.kind === "guide" && p.pos != null && p.index < 0) {
                ctx.setLineDash([6 / s, 4 / s]);
                ctx.beginPath();
                if (p.axis === "x") { ctx.moveTo(p.pos, -1e5); ctx.lineTo(p.pos, 1e5); } else { ctx.moveTo(-1e5, p.pos); ctx.lineTo(1e5, p.pos); }
                ctx.stroke();
            }
            ctx.restore();
        }
        // a plugin draws on the picture: under the straighten preview it turns with it
        if (this.viewTilt()) {
            ctx.save();
            this.applyTilt(ctx);
            host.pluginOverlay(this, ctx);
            if (this.boxes) this.boxes.draw(ctx);
            if (this.tool === "lights" && this.isRelightActive()) this.drawLightsOverlay(ctx);
            ctx.restore();
        } else {
            host.pluginOverlay(this, ctx);
            if (this.boxes) this.boxes.draw(ctx);
            if (this.tool === "lights" && this.isRelightActive()) this.drawLightsOverlay(ctx);
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (this.compare && this.compare.a && this.compare.b) {
            const split = Math.min(0.95, Math.max(0.05, this.compare.split ?? 0.5));
            const x = W * split;
            ctx.save();
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 2 * dpr;
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
            ctx.font = `${12 * dpr}px system-ui, sans-serif`;
            ctx.textBaseline = "top";
            const name = (id) => { const l = this.layers.find((q) => q.id === id); return l ? l.name : "?"; };
            const label = (txt, lx, align) => { ctx.textAlign = align; const w = ctx.measureText(txt).width + 12 * dpr; ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(align === "right" ? lx - w : lx, 8 * dpr, w, 18 * dpr); ctx.fillStyle = "#fff"; ctx.fillText(txt, align === "right" ? lx - 6 * dpr : lx + 6 * dpr, 11 * dpr); };
            label("A · " + name(this.compare.a), x - 8 * dpr, "right");
            label("B · " + name(this.compare.b), x + 8 * dpr, "left");
            ctx.restore();
        }
        if (this.showRulers) this.drawRulers(ctx, W, H, dpr);
        if (this.textEdit) this.positionTextEdit();
    }

    drawRulers(ctx, W, H, dpr) {
        const rp = RULER_PX * dpr;
        ctx.save();
        ctx.fillStyle = THEME.rulerBg;
        ctx.fillRect(0, 0, W, rp);
        ctx.fillRect(0, 0, rp, H);
        ctx.strokeStyle = THEME.rulerEdge;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, rp + 0.5); ctx.lineTo(W, rp + 0.5); ctx.moveTo(rp + 0.5, 0); ctx.lineTo(rp + 0.5, H); ctx.stroke();
        if (!this.view.angle) {
            const s = this.view.scale;
            const cands = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
            const step = cands.find((c) => c * s >= 48 * dpr) || 10000;
            const minor = step / 5;
            ctx.fillStyle = THEME.rulerText;
            ctx.strokeStyle = THEME.rulerTick;
            ctx.font = `${9 * dpr}px system-ui, sans-serif`;
            ctx.textBaseline = "top";
            ctx.textAlign = "left";
            const [ix0] = this.canvasToImage(rp, rp), [ix1] = this.canvasToImage(W, rp);
            const [, iy0] = this.canvasToImage(rp, rp), [, iy1] = this.canvasToImage(rp, H);
            ctx.beginPath();
            for (let v = Math.floor(ix0 / minor) * minor; v <= ix1; v += minor) {
                const [sx] = this.imageToScreen(v, 0);
                if (sx < rp) continue;
                const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
                ctx.moveTo(Math.round(sx) + 0.5, rp); ctx.lineTo(Math.round(sx) + 0.5, major ? rp * 0.35 : rp * 0.7);
                if (major) ctx.fillText(String(Math.round(v)), sx + 2 * dpr, 1 * dpr);
            }
            for (let v = Math.floor(iy0 / minor) * minor; v <= iy1; v += minor) {
                const [, sy] = this.imageToScreen(0, v);
                if (sy < rp) continue;
                const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
                ctx.moveTo(rp, Math.round(sy) + 0.5); ctx.lineTo(major ? rp * 0.35 : rp * 0.7, Math.round(sy) + 0.5);
                if (major) { ctx.save(); ctx.translate(2 * dpr, sy + 2 * dpr); ctx.rotate(Math.PI / 2); ctx.fillText(String(Math.round(v)), 0, -9 * dpr); ctx.restore(); }
            }
            ctx.stroke();
        }
        ctx.fillStyle = THEME.rulerBg;
        ctx.fillRect(0, 0, rp, rp);
        ctx.restore();
    }

    setCompare(side, h) {
        if (!this.compare) this.compare = { a: null, b: null, split: 0.5 };
        this.compare[side] = h.layerId;
        if (!this.compare.a || !this.compare.b) {
            const others = this.layers.filter((l) => l.kind === "result" && l.id !== h.layerId);
            const other = others[others.length - 1];
            if (other) this.compare[side === "a" ? "b" : "a"] = other.id;
        }
        if (this.compareBtn) this.compareBtn.classList.toggle("ipc-on", !!(this.compare.a && this.compare.b));
        this.draw();
        this.setStatus(this.compare.a && this.compare.b ? "Comparing A (left) and B (right). Drag the divider; Esc ends it." : `${side.toUpperCase()} set; choose the other result too.`);
    }

    toggleCompare() {
        if (this.compare) {
            this.compare = null;
            if (this.compareBtn) this.compareBtn.classList.remove("ipc-on");
            this.draw();
            this.setStatus("Compare ended.");
            return;
        }
        const res = this.layers.filter((l) => l.kind === "result");
        if (res.length < 2) { this.setStatus("Compare needs two result layers."); return; }
        this.compare = { a: res[res.length - 2].id, b: res[res.length - 1].id, split: 0.5 };
        if (this.compareBtn) this.compareBtn.classList.add("ipc-on");
        this.draw();
        this.setStatus(`Comparing A (${res[res.length - 2].name}, left) and B (${res[res.length - 1].name}, right). Drag the divider; Ctrl / Shift+click a history thumbnail changes A / B; Esc ends it.`, "info");
    }

    // ---- file cleanup ---------------------------------------------------------------

    /** File names every open editor and every open workflow tab still reference. */
    /** A job of the editor's worker, and the timings of the worker jobs since the last reset (phase R's benchmark, docs/PLAN_BCE.md §2b). */
    static get kernels() { return kernelsMode(); }
    static set kernels(mode) { setKernels(mode); }

    /** The window's kernel routes, defaults and overrides merged (px/kernels.js `kernelRoutes`; docs/PLAN_WASM_K1.md §1.3). */
    static get routes() { return kernelRoutes(); }

    /** Override one route on the window and in every job sent after it (`null` removes the override; a bad name or value throws). */
    static setRoute(name, value) { return setKernelRoute(name, value); }

    static workerJob(op, args = {}, transfer = []) {
        return workerCall(op, args, transfer);
    }

    /** The PNG writers of E2, the parted reader of K8, the banded TIFF reader of K18 and the pool, for tests and benchmarks. */
    static get parts() {
        return { usable: partsUsable, encodeTilePixels, encodeBands, encodeCanvas, uploadPixels, buildLayered, pool: editorPool, pngRoute: hugePngSize, imageRoute: imageFileSize, offThread: pixelsOffThread, pngPartsOf, readPngParts, pixelsFromTiff, tiffPlan, readTiffBand, readTiffBands };
    }

    /** Rows per band for `tiff_band` opens (K18; `0`: `TILE_SIZE`; `false`: `tiff_read` instead of `tiff_band`). */
    static tiffBandRows = 0;

    /** PNG files of at least this many pixels are opened through the stream reader when they need no colour management (0: only above the canvas limit). */
    static pngStreamFrom = 32 * 1024 * 1024;

    /** Image files (JPEG, WebP, a PNG the stream reader does not take) of at least this many pixels are decoded in a pool worker on tiles (0: never). */
    static imageWorkerFrom = 32 * 1024 * 1024;

    /** The heal's Poisson blend at the release (false: the dabs' quick heal is what lands, as before 0.1.32). */
    static healBlend = true;

    /** A heal stroke's box above this many pixels keeps the quick heal (the blend's grids take about 40 bytes a pixel). */
    static healBlendMax = 8 * 1024 * 1024;

    /** A heal stroke with at most this many pixels to heal, in a box of at most `healSyncBox`, is blended at the release
     * (up to about 60 ms: the blend's cost follows the box too); more go to a worker. */
    static healSyncMax = 128 * 1024;

    static healSyncBox = 512 * 1024;

    /** Remove fills a stroke up to this many pixels across (its crop is twice that, scaled to the model's 512 x 512). */
    static removeMaxHole = 2048;

    /** A liquify stroke whose tiles hold at most this many pixels is baked at the release; more in the pool (0: always the pool). */
    static liquifySyncMax = 256 * 1024;

    /** A liquify bake's gathered block at most this many pixels (inpaint_liquify.js; tests force it small). 0: the module's. */
    static liquifyBlockMax = 0;

    /** Grow, shrink, swirl and restore dab this often (ms) while the button is held still; 0 turns the timer off (tests). */
    static liquifyRateMs = 33;

    /** The dense dab kernel `liquifyDab` passes to `LiquifyField.dab` (K30; `null` forces the Map-based reference loop). */
    static liquifyDabKernel = liquifyDab;

    /** Liquify's preview of a box larger than this many pixels is computed at a coarser resolution and scaled up. */
    static liquifyPreviewMax = 256 * 1024;

    /** A patch drag shows the picture it would take (Source) or the piece it copies (Destination) up to this many pixels of the selection's box; above, only the outline follows. */
    static patchPreviewMax = 2 * 1024 * 1024;

    static jobTimings(reset = false) {
        const out = JOB_TIMINGS.slice();
        if (reset) JOB_TIMINGS.length = 0;
        return out;
    }

    /** The window's step marks (inpaint_jobs.js `markStep`): a copy; `reset` clears them. */
    static stepMarks(reset = false) {
        const out = STEP_MARKS.slice();
        if (reset) STEP_MARKS.length = 0;
        return out;
    }

    /** The window thread's px kernel calls by export name (px/kernels.js `pxCalls`, the K0b harness): a copy; `reset` clears them. */
    static pxCalls(reset = false) {
        return pxCalls(reset);
    }

    /** The window's px clocks on or off (no argument: the current state); while on, every job asks its worker for a split (K1). */
    static pxTimed(on) {
        return on === undefined ? pxTimed() : pxTimed(on);
    }

    /** The window thread's split since the last `pxCalls(true)` (px/kernels.js `pxSplit`); `since` a split taken before. */
    static pxSplit(since = null) {
        return pxSplit(since);
    }

    /** The window thread's px instance: its serial, bytes, holds and renewals by cause (px/kernels.js `pxInstances`). */
    static pxInstances() {
        return pxInstances();
    }

    /** The measurement generation the jobs carry (inpaint_jobs.js `measureGen`); `next` starts a new one. */
    static measureGen(next = false) {
        return measureGen(next);
    }

    /** The worker jobs sent and not answered yet, the pool's queue included (a harness's settle waits for 0). */
    static pendingJobs() {
        return pendingJobs();
    }

    /** Stop the pool's workers so the next job starts new ones (a harness's fresh pool). */
    static resetPool() {
        resetPool();
    }

    static referencedFiles() {
        const keep = new Set();
        const scan = (text) => { for (const m of String(text || "").matchAll(/"filename"\s*:\s*"([^"]+)"/g)) keep.add(m[1]); };
        for (const text of host.referencedTexts ? host.referencedTexts() : []) scan(text);   // the node's open workflow tabs
        for (const ed of host.editors()) {
            scan(ed.lastValueString);
            try { scan(ed.getValue()); } catch (_) { /* ignore */ }
            scan(JSON.stringify(ed.uploaded));
            scan(JSON.stringify(ed.layers.map((l) => [l.ref, l.maskRef, l.exportRef, l.lut && l.lut.ref, l.plate && l.plate.ref])));
            if (ed.base) scan(JSON.stringify(ed.base.ref));
            // what the undo and redo steps and the named snapshots hold: an undo puts those files back (not caught: a walk
            // that fails stops the clean-up)
            scan(JSON.stringify(ed.heldFileRefs()));
        }
        try { for (let i = 0; i < localStorage.length; i++) scan(localStorage.getItem(localStorage.key(i))); } catch (_) { /* ignore */ }
        return Array.from(keep);
    }

    /**
     * The base image, `{ ref, px }` or null (C6 d): the file in the mirror (the state, runs, uploads) and its pixels, made
     * once when the base is set. The base kept the <img> it was decoded from, `{ ref, img }`, and made its pixels from it
     * on the first frame: at 15000 x 10000 a 572 MB decoded image kept for the life of the base and of every canvas undo
     * step, a second decode of each crop, resize, extend, merge into the base, flatten and generated base after its own
     * upload came back as an <img>, and 0.5 to 0.8 s of `fromImage` on the first frame after an undo of any of them.
     * A base is never written, only replaced; a replaced base's atlas pages go (C6 a).
     */
    get base() { return this._base || null; }

    set base(v) {
        const old = this._base;
        this._base = v || null;
        if (old && (!v || old.px !== v.px)) this.scheduleDetachedRelease();
    }

    /** The base image's pixels; null exactly when there is no base image. */
    get basePx() { return this._base ? this._base.px || null : null; }

    get _basePx() { return this.basePx; }

    /**
     * Upload every edited layer so its pixels survive a reload. Only dirty pixels are
     * materialised (autosave calls this for every tab); the file name is the PNG's hash.
     */
    /**
     * Upload every edited layer and mask. One pass at a time per document (the 15 s autosave and a save before closing
     * can ask at once: the second waits for the first, so it never finds a layer "clean" whose upload is still running).
     * A layer counts as clean from the start of its upload, so a change during the upload marks it again for the next
     * pass; a failed upload marks it again too.
     */
    syncLayers() {
        const pass = (this._syncing || Promise.resolve()).catch(() => {}).then(() => this.syncLayersOnce());
        this._syncing = pass;
        return pass;
    }

    async syncLayersOnce() {
        for (const layer of this.layers) {
            if (layer.dirty && layer.px) {
                layer.dirty = false;
                try {
                    const { ref } = await uploadPixels(layer.px, `n${this.node.id}_layer`);
                    layer.ref = ref;
                } catch (err) {
                    layer.dirty = true;
                    throw err;
                }
            }
            if (layer.maskDirty && layer.maskPx) {
                layer.maskDirty = false;
                try {
                    const { ref } = await uploadPixels(layer.maskPx, `n${this.node.id}_lmask`);
                    layer.maskRef = ref;
                } catch (err) {
                    layer.maskDirty = true;
                    throw err;
                }
            }
        }
        this.notifyChanged();
    }

    /** Draw once on the next animation frame, however many slider events arrive before it. */
    drawSoon() {
        if (this._drawQueued) return;
        this._drawQueued = true;
        requestAnimationFrame(() => { this._drawQueued = false; this.draw(); });
    }

    /** A skin was switched (renderer/skins.js): redraw what took its colours from THEME. */
    themeChanged() { try { this.renderLayers(); } catch (err) { console.warn("theme: layers", err); } try { this.syncTipControls(); } catch (err) { console.warn("theme: tip", err); } this.drawSoon(); }

    // ---- queue -------------------------------------------------------------

    // ---- editor-driven settings (setting_n outputs) -------------------------------

    /** Connected setting outputs with their targets: [{index, output, node, inputName, spec, widget}]. */
    settingTargets() {
        return host.settingTargets(this);
    }

    settingTargetsFromGraph() {
        const res = [];
        const outs = this.node.outputs || [];
        const graph = this.node.graph || (host.graph ? host.graph() : null);
        for (let i = FIXED_OUTPUTS; i < outs.length; i++) {
            const o = outs[i];
            if (!isSettingOutput(o) || !o.links || !o.links.length) continue;
            const link = linkOf(graph, o.links[0]);
            if (!link) continue;
            const target = graph.getNodeById(link.target_id);
            if (!target) continue;
            const input = target.inputs && target.inputs[link.target_slot];
            if (!input) continue;
            const inputName = input.name;
            const nd = target.constructor && target.constructor.nodeData;
            const spec = nd && nd.input && ((nd.input.required && nd.input.required[inputName]) || (nd.input.optional && nd.input.optional[inputName])) || null;
            const widget = target.widgets && target.widgets.find((w) => w.name === inputName) || null;
            res.push({ index: settingIndex(o), output: o, node: target, inputName, spec, widget });
        }
        return res;
    }

    /** Kind and options of a target input from its node definition (or its widget as fallback). */
    settingKind(t) {
        const spec = t.spec;
        let type = spec ? spec[0] : (t.widget ? t.widget.type : "STRING");
        let opts = spec && spec[1] ? spec[1] : {};
        if (Array.isArray(type)) return { kind: "combo", options: type, opts };
        if (type === "COMBO") return { kind: "combo", options: (opts.options || (t.widget && t.widget.options && t.widget.options.values) || []), opts };
        if (type === "INT" || type === "FLOAT") return { kind: "number", type, opts };
        if (type === "BOOLEAN") return { kind: "boolean", opts };
        if (t.widget && t.widget.type === "combo") return { kind: "combo", options: (t.widget.options && t.widget.options.values) || [], opts };
        if (t.widget && t.widget.type === "number") return { kind: "number", type: Number.isInteger(t.widget.options && t.widget.options.precision) && t.widget.options.precision === 0 ? "INT" : "FLOAT", opts: t.widget.options || {} };
        return { kind: "string", opts };
    }

    /** Called when a setting output is (dis)connected: keep the stored values in step with the targets. */
    settingsChanged() {
        const targets = this.settingTargets();
        const live = new Set();
        for (const t of targets) {
            const key = String(t.index);
            live.add(key);
            const k = this.settingKind(t);
            const label = `${t.node.title || t.node.type} · ${t.inputName}`;
            const type = k.kind === "number" ? k.type : (k.kind === "boolean" ? "BOOLEAN" : (k.kind === "combo" ? "COMBO" : "STRING"));
            const cur = this.settings[key];
            // the app's local recipes give a key with the recipe in it; the node's graph targets have none
            const target = t.key || `${t.node.id}:${t.inputName}`;
            if (!cur || cur.target !== target) {
                // new target: start from what the widget shows now, so connecting changes nothing
                const value = t.widget ? t.widget.value : (k.kind === "combo" ? k.options[0] : (k.kind === "number" ? (k.opts.default ?? 0) : (k.kind === "boolean" ? !!k.opts.default : "")));
                this.settings[key] = { value, type, label, target };
            } else {
                cur.type = type; cur.label = label;
            }
        }
        for (const key of Object.keys(this.settings)) if (!live.has(key)) delete this.settings[key];
        this.renderSettings();
        this.notifyChanged();
    }

    renderSettings() {
        // a preset or a recipe may switch a row the layout reads (a ToAPIs channel)
        this.refreshRefLayout();
        if (!this.settingsList) return;
        const list = this.settingsList;
        list.innerHTML = "";
        const targets = this.settingTargets();
        if (!targets.length) {
            // the app's rows come from the recipe, not from wiring: its shell sets its own text (noSettingsText)
            list.appendChild(el("span", null, this.noSettingsText || "Wire a setting output of the node into any widget (lora_name, ckpt_name, steps ...) and it shows up here."));
            return;
        }
        host.renderPresets(this, list, targets);
        for (const t of targets) {
            const key = String(t.index);
            const entry = this.settings[key];
            if (!entry) continue;
            const k = this.settingKind(t);
            const lab = el("label", null, entry.label);
            lab.title = `setting_${t.index} → ${entry.label}`;
            let control;
            const commit = (v) => { entry.value = v; if (t.widget) { try { t.widget.value = v; } catch (_) { /* read-only */ } } this.notifyChanged(); this.refreshRefLayout(); };
            if (k.kind === "combo") {
                // a file the server's list lacks stays the recipe's choice, marked in the select (issue #4: until 0.1.45
                // the row silently became the folder's first file, a Flux file on most installs); the app's host refuses
                // the run with the file and its download link (missingFilesRefusal). An empty value still takes the first.
                const options = k.options.map(String), value = String(entry.value ?? "");
                const known = options.includes(value);
                const missing = !known && options.length > 0 && value !== "";
                control = selectInput(missing ? [...options, { value, label: `${value} (not on the server)` }] : options, value, entry.label);
                if (!known && !missing && options.length) { entry.value = k.options[0]; control.value = String(entry.value); }
                if (missing) {
                    control.classList.add("ipc-sel-missing");
                    control.title = `${entry.label}: ${value} is not on the server. Put the file in its models folder (Generate names the download link), or pick one of the server's files here.`;
                }
                control.addEventListener("change", () => commit(control.value));
            } else if (k.kind === "number") {
                const o = k.opts || {};
                control = numberInput(entry.value, o.min ?? -1e9, o.max ?? 1e9, entry.label, 96);
                control.step = o.step ?? (k.type === "INT" ? 1 : 0.01);
                control.addEventListener("change", () => commit(k.type === "INT" ? Math.round(+control.value || 0) : (+control.value || 0)));
            } else if (k.kind === "boolean") {
                control = document.createElement("input"); control.type = "checkbox"; control.checked = !!entry.value;
                control.addEventListener("change", () => commit(control.checked));
            } else {
                control = document.createElement("input"); control.type = "text"; control.value = entry.value == null ? "" : String(entry.value); control.spellcheck = false;
                control.addEventListener("keydown", (e) => e.stopPropagation());
                control.addEventListener("change", () => commit(control.value));
            }
            lab.appendChild(control);
            list.appendChild(lab);
        }
    }

    /** Name of the result input the current mode expects, and whether something is wired to it. */
    /** Which result input the run will use: the mode's own, or the other one when only that is wired. */
    resultInputState() {
        return host.resultInputState(this);
    }

    resultInputStateFromGraph() {
        const want = this.genSettings.mode === "local" ? "result_local" : "result";
        const other = want === "result" ? "result_local" : "result";
        const wired = (name) => { const input = (this.node.inputs || []).find((i) => i.name === name); return !!(input && input.link != null); };
        if (wired(want)) return { name: want, wired: true, fallback: false };
        if (wired(other)) return { name: other, wired: true, fallback: true };
        return { name: want, wired: false, fallback: false };
    }

    syncGenControls() {
        this.syncBoxesRow();
        if (!this.modeSel) return;
        const local = this.genSettings.mode === "local";
        // the app adds a third mode, cloud (Comfy Cloud recipes); a mode the select lacks shows as api
        this.modeSel.value = this.genSettings.mode;
        if (this.modeSel.value !== this.genSettings.mode) this.modeSel.value = local ? "local" : "api";
        this.denoiseInput.value = this.genSettings.denoise;
        if (this.denoiseVal) this.denoiseVal.textContent = (+this.genSettings.denoise || 1).toFixed(2);
        this.seedInput.value = this.genSettings.seed;
        this.seedRandom.checked = !!this.genSettings.seedRandom;
        this.refineBtn.classList.toggle("ipc-toggle-on", !!this.genSettings.refine);
        this.refineBtn.hidden = !local;
        this.denoiseInput.parentElement.hidden = !local;
        // a Comfy Cloud graph takes the negative where it has one, as a local chain does; left empty, it keeps its own
        if (this.negativeInput) {
            const cloud = this.genSettings.mode === "cloud";
            this.negativeInput.hidden = !(local || cloud);
            if (this._negativeHint == null) this._negativeHint = this.negativeInput.placeholder;
            this.negativeInput.placeholder = cloud ? "Negative prompt. Left empty, the recipe's graph keeps its own negative." : this._negativeHint;
        }
    }

    /**
     * The Boxes switch under the prompt field (item 28 S3d): shown while the recipe sends boxes (host.boxSwitch), its
     * label counting the document's boxes; the hint says what goes while it is on (the selection, with no boxes) and
     * that the boxes stay home while it is off. The node always shows it (its host answers takes: the canvas output
     * box_prompt carries the boxes; the editor owns them there, inpaint_boxes.js).
     */
    syncBoxesRow() {
        if (!this.boxesRow) return;
        const s = host.boxSwitch(this);
        this.boxesRow.hidden = !(s && s.takes);
        if (!s) return;
        const on = !!this.genSettings.boxes;
        this.boxesCheck.checked = on;
        this.boxesLabel.textContent = s.count ? `Boxes · ${s.count}` : "Boxes";
        this.boxesHint.textContent = on ? (s.count ? "" : "the selection goes as one box") : (s.count ? "not sent" : "");
    }

    /** Drop the helper models from VRAM: ComfyUI's /free resets the executor, which releases the node instances holding them. */
    /**
     * Give the caches back: the filtered and matched copies, the masked layers, the
     * scratch canvases, the display pyramids and the compositor's textures. Everything
     * here is rebuilt on demand, so the only cost is the next frame; the pyramid comes
     * back one level per frame by design. `deep` also drops the GPU-side pool through
     * the hook the app sets (`releaseGpu`). `mirrors` also gives back the display canvases of
     * pixels on tiles (a cache of the tiles, made again and synced by the next frame that shows
     * them, which costs a putImageData per tile: for tabs that are not in front). Returns the bytes
     * it let go of.
     */
    releaseCaches({ deep = false, mirrors = false } = {}) {
        const px = (c) => (c && c.width ? c.width * c.height * 4 : 0);
        let freed = 0;
        const sources = [];
        for (const l of this.layers) {
            for (const slot of ["_fcache", "_fcacheView", "_fcacheSample", "_mcache", "_mcacheView", "_mcacheSample"]) {
                if (l[slot]) { freed += px(l[slot].canvas); l[slot] = null; }
            }
            l._fxCache = null;
            l._fxCacheView = null;
            l._fxCacheSample = null;
            l._mstats = null;
            l._mstatsSample = null;
            l._mstatsSampleRun = null;
            l._mstatsStack = null;
            l._mstatsStackRun = null;
            if (l._masked) { freed += px(l._masked); sources.push(l._masked); l._masked = null; l._maskedValid = false; }
            if (deep && l._relight) {
                if (l._relight.normals && l._relight.normals.data) freed += l._relight.normals.data.byteLength;
                if (l._relight.vis && l._relight.vis.data) freed += l._relight.vis.data.byteLength;
                if (l._relight.visQuick && l._relight.visQuick.data) freed += l._relight.visQuick.data.byteLength;
                if (l._relight.depthQuick && l._relight.depthQuick.data) freed += l._relight.depthQuick.data.byteLength;
                l._relight = null;
            }
            for (const p of [l.px, l.maskPx]) if (p) sources.push(displayCanvasIfMade(p));
        }
        for (const name of ["sceneCanvas", "viewCanvas", "flatCanvas", "filterMaskCanvas", "strokePreview", "maskPreview", "maskedPreview", "antsCanvas", "strokeView", "strokeMaskView", "_strokePatch", "_strokeClip", "_strokeDev", "_passView", "_passMaskView", "_filterMaskView", "_smudgeSrc", "_smudgeClip", "_smudgeTip", "_brushBytes", "_cloneDab", "_healDest", "_dabMask", "_blendScratchGpu", "_blendScratchCpu"]) {
            if (this[name]) { freed += px(this[name].c || this[name]); this[name] = null; }
        }
        if (this._brushRead) { for (const c of this._brushRead) if (c) freed += px(c); this._brushRead = null; }
        if (this._walkScratches) { for (const c of this._walkScratches.values()) freed += px(c); this._walkScratches = null; }
        releaseBoxBuffers();
        if (this.flatCache) { freed += px(this.flatCache.canvas); this.flatCache = null; }
        this.sceneSig = null;
        // the pyramids: their levels are exclusively theirs, the sources stay
        // the base's pixels only when they were built: asking basePx here would build them
        for (const src of [...sources, displayCanvasIfMade(this._basePx), displayCanvasIfMade(this.sel)]) {
            if (!src) continue;
            const entry = this.pyramids.get(src);
            if (!entry) continue;
            for (const lvl of entry.levels) freed += px(lvl);
            freed += px(entry.gpu);
            this.pyramids.delete(src);
        }
        if (this._compositor) {
            const st = this._compositor.stats ? this._compositor.stats() : null;
            if (st) freed += st.bytes + ((st.atlas && st.atlas.bytes) || 0);   // the source textures and the tile atlas
            this._compositor.clear();
        }
        if (mirrors) {
            // after the pyramids and the textures, which were keyed on these canvases; the caches
            // above that could hold one (_mcache*, flatCache) are gone too. The canvas backend's
            // display canvas is the pixels themselves and answers 0.
            for (const p of this.heldPixels()) freed += p.releaseDisplay();
        }
        if (deep && typeof this.releaseGpu === "function") { try { freed += this.releaseGpu() || 0; } catch (_) { /* no GPU path */ } }
        // the mips scheduler's buffers for its next batch (the module's, up to 32 MB): only while no chain is on its way (C6 b)
        if (this.tileMode) freed += chainScheduler().releasePool();
        // deliberately no draw: a background tab that redrew here would build every cache
        // straight back. The next draw (a gesture, or the tab coming forward) rebuilds
        // exactly what it needs; the caller redraws when the tab is the one in front.
        return freed;
    }

    /**
     * Every pixels object this editor holds: the layers' and masks', the base's (when built), the
     * selection, and what the undo and redo steps keep (rect copies, the layers of a layers / canvas
     * step). Each once.
     */
    heldPixels() {
        const out = new Set();
        const add = (p) => { if (p instanceof LayerPixels) out.add(p); };
        for (const l of this.layers) { add(l.px); add(l.maskPx); }
        add(this._basePx);
        add(this.sel);
        for (const list of [this.undo, this.redo, this.snapshots.map((s) => s.snap)]) {
            for (const st of list) {
                if (!st) continue;
                add(st.px);
                add(st.maskPx);   // on tiles: a mask / layerfull step's clone
                add(st.selPx);    // on tiles: a canvas step's selection
                add(st.base && st.base.px);   // a canvas step's base (C6 d: its pixels, where it held an <img>)
                for (const l of st.layers || []) { add(l.px); add(l.maskPx); }
                for (const p of st.pixels || []) { add(p && p.px); add(p && p.maskPx); }   // a turn step's and a named snapshot's clones
            }
        }
        return out;
    }

    /**
     * Every file ref (`{ filename, subfolder, type }`) the undo and redo steps and the named snapshots hold: a layer
     * record's `ref` and `maskRef` (layers, canvas and turn steps), a text's user font (`text.fontRef`, a text step's
     * too), a filter's LUT and grain plate, a canvas or turn step's base, the document maps' files, the plugins' data a
     * step keeps. An undo puts these back with their refs and uploads none of them again, so Settings › Local files ›
     * Clean up keeps them (the host's referencedFileKeys, and the node's referencedFiles); it removed them, and an undo across
     * the clean-up left a layer, a font or the whole picture naming a file the next start and the next save could not find.
     */
    heldFileRefs() {
        return this.fileRefsOf([...(this.undo || []), ...(this.redo || []), ...(this.snapshots || []).map((s) => s && s.snap)]);
    }

    /**
     * The file refs in these steps (undo steps, turn snapshots: the assistant's "Undo this turn" record asks too). Each
     * step is walked as data: plain objects and arrays, every object with a `filename` string being a ref, so a ref field
     * a later step adds is found too. Pixels, canvases, images, typed arrays and maps are class instances and are not
     * entered, nor the layers' `_` caches.
     */
    fileRefsOf(steps) {
        const out = [];
        const seen = new Set();
        const walk = (v, depth) => {
            if (!v || typeof v !== "object" || depth > 40 || seen.has(v)) return;
            const proto = Object.getPrototypeOf(v);
            const array = Array.isArray(v);
            if (!array && proto !== Object.prototype && proto !== null) return;
            seen.add(v);
            if (array) { for (const x of v) walk(x, depth + 1); return; }
            if (typeof v.filename === "string" && v.filename) out.push(v);
            for (const k of Object.keys(v)) if (k.charCodeAt(0) !== 95) walk(v[k], depth + 1);   // not the "_" caches
        };
        for (const st of steps || []) walk(st, 0);
        return out;
    }

    async freeHelperModels() {
        const freed = this.releaseCaches({ deep: true });
        const mb = Math.round(freed / 1048576);
        this.drawSoon();
        try { await host.freeHelpers(); } catch (err) { console.warn(err); }
        if (!host.connected) { this.helperUsed = false; this.setStatus(`Freed ${mb} MB of caches; the in-app helper models are unloaded too.`); return; }
        try {
            this.setStatus(`Freed ${mb} MB of caches. Freeing helper models (SAM, Qwen-VL) from VRAM ...`);
            const r = await api.fetchApi("/free", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }) });
            if (r.status !== 200) throw new Error("/free answered " + r.status);
            this.helperUsed = false;
            this.setStatus(`Freed ${mb} MB of caches; the helper models are out of VRAM too.`);
        } catch (err) {
            console.warn("Inpaint Canvas: could not free models", err);
            this.setStatus("Could not free the helper models: " + (err.message || err), failKind(err));
        }
    }

    /**
     * Generate with the host's recipe. `opts` (the app's Each area, eacharea.js; the button and Ctrl+Enter pass none):
     * `refs` a reference snapshot to send instead of the one of now, `area` one area of the selection to run on instead of
     * the selection itself (the host reads it in place of `this.sel`; the document's selection is never touched).
     */
    async generate(opts = {}) {
        this.lastRunError = null;
        if (!this.base) { this.setStatus("Load an image first."); return; }
        // One API run per document: the host holds `providerPending` until its result has landed, and the button stays
        // disabled while the run is awaited. Ctrl+Enter (the editor's keys and the prompt field) reaches here directly, so
        // a run that needs that slot (the host's resultInputState says `provider`) is refused here, before the seed is
        // rolled or the button freed under the first run. A recipe on the user's ComfyUI takes no slot and keeps
        // queueing (ComfyUI queues on purpose), also while a 1× pass or a selection's upscale holds it; not while a run
        // whose landing resizes the document holds it (`resizes`: an upscale of the whole picture, the Realism Pass
        // above 1×), whose result would land in the old geometry. The node's host has no slot.
        const area = (opts && opts.area) || null;
        // the app's Each area (eacharea.js) runs its areas one by one on this document: a Generate of the whole selection
        // meanwhile would land among them (and on the user's ComfyUI hold up the next area)
        if (!area && this._eachArea) {
            this.lastRunError = new Error("Each area is running on this document: wait for it, or stop it.");
            this.setStatus(this.lastRunError.message, "info");
            return { error: this.lastRunError };
        }
        if (this.providerPending && (this.resultInputState().provider || this.providerPending.resizes)) {
            this.lastRunError = new Error(RUN_GOING_TEXT);
            this.setStatus(this.lastRunError.message, "info");
            return { error: this.lastRunError };
        }
        // the prompt and the references as they are at the click (docs/PLAN_REFS.md C3): a later hide or move does not
        // change what this run sends
        const refs = (opts && opts.refs) || this.refSnapshot();
        if (this.removePending || this.healPending || this.liquifyPending) { this.setStatus("Waiting for the stroke to land..."); await this.heldEdit(); }
        if (this.genSettings.seedRandom) { this.genSettings.seed = randomSeed(); if (this.seedInput) this.seedInput.value = this.genSettings.seed; }
        const { name, wired } = this.resultInputState();
        try {
            this.generateBtn.disabled = true;
            // Local mode: the helper models (Qwen-VL, SAM3, SAM2, RMBG) keep their weights inside their node
            // instances, invisible to ComfyUI's model management. Before a local run they are freed, so a big
            // model such as Flux.2 gets the whole card; in API mode they simply stay resident.
            if (this.genSettings.mode === "local" && this.helperUsed) await this.freeHelperModels();
            this.setStatus(wired ? `Queueing (${this.genSettings.mode}, seed ${this.genSettings.seed}, result from ${name}) ...` : `Queueing, but nothing is wired into "result" or "result_local": the result will not come back into the canvas.`);
            await host.queueGenerate(this, area ? { refs, area } : { refs });
        } catch (err) {
            console.error(err);
            // kept for the app's generate command, which throws it at once; also returned, so a caller gets its own run's
            this.lastRunError = err instanceof Error ? err : new Error(String(err));
            this.setStatus(String(err.message || err), failKind(err));
            return { error: this.lastRunError };
        } finally {
            this.generateBtn.disabled = false;
            if (this.isOpen) this.root.focus({ preventScroll: true });
        }
    }

    // ---- persistence -------------------------------------------------------

    notifyChanged() {
        if (this.boxes) this.boxes.refresh();   // a box written, an undo or redo of one, a restored workflow
        host.changed(this);
    }

    /** Encode the selection PNG for getValue off the main thread and save again when it lands. */
    encodeSelectionSoon() {
        if (this._selEncoding) return;
        this._selEncoding = true;
        const seq = this.selectionSeq;
        const sel = this.sel;   // a replaced selection is a new object: its PNG is not stored
        // E5: on tiles the PNG holds the box the selection's tiles cover (`selectionBox` says where it goes), read from the
        // tiles; a box too large for a canvas (an inverted selection of a huge document) is the whole mask written in
        // parts by the pool. It was `sel.toCanvas()`: a canvas of the whole image for every change of the selection
        // (600 MB at 15000 x 10000), and nothing at all above the canvas limit.
        let blobOf, box = null;
        try {
            const ext = isTilePixels(sel) ? sel.bounds() : null;
            if (isTilePixels(sel) && !ext) {
                this._selEncoding = false;
                this.selectionDataUrl = null; this.selectionBox = null;
                if (seq === this.selectionSeq) this.selectionEncoded = true;
                return;
            }
            if (ext && (ext[2] - ext[0]) * (ext[3] - ext[1]) <= SEL_BOX_MAX_PX) {
                box = [ext[0], ext[1], ext[2] - ext[0], ext[3] - ext[1]];
                const c = document.createElement("canvas");
                c.width = box[2]; c.height = box[3];
                c.getContext("2d", { willReadFrequently: true }).putImageData(sel.readRect(box[0], box[1], box[2], box[3]), 0, 0);
                blobOf = canvasToBlob(c).finally(() => { c.width = 1; c.height = 1; });
            } else if (ext) {
                blobOf = encodeTilePixels(sel).then((r) => { if (!r) throw new Error("the selection is too large to be saved without the worker pool"); return r.blob; });
            } else {
                blobOf = canvasToBlob(sel.toCanvas());
            }
        } catch (err) {
            this._selEncoding = false;
            console.warn("Inpaint Canvas: selection encode failed", err);
            return;
        }
        blobOf
            .then((blob) => new Promise((res, rej) => {
                const r = new FileReader();
                r.onload = () => res(r.result);
                r.onerror = () => rej(r.error);
                r.readAsDataURL(blob);
            }))
            .then((url) => {
                this._selEncoding = false;
                if (sel !== this.sel) return;
                this.selectionDataUrl = url;
                this.selectionBox = box;
                if (seq === this.selectionSeq) {
                    this.selectionEncoded = true;
                    this.notifyChanged();   // save again, now with the fresh selection
                } else {
                    this.encodeSelectionSoon();
                }
            })
            .catch((err) => { this._selEncoding = false; console.warn("Inpaint Canvas: selection encode failed", err); });
    }

    /**
     * What this editor holds in pixels, as plain data (bytes are w * h * 4, the backing
     * store of a canvas). Nothing here allocates or frees; it is the input of
     * tools/mem_test.py and of the memory work in the app's docs/PERFORMANCE.md.
     * The GPU filter chain is app-only and is asked separately (glPoolStats()).
     *
     * Pixels on tiles (docs/PLAN_BCE.md §C2 step b) are reported under the same slot names with
     * `tiles` and the bytes of their allocated tiles, a tile shared copy-on-write by several
     * pixels objects counted once (the first holder in the order layers, base, selection, undo);
     * their display mirror, where one was made, is a slot of its own ("mirror", a canvas of the
     * pixels' size in renderer memory). `tiles` at the top sums both.
     */
    memoryReport() {
        const px = (c) => (c && c.width ? c.width * c.height * 4 : 0);
        const seen = new Set();          // one canvas (or tile) counted once, however many slots hold it
        const add = (into, name, c) => {
            if (!c || !c.width) return;
            const bytes = px(c);
            into.push({ name, w: c.width, h: c.height, bytes, shared: seen.has(c) });
            seen.add(c);
        };
        const tileSum = { pixels: 0, tiles: 0, bytes: 0, sharedTiles: 0, chains: 0, chainBytes: 0, mirrors: 0, mirrorBytes: 0, thumbnails: 0, thumbnailBytes: 0, regions: 0, regionBytes: 0, primedBytes: 0 };
        // the mip chains a tile keeps and its edge copy (C6 b): a buffer a copy on write shares is counted once
        const chainSeen = new Set();
        const addChains = (t) => {
            for (const b of [t.mips, t.edge && t.edge.mips, t.edge && t.edge.data]) {
                if (!b || chainSeen.has(b.buffer)) continue;
                chainSeen.add(b.buffer);
                tileSum.chains++; tileSum.chainBytes += b.byteLength;
            }
        };
        // the tiles of `p` no slot counted yet: [tiles, bytes, tiles counted before]
        const newTiles = (p, skip = null) => {
            let n = 0, bytes = 0, old = 0;
            for (const t of p.tileList()) {
                if (seen.has(t) || (skip && skip.has(t))) { old++; continue; }
                seen.add(t);
                n++;
                bytes += t.data.byteLength;
                addChains(t);
            }
            return [n, bytes, old];
        };
        // a pixels object into `into` under `name`: its backing canvas, or its new tiles plus its mirror
        const addPixels = (into, name, p) => {
            if (!p) return;
            if (!isTilePixels(p)) { add(into, name, canvasOf(p)); return; }
            const [n, bytes, old] = newTiles(p);
            tileSum.pixels++; tileSum.tiles += n; tileSum.bytes += bytes; tileSum.sharedTiles += old;
            // the cells of a primed exact read still in flight (C6 c3); zero unless one is reading right now
            if (p.primedBytes) tileSum.primedBytes += p.primedBytes();
            into.push({ name, w: p.width, h: p.height, tiles: n, sharedTiles: old, bytes, shared: false });
            const m = p.displayCanvasIfMade();
            if (m && m.width && !seen.has(m)) { tileSum.mirrors++; tileSum.mirrorBytes += px(m); }
            add(into, name === "canvas" ? "mirror" : name + "Mirror", m);
            const th = p.thumbnailCanvasIfMade();
            if (th && th.width && !seen.has(th)) { tileSum.thumbnails++; tileSum.thumbnailBytes += px(th); }
            add(into, name === "canvas" ? "thumbnail" : name + "Thumbnail", th);
            // the part of the pixels a view shows, at a level, from the tiles' mips (C3: what the
            // selection's overlay draws instead of a mirror of the whole mask)
            for (const rg of (p.regionCanvasesIfMade ? p.regionCanvasesIfMade() : [])) {
                if (!rg || !rg.width || seen.has(rg)) continue;
                tileSum.regions++; tileSum.regionBytes += px(rg);
                add(into, name === "canvas" ? "region" : name + "Region", rg);
            }
        };
        const sum = (list) => list.reduce((a, e) => a + (e.shared ? 0 : e.bytes), 0);

        // layers, and the sources whose pyramids we can find again
        const sources = [];
        const layers = [];
        for (const l of this.layers) {
            const own = [];
            // the backing canvases, so a colour-match cache that holds the layer's own canvas is counted once
            const lc = displayCanvasIfMade(l.px), mc = displayCanvasIfMade(l.maskPx);
            addPixels(own, "canvas", l.px);
            addPixels(own, "mask", l.maskPx);
            add(own, "_masked", l._masked);
            for (const slot of ["_fcache", "_fcacheView", "_fcacheSample", "_mcache", "_mcacheView", "_mcacheSample"]) {
                const c = l[slot] && l[slot].canvas;
                add(own, slot, c);
            }
            for (const c of [lc, mc, l._masked, l._mcache && l._mcache.canvas, l._mcacheView && l._mcacheView.canvas, l._mcacheSample && l._mcacheSample.canvas]) if (c) sources.push(c);
            layers.push({ id: l.id, name: l.name, kind: l.kind, w: l.w, h: l.h, bytes: sum(own), slots: own });
        }
        // the base's pixels only when they were built (basePx would build them)
        for (const c of [displayCanvasIfMade(this._basePx), displayCanvasIfMade(this.sel)]) if (c) sources.push(c);

        // pyramids: a WeakMap cannot be walked, so ask it for every source we know of
        const pyramid = [];
        for (const src of sources) {
            const entry = this.pyramids.get(src);
            if (!entry || (!entry.levels.length && !entry.gpu)) continue;
            let bytes = 0, levels = 0;
            for (const lvl of entry.levels) if (lvl && lvl.width) { bytes += px(lvl); levels++; }
            // the screen's GPU copy of a tile mirror (displaySource's `screen`)
            const gpuBytes = px(entry.gpu);
            pyramid.push({ w: src.width, h: src.height, levels, bytes: bytes + gpuBytes, gpuCopyBytes: gpuBytes });
        }

        // the scratch canvases the editor keeps between frames, the base and the selection first:
        // their tiles are counted before the undo steps that share them
        const scratch = [];
        addPixels(scratch, "_baseCanvas", this._basePx);   // the name mem_test and the docs know
        addPixels(scratch, "selection", this.sel);
        for (const name of ["sceneCanvas", "viewCanvas", "flatCanvas", "strokePreview", "maskPreview", "maskedPreview", "antsCanvas", "strokeView", "strokeMaskView", "_strokePatch", "_strokeClip", "_strokeDev", "filterMaskCanvas", "_passView", "_passMaskView", "_filterMaskView"]) add(scratch, name, this[name]);
        add(scratch, "flatCache", this.flatCache && this.flatCache.canvas);

        // undo / redo: the rect copies plus the canvases (or tiles) the "layers" / "canvas" snapshots
        // hold that the live document does not
        const live = new Set();
        for (const l of this.layers) {
            for (const p of [l.px, l.maskPx]) {
                if (!p) continue;
                if (isTilePixels(p)) { for (const t of p.tileList()) live.add(t); const m = p.displayCanvasIfMade(); if (m) live.add(m); } else live.add(canvasOf(p));
            }
        }
        const undoSeen = new Set();
        // bytes of pixels a step holds that neither the live layers nor an earlier step hold
        const heldBytes = (p) => {
            if (!p) return 0;
            if (!isTilePixels(p)) {
                const c = canvasOf(p);
                if (!c || !c.width || live.has(c) || undoSeen.has(c) || seen.has(c)) return 0;
                undoSeen.add(c);
                return px(c);
            }
            let bytes = 0;
            for (const t of p.tileList()) {
                if (live.has(t) || undoSeen.has(t) || seen.has(t)) continue;
                undoSeen.add(t);
                bytes += t.data.byteLength;
                tileSum.tiles++; tileSum.bytes += t.data.byteLength;
                addChains(t);
            }
            const m = p.displayCanvasIfMade();
            if (m && m.width && !live.has(m) && !undoSeen.has(m) && !seen.has(m)) { undoSeen.add(m); bytes += px(m); tileSum.mirrors++; tileSum.mirrorBytes += px(m); }
            tileSum.pixels++;
            return bytes;
        };
        const walkSteps = (list) => {
            const kinds = {};
            let bytes = 0, held = 0;
            for (const s of list) {
                if (!s) continue;
                kinds[s.kind] = (kinds[s.kind] || 0) + 1;
                if (s.kind === "layerrect" || s.kind === "selection") bytes += heldBytes(s.px) + (s.parts || []).reduce((n, q) => n + heldBytes(q.px), 0);   // a rect / selection step's pixels copy (a move's two)
                else held += heldBytes(s.px);   // on tiles: a whole-layer step's clone (its tiles the live layers do not hold)
                held += heldBytes(s.maskPx) + heldBytes(s.selPx) + heldBytes(s.base && s.base.px);
                for (const l of s.layers || []) {
                    // snapshot copies are spreads: they carry px / maskPx, not the aliases
                    held += heldBytes(l.px) + heldBytes(l.maskPx);
                    if (l._masked && l._masked.width && !live.has(l._masked) && !undoSeen.has(l._masked)) { undoSeen.add(l._masked); held += px(l._masked); }
                }
                for (const p of s.pixels || []) held += heldBytes(p && p.px) + heldBytes(p && p.maskPx);   // a turn step's and a named snapshot's clones
            }
            return { steps: list.length, kinds, rectBytes: bytes, heldLayerBytes: held };
        };
        const undo = { budget: this.undoBytes, undo: walkSteps(this.undo || []), redo: walkSteps(this.redo || []), snapshots: walkSteps((this.snapshots || []).map((s) => s.snap)) };

        const comp = this._compositor && this._compositor.stats ? this._compositor.stats() : null;
        const pool = this.tileMode ? scratchStats() : null;
        const mapsReport = {};
        let mapsBytes = 0;
        if (this.maps) {
            for (const [k, m] of Object.entries(this.maps)) {
                if (!m) continue;
                const b = (m.data ? m.data.byteLength : 0) + (m.guide ? m.guide.byteLength : 0);
                mapsBytes += b;
                mapsReport[k] = { w: m.w, h: m.h, bytes: b, version: m.version, dataVersion: m.dataVersion, guide: !!m.guide };
            }
        }
        return {
            id: this.node && this.node.id,
            size: [this.width, this.height],
            tileMode: this.tileMode,
            // tile bytes and mirrors of every pixels object above; the scratch pool is the module's, shared by all editors
            tiles: this.tileMode ? { ...tileSum, tileSize: TILE_SIZE, scratchPoolBytes: pool.poolPixels * 4, chainPoolBytes: chainScheduler().pool.length * TILE_SIZE * TILE_SIZE * 4 } : null,
            layers: { count: layers.length, bytes: layers.reduce((a, l) => a + l.bytes, 0), list: layers },
            pyramid: { sources: pyramid.length, levels: pyramid.reduce((a, p) => a + p.levels, 0), bytes: pyramid.reduce((a, p) => a + p.bytes, 0), list: pyramid },
            undo,
            compositor: comp,
            objects: this.objects && this.objects.ids ? { w: this.objects.w, h: this.objects.h, bytes: this.objects.ids.byteLength } : null,
            maps: { count: Object.keys(mapsReport).length, bytes: mapsBytes, kinds: mapsReport },
            scratch: { bytes: sum(scratch), list: scratch },
        };
    }

    destroy() {
        this._destroyed = true;
        if (this.runProgress) this.runProgress.clear();   // its one-second ticker
        this._mapUndoPending = null;
        clearTimeout(this._refLayTimer);
        if (this._compositor) { try { this._compositor.dispose(); } catch (_) { /* context gone */ } this._compositor = null; }
        this.close();
        this.closeFlyout();
        this.dropFlyoutListener();   // close() returns early for an editor that is not open
        this.closeAsk();
        if (this.promptField) this.promptField.destroy();   // its document listener and the context callback
        // after close(), which commits an open text edit: that step's blob URL is revoked with the rest
        this.clearUndo();   // the blob URLs of the whole-layer steps are revoked, not left behind
        this.clearSnapshots();
        try { this.resizeObserver.disconnect(); } catch (_) { /* ignore */ }
        try { this.thumbObserver.disconnect(); } catch (_) { /* ignore */ }
    }
}
installParts(InpaintEditor, [PanelsPart, LayersPart, HistoryPanelPart, TextPart, TipsPart, HealPart, LiquifyPart, ShapePart, SelectPart, StackPart, SegmentPart, MasksPart, GeometryPart, PointerPart, DepthPart, FiltersPart, HistoryPart, PersistPart, ExportPart, OpenPart, StrokesPart, DisplayPart, CompositePart, MatchPart, DrawPart, RelightPart]);
bindDisplay(InpaintEditor);
bindComposite(InpaintEditor);
bindExport(InpaintEditor);
bindOpen(InpaintEditor);
bindStrokes(InpaintEditor);
bindSelect(InpaintEditor);
bindStack(InpaintEditor);
bindHeal(InpaintEditor);
bindLiquify(InpaintEditor);
bindShape(InpaintEditor);
bindLoad(InpaintEditor);

// everything the hosts use: Scumble's shell, commands and plugins, the node's extension (js/inpaint_node.js)
export { InpaintEditor, BLEND_MODES, DISSOLVE_SHADER, DISSOLVE_CLIP_SHADER, viewUrl, loadImageEl, makeCanvas, uploadBlob, uploadCanvas, CROP_DEFAULTS, GEN_DEFAULTS, FIXED_OUTPUTS, SETTING_SLOTS, TAIL_OUTPUTS, NODE_CLASS, STITCH_CLASS, isSettingOutput, settingIndex, linkOf, el, icon, iconButton, miniButton, selectInput, selectGrouped, numberInput, hostText, REF_FITS, REF_DEFAULTS, UPSAMPLE_CASES, randomSeed, STYLE, RELIGHT_STYLES, RELIGHT_LIGHT_TYPES, BRUSH_MAX, brushSizeToSlider, sliderToBrushSize };
