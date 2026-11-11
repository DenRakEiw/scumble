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
import { FILTERS, filterDefaults, applyFilter, matchCanvas, lutFromCube, lutToCanvas, lutFromImage, plateStats, colourStats, fillPixels } from "./inpaint_filters.js";
import { isGLSurface, glChainUsable, beginScope, endScope, releaseSurface, surfaceToCanvas, drawSurfaceTo, runShader, glToCanvas } from "./inpaint_filters_gl.js";
import { TEXT_DEFAULTS, loadFontList } from "./inpaint_text.js";
import { setKernels, kernelsMode, OPS, deflate, compositeTile, freqSeparate, liquifyDab } from "./px/kernels.js";
import { GLCompositor } from "./inpaint_compositor.js";
import { LayerPixels, MaskPixels, canvasOf, displayCanvasIfMade, installLayerAliases, deprecatedPixels, pixelsOptions, BLIT_MARGIN } from "./inpaint_pixels.js";
import { INTERACTIVE, NORMAL, CancelledError } from "./inpaint_pool.js";
import { pngHeader, asciiJson, pngWithChunks, SRGB_CHUNK, pngPartsOf, readPngParts } from "./inpaint_png.js";
import { tileRows, bandRows, PsdBandWriter, OraBandWriter, writeTiff } from "./inpaint_bands.js";
import { releaseBoxBuffers } from "./inpaint_boxstack.js";
import { pressureCurve, Stabiliser, toneLUT } from "./inpaint_stroke.js";
import { TIFF_EXT, tiffInfo, tiffPlan, readTiffBand, readTiffBands, tiffPart } from "./inpaint_tiff.js";
import { arenaEnabled } from "./inpaint_arena.js";
import { pixelsBackend, isTilePixels, scratchStats, TILE_SIZE, MIP_LEVELS, CANVAS_MAX_PIXELS, chainScheduler } from "./inpaint_tiles.js";
import { JOB_TIMINGS, STEP_MARKS, markStep, workerCall, editorPool, buildLayered, measureGen, pendingJobs, resetPool } from "./inpaint_jobs.js";
import { buildEditorModal } from "./inpaint_modal.js";
import { encodeCanvas, canvasToBlob, partsUsable, partsRun, partsFlights, bandPause, partsFailed, nextPartsSeq, encodeTilePixels, encodeBands, encodeRows } from "./inpaint_encode.js";
import { uploadBlob, uploadCanvas, uploadPixels } from "./inpaint_upload.js";
import { LAYERED_EXT, readPsd, readOraBlob, inflateAtMost } from "./inpaint_layered.js";
import { THEME } from "./inpaint_theme.js";
import { labelMap, remap } from "./reftokens.js";
import { promptPayload, selectionBoxIdOf } from "./boxes_model.js";
import { STALE_DIFF, GUIDE, WORK_MAX, modelSize, workSize } from "./inpaint_depth.js";
import { packRG16, mapToJSON, mapFromJSON, fingerprint, fingerprintDiff, passToMap, makeMap, sampleMap, deriveMap, selectionOnMap, editMap } from "./inpaint_maps.js";
import { SNAP_DEFAULT } from "./inpaint_edges.js";
import { u16Bilinear, rangeWeight, opp, colourSimilarity, hexToRgb as hexToRgb01 } from "./inpaint_weights.js";
import { limitAlphaRows } from "./inpaint_limit.js";
import { BLEND_MODES, EMULATED_BLENDS, BLEND_OPS, canvasOp, normalBlend, seedOfLayer, hash32, mul255 } from "./blend_modes.js";
import { heightNormals, shadowMarch, pxCalls, kernelRoutes, setRoute as setKernelRoute, route as kernelRoute, pxTimed, pxSplit, pxInstances } from "./px/kernels.js";
import { statusKindFor, failKind, refusal } from "./inpaint_status.js";
import { RunProgress } from "./inpaint_progress.js";
import { lightToMap, lightColorHex, relightMapKey, relightDepthScale, relightVisKey, relightVisCurrent, marchOnPool, cancelMarch, STRIPES_PER_WORKER } from "./inpaint_relight.js";
import { BRUSH_MAX, CURSOR_CLASSES, FREQ_MAX_PX, HANDLE_PX, LAYER_KINDS, LAYER_PENDING_KEYS, LOAD_NOTE_LINES, LOAD_NOTE_MS, MAX_SNAPSHOTS, MAX_UNDO, MAX_UNDO_BYTES, NODE_CLASS, PSD_WINDOW, PYRAMID_LEVELS, PYRAMID_MIN_PX, REF_DEFAULTS, REF_FITS, RELIGHT_LIGHT_TYPES, RELIGHT_STYLES, RULER_PX, RUN_GOING_TEXT, SEL_BOX_MAX_PX, SIDE_DEFAULT_PX, SIDE_MAX_SHARE, SIDE_MIN_PX, SNAP_CANVAS_PX, STITCH_CLASS, SYNC_ENCODE_PX, TAIL_OUTPUTS, UNDO_LABELS, brushSizeToSlider, sliderToBrushSize, cpuDab, editorTileMode, hostText, leftOutText, makeCanvas, refBadge } from "./inpaint_consts.js";
import { orientIsUp, validXf } from "./inpaint_orient.js";
import { DISSOLVE_CLIP_SHADER, DISSOLVE_SHADER, EMULATED_BLEND_CLIP_SHADER, EMULATED_BLEND_SHADER, RANGE_PREVIEW_SHADER } from "./inpaint_shaders.js";
import { el, icon, iconButton, miniButton, numberInput, selectGrouped, selectInput, setFieldText } from "./inpaint_dom.js";
import { drawMesh } from "./inpaint_mesh.js";
import { CROP_DEFAULTS, CROP_LEGACY, FIXED_OUTPUTS, GEN_DEFAULTS, MIN_AUTO_CROP, SETTING_SLOTS, UPSAMPLE_CASES, autoSelectionParams, ensureMinSpan, isSettingOutput, linkOf, randomSeed, settingIndex } from "./inpaint_backends.js";
import { STYLE, injectStyle } from "./inpaint_style.js";
import { STROKE_BAND, STROKE_SCRATCH_KEEP_PX, StrokeBuffer, UploadCache, sourceTag } from "./inpaint_strokebuf.js";
import { HUGE_MAX_PIXELS, HUGE_MAX_SIDE, NO_PROGRAM, canvasRows, clampRect, fileGone, hugePngSize, imageFileSize, imageOfBlob, isSvgFile, isTiffFile, layeredKind, layeredStem, loadImageEl, needImage, pixelsFromPngStream, pixelsFromTiff, pixelsOffThread, pngIsPlainSrgb, pngReaderUsable, psdOnPool, rasterizeSvg, refKey, snapImage, storedExt, svgSize, tileDiffBox, viewUrl, bindLoad } from "./inpaint_load.js";
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

    selectionDab(x0, y0, x1, y1) {
        const r = this.brushSize / 2 + 2;
        const p = this.pointer;
        if (p && p.kind === "selpaint") this.strokeBounds(p, x0, y0, x1, y1, r);
        const subtract = this.pointer && this.pointer.kind === "selpaint" ? !!this.pointer.subtract : this.tool === "deselect";
        const size = this.brushSize;
        // The round line reaches half the brush past its ends, but the clip must hold Skia's
        // conservative bounds of the stroke too (about 0.71 of the width past the ends): a clip
        // inside those changes how a GPU canvas antialiases the stroke, measured up to 255 levels
        // on the edge pixels with a pad of half the brush + 16 at 150 px. The full width + 4 holds them.
        const pad = size + 4;
        this.sel.drawInto([Math.min(x0, x1) - pad, Math.min(y0, y1) - pad, Math.max(x0, x1) + pad, Math.max(y0, y1) + pad], (sctx) => {
            sctx.globalCompositeOperation = subtract ? "destination-out" : "source-over";
            sctx.strokeStyle = "#ff0000";
            sctx.lineCap = "round";
            sctx.lineJoin = "round";
            sctx.lineWidth = size;
            sctx.beginPath();
            sctx.moveTo(x0, y0);
            sctx.lineTo(x1 + 0.01, y1 + 0.01);
            sctx.stroke();
        });
        // after the write (the contract's order): before it, the display levels were refreshed from
        // the selection without this dab, and a fast stroke zoomed out showed gaps until pointer up
        this.touchSourceRect(this.sel, Math.min(x0, x1) - r, Math.min(y0, y1) - r, Math.max(x0, x1) + r, Math.max(y0, y1) + r);
    }

    /**
     * Photoshop-style loop closing: every unselected region that cannot reach
     * the image border (i.e. is fully enclosed by the selection) gets selected.
     */
    /**
     * Photoshop-style loop closing for the selection brush: when a stroke comes
     * back to where it started, the path is closed with a straight line and its
     * inside is filled (nonzero winding, so a figure-eight fills both lobes and
     * a loop against the image border counts too). Works for the subtract brush
     * as well. Returns true when something was filled.
     */
    closeStrokeLoop(path, subtract) {
        if (!path || path.length < 8) return false;
        const [x0, y0] = path[0];
        const [x1, y1] = path[path.length - 1];
        const tol = Math.max(this.brushSize, 24 / this.view.scale);
        if (Math.hypot(x1 - x0, y1 - y0) > tol) return false;
        // ignore tiny scribbles: the loop must span more than the brush itself
        let minX = x0, maxX = x0, minY = y0, maxY = y0;
        for (const [x, y] of path) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
        if (Math.max(maxX - minX, maxY - minY) < this.brushSize * 1.5) return false;
        // the closed path lies inside the box of its points
        this.sel.drawInto([minX - 1, minY - 1, maxX + 1, maxY + 1], (sctx) => {
            sctx.globalCompositeOperation = subtract ? "destination-out" : "source-over";
            sctx.fillStyle = "#ff0000";
            sctx.beginPath();
            sctx.moveTo(x0, y0);
            for (let i = 1; i < path.length; i++) sctx.lineTo(path[i][0], path[i][1]);
            sctx.closePath();
            sctx.fill("nonzero");
        });
        return true;
    }

    /**
     * Draw one brush segment into the stroke buffer of a layer-paint gesture (the press, a Shift+click line); a move
     * goes through `layerStroke` with all its points.
     */
    layerDab(p, x0, y0, x1, y1) {
        this.layerStroke(p, x0, y0, [[x1, y1, p.pressure]]);
    }

    /**
     * Draw one move of a layer-paint gesture into its stroke buffer: from (x0, y0) through `pts` ([x, y, pressure] in
     * image pixels: a pen's coalesced points, the stabiliser's), in one box of the buffer. Hard brushes draw a round line,
     * soft brushes stamp radial-gradient dabs and tips their stamp, evenly along the whole path and both ends included,
     * as one segment was stamped before 0.1.32. 0.1.32 stamped every point as a segment of its own, each joint twice and
     * each in a box of its own (on tiles a scratch round trip): a soft 700 to 1,000 px eraser under a pen was four to six
     * times slower (docs/BUGS.md, fixed for 0.1.33). Flow below 100 % carries its spacing (`flowStamps`). A pen's pressure
     * scales the size (Krita's default "size by pressure"), a segment at its end's; the mouse paints at full size. Image
     * coords are mapped into the layer's own pixels.
     */
    layerStroke(p, x0, y0, pts) {
        if (!pts.length) return;
        const layer = p.layer;
        const c = p.stroke;
        const sx = c.tw / layer.w, sy = c.th / layer.h;
        const full = this.brushSize * (sx + sy) / 4;
        const segs = [];
        let ix = x0, iy = y0, lx = (x0 - layer.x) * sx, ly = (y0 - layer.y) * sy;
        let bx0 = lx, by0 = ly, bx1 = lx, by1 = ly, rMax = 0;
        for (const [x, y, pr] of pts) {
            this.strokeBounds(p, ix, iy, x, y, this.brushSize / 2 + 2);
            this.strokeDirty(p, ix, iy, x, y, this.brushSize / 2 + 2);
            const nx = (x - layer.x) * sx, ny = (y - layer.y) * sy;
            const radius = full * (pr == null ? 1 : Math.max(0.05, Math.min(1, pr)));
            segs.push({ x0: lx, y0: ly, x1: nx, y1: ny, radius, len: Math.hypot(nx - lx, ny - ly), step: 1 });
            if (nx < bx0) bx0 = nx; if (nx > bx1) bx1 = nx; if (ny < by0) by0 = ny; if (ny > by1) by1 = ny;
            if (radius > rMax) rMax = radius;
            ix = x; iy = y; lx = nx; ly = ny;
        }
        // the buffer holds the path plus the dab (a tip may be wider than round, and turned)
        const R = rMax * 1.5 + 2;
        const color = p.dabColor || (p.white ? "#ffffff" : (p.erase ? "#000000" : this.color));
        const hardness = p.erase ? this.eraseHardness : this.hardness;
        const tip = p.remove ? null : this.brushTip();   // Remove marks a hole with the round brush
        const flow = p.flow == null ? 1 : Math.max(0.01, Math.min(1, p.flow));
        // "Follow stroke": the tip turns with the move's direction, from its start to its end (as one segment did before
        // 0.1.32; a pen's points a pixel apart turned it every which way, or not at all); a stationary dab keeps the last
        if (tip && this.tipRotate) {
            const dx = lx - segs[0].x0, dy = ly - segs[0].y0;
            if (Math.hypot(dx, dy) > 0.5) this._tipAngle = Math.atan2(dy, dx);
        }
        c.draw(bx0 - R, by0 - R, bx1 + R, by1 + R, (ctx) => {
            ctx.globalCompositeOperation = "source-over";
            if (flow < 1) { for (const s of segs) this.flowStamps(ctx, p, tip, s.x0, s.y0, s.x1, s.y1, s.radius, color, hardness, flow); return; }
            if (tip) { this.stampDab(ctx, tip, segs, color); return; }
            if (hardness >= 0.98) {
                ctx.strokeStyle = color;
                ctx.lineCap = "round";
                ctx.lineJoin = "round";
                // one line through the points while the width holds (the mouse, a steady pen), a new one where it changes
                for (let i = 0; i < segs.length;) {
                    let j = i + 1;
                    while (j < segs.length && segs[j].radius === segs[i].radius) j++;
                    ctx.lineWidth = segs[i].radius * 2;
                    ctx.beginPath();
                    ctx.moveTo(segs[i].x0, segs[i].y0);
                    for (let k = i; k < j - 1; k++) ctx.lineTo(segs[k].x1, segs[k].y1);
                    ctx.lineTo(segs[j - 1].x1 + 0.01, segs[j - 1].y1 + 0.01);
                    ctx.stroke();
                    i = j;
                }
                return;
            }
            // the gradient belongs to the context that made it, and on the tile backend every dab
            // draws on a scratch of its own, so it is cached per context as well as per radius
            const rgb = color.length === 7 ? `${parseInt(color.slice(1, 3), 16)},${parseInt(color.slice(3, 5), 16)},${parseInt(color.slice(5, 7), 16)}` : "0,0,0";
            for (const s of segs) s.step = Math.max(1, s.radius * 0.18);
            this.pathStamps(segs, (x, y, s) => {
                const radius = s.radius;
                if (!p.gradient || p.gradientRadius !== radius || p.gradientCtx !== ctx) {
                    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
                    g.addColorStop(0, `rgba(${rgb},1)`);
                    g.addColorStop(Math.max(0, Math.min(0.97, hardness)), `rgba(${rgb},1)`);
                    g.addColorStop(1, `rgba(${rgb},0)`);
                    p.gradient = g;
                    p.gradientRadius = radius;
                    p.gradientCtx = ctx;
                }
                ctx.fillStyle = p.gradient;
                ctx.save();
                ctx.translate(x, y);
                ctx.beginPath();
                ctx.arc(0, 0, radius, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            });
        });
    }

    /**
     * The places a move's dabs go (layer pixels): `steps + 1` evenly along the whole path of `segs`, both ends included,
     * `steps` the fewest that keep them at most each segment's `step` apart. One segment gives the places its own loop
     * gave before (the fraction i / steps, exactly); the points of a pen's move no longer stamp every joint twice. Where
     * the steps differ (a pen's pressure changing within the move) a segment's share of the places follows its length in
     * its own steps, so a large dab is not spaced as the move's smallest. `fn(x, y, seg)` per place, `seg` the segment it
     * lies on (a place on a joint belongs to the segment it ends). `first` false leaves out the path's start when the path
     * has a length (clone and heal: the last move put its dab there).
     */
    pathStamps(segs, fn, first = true) {
        const n = segs.length;
        let total = 0, weight = 0, step = 0, one = true;
        for (const s of segs) {
            total += s.len;
            if (!(s.len > 0)) continue;
            weight += s.len / s.step;
            if (!step) step = s.step; else if (s.step !== step) one = false;
        }
        // one step for the whole path (the mouse, a steady pen): the arithmetic of one segment, so a straight move of
        // several points puts its dabs where one point did
        const steps = Math.max(1, Math.ceil(one && step ? total / step : weight));
        if (!(total > 0)) {
            // a press, or a pen that did not move: the path's point, at the first segment's size and then the last's
            for (let i = 0; i <= steps; i++) { const s = segs[i === 0 ? 0 : n - 1]; fn(s.x0, s.y0, s); }
            return;
        }
        // where each segment starts and ends, as a fraction of the path (of its length, or of its steps); the last ends at 1
        const f = new Float64Array(n + 1), sum = one ? total : weight;
        for (let k = 0, acc = 0; k < n; k++) {
            if (segs[k].len > 0) acc += one ? segs[k].len : segs[k].len / segs[k].step;
            f[k + 1] = k === n - 1 ? 1 : acc / sum;
        }
        let k = 0;
        for (let i = first ? 0 : 1; i <= steps; i++) {
            const u = i / steps;
            while (k < n - 1 && (segs[k].len === 0 || f[k + 1] < u)) k++;
            const s = segs[k];
            const t = s.len === 0 ? 0 : Math.max(0, Math.min(1, (u - f[k]) / (f[k + 1] - f[k])));
            fn(s.x0 + (s.x1 - s.x0) * t, s.y0 + (s.y1 - s.y0) * t, s);
        }
    }

    /**
     * Flow below 100 % (PLAN_0_1_31 §4 step 5): stamps at even spacing along the stroke, each at alpha `flow`, so paint
     * builds up where stamps overlap and where the stroke passes again; the distance to the next stamp carries over from
     * one segment to the next (`p.rest`), so no joint is stamped twice. The round dab is spaced at a quarter of its
     * diameter (Photoshop's default), a tip at its own spacing. The stroke buffer is 8 bits, so a low flow tops out below
     * full cover (5 % near 96 %), which is why the slider starts at 5 %. Flow 100 % keeps the path of before.
     */
    flowStamps(ctx, p, tip, lx0, ly0, lx1, ly1, radius, color, hardness, flow) {
        const dist = Math.hypot(lx1 - lx0, ly1 - ly0);
        if (p.rest != null && dist === 0) return;   // a repeated point adds nothing; the press stamps once
        const stamp = tip ? this.tipStamp(tip, radius * 2, color) : null;
        const spacing = Math.max(1, stamp ? Math.max(stamp.width, stamp.height) * (tip.spacing || this.brushTipSpacing) : radius * 0.5);
        let fill = color;
        if (!tip && hardness < 0.98) {
            if (!p.gradient || p.gradientRadius !== radius || p.gradientCtx !== ctx) {
                const g = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
                const rgb = color.length === 7 ? `${parseInt(color.slice(1, 3), 16)},${parseInt(color.slice(3, 5), 16)},${parseInt(color.slice(5, 7), 16)}` : "0,0,0";
                g.addColorStop(0, `rgba(${rgb},1)`);
                g.addColorStop(Math.max(0, Math.min(0.97, hardness)), `rgba(${rgb},1)`);
                g.addColorStop(1, `rgba(${rgb},0)`);
                p.gradient = g; p.gradientRadius = radius; p.gradientCtx = ctx;
            }
            fill = p.gradient;
        }
        // "Follow stroke": the angle `layerStroke` took from the whole move
        const angle = tip && this.tipRotate ? (this._tipAngle || 0) : 0;
        ctx.globalAlpha = flow;
        let next = p.rest == null ? 0 : p.rest;
        while (next <= dist) {
            const t = dist ? next / dist : 0;
            const x = lx0 + (lx1 - lx0) * t, y = ly0 + (ly1 - ly0) * t;
            ctx.save();
            ctx.translate(x, y);
            if (stamp) { if (angle) ctx.rotate(angle); ctx.drawImage(stamp, -stamp.width / 2, -stamp.height / 2); }
            else { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.fill(); }
            ctx.restore();
            next += spacing;
        }
        p.rest = next - dist;
        ctx.globalAlpha = 1;
    }

    /** A pen's pressure through the chosen curve (PLAN_0_1_31 §4 step 5); the mouse and touch paint at 1. */
    pressureOf(e) {
        return e && e.pointerType === "pen" && e.pressure > 0 ? pressureCurve(e.pressure, this.pressureCurve) : 1;
    }

    /** The gesture's stabiliser, or null when it is off: the options bar's string in screen pixels, in image pixels at this zoom. */
    newStabiliser(ix, iy, pressure) {
        if (!(this.stabiliser > 0)) return null;
        const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
        return new Stabiliser(this.stabiliser * dpr / Math.max(1e-6, this.view.scale), ix, iy, pressure);
    }

    /**
     * The points a move gives a brush gesture: every coalesced event of `e` (a pen faster than the screen gives several a
     * frame, and Chromium hands one pointermove per frame), in image pixels with its pressure, through the gesture's
     * stabiliser; none while its string is slack. A synthetic event without coalesced events is its own one.
     */
    strokePoints(p, e) {
        let evs = null;
        try { evs = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : null; } catch (_) { evs = null; }
        if (!evs || !evs.length) evs = [e];
        const out = [];
        for (const ce of evs) {
            const [x, y] = this.toImage(ce);
            const pr = this.pressureOf(ce);
            if (p.stab) for (const q of p.stab.push(x, y, pr)) out.push(q);
            else out.push([x, y, pr]);
        }
        return out;
    }

    /** The release of a brush gesture: the stabiliser's rest of the string, drawn before the stroke is committed. */
    finishStroke(p) {
        if (!p || !p.stab) return;
        if (p.kind === "liquify") { const rest = p.stab.finish(); p.stab = null; this.liquifyMove(p, rest); return; }
        const rest = p.stab.finish();
        if (rest.length && p.kind !== "smudge" && !p.shape && !p.grad) {
            if (p.clone) this.cloneStroke(p, p.last[0], p.last[1], rest); else this.layerStroke(p, p.last[0], p.last[1], rest);
        }
        for (const [x, y, pr] of rest) {
            p.pressure = pr;
            if (p.kind === "smudge") this.smudgeDab(p, p.last[0], p.last[1], x, y);
            p.last = [x, y];
        }
        p.stab = null;
    }

    // ---- selection tools: wand, feather, saved selections, quick mask ------------------------

    selectedAt(ix, iy) {
        const x = Math.floor(ix), y = Math.floor(iy);
        if (x < 0 || y < 0 || x >= this.width || y >= this.height || !this.getBounds()) return false;
        return this.sel.readRect(x, y, 1, 1).data[3] > 127;
    }

    /**
     * Whether strokes on this layer are clipped to the selection, like in Krita and
     * Photoshop (Ctrl+D clears the selection to paint freely). The clip itself is drawn on
     * demand for the part of the layer a gesture touches (clipCanvasFor); it used to be a
     * canvas the size of the layer per gesture.
     */
    strokeClip(layer, target) {
        return !!(this.sel && this.getBounds()) || null;
    }

    /** A stroke buffer for `target` (a layer's `px` or a mask's `maskPx`; only the size is read); tests build gestures with it. */
    newStrokeBuffer(target) { return new StrokeBuffer(target, this.pixels); }

    /**
     * The selection mapped into `target`'s pixels (alpha = selected) inside the box
     * (x, y, w, h in target pixels), as a canvas of that size; `into` is reused when it fits.
     * `target` is the layer's or the mask's pixels; only its size is read. It sets absolute
     * transforms, which is allowed because the canvas is its own (or `into`, a scratch it owns),
     * never a context handed to a drawInto callback (docs/PLAN_BCE.md §C1 rule 12).
     */
    clipCanvasFor(layer, target, x, y, w, h, into = null, sel = this.sel) {
        const c = into && into.width === w && into.height === h ? into : makeCanvas(w, h);
        const ctx = c.getContext("2d");
        const fx = layer.w / target.width, fy = layer.h / target.height;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, w, h);
        ctx.setTransform(target.width / layer.w, 0, 0, target.height / layer.h, -x, -y);
        // C5: on tiles only the part of the selection the box covers, materialised from its tiles,
        // with a margin of BLIT_MARGIN so a fractional draw samples the neighbours as a draw from the
        // whole thing does. `drawTo` reads the selection's display mirror, which at 15000 x 10000 is
        // 572 MB built for a clip of a few hundred pixels. A canvas selection is its own canvas: the
        // draw is free there and a crop would allocate per dab (the smudge asks once a step).
        const r = isTilePixels(sel)
            ? clampRect([layer.x + x * fx - BLIT_MARGIN, layer.y + y * fy - BLIT_MARGIN,
                layer.x + (x + w) * fx + BLIT_MARGIN, layer.y + (y + h) * fy + BLIT_MARGIN], this.width, this.height)
            : null;
        if (!r) sel.drawTo(ctx, -layer.x, -layer.y);
        else if (r[2] > r[0] && r[3] > r[1]) ctx.drawImage(sel.toCanvas(r), r[0] - layer.x, r[1] - layer.y, r[2] - r[0], r[3] - r[1]);
        ctx.restore();
        return c;
    }

    /** A scratch of w x h kept between bands (the stroke's patch and its clip); at most STROKE_BAND a side. */
    bandScratch(key, w, h) {
        const c = this[key];
        if (c && c.width === w && c.height === h) return c;
        const n = makeCanvas(w, h);
        n._livePreview = true;   // never given a display pyramid
        this[key] = n;
        return n;
    }

    /**
     * The stroke buffer's pixels for a rectangle of the target (x, y, w, h in the target's own
     * pixels), limited to the selection when the gesture has a clip, as a canvas of that size;
     * null when the rectangle holds nothing of the buffer. The caller asks band by band
     * (STROKE_BAND): the clipped copy of a whole stroke used to be two canvases the size of the
     * stroke's box, 1.1 GB together on a 15000 x 10000 picture (docs/PLAN_BCE.md §C5).
     */
    strokePatch(p, target, x, y, w, h) {
        const sb = p.stroke;
        if (!sb || sb.empty) return null;
        const ix0 = Math.max(x, sb.x), iy0 = Math.max(y, sb.y);
        const ix1 = Math.min(x + w, sb.x + sb.w), iy1 = Math.min(y + h, sb.y + sb.h);
        if (ix1 <= ix0 || iy1 <= iy0) return null;
        const src = sb.part(ix0, iy0, ix1, iy1);
        if (!src) return null;
        const c = this.bandScratch("_strokePatch", w, h);
        const ctx = c.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(src.canvas, ix0 - src.x, iy0 - src.y, ix1 - ix0, iy1 - iy0, ix0 - x, iy0 - y, ix1 - ix0, iy1 - iy0);
        if (p.clip) {
            ctx.globalCompositeOperation = "destination-in";
            ctx.drawImage(this.clipCanvasFor(p.layer, target, x, y, w, h, this.bandScratch("_strokeClip", w, h), p.clipSel || this.sel), 0, 0);
            ctx.globalCompositeOperation = "source-over";
        }
        return c;
    }

    /**
     * The bands of the target a stroke's buffer covers, at most STROKE_BAND a side and never
     * wider than the box the gesture painted over: [x, y, w, h] in the target's own pixels.
     */
    *strokeBands(p, target) {
        const sb = p.stroke;
        if (!sb || sb.empty) return;
        const r = this.strokeRect(p, target);
        const x0 = Math.max(sb.x, r ? Math.floor(r[0]) : sb.x), y0 = Math.max(sb.y, r ? Math.floor(r[1]) : sb.y);
        const x1 = Math.min(sb.x + sb.w, r ? Math.ceil(r[2]) : sb.x + sb.w), y1 = Math.min(sb.y + sb.h, r ? Math.ceil(r[3]) : sb.y + sb.h);
        // only the grid cells a dab drew into: a diagonal stroke's rectangle is the whole picture
        for (const cell of sb.cells) {
            const bx = Math.max(x0, (cell % 65536) * STROKE_BAND), by = Math.max(y0, Math.floor(cell / 65536) * STROKE_BAND);
            const bx1 = Math.min(x1, (cell % 65536 + 1) * STROKE_BAND), by1 = Math.min(y1, (Math.floor(cell / 65536) + 1) * STROKE_BAND);
            if (bx1 > bx && by1 > by) yield [bx, by, bx1 - bx, by1 - by];
        }
    }

    /** What the Undo history calls a stroke's step (a shape is committed as a stroke while the shape tool is on). */
    strokeLabel(p) {
        if (p.kind === "maskpaint") return p.erase ? "Erase mask" : "Paint mask";
        if (p.grad) return "Gradient";
        if (p.move) return p.move.mode === "extend" ? "Content-aware extend" : "Content-aware move";
        if (p.patch) return "Patch";
        if (p.remove) return "Remove";
        if (p.clone) return p.clone.heal ? "Heal" : "Clone";
        if (this.tool === "shape") return "Shape";
        return p.erase ? "Erase" : "Brush stroke";
    }

    /** The opacity a live stroke is shown at: the brush's, or the gesture's own (Remove shows its mark half transparent). */
    strokeAlpha(p) {
        return p && p.previewAlpha != null ? p.previewAlpha : this.brushOpacity;
    }

    /** Apply the stroke buffer to the layer (or its mask) with the brush opacity, band by band. */
    commitStroke(p) {
        const target = p.kind === "maskpaint" ? p.layer.maskPx : p.layer.px;
        if (!target) return;   // a mask removed under the gesture: nothing to write into
        // the undo step is a copy of what the stroke touched, taken before it is applied
        // a heal that blended in a worker is an edit an undo pressed meanwhile waited for (`trackEdit`): its step is that
        // undo's to take back, so it does not count as an edit made after the key
        if (!p.noUndo) this.pushUndoSnapshot(this.strokeUndo(p, target), { label: this.strokeLabel(p), tracked: !!p.healing });
        if (!p.stroke || p.stroke.empty) return;
        // what the release froze for a heal that blended in a worker (`healBlend`), else as it is now
        const opacity = p.opacity != null ? p.opacity : this.brushOpacity;
        const op = p.op || (p.erase ? "destination-out" : (p.kind === "layerpaint" && p.layer.alphaLock ? "source-atop" : "source-over"));
        try {
            if (this.commitStrokeTiles(p, target, op, opacity)) return;
            for (const [bx, by, bw, bh] of this.strokeBands(p, target)) {
                const patch = this.strokePatch(p, target, bx, by, bw, bh);
                if (!patch) continue;
                // the patch is the band's size at the band's origin: unscaled, on whole pixels
                target.drawInto([bx, by, bx + bw, by + bh], (ctx) => {
                    ctx.globalAlpha = opacity;
                    ctx.globalCompositeOperation = op;
                    ctx.drawImage(patch, bx, by);
                });
            }
        } catch (err) {
            // the renderer's memory for pixels ran out part way (PixelMemoryError, inpaint_arena.js): the undo step above is
            // in, so Ctrl+Z takes back what the commit wrote, and the release goes on to mark the stroke's box
            if (!err || err.name !== "PixelMemoryError") throw err;
            this.setStatus(err.message, failKind(err));
            return false;
        }
    }

    /**
     * The commit on tiles: the stroke store's tiles into the target's through the compositing kernel, a tile at a time
     * (`compositeStroke`), not band by band through canvases (docs/BUGS.md: releasing a long erase held the window
     * 0.3 s at 15000 x 10000). The stroke's box, and with a clip the selection under each tile, are the kernel's
     * coverage; a clip on a scaled or fractional layer, and the canvas backend, keep the bands. False when it did not run.
     */
    commitStrokeTiles(p, target, op, opacity) {
        const sb = p.stroke, sp = sb && sb.px;
        if (!sp || !isTilePixels(target) || typeof target.compositeStroke !== "function" || InpaintEditor.strokeTiles === false) return false;
        if (sp.width !== target.width || sp.height !== target.height) return false;
        const l = p.layer;
        const sel = p.clip ? (p.clipSel || this.sel) : null;
        if (sel && (!isTilePixels(sel) || target.width !== l.w || target.height !== l.h || l.x !== Math.round(l.x) || l.y !== Math.round(l.y))) return false;
        // the box the bands would walk (`strokeBands`): the buffer's extent within the gesture's rectangle
        const r = this.strokeRect(p, target);
        const x0 = Math.max(sb.x, r ? Math.floor(r[0]) : sb.x), y0 = Math.max(sb.y, r ? Math.floor(r[1]) : sb.y);
        const x1 = Math.min(sb.x + sb.w, r ? Math.ceil(r[2]) : sb.x + sb.w), y1 = Math.min(sb.y + sb.h, r ? Math.ceil(r[3]) : sb.y + sb.h);
        if (x1 <= x0 || y1 <= y0) return true;
        const T = TILE_SIZE;
        const coverage = (tx, ty) => {
            const X = tx * T, Y = ty * T;
            const cx0 = Math.max(x0, X), cy0 = Math.max(y0, Y), cx1 = Math.min(x1, X + T), cy1 = Math.min(y1, Y + T);
            if (cx1 <= cx0 || cy1 <= cy0) return null;
            if (!sel && cx0 === X && cy0 === Y && cx1 === X + T && cy1 === Y + T) return true;
            const m = new Uint8Array(T * T);
            if (sel) {
                // the selection under this tile of the layer (unscaled, on whole pixels): its alpha is the clip
                const a = sel.readRect(l.x + cx0, l.y + cy0, cx1 - cx0, cy1 - cy0).data;
                let any = false;
                for (let yy = cy0; yy < cy1; yy++) {
                    for (let xx = cx0, j = ((yy - cy0) * (cx1 - cx0)) * 4 + 3; xx < cx1; xx++, j += 4) {
                        const v = a[j];
                        if (v) { m[(yy - Y) * T + (xx - X)] = v; any = true; }
                    }
                }
                return any ? m : null;
            }
            for (let yy = cy0; yy < cy1; yy++) m.fill(255, (yy - Y) * T + (cx0 - X), (yy - Y) * T + (cx1 - X));
            return m;
        };
        target.compositeStroke(sp, OPS[op], Math.round(Math.max(0, Math.min(1, opacity)) * 255), coverage);
        return true;
    }

    /**
     * Add the box a dab changed (image coordinates, padded) to the gesture's dirty
     * rectangles, one per live preview: each preview refreshes its own and takes it.
     *
     * The dab also changed the scene the screen shows, so the scene cache's key moves on
     * (`pixelVersion`, which `sceneSignature` reads). Every stroke kind that draws into a
     * stroke buffer comes through here (layerDab, cloneDab, gradientDab, shapeDab); a write
     * into pixels says so through touchSource / touchSourceRect instead. 28bfad0 (C5 c) took
     * the per-dab `touchSource(buffer canvas)` out of those four with nothing in its place:
     * from then on every frame of a gesture blitted the scene built at the press, and the
     * brush, the eraser, clone, the gradient and a dragged shape showed nothing until the
     * release (0.1.13, docs/PLAN_BCE.md §C7 "The live stroke that did not show"). Only the
     * key: no display level, no mirror and no pixels are touched, which is what the stroke
     * store and the region preview are for.
     */
    strokeDirty(p, x0, y0, x1, y1, pad) {
        const b = [Math.min(x0, x1) - pad, Math.min(y0, y1) - pad, Math.max(x0, x1) + pad, Math.max(y0, y1) + pad];
        for (const k of ["dirtyLayer", "dirtyMask", "dirtyMasked", "dirtyView"]) {
            const d = p[k];
            p[k] = d ? [Math.min(d[0], b[0]), Math.min(d[1], b[1]), Math.max(d[2], b[2]), Math.max(d[3], b[3])] : b;
        }
        this.pixelVersion++;
    }

    /** A live preview's dirty rectangle in `target`'s pixels (clamped), taken; null when nothing changed. `target`: pixels or a canvas of their size. */
    takeDirty(p, key, layer, target) {
        const d = p[key];
        if (!d) return null;
        p[key] = null;
        const sx = target.width / layer.w, sy = target.height / layer.h;
        const x0 = Math.max(0, Math.floor((d[0] - layer.x) * sx) - 1), y0 = Math.max(0, Math.floor((d[1] - layer.y) * sy) - 1);
        const x1 = Math.min(target.width, Math.ceil((d[2] - layer.x) * sx) + 1), y1 = Math.min(target.height, Math.ceil((d[3] - layer.y) * sy) + 1);
        return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
    }

    /**
     * Bring a live preview up to date inside `box` (target pixels; null for all of it, once
     * per gesture): the target's own pixels there, then the stroke over them with the brush
     * opacity and operation. A preview used to be rebuilt whole on every frame, three
     * full-size blits per dab on a 15k layer. `target` is the layer's or the mask's pixels;
     * the preview stays a canvas in C1 (docs/PLAN_BCE.md §C1 rule 8).
     */
    refreshStrokePreview(preview, target, p, box, op) {
        const [x, y, w, h] = box ? [box[0], box[1], box[2] - box[0], box[3] - box[1]] : [0, 0, target.width, target.height];
        if (w <= 0 || h <= 0) return;
        const ctx = preview.getContext("2d");
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.clearRect(x, y, w, h);
        target.drawTo(ctx, x, y, w, h, x, y, w, h);
        ctx.globalAlpha = this.strokeAlpha(p);
        ctx.globalCompositeOperation = op;
        for (const [bx, by, bw, bh] of this.strokeBands(p, target)) {
            const ix0 = Math.max(x, bx), iy0 = Math.max(y, by), ix1 = Math.min(x + w, bx + bw), iy1 = Math.min(y + h, by + bh);
            if (ix1 <= ix0 || iy1 <= iy0) continue;
            const patch = this.strokePatch(p, target, bx, by, bw, bh);
            if (patch) ctx.drawImage(patch, ix0 - bx, iy0 - by, ix1 - ix0, iy1 - iy0, ix0, iy0, ix1 - ix0, iy1 - iy0);
        }
        ctx.restore();
    }

    /** After a gesture: the live preview canvases of a large layer are given back, small ones are kept for the next stroke. */
    releaseStrokeScratch() {
        for (const k of ["strokePreview", "maskPreview", "maskedPreview", "strokeView", "strokeMaskView", "_strokePatch", "_strokeClip", "_strokeDev", "_smudgeSrc", "_smudgeClip", "_smudgeTip", "_brushBytes", "_cloneDab", "_healDest", "_healClip", "_healSrc", "_patchQuick", "_patchPrev", "_liqPreview"]) {
            const c = this[k];
            if (c && c.width * c.height > STROKE_SCRATCH_KEEP_PX) this[k] = null;
        }
        if (this._brushRead) this._brushRead = this._brushRead.map((c) => (c && c.width * c.height > STROKE_SCRATCH_KEEP_PX ? null : c));
        this._strokeViewOf = null;
        this._strokeViewSig = null;
    }

    /**
     * The mask a tile path can apply straight from its own tiles: a `MaskPixels` on the same backend
     * and with the same tile grid as the pixels it masks (docs/PLAN_BCE.md §C5). A mask of another
     * size is scaled onto the layer, which only the `_masked` canvas can do.
     */
    tileMaskOf(layer) {
        const m = this.liveMask(layer);
        if (!m || !layer.px || !isTilePixels(m) || !isTilePixels(layer.px)) return null;
        return m.width === layer.px.width && m.height === layer.px.height ? m : null;
    }

    /**
     * The mask that shapes `layer` where it is drawn: its `maskPx`, or none while the mask is switched off (`maskOff`,
     * PSD's "disabled"; Shift+click on the mask). Everything that draws or composites a layer asks this; what moves,
     * saves or undoes a mask keeps using `maskPx`, so a switched-off mask follows a crop or a flip like any.
     */
    liveMask(layer) {
        return layer.maskOff ? null : layer.maskPx || null;
    }

    /** A gesture whose stroke buffer is drawn over `layer`'s pixels for the live preview. */
    liveStrokeOn(layer) {
        const p = this.pointer;
        return !!(p && p.stroke && (p.kind === "layerpaint" || p.kind === "maskpaint") && p.layer === layer);
    }

    /**
     * The layer as a region pass shows it while a live stroke runs on it (docs/PLAN_BCE.md §C5):
     * the part the pass covers, at the pass's resolution, in a scratch of the pass's size, redrawn
     * inside the dab's rectangle only. `layerWithStroke` makes a canvas as large as the layer and
     * fills it from the layer's display canvas at the first dab, which on a tile store is its
     * display mirror: 355 ms and two mirrors of 572 MB on a 15000 x 10000 document, measured, and
     * the last thing in the tree that made a mirror for the screen.
     *
     * Null when the caller has to take that path after all: a pass whose region is not a whole
     * number of destination pixels would resample the scratch on the way back.
     */
    layerRegionView(layer, vp) {
        const p = this.liveStrokeOn(layer) || this.liquifyOn(layer) ? this.pointer : null;
        const target = p && p.kind === "maskpaint" ? layer.maskPx : layer.px;
        if (!target || !layer.px) return null;
        const vw = vp.w * vp.sx, vh = vp.h * vp.sy;
        if (!(vw >= 1 && vh >= 1)) return null;
        if (Math.abs(vw - Math.round(vw)) > 1e-6 || Math.abs(vh - Math.round(vh)) > 1e-6) return null;
        const W = Math.round(vw), H = Math.round(vh);
        if (!this.strokeView || this.strokeView.width !== W || this.strokeView.height !== H) {
            this.strokeView = makeCanvas(W, H);
            this.strokeView._livePreview = true;   // never cached in the display pyramid
            this._strokeViewSig = null;
        }
        // the scratch holds one (gesture, layer, region): a pan, a zoom, another layer, a write into
        // the pixels or the mask, or a new gesture rebuilds it
        const sig = [vp.x, vp.y, vp.w, vp.h, layer.id, p ? p.kind : "-", layer.x, layer.y, layer.w, layer.h,
            layer.px.version, this.liveMask(layer) ? layer.maskPx.version : -1,
            // C6 b: mips landing from the worker put the stale cells of the region canvases again, the selection's too:
            // a clipped gesture's scratch is clipped by the selection's region canvas, and the dabs drawn before its
            // chains landed kept the clip of the selection before an invert until the commit (the C6 b review)
            layer.px.chainEpoch || 0, layer.maskPx ? layer.maskPx.chainEpoch || 0 : 0, this.sel ? this.sel.chainEpoch || 0 : 0].join(",");
        const full = this._strokeViewOf !== (p || layer) || this._strokeViewSig !== sig;
        if (full) { this._strokeViewOf = p || layer; this._strokeViewSig = sig; if (p) p.dirtyView = null; }
        const box = full || !p ? null : this.takeStrokeBox(p, "dirtyView");
        if (full || box) this.refreshStrokeView(layer, vp, box);
        return this.strokeView;
    }

    /** A live preview's dirty rectangle in image coordinates, taken; null when nothing changed. */
    takeStrokeBox(p, key) {
        const d = p[key];
        p[key] = null;
        return d || null;
    }

    /** Redraw `box` (image coordinates; all of the scratch when null) of the live stroke's view scratch. */
    refreshStrokeView(layer, vp, box) {
        const p = this.liveStrokeOn(layer) || this.liquifyOn(layer) ? this.pointer : null;
        const c = this.strokeView, ctx = c.getContext("2d");
        ctx.save();
        try {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "source-over";
            let dx0 = 0, dy0 = 0, dx1 = c.width, dy1 = c.height;
            if (box) {
                dx0 = Math.max(0, Math.floor((box[0] - vp.x) * vp.sx) - 1);
                dy0 = Math.max(0, Math.floor((box[1] - vp.y) * vp.sy) - 1);
                dx1 = Math.min(c.width, Math.ceil((box[2] - vp.x) * vp.sx) + 1);
                dy1 = Math.min(c.height, Math.ceil((box[3] - vp.y) * vp.sy) + 1);
                if (dx1 <= dx0 || dy1 <= dy0) return;
            }
            // whole destination pixels, so the clip has no anti-aliased edge and what a dab does not
            // touch stays exactly the pixels the frame before drew (destination-in below needs it too)
            ctx.beginPath();
            ctx.rect(dx0, dy0, dx1 - dx0, dy1 - dy0);
            ctx.clip();
            ctx.clearRect(dx0, dy0, dx1 - dx0, dy1 - dy0);
            ctx.setTransform(vp.sx, 0, 0, vp.sy, -vp.x * vp.sx, -vp.y * vp.sy);
            this.drawPixelsInto(ctx, layer, layer.px, vp);
            if (p && p.kind === "layerpaint") {
                this.drawStrokeInto(ctx, layer, layer.px, p.erase ? "destination-out" : (layer.alphaLock ? "source-atop" : "source-over"), vp, [dx0, dy0, dx1, dy1]);
            } else if (p && p.kind === "liquify") {
                this.drawLiquifyInto(ctx, layer, vp, [dx0, dy0, dx1, dy1]);
            }
            if (this.liveMask(layer)) {
                ctx.globalAlpha = 1;
                ctx.globalCompositeOperation = "destination-in";
                if (p && p.kind === "maskpaint") {
                    const m = this.maskStrokeView(layer, vp, dx0, dy0, dx1, dy1);
                    ctx.setTransform(1, 0, 0, 1, 0, 0);
                    ctx.drawImage(m, dx0, dy0, dx1 - dx0, dy1 - dy0, dx0, dy0, dx1 - dx0, dy1 - dy0);
                } else {
                    this.drawPixelsInto(ctx, layer, layer.maskPx, vp);
                }
            }
        } finally {
            ctx.restore();
        }
    }

    /** The mask of `layer` with the in-progress mask stroke on it, in a scratch of the pass's size. */
    maskStrokeView(layer, vp, dx0, dy0, dx1, dy1) {
        const s = this.strokeView;
        if (!this.strokeMaskView || this.strokeMaskView.width !== s.width || this.strokeMaskView.height !== s.height) {
            this.strokeMaskView = makeCanvas(s.width, s.height);
            this.strokeMaskView._livePreview = true;
        }
        const m = this.strokeMaskView, ctx = m.getContext("2d");
        ctx.save();
        try {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "source-over";
            ctx.beginPath();
            ctx.rect(dx0, dy0, dx1 - dx0, dy1 - dy0);
            ctx.clip();
            ctx.clearRect(dx0, dy0, dx1 - dx0, dy1 - dy0);
            ctx.setTransform(vp.sx, 0, 0, vp.sy, -vp.x * vp.sx, -vp.y * vp.sy);
            this.drawPixelsInto(ctx, layer, layer.maskPx, vp);
            this.drawStrokeInto(ctx, layer, layer.maskPx, this.pointer.erase ? "destination-out" : "source-over", vp, [dx0, dy0, dx1, dy1]);
        } finally {
            ctx.restore();
        }
        return m;
    }

    /** Some pixels of `layer` (its own or its mask) over the layer's rectangle, at the pass's level; false when a tile store holds none there. */
    drawPixelsInto(ctx, layer, px, vp) {
        if (isTilePixels(px)) return this.drawTilesInto(ctx, px, layer.x, layer.y, layer.w, layer.h, vp);
        ctx.drawImage(this.displaySource(px, (layer.w * vp.sx) / px.width, false), layer.x, layer.y, layer.w, layer.h);
        return true;
    }

    /**
     * A scratch for one pass (C6 c2): kept under `key` up to STROKE_SCRATCH_KEEP_PX, a canvas of its own above that (a
     * fine flood box can be tens of megapixels, and nothing should hold one after the pass).
     */
    passScratch(key, w, h) {
        if (w * h > STROKE_SCRATCH_KEEP_PX) { const c = makeCanvas(w, h); c._livePreview = true; return c; }
        return this.bandScratch(key, w, h);
    }

    /**
     * A masked layer, or one a live stroke runs on, in a region pass other than the screen's stroke (C6 c2): composed
     * into a scratch of the pass target's size with the pass's transform (the layer's pixels, the stroke over them,
     * the mask, or the mask with its stroke, destination-in), then drawn at identity with the layer's alpha and blend
     * mode as `ctx` carries them. The screen's scratch (`strokeView`, its signature and the gesture's dirty box) stays
     * the screen's: the film panel's flatten during a stroke rebuilt it at 192 px and the next frame rebuilt it again,
     * two masked layers took it from each other on every frame, and a pass whose size is not a whole number of pixels
     * (the flood's coarse pass on a 3:2 picture) fell back to `_masked`: a 572 MB canvas and two display mirrors at
     * 15000 x 10000 for each masked layer.
     */
    drawLayerPass(ctx, layer, vp) {
        const W = ctx.canvas.width, H = ctx.canvas.height;
        const p = this.liveStrokeOn(layer) ? this.pointer : null;
        const s = this.passScratch("_passView", W, H);
        const x = s.getContext("2d");
        const toPass = (c) => { c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = "source-over"; c.clearRect(0, 0, W, H); c.setTransform(vp.sx, 0, 0, vp.sy, -vp.x * vp.sx, -vp.y * vp.sy); };
        x.save();
        try {
            toPass(x);
            this.drawPixelsInto(x, layer, layer.px, vp);
            if (p && p.kind === "layerpaint") this.drawStrokeInto(x, layer, layer.px, p.erase ? "destination-out" : (layer.alphaLock ? "source-atop" : "source-over"), vp, [0, 0, W, H]);
            // a liquify stroke on the screen whose region is not whole pixels (layerRegionView's null): its preview here
            else if (vp.screen && this.liquifyOn(layer)) this.drawLiquifyInto(x, layer, vp, [0, 0, W, H]);
            if (this.liveMask(layer)) {
                let m = null;
                if (p && p.kind === "maskpaint") {
                    m = this.passScratch("_passMaskView", W, H);
                    const mx = m.getContext("2d");
                    mx.save();
                    try {
                        toPass(mx);
                        this.drawPixelsInto(mx, layer, layer.maskPx, vp);
                        this.drawStrokeInto(mx, layer, layer.maskPx, p.erase ? "destination-out" : "source-over", vp, [0, 0, W, H]);
                    } finally { mx.restore(); }
                }
                x.globalAlpha = 1;
                x.globalCompositeOperation = "destination-in";
                if (m) {
                    x.setTransform(1, 0, 0, 1, 0, 0);
                    x.drawImage(m, 0, 0);
                } else {
                    this.drawPixelsInto(x, layer, layer.maskPx, vp);   // nothing to draw only outside the mask, where the layer drew nothing either
                }
            }
        } finally {
            x.restore();
        }
        ctx.save();
        try {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.drawImage(s, 0, 0);
        } finally {
            ctx.restore();
        }
    }

    /**
     * The in-progress stroke over the layer's rectangle, at the brush opacity and the gesture's
     * operation, into a context that carries the image -> destination transform. A gesture clipped
     * to the selection gets its clip in a scratch of the destination rectangle `dev` ([x0, y0, x1,
     * y1] in that context's own pixels), never in a copy of the stroke at the layer's resolution.
     */
    drawStrokeInto(ctx, layer, target, op, vp, dev) {
        const p = this.pointer, sb = p.stroke;
        if (!sb || sb.empty) return;
        if (!p.clip) {
            ctx.globalAlpha = this.strokeAlpha(p);
            ctx.globalCompositeOperation = op;
            sb.drawOver(this, ctx, layer, target, vp);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "source-over";
            return;
        }
        const w = dev[2] - dev[0], h = dev[3] - dev[1];
        if (w <= 0 || h <= 0) return;
        const s = this.bandScratch("_strokeDev", w, h);
        const x = s.getContext("2d");
        x.setTransform(1, 0, 0, 1, 0, 0);
        x.globalAlpha = 1;
        x.globalCompositeOperation = "source-over";
        x.clearRect(0, 0, w, h);
        x.setTransform(vp.sx, 0, 0, vp.sy, -vp.x * vp.sx - dev[0], -vp.y * vp.sy - dev[1]);
        sb.drawOver(this, x, layer, target, { ...vp, x: vp.x, y: vp.y, w: vp.w, h: vp.h });
        // the selection over the same image rectangle: destination-in, and the scratch is exactly
        // the rectangle, so the operation's reach beyond what is drawn is what it has to be
        x.globalCompositeOperation = "destination-in";
        this.drawSelectionInto(x, vp.sx, { x: vp.x, y: vp.y, w: vp.w, h: vp.h });
        ctx.save();
        try {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = this.strokeAlpha(p);
            ctx.globalCompositeOperation = op;
            ctx.drawImage(s, 0, 0, w, h, dev[0], dev[1], w, h);
        } finally {
            ctx.restore();
        }
    }

    /** Layer pixels with the in-progress stroke applied, for live preview: a canvas to draw from, never into; `display` as in layerPixels. */
    layerWithStroke(layer, display = false) {
        const p = this.pointer;
        if (!p || p.kind !== "layerpaint" || p.layer !== layer) return layer.px ? (display ? canvasOf(layer.px) : layer.px.toCanvas()) : null;
        const target = layer.px;
        let fresh = false;
        if (!this.strokePreview || this.strokePreview.width !== target.width || this.strokePreview.height !== target.height) {
            this.strokePreview = makeCanvas(target.width, target.height);
            this.strokePreview._livePreview = true;
            fresh = true;
        }
        if (p.previewOf !== this.strokePreview) { p.previewOf = this.strokePreview; fresh = true; }   // a new gesture: the layer is copied once
        const box = fresh ? null : this.takeDirty(p, "dirtyLayer", layer, target);
        if (fresh) p.dirtyLayer = null;
        if (fresh || box) this.refreshStrokePreview(this.strokePreview, target, p, box, p.erase ? "destination-out" : (layer.alphaLock ? "source-atop" : "source-over"));
        return this.strokePreview;
    }

    // ---- depth estimation (Nik-9 Parity R1-S3b / F8) --------------------------------

    /** The depth map on the document's map store (F8), or null. */
    get depth() {
        const m = this.maps && this.maps.depth;
        if (!m) return null;
        return {
            ...m,
            u16: m.data || m.u16,   // a store entry keeps its bytes in `data`; a legacy object set through the setter in `u16`
            ...m.meta,
            origW: this.width,
            origH: this.height,
        };
    }

    set depth(v) {
        if (!this.maps) this.maps = {};
        if (v) this.maps.depth = v;
        else delete this.maps.depth;
    }

    async ensureDepthMap({ force = false, edges = null, detail = null } = {}) {
        return this.computeDepthMap({ recompute: force, edges, detail });
    }

    /**
     * Compute or refresh the document's depth map:
     * Samples document without filter layers via host.depthInput, runs Depth Anything V2 Small,
     * optionally computes detail tiles pass (R2-S7), refines edges using guided filter in a worker,
     * and stores result in this.maps.depth via setMap.
     */
    async computeDepthMap({ recompute = false, edges = null, detail = null } = {}) {
        if (!this.base) throw new Error("No image loaded in document");
        if (this.depthPending) return this.depthPending;
        const model = host.depthModel();
        if (!model) {
            this.setStatus("Depth estimation needs Depth Anything V2 Small: download it in Settings › Helpers.", "warn");
            throw new Error("No depth model is downloaded (Settings › Helpers)");
        }
        const run = async () => {
            this.depthPending = true;
            this.renderDepthRow();
            try {
                const token = this.geometryToken();
                const W = this.width, H = this.height;
                const [mw, mh] = modelSize(W, H);
                const input = await host.depthInput(this, mw, mh);
                const fpInp = await host.pictureInput(this, 64, 64, { skipFilters: true, background: "#808080" });
                const fp = fingerprint(fpInp.image, 64, 64);

                const chosenDetail = detail || (host.getDepthDetail ? host.getDepthDetail() : (host.depthDetailSetting || "standard"));
                const existing = this.maps && this.maps.depth;
                const existingDetail = existing && existing.meta && existing.meta.detail
                    ? (existing.meta.detail.route === "large" ? "large" : (existing.meta.detail.grid === 3 ? "finest" : "fine"))
                    : "standard";
                if (!recompute && existing && existing.meta && existing.meta.fp === fp && existingDetail === chosenDetail) {
                    if (edges !== null && edges !== undefined) {
                        this.setMapMeta("depth", { snap: { ...(existing.meta.snap || {}), strength: Math.max(0, Math.min(100, Math.round(+edges))) } });
                    }
                    this.renderDepthRow();
                    return this.maps.depth;
                }
                this.setStatus("Estimating depth with " + model.label + " ...");
                const res = await host.computeDepth(this, {
                    image: input.image,
                    width: mw,
                    height: mh,
                });

                let rawDepth = res.depth;
                let rw = mw;
                let rh = mh;
                let detailMeta = null;

                if (chosenDetail !== "standard") {
                    const grid = chosenDetail === "finest" ? 3 : 2;
                    this._depthAbort = new AbortController();
                    this._depthStatusText = `Depth: tile 1 of ${grid * grid}`;
                    this.renderDepthRow();
                    let detailRes = null;
                    try {
                        detailRes = await host.depthDetail(this, {
                            grid,
                            route: "tiles",
                            global: { data: res.depth, w: mw, h: mh },
                            signal: this._depthAbort.signal,
                            onProgress: (i, n) => {
                                this._depthStatusText = `Depth: tile ${i} of ${n}`;
                                this.setStatus(this._depthStatusText);
                                this.renderDepthRow();
                            },
                        });
                    } catch (err) {
                        console.error("Depth detail failed:", err);
                        this.setStatus("Depth detail failed: " + (err.message || err), failKind(err));
                        return existing || null;
                    } finally {
                        this._depthAbort = null;
                        this._depthStatusText = null;
                    }
                    if (!detailRes) {
                        this.setStatus("Depth estimation cancelled.");
                        return existing || null;
                    }
                    rawDepth = detailRes.data;
                    rw = detailRes.w;
                    rh = detailRes.h;
                    detailMeta = {
                        route: detailRes.route,
                        grid: detailRes.grid,
                        size: [detailRes.w, detailRes.h],
                        tiles: detailRes.fits ? detailRes.fits.length : (detailRes.grid * detailRes.grid),
                        dropped: detailRes.fits ? detailRes.fits.filter((f) => f.dropped).length : 0,
                    };
                }

                const [gw, gh] = workSize(W, H, WORK_MAX);
                const guide = await host.depthInput(this, gw, gh);
                this.setStatus("Refining depth map with guided filter ...");
                const poolRes = await editorPool().run("depth_guide", {
                    raw: rawDepth,
                    rw,
                    rh,
                    gd: guide.image,
                    gw,
                    gh,
                    r: GUIDE.r,
                    eps: GUIDE.eps,
                }, [guide.image.buffer], { priority: INTERACTIVE });
                const u16 = new Uint16Array(poolRes.u16);
                const gd = new Uint8ClampedArray(poolRes.gd);
                const { lo, hi } = poolRes;
                // main answers the model's own time as runMs (and the whole call as seconds)
                const modelMs = res.runMs != null ? res.runMs : (res.seconds != null ? res.seconds * 1000 : 0);
                const snapStrength = edges != null ? Math.max(0, Math.min(100, Math.round(+edges))) : SNAP_DEFAULT;
                const meta = {
                    fp,
                    lo,
                    hi,
                    rawBounds: [res.min, res.max],
                    provider: res.provider,
                    ms: modelMs,
                    totalMs: modelMs + (poolRes.timing && poolRes.timing.total ? poolRes.timing.total : 0),
                    raw: rawDepth,
                    rw,
                    rh,
                    snap: { strength: snapStrength },
                    ...(detailMeta ? { detail: detailMeta } : {}),
                };
                const map = makeMap("depth", gw, gh, u16, [W, 0, 0, H, 0, 0], meta, gd);
                const ok = await this.setMap("depth", map, { label: recompute ? "Recompute depth map" : "Depth map", token });
                if (!ok) {
                    this.setStatus("The depth map was dropped: the picture was turned or cropped meanwhile.");
                    return null;
                }
                this._depthOverlayCanvas = null;
                this._depthStale = false;
                const detailSuffix = detailMeta ? (" (" + chosenDetail + ")") : "";
                this.setStatus("Depth map " + rw + "x" + rh + " -> " + gw + "x" + gh + detailSuffix + " with " + model.label + " in " + (meta.totalMs / 1000).toFixed(2) + " s (" + res.provider + ").");
                return map;
            } catch (err) {
                console.error("Depth estimation failed:", err);
                this.setStatus("Depth estimation failed: " + (err.message || err), failKind(err));
                throw err;
            } finally {
                this.depthPending = null;
                this.renderDepthRow();
            }
        };
        const p = run();
        this.depthPending = p;
        return p;
    }

    /**
     * Create the document's depth map from an existing layer (white is near, black is far).
     * The layer must cover the whole picture.
     * @param {any} layer - Layer object, name, or id
     * @param {{ invert?: boolean }} [opts]
     * @returns {Promise<any>} The created DocMap
     */
    async depthFromLayer(layer, { invert = false } = {}) {
        if (!this.base) throw new Error("No image loaded in document");
        const l = typeof layer === "object" && layer ? layer : (this.layers.find((x) => x.id === layer || x.name === layer) || null);
        if (!l) {
            this.setStatus("Layer not found");
            throw new Error("Layer not found");
        }
        if (l.kind === "filter" || l.kind === "group" || !l.px || l.x > 0 || l.y > 0 || (l.x + l.w) < this.width || (l.y + l.h) < this.height) {
            this.setStatus("The layer must cover the whole picture");
            throw new Error("the layer must cover the whole picture");
        }

        const token = this.geometryToken();
        const W = this.width, H = this.height;
        const [gw, gh] = workSize(W, H, WORK_MAX);
        const s = Math.min(1, WORK_MAX / Math.max(W, H));

        const prevActiveId = this.activeLayerId;
        this.activeLayerId = l.id;
        let layerCanvas = null;
        try {
            layerCanvas = await this.sampleRegionSettled("layer", [0, 0, W, H], s);
        } finally {
            this.activeLayerId = prevActiveId;
        }

        if (!layerCanvas) {
            this.setStatus("Failed to read layer pixels", "error");
            throw new Error("Failed to read layer pixels");
        }

        const lctx = layerCanvas.getContext("2d", { willReadFrequently: true });
        const ldata = lctx.getImageData(0, 0, gw, gh).data;
        const n = gw * gh;
        const rawDepth = new Float32Array(n);
        for (let i = 0, j = 0; i < ldata.length; i += 4, j++) {
            const r = ldata[i], g = ldata[i + 1], b = ldata[i + 2], a = ldata[i + 3];
            const luma = a === 0 ? 0 : (0.299 * r + 0.587 * g + 0.114 * b) / 255;
            const far = invert ? luma : (1 - luma);
            rawDepth[j] = 1 - far;
        }

        const guide = await host.pictureInput(this, gw, gh, { skipFilters: true, background: "#808080" });
        this.setStatus("Refining depth map with guided filter ...");
        const poolRes = await editorPool().run("depth_guide", {
            raw: rawDepth,
            rw: gw,
            rh: gh,
            gd: guide.image,
            gw,
            gh,
            r: GUIDE.r,
            eps: GUIDE.eps,
            lo: 0,
            hi: 1,
        }, [guide.image.buffer], { priority: INTERACTIVE });
        const u16 = new Uint16Array(poolRes.u16);
        const gd = new Uint8ClampedArray(poolRes.gd);

        const fpInp = await host.pictureInput(this, 64, 64, { skipFilters: true, background: "#808080" });
        const fp = fingerprint(fpInp.image, 64, 64);
        const meta = {
            source: "layer",
            layer: l.name || `Layer ${l.id}`,
            time: Date.now(),
            fp,
            lo: 0,
            hi: 1,
            raw: rawDepth,
            rw: gw,
            rh: gh,
            snap: { strength: SNAP_DEFAULT },
            invert: !!invert,
        };

        const map = makeMap("depth", gw, gh, u16, [W, 0, 0, H, 0, 0], meta, gd);
        const ok = await this.setMap("depth", map, { label: "Depth from layer", token });
        if (!ok) {
            this.setStatus("The depth map was dropped: the picture was turned or cropped meanwhile.");
            return null;
        }
        this._depthOverlayCanvas = null;
        this._depthStale = false;
        this.setStatus("Depth map " + gw + "x" + gh + " from layer \"" + (l.name || l.id) + "\".");
        this.renderDepthRow();
        return map;
    }

    /**
     * Flyout menu to select a layer to generate depth from.
     * @param {HTMLElement} anchor
     */
    openDepthFromLayerMenu(anchor) {
        if (this.flyout && this.flyout.group && this.flyout.group.btn === anchor) { this.closeFlyout(); return; }
        const candidateLayers = this.layers.filter((l) => l.kind !== "filter" && l.kind !== "group");
        if (!candidateLayers.length) {
            this.setStatus("No layers to create depth from.");
            return;
        }
        const actions = [];
        for (const l of candidateLayers) {
            const name = l.name || `Layer ${l.id}`;
            actions.push({
                label: name,
                title: "Make depth map from " + name + " (white is near, black is far)",
                onClick: () => this.depthFromLayer(l, { invert: false }),
            });
            actions.push({
                label: name + " (inverted)",
                title: "Make depth map from " + name + " inverted (black is near, white is far)",
                onClick: () => this.depthFromLayer(l, { invert: true }),
            });
        }
        this.openFlyout({ btn: anchor, items: [], actions });
    }

    /**
     * Is this filter layer's effect shown instead of the picture in the pass being drawn? Only the
     * screen pass (`viewPass.screen`): a sample pass (the wand's fine pass, the bucket's probe, the
     * Limit row's histograms), a thumbnail or an export reads the picture whatever the view shows.
     */
    effectViewOf(layer, forRun = false) {
        const vp = this.viewPass;
        return !forRun && !!vp && !!vp.screen && !vp.sample
            && !!this.maskView && this.maskView.mode === "effect" && this.maskView.id === layer.id;
    }

    /**
     * Has the picture changed enough since the depth map was computed? Answers from the last check and,
     * when the composite moved since then, runs one more check in the background (a 64 x 64 flatten,
     * no model) and redraws the row when its answer differs; a map just computed is never stale.
     */
    isDepthStale() {
        const m = this.maps && this.maps.depth;
        if (!m) return false;
        if (this._depthStaleAt !== this.compositeVersion && !this._depthStaleCheck) {
            const at = this.compositeVersion;
            this._depthStaleCheck = this.checkDepthStale().then((stale) => {
                this._depthStaleAt = at;
                this._depthStaleCheck = null;
                // the picture moved on while the check ran: once more, for the picture as it is now
                if (this.compositeVersion !== at) this.isDepthStale();
                else if (stale !== this._depthStaleShown) this.renderDepthRow();
            }, () => { this._depthStaleCheck = null; });
        }
        this._depthStaleShown = this._depthStale ?? false;
        return this._depthStaleShown;
    }

    async checkDepthStale() {
        const res = await this.mapStale("depth");
        this._depthStale = res.stale;
        return res.stale;
    }

    /** Draw depth map overlay onto canvas view. */
    drawDepthOverlay(ctx) {
        if (!this.depth || !this.depth.u16) return;
        const key = this.depth.dataVersion || this.depth.version || 1;
        if (!this._depthOverlayCanvas || this._depthOverlayKey !== key) {
            const dw = this.depth.w, dh = this.depth.h;
            const c = document.createElement("canvas");
            c.width = dw; c.height = dh;
            const dctx = c.getContext("2d");
            const idata = dctx.createImageData(dw, dh);
            const d32 = idata.data;
            const u16 = this.depth.u16;
            const n = dw * dh;
            for (let i = 0, j = 0; i < n; i++, j += 4) {
                const v = (u16[i] >> 8) & 0xff;
                d32[j] = v;
                d32[j + 1] = v;
                d32[j + 2] = v;
                d32[j + 3] = 255;
            }
            dctx.putImageData(idata, 0, 0);
            this._depthOverlayCanvas = c;
            this._depthOverlayKey = key;
        }
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.drawImage(this._depthOverlayCanvas, 0, 0, this.width, this.height);
        ctx.restore();
    }

    /** Refresh sidebar depth controls and status. */
    renderDepthRow() {
        if (!this.depthContainer) return;
        const con = this.depthContainer;
        con.innerHTML = "";
        if (!this.base) {
            con.appendChild(el("span", "ipc-dim", "No image loaded"));
            return;
        }
        if (this.depthPending) {
            const row = el("div", "ipc-sec");
            row.appendChild(el("span", null, this._depthStatusText || "Estimating depth map ..."));
            if (this._depthAbort) {
                const cancelBtn = el("button", "ipc-small", "Cancel");
                cancelBtn.addEventListener("click", () => {
                    if (this._depthAbort) this._depthAbort.abort();
                    this.setStatus("Depth estimation cancelled.");
                });
                row.appendChild(cancelBtn);
            }
            con.appendChild(row);
            return;
        }
        const depthMap = (this.maps && this.maps.depth) || this.depth;
        if (!depthMap) {
            const row = el("div", "ipc-sec");
            const btn = iconButton("magic", "Compute 16-bit depth map with Depth Anything V2 Small", () => this.ensureDepthMap(), "Compute depth map");
            btn.classList.add("ipc-small", "ipc-primary");
            row.appendChild(btn);

            const fromLayerBtn = el("button", "ipc-small ipc-btn ipc-depth-from-layer-btn", "From layer...");
            fromLayerBtn.title = "Make depth map from an existing layer";
            fromLayerBtn.addEventListener("click", () => this.openDepthFromLayerMenu(fromLayerBtn));
            row.appendChild(fromLayerBtn);

            const detailLab = el("label", "ipc-depth-detail-label", "Detail");
            const detailSel = el("select", "ipc-select ipc-depth-detail-select");
            const curDetail = host.getDepthDetail ? host.getDepthDetail() : (host.depthDetailSetting || "standard");
            for (const [val, lbl] of [["standard", "Standard"], ["fine", "Fine (2x2)"], ["finest", "Finest (3x3)"]]) {
                const opt = el("option", null, lbl);
                opt.value = val;
                if (val === curDetail) opt.selected = true;
                detailSel.appendChild(opt);
            }
            detailSel.addEventListener("change", () => {
                if (host.setDepthDetail) host.setDepthDetail(detailSel.value);
                else host.depthDetailSetting = detailSel.value;
            });
            detailLab.appendChild(detailSel);
            row.appendChild(detailLab);

            con.appendChild(row);
            return;
        }
        const stale = this.isDepthStale();
        const row = el("div", "ipc-sec");
        const info = el("span", null, `${depthMap.w} x ${depthMap.h}` + (stale ? " (stale)" : ""));
        if (stale) info.classList.add("ipc-warn");
        row.appendChild(info);
        const recomputeBtn = iconButton("refresh", "Recompute depth map for the current picture", () => this.ensureDepthMap({ force: true }), "Recompute");
        recomputeBtn.classList.add("ipc-small");
        if (stale) recomputeBtn.classList.add("ipc-primary");
        row.appendChild(recomputeBtn);

        const fromLayerBtn = el("button", "ipc-small ipc-btn ipc-depth-from-layer-btn", "From layer...");
        fromLayerBtn.title = "Replace depth map from an existing layer";
        fromLayerBtn.addEventListener("click", () => this.openDepthFromLayerMenu(fromLayerBtn));
        row.appendChild(fromLayerBtn);

        const detailLab = el("label", "ipc-depth-detail-label", "Detail");
        const detailSel = el("select", "ipc-select ipc-depth-detail-select");
        const curDetail = host.getDepthDetail ? host.getDepthDetail() : (host.depthDetailSetting || "standard");
        for (const [val, lbl] of [["standard", "Standard"], ["fine", "Fine (2x2)"], ["finest", "Finest (3x3)"]]) {
            const opt = el("option", null, lbl);
            opt.value = val;
            if (val === curDetail) opt.selected = true;
            detailSel.appendChild(opt);
        }
        detailSel.addEventListener("change", () => {
            if (host.setDepthDetail) host.setDepthDetail(detailSel.value);
            else host.depthDetailSetting = detailSel.value;
        });
        detailLab.appendChild(detailSel);
        row.appendChild(detailLab);

        const viewBtn = iconButton("eye", "Show depth map on canvas", () => {
            this.mapView = this.mapView === "depth" ? null : "depth";
            viewBtn.classList.toggle("ipc-toggle-on", this.mapView === "depth");
            this.draw();
        }, "Show map");
        viewBtn.classList.add("ipc-small");
        viewBtn.classList.toggle("ipc-toggle-on", this.mapView === "depth");
        this.depthViewBtn = viewBtn;
        row.appendChild(viewBtn);
        con.appendChild(row);

        const edgesRow = el("div", "ipc-sec ipc-depth-edges-row");
        const edgesLab = el("label", "ipc-depth-edges-label", "Edges");
        edgesLab.title = "How closely depth follows the picture's edges; 0 is the smooth map";
        const edgesSlider = document.createElement("input");
        edgesSlider.type = "range";
        edgesSlider.min = "0";
        edgesSlider.max = "100";
        edgesSlider.step = "1";
        const curStrength = (depthMap.meta?.snap?.strength != null) ? depthMap.meta.snap.strength : SNAP_DEFAULT;
        edgesSlider.value = String(curStrength);
        edgesSlider.title = "How closely depth follows the picture's edges; 0 is the smooth map";
        edgesSlider.className = "ipc-range-slider ipc-depth-edges-slider";
        const edgesVal = el("span", "ipc-depth-edges-val", String(curStrength));
        edgesSlider.addEventListener("input", () => {
            const str = parseInt(edgesSlider.value, 10) || 0;
            edgesVal.textContent = String(str);
            this.setMapMeta("depth", { snap: { strength: str } }, { preview: true });
            this.drawSoon();
        });
        edgesSlider.addEventListener("change", () => {
            const str = parseInt(edgesSlider.value, 10) || 0;
            edgesVal.textContent = String(str);
            this.setMapMeta("depth", { snap: { strength: str } }, { preview: false });
            this.draw();
        });
        edgesSlider.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                e.stopPropagation();
                this.cancelMapMeta("depth");
                const reverted = (this.maps?.depth?.meta?.snap?.strength != null) ? this.maps.depth.meta.snap.strength : SNAP_DEFAULT;
                edgesSlider.value = String(reverted);
                edgesVal.textContent = String(reverted);
                this.drawSoon();
            }
        });
        this.depthEdgesInput = edgesSlider;
        edgesLab.appendChild(edgesSlider);
        edgesLab.appendChild(edgesVal);
        edgesRow.appendChild(edgesLab);
        con.appendChild(edgesRow);

        const editRow = el("div", "ipc-sec ipc-depth-edit-row");
        const hasSel = !!this.getBounds();

        const btnFlatten = el("button", "ipc-small ipc-depth-flatten-btn", "Flatten");
        btnFlatten.title = "Flatten depth inside selection to median";
        btnFlatten.disabled = !hasSel;
        btnFlatten.addEventListener("click", () => this.editDepth("flatten", null, { label: "Depth: Flatten" }));
        editRow.appendChild(btnFlatten);

        const btnNearer = el("button", "ipc-small ipc-depth-nearer-btn", "Nearer");
        btnNearer.title = "Step depth inside selection nearer (-0.05)";
        btnNearer.disabled = !hasSel;
        btnNearer.addEventListener("click", () => this.editDepth("offset", -0.05, { label: "Depth: Nearer" }));
        editRow.appendChild(btnNearer);

        const btnFarther = el("button", "ipc-small ipc-depth-farther-btn", "Farther");
        btnFarther.title = "Step depth inside selection farther (+0.05)";
        btnFarther.disabled = !hasSel;
        btnFarther.addEventListener("click", () => this.editDepth("offset", 0.05, { label: "Depth: Farther" }));
        editRow.appendChild(btnFarther);

        const btnSmooth = el("button", "ipc-small ipc-depth-smooth-btn", "Smooth");
        btnSmooth.title = "Smooth depth inside selection";
        btnSmooth.disabled = !hasSel;
        btnSmooth.addEventListener("click", () => this.editDepth("smooth", 1, { label: "Depth: Smooth" }));
        editRow.appendChild(btnSmooth);

        con.appendChild(editRow);
    }

    /** The sequence counter bumped whenever whole-document geometry changes (PLAN_NIK9_BUILD.md §F8). */
    geometryToken() {
        return this.geometrySeq;
    }

    /**
     * Store or replace a document map (depth, guide, sky mask) under `kind`.
     * Immutable in data: changes produce a new DocMap object.
     * Uploads the packed u16 RGBA8 representation to ComfyUI/mirror if ref is missing.
     * Rejects if `token` no longer matches `geometryToken()` (e.g. canvas turned or cropped meanwhile)
     * or if the editor was destroyed.
     * @param {string} kind
     * @param {any} [map]
     * @param {{ label?: string, token?: number | null }} [opts]
     * @returns {Promise<boolean>}
     */
    async setMap(kind, map = null, { label = "Depth map", token = null } = {}) {
        if (token !== null && token !== this.geometryToken()) return false;
        if (this._destroyed) return false;

        const nodeId = (this.node && this.node.id != null) ? this.node.id : "0";
        if (map && !map.ref) {
            try {
                const c = packRG16(map);
                const { ref } = await uploadCanvas(c, `n${nodeId}_${kind || "depth"}`);
                map.ref = ref;
            } catch (_) {
                // Standalone / offline / test mode
            }
        }
        if (map && map.guide && !map.guideRef) {
            try {
                const gc = document.createElement("canvas");
                gc.width = map.w;
                gc.height = map.h;
                const gctx = gc.getContext("2d");
                const imgData = gctx.createImageData(map.w, map.h);
                imgData.data.set(map.guide);
                gctx.putImageData(imgData, 0, 0);
                const { ref } = await uploadCanvas(gc, `n${nodeId}_${kind || "depth"}guide`);
                map.guideRef = ref;
            } catch (_) {
                // Standalone / offline / test mode
            }
        }
        if (token !== null && token !== this.geometryToken()) return false;
        if (this._destroyed) return false;

        const prev = (this.maps && this.maps[kind]) || null;
        let snapBytes = 0;
        if (prev) {
            if (!map || prev.data !== map.data) snapBytes += prev.data ? prev.data.byteLength : 0;
            if (!map || prev.guide !== map.guide) snapBytes += prev.guide ? prev.guide.byteLength : 0;
        }
        this.pushUndoSnapshot({ kind: "maps", map: kind, prev, bytes: snapBytes }, { label });
        if (!this.maps) this.maps = {};
        if (map) {
            this.maps[kind] = map;
        } else {
            delete this.maps[kind];
        }
        this.mapsVersion++;

        for (const l of this.layers) {
            if (l.kind === "filter" && (l.params?.limit?.source === (kind || "depth") || this.mapsOf(l).includes(kind || "depth"))) {
                this.markFilterChanged(l);
            }
        }
        this.sceneSig = null;
        this.renderHistory();
        this.draw();
        this.notifyChanged();
        return true;
    }

    /**
     * Update metadata of a document map (R2-S4).
     * @param {string} kind
     * @param {object} patch
     * @param {{ preview?: boolean, label?: string }} [opts]
     * @returns {boolean}
     */
    setMapMeta(kind, patch, { preview = false, label = "Depth map edges" } = {}) {
        const cur = (this.maps && this.maps[kind]) || null;
        if (!cur) return false;
        const newMeta = { ...(cur.meta || {}), ...patch };
        const updated = deriveMap(cur, { meta: newMeta });
        if (preview) {
            if (!this._mapUndoPending) {
                this._mapUndoPending = cur;
            }
            this.maps[kind] = updated;
            this.mapsVersion++;
            for (const l of this.layers) {
                if (l.kind === "filter" && (l.params?.limit?.source === (kind || "depth") || this.mapsOf(l).includes(kind || "depth"))) {
                    this.markFilterChanged(l);
                }
            }
            this.draw();
            return true;
        }
        const prev = this._mapUndoPending || cur;
        this._mapUndoPending = null;
        this.pushUndoSnapshot({ kind: "maps", map: kind, prev, bytes: 0 }, { label });
        this.maps[kind] = updated;
        this.mapsVersion++;
        for (const l of this.layers) {
            if (l.kind === "filter" && (l.params?.limit?.source === (kind || "depth") || this.mapsOf(l).includes(kind || "depth"))) {
                this.markFilterChanged(l);
            }
        }
        this.sceneSig = null;
        this.renderHistory();
        this.draw();
        this.notifyChanged();
        return true;
    }

    /**
     * Cancel an in-flight metadata preview on a document map (R2-S5).
     * @param {string} [kind]
     * @returns {boolean}
     */
    cancelMapMeta(kind = "depth") {
        if (!this._mapUndoPending) return false;
        const prev = this._mapUndoPending;
        this._mapUndoPending = null;
        if (!this.maps) this.maps = {};
        this.maps[kind] = prev;
        this.mapsVersion++;
        for (const l of this.layers) {
            if (l.kind === "filter" && (l.params?.limit?.source === (kind || "depth") || this.mapsOf(l).includes(kind || "depth"))) {
                this.markFilterChanged(l);
            }
        }
        this.draw();
        return true;
    }

    /**
     * Edit the document's depth map inside the current selection (R2-S8).
     * @param {"flatten" | "offset" | "smooth"} op
     * @param {number | null} [value]
     * @param {{ label?: string }} [opts]
     * @returns {Promise<{ op: string, median?: number, texels_changed: number, map: { w: number, h: number, version: number } } | null>}
     */
    async editDepth(op, value = null, { label } = {}) {
        if (!this.maps || !this.maps.depth) {
            this.setStatus("Compute a depth map first.");
            return null;
        }
        if (!this.getBounds()) {
            this.setStatus("Select what to change first.");
            return null;
        }

        const map = this.maps.depth;
        const W = this.width;
        const H = this.height;
        const s = Math.min(1, (2 * Math.max(map.w, map.h)) / Math.max(W, H));
        const sw = Math.max(1, Math.round(W * s));
        const sh = Math.max(1, Math.round(H * s));

        let selCanvas = await this.selectionCanvasSettled([0, 0, W, H], s, sw, sh);
        let allocated = false;
        if (!selCanvas) {
            selCanvas = makeCanvas(sw, sh);
            allocated = true;
            const sctx = selCanvas.getContext("2d");
            sctx.imageSmoothingEnabled = true;
            this.sel.drawTo(sctx, 0, 0, sw, sh);
        }

        let weight;
        try {
            weight = selectionOnMap(selCanvas, s, map);
        } finally {
            if (allocated || selCanvas) {
                selCanvas.width = 1;
                selCanvas.height = 1;
            }
        }

        const data = editMap(map, weight, op, value);
        const edits = ((map.meta && map.meta.edits) || 0) + 1;
        const nextMeta = { ...(map.meta || {}), edits };
        const nextMap = deriveMap(map, { data, meta: nextMeta });
        const undoLabel = label || ("Depth: " + (op.charAt(0).toUpperCase() + op.slice(1)));
        await this.setMap("depth", nextMap, { label: undoLabel });

        const res = {
            op,
            texels_changed: data.texelsChanged || 0,
            map: { w: nextMap.w, h: nextMap.h, version: nextMap.version },
        };
        if (data.median !== undefined) {
            res.median = data.median;
        }
        return res;
    }

    /**
     * The map kinds a filter layer depends on (R2-S12, F10):
     * union of def.maps(params) and limit.source === "depth" ? ["depth"] : [].
     * @param {any} layer
     * @returns {string[]}
     */
    mapsOf(layer) {
        if (!layer || (layer.kind ? layer.kind !== "filter" : !layer.filter)) return [];
        const def = FILTERS[layer.filter];
        const res = new Set();
        if (def) {
            if (typeof def.maps === "function") {
                try {
                    const list = def.maps(layer.params || {});
                    if (Array.isArray(list)) for (const k of list) if (k) res.add(k);
                } catch (_) { /* ignore */ }
            } else if (Array.isArray(def.maps)) {
                for (const k of def.maps) if (k) res.add(k);
            }
        }
        if (layer.params && layer.params.limit && (layer.params.limit.source === "depth" || layer.params.limit.source === "map")) {
            res.add("depth");
        }
        return Array.from(res);
    }

    /**
     * Cancel pending filter parameter preview (e.g. from slider drag or preset hover).
     * Restores params to the snapshot taken before preview began and clears pending state.
     * @param {any} layer
     * @returns {boolean}
     */
    cancelFilterParams(layer) {
        if (!layer || layer.kind !== "filter" || !layer._undoPending) return false;
        layer.params = { ...(layer._undoPending.params || {}) };
        layer._undoPending = null;
        this.filterPreview = null;
        this.markFilterChanged(layer, { soon: true });
        this.draw();
        return true;
    }

    /**
     * Every preview still shown goes back to its committed values: a choice list's hover and a filter layer's
     * `_undoPending` while `filterPreview` names its layer (a plugin's hover over a stock, a slider not let go). An
     * `_undoPending` no preview shows any more is a slider the list was rebuilt under: it is not cancelled (that would
     * put back the values from before it over every later edit of the layer). A relight nudge or wheel burst is not a
     * preview but a step of its own (`_nudgePending` / `_wheelPending`, pushed by flushPendingDebounces).
     */
    cancelPreviews() {
        this.cancelChoicePreview();
        for (const l of this.layers || []) if (this.previewShown(l)) this.cancelFilterParams(l);
    }

    /**
     * Whether `filterPreview` shows a preview whose "before" the layer holds in `_undoPending`: not a relight nudge's or
     * wheel burst's preview (theirs is `_nudgePending` / `_wheelPending`), not an `_undoPending` left by a slider the list
     * was rebuilt under (nothing shows it any more).
     */
    previewShown(l) {
        return !!(l && l._undoPending && this.filterPreview === l.id && !l._nudgePending && !l._wheelPending);
    }

    /**
     * The committed parameters (and name) of a filter layer whose preview is shown, as cancelPreviews would put them
     * back (a choice list's hover first: its cancel ends the preview); null when none is. An undo record or a copy holds
     * these, not the hovered or half-dragged ones.
     */
    committedFilter(l) {
        if (!l || l.kind !== "filter") return null;
        const snap = l._hoverSnap && this.filterPreview === l.id ? l._hoverSnap
            : this.previewShown(l) && l._undoPending.kind === "filter" ? l._undoPending : null;
        if (!snap) return null;
        const params = { ...(snap.params || {}) };
        if (Array.isArray(params.lights)) params.lights = JSON.parse(JSON.stringify(params.lights));
        return { params, name: l._hoverSnap === snap ? snap.name || null : null };
    }

    /**
     * renderLayers, unless a control of the list holds an edit still in progress (a slider being dragged): rebuilding the
     * list under it ends the drag without its change event, and its step would never be pushed. The control's own
     * change renders the list when it lets go.
     */
    renderLayersUnlessEditing() {
        if ((this.layers || []).some((x) => x && (x._undoPending || x._matchUndo))) return;
        this.renderLayers();
    }

    /**
     * Checks if the document map under `kind` is stale against the current picture.
     * Renders pictureInput through the map's xf into 64 x 64 and compares fingerprint against meta.fp.
     * @param {string} kind
     * @returns {Promise<{ stale: boolean, diff: number }>}
     */
    async mapStale(kind) {
        const map = this.maps && this.maps[kind];
        if (!map || !map.meta || !map.meta.fp) return { stale: false, diff: 0 };
        if (this.width <= 0 || this.height <= 0) return { stale: false, diff: 0 };
        try {
            const inp = await host.pictureInput(this, 64, 64, { skipFilters: true, background: "#808080" });
            const fp = fingerprint(inp.image, 64, 64);
            const diff = fingerprintDiff(map.meta.fp, fp);
            const thresh = map.meta.threshold != null ? map.meta.threshold : STALE_DIFF;
            return { stale: diff >= thresh, diff };
        } catch (err) {
            console.warn("mapStale failed:", err);
            return { stale: false, diff: 0 };
        }
    }

    // ---- undo ----------------------------------------------------------------

    /**
     * PNG of a canvas as a blob URL, encoded off the main thread; undo steps hold the promise. The
     * canvas is a `toCanvas()` view that the edit writes into next, so it is encoded as a snapshot.
     */
    snapUrl(canvas) {
        const p = canvasToBlob(canvas, { snapshot: true }).then((blob) => URL.createObjectURL(blob));
        p.catch(() => null);
        return p;
    }

    /**
     * A copy of the pixels of `layer` inside `rect` (in the target's own pixels): the undo
     * step of a brush stroke, so a stroke on a 100 MP layer costs what it covered. The step
     * holds the copy as pixels (`px`) and goes back with a "copy" blit.
     */
    snapshotRect(layer, rect, mask = false, exact = false) {
        const target = mask ? layer.maskPx : layer.px;
        if (!target) return null;
        let x, y, x1, y1;
        if (exact) {
            // the box of a step being undone or redone, taken again as it is: a margin added per round trip grew the redo
            // copy by 6 px each time, and on tiles by a whole tile
            x = rect.x; y = rect.y; x1 = rect.x + rect.w; y1 = rect.y + rect.h;
        } else {
            x = Math.max(0, Math.floor(rect.x) - 2); y = Math.max(0, Math.floor(rect.y) - 2);
            x1 = Math.min(target.width, Math.ceil(rect.x + rect.w) + 4); y1 = Math.min(target.height, Math.ceil(rect.y + rect.h) + 4);
            // C4: on tiles the box grows to the whole tiles it touches. `copyRect` shares a tile only when the copy starts on a
            // tile's corner, so a box at floor(x) - 2 copied every tile it overlapped into a new one; over whole tiles the step
            // shares them, and the stroke's own write is what copies the tiles it touches (the originals stay the step's)
            if (isTilePixels(target)) {
                x = x - (x % TILE_SIZE); y = y - (y % TILE_SIZE);
                x1 = Math.min(target.width, Math.ceil(x1 / TILE_SIZE) * TILE_SIZE); y1 = Math.min(target.height, Math.ceil(y1 / TILE_SIZE) * TILE_SIZE);
            }
        }
        const w = x1 - x, h = y1 - y;
        if (w <= 0 || h <= 0) return null;
        const copy = target.copyRect([x, y, x1, y1]);
        return { kind: "layerrect", id: layer.id, mask, x, y, w, h, px: copy, bytes: w * h * 4 };
    }

    /**
     * A layer-pixels step of several rectangles (a content-aware move's old and new place, PLAN_0_1_31 §5 step 4b): a
     * `layerrect` whose `parts` are `snapshotRect`s, each put back by its own blit (both are copies from before the edit,
     * so their order does not matter where they overlap); x y w h are the box around them. Null when none holds pixels.
     */
    snapshotRects(layer, rects, exact = false) {
        const parts = rects.map((r) => this.snapshotRect(layer, r, false, exact)).filter(Boolean);
        if (!parts.length) return null;
        const x = Math.min(...parts.map((s) => s.x)), y = Math.min(...parts.map((s) => s.y));
        const x1 = Math.max(...parts.map((s) => s.x + s.w)), y1 = Math.max(...parts.map((s) => s.y + s.h));
        return { kind: "layerrect", id: layer.id, mask: false, x, y, w: x1 - x, h: y1 - y, parts, bytes: parts.reduce((n, s) => n + s.bytes, 0) };
    }

    /**
     * The undo step of a selection change: a copy of the selection inside its extent, the
     * way a brush stroke's step is a copy of the touched rectangle. A whole-canvas PNG
     * used to be encoded per step, which on a 15k document is 150 million pixels through
     * the worker for a marquee that covers a corner. Up to SNAP_CANVAS_PX the copy is
     * pixels (`px`, a GPU blit, counted against MAX_UNDO_BYTES); above it the extent is
     * encoded as a PNG off the main thread, like the old whole-canvas step. An empty
     * selection is a step without pixels.
     */
    snapshotSelection() {
        const ext = this.selectionExtent();
        const bounds = this.selectionDirty ? undefined : this.cachedBounds;
        if (!ext) return { kind: "selection", empty: true, bytes: 0, bounds: null };
        let [x, y, x1, y1] = ext;
        // C4: on tiles the whole tiles the extent touches, so the copy shares them (see snapshotRect)
        if (isTilePixels(this.sel)) {
            x -= x % TILE_SIZE; y -= y % TILE_SIZE;
            x1 = Math.min(this.width, Math.ceil(x1 / TILE_SIZE) * TILE_SIZE); y1 = Math.min(this.height, Math.ceil(y1 / TILE_SIZE) * TILE_SIZE);
        }
        const w = x1 - x, h = y1 - y;
        const copy = this.sel.copyRect([x, y, x1, y1]);   // the extent is on whole pixels inside the selection
        // on tiles the copy shares the selection's tiles and stays pixels at any size, counted like the PNG it
        // replaces (docs/PLAN_BCE.md §C2, the final review; C4 counts the tiles a step holds alone)
        if (w * h > SNAP_CANVAS_PX) return isTilePixels(copy) ? { kind: "selection", x, y, w, h, px: copy, bytes: 0, bounds } : { kind: "selection", x, y, w, h, url: this.snapUrl(copy.toCanvas()), bytes: 0, bounds };
        return { kind: "selection", x, y, w, h, px: copy, bytes: w * h * 4, bounds };
    }

    /** Widen the box a gesture has painted over (image coordinates). */
    strokeBounds(p, x0, y0, x1, y1, pad) {
        const nx0 = Math.min(x0, x1) - pad, ny0 = Math.min(y0, y1) - pad;
        const nx1 = Math.max(x0, x1) + pad, ny1 = Math.max(y0, y1) + pad;
        const b = p.bounds;
        p.bounds = b ? [Math.min(b[0], nx0), Math.min(b[1], ny0), Math.max(b[2], nx1), Math.max(b[3], ny1)] : [nx0, ny0, nx1, ny1];
    }

    /** The box a gesture painted over, in the target canvas's own pixels, or null for all of it. */
    strokeRect(p, target) {
        if (!target || !p.bounds) return null;
        if (p.rect && target === p.layer.px) return p.rect;   // frozen at the release of a heal that blended in a worker
        const layer = p.layer;
        const sx = target.width / layer.w, sy = target.height / layer.h;
        const [x0, y0, x1, y1] = p.bounds;
        return [(x0 - layer.x) * sx, (y0 - layer.y) * sy, (x1 - layer.x) * sx, (y1 - layer.y) * sy];
    }

    /** The undo step for a finished stroke: the touched rectangle, or the whole layer. */
    strokeUndo(p, target) {
        const layer = p.layer;
        if (!target) return null;
        // a content-aware move's two places (layer pixels), each copied (`snapshotRects`)
        if (p.undoBoxes && target === layer.px) return this.snapshotRects(layer, p.undoBoxes.map((b) => ({ x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] })));
        const box = this.strokeRect(p, target);
        const rect = box ? { x: box[0], y: box[1], w: box[2] - box[0], h: box[3] - box[1] } : { x: 0, y: 0, w: target.width, h: target.height };
        return this.snapshotRect(layer, rect, p.kind === "maskpaint");
    }

    /** Free a discarded undo step: its blob URLs, its pixels copy and its share of the memory budget. */
    /**
     * Layers an undo took out of the document (replaced by the objects of a record) let go of an edit still in progress:
     * a text edit's or a colour match drag's "before" (on canvases a blob URL), which no record holds (LAYER_PENDING_KEYS).
     */
    releaseDroppedEdits(outgoing) {
        for (const l of outgoing || []) {
            if (!l || this.layers.includes(l)) continue;
            if (l._textUndo) { this.releaseSnapshot(l._textUndo); l._textUndo = null; }
            if (l._matchUndo) { this.releaseSnapshot(l._matchUndo); l._matchUndo = null; }
        }
    }

    releaseSnapshot(snap) {
        if (!snap) return;
        this.undoBytes -= snap.bytes || 0;
        for (const k of ["url", "mask", "selection"]) {
            const v = snap[k];
            if (!v || v === true) continue;   // a layerrect step's `mask` is a flag
            if (typeof v.then === "function") v.then((u) => { if (typeof u === "string" && u.startsWith("blob:")) URL.revokeObjectURL(u); }).catch(() => {});
            else if (typeof v === "string" && v.startsWith("blob:")) URL.revokeObjectURL(v);
        }
        // C4: the step's own copies let go of their tiles (a restore that put them into the document took them out of the
        // step first); a `layers` / `canvas` step's layers and base are the document's objects by reference, never released
        for (const k of ["px", "maskPx", "selPx"]) {
            const p = snap[k];
            if (p && typeof p.release === "function") p.release();
            snap[k] = null;
        }
        // a step of several rectangles (`snapshotRects`): each part's copy
        if (Array.isArray(snap.parts)) {
            for (const s of snap.parts) if (s && s.px && typeof s.px.release === "function") { s.px.release(); s.px = null; }
            snap.parts = null;
        }
        // a turn step holds one clone per layer (turnSnapshot); a restore took them out first
        if (Array.isArray(snap.pixels)) {
            for (const p of snap.pixels) {
                if (p && p.px && typeof p.px.release === "function") p.px.release();
                if (p && p.maskPx && typeof p.maskPx.release === "function") p.maskPx.release();
            }
            snap.pixels = null;
        }
    }

    /**
     * A layer as a `layers` / `canvas` step keeps it: the pixels by reference (they are replaced,
     * never written, by the operations those steps undo), and its own copies of what the text
     * and filter controls change in place (the text description, the filter parameters, colour
     * match, LUT, plate), copied as their own undo steps copy them. A shared object brought an
     * undone text size or slider value back when an older step was undone.
     */
    snapshotLayer(l) {
        const c = { ...l };
        for (const k of LAYER_PENDING_KEYS) delete c[k];
        if (l.text) c.text = JSON.parse(JSON.stringify(l.text));
        if (l.params && typeof l.params === "object") {
            c.params = { ...l.params };
            if (Array.isArray(l.params.lights)) {
                c.params.lights = JSON.parse(JSON.stringify(l.params.lights));
            }
        }
        // a preview still shown is not the layer's value: the record holds what was committed (an undo of it brings back
        // what was clicked, not what was hovered; its guard is not in the record to put it back later)
        const committed = this.committedFilter(l);
        if (committed) { c.params = committed.params; if (committed.name) c.name = committed.name; }
        for (const k of ["match", "lut", "plate"]) if (l[k] && typeof l[k] === "object") c[k] = { ...l[k] };
        return c;
    }

    /**
     * The whole document as one step (`{kind: "turn"}`), for the assistant's "Undo this turn"
     * (docs/PLAN_ASSISTANT.md §4 A7). It is a `canvas` step plus **a copy-on-write clone of every
     * layer's pixels and mask** - a canvas step keeps the layer objects by reference, which is
     * enough for an extend or a crop (they replace pixels, never write them), but a turn is a
     * row of edits that write into the layers the document still holds. The clones cost nothing
     * to take on tiles; on the canvas backend a full copy of every layer would be 600 MB at
     * 15,000 x 10,000, so there this answers **null** and the panel says so.
     *
     * It also holds what no undo step holds: the prompt, the negative prompt, the generation and
     * crop settings and the recipe's setting values, which `set_prompt`, `set_generation`,
     * `set_crop` and `set_settings` change and no step of the editor's own covers.
     */
    turnSnapshot() {
        if (!this.tileMode || !this.sel) return null;
        const pixels = [];
        const layers = this.layers.map((l) => {
            const record = this.snapshotLayer(l);
            pixels.push({ id: l.id, px: l.px ? l.px.clone() : null, maskPx: l.maskPx ? l.maskPx.clone() : null });
            // the restore takes the clones above; the record's own references to the live pixels and the layer's caches
            // would only keep what the document replaces later alive (a named snapshot lives as long as the user wants)
            record.px = null; record.maskPx = null;
            record._masked = null; record._maskedValid = false; record._mcache = null; record._fcache = null; record._fxCache = null;
            return record;
        });
        return {
            kind: "turn",
            base: this.base,
            width: this.width,
            height: this.height,
            selPx: this.sel.clone(),
            layers,
            groups: this.groupsCopy(),
            pixels,
            activeLayerId: this.activeLayerId,
            maps: this.maps ? { ...this.maps } : {},
            ...this.geometrySnapshot(),
            doc: {
                prompt: this.promptText,
                negative: this.negativeText,
                gen: JSON.parse(JSON.stringify(this.genSettings || {})),
                crop: JSON.parse(JSON.stringify(this.cropSettings || {})),
                settings: JSON.parse(JSON.stringify(this.settings || {})),
            },
        };
    }

    /**
     * Put a turn snapshot back and leave the way back on the undo stack: the present goes on as
     * one `turn` step, so Ctrl+Z takes the restore back and redo does it again, like any step.
     * The steps the turn itself pushed stay below it; nothing is collapsed.
     */
    restoreTurn(snap, { label } = {}) {
        if (!snap || snap.kind !== "turn" || !this.tileMode) return false;
        this.cancelPreviews();   // the present pushed below holds committed values, not a hover's (historyStepNow)
        const now = this.turnSnapshot();
        if (now) this.pushUndoSnapshot(now, { label });
        this.applySnapshot(snap);
        this.scheduleDetachedRelease();
        return true;
    }

    // ---- named snapshots (the Undo history section; tiles only, not saved with the document) ----------------------

    /**
     * Keep the whole document under a name: a turn snapshot (copy-on-write clones of every layer, its mask and the
     * selection, plus the prompt and the settings), so taking one costs nothing until the document is edited on. At
     * most MAX_SNAPSHOTS; the oldest goes first. Null on the canvas backend, which cannot clone for free.
     */
    takeSnapshot(name) {
        const snap = this.turnSnapshot();
        if (!snap) return null;
        // names are unique: the panel and the commands find a snapshot by its name
        let label = String(name || "").trim() || this.nextSnapshotName();
        if (this.findSnapshot(label)) { let n = 2; while (this.findSnapshot(`${label} (${n})`)) n++; label = `${label} (${n})`; }
        const entry = { name: label, at: Date.now(), snap };
        this.snapshots.push(entry);
        let dropped = null;
        while (this.snapshots.length > MAX_SNAPSHOTS) { dropped = this.snapshots.shift(); this.releaseSnapshot(dropped.snap); }
        if (dropped) this.setStatus(`Snapshot "${label}" taken; the oldest, "${dropped.name}", was dropped (${MAX_SNAPSHOTS} at most).`);
        else this.setStatus(`Snapshot "${label}" taken.`);
        this.historyChanged();
        return entry;
    }

    /** The first free "Snapshot N" (the panel offers it as the name). */
    nextSnapshotName() {
        let n = this.snapshots.length + 1;
        while (this.findSnapshot(`Snapshot ${n}`)) n++;
        return `Snapshot ${n}`;
    }

    /** A snapshot by its name or its index in `snapshots`. */
    findSnapshot(which) {
        if (typeof which === "number") return this.snapshots[which] || null;
        return this.snapshots.find((s) => s.name === which) || null;
    }

    /**
     * Put a snapshot back as one undo step (Ctrl+Z takes it back). The snapshot stays: what goes into the document
     * is a fresh copy of it, since a restore moves the pixels it is given into the layers.
     */
    restoreSnapshot(which) {
        const entry = this.findSnapshot(which);
        if (!entry) return false;
        if (!this.restoreTurn(this.copyTurn(entry.snap), { label: `Restore "${entry.name}"` })) return false;
        this.setStatus(`Snapshot "${entry.name}" restored. Ctrl+Z takes it back.`);
        return true;
    }

    deleteSnapshot(which) {
        const entry = this.findSnapshot(which);
        if (!entry) return false;
        this.snapshots.splice(this.snapshots.indexOf(entry), 1);
        this.releaseSnapshot(entry.snap);
        this.historyChanged();
        return true;
    }

    clearSnapshots() {
        for (const s of this.snapshots) this.releaseSnapshot(s.snap);
        this.snapshots = [];
        this.historyChanged();
    }

    /** A turn snapshot to hand to applySnapshot, leaving `snap` whole: new clones and new layer records. */
    copyTurn(snap) {
        return {
            ...snap,
            selPx: snap.selPx ? snap.selPx.clone() : null,
            layers: snap.layers.map((l) => this.snapshotLayer(l)),
            pixels: (snap.pixels || []).map((p) => ({ id: p.id, px: p.px ? p.px.clone() : null, maskPx: p.maskPx ? p.maskPx.clone() : null })),
            doc: JSON.parse(JSON.stringify(snap.doc || {})),
        };
    }

    /** The undo step a site asks for, with its label (the site's, else the kind's) and, taken back, its time. */
    snapshot(step) {
        const snap = this.snapshotOf(step);
        if (snap) {
            snap.label = step.label || UNDO_LABELS[snap.kind] || snap.kind;
            if (step.at) snap.at = step.at;
        }
        return snap;
    }

    snapshotOf(step) {
        if (step.kind === "layerrect") {
            const l = this.layers.find((x) => x.id === step.id);
            if (!l) return null;
            const snap = step.parts ? this.snapshotRects(l, step.parts, true) : this.snapshotRect(l, step, step.mask, true);
            // a liquify step's other side carries the field as it is (only a liquify step: another step's redo must not
            // bring a session back over pixels its field does not describe)
            if (snap && step.liq && this.liq && this.liq.sid === step.liq.sid && this.liq.layer === l) {
                snap.liq = { sid: this.liq.sid, cells: new Map(this.liq.field.cells) };
                snap.liqBytes = this.liquifyCellBytes(this.liq.field.cells, step.liq.cells, this.liq.field);
                snap.bytes += snap.liqBytes;
            }
            return snap;
        }
        if (step.kind === "selection") return this.snapshotSelection();
        if (step.kind === "turn") return this.turnSnapshot();
        // the plugins' per-document data alone (scumble.documents.data(doc).set(patch, { undo })): a plugin's own change
        // of what it keeps with the document, no pixels; a canvas or turn step carries the same copy beside its pixels
        if (step.kind === "data") return { kind: "data", pluginData: this.pluginDataCopy() };
        if (step.kind === "maps") {
            const prev = (this.maps && this.maps[step.map]) || null;
            const target = step.prev;
            let snapBytes = 0;
            if (prev) {
                if (!target || prev.data !== target.data) snapBytes += prev.data ? prev.data.byteLength : 0;
                if (!target || prev.guide !== target.guide) snapBytes += prev.guide ? prev.guide.byteLength : 0;
            }
            return { kind: "maps", map: step.map, prev, bytes: snapBytes };
        }
        if (step.kind === "layers") return { kind: "layers", layers: this.layers.map((l) => this.snapshotLayer(l)), groups: this.groupsCopy(), activeLayerId: this.activeLayerId };
        if (step.kind === "transforms") {
            // the places of several layers moved or scaled together (a multi-selection): one step, no pixels
            const ids = step.ids || step.items.map((i) => i.id);
            const items = ids.map((id) => this.layers.find((l) => l.id === id)).filter(Boolean).map((l) => ({ id: l.id, x: l.x, y: l.y, w: l.w, h: l.h }));
            return items.length ? { kind: "transforms", items } : null;
        }
        // On tiles a whole-layer step (and the canvas step's selection) holds a copy-on-write clone of the pixels
        // instead of a PNG: a clone shares every tile, costs nothing to take or to restore, and never materialises
        // the pixels. The PNG took a full-size CPU canvas plus a bitmap for the worker per step, and on a
        // 20000 × 12000 document its encode failed under that load, so the flip it belonged to could not be
        // undone (C2's final review). No PNG is made on tiles; the clone counts no bytes, like the PNG it
        // replaces (C4 counts the tiles a step holds alone and adds release()).
        const tiles = this.tileMode;
        if (step.kind === "canvas") {
            // base, size, selection and the layer list (shallow copies: the canvases themselves are never mutated by extend / crop, only replaced)
            const sel = tiles ? { selPx: this.sel.clone() } : { selection: this.snapUrl(this.sel.toCanvas()) };
            return { kind: "canvas", base: this.base, width: this.width, height: this.height, ...sel, layers: this.layers.map((l) => this.snapshotLayer(l)), groups: this.groupsCopy(), activeLayerId: this.activeLayerId,
                ...this.geometrySnapshot() };
        }
        const layer = this.layers.find((l) => l.id === step.id);
        if (!layer) return null;
        // on canvases the whole-layer steps stay a PNG per step (docs/PLAN_BCE.md C1 rule 7); C4 makes them tile refs
        const pixelsOf = (p) => (tiles ? { px: p.clone() } : { url: this.snapUrl(p.toCanvas()) });
        const maskOf = (m) => (!m ? { mask: null } : tiles ? { maskPx: m.clone() } : { mask: this.snapUrl(m.toCanvas()) });
        if (step.kind === "layer") return { kind: "layer", id: layer.id, ...pixelsOf(layer.px) };
        if (step.kind === "transform") return { kind: "transform", id: layer.id, x: layer.x, y: layer.y, w: layer.w, h: layer.h };
        if (step.kind === "mask") {
            const m = layer.maskPx;
            return { kind: "mask", id: layer.id, ...(!m ? { url: null } : tiles ? { maskPx: m.clone() } : { url: this.snapUrl(m.toCanvas()) }), mw: m ? m.width : 0, mh: m ? m.height : 0, maskOff: !!layer.maskOff };
        }
        if (step.kind === "match") return { kind: "match", id: layer.id, match: { ...(layer.match || { strength: 0, source: "surroundings" }) } };
        if (step.kind === "filter") {
            const p = { ...(layer.params || {}) };
            if (Array.isArray(p.lights)) p.lights = JSON.parse(JSON.stringify(p.lights));
            return { kind: "filter", id: layer.id, filter: layer.filter, params: p, lut: layer.lut ? { ...layer.lut } : null, lutData: layer._lutData || null, plate: layer.plate ? { ...layer.plate } : null, plateImg: layer._plateImg || null, name: layer.name, _selectedLightId: layer._selectedLightId || null, _deselected: !!layer._deselected };
        }
        if (step.kind === "text") return { kind: "text", id: layer.id, text: JSON.parse(JSON.stringify(layer.text || TEXT_DEFAULTS)), ...pixelsOf(layer.px), cw: layer.px.width, ch: layer.px.height, x: layer.x, y: layer.y, w: layer.w, h: layer.h,
            behind: !!layer._textRendering };
        if (step.kind === "layerfull") return { kind: "layerfull", id: layer.id, ...pixelsOf(layer.px), cw: layer.px.width, ch: layer.px.height, x: layer.x, y: layer.y, w: layer.w, h: layer.h,
            ...maskOf(layer.maskPx), mw: layer.maskPx ? layer.maskPx.width : 0, mh: layer.maskPx ? layer.maskPx.height : 0, maskOff: !!layer.maskOff };
        return null;
    }

    pushUndo(step) {
        if (!this.sel) return;   // no image loaded yet: nothing to undo
        this.pushUndoSnapshot(this.snapshot(step));
    }

    /**
     * `tracked`: the push of an operation an undo waits for (`trackEdit`) after its await. It is the
     * step that undo was pressed for, so it does not count as a change the waiting undo must stop at.
     */
    // `label`: what the Undo history calls the step (the edit it takes back); else the one the snapshot carries, else
    // its kind's
    pushUndoSnapshot(snap, { tracked = false, label, fromDebounce = false } = {}) {
        if (!snap) return;
        if (!fromDebounce) this.flushPendingDebounces();
        if (!tracked) this.historyGen++;
        if (label) snap.label = label;
        if (!snap.label) snap.label = UNDO_LABELS[snap.kind] || snap.kind;
        snap.at = Date.now();
        // the redo steps go first: the budget counts them, and trimming against it while they are
        // still counted threw away older undo steps that fit once the redo steps were gone
        for (const s of this.redo) this.releaseSnapshot(s);
        this.redo = [];
        this.undo.push(snap);
        this.undoBytes += snap.bytes || 0;
        this.trimUndo();
        this.scheduleDetachedRelease();
        this.historyChanged();
    }

    /** Drop the oldest steps past the depth (the instance's maxUndo / maxUndoBytes, which the app's settings set). */
    trimUndo() {
        const steps = Math.max(1, this.maxUndo || MAX_UNDO), bytes = this.maxUndoBytes || MAX_UNDO_BYTES;
        while (this.undo.length > steps || (this.undoBytes > bytes && this.undo.length > 1)) {
            this.releaseSnapshot(this.undo.shift());
            this.undoTrimmed = true;
        }
    }

    /** A new depth: applied at once (the oldest steps past it go), and to every step after. */
    setUndoDepth({ steps, bytes } = {}) {
        if (steps != null) this.maxUndo = Math.max(1, Math.round(+steps) || MAX_UNDO);
        if (bytes != null) this.maxUndoBytes = Math.max(1048576, Math.round(+bytes) || MAX_UNDO_BYTES);
        this.trimUndo();
        this.historyChanged();
    }

    /** The undo stacks changed: the Undo history section redraws once, after the current task. */
    historyChanged() {
        if (!this.renderUndoList || this._undoListQueued) return;
        this._undoListQueued = true;
        queueMicrotask(() => { this._undoListQueued = false; try { this.renderUndoList(); } catch (err) { console.warn("undo history", err); } });
    }

    /**
     * The history as rows, oldest first, the way Photoshop lists it: a state per row, named by the edit that led to it.
     * The first row is the oldest state kept ("Start", or "Oldest kept" once steps were dropped), then one row per undo
     * step (the state after that edit; the last of them is the present), then the redo steps (states after edits that
     * were taken back). `steps` is what `stepHistory` takes to get there: negative undoes, positive redoes.
     */
    undoList() {
        const rows = [{ label: this.undoTrimmed ? "Oldest kept" : "Start", at: null, steps: -this.undo.length }];
        this.undo.forEach((s, i) => rows.push({ label: s.label || UNDO_LABELS[s.kind] || s.kind, at: s.at || null, steps: i + 1 - this.undo.length }));
        for (let j = this.redo.length - 1; j >= 0; j--) {
            const s = this.redo[j];
            rows.push({ label: s.label || UNDO_LABELS[s.kind] || s.kind, at: s.at || null, steps: this.redo.length - j });
        }
        return rows.map((r) => ({ ...r, current: r.steps === 0, future: r.steps > 0 }));
    }

    /**
     * Undo (`n` < 0) or redo (`n` > 0) that many steps, one after the other through the history queue; stops early when
     * a step does not happen (a held stroke, an edit in between). Resolves with the steps taken.
     */
    async stepHistory(n) {
        this.flushPendingDebounces();
        const redo = n > 0;
        let done = 0;
        for (let i = 0; i < Math.abs(Math.round(n) || 0); i++) {
            const stack = () => (redo ? this.redo : this.undo);
            const before = stack().length;
            if (!before) break;
            await (redo ? this.redoStep() : this.undoStep());
            if (stack().length >= before) break;
            done++;
        }
        return done;
    }

    /**
     * After the current task: the display caches of pixels that left the document into a step (a removed,
     * merged or flattened layer, the old pixels of an extend or crop), and the atlas pages of pixels that left it
     * altogether (replaced by a flip, a turn, a new mask, a restore, a new base: C6 a). See releaseDetachedDisplays.
     * A microtask, because the operations push their step first and take the pixels out of the document after it.
     * Queued by every undo step, every undo / redo, every whole change of a layer or a mask (which is what a
     * replacement ends with), by setBase (a restore goes through it: its release runs at the restore's next
     * await, when the old layers are gone) and by the basePx getter when a new base image replaces the pixels.
     */
    scheduleDetachedRelease() {
        if (!this.tileMode || this._detachQueued) return;
        this._detachQueued = true;
        queueMicrotask(() => { this._detachQueued = false; this.releaseDetachedDisplays(); });
    }

    /**
     * On tiles: pixels an undo or redo step holds that the document does not (not a layer's, a mask's, the base's
     * or the selection's) give back their display mirror and thumbnail, with the pyramid levels, the screen's GPU
     * copy and the textures keyed on them. Nothing draws such pixels; their mirror stayed for as long as the step
     * lived, so a step held tiles plus a canvas as large as the layer, twice what the canvas backend holds, and
     * only a tab in the background ever let it go (C2's final review). An undo that brings them back makes the
     * mirror again on its first frame. Returns the bytes; 0 on canvases.
     */
    releaseDetachedDisplays() {
        if (!this.tileMode) return 0;
        const live = new Set([this._basePx, this.sel]);
        for (const l of this.layers) { live.add(l.px); live.add(l.maskPx); }
        const comp = this._compositor || null;
        let freed = 0;
        // C3: the compositor's atlas pages of pixels nothing draws any more. C6 (a): every record whose pixels the
        // document does not hold, not only the ones a step holds: pixels a flip, a new mask or an undo replaced are
        // in no step (the steps hold clones), and their pages stayed until they aged out
        if (comp) freed += comp.retainPixels(live);
        for (const p of this.heldPixels()) {
            if (live.has(p) || !isTilePixels(p)) continue;
            const m = p.displayCanvasIfMade();
            if (m) {
                const entry = this.pyramids.get(m);
                if (entry) {
                    if (comp) for (const c of [...entry.levels, entry.gpu]) if (c) comp.forget(c);
                    this.pyramids.delete(m);
                }
                if (comp) comp.forget(m);
            }
            if (m || p.thumbnailCanvasIfMade()) freed += p.releaseDisplay();
        }
        return freed;
    }

    /**
     * Drop the whole history: every step is released (its blob URLs revoked, its bytes taken off
     * the budget). A plain `undo = []` left the old document's bytes on the budget for good, so
     * the tab kept one undo step, and leaked the PNG blobs of its whole-layer steps.
     */
    clearUndo() {
        this.historyGen++;
        for (const s of this.undo) this.releaseSnapshot(s);
        for (const s of this.redo) this.releaseSnapshot(s);
        this.undo = [];
        this.redo = [];
        this.undoBytes = 0;
        this.undoTrimmed = false;
        this.historyChanged();
    }

    /**
     * Put a step back, synchronously: the images it carries (`url`, `mask`, the canvas step's
     * `selection`) were decoded by `loadSnapImages` before the step was taken off its stack, and
     * come in `images`. A restore that awaited its PNG wrote over whatever was edited meanwhile.
     */
    applySnapshot(snap, images = {}) {
        if (snap.kind === "layers") {
            if (this.pending) this.cancelPending();
            // a spread carries px / maskPx and not the non-enumerable aliases: installed again
            const outgoing = this.layers;
            this.layers = snap.layers.map((l) => installLayerAliases({ ...l, _maskedValid: false, _mcache: null, _fcache: null }, this.pixels));
            this.releaseDroppedEdits(outgoing);
            // the layers that come back keep their files and are not uploaded again: one whose file left the store meanwhile
            // (a clean-up, a file removed by hand) is uploaded from its pixels
            this.recheckRestoredFiles({ layers: this.layers, outgoing });
            this.groups = (snap.groups || []).map((g) => ({ ...g }));
            this.activeLayerId = this.layers.some((l) => l.id === snap.activeLayerId) ? snap.activeLayerId : null;
            this.uploaded.baseHash = null;
            this.uploaded.controlHash = null;
            this.refsMutated();   // an undo or redo of a layers step: the prompt stays, its tokens follow the ids
            this.renderLayers(); this.renderHistory(); this.draw(); this.drawThumb(); this.notifyChanged();
            return;
        }
        if (snap.kind === "transforms") {
            for (const it of snap.items) {
                const l = this.layers.find((x) => x.id === it.id);
                if (l) Object.assign(l, { x: it.x, y: it.y, w: it.w, h: it.h });
            }
            this.uploaded.baseHash = null;
            this.uploaded.controlHash = null;
            this.renderLayers(); this.renderHistory(); this.draw(); this.drawThumb(); this.notifyChanged();
            return;
        }
        if (snap.kind === "data") {
            this.pluginData = snap.pluginData ? JSON.parse(JSON.stringify(snap.pluginData)) : {};
            this.renderHistory(); this.draw(); this.notifyChanged();   // the plugins hear "changed" and redraw their overlays
            return;
        }
        if (snap.kind === "maps") {
            const kind = snap.map;
            if (!this.maps) this.maps = {};
            if (snap.prev) {
                this.maps[kind] = snap.prev;
            } else {
                delete this.maps[kind];
            }
            this.mapsVersion++;
            for (const l of this.layers) {
                if (l.kind === "filter" && (l.params?.limit?.source === (kind || "depth") || this.mapsOf(l).includes(kind || "depth"))) {
                    this.markFilterChanged(l);
                }
            }
            this.renderHistory(); this.draw(); this.notifyChanged();
            return;
        }
        if (snap.kind === "turn") {
            if (this.pending) this.cancelPending();
            if (this.textEdit) this.endTextEdit(false);
            const byId = new Map((snap.pixels || []).map((p) => [p.id, p]));
            const resized = snap.width !== this.width || snap.height !== this.height;
            this.restoreGeometry(snap);
            this.groups = (snap.groups || []).map((g) => ({ ...g }));
            if (snap.base !== this.base) this.recheckRestoredFiles({ base: snap.base });   // the layers below are all uploaded again
            this.base = snap.base;
            this.width = snap.width;
            this.height = snap.height;
            const outgoing = this.layers;
            this.layers = snap.layers.map((l) => {
                const kept = byId.get(l.id);
                const copy = installLayerAliases({ ...l, dirty: true, exportRef: null, _maskedValid: false, _mcache: null, _fcache: null, _fxCache: null }, this.pixels);
                // the clones move into the document; the step must not hand them out twice
                if (kept) {
                    if (kept.px) { copy.px = kept.px; kept.px = null; }
                    if (kept.maskPx) { copy.maskPx = kept.maskPx; kept.maskPx = null; copy.maskDirty = true; }
                }
                return copy;
            });
            this.releaseDroppedEdits(outgoing);
            snap.pixels = null;
            this.activeLayerId = this.layers.some((l) => l.id === snap.activeLayerId) ? snap.activeLayerId : null;
            const sel = snap.selPx || this.pixels.Mask.empty(this.width, this.height);
            snap.selPx = null;
            this.sel = sel;
            this.touchSource(sel);
            this.uploaded = this.makeUploaded();
            this.dropCompositeCaches();
            this.selectionDirty = true; this.selectionLoose = false;
            this.selectionDataUrl = null; this.selectionEncoded = false;
            if (resized) this.fitView();   // a snapshot from before a quarter turn or a crop
            this.renderSelectionList();
            // what no undo step holds: the fields set_prompt, set_generation, set_crop and
            // set_settings change; put back the way setValue puts them back
            const doc = snap.doc || {};
            if (doc.prompt !== undefined) this.setPromptText(doc.prompt, { history: "reset" });
            if (doc.negative !== undefined) this.setNegativeText(doc.negative);
            // the prompt came back with its layers: only what the snapshot does not hold is remapped
            this.refsRebuilt({ carry: true });
            // the mode stays: the recipe (the app) or the chain picked (the node) decides it, not a snapshot
            if (doc.gen) this.genSettings = { ...JSON.parse(JSON.stringify(doc.gen)), mode: this.genSettings.mode };
            if (doc.crop) { this.cropSettings = JSON.parse(JSON.stringify(doc.crop)); this.syncCropControls(); }
            if (doc.settings) this.settings = JSON.parse(JSON.stringify(doc.settings));
            this.syncGenControls();
            this.maps = snap.maps ? { ...snap.maps } : {};
            this.mapsVersion++;
            this.renderSettings();
            this.renderLayers();
            this.renderInfo();
            this.renderHistory();
            this.draw();
            this.drawThumb();
            this.notifyChanged();
            // the assistant's own restore hands a snapshot without a label; an undo or redo of a restore step is said by
            // historyStepNow
            if (!snap.label) this.setStatus("The assistant's turn was taken back.");
            return;
        }
        if (snap.kind === "canvas") {
            if (this.pending) this.cancelPending();
            // the selection was decoded before anything is put back: a frame drawn while it decoded
            // saw a new, empty selection, cached its display levels under the version the restored
            // one kept, and the restored selection's bounds came back empty
            const selImg = images.selection || null;   // null: its encode failed, an empty selection
            this.restoreGeometry(snap);
            this.groups = (snap.groups || []).map((g) => ({ ...g }));
            // the base comes back with its file and is not uploaded again (the layers below are, all of them)
            if (snap.base !== this.base) this.recheckRestoredFiles({ base: snap.base });
            this.base = snap.base;
            this.width = snap.width;
            this.height = snap.height;
            const outgoing = this.layers;
            this.layers = snap.layers.map((l) => installLayerAliases({ ...l, dirty: true, exportRef: null, _maskedValid: false, _mcache: null, _fxCache: null, maskDirty: !!l.maskPx }, this.pixels));
            this.releaseDroppedEdits(outgoing);
            this.activeLayerId = snap.activeLayerId;
            let sel = snap.selPx || null;   // on tiles the step's clone, taken out of the step (it is released after this)
            snap.selPx = null;
            if (!sel) {
                sel = this.pixels.Mask.empty(this.width, this.height);
                if (selImg) sel.drawInto(null, (ctx) => ctx.drawImage(selImg, 0, 0));
            }
            this.sel = sel;
            this.touchSource(sel);
            this.uploaded = this.makeUploaded();
            this.dropCompositeCaches();
            this.selectionDirty = true; this.selectionLoose = false;
            this.selectionDataUrl = null; this.selectionEncoded = false;
            if (this.extendInputs) for (const k of Object.keys(this.extendInputs)) this.extendInputs[k].value = 0;
            this.refsMutated();
            this.renderLayers();
            this.renderHistory();
            this.renderSelectionList();
            this.renderInfo();
            this.fitView();
            this.drawThumb();
            this.notifyChanged();
            this.setStatus(`Canvas is ${this.width} × ${this.height} again.`);
            return;
        }
        if (snap.kind === "selection") {
            // the copy goes back where it was taken from; what was selected outside it since is
            // cleared. The display levels are refreshed inside the union of both rectangles, so
            // an undo costs the selection's extent and not a rebuild of the levels of a 15k canvas.
            const old = this.selectionExtent();
            if (snap.px) {
                this.sel.clear();
                this.sel.blit(snap.px, snap.x, snap.y, "copy");
            } else {
                const img = snap.empty ? null : needImage(images.url);
                const W = this.width, H = this.height;
                this.sel.drawInto(null, (sctx) => {
                    sctx.clearRect(0, 0, W, H);
                    if (img) sctx.drawImage(img, snap.x, snap.y);
                });
            }
            const now = snap.empty ? null : [snap.x, snap.y, snap.x + snap.w, snap.y + snap.h];
            const rect = old && now ? [Math.min(old[0], now[0]), Math.min(old[1], now[1]), Math.max(old[2], now[2]), Math.max(old[3], now[3])] : (old || now || [0, 0, 1, 1]);
            this.markSelectionChanged(snap.bounds, rect);
        } else {
            const layer = this.layers.find((l) => l.id === snap.id);
            if (!layer) return;
            if (snap.kind === "layer") {
                const pixels = layer.px, W = pixels.width, H = pixels.height;
                if (snap.px) {
                    // tiles: in place, as a "copy" of the step's clone, which shares its tiles back; a tile the
                    // step shares with the layer is left alone (its display mirror syncs only what changed), and
                    // the display levels are refreshed over the tiles that differ, not rebuilt from the whole mirror
                    const same = snap.px.width === W && snap.px.height === H;
                    const box = same ? tileDiffBox(pixels, snap.px) : null;
                    if (!same) pixels.clear();
                    pixels.blit(snap.px, 0, 0, "copy");
                    if (same) {
                        if (box) this.markLayerChanged(layer, box);
                    } else this.markLayerChanged(layer);
                } else {
                    const img = needImage(images.url);
                    // in place, from a fresh context: 0.1.11 drew with whatever a flip, a turn or a merge
                    // had left on the layer's context, and put a flipped layer back mirrored (rule 11)
                    pixels.drawInto(null, (ctx) => {
                        ctx.clearRect(0, 0, W, H);
                        ctx.drawImage(img, 0, 0);
                    });
                    this.markLayerChanged(layer);
                }
            } else if (snap.kind === "transform") {
                Object.assign(layer, { x: snap.x, y: snap.y, w: snap.w, h: snap.h });
                this.uploaded.baseHash = null;
                this.uploaded.controlHash = null;
                this.renderLayers();
                this.drawThumb();
                this.notifyChanged();
            } else if (snap.kind === "match") {
                layer.match = { ...snap.match };
                this.markMatchChanged(layer);
                this.renderLayers();
            } else if (snap.kind === "filter") {
                layer.filter = snap.filter;
                layer.params = { ...(snap.params || {}) };
                if (Array.isArray(snap.params?.lights)) {
                    layer.params.lights = JSON.parse(JSON.stringify(snap.params.lights));
                }
                if (snap._selectedLightId !== undefined) {
                    layer._selectedLightId = snap._selectedLightId;
                    // Escape's "no light" belongs to the selection the step recorded; a step taken before any light was
                    // picked (id null, no flag) stays "the first light", not "none" (docs/PLAN_RELIGHT_FIXES.md F4)
                    layer._deselected = !!snap._deselected;
                } else if (layer._selectedLightId && (!layer.params.lights || !layer.params.lights.some((x) => x && x.id === layer._selectedLightId))) {
                    layer._selectedLightId = layer.params.lights && layer.params.lights[0] ? layer.params.lights[0].id : null;
                }
                layer.lut = snap.lut ? { ...snap.lut } : null;
                layer._lutData = snap.lutData || null;
                layer.plate = snap.plate ? { ...snap.plate } : null;
                layer._plateImg = snap.plateImg || null;
                layer.name = snap.name || layer.name;
                this.markFilterChanged(layer);
                this.renderLayers();
            } else if (snap.kind === "mask") {
                layer.maskPx = snap.maskPx || (snap.url ? this.pixels.Mask.fromImage(needImage(images.url), snap.mw, snap.mh) : null);
                snap.maskPx = null;   // the document's now, not the step's to release (C4)
                layer.maskOff = !!(snap.maskOff && layer.maskPx);
                if (!layer.maskPx) layer.maskEdit = false;
                this.markMaskChanged(layer);
                this.renderLayers();
            } else if (snap.kind === "text") {
                // a render still waiting for its font is dropped: it would put the pixels of the
                // description that is being undone on top of the restored one
                layer._textToken = (layer._textToken || 0) + 1;
                layer._textRendering = 0;
                layer.px = snap.px || this.pixels.Layer.fromImage(needImage(images.url), snap.cw, snap.ch);   // replaced: rule 2
                snap.px = null;   // the document's now (C4)
                Object.assign(layer, { x: snap.x, y: snap.y, w: snap.w, h: snap.h });
                layer.text = JSON.parse(JSON.stringify(snap.text));
                layer._maskedValid = false;
                this.markLayerChanged(layer);
                this.renderLayers();
                // taken while a render was on its way (a redo copy of an edit not drawn yet): the
                // pixels are older than the description, so they are drawn from it again
                if (snap.behind) this.renderTextLayer(layer);
            } else if (snap.kind === "layerrect") {
                const target = snap.mask ? layer.maskPx : layer.px;
                // the touched rectangles are known: the display levels are refreshed there instead
                // of being rebuilt, which on a 15k layer cost the next frame 400 ms
                for (const s of snap.parts || [snap]) {
                    if (target && s.px) target.blit(s.px, s.x, s.y, "copy");
                    const rect = [s.x, s.y, s.x + s.w, s.y + s.h];
                    if (snap.mask) this.markMaskChanged(layer, rect); else this.markLayerChanged(layer, rect);
                }
                if (snap.liq) this.liquifyRestored(layer, snap);
                this.refreshLayerThumb(layer);   // nothing else in the list changed
            } else if (snap.kind === "layerfull") {
                layer.px = snap.px || this.pixels.Layer.fromImage(needImage(images.url), snap.cw, snap.ch);   // replaced: rule 2
                Object.assign(layer, { x: snap.x, y: snap.y, w: snap.w, h: snap.h });
                layer.maskPx = snap.maskPx || (snap.mask ? this.pixels.Mask.fromImage(needImage(images.mask), snap.mw, snap.mh) : null);
                snap.px = null; snap.maskPx = null;   // the document's now (C4)
                layer.maskOff = !!(snap.maskOff && layer.maskPx);
                if (!layer.maskPx) layer.maskEdit = false;
                layer.maskDirty = !!layer.maskPx;
                layer._maskedValid = false;
                layer.exportRef = null;
                this.markLayerChanged(layer);
                this.renderLayers();
            }
        }
        this.draw();
    }

    /**
     * After an undo or redo that put back layers (`layers`: the layers step's, against the `outgoing` ones it replaced) or a
     * base (`base`: a canvas or turn step's) with the files they had: those steps upload nothing again, so a file that left
     * the store since (Settings › Local files › Clean up, a file removed by hand) would be named by the next save and the
     * next start and found by neither. Each file not named by what the document held a moment ago is asked for (a HEAD
     * request, after this task), and one that is gone is uploaded again from the pixels the document holds: a layer is
     * marked for the next syncLayers (started at once), the base is uploaded here. `heldEdit()` waits for it, so a
     * document save does not name the old file. Clean up keeps what the steps hold (heldFileRefs); this is the backstop.
     */
    recheckRestoredFiles({ layers = null, outgoing = [], base = null } = {}) {
        const items = [];
        if (layers) {
            // a file the replaced layers named and had stored (clean): a dirty one's upload was still to come (a canvas or
            // turn undo marks every layer so), and it goes with the layer the step replaces
            const held = new Set();
            for (const l of outgoing || []) {
                if (l && l.ref && !l.dirty) held.add(refKey(l.ref));
                if (l && l.maskRef && !l.maskDirty) held.add(refKey(l.maskRef));
            }
            for (const l of layers) {
                if (!l) continue;
                if (l.px && l.ref && !l.dirty && !held.has(refKey(l.ref))) items.push({ layer: l, key: "ref", ref: l.ref });
                if (l.maskPx && l.maskRef && !l.maskDirty && !held.has(refKey(l.maskRef))) items.push({ layer: l, key: "maskRef", ref: l.maskRef });
            }
        }
        if (base && base.ref && base.px) items.push({ base, ref: base.ref });
        if (!items.length) return;
        const run = (this._fileCheck || Promise.resolve())
            .then(() => this.runFileChecks(items))
            .catch((err) => console.warn("Inpaint Canvas: a restored file could not be stored again", err));
        this._fileCheck = run;
        run.then(() => { if (this._fileCheck === run) this._fileCheck = null; });
    }

    /** recheckRestoredFiles' requests and uploads, one item after the other; an item changed meanwhile is left alone. */
    async runFileChecks(items) {
        let layers = false, base = false;
        // not the document's any more (another undo, a delete): the step that holds it checks again when it comes back
        const live = (it) => (it.layer ? this.layers.includes(it.layer) && it.layer[it.key] === it.ref : this.base === it.base && it.base.ref === it.ref);
        for (const it of items) {
            if (this._destroyed) return;
            if (!live(it)) continue;
            if (!(await fileGone(it.ref))) continue;
            if (this._destroyed || !live(it)) continue;
            if (it.layer) {
                // an edit since marked it already, or the next syncLayers uploads it (the PNG's hash names the file)
                if (it.key === "ref") it.layer.dirty = true; else it.layer.maskDirty = true;
                layers = true;
                console.warn("Inpaint Canvas: a restored layer's file was gone; it is stored again", it.ref.filename);
            } else {
                const { ref } = await this.uploadBase(it.base.px);
                // every step that holds this base names the new file with it (the base is never written, only replaced)
                if (it.base.ref === it.ref) { it.base.ref = ref; base = true; }
                // a run or a helper meanwhile took the base itself as its picture (no layer shown): not the gone file again
                const up = this.uploaded;
                if (up && up.baseRef && refKey(up.baseRef) === refKey(it.ref)) { up.baseRef = null; up.baseHash = null; }
                console.warn("Inpaint Canvas: the restored base's file was gone; it is stored again as", ref && ref.filename);
            }
        }
        if (this._destroyed || !(layers || base)) return;
        if (layers) await this.syncLayers();
        else this.notifyChanged();   // syncLayers ends with it
    }

    /**
     * Undo and redo run one after the other. A restore needs a PNG decode, and a second Ctrl+Z
     * (key repeat, a double click) used to take its redo copy before the first restore had
     * landed, and the decodes could land out of order: the pixels ended half undone and the redo
     * stack wrong. An operation that pushed its step and writes after an await (grow, feather,
     * invert in the worker; extend, crop, resize, merge into the base and flatten, which push
     * after their upload) is waited for first, so the undo takes back what it wrote.
     *
     * The step's images are decoded while it is still on its stack; then it is taken off, its redo
     * copy made and the restore applied in one synchronous run. An edit made while the step decoded
     * (a stroke, a marquee, a layer added, a new image: anything that moves `historyGen`) stops the
     * undo with a status line instead: it used to land first and be overwritten by the restore, or
     * be the step that was undone in place of the one Ctrl+Z was pressed for. An undo pressed while
     * a stroke or a drag is held is refused too: it took back the gesture's own step, pushed at
     * pointer down, and the finished gesture had none.
     */
    // `historyGen` is read when the key is pressed, not when the queued step runs: an edit made after
    // that stops it, and so a held Ctrl+Z that is still queued never takes back a stroke made meanwhile
    flushPendingDebounces() {
        if (this.layers) {
            for (const l of this.layers) {
                if (!l) continue;
                // the field is cleared on the layer that holds it, so a flush that returns early runs once, not on every push
                const nudge = l._flushNudge, wheel = l._flushWheel;
                if (typeof nudge === "function") { l._flushNudge = null; nudge(); }
                if (typeof wheel === "function") { l._flushWheel = null; wheel(); }
            }
        }
    }

    // a nudge or wheel burst still in its 300 ms window is a step before the key press: pushed first, then `gen` is read
    undoStep() { this.flushPendingDebounces(); this.closeFlyout(); const gen = this.historyGen; return this.queueHistory(() => this.historyStepNow(false, gen)); }

    redoStep() { this.flushPendingDebounces(); this.closeFlyout(); const gen = this.historyGen; return this.queueHistory(() => this.historyStepNow(true, gen)); }

    queueHistory(fn) {
        const prev = this._historyQueue;
        const run = prev ? prev.then(fn) : fn();   // idle: starts now, as before (nothing waits a tick)
        const settled = run.then(() => {}, () => {});
        this._historyQueue = settled;
        settled.then(() => { if (this._historyQueue === settled) this._historyQueue = null; });
        return run;
    }

    /** Keep `promise` (an edit that pushed its undo step and still writes) in front of the next undo / redo. */
    trackEdit(promise) {
        const edits = this._pendingEdits || (this._pendingEdits = new Set());
        const done = promise.then(() => {}, () => {});
        edits.add(done);
        done.then(() => edits.delete(done));
        return promise;
    }

    /** A stroke, a marquee, a move or another editing drag is held (panning and guides are not edits). */
    gestureHeld() {
        const p = this.pointer;
        return !!p && !["pan", "split", "guide"].includes(p.kind);
    }

    /** Decode the images a step carries, for `applySnapshot`. */
    async loadSnapImages(snap) {
        if (snap.kind === "canvas") {
            let selection = null;
            try { selection = await snapImage(snap.selection); } catch (_) { /* its encode failed: restored as an empty selection, as before */ }
            return { selection };
        }
        // `mask` is an image only on a "layerfull" step; on a "layerrect" step it is the flag of a mask stroke
        const maskSrc = snap.kind === "layerfull" ? snap.mask : null;
        const [url, mask] = await Promise.all([snap.url ? snapImage(snap.url) : null, maskSrc ? snapImage(maskSrc) : null]);
        return { url, mask };
    }

    async historyStepNow(redo, gen = this.historyGen) {
        const word = redo ? "redo" : "undo";
        const held = () => {
            if (!this.gestureHeld()) return false;
            this.setStatus(`Release the button first: an ${word} does not interrupt a stroke or a drag.`);
            return true;
        };
        // `gen` was taken before the wait: an edit made during it is not the step this undo was pressed for
        while (this._pendingEdits && this._pendingEdits.size) await Promise.all(Array.from(this._pendingEdits));
        if (held()) return;
        // a nudge or wheel burst begun before the key press was pushed by undoStep / redoStep before `gen` was read; one
        // begun during the wait is pushed now and, like any edit made then, stops this step (the gen check below).
        // Taking `gen` again here forgot every edit made while the wait ran, and an undo ran over them.
        this.flushPendingDebounces();
        // the stacks are looked up now, not when the step was queued: an edit or a new image replaces them
        const stack = () => (redo ? this.redo : this.undo);
        const snap = stack()[stack().length - 1];
        if (!snap) return;
        let images = {}, failed = null;
        // a layerrect step's `mask` is a flag (a mask stroke), not an image: loading it as one failed every
        // undo of a mask brush stroke with "could not load true" (c6bc6a6); on tiles a canvas step holds a
        // selection clone (`selPx`) and a whole-layer step pixels clones, neither of which is decoded
        if (snap.kind === "canvas" ? !snap.selPx : snap.kind !== "layerrect" && (snap.url || snap.mask)) {
            try { images = await this.loadSnapImages(snap); } catch (err) { failed = err; }
        }
        const now = stack();
        if (gen !== this.historyGen || now[now.length - 1] !== snap) {
            // a step an edit released (a new image, a redo after an edit) has nothing left to say
            if (now.includes(snap)) this.setStatus(`Nothing ${redo ? "redone" : "undone"}: the picture changed before the ${word} could run. Press ${redo ? "Ctrl+Shift+Z" : "Ctrl+Z"} again.`);
            return;
        }
        if (held()) return;
        // a step that changes the document's geometry (a crop, an extend, a resize, a turn, Generate new's picture) is
        // refused while a job would land in the geometry it was made for, as the crop, the resize and the turn are
        // themselves (turnBlocked): an upscale of the whole picture or a Realism Pass above 1× would otherwise land its
        // answer in a document of another size (release review 2026-10-05)
        if ((snap.kind === "canvas" || snap.kind === "turn") && this.turnBlocked()) {
            this.setStatus(`Nothing ${redo ? "redone" : "undone"}: a job still running on this document would land where the picture was. Press ${redo ? "Ctrl+Shift+Z" : "Ctrl+Z"} again when it is in.`);
            return;
        }
        if (this.pending) this.cancelPending();
        now.pop();
        if (failed) {
            // a step whose pixels could not be kept (its encode failed): said, not thrown at a key handler
            console.error(`Inpaint Canvas: ${word} step could not be restored`, failed);
            this.setStatus(`That ${word} step could not be restored: ${(failed && failed.message) || failed}`, failKind(failed));
            this.releaseSnapshot(snap);
            return;
        }
        // a preview still open is not the present (a plugin's hover over a stock, a slider not let go): its committed
        // values go back first, or the other stack's copy below keeps the preview and the redo applies it
        this.cancelPreviews();
        // the present, as the other stack's step: it keeps the step's label and time, so the list reads the same
        const current = this.snapshot(snap);
        if (current) { (redo ? this.undo : this.redo).push(current); this.undoBytes += current.bytes || 0; }
        try {
            this.applySnapshot(snap, images);
            if (snap.kind === "turn") this.setStatus(`${redo ? "Redone" : "Undone"}: ${snap.label || UNDO_LABELS.turn}.`);   // the whole document changed
        } catch (err) {
            console.error(`Inpaint Canvas: ${word} step could not be restored`, err);
            this.setStatus(`That ${word} step could not be restored: ${(err && err.message) || err}`, failKind(err));
        } finally {
            this.releaseSnapshot(snap);
            this.scheduleDetachedRelease();   // what the restore took out of the document is in the other stack now
            this.historyChanged();
        }
    }

    /**
     * Draw in a blend mode Canvas 2D has no operation for (linear light, PLAN_0_1_31 §4 step 8; PLAN_NIK9's other modes
     * would join `EMULATED_BLENDS`): `draw(c)` puts the layer alone onto a scratch of `ctx`'s canvas size, with `ctx`'s
     * transform and smoothing, at full opacity (the layer's `opacity` goes to the blend, as the worker stack takes it:
     * baked into the 8-bit scratch its rounding came out doubled by linear light's slope), then blended over the canvas: on the GPU for a screen pass (the compositor's
     * formula through runShader: a readback of the view canvas every frame would trip Chromium's acceleration latch),
     * else on the CPU through `compositeTile`, the worker stack's own kernel (the flatten, the bands, the merges). A
     * colour-matched layer drawn into the scratch finds no backdrop there: its statistics come from the sampled passes.
     *
     * `clip` (PLAN_0_1_31 §6 step 3): the coverage of a clipped layer's base (`clipCoverage`, a canvas of `ctx`'s size in
     * its pixels): the scratch keeps the layer only where the base is (`destination-in`), and then goes over the canvas
     * in any blend mode, the ones Canvas 2D has as well.
     *
     * Dissolve (`seed`, the layer's `seedOfLayer`): a pixel is kept or dropped by a hash of its image pixel, so the dots
     * stay where they are on every path. `toImage` maps the canvas's pixels to image pixels for that hash; without it
     * the inverse of `ctx`'s transform does, which is right for a canvas the image is drawn into through its transform
     * (the screen, the region pass, the flatten). A canvas whose transform does not say where its origin lies in the
     * image (a merge's union box, drawn at offsets of its own) passes the map.
     */
    blendEmulated(ctx, mode, draw, opacity = 1, clip = null, seed = null, toImage = null) {
        const cv = ctx.canvas, W = cv.width, H = cv.height;
        if (!W || !H) return;
        const screen = !!(this.viewPass && this.viewPass.screen);
        const slot = screen ? "_blendScratchGpu" : "_blendScratchCpu";
        let s = this[slot];
        if (!s || s.width !== W || s.height !== H) s = this[slot] = screen ? makeCanvas(W, H) : cpuDab(null, W, H);
        const sc = s.getContext("2d");
        sc.setTransform(1, 0, 0, 1, 0, 0);
        sc.globalAlpha = 1; sc.globalCompositeOperation = "source-over";
        sc.clearRect(0, 0, W, H);
        sc.setTransform(ctx.getTransform());
        sc.imageSmoothingEnabled = ctx.imageSmoothingEnabled;
        draw(sc);
        sc.setTransform(1, 0, 0, 1, 0, 0);
        sc.globalAlpha = 1;
        const op = mode && mode !== "normal" ? OPS[mode] : 0;
        // a clip on the screen in a mode Canvas 2D has (or in one the kernel lacks): the scratch cut to the base's coverage
        // and drawn over. Off the screen the kernel below takes the coverage as the layer's mask, as the workers do:
        // `destination-in` rounds the premultiplied scratch, which a mode's slope then magnifies (5 levels, measured)
        if (clip && !EMULATED_BLENDS.has(mode) && (screen || !(op >= 0))) {
            sc.globalCompositeOperation = "destination-in";
            sc.globalAlpha = (clip._clipAlpha ?? 255) / 255;
            sc.drawImage(clip, 0, 0);
            sc.globalAlpha = 1;
            sc.globalCompositeOperation = "source-over";
        }
        if (!EMULATED_BLENDS.has(mode) && (screen || !clip || !(op >= 0))) {
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
            ctx.globalCompositeOperation = canvasOp(mode);
            ctx.drawImage(s, 0, 0);
            ctx.restore();
            return;
        }
        if (screen && EMULATED_BLENDS.has(mode)) {
            let out = null;
            if (mode === "dissolve") {
                const inv = toImage || ctx.getTransform().inverse();
                const seedVal = seed !== null ? (seed >>> 0) : 0;
                const uniforms = {
                    u_layer: s,
                    u_alpha255: Math.round(Math.max(0, Math.min(1, opacity)) * 255),
                    u_seed_hi: (seedVal >>> 16) & 0xffff,
                    u_seed_lo: seedVal & 0xffff,
                    u_invX: [inv.a, inv.c, inv.e],
                    u_invY: [inv.b, inv.d, inv.f],
                };
                if (clip) uniforms.u_clip = clip;
                try {
                    out = clip
                        ? runShader(DISSOLVE_CLIP_SHADER, cv, uniforms)
                        : runShader(DISSOLVE_SHADER, cv, uniforms);
                } catch (err) {
                    console.warn("Inpaint Canvas: the dissolve blend shader failed, blending on the CPU:", err);
                }
            } else {
                const uMode = BLEND_OPS[mode];
                try {
                    out = clip
                        ? runShader(EMULATED_BLEND_CLIP_SHADER, cv, { u_layer: s, u_clip: clip, u_opacity: Math.max(0, Math.min(1, opacity)), u_mode: uMode })
                        : runShader(EMULATED_BLEND_SHADER, cv, { u_layer: s, u_opacity: Math.max(0, Math.min(1, opacity)), u_mode: uMode });
                } catch (err) {
                    console.warn("Inpaint Canvas: the blend shader failed, blending on the CPU:", err);
                }
            }
            if (out) {
                const img = isGLSurface(out) ? surfaceToCanvas(out) : out;
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.globalAlpha = 1;
                ctx.globalCompositeOperation = "copy";
                ctx.imageSmoothingEnabled = false;   // copy with smoothing on moves bytes (CLAUDE.md)
                ctx.drawImage(img, 0, 0);
                ctx.restore();
                return;
            }
        }
        const b = ctx.getImageData(0, 0, W, H), t = sc.getImageData(0, 0, W, H);
        let mask = null;
        if (clip) {
            const cd = clip.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, W, H).data;
            mask = new Uint8Array(W * H);
            const ca = clip._clipAlpha ?? 255;
            if (ca === 255) for (let i = 0; i < mask.length; i++) mask[i] = cd[i * 4 + 3];
            else for (let i = 0; i < mask.length; i++) { const t = cd[i * 4 + 3] * ca + 128; mask[i] = (t + (t >> 8)) >> 8; }
        }
        if (mode === "dissolve") {
            const inv = toImage || ctx.getTransform().inverse();
            const td = t.data;
            const alpha255 = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
            const seedVal = seed !== null ? (seed >>> 0) : 0;
            for (let y = 0; y < H; y++) {
                for (let x = 0; x < W; x++) {
                    const idx = (y * W + x) * 4;
                    const srcA = td[idx + 3];
                    if (srcA === 0) continue;
                    const m = mask ? mask[y * W + x] : 255;
                    const c = mul255(mul255(srcA, alpha255), m);
                    const imgX = Math.floor(inv.a * (x + 0.5) + inv.c * (y + 0.5) + inv.e);
                    const imgY = Math.floor(inv.b * (x + 0.5) + inv.d * (y + 0.5) + inv.f);
                    const keep = c === 255 || ((hash32(imgX, imgY, seedVal) >>> 24) < c);
                    if (keep) {
                        td[idx + 3] = 255;
                    } else {
                        td[idx] = 0;
                        td[idx + 1] = 0;
                        td[idx + 2] = 0;
                        td[idx + 3] = 0;
                    }
                }
            }
            compositeTile(new Uint8Array(b.data.buffer, b.data.byteOffset, W * H * 4), [new Uint8Array(td.buffer, td.byteOffset, W * H * 4)], [0], [255], [null]);
            ctx.putImageData(b, 0, 0);
            return;
        }
        compositeTile(new Uint8Array(b.data.buffer, b.data.byteOffset, W * H * 4), [new Uint8Array(t.data.buffer, t.data.byteOffset, W * H * 4)], [op], [Math.round(Math.max(0, Math.min(1, opacity)) * 255)], [mask]);
        ctx.putImageData(b, 0, 0);
    }

    /**
     * Frequency separation (PLAN_0_1_31 §4 step 8): the picture of the selection's box, or of the whole picture up to
     * 16 MP, split into two layers on top, "Low frequency" (its blur of `radius` px, normal) and above it "High frequency"
     * (the detail, in linear light), which give the picture back where it is opaque: H = floor((I - L + 255) / 2) and,
     * where I - L is odd, L one level up (at 255 one down, H one up), so that L + 2H - 255 = I exactly, on every path at
     * full opacity (8-bit linear light has no neutral grey; Photoshop's recipe loses a level on half the pixels). The
     * picture is the run's (`readBoxBytes`, without helper layers). One undo step; the high layer is made active.
     */
    async frequencySeparation({ radius = null } = {}) {
        if (!this.base) { this.setStatus("Load a picture first."); return null; }
        const b = this.getBounds();
        const box = b ? [Math.max(0, Math.floor(b[0])), Math.max(0, Math.floor(b[1])), Math.min(this.width, Math.ceil(b[2])), Math.min(this.height, Math.ceil(b[3]))] : [0, 0, this.width, this.height];
        const w = box[2] - box[0], h = box[3] - box[1];
        if (!(w > 0 && h > 0)) { this.setStatus("The selection is empty."); return null; }
        if (w * h > FREQ_MAX_PX) { this.setStatus(`Frequency separation works on up to ${Math.round(FREQ_MAX_PX / 1e6)} MP (this is ${Math.round(w * h / 1e5) / 10} MP): select the area first, a face or a patch of skin.`, "warn"); return null; }
        const r = radius > 0 ? Math.max(1, Math.min(200, Math.round(radius))) : Math.max(2, Math.round(Math.min(this.width, this.height) * 0.004));
        markStep("freqsep", "start", { w, h, radius: r });   // the K0b harness (docs/PLAN_WASM_BUILD.md §4.9): read, split (the blur in it since K27), written
        this.setStatus(`Frequency separation (${r} px) ...`);
        const src = await this.readBoxBytes(box, { forRun: true });
        const I = new Uint8ClampedArray(w * h * 4);
        I.set(src.data.subarray ? src.data.subarray(0, w * h * 4) : src.data);
        markStep("freqsep", "read");
        // the blur and the split (px/kernels.js `freqSeparate`, K26 + K27: Rust in one arena, the twins in
        // inpaint_stroke.js on the routes "js"), L and Hi copied out of wasm memory before the layers are written
        const { low: L, high: Hi } = freqSeparate(I, w, h, r);
        markStep("freqsep", "split");
        this.pushUndo({ kind: "layers", label: "Frequency separation" });
        const make = (bytes, name, blend) => {
            const px = this.pixels.Layer.empty(w, h);
            px.writeRect({ data: bytes, width: w, height: h }, 0, 0);
            const l = this.addLayer({ name, kind: "paint", px, x: box[0], y: box[1], w, h, dirty: true });
            l.blend = blend;
            this.markLayerChanged(l);
            return l;
        };
        const low = make(L, `Low frequency (${r} px)`, "normal");
        const high = make(Hi, "High frequency", "linear-light");
        markStep("freqsep", "written");
        this.activeLayerId = high.id;
        this.renderLayers();
        this.draw();
        this.setStatus(`Frequency separation: ${low.name} and ${high.name} (linear light) on top, ${w} \u00d7 ${h}. Soften colour on the low layer, retouch texture on the high one.`);
        markStep("freqsep", "done");
        return { low: low.id, high: high.id, radius: r, box };
    }

    /**
     * Image > New Dodge & Burn Layer (PLAN_0_1_31 §4 step 9): a paint layer in soft light on top, where white paint
     * lightens and black darkens. Empty unless `grey`: soft light is affine in the layer's colour on each side of 50 %
     * grey, so paint of alpha a on an empty layer gives the picture it gives on a grey one (to rounding), and an empty
     * layer holds no tiles until painted (a grey fill takes every one, about 600 MB at 15000 x 10000). `grey` fills it
     * with 128 (Photoshop's habit; 128 is neutral at any opacity, dist/map4/blend.md §4a). One undo step, made active.
     */
    dodgeBurnLayer({ grey = false } = {}) {
        if (!this.width) { this.setStatus("Load an image first."); return null; }
        this.pushUndo({ kind: "layers", label: "Dodge & burn layer" });
        const px = this.pixels.Layer.empty(this.width, this.height);
        if (grey) px.fill(null, "#808080");
        // the blend goes in with it: addLayer draws at once, and a grey layer drawn as normal covered the picture
        const l = this.addLayer({ name: "Dodge & burn", kind: "paint", px, x: 0, y: 0, w: this.width, h: this.height, dirty: true, blend: "soft-light" });
        this.markLayerChanged(l);
        this.renderLayers();
        this.draw();
        this.setStatus(`Dodge & burn layer (soft light${grey ? ", 50 % grey" : ""}) on top: paint white to lighten and black to darken at a low opacity${grey ? ", grey takes it back" : ", the eraser takes it back"}.`);
        return l;
    }

    /** The tone brush's stroke, fixed at the press: the options bar's mode and curve; `swap` (Alt) turns dodge into burn. */
    toneStroke(swap = false) {
        const o = this.toneOpts || {};
        let mode = o.mode || "dodge";
        if (swap) mode = { dodge: "burn", burn: "dodge", saturate: "desaturate", desaturate: "saturate" }[mode] || mode;
        const amount = Math.max(0, Math.min(100, +o.exposure || 0)) / 100;
        const label = mode[0].toUpperCase() + mode.slice(1);
        if (mode === "saturate" || mode === "desaturate") return { mode, label, sponge: true, amount, vibrance: o.vibrance !== false };
        return { mode, label, lut: toneLUT(o.range || "midtones", amount, mode === "burn"), protect: o.protect !== false };
    }

    /** The options bar's hint for the tone brush. */
    toneHint() {
        const m = this.toneOpts && this.toneOpts.mode;
        return m === "burn" ? "Paint over what should darken; Alt dodges"
            : m === "saturate" ? "Paint over what should gain colour; Alt desaturates"
            : m === "desaturate" ? "Paint over what should lose colour; Alt saturates"
            : "Paint over what should lighten; Alt burns";
    }

    /** A rectangle in a layer target's own pixels ([x0, y0, x1, y1]) in image coordinates; `target` is pixels or a canvas. */
    layerRectToImage(layer, target, rect) {
        const sx = layer.w / target.width, sy = layer.h / target.height;
        return [layer.x + rect[0] * sx, layer.y + rect[1] * sy, layer.x + rect[2] * sx, layer.y + rect[3] * sy];
    }

    /**
     * The composite changed because `layer`'s pixels changed inside `box` (image coordinates,
     * null for the whole layer). The colour-match statistics of every other layer are keyed
     * on the composite version and would be scanned for again on the next frame, which is a
     * readback that waits for the GPU (40 to 380 ms on a 15k document); those that the change
     * cannot have touched keep their statistics: a matched layer below the changed one (its
     * backdrop is untouched), and one whose sampling rectangle (its own rectangle plus the
     * statistics' padding) lies clear of the box.
     */
    bumpComposite(layer, box) {
        const v0 = this.compositeVersion;
        this.uploaded.baseHash = null;   // bumps compositeVersion
        const v1 = this.compositeVersion;
        if (v1 === v0) return;
        const i = this.layers.indexOf(layer);
        // a matched layer's own statistics move with any change of its pixels, and its match with them: its whole rectangle is the change
        const b = box && !this.matchActive(layer) ? box : [layer.x, layer.y, layer.x + layer.w, layer.y + layer.h];
        for (let j = 0; j < this.layers.length; j++) {
            const l = this.layers[j];
            if (l === layer || !this.matchActive(l)) continue;
            let keep = j < i;   // below the change: its backdrop did not change
            if (!keep) {
                const pad = Math.max(8, Math.max(l.w, l.h) * 0.1);   // matchStats samples 8 % around the layer
                keep = b[2] <= l.x - pad || b[0] >= l.x + l.w + pad || b[3] <= l.y - pad || b[1] >= l.y + l.h + pad;
            }
            if (!keep) continue;
            for (const slot of ["_mstats", "_mstatsSample", "_mstatsSampleRun", "_mstatsStack", "_mstatsStackRun"]) if (l[slot] && l[slot].version === v0) l[slot].version = v1;
        }
    }

    /** Upload edited layers 15 s after the last change, so a crash loses at most that much. */
    scheduleAutosave() {
        clearTimeout(this._autosave);
        this._autosave = setTimeout(() => {
            if (!this.isOpen) return;
            if (this.pointer || this.pending || this.textEdit) { this.scheduleAutosave(); return; }
            this.syncLayers().catch((err) => console.warn("Inpaint Canvas: autosave failed", err));
        }, 15000);
    }

    /** The upload cache; clearing baseHash means "the composite changed" and bumps compositeVersion. */
    makeUploaded() {
        return new UploadCache(this);
    }

    // ---- filter layers ------------------------------------------------------------

    addFilterLayer(id = "grain") {
        if (!this.width) { this.setStatus("Load an image first."); return null; }
        if (!FILTERS[id]) id = "grain";
        this.filterCounter += 1;
        const params = filterDefaults(id);
        // a colour fill starts in the paint colour, a gradient from it to transparent
        const paint = /^#[0-9a-f]{6}$/i.test(this.color || "") ? this.color.toLowerCase() : null;
        if (paint && id === "fill") params.color = paint;
        if (paint && id === "gradient") { params.from = paint; params.to = paint; params.to_opacity = 0; }
        const layer = this.addLayer({
            name: `${FILTERS[id].label} ${this.filterCounter}`, kind: "filter", filter: id, params, lut: null,
            ref: null, px: this.pixels.Layer.empty(this.width, this.height), x: 0, y: 0, w: this.width, h: this.height, dirty: false,
        });
        this.setStatus(FILTERS[id].over
            ? `${layer.name} added. It covers everything below it; set the colour in the layer list, the blend mode, the opacity or a mask to let the picture through.`
            : `${layer.name} added. It filters everything below it; pick the type and drag the sliders in the layer list.`);
        if (id === "relight") {
            const relightConf = host.getRelightSettings ? host.getRelightSettings() : null;
            params.route = "app";
            if (relightConf) {
                if (relightConf.strength !== undefined) params.strength = relightConf.strength;
                if (relightConf.style !== undefined) params.style = relightConf.style;
                if (relightConf.preserve_details !== undefined) params.preserve_details = relightConf.preserve_details;
                if (relightConf.interpolate !== undefined) params.interpolate = relightConf.interpolate;
                if (relightConf.detail !== undefined) params.detail = relightConf.detail;
                if (relightConf.enable_hr_fix !== undefined) params.enable_hr_fix = relightConf.enable_hr_fix;
                if (relightConf.light_type !== undefined) params.light_type = relightConf.light_type;
                if (relightConf.lora_strength !== undefined) params.lora_strength = relightConf.lora_strength;
                if (relightConf.steps !== undefined) params.steps = relightConf.steps;
            }
            this.setTool("lights");
            const hasDepth = !!(this.maps && this.maps.depth && (this.maps.depth.data || this.maps.depth.u16));
            if (!hasDepth && this.ensureDepthMap) {
                this.ensureDepthMap().catch(() => {});
            }
        }
        return layer;
    }

    setFilterType(layer, id) {
        if (!FILTERS[id] || layer.filter === id) return;
        this.pushUndo({ kind: "filter", id: layer.id, label: "Filter type" });
        // a fill switched to a gradient keeps its colour (to transparent) and back; other types start in the paint colour
        const was = layer.filter, prev = layer.params || {};
        const hex = (c) => (/^#[0-9a-f]{6}$/i.test(c || "") ? c.toLowerCase() : null);
        const seed = was === "fill" ? hex(prev.color) : was === "gradient" ? hex(prev.from) : hex(this.color);
        layer.filter = id;
        layer.params = filterDefaults(id);
        if (id === "relight") {
            const relightConf = host.getRelightSettings ? host.getRelightSettings() : null;
            layer.params.route = "app";
            if (relightConf) {
                if (relightConf.strength !== undefined) layer.params.strength = relightConf.strength;
                if (relightConf.style !== undefined) layer.params.style = relightConf.style;
                if (relightConf.preserve_details !== undefined) layer.params.preserve_details = relightConf.preserve_details;
                if (relightConf.interpolate !== undefined) layer.params.interpolate = relightConf.interpolate;
                if (relightConf.detail !== undefined) layer.params.detail = relightConf.detail;
                if (relightConf.enable_hr_fix !== undefined) layer.params.enable_hr_fix = relightConf.enable_hr_fix;
                if (relightConf.light_type !== undefined) layer.params.light_type = relightConf.light_type;
                if (relightConf.lora_strength !== undefined) layer.params.lora_strength = relightConf.lora_strength;
                if (relightConf.steps !== undefined) layer.params.steps = relightConf.steps;
            }
            this.setTool("lights");
            const hasDepth = !!(this.maps && this.maps.depth && (this.maps.depth.data || this.maps.depth.u16));
            if (!hasDepth && this.ensureDepthMap) {
                this.ensureDepthMap().catch(() => {});
            }
        }
        if (prev.limit) {
            layer.params.limit = { ...prev.limit };
            if (FILTERS[id] && FILTERS[id].over && layer.params.limit.source !== "depth") {
                delete layer.params.limit;
                this.setStatus("Fill layers take a depth limit only: non-depth limit dropped.", "warn");
            }
        }
        if (seed && id === "fill") layer.params.color = seed;
        if (seed && id === "gradient") { layer.params.from = seed; layer.params.to = seed; layer.params.to_opacity = 0; }
        // layer names are not editable: the type (or a preset, see the preset select) names the layer
        layer.name = `${FILTERS[id].label} ${this.filterCounter}`;
        if (id === "relight") {
            this.setTool("lights");
        }
        this.markFilterChanged(layer);
        this.renderLayers();
    }

    /** A fill layer (PLAN_0_1_31 §6 step 6): a filter layer whose type gives pixels of its own (`over`: a colour, a gradient). */
    isFillLayer(l) {
        return !!(l && l.kind === "filter" && FILTERS[l.filter] && FILTERS[l.filter].over);
    }

    /** A fill layer's pixels at the picture's size as a canvas (the PSD / ORA layer), with its live mask baked in when `bake`. */
    fillLayerCanvas(l, bake) {
        const W = this.width, H = this.height;
        const c = makeCanvas(W, H), ctx = c.getContext("2d");
        const rows = fillPixels(l.filter, l.params || {}, [W, H], [0, 0], W, H);
        if (l.params && l.params.limit) {
            limitAlphaRows(rows, 0, 0, W, H, l.params.limit, this.maps && this.maps.depth);
        }
        ctx.putImageData(new ImageData(rows, W, H), 0, 0);
        const m = bake ? this.liveMask(l) : null;
        if (m) { ctx.globalCompositeOperation = "destination-in"; m.drawTo(ctx, 0, 0, W, H); ctx.globalCompositeOperation = "source-over"; }
        return c;
    }

    /** `exportLayerSources`' `open` of a fill layer: its rows as `fillPixels` makes them, band by band; drawn once into a canvas when its live mask is to be baked (ORA). */
    fillLayerRows(l, bake) {
        const W = this.width, H = this.height, id = l.filter, p = JSON.parse(JSON.stringify(l.params || {}));
        if (bake && this.liveMask(l)) return () => { const c = this.fillLayerCanvas(l, true); return { source: canvasRows(c), close() { c.width = 1; c.height = 1; } }; };
        const depthMap = this.maps && this.maps.depth;
        return () => ({ source: bandRows(W, H, (y0, y1) => {
            const rows = fillPixels(id, p, [W, H], [0, y0], W, y1 - y0);
            if (p.limit) limitAlphaRows(rows, 0, y0, W, y1 - y0, p.limit, depthMap);
            return rows;
        }), close() {} });
    }

    markFilterChanged(layer, { soon = false } = {}) {
        this.sceneSig = null;
        layer._fcache = null;
        layer._fcacheView = null; layer._fcacheSample = null; layer._fxCacheSample = null;
        this.uploaded.baseHash = null;
        if (layer && layer.kind === "filter" && layer.filter === "relight") {
            this.ensureRelightMaps(layer, { quick: this.filterPreview === layer.id });
        }
        if (this.isFillLayer(layer)) this.redrawThumbsOf(layer);   // a fill layer's row shows its fill
        if (soon) { this.drawSoon(); return; }   // slider drag: one draw per frame, thumbnail and save on release
        this.draw();
        this.drawThumb();
        this.notifyChanged();
    }

    async loadLutFile(layer, file) {
        if (!file) return;
        try {
            this.setStatus(`Reading ${file.name} ...`);
            const lut = lutFromCube(await file.text());
            const up = await uploadCanvas(lutToCanvas(lut), `n${this.node.id}_lut`);
            this.pushUndo({ kind: "filter", id: layer.id, label: "Load LUT" });
            layer.lut = { name: file.name, size: lut.size, ref: up.ref };
            layer._lutData = lut;
            if (/^LUT/.test(layer.name || "") || !layer.name) layer.name = file.name.replace(/\.cube$/i, "");
            this.markFilterChanged(layer);
            this.renderLayers();
            this.setStatus(`${file.name} loaded (${lut.size}³ LUT).`);
        } catch (err) {
            console.error(err);
            this.setStatus("Could not load the LUT: " + (err.message || err), failKind(err));
        }
    }

    async loadPlateFile(layer, file) {
        if (!file) return;
        try {
            this.setStatus(`Uploading ${file.name} ...`);
            const ext = ((file.name || "").match(/\.[a-z0-9]+$/i) || [".png"])[0];
            const stem = (file.name || "plate").replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]/gi, "_") || "plate";
            const ref = await uploadBlob(file, stem + ext, { overwrite: false });
            const img = await loadImageEl(viewUrl(ref));
            const st = plateStats(img);
            this.pushUndo({ kind: "filter", id: layer.id, label: "Load grain plate" });
            layer.plate = { name: file.name, ref, w: img.naturalWidth, h: img.naturalHeight, mean: Math.round(st.mean * 10) / 10, std: Math.round(st.std * 10) / 10 };
            layer._plateImg = img;
            this.markFilterChanged(layer);
            this.renderLayers();
            this.setStatus(`${file.name} loaded as grain plate (${img.naturalWidth} × ${img.naturalHeight}, mean ${layer.plate.mean}, noise ${layer.plate.std}).`);
        } catch (err) {
            console.error(err);
            this.setStatus("Could not load the plate: " + (err.message || err), failKind(err));
        }
    }

    removePlate(layer) {
        if (!layer.plate) return;
        this.pushUndo({ kind: "filter", id: layer.id, label: "Remove grain plate" });
        layer.plate = null;
        layer._plateImg = null;
        this.markFilterChanged(layer);
        this.renderLayers();
        this.setStatus(`${layer.name}: back to synthetic grain.`);
    }

    /**
     * Cache key for a filtered canvas pass. Centralises key generation so call sites and future
     * map dependencies stay in sync. Produces the legacy string for layers without limit or maps.
     */
    filterKey(layer, below, forRun, preview, vp = this.viewPass, plain = false) {
        const baseKey = [
            layer.filter,
            layer.params,
            layer.lut && layer.lut.ref && layer.lut.ref.filename,
            layer.plate && layer.plate.ref && layer.plate.ref.filename,
            !!forRun,
            !!preview,
            vp && vp.crop ? vp.crop.bw : below.width,
            vp && vp.crop ? vp.crop.bh : below.height,
            vp ? [vp.x, vp.y, vp.w, vp.h, vp.sx, vp.sy, !!(vp.screen || vp.display)] : 0,
        ];
        const readsMap = typeof this.mapsOf === "function" ? this.mapsOf(layer).length > 0 : (layer.params && layer.params.limit && (layer.params.limit.source === "depth" || layer.params.limit.source === "map"));
        if (readsMap) {
            baseKey.push(this.mapsVersion || 0);
        }
        const isEffectView = this.effectViewOf(layer, forRun);
        if (isEffectView) baseKey.push(true);
        if (layer.params && layer.params.limit) baseKey.push(!!plain);
        return JSON.stringify(baseKey);
    }

    /**
     * @typedef {{ scale: number, origin: number[], full: number[], forRun?: boolean, cache?: object, chain?: boolean|"bands", site?: string }} FilterPass
     *
     * Build the context object handed to `applyFilter` for both filteredCanvas and bandFilter.
     * @param {any} layer
     * @param {FilterPass} pass
     */
    filterInfo(layer, pass) {
        const def = FILTERS[layer.filter];
        const stats = def && def.wholeStats ? this.belowStats(layer, pass.forRun) : null;
        const info = {
            scale: pass.scale,
            origin: pass.origin,
            full: pass.full,
            stats,
            wholeStats: stats,
            seed: layer.id,
            lut: layer._lutData,
            plate: layer._plateImg || null,
            plateKey: layer.plate && layer.plate.ref && layer.plate.ref.filename,
            plateMean: layer.plate && layer.plate.mean,
            plateStd: layer.plate && layer.plate.std,
            cache: pass.cache,
            chain: pass.chain,
            maps: this.maps || null,
        };
        if (this.effectViewOf(layer, pass.forRun)) {
            info.limitView = true;
        }
        if (pass.site) {
            if (!this._lastFilterInfoBySite) this._lastFilterInfoBySite = {};
            this._lastFilterInfoBySite[pass.site] = info;
        }
        if (layer.filter === "relight") {
            info.layer = layer;
            info.relight = layer._relight;
            info.forRun = !!pass.forRun;   // pickVis: a run never reads the quick shadow map
            info.quick = !pass.forRun && this.filterPreview === layer.id;
            this.ensureRelightMaps(layer, { quick: info.quick });
        }
        if (this._filterInfoHook) this._filterInfoHook(info, layer, pass);
        return info;
    }

    /**
     * Crop `below` (a region-pass canvas that reaches past the document) to the document's pixel box `[bx0, by0, bw, bh]`,
     * clamping any 1-pixel fractional rim from the strictly-inside box `[ix0, iy0, iw, ih]` so a filter that samples
     * neighbours never reads the empty margin or a subpixel edge pixel.
     */
    cropFilterInput(below, { bx0, by0, bw, bh, ix0, iy0, iw, ih }) {
        const doc = makeCanvas(bw, bh);
        const dctx = doc.getContext("2d");
        dctx.imageSmoothingEnabled = false;
        if (iw > 0 && ih > 0) {
            const ox = ix0 - bx0, oy = iy0 - by0;
            dctx.drawImage(below, ix0, iy0, iw, ih, ox, oy, iw, ih);
            if (ox > 0) dctx.drawImage(doc, ox, oy, 1, ih, 0, oy, ox, ih);
            if (bw > ox + iw) dctx.drawImage(doc, ox + iw - 1, oy, 1, ih, ox + iw, oy, bw - ox - iw, ih);
            if (oy > 0) dctx.drawImage(doc, 0, oy, bw, 1, 0, 0, bw, oy);
            if (bh > oy + ih) dctx.drawImage(doc, 0, oy + ih - 1, bw, 1, 0, oy + ih, bw, bh - oy - ih);
        } else {
            dctx.drawImage(below, bx0, by0, bw, bh, 0, 0, bw, bh);
        }
        return doc;
    }

    /**
     * Filtered copy of `below` for a filter layer, cached until the composite or the parameters
     * change. `below` is the composite so far: a canvas, or the GPU surface the filter layer
     * before this one left behind. With `keepSurface` the result stays a surface for the next
     * filter layer and is not cached; without it the surface is read back into a canvas. The
     * stages inside one filter (the film look is colour, halation and grain) always chain on
     * the GPU, which is where most of the canvas round trips were.
     */
    filteredCanvas(layer, below, forRun, preview, keepSurface = false, plain = keepSurface) {
        const vp = this.viewPass;
        const key = this.filterKey(layer, below, forRun, preview, vp, plain);
        const slot = vp ? (vp.sample ? "_fcacheSample" : "_fcacheView") : "_fcache";
        const c = layer[slot];
        if (!keepSurface && c && c.version === this.compositeVersion && c.key === key) return c.canvas;
        let input = below, scale = vp ? vp.sx : 1;
        if (vp && vp.crop && !isGLSurface(below)) {
            input = this.cropFilterInput(below, vp.crop);
        } else if (preview) {
            const s = Math.min(1, 1024 / Math.max(below.width, below.height));
            if (s < 1) {
                input = makeCanvas(Math.round(below.width * s), Math.round(below.height * s));
                const ictx = input.getContext("2d");
                ictx.imageSmoothingEnabled = true;
                ictx.drawImage(below, 0, 0, input.width, input.height);
                scale = s;
            }
        }
        let canvas = null;
        const fxSlot = vp ? (vp.sample ? "_fxCacheSample" : "_fxCacheView") : "_fxCache";
        if (!layer[fxSlot]) layer[fxSlot] = {};
        // where the input sits in the image, in its own pixels: filters with a field of
        // their own (grain) anchor it there instead of at the corner of the preview
        const origin = vp ? [vp.x * vp.sx, vp.y * vp.sy] : [0, 0];
        // E3: the whole picture in the input's pixels, for a filter whose geometry belongs to the picture (a vignette, a
        // frame), and the whole picture's statistics for one that reads them (normalise): a pass composites a part
        const full = vp ? [this.width * vp.sx, this.height * vp.sy] : [input.width, input.height];
        const chain = !this.filterChainOff && glChainUsable(input.width, input.height);   // filterChainOff: the Canvas 2D path, for composite_test
        const info = this.filterInfo(layer, {
            scale,
            origin,
            full,
            forRun: !!forRun,
            cache: layer[fxSlot],
            chain,
            site: "filteredCanvas",
        });
        // A limit's weight goes into the result's alpha whenever the result is drawn over the picture (a
        // blend mode, an opacity, a mask, or a clip): where the limit is 0 the layer then shows nothing,
        // like its painted mask. A plain filter layer stands for the picture (whether it stays a surface
        // for the next filter layer or replaces the canvas below it) and mixes the input back in instead.
        info.limitOver = !plain;
        beginScope();
        try { canvas = applyFilter(layer.filter, input, layer.params, info); }
        catch (err) { console.error(err); }
        canvas = endScope(canvas);
        // A depth limit without a map: the layer shows nothing (the limit stage hands the input back and
        // says so; the Limit row reads the flag). Drawn over the picture that is nothing; only as the
        // chain's surface it is the picture.
        layer.limitMissing = !!info.limitMissing;
        if (info.limitMissing && canvas === input && !(keepSurface && isGLSurface(canvas))) canvas = null;
        if (isGLSurface(canvas)) {
            if (keepSurface) return canvas;                    // the next filter layer reads the texture
            const flat = surfaceToCanvas(canvas);
            if (canvas !== input) releaseSurface(canvas);      // a filter that did nothing hands its input back
            canvas = flat;
        }
        layer[slot] = { version: this.compositeVersion, key, canvas };
        return canvas;
    }

    /**
     * `colourStats` or custom `wholeStats` of the whole picture below a filter layer (E3, F10):
     * from a sampled pass of the layers below it (size chosen by def.wholeStatsSize, 64..1024, default 256),
     * kept while the picture below (`belowSignature`) and the parameters the statistics read stay the same: a custom
     * `wholeStats` reads the ones `wholeStatsParams` names (relight's fit: depth_scale and sigma), or all of them.
     * Keyed on `compositeVersion` before (F2.6), which every slider and light drag of the layer itself bumps: a drag of
     * ten moves read the picture below back 22 times.
     */
    belowStats(layer, forRun) {
        if (!layer || !this.layers || !this.width || !this.height) return null;
        const def = FILTERS[layer.filter];
        const n = Math.max(64, Math.min(1024, (def && def.wholeStatsSize) || 256));
        const params = layer.params || {};
        const reads = !def || typeof def.wholeStats !== "function" ? ""
            : Array.isArray(def.wholeStatsParams) ? JSON.stringify(def.wholeStatsParams.map((k) => params[k] ?? null)) : JSON.stringify(params);
        const vKey = `${this.belowSignature(layer)}#${reads}#${n}#${this.mapsOf(layer).length ? this.mapsVersion || 0 : 0}`;
        const slot = forRun ? "_bstatsRun" : "_bstats";
        const c = layer[slot];
        if (c && c.version === vKey) return c.stats;
        const index = this.layers.indexOf(layer);
        const s = Math.min(1, n / Math.max(this.width, this.height));
        const entry = { version: vKey, stats: null };
        layer[slot] = entry;
        const small = this.sampleRegion("image", [0, 0, this.width, this.height], s, { forRun: !!forRun, upTo: Math.max(0, index) });
        if (def && typeof def.wholeStats === "function") {
            try {
                entry.stats = def.wholeStats(small, { width: this.width, height: this.height }, { maps: this.maps || {}, sampleMap, layer, params: layer?.params });
            } catch (err) {
                console.warn(`filter ${def.label || layer.filter} wholeStats failed:`, err);
                if (host.pluginReport && def.plugin) host.pluginReport(def.plugin, `filter ${layer.filter} wholeStats`, err);
                entry.stats = null;
            }
        } else {
            entry.stats = colourStats(small);
        }
        return entry.stats;
    }

    /**
     * What the picture below `layer` is made of, as a string (F2.6): the base and every layer below it as the composite
     * reads them - each pixel source by identity and version (every write reaches the display through `touchSource` /
     * `touchSourceRect`, whose `touch()` moves the source's version on both backends), place, size, visibility (groups
     * included), opacity, blend, clip, mask, colour match, role, a filter's parameters, LUT and plate, and a relight
     * layer's shadow and normal maps (they land after its parameters change), the maps for a layer below that reads
     * them - and the compare side shown and a filter preview of another layer. A change of the layer's own parameters or
     * of a layer above it leaves it as it is, and so does a brush dab anywhere above (the document-wide `pixelVersion`
     * is not in it: it moves with every dab). `belowStats` adds the maps when the layer itself reads them.
     * @param {any} layer
     */
    belowSignature(layer) {
        const index = this.layers.indexOf(layer);
        const parts = [this.width, this.height, sourceTag(this.basePx),
            this.compareShow || "", this.filterPreview && this.filterPreview !== layer.id ? this.filterPreview : ""];
        for (const g of this.groups || []) parts.push(g.id, g.parent || "", g.visible === false ? 0 : 1);
        for (let i = 0; i < index; i++) {
            const l = this.layers[i];
            let filter = "";
            if (l.kind === "filter") {
                filter = `${l.filter}${JSON.stringify(l.params || {})}${sourceTag(l._lutData)}${sourceTag(l._plateImg)}`;
                const r = l.filter === "relight" ? l._relight : null;
                if (r) filter += `:${r.seq || 0}:${r.visQuick ? r.visQuick.seq || 0 : "-"}:${(r.normals && r.normals.key) || ""}`;
                if (this.mapsOf(l).length) filter += `@${this.mapsVersion || 0}`;
            }
            parts.push(l.id, l.kind, l.role || "", this.shown(l) ? 1 : 0, l.opacity, l.blend || "", l.clip ? 1 : 0, l.group || "",
                l.x, l.y, l.w, l.h, sourceTag(l.px), sourceTag(l.maskPx), l.maskOff ? 1 : 0,
                l.match ? `${l.match.strength}:${l.match.source}` : "", filter);
        }
        return parts.join("|");
    }

    /**
     * `colourStats` below a filter layer, used as fallback for histogram / color sample when a filter defines custom `wholeStats`.
     */
    belowColourStats(layer, forRun = false) {
        if (!layer || !this.layers || !this.width || !this.height) return null;
        const slot = forRun ? "_bcstatsRun" : "_bcstats";
        const c = layer[slot];
        if (c && c.version === this.compositeVersion) return c.stats;
        const index = this.layers.indexOf(layer);
        const s = Math.min(1, 256 / Math.max(this.width, this.height));
        const small = this.sampleRegion("image", [0, 0, this.width, this.height], s, { forRun: !!forRun, upTo: Math.max(0, index) });
        const entry = { version: this.compositeVersion, stats: colourStats(small) };
        layer[slot] = entry;
        return entry.stats;
    }

    /**
     * The histogram `{ r, g, b, luma }` of the composite below a filter layer (R1-S4).
     */
    belowHistogram(layer, forRun = false) {
        const st = this.belowStats(layer, forRun);
        if (st && st.hist) return st.hist;
        const cs = this.belowColourStats(layer, forRun);
        return (cs && cs.hist) || null;
    }

    /**
     * The 256 px RGBA sample `{ bytes, w, h }` below a filter layer (R1-S4).
     */
    belowSample(layer, forRun = false) {
        const st = this.belowStats(layer, forRun);
        if (st && st.bytes) return { bytes: st.bytes, w: st.w, h: st.h };
        const cs = this.belowColourStats(layer, forRun);
        return (cs && cs.bytes) ? { bytes: cs.bytes, w: cs.w, h: cs.h } : null;
    }

    /**
     * `colourStats` of the whole picture, sampled at up to 256 px on the long side (R1-S4).
     * Cached per `compositeVersion` in `_picStats` or `_picStatsRun`.
     */
    pictureStats(forRun = true) {
        if (!this.width || !this.height) return null;
        const slot = forRun ? "_picStatsRun" : "_picStats";
        const c = this[slot];
        if (c && c.version === this.compositeVersion) return c.stats;
        const s = Math.min(1, 256 / Math.max(this.width, this.height));
        const entry = { version: this.compositeVersion, stats: null };
        this[slot] = entry;
        const upTo = this.layers ? this.layers.length : 0;
        const small = this.sampleRegion("image", [0, 0, this.width, this.height], s, { forRun: !!forRun, upTo });
        entry.stats = colourStats(small);
        return entry.stats;
    }

    /**
     * The whole picture's histogram `{ r, g, b, luma }` from a 256 px sample (R1-S4).
     */
    pictureHistogram(forRun = true) {
        const st = this.pictureStats(forRun);
        return (st && st.hist) || null;
    }

    /**
     * The whole picture's 256 px RGBA sample `{ bytes, w, h }` (R1-S4).
     */
    pictureSample(forRun = true) {
        const st = this.pictureStats(forRun);
        return (st && st.bytes) ? { bytes: st.bytes, w: st.w, h: st.h } : null;
    }

    /**
     * 256-bin histogram of a feature map (depth `u16 >> 8`, etc.), cached by hash / dataVersion (R1-S4).
     */
    mapHistogram(kind) {
        if (kind === "depth") {
            // The map store's entry keeps its bytes in `data`; the `depth` getter presents them as `u16`.
            const depth = this.depth;
            if (!depth || !depth.u16) return null;
            if (!this._mapHistCache) this._mapHistCache = new Map();
            const key = `depth:${depth.hash ?? depth.dataVersion ?? depth.version ?? "default"}`;
            if (this._mapHistCache.has(key)) return this._mapHistCache.get(key);
            if (this._mapHistCache.size >= 8) this._mapHistCache.clear();   // a few versions, not every recompute
            const u16 = depth.u16;
            const hist = new Float64Array(256);
            for (let i = 0; i < u16.length; i++) hist[u16[i] >> 8]++;
            this._mapHistCache.set(key, hist);
            return hist;
        }
        if (this.maps && this.maps[kind]) {
            const map = this.maps[kind];
            if (!this._mapHistCache) this._mapHistCache = new Map();
            const key = `${kind}:${map.hash ?? map.dataVersion ?? map.version ?? "default"}`;
            if (this._mapHistCache.has(key)) return this._mapHistCache.get(key);
            if (map.u16) {
                const hist = new Float64Array(256);
                for (let i = 0; i < map.u16.length; i++) hist[map.u16[i] >> 8]++;
                this._mapHistCache.set(key, hist);
                return hist;
            }
            if (map.u8) {
                const hist = new Float64Array(256);
                for (let i = 0; i < map.u8.length; i++) hist[map.u8[i]]++;
                this._mapHistCache.set(key, hist);
                return hist;
            }
        }
        return null;
    }

    /**
     * 256-bin histogram of colour similarity over a 256 px sample (R1-S6 / R1-S8).
     * Cached per (compositeVersion, color, tol).
     * @param {Object} limit - Range limit containing { color, tol }
     * @param {Object} [sample] - Optional custom sample { bytes, w, h }
     * @returns {Float64Array | null}
     */
    similarityHistogram(limit, sample = null) {
        if (!limit) return null;
        const color = limit.color || "#ffffff";
        const tol = limit.tol ?? 30;
        const samp = sample || this.pictureSample();
        if (!samp || !samp.bytes) return null;
        let key = null;
        if (!sample) {
            if (!this._simHistCache) this._simHistCache = new Map();
            key = `${this.compositeVersion}:${color}:${tol}`;
            if (this._simHistCache.has(key)) return this._simHistCache.get(key);
        }
        const rgbRef = hexToRgb01(color);
        const colorRef = opp(rgbRef[0], rgbRef[1], rgbRef[2]);
        const px = samp.bytes;
        const hist = new Float64Array(256);
        for (let i = 0; i < px.length; i += 4) {
            const a = px[i + 3] / 255;
            if (!a) continue;
            const sim = colourSimilarity(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255, colorRef, tol);
            const bin = Math.min(255, Math.max(0, Math.floor(sim * 256)));
            hist[bin] += a;
        }
        if (!sample && key) {
            this._simHistCache.set(key, hist);
        }
        return hist;
    }

    /**
     * Samples the depth map at image coordinates (ix, iy), returning a value in 0..1 (R1-S6).
     * @param {number} ix
     * @param {number} iy
     * @returns {number}
     */
    depthAt(ix, iy) {
        const map = (this.maps && this.maps.depth) || this.depth;
        if (!map) return 0;
        const data = map.u16 || map.data;
        if (!data || !map.w || !map.h) return 0;
        if (map.xf) {
            const m = passToMap(map, 1);
            const pxCentre = ix + 0.5;
            const pyCentre = iy + 0.5;
            const mx = m[0] * pxCentre + m[2] * pyCentre + m[4];
            const my = m[1] * pxCentre + m[3] * pyCentre + m[5];
            return u16Bilinear(data, map.w, map.h, mx, my);
        }
        const mx = (ix / (this.width || 1)) * map.w;
        const my = (iy / (this.height || 1)) * map.h;
        return u16Bilinear(data, map.w, map.h, mx, my);
    }

    /**
     * Greyscale canvas proxy of a feature map downsampled to <= maxSize on long side (R1-S6).
     * Cached per dataVersion.
     */
    depthProxy(map, maxSize = 2048) {
        if (!map) return null;
        const key = `${maxSize}:${map.dataVersion ?? map.version ?? 1}`;
        if (!this._depthProxies) this._depthProxies = new Map();
        if (this._depthProxies.has(key)) return this._depthProxies.get(key);

        const data = map.u16 || map.data;
        if (!data || !map.w || !map.h) return null;
        const dw = map.w, dh = map.h;
        const maxSide = Math.max(dw, dh);
        const scale = maxSide > maxSize ? maxSize / maxSide : 1;
        const pw = Math.max(1, Math.round(dw * scale));
        const ph = Math.max(1, Math.round(dh * scale));

        const c = document.createElement("canvas");
        c.width = pw; c.height = ph;
        const ctx = c.getContext("2d");
        const idata = ctx.createImageData(pw, ph);
        const d32 = idata.data;

        for (let y = 0; y < ph; y++) {
            const sy = Math.min(dh - 1, Math.floor(y / scale));
            const yOffset = sy * dw;
            const rowOffset = y * pw * 4;
            for (let x = 0; x < pw; x++) {
                const sx = Math.min(dw - 1, Math.floor(x / scale));
                const v = (data[yOffset + sx] >> 8) & 0xff;
                const idx = rowOffset + x * 4;
                d32[idx] = v;
                d32[idx + 1] = v;
                d32[idx + 2] = v;
                d32[idx + 3] = 255;
            }
        }
        ctx.putImageData(idata, 0, 0);
        this._depthProxies.set(key, c);
        return c;
    }

    depthProxy2048(map) {
        return this.depthProxy(map, 2048);
    }

    depthProxy1024(map) {
        return this.depthProxy(map, 1024);
    }

    depthProxy1024Data(map) {
        if (!map) return null;
        const key = `data1024:${map.dataVersion ?? map.version ?? 1}`;
        if (!this._depthProxies) this._depthProxies = new Map();
        if (this._depthProxies.has(key)) return this._depthProxies.get(key);

        const data = map.u16 || map.data;
        if (!data || !map.w || !map.h) return null;
        const dw = map.w, dh = map.h;
        const maxSide = Math.max(dw, dh);
        const scale = maxSide > 1024 ? 1024 / maxSide : 1;
        const pw = Math.max(1, Math.round(dw * scale));
        const ph = Math.max(1, Math.round(dh * scale));
        const vals = new Float32Array(pw * ph);

        for (let y = 0; y < ph; y++) {
            const sy = Math.min(dh - 1, Math.floor(y / scale));
            const yOffset = sy * dw;
            const rowOffset = y * pw;
            for (let x = 0; x < pw; x++) {
                const sx = Math.min(dw - 1, Math.floor(x / scale));
                vals[rowOffset + x] = data[yOffset + sx] / 65535;
            }
        }
        const res = { vals, w: pw, h: ph };
        this._depthProxies.set(key, res);
        return res;
    }

    /**
     * Sets or clears live red preview tint for range selection (R1-S6).
     * Builds this._rangeTint and calls drawSoon().
     * @param {Object | null} limit
     */
    setRangePreview(limit) {
        if (!limit) {
            this._rangeTint = null;
            this.drawSoon();
            return;
        }

        if (limit.source === "depth") {
            const map = (this.maps && this.maps.depth) || this.depth;
            if (!map) {
                this._rangeTint = null;
                this.drawSoon();
                return;
            }
            const pdata = this.depthProxy1024Data(map);
            if (!pdata) {
                this._rangeTint = null;
                this.drawSoon();
                return;
            }
            const { vals, w, h } = pdata;

            if (!this._depthTintCanvas || this._depthTintCanvas.width !== w || this._depthTintCanvas.height !== h) {
                this._depthTintCanvas = document.createElement("canvas");
                this._depthTintCanvas.width = w;
                this._depthTintCanvas.height = h;
                this._depthTintCtx = this._depthTintCanvas.getContext("2d");
                this._depthTintImg = this._depthTintCtx.createImageData(w, h);
            }
            const imgData = this._depthTintImg;
            const d32 = imgData.data;
            const n = w * h;
            for (let i = 0, j = 0; i < n; i++, j += 4) {
                const wt = rangeWeight(vals[i], limit);
                d32[j] = 255;
                d32[j + 1] = 0;
                d32[j + 2] = 0;
                d32[j + 3] = Math.round(wt * 255);
            }
            this._depthTintCtx.putImageData(imgData, 0, 0);
            this._rangeTint = {
                canvas: this._depthTintCanvas,
                xf: map.xf || [this.width, 0, 0, this.height, 0, 0],
            };
            this.drawSoon();
            return;
        }

        // luma or color
        const vr = this.viewportRegion();
        const box = vr ? [Math.max(0, vr.x), Math.max(0, vr.y), Math.min(this.width, vr.x + vr.w), Math.min(this.height, vr.y + vr.h)] : [0, 0, this.width, this.height];
        const bw = box[2] - box[0], bh = box[3] - box[1];
        if (bw <= 0 || bh <= 0) {
            this._rangeTint = null;
            this.drawSoon();
            return;
        }
        const scale = vr ? vr.scale : Math.min(1, 1024 / Math.max(this.width, this.height));
        const boxKey = `${box[0]},${box[1]},${box[2]},${box[3]}`;
        const cacheKey = `${this.compositeVersion}:${boxKey}:${scale}`;

        if (!this._rangeSampleCache || this._rangeSampleCache.key !== cacheKey) {
            const sampleCanvas = this.sampleRegion("image", box, scale, { forRun: true });
            const sctx = sampleCanvas.getContext("2d", { willReadFrequently: true });
            const imgData = sctx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);
            this._rangeSampleCache = {
                key: cacheKey,
                version: this.compositeVersion,
                canvas: sampleCanvas,
                imgData,
                box,
                scale,
                w: sampleCanvas.width,
                h: sampleCanvas.height,
            };
        }

        const cached = this._rangeSampleCache;
        const cw = cached.w, ch = cached.h;

        let tintOut = null;
        let colorRef = [0, 0, 0], colorTol = limit.tol ?? 30;
        if (limit.source === "color") {
            const rgbRef = hexToRgb01(limit.color || "#ffffff");
            colorRef = opp(rgbRef[0], rgbRef[1], rgbRef[2]);
        }
        const rVec = [limit.lo ?? 0, limit.hi ?? 1, limit.fLo ?? 0, limit.fHi ?? 0];
        try {
            const uniforms = {
                u_source: limit.source === "color" ? 2 : 1,
                u_range: rVec,
                u_invert: limit.invert ? 1 : 0,
                u_ref: colorRef,
                u_tol: colorTol,
            };
            const shRes = runShader(RANGE_PREVIEW_SHADER, cached.canvas, uniforms);
            if (shRes) {
                tintOut = glToCanvas(shRes);
            }
        } catch (_) {
            tintOut = null;
        }

        if (!tintOut) {
            if (!this._tintCpuCanvas || this._tintCpuCanvas.width !== cw || this._tintCpuCanvas.height !== ch) {
                this._tintCpuCanvas = document.createElement("canvas");
                this._tintCpuCanvas.width = cw;
                this._tintCpuCanvas.height = ch;
                this._tintCpuCtx = this._tintCpuCanvas.getContext("2d");
                this._tintCpuImg = this._tintCpuCtx.createImageData(cw, ch);
            }
            const srcData = cached.imgData.data;
            const outImg = this._tintCpuImg;
            const outData = outImg.data;
            const isLuma = limit.source === "luma";
            for (let i = 0; i < srcData.length; i += 4) {
                const a = srcData[i + 3] / 255;
                if (!a) {
                    outData[i] = 255;
                    outData[i + 1] = 0;
                    outData[i + 2] = 0;
                    outData[i + 3] = 0;
                    continue;
                }
                const r = srcData[i] / 255, g = srcData[i + 1] / 255, b = srcData[i + 2] / 255;
                const v = isLuma ? (0.299 * r + 0.587 * g + 0.114 * b) : colourSimilarity(r, g, b, colorRef, colorTol);
                const wt = rangeWeight(v, limit);
                outData[i] = 255;
                outData[i + 1] = 0;
                outData[i + 2] = 0;
                outData[i + 3] = Math.round(wt * 255 * a);
            }
            this._tintCpuCtx.putImageData(outImg, 0, 0);
            tintOut = this._tintCpuCanvas;
        }

        this._rangeTint = {
            canvas: tintOut,
            box: [box[0], box[1], bw, bh],
        };
        this.drawSoon();
    }

    /**
     * Arms a one-shot click to pick range value from the picture (R1-S6).
     * @param {"depth" | "luma" | "color"} source
     * @param {(val: number | string | null, meta?: any) => void} [onPick] - Optional target callback (R1-S8)
     * @returns {Promise<number | string | null>}
     */
    pickOnce(source = "depth", onPick = null) {
        this._pendingPick = source;
        this._pendingPickTarget = typeof onPick === "function" ? onPick : null;
        const name = source === "depth" ? "depth" : source === "luma" ? "luminosity" : "colour";
        this.setStatus(`Click the picture to pick ${name} … (Esc cancels)`);
        this.draw();
        return new Promise((resolve) => {
            this._pickResolve = resolve;
        });
    }

    async handlePickOnce(source, ix, iy) {
        const targetCb = this._pendingPickTarget;
        this._pendingPick = null;
        this._pendingPickTarget = null;
        this.setStatus("");
        const px = Math.max(0, Math.min(this.width - 1, Math.floor(ix)));
        const py = Math.max(0, Math.min(this.height - 1, Math.floor(iy)));
        let pickedVal = null;

        if (source === "depth") {
            const v = this.depthAt(ix, iy);
            pickedVal = v;
            if (!targetCb) {
                const w = (this.rangeLimit.hi ?? 0.3) - (this.rangeLimit.lo ?? 0);
                const half = w / 2;
                let lo = Math.max(0, v - half);
                let hi = Math.min(1, v + half);
                if (lo === 0) hi = Math.min(1, w);
                if (hi === 1) lo = Math.max(0, 1 - w);
                this.rangeLimit.lo = lo;
                this.rangeLimit.hi = hi;
                if (this.rangeBar) this.rangeBar.set(this.rangeLimit);
            }
        } else if (source === "luma") {
            const res = await this.readBoxBytes([px, py, px + 1, py + 1], { forRun: true });
            const d = res ? res.data : null;
            if (d && d.length >= 3) {
                const v = (0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2]) / 255;
                pickedVal = v;
                if (!targetCb) {
                    const w = (this.rangeLimit.hi ?? 0.3) - (this.rangeLimit.lo ?? 0);
                    const half = w / 2;
                    let lo = Math.max(0, v - half);
                    let hi = Math.min(1, v + half);
                    if (lo === 0) hi = Math.min(1, w);
                    if (hi === 1) lo = Math.max(0, 1 - w);
                    this.rangeLimit.lo = lo;
                    this.rangeLimit.hi = hi;
                    if (this.rangeBar) this.rangeBar.set(this.rangeLimit);
                }
            }
        } else if (source === "color") {
            const res = await this.readBoxBytes([px, py, px + 1, py + 1], { forRun: true });
            const d = res ? res.data : null;
            if (d && d.length >= 3) {
                const toHex = (n) => n.toString(16).padStart(2, "0");
                const hex = `#${toHex(d[0])}${toHex(d[1])}${toHex(d[2])}`;
                pickedVal = hex;
                if (!targetCb) {
                    this.rangeLimit.color = hex;
                    if (this.rangeColorInput) this.rangeColorInput.value = hex;
                    if (this.rangeBar) this.rangeBar.refresh();
                }
            }
        }
        if (targetCb) {
            try {
                targetCb(pickedVal, { ix, iy, source });
            } catch (err) {
                console.error("pickOnce target callback failed:", err);
            }
        }
        if (this._pickResolve) {
            const r = this._pickResolve;
            this._pickResolve = null;
            r(pickedVal);
        }
        this.draw();
    }

    /**
     * Draw a filter layer onto `ctx` (a canvas holding everything below it), or hand its result
     * on to the next filter layer as a GPU surface. `chain` is what the filter layer before it
     * left there, `more` says another filter layer follows; the return value is the new chain,
     * null once everything has been drawn. The pixels are the same either way: a result that
     * goes onto the canvas is drawn over the composite exactly as before, and the held chain is
     * flushed first (flushFilterChain), so only the upload of the next filter's input is saved.
     */
    // `clip`: the filter layer is clipped to the layer below (PLAN_0_1_31 §6 step 3), `() => coverage` (`clipCoverage`, asked for
    // once the filter has run: its input's statistics may walk the stack again): the result goes over the picture where the
    // base is, `mix(in, filtered, baseAlpha)`
    applyFilterLayer(ctx, layer, index, forRun, chain = null, more = false, clip = null) {
        if (!forRun) {
            // While something below the filter is being painted or moved, the cached
            // result would hide the live change: show the layers unfiltered instead.
            const p = this.pointer;
            const gestureLayer = (p && p.layer) || (this.pending && this.pending.layer) || null;
            if (gestureLayer && gestureLayer !== layer) {
                const gi = this.layers.indexOf(gestureLayer);
                if (gi >= 0 && gi < index) return chain;
            }
        }
        const vp = this.viewPass;
        // the region pass already works at screen resolution; the 1024 px preview is for the full-size path
        const preview = !forRun && !vp && (this.filterPreview === layer.id || this.filterPreview === "*");
        if (chain && preview) chain = this.flushFilterChain(ctx, chain);   // the preview downscales on a canvas
        // A filter layer that covers its input one to one can leave its result on the GPU; a
        // mask, an opacity or a blend mode has to composite it onto the canvas.
        // a fill layer (`over`) goes over the picture as a layer does: its result never stands for the picture
        const limitView = this.effectViewOf(layer, forRun);
        const plain = !limitView && !this.liveMask(layer) && Math.round(layer.opacity * 255) === 255 && (!layer.blend || layer.blend === "normal") && !preview && !clip && !this.isFillLayer(layer);
        let rx = vp ? vp.x : 0, ry = vp ? vp.y : 0;
        let rw = vp ? vp.w : this.width, rh = vp ? vp.h : this.height;
        const margin = !!(vp && (rx < 0 || ry < 0 || rx + rw > this.width || ry + rh > this.height));
        let fvp = vp;
        if (margin && !this.isFillLayer(layer)) {
            const W = ctx.canvas.width, H = ctx.canvas.height;
            const sx = W / rw, sy = H / rh;
            const dl = -rx * sx, dt = -ry * sy, dr = (this.width - rx) * sx, db = (this.height - ry) * sy;
            const bx0 = Math.max(0, Math.floor(dl)), by0 = Math.max(0, Math.floor(dt));
            const bx1 = Math.min(W, Math.ceil(dr)), by1 = Math.min(H, Math.ceil(db));
            const bw = bx1 - bx0, bh = by1 - by0;
            if (bw <= 0 || bh <= 0) return chain;
            const ix0 = Math.max(bx0, Math.min(bx1, Math.ceil(dl))), iy0 = Math.max(by0, Math.min(by1, Math.ceil(dt)));
            const ix1 = Math.min(bx1, Math.max(ix0, Math.floor(dr))), iy1 = Math.min(by1, Math.max(iy0, Math.floor(db)));
            rx += bx0 / sx; ry += by0 / sy;
            rw = bw / sx; rh = bh / sy;
            fvp = { ...vp, x: rx, y: ry, w: rw, h: rh, crop: { bx0, by0, bw, bh, ix0, iy0, iw: ix1 - ix0, ih: iy1 - iy0 } };
        }
        if (chain && margin && this.isFillLayer(layer)) chain = this.flushFilterChain(ctx, chain);
        const keepSurface = plain && more && !this.filterChainOff && glChainUsable(fvp && fvp.crop ? fvp.crop.bw : ctx.canvas.width, fvp && fvp.crop ? fvp.crop.bh : ctx.canvas.height);
        let out;
        this.viewPass = fvp;
        try {
            out = this.filteredCanvas(layer, chain ? chain.surface : ctx.canvas, forRun, preview, keepSurface, plain);
        } finally {
            this.viewPass = vp;
        }
        if (isGLSurface(out)) {
            if (chain && out !== chain.surface) releaseSurface(chain.surface);
            return { surface: out, x: rx, y: ry, w: rw, h: rh };
        }
        chain = this.flushFilterChain(ctx, chain);   // the result goes onto the canvas, so the composite has to be there
        if (!out || (plain && out === ctx.canvas)) return null;
        let src = out;
        if (this.liveMask(layer)) {
            if (!this.filterMaskCanvas || this.filterMaskCanvas.width !== out.width || this.filterMaskCanvas.height !== out.height) this.filterMaskCanvas = makeCanvas(out.width, out.height);
            const m = this.filterMaskCanvas;
            const mctx = m.getContext("2d");
            mctx.globalCompositeOperation = "source-over";
            mctx.globalAlpha = 1;
            mctx.clearRect(0, 0, m.width, m.height);
            mctx.drawImage(out, 0, 0);
            mctx.globalCompositeOperation = "destination-in";
            const ms = layer.maskPx.width / this.width;   // a filter layer's mask covers the whole image
            const g = this.pointer;
            const stroke = !!(g && g.kind === "maskpaint" && g.layer === layer);
            if (vp && isTilePixels(layer.maskPx)) {
                // C6 (c2): in a region pass the part of the mask the pass shows, from the mask's tiles at the pass's level,
                // and during a mask stroke on this layer the stroke over it in a scratch of the pass's size. drawTo gave
                // the mask's display mirror (572 MB at 15000 x 10000, synced per written tile) and a sub-rectangle draw of
                // it per pass; the stroke a full-size live preview filled from that mirror.
                const sx = m.width / rw, sy = m.height / rh;
                const mvp = { ...(fvp || vp), sx, sy };
                const whole = { x: 0, y: 0, w: this.width, h: this.height };
                mctx.save();
                try {
                    if (stroke) {
                        const sc = this.passScratch("_filterMaskView", m.width, m.height), sctx = sc.getContext("2d");
                        sctx.save();
                        try {
                            sctx.setTransform(1, 0, 0, 1, 0, 0);
                            sctx.globalAlpha = 1;
                            sctx.globalCompositeOperation = "source-over";
                            sctx.clearRect(0, 0, m.width, m.height);
                            sctx.setTransform(sx, 0, 0, sy, -rx * sx, -ry * sy);
                            this.drawTilesInto(sctx, layer.maskPx, 0, 0, this.width, this.height, mvp);
                            this.drawStrokeInto(sctx, whole, layer.maskPx, g.erase ? "destination-out" : "source-over", mvp, [0, 0, m.width, m.height]);
                        } finally {
                            sctx.restore();
                        }
                        mctx.setTransform(1, 0, 0, 1, 0, 0);
                        mctx.drawImage(sc, 0, 0);
                    } else {
                        mctx.setTransform(sx, 0, 0, sy, -rx * sx, -ry * sy);
                        this.drawTilesInto(mctx, layer.maskPx, 0, 0, this.width, this.height, mvp);
                    }
                } finally {
                    mctx.restore();
                }
            }
            // during a mask stroke on this layer its live preview (the mask's size), otherwise the mask's own pixels
            else if (stroke) mctx.drawImage(this.maskWithStroke(layer), rx * ms, ry * ms, rw * ms, rh * ms, 0, 0, m.width, m.height);
            else layer.maskPx.drawTo(mctx, rx * ms, ry * ms, rw * ms, rh * ms, 0, 0, m.width, m.height);
            mctx.globalCompositeOperation = "source-over";
            src = m;
        }
        if (limitView) {
            ctx.save();
            ctx.fillStyle = "#000000";
            ctx.fillRect(rx, ry, rw, rh);
            ctx.restore();
        }
        // A fill layer covers the picture, not the view: the screen's region pass reaches past the document when the
        // view is zoomed out (viewportRegion pads the visible area and clamps nothing), and the fill's bytes there are
        // its clamped ends, so a gradient painted the whole viewport (the user's screenshot, 2026-10-10). The draw is
        // clipped to the document; a filter leaves the transparent outside transparent by itself.
        const clipDoc = margin && this.isFillLayer(layer);
        if (clipDoc) { ctx.save(); ctx.beginPath(); ctx.rect(0, 0, this.width, this.height); ctx.clip(); }
        try {
            if (!limitView && (clip || EMULATED_BLENDS.has(layer.blend))) {
                this.blendEmulated(ctx, layer.blend, (c) => { c.drawImage(src, rx, ry, rw, rh); }, layer.opacity, clip ? clip() : null, seedOfLayer(layer.id));
                return null;
            }
            ctx.globalAlpha = limitView ? 1 : layer.opacity;
            ctx.globalCompositeOperation = limitView ? "source-over" : canvasOp(layer.blend);
            if (plain) ctx.clearRect(rx, ry, rw, rh);
            ctx.drawImage(src, rx, ry, rw, rh);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "source-over";
            return null;
        } finally {
            if (clipDoc) ctx.restore();
        }
    }

    /** Draw what the filter chain left on the GPU onto `ctx` and give the surface back. */
    flushFilterChain(ctx, chain) {
        if (!chain) return null;
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        if (!drawSurfaceTo(ctx, chain.surface, chain.x, chain.y, chain.w, chain.h, true)) {
            const flat = surfaceToCanvas(chain.surface);
            if (flat) {
                ctx.clearRect(chain.x, chain.y, chain.w, chain.h);
                ctx.drawImage(flat, chain.x, chain.y, chain.w, chain.h);
            }
        }
        releaseSurface(chain.surface);
        return null;
    }

    /** Is the next layer that gets drawn after `i` a filter layer? (may the chain go on?) */
    nextIsFilterLayer(i, forRun, end = this.layers.length) {
        for (let j = i + 1; j < end; j++) {
            const l = this.layers[j];
            if (this.compareShow && l.kind === "result" && l.id !== this.compareShow) continue;
            if ((!this.shown(l) && !(this.compareShow && l.id === this.compareShow)) || !l.px) continue;
            if (l.kind === "filter") return true;
            if (forRun && (this.isControl(l) || this.isReference(l))) continue;
            return false;
        }
        return false;
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

    // ---- export -----------------------------------------------------------------

    /** Save the visible composite (filters applied, no control / reference layers) to output/inpaint_canvas. */
    /**
     * The layers as PSD / ORA see them: pixels at image resolution, bottom first, the base as
     * "Background". The descriptors are not layers: each holds its own export copy as `canvas`.
     * PSD (docs/PLAN_0_1_31.md 3e): a layer's pixels as they are and its mask as `mask: { canvas, disabled }` (the mask's
     * alpha, at the layer's export size), switched off or not; ORA has no masks, so its layers bake the live one.
     * A clipped layer is clipped in the PSD too (`clip`, when its base is exported); ORA has no clipping, its layers go unclipped.
     */
    /**
     * The PSD groups (`lsct`, PLAN_0_1_31 §6.5) of a walk of the layers bottom first: `at(l)` gives the section records
     * to write before layer `l` (a folder record for each group it is not in any more, then a bounding divider for each
     * group it opens), `end()` the folder records that close the rest. A reference never closes a group: it is written
     * where the walk is. A record: `{ section: 1 | 2 | 3, name, visible }` (2 = a folded group, 3 = the divider).
     */
    psdSections() {
        let open = [];
        const close = (k) => {
            const out = [];
            for (let q = open.length - 1; q >= k; q--) out.push({ section: open[q].collapsed ? 2 : 1, name: open[q].name, visible: open[q].visible !== false, x: 0, y: 0, opacity: 1, blend: "normal" });
            open = open.slice(0, k);
            return out;
        };
        return {
            at: (l) => {
                if (this.isReference(l)) return [];
                const chain = this.groupsOf(l.group).reverse();
                let k = 0;
                while (k < open.length && k < chain.length && open[k] === chain[k]) k++;
                const out = close(k);
                for (let q = k; q < chain.length; q++) { out.push({ section: 3, name: "</Layer group>", visible: true, x: 0, y: 0, opacity: 1, blend: "normal" }); open.push(chain[q]); }
                return out;
            },
            end: () => close(0),
        };
    }

    exportLayerStack(fmt = "psd") {
        const psd = fmt === "psd";
        const sec = psd ? this.psdSections() : null;
        const layers = [];
        const bg = makeCanvas(this.width, this.height);
        this.basePx.drawTo(bg.getContext("2d"), 0, 0);   // unscaled (PLAN_BCE §C1 rule 6)
        layers.push({ name: "Background", x: 0, y: 0, canvas: bg, opacity: 1, visible: true, blend: "normal" });
        let skipped = 0;
        for (const l of this.layers) {
            if (sec) layers.push(...sec.at(l));
            if ((l.kind === "filter" && !this.isFillLayer(l)) || !l.px) { skipped++; continue; }
            const w = Math.max(1, Math.round(l.w)), h = Math.max(1, Math.round(l.h));
            const c = makeCanvas(w, h);
            const ctx = c.getContext("2d");
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            const keepMask = psd && !!l.maskPx;
            if (this.isFillLayer(l)) ctx.drawImage(this.fillLayerCanvas(l, !keepMask), 0, 0, w, h);   // its fill, the live mask baked unless it goes along
            else ctx.drawImage(keepMask ? this.layerWithStroke(l) : this.layerPixels(l), 0, 0, w, h);
            let mask = null;
            if (keepMask) {
                // the mask at the pixels' export size, the same resampling as the pixels
                const mc = makeCanvas(w, h);
                const mctx = mc.getContext("2d");
                mctx.imageSmoothingEnabled = true;
                mctx.imageSmoothingQuality = "high";
                l.maskPx.drawTo(mctx, 0, 0, w, h);
                mask = { canvas: mc, disabled: !!l.maskOff };
            }
            const aside = this.isControl(l) || this.isReference(l);
            layers.push({ name: l.name + (aside ? ` (${l.role})` : ""), x: Math.round(l.x), y: Math.round(l.y), canvas: c, opacity: l.opacity ?? 1, visible: (psd ? l.visible !== false : this.shown(l)) && !aside, blend: l.blend || "normal", ...(mask ? { mask } : {}), ...(psd && this.clipBaseOf(l) ? { clip: true } : {}) });
        }
        if (sec) layers.push(...sec.end());
        return { layers, skipped };
    }

    /**
     * The layers as PSD / ORA see them, as row sources (E4, inpaint_bands.js), bottom first: `[{ meta, open() }]`, where
     * `open()` gives `{ source, close() }`. A layer on tiles, at its own size and without a mask, is read from its tiles
     * (a copy-on-write clone taken now, released through `held`); any other is drawn into a canvas of its size when it
     * is opened, as `exportLayerStack` does for all of them at once, so only one such canvas exists at a time.
     * PSD: a masked layer's pixels as they are (from its tiles when it can) and its mask as `openMask()`, with
     * `meta.mask = { disabled }`; ORA bakes the live mask as before.
     */
    exportLayerSources(held, fmt = "psd") {
        const psd = fmt === "psd";
        const byName = arenaEnabled();
        const fromTiles = (px) => { const snap = px.clone(); held.push(snap); return () => ({ source: tileRows(snap, byName), close() {} }); };
        const fromCanvas = (draw, w, h) => () => {
            const c = makeCanvas(w, h);
            draw(c.getContext("2d"));
            return { source: canvasRows(c), close() { c.width = 1; c.height = 1; } };
        };
        const out = [];
        const bs = this.basePx;
        out.push({
            meta: { name: "Background", x: 0, y: 0, opacity: 1, visible: true, blend: "normal" },
            open: isTilePixels(bs) && bs.width === this.width && bs.height === this.height ? fromTiles(bs) : fromCanvas((ctx) => bs.drawTo(ctx, 0, 0), this.width, this.height),
        });
        let skipped = 0;
        const sec = psd ? this.psdSections() : null;
        const sections = (list) => list.map((meta) => ({ meta, open: null }));
        for (const l of this.layers) {
            if (sec) out.push(...sections(sec.at(l)));
            if ((l.kind === "filter" && !this.isFillLayer(l)) || !l.px) { skipped++; continue; }
            const w = Math.max(1, Math.round(l.w)), h = Math.max(1, Math.round(l.h));
            const aside = this.isControl(l) || this.isReference(l);
            const mask = psd ? l.maskPx : null;   // kept as a mask, switched off or not
            const still = !this.liveStrokeOn(l) && !(this.pending && this.pending.layer === l);
            // raw pixels from the tiles: an unmasked layer, or one whose mask goes along as a mask
            const plain = isTilePixels(l.px) && (mask || !this.liveMask(l)) && l.px.width === w && l.px.height === h && still;
            const smooth = (ctx) => { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; };
            out.push({
                meta: { name: l.name + (aside ? ` (${l.role})` : ""), x: Math.round(l.x), y: Math.round(l.y), opacity: l.opacity ?? 1, visible: (psd ? l.visible !== false : this.shown(l)) && !aside, blend: l.blend || "normal", ...(mask ? { mask: { disabled: !!l.maskOff } } : {}), ...(psd && this.clipBaseOf(l) ? { clip: true } : {}) },
                open: this.isFillLayer(l) ? this.fillLayerRows(l, !mask) : plain ? fromTiles(l.px) : fromCanvas((ctx) => { smooth(ctx); ctx.drawImage(mask ? this.layerWithStroke(l) : this.layerPixels(l), 0, 0, w, h); }, w, h),
                // the mask at the pixels' size: its own tiles when it has that size already, else drawn to it
                ...(mask ? { openMask: isTilePixels(mask) && mask.width === w && mask.height === h && still ? fromTiles(mask) : fromCanvas((ctx) => { smooth(ctx); mask.drawTo(ctx, 0, 0, w, h); }, w, h) } : {}),
            });
        }
        if (sec) out.push(...sections(sec.end()));
        return { stack: out, skipped };
    }

    /**
     * A PSD or ORA file written from row sources by the worker pool (E4): `{ blob, layers, skipped }`, or null when it
     * cannot be (the canvas backend, no pool, no Rust kernels) and the caller takes the canvas writers. The merged
     * picture comes in bands when it can (`bandPlan`), else from one flatten.
     */
    async exportLayeredBands(fmt, progress = null) {
        if (!this.tileMode || !partsUsable() || InpaintEditor.bands === false) return null;
        const group = "layered" + nextPartsSeq();
        const W = this.width, H = this.height;
        const version = this.compositeVersion;
        const held = [];
        let flat = null;
        try {
            const opts = { width: W, height: H, run: partsRun(group), flights: partsFlights(), pause: bandPause };
            const writer = fmt === "psd" ? new PsdBandWriter(opts) : new OraBandWriter(opts);
            const { stack, skipped } = this.exportLayerSources(held, fmt);
            // B item 1: the merged picture of a plain stack is composited by the workers, from clones taken now with the layers'
            const stackOf = await this.stackSource({ forRun: true });
            if (stackOf) held.push({ release: () => stackOf.release() });
            const steps = stack.length + 1;
            let done = 0;
            const report = (f) => { if (progress) progress((done + f) / steps); };
            for (const L of stack) {
                if (!L.open) { writer.section(L.meta); done++; continue; }   // a group's record (PSD)
                const o = L.open();
                const m = L.openMask ? L.openMask() : null;
                try { await writer.layer(L.meta, o.source, report, m ? m.source : null); } finally { o.close(); if (m) m.close(); }
                done++;
            }
            const plan = stackOf ? null : this.bandPlan({ forRun: true });
            const bands = plan ? await this.bandSource({ forRun: true }, plan) : null;   // B item 7 part 2: filter layers over worker-composited bands
            if (bands) held.push(bands);
            let composite;
            if (stackOf) composite = stackOf.source;
            else if (bands) {
                composite = bandRows(W, H, (y0, y1) => {
                    if (this.compositeVersion !== version) throw new Error("the picture changed while it was written; try again");
                    return bands.read(y0, y1);
                }, bands.rows);
            } else {
                flat = this.flattenToCanvas({ forRun: true });
                composite = canvasRows(flat);
            }
            let blob;
            if (fmt === "psd") blob = await writer.finish(composite, report);
            else {
                const ts = Math.min(1, 256 / Math.max(W, H));
                const small = await this.sampleRegionSettled("image", [0, 0, W, H], ts, { forRun: true });
                const thumb = await new Promise((r) => small.toBlob(r, "image/png"));
                blob = await writer.finish(composite, thumb, report);
            }
            return { blob, layers: stack.filter((L) => L.open).length, skipped };
        } catch (err) {
            editorPool().cancel(group);
            if (partsFailed(err) || String(err && err.message).includes(NO_PROGRAM)) return null;   // the canvas writers take it
            throw err;
        } finally {
            for (const px of held) px.release();
            if (flat) { flat.width = 1; flat.height = 1; }
        }
    }

    /**
     * The picture as a TIFF (docs/PLAN_0_1_29.md 3d): `{ blob, width, height }`. As it is (no Size or Canvas row), from
     * the row sources the PNG and PSD exports read: a plain stack composited by the workers, bands, or one flatten;
     * scaled or framed, from the export canvas. The strips are compressed by the pool, or here when there is none.
     */
    async encodeTiff(progress = null, { flatOnly = false } = {}) {
        const plain = host.exportIsPlain(this);
        const pooled = partsUsable();
        const group = "tiff" + nextPartsSeq();
        const held = [];
        let flat = null;
        try {
            let source = null;
            if (plain && pooled && this.tileMode && !flatOnly) {
                const stack = await this.stackSource({ forRun: true });
                if (stack) { held.push({ release: () => stack.release() }); source = stack.source; }
                else {
                    const plan = this.bandPlan({ forRun: true });
                    const bands = plan ? await this.bandSource({ forRun: true }, plan) : null;
                    if (bands) {
                        held.push(bands);
                        const version = this.compositeVersion;
                        source = bandRows(this.width, this.height, (y0, y1) => {
                            if (this.compositeVersion !== version) throw new Error("the picture changed while it was written; try again");
                            return bands.read(y0, y1);
                        }, bands.rows);
                    }
                }
            }
            if (!source) {
                if (this.relightSettled) await this.relightSettled();
                flat = plain ? this.flattenToCanvas({ forRun: true }) : await host.exportCanvas(this, "tiff");
                source = canvasRows(flat);
            }
            const run = pooled ? partsRun(group) : (op, args) => tiffPart(args, deflate);
            const blob = await writeTiff(source, run, { flights: pooled ? partsFlights() : 1, progress, pause: bandPause });
            return { blob, width: source.width, height: source.height };
        } catch (err) {
            if (pooled) editorPool().cancel(group);
            if (!flatOnly && !this.huge && String(err && err.message).includes(NO_PROGRAM)) return this.encodeTiff(progress, { flatOnly: true });   // a matched stack without its program: one flatten
            throw err;
        } finally {
            for (const h of held) h.release();
            if (flat) { flat.width = 1; flat.height = 1; }
        }
    }

    /** The active layer alone as a PNG with transparency, into the output folder. */
    async exportLayerPng() {
        const l = this.activeLayer();
        if (!l || l.kind === "filter" || !l.px) { this.setStatus("Select a pixel layer to save it on its own."); return null; }
        try {
            const c = makeCanvas(this.width, this.height);
            c.getContext("2d").drawImage(this.layerPixels(l), l.x, l.y, l.w, l.h);
            const blob = await new Promise((r) => c.toBlob(r, "image/png"));
            const stem = (l.name || "layer").replace(/[^a-z0-9._ -]/gi, "_");
            const saved = await host.saveExport(blob, `${stem}.png`, { editor: this });
            if (!saved) { this.setStatus("Save cancelled."); return null; }
            this.setStatus(`Saved ${saved.path} (${l.name}, ${this.width} × ${this.height} with transparency).`, "info");
            return saved;
        } catch (err) { console.error(err); this.setStatus("Save failed: " + (err.message || err), failKind(err)); return null; }
    }

    /** The selection as a black and white mask PNG, into the output folder. */
    async exportMaskPng() {
        if (!this.getBounds()) { this.setStatus("Nothing selected to save as a mask."); return null; }
        try {
            const blob = await new Promise((r) => this.maskToCanvas().toBlob(r, "image/png"));
            const stem = ((this.saveNameInput && this.saveNameInput.value) || "inpaint_canvas").trim().replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._ -]/gi, "_") || "inpaint_canvas";
            const saved = await host.saveExport(blob, `${stem}_mask.png`, { editor: this });
            if (!saved) { this.setStatus("Save cancelled."); return null; }
            this.setStatus(`Saved ${saved.path} (mask, white = selected).`, "info");
            return saved;
        } catch (err) { console.error(err); this.setStatus("Save failed: " + (err.message || err), failKind(err)); return null; }
    }

    async exportImage({ download = false } = {}) {
        if (!this.base) { this.setStatus("Nothing to save yet."); return null; }
        const start = markStep("export", "start");   // its fmt once it is read below
        if (this.removePending || this.healPending || this.liquifyPending) { this.setStatus("Waiting for the stroke to land..."); await this.heldEdit(); }
        await this.relightSettled();   // every format: the layered and TIFF writers read bands that do not wait by themselves (F2.7)
        markStep("export", "ready");
        const fmt = ["png", "jpg", "webp", "tiff", "psd", "ora"].includes(this.saveFormatSel && this.saveFormatSel.value) ? this.saveFormatSel.value : "png";
        start.fmt = fmt;
        const stem = ((this.saveNameInput && this.saveNameInput.value) || "inpaint_canvas").trim().replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._ -]/gi, "_") || "inpaint_canvas";
        try {
            this.setStatus("Saving ...");
            let blob, note = "", embedded = false, banded = false, size = null;
            let pngTexts = null;
            const pngChunks = fmt === "png" ? [SRGB_CHUNK] : null;   // 3f: the pixels are sRGB, and the file says so
            if (fmt === "png") {
                // Same metadata as SaveImage: the workflow (and the canvas prompt), so the file loads back into ComfyUI. The
                // host answers null when it is not to be embedded (the app's switch, on by default: docs/PLAN_0_1_29.md 3f).
                try {
                    const workflow = host.workflowForPng(this);
                    if (workflow) pngTexts = { workflow: asciiJson(workflow), inpaint_canvas: asciiJson({ prompt: this.promptText, negative: this.negativeText, width: this.width, height: this.height, seed: this.genSettings.seed, mode: this.genSettings.mode }) };
                } catch (err) { console.warn("Inpaint Canvas: could not embed the workflow", err); }
            }
            // E2: a PNG of the picture as it is is written in bands by the worker pool, without a canvas of the picture
            if (fmt === "png" && host.exportIsPlain(this)) {
                const t0 = performance.now();
                const r = await this.encodeComposite({ forRun: true }, { texts: pngTexts, chunks: pngChunks, progress: (f) => this.setStatus(`Saving ... ${Math.round(f * 100)} %`) });
                if (r) { blob = r.blob; banded = true; embedded = !!pngTexts; note = `, ${Math.round(performance.now() - t0)} ms`; }
            }
            // E4: a layered file from the layers' own tiles and the composite's bands, packed by the worker pool
            if (fmt === "psd" || fmt === "ora") {
                const t0 = performance.now();
                const r = await this.exportLayeredBands(fmt, (f) => this.setStatus(`Saving ... ${Math.round(f * 100)} %`));
                if (r) { blob = r.blob; note = `, ${r.layers} layers${r.skipped ? `, ${r.skipped} filter layer${r.skipped > 1 ? "s" : ""} only in the merged image` : ""}, ${Math.round(performance.now() - t0)} ms`; }
            }
            // 3d: a TIFF is written in strips from the picture's rows (scaled or framed from the export canvas)
            if (fmt === "tiff") {
                const t0 = performance.now();
                const r = await this.encodeTiff((f) => this.setStatus(`Saving ... ${Math.round(f * 100)} %`));
                blob = r.blob; size = [r.width, r.height]; note = `, ${Math.round(performance.now() - t0)} ms`;
            }
            const canvas = blob ? { width: size ? size[0] : this.width, height: size ? size[1] : this.height } : await host.exportCanvas(this, fmt);
            if (blob) { /* written in bands */ }
            else if (fmt === "psd" || fmt === "ora") {
                const t0 = performance.now();
                const { layers, skipped } = this.exportLayerStack(fmt);
                blob = await buildLayered(fmt, { width: this.width, height: this.height, layers, composite: canvas });
                note = `, ${layers.filter((L) => !L.section).length} layers${skipped ? `, ${skipped} filter layer${skipped > 1 ? "s" : ""} only in the merged image` : ""}, ${Math.round(performance.now() - t0)} ms`;
            } else {
                blob = await new Promise((r) => canvas.toBlob(r, fmt === "jpg" ? "image/jpeg" : fmt === "webp" ? "image/webp" : "image/png", host.exportQuality(this)));
            }
            if (fmt === "png" && !banded) {
                try { blob = pngWithChunks(await blob.arrayBuffer(), { texts: pngTexts, chunks: pngChunks }); embedded = !!pngTexts; } catch (err) { console.warn("Inpaint Canvas: could not embed the workflow", err); }
            }
            markStep("export", "encoded", { MB: blob ? blob.size / 1048576 : 0 });
            const saved = await host.saveExport(blob, `${stem}.${fmt === "tiff" ? "tif" : fmt}`, { editor: this, download });
            markStep("export", "saved");
            if (!saved) { this.setStatus("Save cancelled."); return null; }
            const kb = Math.round(blob.size / 1024);
            this.setStatus(`Saved ${saved.path} (${canvas.width} × ${canvas.height}, ${kb >= 1024 ? (kb / 1024).toFixed(1) + " MB" : kb + " kB"}${fmt === "png" && embedded ? ", " + hostText("pngEmbedded", "recipe embedded") : ""}${note}).`, "info");
            return saved;
        } catch (err) {
            console.error(err);
            this.setStatus("Save failed: " + (err.message || err), failKind(err));
            return null;
        }
    }

    async cleanupFiles() {
        const fmt = (b) => b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1e3) + " kB";
        try {
            const keep = InpaintEditor.referencedFiles();
            const call = async (dry) => {
                const r = await api.fetchApi("/inpaint_canvas/cleanup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keep, dry_run: dry }) });
                if (r.status !== 200) throw new Error(`cleanup route answered ${r.status} (restart ComfyUI after updating the node)`);
                return r.json();
            };
            this.setStatus("Checking files ...");
            const plan = await call(true);
            if (!plan.removed) {
                this.setStatus(`Nothing to clean up: ${plan.kept} file${plan.kept === 1 ? "" : "s"} still in use.`);
                if (this.cleanupInfo) this.cleanupInfo.textContent = `${plan.kept} in use`;
                return;
            }
            const t = plan.by_type || {};
            const msg = `Delete ${plan.removed} file${plan.removed === 1 ? "" : "s"} (${fmt(plan.bytes)}) from the inpaint_canvas folders?\n` +
                `input ${t.input || 0} · output ${t.output || 0} · temp ${t.temp || 0}\n\n` +
                `Kept: ${plan.kept} file${plan.kept === 1 ? "" : "s"} used by open editors, open workflow tabs or saved workflows, and anything younger than two minutes. Discarded history results that are deleted cannot be restored.`;
            if (!(await this.ask({ title: "Clean up files", message: msg, ok: "Delete", danger: true }))) { this.setStatus("Cleanup cancelled."); return; }
            const res = await call(false);
            this.setStatus(`Cleanup: ${res.removed} file${res.removed === 1 ? "" : "s"} deleted (${fmt(res.bytes)}), ${res.kept} kept.`);
            if (this.cleanupInfo) this.cleanupInfo.textContent = `${res.removed} deleted, ${fmt(res.bytes)}`;
        } catch (err) {
            console.error(err);
            this.setStatus("Cleanup failed: " + (err.message || err), failKind(err));
        }
    }

    /** Exact bounding box of the selected pixels inside a box, or null when it holds none. */
    scanBounds(bx0, by0, bx1, by1) {
        const W = bx1 - bx0, H = by1 - by0;
        if (W <= 0 || H <= 0) return null;
        // one 32-bit word per pixel; alpha is the high byte, so "selected" is one bit test
        const d = new Uint32Array(this.sel.readRect(bx0, by0, W, H).data.buffer);
        let x0 = W, y0 = H, x1 = -1, y1 = -1;
        for (let y = 0; y < H; y++) {
            const row = y * W;
            let rx0 = -1;
            for (let x = 0; x < W; x++) if (d[row + x] & 0x80000000) { rx0 = x; break; }
            if (rx0 < 0) continue;
            let rx1 = rx0;
            for (let x = W - 1; x > rx0; x--) if (d[row + x] & 0x80000000) { rx1 = x; break; }
            if (rx0 < x0) x0 = rx0;
            if (rx1 > x1) x1 = rx1;
            if (y < y0) y0 = y;
            y1 = y;
        }
        if (x1 < 0) return null;
        return [bx0 + x0, by0 + y0, bx0 + x1 + 1, by0 + y1 + 1];
    }

    /**
     * Exact bounding box of the selected pixels inside `box`, a rectangle known to hold
     * them all, read in 64 px strips from each edge inwards: rows from the top until the
     * first selected pixel, rows from the bottom, then columns within those rows. A
     * marquee on a 15k canvas costs four strips of a few MB instead of the box (hundreds
     * of MB and half a second of readback). A selection whose alpha never reaches 128
     * still reads the whole box, strip by strip. Null when the box holds none.
     */
    scanBoundsIn(box) {
        const [bx0, by0, bx1, by1] = box;
        const W = bx1 - bx0, H = by1 - by0;
        if (W <= 0 || H <= 0) return null;
        const sel = this.sel;
        const STRIP = 64;
        const rows = (y, h) => {   // first and last row of the strip with a selected pixel, or null
            const d = new Uint32Array(sel.readRect(bx0, y, W, h).data.buffer);
            let first = -1, last = -1;
            for (let r = 0; r < h; r++) {
                const row = r * W;
                for (let x = 0; x < W; x++) if (d[row + x] & 0x80000000) { if (first < 0) first = r; last = r; break; }
            }
            return first < 0 ? null : [first, last];
        };
        let y0 = -1, y1 = -1;
        for (let y = by0; y < by1 && y0 < 0; y += STRIP) { const hit = rows(y, Math.min(STRIP, by1 - y)); if (hit) y0 = y + hit[0]; }
        if (y0 < 0) return null;
        for (let y = by1; y > y0 && y1 < 0; y -= STRIP) { const yy = Math.max(y0, y - STRIP); const hit = rows(yy, y - yy); if (hit) y1 = yy + hit[1] + 1; }
        if (y1 < 0) y1 = y0 + 1;
        const cols = (x, w) => {   // first and last column of the strip with a selected pixel, or null
            const h = y1 - y0;
            const d = new Uint32Array(sel.readRect(x, y0, w, h).data.buffer);
            let first = -1, last = -1;
            for (let c = 0; c < w; c++) {
                for (let r = 0; r < h; r++) if (d[r * w + c] & 0x80000000) { if (first < 0) first = c; last = c; break; }
            }
            return first < 0 ? null : [first, last];
        };
        let x0 = -1, x1 = -1;
        for (let x = bx0; x < bx1 && x0 < 0; x += STRIP) { const hit = cols(x, Math.min(STRIP, bx1 - x)); if (hit) x0 = x + hit[0]; }
        if (x0 < 0) return null;
        for (let x = bx1; x > x0 && x1 < 0; x -= STRIP) { const xx = Math.max(x0, x - STRIP); const hit = cols(xx, x - xx); if (hit) x1 = xx + hit[1] + 1; }
        if (x1 < 0) x1 = x0 + 1;
        return [x0, y0, x1, y1];
    }

    /**
     * A rectangle holding every pixel of the selection with any alpha at all (the bounds
     * count only alpha >= 128; a feathered tail lies outside them), from the 1/16 display
     * level padded by one cell, so nothing full-size is read back. What an undo step has
     * to copy and what a restore has to refresh. Null when the selection is empty.
     *
     * On tiles it is exact and reads nothing: the extent of the tile set (`bounds()`, every
     * allocated tile holds a pixel), with no display mirror made. The canvas backend's level
     * loses what its four smoothed halvings round away (an isolated pixel below about alpha
     * 128, and at sizes that do not halve evenly even alpha 255); `exact` takes the whole
     * image there instead, for a caller that must not lose one (the selection drag, C2 step
     * b's review; a whole-canvas write is GPU work on that backend).
     */
    selectionExtent({ exact = false } = {}) {
        if (!this.sel) return null;
        const W = this.width, H = this.height;
        if (isTilePixels(this.sel)) return this.sel.bounds();
        if (W * H <= PYRAMID_MIN_PX || exact) return [0, 0, W, H];
        const budget = this._pyramidBudget;
        this._pyramidBudget = Infinity;
        const lvl = this.displaySource(this.sel, 1 / 16);
        this._pyramidBudget = budget;
        // no level came back (displaySource hands back the source itself): read nothing, take it all
        if (lvl === canvasOf(this.sel)) return [0, 0, W, H];
        const lw = lvl.width, lh = lvl.height;
        const d = new Uint32Array(lvl.getContext("2d").getImageData(0, 0, lw, lh).data.buffer);
        let cx0 = lw, cy0 = lh, cx1 = -1, cy1 = -1;
        for (let y = 0; y < lh; y++) {
            const row = y * lw;
            for (let x = 0; x < lw; x++) {
                if (!(d[row + x] & 0xff000000)) continue;   // any alpha at all, the level is smoothed
                if (x < cx0) cx0 = x;
                if (x > cx1) cx1 = x;
                if (y < cy0) cy0 = y;
                cy1 = y;
            }
        }
        if (cx1 < 0) return null;
        const fx = W / lw, fy = H / lh;
        return [Math.max(0, Math.floor((cx0 - 1) * fx) - 2), Math.max(0, Math.floor((cy0 - 1) * fy) - 2),
            Math.min(W, Math.ceil((cx1 + 2) * fx) + 2), Math.min(H, Math.ceil((cy1 + 2) * fy) + 2)];
    }

    /**
     * The selection's bounding box, scanned for: the extent from the 1/16 level, then the
     * exact box by strips inside it. Never a readback of the whole canvas.
     */
    selectionBounds() {
        const ext = this.selectionExtent();
        return ext ? this.scanBoundsIn(ext) : null;
    }

    /**
     * The selection's bounding box after an op that filled `box` ([x0, y0, x1, y1] in
     * image coordinates), or undefined when it has to be scanned for (every subtract).
     */
    boundsAfter(mode, box) {
        // the known box, exact or a superset ({ within }), or undefined when nothing is known
        const known = this.selectionDirty && !this.selectionLoose ? undefined : this.cachedBounds;
        if (mode === "subtract") {
            // a subtract only removes: the old box still holds everything, as a superset
            if (known === undefined) return undefined;
            return known ? { within: known } : null;
        }
        const b = [Math.max(0, Math.floor(box[0])), Math.max(0, Math.floor(box[1])),
            Math.min(this.width, Math.ceil(box[2])), Math.min(this.height, Math.ceil(box[3]))];
        const empty = b[2] <= b[0] || b[3] <= b[1];
        if (mode === "replace") return empty ? null : b;
        if (mode === "intersect") {
            if (empty || known === null) return null;
            if (known === undefined) return { within: b };
            const ix0 = Math.max(known[0], b[0]), iy0 = Math.max(known[1], b[1]);
            const ix1 = Math.min(known[2], b[2]), iy1 = Math.min(known[3], b[3]);
            if (ix0 >= ix1 || iy0 >= iy1) return null;
            return { within: [ix0, iy0, ix1, iy1] };
        }
        if (known === undefined) return undefined;
        const old = known;
        const u = empty ? old : (!old ? b : [Math.min(old[0], b[0]), Math.min(old[1], b[1]), Math.max(old[2], b[2]), Math.max(old[3], b[3])]);
        return this.selectionLoose && u ? { within: u } : u;
    }

    getBounds() {
        if (this.selectionDirty) {
            // a superset is made exact by strips from its edges; otherwise the extent is scanned for
            this.cachedBounds = this.selectionLoose && this.cachedBounds ? this.scanBoundsIn(this.cachedBounds) : this.selectionBounds();
            this.selectionDirty = false;
            this.selectionLoose = false;
        }
        return this.cachedBounds;
    }

    /** Auto sizing values for the current selection, or null without a selection. */
    autoParams() {
        const b = this.getBounds();
        const strength = this.genSettings.mode === "local" ? this.genSettings.denoise : 1;
        return b ? autoSelectionParams(b[2] - b[0], b[3] - b[1], strength) : null;
    }

    cropRect() {
        const b = this.getBounds();
        if (!b) return [0, 0, this.width, this.height];
        const auto = this.cropSettings.context === "auto";
        const padding = auto ? this.autoParams().pad : this.widgetValue("padding", 0);
        let x0 = Math.max(0, b[0] - padding), y0 = Math.max(0, b[1] - padding);
        let x1 = Math.min(this.width, b[2] + padding), y1 = Math.min(this.height, b[3] + padding);
        if (auto) {
            [x0, x1] = ensureMinSpan(x0, x1, this.width, MIN_AUTO_CROP);
            [y0, y1] = ensureMinSpan(y0, y1, this.height, MIN_AUTO_CROP);
        }
        return [x0, y0, x1 - x0, y1 - y0];
    }

    syncCropControls() {
        if (!this.cropContextSel) return;
        this.cropContextSel.value = this.cropSettings.context === "auto" ? "auto" : "manual";
        this.cropFeatherSel.value = this.cropSettings.feather === "auto" ? "auto" : "manual";
        this.cropFillSel.value = this.cropSettings.fill || "none";
        this.cropColorMatch.checked = !!this.cropSettings.colorMatch;
        if (this.cropOriginal) this.cropOriginal.checked = !!this.cropSettings.withOriginal;
        if (this.cropAlign) this.cropAlign.checked = this.cropSettings.align !== false;
        if (this.cropPasteSel) this.cropPasteSel.value = this.cropSettings.paste === "crop" ? "whole crop" : "selection";
        if (this.extendFillSel) this.extendFillSel.value = this.cropSettings.extendFill || "average color";
    }

    widgetValue(name, fallback) {
        return host.widgetValue(this, name, fallback);
    }

    renderInfo() {
        // the recipe, the selection, the fill and the Original all change what the references go as
        this.refreshRefLayout();
        this.renderInfoRows();
        // the depth row follows the picture: a load, a crop or a resize changes what it says (it was
        // rendered only on a document's setValue and after a compute, so a loaded picture kept "No image loaded")
        this.renderDepthRow();
    }

    /** The Info panel's rows (renderInfo, and again when the references' layout has answered: refreshRefLayout). */
    renderInfoRows() {
        if (this.resizeW && this.width && document.activeElement !== this.resizeW && document.activeElement !== this.resizeH) { this.resizeW.value = this.width; this.resizeH.value = this.height; }
        if (!this.infoEl) return;
        const rows = [];
        if (this.base) {
            rows.push(["Canvas", `${this.width} × ${this.height}`]);
            const b = this.getBounds();
            rows.push(["Selection", b ? `${b[2] - b[0]} × ${b[3] - b[1]}` : "none (whole image)"]);
            const [, , cw, ch] = this.cropRect();
            const ap = this.autoParams();
            rows.push(["Crop", `${cw} × ${ch}` + (ap && this.cropSettings.context === "auto" ? ` (context ${ap.pad} px)` : "")]);
            if (ap) rows.push(["Edge", this.cropSettings.feather === "auto" ? `grow ${ap.grow}, feather ${ap.feather}, blend ${ap.blend} px` : `feather ${this.widgetValue("feather", 0)} px`]);
            const target = this.widgetValue("target_size", 0);
            const m = Math.max(1, this.widgetValue("multiple_of", 64) || 64);
            // the node's batch: the crop, the Original (not on a refine pass, which fills nothing), the references; a
            // local recipe of the app sends only those its graph reads (host.refLayout, 26e)
            const refine = this.genSettings.mode === "local" && !!this.genSettings.refine;
            const shown = this.referenceLayers();
            const lay = host.refTokens ? this.refLayoutInfo : null;
            const sent = lay && lay.names ? shown.filter((l) => lay.names.get(l.id)) : shown;
            const nBatch = 1 + (b && !refine && this.cropSettings.withOriginal && this.cropSettings.fill && this.cropSettings.fill !== "none" ? 1 : 0) + (lay && lay.local && lay.names ? sent.length : shown.length);
            const pair = nBatch > 1 ? ` ×${nBatch} (batch)` : "";
            if (target > 0) {
                const s = target / Math.max(cw, ch);
                const ew = Math.max(m, Math.round(cw * s / m) * m), eh = Math.max(m, Math.round(ch * s / m) * m);
                const distort = Math.abs((ew / eh) / (cw / ch) - 1) * 100;
                const warn = distort >= 1.5 ? ` · aspect ${distort.toFixed(1)} % off, stretched back on stitch` : "";
                rows.push(["Emitted", `${ew} × ${eh}${pair}${warn}`]);
                rows.push(["Paste", this.cropSettings.paste === "crop" ? "whole crop" : "selection only"]);
            } else {
                rows.push(["Emitted", `${Math.min(this.width, Math.ceil(cw / m) * m)} × ${Math.min(this.height, Math.ceil(ch / m) * m)}${pair}`]);
            }
            const ctrl = this.layers.filter((l) => this.isControl(l) && this.shown(l)).length;
            rows.push(["Control", ctrl ? `${ctrl} layer${ctrl > 1 ? "s" : ""}` : "none (black)"]);
            const refs = shown.length;
            // a route that sends the references as style references (Magnific's Ideogram) or in a list of their own
            // (Ideogram 4.5) gives them no number: they go, unnamed
            if (lay && lay.style && refs && !lay.none) rows.push(["References", `${refs} image${refs > 1 ? "s" : ""} without a number (style or unnumbered references)`]);
            else if (lay && lay.names && refs && !lay.none) {
                // the app: what each shown reference goes as ("img1 → <image3>"), what is left out, and a guessed wording
                const labels = this.refLabels();
                const arrows = sent.map((l) => `img${labels.get(l.id)} → ${lay.names.get(l.id)}`);
                const left = shown.filter((l) => !lay.names.get(l.id)).map((l) => `img${labels.get(l.id)}`);
                rows.push(["References", (arrows.length ? arrows.join(", ") + (lay.local ? ` (${this.refSettings.fit})` : "") : "none sent")
                    + (left.length ? ` · ${left.join(", ")} not sent` : "") + (lay.guess ? " · wording guessed from the graph" : "")]);
            } else if (lay && lay.none && refs) rows.push(["References", `none sent: ${lay.none}`]);
            else rows.push(["References", refs ? `${refs} image${refs > 1 ? "s" : ""} in crop_image (${this.refSettings.fit})` : "none"]);
            const rs = this.resultInputState();
            rows.push(["Result", `${this.genSettings.mode} → ${rs.name}${rs.wired ? (rs.fallback ? " (only input wired)" : "") : " (not wired!)"}` + (this.genSettings.mode === "local" && this.genSettings.refine ? " · refine" : "")]);
        }
        // as text: a name such as "<image3>" is no tag
        this.infoEl.replaceChildren(...rows.flatMap(([k, v]) => {
            const key = document.createElement("span"), val = document.createElement("b");
            key.textContent = k; val.textContent = v;
            return [key, val];
        }));
        if (this.canvasInfo) this.canvasInfo.textContent = this.frameInfoText();
    }

    // ---- layers: management ------------------------------------------------

    /**
     * A new base from a file in the mirror (`ref`), all else dropped: a large one decoded off the window on tiles.
     * Another picture is not the canvas a preset was made for: Generate new's preset (`genSettings.target`, item 34)
     * goes with the old one, as in loadFile (Generate new's own base, setBaseFromCanvas, keeps it: the run writes it).
     */
    async setBaseFromRef(ref) {
        const before = this.base;
        try {
            if (TIFF_EXT.test(ref.filename || "")) {
                const blob = await (await fetch(viewUrl(ref))).blob();
                if (await isTiffFile(blob)) {
                    const info = await tiffInfo(blob);
                    this.checkBaseSize(info.width, info.height);
                    const { px } = await pixelsFromTiff(blob, this.pixels.Layer);
                    const up = await uploadPixels(px, String(ref.filename).replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]/gi, "_") || "image");
                    return await this.setBasePixels(up.ref, px, { keepLayers: false });
                }
            }
            if (this.tileMode) {
                const blob = await (await fetch(viewUrl(ref))).blob();
                const big = (await hugePngSize(blob)) || (await imageFileSize(blob));
                if (big) this.checkBaseSize(big.width, big.height);
                const px = big ? await pixelsOffThread(blob, this.pixels.Layer) : null;
                if (px) return await this.setBasePixels(ref, px, { keepLayers: false });
                return await this.setBase(ref, await imageOfBlob(blob), { keepLayers: false });
            }
            return await this.setBase(ref, await loadImageEl(viewUrl(ref)), { keepLayers: false });
        } finally {
            if (this.base !== before && this.genSettings && this.genSettings.target) { delete this.genSettings.target; this.notifyChanged(); }
        }
    }

    /** A new base from an <img> (or a canvas with `naturalWidth` / `naturalHeight`): its pixels are made here, the image is not kept. */
    async setBase(ref, img, opts = {}) {
        const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        this.checkBaseSize(w, h);   // before the decode
        return this.setBasePixels(ref, this.pixels.Layer.fromImage(img, w, h), opts);
    }

    // On tiles an image above Chromium's canvas limit decodes into tiles, but nothing in C2 can show, export
    // or save it (the display mirror, toCanvas and the selection's PNG need one canvas of it), and the first
    // autosave stored the tab as "{}" (C2's final review). Refused before anything changes; C3 draws tiles and
    // E streams exports, which lift it. The canvas backend is left as it was.
    checkBaseSize(w, h) {
        if (!this.tileMode) return;
        // E5: above the canvas limit of 268 MP a document lives on tiles only. What still bounds it: a band of it is a
        // canvas (65,535 px a side), and its base alone is 4 bytes a pixel of memory (4 GB at a gigapixel).
        if (w > HUGE_MAX_SIDE || h > HUGE_MAX_SIDE || w * h > HUGE_MAX_PIXELS) {
            throw new Error(`${w} × ${h} px is above what a document can hold (${HUGE_MAX_SIDE.toLocaleString()} px a side, ${Math.round(HUGE_MAX_PIXELS / 1e6)} MP)`);
        }
        if (w * h > CANVAS_MAX_PIXELS && !partsUsable()) {
            throw new Error(`${w} × ${h} px is above the canvas limit of 268 MP, and a document that large needs the worker pool and the compiled pixel kernels, which are not available here`);
        }
    }

    /** Is this document larger than any canvas (268 MP)? Then nothing may ask for a canvas, a bitmap or an ImageData of it. */
    get huge() { return this.width * this.height > CANVAS_MAX_PIXELS; }

    /**
     * A new base from pixels the caller made for it (and does not write again); `ref` is their file in the mirror.
     * `keep`: layers that stay when the others go (Generate new's reference layers, 26f): kept as they are, and on a size
     * change placed again the way a new reference is (referenceBox), their masks, opacity and visibility unchanged.
     */
    async setBasePixels(ref, px, { keepLayers = true, keep = null } = {}) {
        this._blankBase = false;   // the new-canvas path sets it again after this call (the Generate new question, issue #12)
        // the app's Each area (eacharea.js): its areas were cut from the picture there is now
        if (this._eachArea) throw refusal("Each area is running on this document: a new picture waits until it is done, or stop it.");
        this.checkBaseSize(px.width, px.height);
        const sizeChanged = px.width !== this.width || px.height !== this.height;
        this.historyGen++;   // a restore still loading must not put the old document over the new image
        this.endLiquify();
        this.liqFreezes = null;
        this.base = { ref, px };
        this.width = px.width;
        this.height = px.height;
        this._rangeTint = null;
        this.mapView = null;
        this.maskView = null;
        this._pendingPick = null;
        this._pendingPickTarget = null;
        if (this.depthViewBtn) this.depthViewBtn.classList.remove("ipc-toggle-on");
        // the history goes with the layers: a step of the old document applied to a new image put
        // its layers (or its base, for a crop) back on top of it
        if (!keepLayers || sizeChanged) {
            // the kept layers are in the list before the detached release below looks for live pixels
            this.layers = keep ? keep.slice() : [];
            if (keep && sizeChanged) this.layers.forEach((l, k) => { if (l.px) Object.assign(l, this.referenceBox(l.px, k)); });
            this.activeLayerId = null;
            this.clearUndo();
            // the ids and the order of kept references are unchanged: the labels stay, nothing is rewritten
            this.refsRebuilt();
        }
        if (!keepLayers) this.clearSnapshots();   // a new picture is a new document: the snapshots were of the old one
        if (!this.sel || sizeChanged) {
            this.sel = this.pixels.Mask.empty(this.width, this.height);
            this.clearUndo();
        }
        this.uploaded.baseHash = null;
        this.uploaded.baseRef = null;
        this.uploaded.controlHash = null;
        this.dropHint.style.display = "none";
        this.selectionDirty = true; this.selectionLoose = false;
        this.selectionDataUrl = null;
        this.selectionEncoded = false;
        this.scheduleDetachedRelease();   // the old layers' atlas pages go (C6 a); the old base's, the base setter queues
        this.flatCache = null;
        this.sceneSig = null;
        this.touchSource(this.sel);
        this.renderLayers();
        this.renderInfo();
        this.fitView();
        this.drawThumb();
        this.setStatus(`${this.width} × ${this.height}`);
        this.notifyChanged();
    }

    async loadFile(file, { size = null, ask = true } = {}) {
        if (!file) return;
        // an open that is still decoding (a large file in a worker takes seconds, the window stays usable) must not land
        // over a later one: the last file asked for is the base
        const token = (this._openToken = (this._openToken || 0) + 1);
        // a closed tab's open is over too: its read stops at its next band and nothing reaches the local store
        const later = () => this._destroyed || this._openToken !== token;
        const before = this.base;
        try {
            const layered = await layeredKind(file);
            if (layered) { await this.loadLayered(file, layered, later); return; }
            if (await isTiffFile(file)) { await this.loadTiff(file, later); return; }
            if (isSvgFile(file)) {
                const target = await this.svgTarget(file, { size, ask });
                if (!target) { this.setStatus("Import cancelled."); return; }
                this.setStatus(`Rasterising ${file.name || "the SVG"} at ${target.width} × ${target.height} ...`);
                file = await rasterizeSvg(file, target);
            }
            const ext = await storedExt(file);
            // E5: a PNG larger than any canvas is decoded as a stream into tiles (the browser's decoder has nowhere to put
            // it); any other large file is decoded in a pool worker, so the window never holds the whole picture
            const big = this.tileMode ? (await hugePngSize(file)) || (await imageFileSize(file)) : null;
            if (big) this.checkBaseSize(big.width, big.height);
            if (later()) return;
            this.setStatus("Uploading " + (file.name || "image") + " ...");
            const stem = (file.name || "pasted").replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]/gi, "_") || "image";
            const up = uploadBlob(file, stem + ext, { overwrite: false });
            up.catch(() => {});
            let px = null, ref = null;
            try {
                if (big) px = await pixelsOffThread(file, this.pixels.Layer, (f) => { if (!later()) this.setStatus(`Reading ${big.width} × ${big.height} px ... ${Math.round(f * 100)} %`); });
                if (later()) { if (px) px.release(); return; }
                if (px) this.setStatus("Uploading " + (file.name || "image") + " ...");
                ref = await up;
            } catch (err) {
                if (px) px.release();
                throw err;
            }
            if (later()) { if (px) px.release(); return; }
            if (px) {
                await this.setBasePixels(ref, px, { keepLayers: false });
                return;
            }
            const img = await loadImageEl(viewUrl(ref));
            if (later()) return;
            await this.setBase(ref, img, { keepLayers: false });
        } catch (err) {
            console.error(err);
            this.setStatus(String(err.message || err), failKind(err));
        } finally {
            // another picture (open, drag and drop, paste, load_image) is not the canvas a preset was made for: Generate
            // new's preset (`genSettings.target`, item 34) goes with the old one, even at the same size
            if (this.base !== before && this.genSettings && this.genSettings.target) { delete this.genSettings.target; this.notifyChanged(); }
        }
    }

    /**
     * Open a TIFF (inpaint_tiff.js, docs/PLAN_0_1_29.md 3d). The header first, so a file that is not read, or is too
     * large, is refused before anything is stored; then the pixels as a stream. The base goes to the local store as a
     * PNG, so the autosave, a document and ComfyUI never see the TIFF.
     */
    async loadTiff(file, later = () => false) {
        const start = markStep("tiff_open", "start");   // its w and h once the header is read
        const name = file.name || "the TIFF";
        const info = await tiffInfo(file);
        start.w = info.width; start.h = info.height;
        this.checkBaseSize(info.width, info.height);
        markStep("tiff_open", "info");
        if (later()) return;
        let px = null, got = null, writeMs = 0;
        try {
            ({ px, info: got, writeMs } = await pixelsFromTiff(file, this.pixels.Layer, (f) => { if (!later()) this.setStatus(`Reading ${info.width} × ${info.height} px ... ${Math.round(f * 100)} %`); }, later));
        } catch (err) {
            if (later()) return;
            throw err;
        }
        markStep("tiff_open", "pixels", { writeMs });
        if (later()) { px.release(); return; }
        const stem = (file.name || "image").replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]/gi, "_") || "image";
        this.setStatus(`Storing ${name} ...`);
        const { ref } = await uploadPixels(px, stem);
        markStep("tiff_open", "stored");
        if (later()) { px.release(); return; }
        await this.setBasePixels(ref, px, { keepLayers: false });
        markStep("tiff_open", "base");
        const notes = ((got && got.notes) || info.notes || []).filter(Boolean);
        this.setStatus(`Opened ${name}: ${info.width} × ${info.height}${notes.length ? "; " + notes.join("; ") : ""}.`, notes.length ? "warn" : "info");
    }

    /**
     * A PSD or ORA file read into pixels (inpaint_layered.js): `{ width, height, layers, composite, notes }`, each
     * layer with `px` (this backend's pixels) in place of its bytes, bottom first. `later()` true: the open is over (a
     * later one, a closed tab), and a PSD read in a worker stops at its next band (a CancelledError).
     */
    async readLayered(file, kind, later = () => false) {
        markStep("layered_open", "start", { kind });
        this.setStatus(`Reading the layers of ${file.name || "the file"} ...`);
        if (kind === "psd" && psdOnPool(file)) {
            const got = await this.readPsdOnPool(file, later);
            if (got) {
                const t = got.timing || {};
                markStep("layered_open", "parsed", { route: "pool", inflateMs: t.inflate || 0, inflates: t.inflates || 0 });
                markStep("layered_open", "layers", { maskMs: got.maskMs, rgbaMs: got.rgbaMs, bitmapMs: 0, fromImageMs: 0 });
                return got.doc;
            }
        }
        // an ORA stays the file (K20c, readOraBlob): its directory, stack.xml and each layer's header are read as slices
        const bytes = kind === "psd" ? new Uint8Array(await file.arrayBuffer()) : null;
        markStep("layered_open", "read", { MB: bytes ? bytes.length / 1048576 : 0 });
        // the K0a harness: the inflates' time (they run one after another), and the layer loop's parts below
        let inflateMs = 0, inflates = 0, maskMs = 0, rgbaMs = 0, t0 = 0;
        const spent = { streamMs: 0, bitmapMs: 0, fromImageMs: 0 };
        // each inflate stops at the bytes the reader keeps (inpaint_layered.js inflateAtMost, the pool's inflater too)
        const timed = async (b, format, cap) => {
            const t = performance.now();
            try { return await inflateAtMost(b, format, cap); } finally { inflateMs += performance.now() - t; inflates++; }
        };
        // the size is checked from the header before anything else is read or made (H1 S5), as the pool route does
        const onHeader = (h) => this.checkLayeredSize(h.width, h.height);
        const doc = kind === "psd" ? await readPsd(bytes, { inflate: (b, cap) => timed(b, "deflate", cap), onHeader })
            : await readOraBlob(file, { inflateRaw: (b, cap) => timed(b, "deflate-raw", cap), onHeader });
        markStep("layered_open", "parsed", { inflateMs, inflates });
        this.checkLayeredSize(doc.width, doc.height);
        // the bottom layer's PNG, kept for loadLayered's base upload (oraBaseUpload): the decode below lets go of L.pngBlob
        if (kind === "ora") doc.basePng = (doc.layers[0] && doc.layers[0].pngBlob) || null;
        try {
            for (let i = 0; i < doc.layers.length; i++) {
                const L = doc.layers[i];
                if (later()) throw new CancelledError("layered_open");
                // a PSD mask (docs/PLAN_0_1_31.md 3e): one value per pixel of the layer, as the mask's alpha
                if (L.mask && L.mask.data) {
                    t0 = performance.now();
                    const m = new ImageData(L.w, L.h), d = m.data, v = L.mask.data;
                    for (let j = 0, o = 0; j < v.length; j++, o += 4) { d[o] = 255; d[o + 1] = 255; d[o + 2] = 255; d[o + 3] = v[j]; }
                    L.maskPx = this.pixels.Mask.fromImageData(m);
                    L.maskOff = !!L.mask.disabled;
                    maskMs += performance.now() - t0;
                }
                L.mask = null;
                if (L.rgba) {
                    t0 = performance.now();
                    L.px = this.pixels.Layer.fromImageData(new ImageData(L.rgba, L.w, L.h)); L.rgba = null;
                    rgbaMs += performance.now() - t0;
                    continue;
                }
                this.setStatus(`Reading the layers of ${file.name || "the file"} ... layer ${i + 1} of ${doc.layers.length}`);
                await this.decodeOraLayer(L, spent);
                if (later()) throw new CancelledError("layered_open");
            }
        } catch (err) {
            // nothing of a read that ends here is kept: the layers decoded so far hold tiles
            for (const x of doc.layers) {
                if (x.px) { x.px.release(); x.px = null; }
                if (x.maskPx) { x.maskPx.release(); x.maskPx = null; }
            }
            throw err;
        }
        markStep("layered_open", "layers", { maskMs, rgbaMs, ...spent });
        return doc;
    }

    /**
     * K20c: one ORA layer's PNG (`L.pngBlob`) into `L.px`, `L.w`, `L.h`. On tiles a PNG of 8 bits, not interlaced, is
     * decoded by the pool (`pixelsFromPngStream`), so the window neither decodes it nor reads a canvas back. Everything
     * else goes through the browser's decoder, and so does a stream that fails: that decoder says last whether a file
     * is damaged, except for a parted PNG the pool refused twice and for one larger than any canvas.
     * `InpaintEditor.oraParted = false` keeps every layer on the browser's decoder.
     */
    async decodeOraLayer(L, spent) {
        const blob = L.pngBlob;
        if (this.tileMode && InpaintEditor.oraParted !== false && pngReaderUsable()) {
            const h = pngHeader(new Uint8Array(await blob.slice(0, 33).arrayBuffer()));
            if (h && h.bitDepth === 8 && !h.interlace) {
                const t0 = performance.now();
                try {
                    const px = await pixelsFromPngStream(blob, this.pixels.Layer);
                    L.px = px; L.w = px.width; L.h = px.height; L.pngBlob = null;
                    return;
                } catch (err) {
                    if ((err && err.partedRefused) || h.width * h.height > CANVAS_MAX_PIXELS) throw err;
                    console.warn("Inpaint Canvas: an ORA layer could not be read as a stream, using the image decoder:", (err && err.message) || err);
                } finally { spent.streamMs += performance.now() - t0; }
            }
        }
        let t0 = performance.now();
        const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
        spent.bitmapMs += performance.now() - t0;
        L.w = bmp.width; L.h = bmp.height;
        t0 = performance.now();
        try { L.px = this.pixels.Layer.fromImage(bmp, bmp.width, bmp.height); } finally { bmp.close(); }
        spent.fromImageMs += performance.now() - t0;
        L.pngBlob = null;
    }

    /**
     * K20c, the design's question 3: an ORA's bottom layer that became the base goes up as its own PNG, in place of a
     * new PNG encoded from `basePx`. Only a PNG the decoders read alike and a plain sRGB one (8 bits, not interlaced, no
     * colour chunk, the picture's size). `loadLayered` asks for it after the layers were read and the open is still
     * wanted (the review of 2026-11-11: never on an ORA dropped into a document, never for an open that ended early), so
     * nothing lands in the local store for an open that is over. The ref, or null and `loadLayered` encodes as before
     * (also when this upload fails). `InpaintEditor.oraParted = false` encodes too.
     */
    async oraBaseUpload(doc, file) {
        const b = doc.layers[0];
        const png = doc.basePng;
        if (!b || !png || InpaintEditor.oraParted === false) return null;
        if (!(b.x === 0 && b.y === 0 && b.visible && b.opacity >= 0.999 && b.blend === "normal")) return null;
        const h = pngHeader(new Uint8Array(await png.slice(0, 33).arrayBuffer()));
        if (!h || h.bitDepth !== 8 || h.interlace || h.width !== doc.width || h.height !== doc.height) return null;
        if (!(await pngIsPlainSrgb(png))) return null;
        try { return await uploadBlob(png, layeredStem(file) + ".png", { overwrite: false }); } catch (err) {
            console.warn("[Inpaint Canvas] the ORA's base PNG did not upload as it is; encoding it instead:", err);
            return null;
        }
    }

    /** A layered file's size against what this document can open: the document's bounds, then the canvas limit. */
    checkLayeredSize(w, h) {
        this.checkBaseSize(w, h);
        if (w * h > CANVAS_MAX_PIXELS) throw new Error(`${w} × ${h} px is larger than a layered file can be opened at (268 MP); save it as PNG`);
    }

    /**
     * D0 (docs/PLAN_WASM_BUILD.md §7): a PSD read by a pool worker (`psd_read`, inpaint_layered.js `readPsdStream`), its
     * layers and masks written into this backend's pixels band by band as they arrive, so the window never runs the
     * reader's loops and makes no array of the file. `{ doc, rgbaMs, maskMs, timing }`, `doc` as readLayered answers
     * it (each layer with `px`, a masked one with `maskPx` and `maskOff`; a file without layers with `compositePx`, the
     * merged picture, which is read only then), or null when the pool could not take the job before any band came: the
     * caller reads the file on this thread. The size is checked here from the header's 26 bytes before the job is
     * queued, so a file too large costs no worker and no read; a file the reader refuses throws its message as the
     * window's reader would; `later()` true stops the job at its next band (a CancelledError, the worker counted as
     * stopped, not lost). Paced (K20b review): the worker has at most `PSD_WINDOW` bands (the route `psdWindow`; 0 =
     * unpaced) posted and not yet acknowledged here after their `writeRect`.
     */
    async readPsdOnPool(file, later = () => false) {
        const head = new Uint8Array(await file.slice(0, 26).arrayBuffer());
        if (head.length >= 26) {
            // the reader's order of checks: signature and version, mode, depth, then the size (a refusal of the first
            // three is the worker's, in the reader's own words)
            const v = new DataView(head.buffer, head.byteOffset, head.length);
            const mode = v.getUint16(24), depth = v.getUint16(22);
            if (v.getUint32(0) === 0x38425053 && v.getUint16(4) === 1 && (mode === 3 || mode === 1) && (depth === 8 || depth === 16)) this.checkLayeredSize(v.getUint32(18), v.getUint32(14));
        }
        if (later()) throw new CancelledError("psd_read");
        const Layer = this.pixels.Layer, Mask = this.pixels.Mask;
        const made = new Map();   // stream index -> { px, maskPx }
        const name = file.name || "the file";
        let refused = null, stopped = false, bands = 0, rgbaMs = 0, maskMs = 0;
        const drop = () => { for (const e of made.values()) for (const p of [e.px, e.maskPx]) if (p) p.release(); made.clear(); };
        let r;
        // the acknowledgement window (inpaint_worker.js psdRead): each band acknowledged after its writeRect, so the
        // worker never has more than `win` bands queued ahead of this window's other tasks (timers, input, paint)
        const routedWin = kernelRoute("psdWindow"), win = routedWin === undefined ? PSD_WINDOW : routedWin;
        let pool = null;
        try {
            pool = editorPool();
            // "fail": a harness's way to see the fallback (an op no worker knows)
            r = await pool.run(InpaintEditor.psdOnPool === "fail" ? "psd_read_refused" : "psd_read", { blob: file, window: win }, [], {
                timeout: 600000,
                onProgress: (m) => {
                    if (later()) { stopped = true; throw new CancelledError("psd_read"); }
                    try {
                        const t0 = performance.now();
                        let e = made.get(m.index);
                        if (!e) made.set(m.index, (e = { px: null, maskPx: null }));
                        const key = m.mask ? "maskPx" : "px";
                        if (!e[key]) e[key] = (m.mask ? Mask : Layer).empty(m.w, m.h);
                        e[key].writeRect({ data: new Uint8ClampedArray(m.rgba), width: m.w, height: m.rows }, 0, m.y0);
                        if (m.mask) maskMs += performance.now() - t0; else rgbaMs += performance.now() - t0;
                        bands++;
                        if (win) pool.ack(m.id, bands);
                        if (!m.mask) this.setStatus(`Reading the layers of ${name} ... layer ${made.size}, ${Math.round(((m.y0 + m.rows) / m.h) * 100)} %`);
                    } catch (err) { refused = err; throw err; }
                },
            });
        } catch (err) {
            drop();
            if (stopped) throw new CancelledError("psd_read");
            if (refused) throw refused;
            // the job could not run (no pool, an op no worker knows): the window's reader. A worker lost after bands
            // came (most likely out of memory at this size) is not read again here, which needs more memory still
            if (bands) throw new Error(`reading ${name} failed in its worker: ${(err && err.message) || err}`);
            console.warn("Inpaint Canvas: reading the PSD in a worker failed, reading it here:", (err && err.message) || err);
            return null;
        }
        if (r && r.failed) { drop(); throw new Error(r.failed); }
        if (!r || !r.doc) { drop(); throw new Error(`reading ${name} failed in its worker: no answer`); }
        const doc = r.doc, taken = [];
        const take = (i, what) => {
            const e = made.get(i);
            if (!e || !e.px) throw new Error(`the PSD worker sent no pixels for ${what}`);
            made.delete(i);
            taken.push(e);
            return e;
        };
        try {
            for (const L of doc.layers) {
                const e = take(L.index, `layer "${L.name}"`);
                L.px = e.px;
                if (L.mask) {
                    if (!e.maskPx) throw new Error(`the PSD worker sent no mask for layer "${L.name}"`);
                    L.maskPx = e.maskPx;
                    L.maskOff = !!L.mask.disabled;
                } else if (e.maskPx) { e.maskPx.release(); e.maskPx = null; }
                L.mask = null;
                delete L.index;
            }
            if (doc.composite != null) doc.compositePx = take(doc.composite, "the merged picture").px;
            doc.composite = null;
        } catch (err) {
            for (const e of taken) for (const p of [e.px, e.maskPx]) if (p) p.release();
            drop();
            throw err;
        }
        drop();   // bands the answer names no layer for
        return { doc, rgbaMs, maskMs, timing: r.timing || null };
    }

    /**
     * Open a PSD or ORA with its layers. The bottom layer becomes the base when it covers the whole picture, is
     * visible, opaque in the normal mode (what Photoshop's Background and the editor's own export are); otherwise the
     * base is transparent and every layer stays a layer. A flat PSD opens from its merged picture.
     */
    async loadLayered(file, kind, later = () => false) {
        let doc;
        try { doc = await this.readLayered(file, kind, later); } catch (err) { if (later()) return; throw err; }
        // an open that is over (a later one, a closed tab) lets go of what its read made
        const dropDoc = (also = null) => {
            const seen = new Set();
            for (const p of [...doc.layers.flatMap((L) => [L.px, L.maskPx]), doc.compositePx, also]) if (p && !seen.has(p)) { seen.add(p); p.release(); }
        };
        if (later()) { dropDoc(); return; }
        const W = doc.width, H = doc.height;
        const layers = doc.layers.slice();
        let basePx = null;
        const b = layers[0];
        if (b && b.x === 0 && b.y === 0 && b.w === W && b.h === H && b.visible && b.opacity >= 0.999 && b.blend === "normal" && !b.maskPx) { basePx = b.px; layers.shift(); }
        // a layer clipped to what became the base would show "clipped without effect": the base covers the picture anyway
        if (basePx) for (const L of layers) { if (!L.clip) break; L.clip = false; }
        else if (!layers.length && doc.compositePx) basePx = doc.compositePx;   // D0's pool route: already pixels
        else if (!layers.length && doc.composite) basePx = this.pixels.Layer.fromImageData(new ImageData(doc.composite, W, H));
        else basePx = this.pixels.Layer.empty(W, H);
        if (doc.compositePx && basePx !== doc.compositePx) { doc.compositePx.release(); doc.compositePx = null; }
        this.setStatus(`Storing ${file.name || "the file"} ...`);
        const raw = kind === "ora" && basePx === b?.px ? await this.oraBaseUpload(doc, file) : null;
        const ref = raw || (await uploadPixels(basePx, layeredStem(file))).ref;
        markStep("layered_open", "stored");
        if (later()) { dropDoc(basePx); return; }
        await this.setBasePixels(ref, basePx, { keepLayers: false });
        markStep("layered_open", "base");
        let top = null;
        // PSD groups as folders (PLAN_0_1_31 §6.5), with ids of this document
        this.groupCounter = (this.groupCounter || 0) + 1;
        const gid = new Map((doc.groups || []).map((g, i) => [g.id, "G" + Date.now().toString(36) + this.groupCounter + "_" + i]));
        this.groups = (doc.groups || []).map((g) => ({ id: gid.get(g.id), name: g.name, visible: g.visible !== false, locked: false, collapsed: !!g.collapsed, parent: g.parent ? gid.get(g.parent) || null : null }));
        this.holdGroups = (this.holdGroups || 0) + 1;   // the groups wait for their layers: addLayer's list would drop them as empty
        try {
            for (const L of layers) top = this.addLayer({ name: L.name, kind: "image", ref: null, group: L.group ? gid.get(L.group) || null : null, px: L.px, x: L.x, y: L.y, w: L.w, h: L.h, opacity: L.opacity, visible: L.visible, blend: normalBlend(L.blend), dirty: true, maskPx: L.maskPx || null, maskOff: !!L.maskOff, maskDirty: !!L.maskPx, clip: !!L.clip }, { activate: false });
        } finally { this.holdGroups--; }
        if (top) this.activeLayerId = top.id;
        this.renderLayers();
        this.draw();
        markStep("layered_open", "added");
        const n = layers.length;
        this.setStatus(`Opened ${file.name || "the file"}: ${W} × ${H}, ${n} layer${n === 1 ? "" : "s"}${basePx === b?.px ? ` over "${b.name}" as the base` : ""}.${doc.notes.length ? " " + doc.notes.join("; ") + "." : ""}`, doc.lossy ? "warn" : "info");
    }

    /** The pixel size an SVG is rasterised at: the caller's `size` ([w, h], one of them may be 0 for
     *  "keep the aspect"), else fitted into `fit` (a document), else the file's own size when it declares
     *  one and 2048 on the long side when it only has a viewBox; the size dialog confirms it when `ask`. */
    async svgTarget(file, { size = null, ask = true, fit = null } = {}) {
        const info = svgSize(await file.text());
        const ratio = info.width / info.height;
        let w, h;
        if (size && size[0] > 0 && size[1] > 0) { w = size[0]; h = size[1]; }
        else if (size && size[0] > 0) { w = size[0]; h = w / ratio; }
        else if (size && size[1] > 0) { h = size[1]; w = h * ratio; }
        else if (fit && fit[0] > 0 && fit[1] > 0) { const k = Math.min(fit[0] / info.width, fit[1] / info.height); w = info.width * k; h = info.height * k; }
        else if (info.declared && info.width <= 16384 && info.height <= 16384) { w = info.width; h = info.height; }
        else { const k = 2048 / Math.max(info.width, info.height); w = info.width * k; h = info.height * k; }
        w = Math.min(16384, Math.max(1, Math.round(w))); h = Math.min(16384, Math.max(1, Math.round(h)));
        if (ask && !size && !fit) {
            const answer = await this.ask({
                title: "Import SVG",
                message: `${file.name || "The file"} is a vector drawing and has no pixel size of its own. Rasterise it at:`,
                fields: [{ key: "width", label: "Width", value: w, min: 1, max: 16384 }, { key: "height", label: "Height", value: h, min: 1, max: 16384 }],
                linked: "on",
                ok: "Import",
            });
            if (answer == null) return null;
            w = Math.min(16384, Math.max(1, Math.round(answer.width))); h = Math.min(16384, Math.max(1, Math.round(answer.height)));
        }
        return { width: w, height: h };
    }

    /**
     * `p` as pixels of this editor's backend. The editor makes all of its pixels itself, so only a
     * caller outside it can hand in pixels of the other backend (a test, a plugin that built its own):
     * strict mode (dev builds) throws, so a gate finds the mix; otherwise they are converted once
     * with a warning.
     */
    ownPixels(p) {
        if (!(p instanceof LayerPixels) || p.constructor.backend === this.pixels) return p;
        const msg = `Inpaint Canvas: pixels of the ${this.tileMode ? "canvas" : "tile"} backend handed to an editor on ${this.tileMode ? "tiles" : "canvases"}; make them with editor.pixels`;
        if (pixelsOptions().strict) throw new Error(msg);
        if (!InpaintEditor._mixWarned) { InpaintEditor._mixWarned = true; console.warn(msg + " (converted)"); }
        const B = p instanceof MaskPixels ? this.pixels.Mask : this.pixels.Layer;
        return this.tileMode ? B.fromCanvas(p.toCanvas()) : B.fromImage(p.toCanvas());
    }

    // ---- compositing -------------------------------------------------------

    // ---- display pyramid and viewport composite (docs/PERFORMANCE.md phase 1) ----

    /**
     * Mark a source (LayerPixels / MaskPixels, or a canvas of the editor's own caches) as
     * changed: its cached display levels are dropped and the composited scene is rebuilt on
     * the next draw. Call this wherever pixels of the base, a layer, a mask or the selection
     * are written: a write does not bump the version by itself.
     */
    touchSource(src) {
        this.pixelVersion++;
        if (src instanceof LayerPixels) { this.checkBackend(src); src.touch(); }
        else if (src) src._dispVer = (src._dispVer || 0) + 1;
    }

    /**
     * Pixels the editor was told changed must be of its own backend. Every write reaches the display
     * through touchSource / touchSourceRect, so a site that made pixels with the other backend's classes
     * (a flip, an undo restore) is found here, not only pixels handed to addLayer (C2 step b's review):
     * strict mode (dev builds, the gates) throws, otherwise a warning once.
     */
    checkBackend(p) {
        if (p.constructor.backend === this.pixels) return;
        const msg = `Inpaint Canvas: an editor on ${this.tileMode ? "tiles" : "canvases"} holds pixels of the ${this.tileMode ? "canvas" : "tile"} backend; make them with editor.pixels`;
        if (pixelsOptions().strict) throw new Error(msg);
        if (!InpaintEditor._mixWarned) { InpaintEditor._mixWarned = true; console.warn(msg); }
    }

    /**
     * Pixels of `src` changed inside a rectangle (source pixels): refresh the cached levels
     * there instead of dropping them. A brush dab would otherwise cost a full rebuild of
     * the pyramid, which is 200 ms on a 96 MP source.
     */
    touchSourceRect(pixels, x0, y0, x1, y1) {
        this.pixelVersion++;
        if (!pixels) return;
        if (pixels instanceof LayerPixels) this.checkBackend(pixels);
        // The display levels are keyed on the display canvas (C3 replaces both). Pixels without one
        // (tiles nothing has drawn yet, or whose mirror was released) have no levels to keep either:
        // touched only, so a write into a hidden layer or a tab in the background does not make a
        // mirror as large as the pixels just to find nothing to refresh (C2 step b's review).
        const src = displayCanvasIfMade(pixels);
        if (!src) { pixels.touch([x0, y0, x1, y1]); return; }
        // The GPU compositor keeps one texture per source and version, so pixels that changed
        // have to raise the version even when the cached levels are kept: without this a brush
        // stroke or an erase sits in the canvas and never reaches the screen.
        const entry = this.pyramids.get(src);
        const keep = !!(entry && entry.version === (src._dispVer || 0));
        if (pixels instanceof LayerPixels) pixels.touch([x0, y0, x1, y1]);
        else src._dispVer = (src._dispVer || 0) + 1;
        if (!keep) return;
        entry.version = src._dispVer;   // the levels are refreshed below, so they stay valid
        if (!entry.levels.length && !entry.gpu) return;
        const rx0 = Math.max(0, Math.floor(x0) - 1), ry0 = Math.max(0, Math.floor(y0) - 1);
        const rx1 = Math.min(src.width, Math.ceil(x1) + 1), ry1 = Math.min(src.height, Math.ceil(y1) + 1);
        if (rx1 <= rx0 || ry1 <= ry0) return;
        if (entry.gpu) {
            // the screen's GPU copy of a tile mirror: the rectangle copied in unscaled, from the rectangle
            // alone (a draw from the whole CPU mirror would move all of it); the levels then read the copy
            const g = entry.gpu, cx = g.getContext("2d");
            const part = pixels.displayRectSource([rx0, ry0, rx1, ry1]);
            try {
                cx.save();
                cx.setTransform(1, 0, 0, 1, 0, 0);
                cx.globalAlpha = 1;
                cx.globalCompositeOperation = "source-over";
                cx.clearRect(rx0, ry0, rx1 - rx0, ry1 - ry0);
                cx.drawImage(part.canvas, rx0 - part.x, ry0 - part.y, rx1 - rx0, ry1 - ry0, rx0, ry0, rx1 - rx0, ry1 - ry0);
                cx.restore();
            } finally {
                if (part.temp) { part.canvas.width = 1; part.canvas.height = 1; }
            }
            g._dispVer = (g._dispVer || 0) + 1;
        }
        let prev = entry.gpu || src, px0 = rx0, py0 = ry0, px1 = rx1, py1 = ry1;
        for (let i = 0; i < entry.levels.length; i++) {
            const lvl = entry.levels[i];
            if (!lvl) break;
            // the same chain as a full build: level i is drawn from level i - 1
            const f = lvl.width / prev.width, g = lvl.height / prev.height;
            const lx0 = Math.max(0, Math.floor(px0 * f) - 1), ly0 = Math.max(0, Math.floor(py0 * g) - 1);
            const lx1 = Math.min(lvl.width, Math.ceil(px1 * f) + 1), ly1 = Math.min(lvl.height, Math.ceil(py1 * g) + 1);
            if (lx1 <= lx0 || ly1 <= ly0) break;
            const cx = lvl.getContext("2d");
            cx.save();
            cx.setTransform(1, 0, 0, 1, 0, 0);
            cx.globalAlpha = 1;
            // Replace the rectangle, alpha included: clear it and draw over the hole. This used
            // to be one drawImage with globalCompositeOperation "copy", and "copy" applies to
            // the whole canvas in Chromium: everything outside the rectangle was cleared too,
            // so after one erase stroke the display level of the layer held nothing but the
            // strip around the stroke, and a result layer vanished from the screen (not from
            // its pixels) while the eraser was nowhere near its content.
            cx.globalCompositeOperation = "source-over";
            cx.clearRect(lx0, ly0, lx1 - lx0, ly1 - ly0);
            cx.imageSmoothingEnabled = true;
            cx.imageSmoothingQuality = "medium";
            // level 0 reads the pixels: through displayRectSource, which is the canvas itself on the canvas
            // backend (the same draw as always) and the rectangle alone on tiles (a draw from the whole
            // CPU mirror transfers all of it after every write, docs/PLAN_BCE.md §C2 step b)
            const part = i === 0 && !entry.gpu && pixels instanceof LayerPixels
                ? pixels.displayRectSource([Math.floor(lx0 / f) - 4, Math.floor(ly0 / g) - 4, Math.ceil(lx1 / f) + 4, Math.ceil(ly1 / g) + 4])
                : { canvas: prev, x: 0, y: 0, temp: false };
            try {
                cx.drawImage(part.canvas, lx0 / f - part.x, ly0 / g - part.y, (lx1 - lx0) / f, (ly1 - ly0) / g, lx0, ly0, lx1 - lx0, ly1 - ly0);
            } finally {
                if (part.temp) { part.canvas.width = 1; part.canvas.height = 1; }
            }
            cx.restore();
            lvl._dispVer = (lvl._dispVer || 0) + 1;   // this level's pixels changed too
            prev = lvl;
            px0 = lx0; py0 = ly0; px1 = lx1; py1 = ly1;
        }
    }

    /**
     * A cached downscaled copy of a source canvas for drawing at `scale` (destination
     * pixels per source pixel). Levels are successive halvings, so a 12k image is drawn
     * from a 1.5k copy at fit zoom instead of being resampled in full every frame.
     * Live stroke previews change every frame and are never cached. `src` is pixels or a
     * canvas; what comes back is always a canvas to draw from (C3 turns it into a level).
     *
     * `screen`: the result is drawn onto the screen on every frame (the view, its overlays, the
     * GPU compositor). A tile store's display mirror is a CPU canvas, and a draw from a CPU canvas
     * into a GPU canvas moves all of it each time (measured at 6000 × 4000, zoom 1, a filter layer
     * in the stack: 44 ms a pan frame against 3.6 on canvases), so where the mirror itself would be
     * drawn the screen gets a GPU copy of it instead, kept in the pyramid entry and refreshed by
     * rectangles with the levels (C2 step b's review). Exports and runs draw the mirror once and
     * keep nothing.
     */
    displaySource(src, scale, screen = false) {
        src = canvasOf(src);
        if (!src || src._livePreview) return src;
        const w = src.width || src.naturalWidth || 0;
        const h = src.height || src.naturalHeight || 0;
        if (!w || !h || !(scale > 0) || scale >= 0.5 || w * h < PYRAMID_MIN_PX) return screen && src._cpuMirror ? this.gpuCopy(src, w, h) : src;
        let want = 0;
        while (want + 1 < PYRAMID_LEVELS && (1 / (1 << (want + 2))) >= scale) want++;
        const entry = this.pyramidEntry(src, w, h);
        // the screen shows this source from a level now: its full-size GPU copy is not kept in VRAM (the
        // next frame at 0.5 or more makes it again, one transfer of the mirror)
        if (screen && entry.gpu) entry.gpu = null;
        for (let i = 0; i <= want; i++) {
            if (entry.levels[i]) continue;
            // one new level per frame: after a zoom step every source would otherwise build
            // its chain in the same frame (five sources at 24 MP are 200 ms). The frame uses
            // the level it has, drawSoon() comes back for the next one.
            if (this._pyramidBudget <= 0) { this._pyramidPending = true; return entry.levels[i - 1] || src; }
            this._pyramidBudget--;
            const lw = Math.max(1, Math.round(w / (1 << (i + 1))));
            const lh = Math.max(1, Math.round(h / (1 << (i + 1))));
            const c = makeCanvas(lw, lh);
            const cx = c.getContext("2d");
            cx.imageSmoothingEnabled = true;
            cx.imageSmoothingQuality = "medium";
            cx.drawImage(i === 0 ? (entry.gpu || src) : entry.levels[i - 1], 0, 0, lw, lh);
            entry.levels[i] = c;
        }
        return entry.levels[want] || src;
    }

    /** The pyramid entry of a display canvas at its current version (a new, empty one after a change). */
    pyramidEntry(src, w, h) {
        const ver = src._dispVer || 0;
        let entry = this.pyramids.get(src);
        if (!entry || entry.version !== ver || entry.w !== w || entry.h !== h) {
            entry = { version: ver, w, h, levels: [], gpu: null };
            this.pyramids.set(src, entry);
        }
        return entry;
    }

    /**
     * A GPU canvas holding what the CPU display mirror `src` holds (displaySource's `screen`), made
     * with one draw per version of the mirror and refreshed by rectangles in touchSourceRect. The
     * premultiplied pixels are the ones the mirror's own upload would give, so a draw from it is the
     * draw from the mirror.
     */
    gpuCopy(src, w, h) {
        const entry = this.pyramidEntry(src, w, h);
        if (!entry.gpu) {
            const c = makeCanvas(w, h);
            c.getContext("2d").drawImage(src, 0, 0);
            entry.gpu = c;
        }
        return entry.gpu;
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
     * The base drawn into `ctx` at `x, y, w, h` for a full-resolution use (a resize, a merge into the base): on tiles from
     * a canvas made for this draw and let go after it, not the display mirror, which `drawTo` makes and keeps (572 MB at
     * 15000 x 10000 for as long as the tab is in front).
     */
    drawBaseInto(ctx, x, y, w, h) {
        const px = this.basePx;
        if (!isTilePixels(px)) { px.drawTo(ctx, x, y, w, h); return; }
        const c = px.toCanvas();
        try { ctx.drawImage(c, x, y, w, h); } finally { c.width = 1; c.height = 1; }
    }

    /** Upload new base pixels (a PNG in the mirror); on tiles through a canvas made for it and let go. */
    async uploadBase(px) {
        return uploadPixels(px, `n${this.node.id}_base`);
    }

    /**
     * The image rectangle the view shows (a little larger), and the scale to composite it
     * at. Its size depends only on zoom, rotation and window size, never on where the view
     * sits: with a size that changes per frame the viewport canvas would be reallocated on
     * every pan step, which costs more than the composite itself. The rectangle may reach
     * outside the image; the parts outside stay empty.
     */
    viewportRegion() {
        if (!this.width || !this.canvas.width) return null;
        const W = this.canvas.width, H = this.canvas.height;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        // under the straighten preview the screen shows the picture turned: its corners back through the turn
        const tilt = this.viewTilt(), tc = Math.cos(-(tilt || 0)), ts = Math.sin(-(tilt || 0)), hx = this.width / 2, hy = this.height / 2;
        for (const [cx, cy] of [[0, 0], [W, 0], [0, H], [W, H]]) {
            let [ix, iy] = this.canvasToImage(cx, cy);
            if (tilt) { const dx = ix - hx, dy = iy - hy; ix = hx + dx * tc - dy * ts; iy = hy + dx * ts + dy * tc; }
            if (ix < x0) x0 = ix;
            if (ix > x1) x1 = ix;
            if (iy < y0) y0 = iy;
            if (iy > y1) y1 = iy;
        }
        const pad = 4 / Math.max(0.01, this.view.scale);
        const w = Math.ceil(x1 - x0 + 2 * pad) + 1, h = Math.ceil(y1 - y0 + 2 * pad) + 1;
        if (w < 1 || h < 1) return null;
        return { x: Math.floor(x0 - pad), y: Math.floor(y0 - pad), w, h, scale: Math.min(1, this.view.scale) };
    }

    /**
     * The WebGL2 compositor, once per editor and only if this host has WebGL2. Null means
     * the Canvas 2D path does the work, which is also what happens after a failure.
     */
    compositor() {
        if (this._compositor !== undefined) return this._compositor;
        this._compositor = null;
        try {
            if (GLCompositor.available()) {
                this._compositor = new GLCompositor();
                // the tile atlas's budget: settings.memory.atlasMB, put on the editor by the shell
                if (this.atlasMB) this._compositor.setAtlasBudget(this.atlasMB * 1048576);
            }
        } catch (err) {
            console.warn("Inpaint Canvas: no GPU compositor, staying on Canvas 2D:", (err && err.message) || err);
        }
        return this._compositor;
    }

    /**
     * Can the GPU composite this stack? It stacks prepared layer pixels and nothing else,
     * so anything that needs Canvas 2D's own machinery stays on Canvas 2D. None of these
     * is a per-frame cost: painting and transforming are already a fraction of a
     * millisecond after phases 1 and 2, and filter layers keep their chain.
     */
    glCompositeUsable(opts) {
        if (this.compositorOff || opts.forRun || opts.controlOnly) return false;
        if (opts.baseOnly) return !!this.compositor();   // the peek: no layer is drawn, so nothing of theirs can refuse
        if (this.compareShow || this.peekBase) return false;
        if (this.pending) return false;                       // a transform draws with a mesh
        if (this.pointer && this.pointer.layer) return false;  // a live stroke preview changes every frame
        for (const l of this.layers) {
            if (!this.shown(l)) continue;
            if (l.kind === "filter") return false;             // the filter chain is step 2
            if (l.maskEdit) return false;
            const b = l.blend || "normal";
            if (b !== "normal" && !(b in BLEND_OPS)) return false;
        }
        return !!this.compositor();
    }

    /**
     * One entry of the GPU compositor's layer stack (docs/PLAN_BCE.md §C3). A tile store is handed
     * over as itself with the level to draw: the compositor uploads the visible tiles into its atlas
     * and draws them instanced, so no display mirror and no GPU copy of one is made. Anything else
     * (a canvas: a colour-matched layer, a masked layer's `_masked`, the canvas backend) keeps the
     * display pyramid.
     *
     * The level is the one whose tiles are at least as dense as the screen:
     * `floor(-log2(scale))`, clamped to the mips a tile carries.
     */
    glLayerSpec(px, x, y, w, h, opacity, blend, sx, mask = null) {   // a tile store's spec may carry `match` (C6 c 7d)
        const scale = (w * sx) / px.width;
        if (isTilePixels(px)) {
            const level = scale > 0 && Number.isFinite(scale) ? Math.max(0, Math.min(MIP_LEVELS, Math.floor(-Math.log2(scale)))) : 0;
            return { pixels: px, mask, level, x, y, w, h, opacity, blend };
        }
        const lvl = this.displaySource(px, scale, true);
        return { source: lvl, version: this.sourceVersion(lvl), x, y, w, h, opacity, blend };
    }

    /**
     * The visible region composited on the GPU. Returns the compositor's canvas, or null
     * when it could not do it (a source over MAX_TEXTURE_SIZE, a lost context).
     */
    glViewComposite(region, vw, vh, opts) {
        const comp = this.compositor();
        if (!comp) return null;
        const sx = vw / region.w;
        const layers = [];
        const base = this.basePx;
        if (base) layers.push(this.glLayerSpec(base, 0, 0, this.width, this.height, 1, "normal", sx));
        const vp = { x: region.x, y: region.y, w: region.w, h: region.h, sx, sy: vh / region.h };
        // clipping (PLAN_0_1_31 §6 step 3), as drawLayersInto: a clipped layer only over a base this pass draws, which then
        // leaves its coverage for it (`clipId` / `clipTo`)
        const specOf = new Map();
        const push = (layer, spec) => {
            const cb = this.clipBaseOf(layer);
            if (cb) {
                const bs = specOf.get(cb);
                if (!bs) return;
                if (bs.clipId == null) bs.clipId = specOf.size;
                spec.clipTo = bs.clipId;
            }
            specOf.set(layer, spec);
            layers.push(spec);
        };
        try {
            for (const layer of opts.baseOnly ? [] : this.layers) {
                if (!this.shown(layer) || !layer.px) continue;
                if (this.isControl(layer) && opts.forRun) continue;
                const opacity = layer.opacity == null ? 1 : layer.opacity, blend = layer.blend || "normal";
                if (this.matchActive(layer) && this.matchFromTiles(layer)) {
                    // C6 (c) 7d: the layer's own tiles in the atlas, matched in the atlas shader with the shared statistics:
                    // no matched canvas, no upload of one, and a strength tick is a uniform
                    const st = this.matchStats(layer, null, { ...vp, screen: true }, null);
                    const k = Math.min(1, Math.max(0, ((layer.match && layer.match.strength) || 0) / 100));
                    const spec = this.glLayerSpec(layer.px, layer.x, layer.y, layer.w, layer.h, opacity, blend, sx, this.tileMaskOf(layer));
                    spec.match = st && k > 0 ? { meanS: st.meanS, meanT: st.meanT, scale: st.scale, k } : null;
                    push(layer, spec);
                    continue;
                }
                // the statistics are the layer's shared entry (C6 c 7c): no backdrop of this pass is read for them
                const matched = this.matchActive(layer) ? this.layerMatchedPixels(layer, null, vp) : null;
                // C5: a transparency mask on the same tile grid is applied in the atlas shader, so the
                // layer's own tiles are drawn for it too. Only a colour match, a live stroke or a mask
                // of another size still needs layerPixels to prepare a canvas.
                const tileMask = matched ? null : this.tileMaskOf(layer);
                const px = matched || (this.liveMask(layer) && !tileMask ? this.layerPixels(layer, true) : layer.px);
                if (!px || px._livePreview) return null;
                push(layer, this.glLayerSpec(px, layer.x, layer.y, layer.w, layer.h, opacity, blend, sx, tileMask));
            }
            return comp.composite({ width: vw, height: vh, region, layers });
        } catch (err) {
            console.warn("Inpaint Canvas: the GPU compositor failed, staying on Canvas 2D:", (err && err.message) || err);
            this.compositorOff = true;
            return null;
        }
    }

    /**
     * A version for a source canvas that only changes when its pixels do: what
     * `touchSource` and `touchSourceRect` bump, on the original and on every pyramid level
     * they rewrite. A level rebuilt from scratch is a new canvas and starts at 0, which is
     * a fresh key in the compositor's texture cache anyway.
     */
    sourceVersion(src) {
        src = canvasOf(src);
        return src ? (src._dispVer || 0) : 0;
    }

    /**
     * Composite only what the view shows, at screen resolution, and blit that (Krita's
     * prescaled projection). Layers come from their pyramid level, filters and colour
     * match run on the small input; exports, runs and the thumbnail keep their own paths.
     */
    drawViewComposite(ctx, opts = {}) {
        const region = this.viewportRegion();
        if (!region) return;
        const vw = Math.max(1, Math.round(region.w * region.scale));
        const vh = Math.max(1, Math.round(region.h * region.scale));
        if (!this.viewCanvas || this.viewCanvas.width !== vw || this.viewCanvas.height !== vh) this.viewCanvas = makeCanvas(vw, vh);
        this._viewRegion = opts.baseOnly ? null : region;   // what viewCanvas shows (the clone overlay reads it); not the base alone
        const v = this.viewCanvas.getContext("2d");
        const sx = vw / region.w, sy = vh / region.h;
        v.setTransform(1, 0, 0, 1, 0, 0);
        v.globalAlpha = 1;
        v.globalCompositeOperation = "source-over";
        v.clearRect(0, 0, vw, vh);
        v.imageSmoothingEnabled = true;
        let gl = null;
        if (this.glCompositeUsable(opts)) {
            const prevVp = this.viewPass;
            this.viewPass = { x: region.x, y: region.y, w: region.w, h: region.h, sx, sy, screen: true };
            try {
                gl = this.glViewComposite(region, vw, vh, opts);
            } finally {
                this.viewPass = prevVp;
            }
            if (gl) {
                v.setTransform(1, 0, 0, 1, 0, 0);
                v.drawImage(gl, 0, 0);
            }
        }
        if (!gl) {
            v.setTransform(sx, 0, 0, sy, -region.x * sx, -region.y * sy);
            const prev = this.viewPass;
            this.viewPass = { x: region.x, y: region.y, w: region.w, h: region.h, sx, sy, screen: true };
            try {
                this.drawComposite(v, opts);
            } finally {
                this.viewPass = prev;
            }
        }
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.drawImage(this.viewCanvas, region.x, region.y, region.w, region.h);
        ctx.restore();
    }

    /** The visible composite at image resolution, cached: eyedropper, clone, bucket and wand read it. */
    compositeCanvas(opts = {}) {
        const key = JSON.stringify(opts);
        const c = this.flatCache;
        if (c && c.version === this.compositeVersion && c.key === key) return c.canvas;
        const canvas = this.flattenToCanvas(opts);
        this.flatCache = { version: this.compositeVersion, key, canvas };
        return canvas;
    }

    drawComposite(ctx, opts = {}) {
        if (!this.base) return;
        const skipFilters = !!opts.skipFilters;
        const below = opts.baseOnly ? [] : opts.upTo == null ? this.layers : this.layers.slice(0, Math.max(0, opts.upTo));
        const hasFilters = !opts.controlOnly && below.some((l) => this.shown(l) && ((!skipFilters && l.kind === "filter") || this.matchActive(l)));
        // In a region pass the target canvas is already the filter input: no full-size copy.
        if (this.viewPass || !hasFilters) { this.drawLayersInto(ctx, opts); return; }
        // Filters need the composite below them at image resolution: build it offscreen first.
        if (!this.flatCanvas || this.flatCanvas.width !== this.width || this.flatCanvas.height !== this.height) this.flatCanvas = makeCanvas(this.width, this.height);
        const fctx = this.flatCanvas.getContext("2d");
        fctx.setTransform(1, 0, 0, 1, 0, 0);
        fctx.globalAlpha = 1;
        fctx.globalCompositeOperation = "source-over";
        fctx.clearRect(0, 0, this.width, this.height);
        this.drawLayersInto(fctx, opts);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.drawImage(this.flatCanvas, 0, 0);
    }

    /** `upTo`: the composite of the layers below that index only (C6 c1: what a filter layer there takes as its input); `baseOnly`: the base alone (C6 c2f: the peek). */
    drawLayersInto(ctx, { forRun = false, controlOnly = false, upTo = null, baseOnly = false, skipFilters = false } = {}) {
        const skip = skipFilters;
        if (controlOnly) {
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, this.width, this.height);
        } else {
            const bs = this.basePx;
            const vp = this.viewPass;
            // C5: the base of a tile document draws the part the view shows from its own tiles, like
            // every other plain layer since C3 (d). It was the one source left on displaySource in a
            // region pass, and so the one that still made a whole-image mirror and a Skia pyramid
            // (572 MB and 188 MB at 15000 x 10000) as soon as a filter layer put the pass on Canvas 2D.
            if (bs && vp && isTilePixels(bs)) this.drawTilesInto(ctx, bs, 0, 0, this.width, this.height, vp);
            else if (bs) ctx.drawImage(this.displaySource(bs, vp ? vp.sx : 1, !!(vp && vp.screen)), 0, 0, this.width, this.height);
        }
        let chain = null;   // filter layers that follow each other keep the composite on the GPU
        const end = baseOnly ? 0 : upTo == null ? this.layers.length : Math.max(0, Math.min(this.layers.length, upTo));
        // clipping (PLAN_0_1_31 §6 step 3): a clipped layer is drawn only when this pass drew its base, through the base's
        // coverage, made once per base for the layers clipped to it
        const drawn = new Set();
        let cov = null;
        const coverage = (b) => { if (!cov || cov.base !== b) cov = { base: b, canvas: this.clipCoverage(ctx, b) }; return cov.canvas; };
        this._walkDepth = (this._walkDepth || 0) + 1;
        try {
            for (let i = 0; i < end; i++) {
                const layer = this.layers[i];
                if (this.compareShow && layer.kind === "result" && layer.id !== this.compareShow) continue;
                if ((!this.shown(layer) && !(this.compareShow && layer.id === this.compareShow)) || !layer.px) continue;
                const cb = controlOnly ? null : this.clipBaseOf(layer, i);
                if (cb && !drawn.has(cb)) continue;
                if (skip && layer.clip) {
                    const target = controlOnly ? null : this.clipTargetOf(layer, i);
                    if (target && target.kind === "filter" && !drawn.has(target)) continue;
                }
                if (layer.kind === "filter") {
                    if (!controlOnly && !skip) { chain = this.applyFilterLayer(ctx, layer, i, forRun, chain, this.nextIsFilterLayer(i, forRun, end), cb ? () => coverage(cb) : null); drawn.add(layer); }
                    continue;
                }
                const ctrl = this.isControl(layer);
                if (controlOnly && !ctrl) continue;
                if (forRun && (ctrl || this.isReference(layer))) continue;
                chain = this.flushFilterChain(ctx, chain);
                drawn.add(layer);
                if (cb || (!controlOnly && EMULATED_BLENDS.has(layer.blend))) { this.blendEmulated(ctx, layer.blend, (lc) => { this.drawLayer(lc, layer, { skipFilters: skip }); }, layer.opacity, cb ? coverage(cb) : null, seedOfLayer(layer.id)); continue; }
                ctx.globalAlpha = layer.opacity;
                ctx.globalCompositeOperation = controlOnly ? "source-over" : canvasOp(layer.blend);
                this.drawLayer(ctx, layer, { skipFilters: skip });
            }
            chain = this.flushFilterChain(ctx, chain);
        } finally {
            this._walkDepth--;
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
    }

    /**
     * Clipping: the unclipped layer below this layer in the same group that it targets.
     */
    clipTargetOf(layer, i = this.layers.indexOf(layer)) {
        if (!layer || !layer.clip) return null;
        for (let j = i - 1; j >= 0; j--) {
            const b = this.layers[j];
            if (b.clip) continue;
            // a clip does not reach out of its group: the base is in the same one (a reference is in none and draws nothing)
            if (!this.isReference(b) && (b.group || null) !== (layer.group || null)) return null;
            return b;
        }
        return null;
    }

    /**
     * Clipping (PLAN_0_1_31 §6 step 3): the layer a clipped layer (`clip`) is clipped to, its base: the nearest layer below
     * it that is not clipped, when that is a layer of pixels. Null for a layer drawn as it is: not clipped, or a clip
     * without effect (below it only clipped layers and the picture, or a filter layer as the base). A walk of the stack
     * draws a clipped layer only where the base is, and not at all when the walk left the base out (hidden, a reference
     * in a run): `drawLayersInto`, `glViewComposite` and `stackPlan` do it the same way.
     */
    clipBaseOf(layer, i = this.layers.indexOf(layer)) {
        const b = this.clipTargetOf(layer, i);
        return b && b.kind === "filter" ? null : b;
    }

    // ---- groups as folders (PLAN_0_1_31 §6 step 5) ------------------------------------------------------------------

    /**
     * A group is a folder and nothing more (pass-through: no opacity, blend or mask of its own): `this.groups` holds
     * `{ id, name, visible, locked, collapsed, parent }` and a layer names its innermost group in `layer.group`. A group
     * changes the picture only by hiding its layers, so every walk of the stack asks `shown(l)` where it asked
     * `l.visible`, and every edit asks `isLocked(l)`. The layers of a group sit together in the stack (references do not
     * count: they are in no group and may sit anywhere); `normalizeGroups` keeps it so after every change.
     */
    groupById(id) {
        if (!id) return null;
        for (const g of this.groups) if (g.id === id) return g;
        return null;
    }

    /** The group `id` and the groups it is in, innermost first. */
    groupsOf(id) {
        const out = [];
        for (let g = this.groupById(id); g && out.length <= this.groups.length; g = this.groupById(g.parent)) out.push(g);
        return out;
    }

    /** Whether a layer is drawn: its own eye and the eyes of every group it is in. */
    shown(l) {
        if (!l.visible) return false;
        if (!l.group) return true;
        for (const g of this.groupsOf(l.group)) if (!g.visible) return false;
        return true;
    }

    /** Whether a layer is locked, by its own lock or by a group's. */
    isLocked(l) {
        if (!l) return false;
        if (l.locked) return true;
        if (!l.group) return false;
        for (const g of this.groupsOf(l.group)) if (g.locked) return true;
        return false;
    }

    /** Whether a layer (or a group, by its `parent`) is in group `gid`, at any depth. */
    inGroup(l, gid) {
        const start = l && (l.group !== undefined ? l.group : l.parent);
        return !!start && this.groupsOf(start).some((g) => g.id === gid);
    }

    /** The layers of a group (and of the groups in it), bottom first. */
    groupLayers(gid) {
        return this.layers.filter((l) => !this.isReference(l) && this.inGroup(l, gid));
    }

    groupsCopy() {
        return this.groups.map((g) => ({ id: g.id, name: g.name, visible: g.visible !== false, locked: !!g.locked, collapsed: !!g.collapsed, parent: g.parent || null }));
    }

    /**
     * Keep the groups sound after any change of the stack: an unknown group id or a reference's group is dropped, a
     * layer apart from its group's run of layers leaves that group (and the ones inside it), a group without layers
     * goes. Pass-through groups make this cheap to get wrong only in the panel: leaving a group changes the picture
     * only when the group was hidden. True when it changed anything.
     */
    normalizeGroups() {
        if (this.holdGroups > 0) return false;   // layers are still being added (a PSD opening, a state loading)
        let changed = false;
        if (!this.groups.length) {
            for (const l of this.layers) if (l.group) { l.group = null; changed = true; }
            if (this.activeGroupId) this.activeGroupId = null;
            return changed;
        }
        const byId = new Map(this.groups.map((g) => [g.id, g]));
        for (const g of this.groups) {
            if (g.parent && !byId.has(g.parent)) { g.parent = null; changed = true; }
            // a cycle (never made here; a damaged file): the group goes to the top level
            const seen = new Set([g.id]);
            for (let p = byId.get(g.parent); p; p = byId.get(p.parent)) {
                if (seen.has(p.id)) { g.parent = null; changed = true; break; }
                seen.add(p.id);
            }
        }
        const chainOf = (id) => { const c = []; for (let g = byId.get(id); g; g = byId.get(g.parent)) c.unshift(g.id); return c; };
        const closed = new Set(), used = new Set();
        let open = [];
        for (const l of this.layers) {
            if (this.isReference(l)) { if (l.group) { l.group = null; changed = true; } continue; }
            if (l.group && !byId.has(l.group)) { l.group = null; changed = true; }
            let chain = l.group ? chainOf(l.group) : [];   // outermost first
            const cut = chain.findIndex((id) => closed.has(id));
            if (cut >= 0) { chain = chain.slice(0, cut); l.group = chain.length ? chain[chain.length - 1] : null; changed = true; }
            let k = 0;
            while (k < open.length && k < chain.length && open[k] === chain[k]) k++;
            for (let q = k; q < open.length; q++) closed.add(open[q]);
            open = chain;
            for (const id of chain) used.add(id);
        }
        const before = this.groups.length;
        this.groups = this.groups.filter((g) => used.has(g.id));
        if (this.groups.length !== before) changed = true;
        if (this.activeGroupId && !used.has(this.activeGroupId)) this.activeGroupId = null;
        return changed;
    }

    /** Stack order changed: what every change of the layer list does after it. */
    layersRestacked() {
        this.normalizeGroups();
        this.uploaded.baseHash = null;
        this.uploaded.controlHash = null;
        this.refsMutated();
        this.renderLayers(); this.draw(); this.drawThumb(); this.notifyChanged();
    }

    /**
     * Put layers (the selected ones by default) into a new group (Ctrl+G), one "layers" undo step. The group takes the
     * place of the topmost of them, inside the deepest group that holds all of them; a group whose layers are all among
     * them goes in whole (nested), every other layer moves in by itself, in the order of the stack. The new group is
     * selected (its layers).
     */
    groupLayersNow(layers = this.selectedLayers(), { name = null } = {}) {
        const pick = this.layers.filter((l) => layers.includes(l) && !this.isReference(l));
        if (!pick.length) { this.setStatus("Select the layers to group (a reference is in no group)."); return null; }
        if (this.pending) this.cancelPending();
        const picked = new Set(pick);
        const chains = pick.map((l) => this.groupsOf(l.group).map((g) => g.id).reverse());   // outermost first
        const common = [];
        for (let k = 0; chains.every((c) => k < c.length && c[k] === chains[0][k]); k++) common.push(chains[0][k]);
        const parent = common.length ? common[common.length - 1] : null;
        // where the block goes: above what is left of the topmost layer's unit (its own group within `parent`), or where
        // that layer was when all of the unit moves
        const topChain = chains[chains.length - 1].slice(common.length);
        const unit = topChain.length ? topChain[0] : null;
        const rest = this.layers.filter((l) => !picked.has(l));
        const unitRest = unit ? rest.filter((l) => this.inGroup(l, unit)) : [];
        const topAt = this.layers.indexOf(pick[pick.length - 1]);
        const at = unitRest.length ? rest.indexOf(unitRest[unitRest.length - 1]) + 1 : rest.filter((l) => this.layers.indexOf(l) < topAt).length;
        // which groups go in whole: the outermost group below `parent` on a layer's chain whose layers are all picked
        const whole = new Map();
        pick.forEach((l, i) => {
            const c = chains[i].slice(common.length);
            whole.set(l, c.find((id) => this.groupLayers(id).every((x) => picked.has(x))) || null);
        });
        this.pushUndo({ kind: "layers", label: "Group layers" });
        this.groupCounter = (this.groupCounter || 0) + 1;
        let n = this.groups.length + 1;
        while (this.groups.some((g) => g.name === `Group ${n}`)) n++;
        const g = { id: "G" + Date.now().toString(36) + this.groupCounter, name: name || `Group ${n}`, visible: true, locked: false, collapsed: false, parent };
        this.groups.push(g);
        for (const l of pick) {
            const w = whole.get(l);
            if (w) this.groupById(w).parent = g.id;
            else l.group = g.id;
        }
        this.layers = [...rest.slice(0, at), ...pick, ...rest.slice(at)];
        this.normalizeGroups();
        const ids = pick.map((l) => l.id);
        this.activeLayerId = ids[ids.length - 1];
        this.layerSel = new Set(ids.length > 1 ? ids : []);
        this.layerAnchorId = this.activeLayerId;
        this.activeGroupId = g.id;
        this.layersRestacked();
        this.updateSubbar();
        this.setStatus(`${g.name}: ${pick.length} layer${pick.length > 1 ? "s" : ""} grouped. The eye and the lock of its row count for all of them; Ctrl+Z takes it back.`);
        return g;
    }

    /** Dissolve a group: its layers and groups go to the group around it, where they are. One "layers" undo step. */
    ungroup(gid) {
        const g = this.groupById(gid);
        if (!g) { this.setStatus("No such group."); return false; }
        this.pushUndo({ kind: "layers", label: "Ungroup" });
        // a hidden or locked group gave its layers and groups that state; they keep it as their own
        for (const l of this.layers) if (l.group === g.id) {
            l.group = g.parent || null;
            if (!g.visible) l.visible = false;
            if (g.locked) l.locked = true;
        }
        for (const s of this.groups) if (s.parent === g.id) {
            s.parent = g.parent || null;
            if (!g.visible) s.visible = false;
            if (g.locked) s.locked = true;
        }
        this.groups = this.groups.filter((x) => x !== g);
        if (this.activeGroupId === g.id) this.activeGroupId = null;
        this.layersRestacked();
        this.setStatus(`${g.name} ungrouped.`);
        return true;
    }

    /** Delete a group with its layers, one "layers" undo step; refused while one of them is locked. */
    removeGroup(gid) {
        const g = this.groupById(gid);
        if (!g) { this.setStatus("No such group."); return 0; }
        const members = this.groupLayers(g.id);
        const locked = members.filter((l) => this.isLocked(l));
        if (locked.length) { this.setStatus(`${locked.map((l) => l.name).join(", ")} ${locked.length > 1 ? "are" : "is"} locked. Unlock first.`); return 0; }
        if (this.pending && members.includes(this.pending.layer)) this.cancelPending();
        this.pushUndo({ kind: "layers", label: "Delete group" });
        this.layers = this.layers.filter((l) => !members.includes(l));
        if (members.some((l) => l.id === this.activeLayerId)) this.activeLayerId = null;
        this.layerSel = new Set();
        const gone = new Set([g.id, ...this.groups.filter((s) => this.inGroup(s, g.id)).map((s) => s.id)]);
        this.groups = this.groups.filter((s) => !gone.has(s.id));
        this.layersRestacked();
        this.renderHistory();
        this.setStatus(`${g.name} deleted with ${members.length} layer${members.length === 1 ? "" : "s"}. Ctrl+Z takes it back.`);
        return members.length;
    }

    /**
     * A group's switch: `visible`, `locked` or `collapsed`. Like a layer's eye and lock, no undo step; saved with the
     * document. Locking a group ends a transform pending on one of its layers.
     */
    setGroupFlag(gid, key, value) {
        const g = this.groupById(gid);
        if (!g || !["visible", "locked", "collapsed"].includes(key)) return false;
        const v = !!value;
        if (!!g[key] === v) return false;
        g[key] = v;
        if (key === "locked" && v && this.pending && this.inGroup(this.pending.layer, g.id)) this.cancelPending();
        if (key === "visible") { this.visibilityChanged(); return true; }
        this.renderLayers();
        if (key === "locked") this.updateSubbar();
        this.notifyChanged();
        return true;
    }

    renameGroup(gid, name) {
        const g = this.groupById(gid);
        const v = String(name || "").trim();
        if (!g || !v || v === g.name) return false;
        this.pushUndo({ kind: "layers", label: "Rename group" });
        g.name = v;
        this.renderLayers(); this.notifyChanged();
        return true;
    }

    /** A click on a group's row selects its layers (Ctrl adds them to the selection); the row shows as selected. */
    clickGroupRow(g, e) {
        const members = this.groupLayers(g.id);
        if (!members.length) return;
        const ids = members.map((l) => l.id);
        const ctrl = e && (e.ctrlKey || e.metaKey);
        const cur = ctrl ? this.selectedLayers().map((l) => l.id) : [];
        const all = [...new Set([...cur, ...ids])];
        this.selectLayers(all, { active: ids[ids.length - 1] });
        this.activeGroupId = g.id;
        this.renderLayers();
    }

    /**
     * Move layers or a group in the panel (drag and drop), one "layers" undo step. `what`: `{ layer }` or `{ group }`;
     * `onto`: `{ layer }` or `{ group }` (a group's row), `above` as the panel shows it. Onto a layer's row the moved
     * item joins that layer's group; onto a group's row, above goes next to the group, below goes into it at its top.
     */
    dropInLayers(what, onto, above) {
        const g = what.group ? this.groupById(what.group) : null;
        const src = what.layer ? this.layers.find((l) => l.id === what.layer) : null;
        if (!g && !src) return false;
        const block = g ? this.groupLayers(g.id) : [src];
        if (!block.length) return false;
        const tLayer = onto.layer ? this.layers.find((l) => l.id === onto.layer) : null;
        const tGroup = onto.group ? this.groupById(onto.group) : null;
        if (!tLayer && !tGroup) return false;
        if (tLayer && block.includes(tLayer)) return false;
        if (g && tGroup && (tGroup === g || this.inGroup(tGroup, g.id))) return false;
        const rest = this.layers.filter((l) => !block.includes(l));
        let at, parent;
        if (tLayer) {
            const j = rest.indexOf(tLayer);
            at = above ? j + 1 : j;
            parent = tLayer.group || null;
        } else {
            const mem = rest.filter((l) => this.inGroup(l, tGroup.id));
            at = mem.length ? rest.indexOf(mem[mem.length - 1]) + 1 : rest.length;
            parent = above ? (tGroup.parent || null) : tGroup.id;
        }
        const next = [...rest.slice(0, at), ...block, ...rest.slice(at)];
        // a drop next to where it already is changes nothing that shows: no step, no change (review F26)
        const sameParent = g ? (g.parent || null) === parent : this.isReference(src) || (src.group || null) === parent;
        if (sameParent && this.sameStackOrder(src, next)) return false;
        this.pushUndo({ kind: "layers", label: "Layer order" });
        if (g) g.parent = parent;
        else if (!this.isReference(src)) src.group = parent;
        this.layers = next;
        this.layersRestacked();
        return true;
    }

    /**
     * Whether the stack `next` shows the layers in the order they have now: the whole stack, or only the references'
     * order when `moved` is a reference (they are no part of the picture, so their place among the other layers is not).
     */
    sameStackOrder(moved, next) {
        const seen = (arr) => (moved && this.isReference(moved) ? arr.filter((l) => this.isReference(l)) : arr);
        const a = seen(next), b = seen(this.layers);
        return a.length === b.length && a.every((l, k) => l === b[k]);
    }

    /** Whether reorderLayer(srcId, targetId, above) would move anything (a reference row's drop marker). */
    reorderMoves(srcId, targetId, above) {
        const src = this.layers.find((l) => l.id === srcId), t = this.layers.find((l) => l.id === targetId);
        if (!src || !t || src === t) return false;
        // where dropInLayers puts it: next to the target in the stack without it
        const rest = this.layers.filter((l) => l !== src);
        const at = rest.indexOf(t) + (above ? 1 : 0);
        const next = [...rest.slice(0, at), src, ...rest.slice(at)];
        return !this.sameStackOrder(src, next) || (!this.isReference(src) && (src.group || null) !== (t.group || null));
    }

    /**
     * One step up (+1) or down (-1) through the tree (Ctrl+] / Ctrl+[): past the next layer of the same group, into a
     * group that starts next to it (at its near end), or out of its own group when it is at that group's end. False
     * when it cannot move.
     */
    stepLayer(l, dir) {
        const i = this.layers.indexOf(l);
        const j = i + dir;
        const n = this.layers[j];
        const own = l.group ? this.groupById(l.group) : null;
        if (!n || (own && !this.isReference(n) && !this.inGroup(n, own.id))) {
            if (!own || this.isReference(l)) return false;
            l.group = own.parent || null;   // out of its group, in place
            return true;
        }
        if (this.isReference(n) || this.isReference(l) || (n.group || null) === (l.group || null)) {
            this.layers[i] = n; this.layers[j] = l;
            return true;
        }
        // `n` is in a group inside the layer's own (or any group, at the top level): into the outermost of them
        const chain = this.groupsOf(n.group);
        const k = own ? chain.findIndex((x) => x.id === own.id) : chain.length;
        l.group = chain[k - 1].id;
        return true;
    }

    /**
     * The coverage of a clipping base in a pass onto `ctx`: the base drawn alone at its opacity (its pixels' alpha
     * through its mask, whatever its blend mode) into a scratch of `ctx`'s canvas size with its transform, returned
     * in canvas pixels. One scratch per depth of the walk, so a walk nested in a filter's statistics keeps it.
     */
    clipCoverage(ctx, base) {
        const cv = ctx.canvas, W = cv.width, H = cv.height;
        const screen = !!(this.viewPass && this.viewPass.screen);
        const key = (screen ? "gpu" : "cpu") + (this._walkDepth || 0);
        const m = this._walkScratches || (this._walkScratches = new Map());
        let c = m.get(key);
        if (!c || c.width !== W || c.height !== H) { c = screen ? makeCanvas(W, H) : cpuDab(null, W, H); m.set(key, c); }
        const x = c.getContext("2d");
        x.setTransform(1, 0, 0, 1, 0, 0);
        x.globalAlpha = 1;
        x.globalCompositeOperation = "source-over";
        x.clearRect(0, 0, W, H);
        x.setTransform(ctx.getTransform());
        x.imageSmoothingEnabled = ctx.imageSmoothingEnabled;
        // on the screen the opacity goes into the scratch (`destination-in` takes it from there); off the screen the kernel
        // multiplies it into the mask (`_clipAlpha`, mul255 as the workers do: drawn in, it came out 3 levels apart)
        const op = Math.max(0, Math.min(1, base.opacity ?? 1));
        x.globalAlpha = screen ? op : 1;
        c._clipAlpha = screen ? 255 : Math.round(op * 255);
        this.drawLayer(x, base);
        x.setTransform(1, 0, 0, 1, 0, 0);
        x.globalAlpha = 1;
        return c;
    }

    drawLayer(ctx, layer, opts = {}) {
        const p = this.pending;
        if (p && p.layer === layer) {
            const fine = !this.pointer;
            const n = this.pendingSubdivisions(p, fine);
            // while the view is drawn, a tile layer's GPU copy (displaySource's `screen`), not its CPU mirror
            const px = this.viewPass && this.viewPass.screen ? this.displaySource(this.layerPixels(layer, true), 1, true) : this.layerPixels(layer, true);
            if (p.mode === "rotate") {
                const cx = layer.x + layer.w / 2, cy = layer.y + layer.h / 2;
                ctx.save();
                ctx.translate(cx, cy);
                ctx.rotate(p.angle);
                ctx.drawImage(px, -layer.w / 2, -layer.h / 2, layer.w, layer.h);
                ctx.restore();
            } else {
                drawMesh(ctx, px, (u, v) => this.pendingDst(p, u, v), n, n);
            }
            return;
        }
        const vp = this.viewPass;
        const gesture = this.pointer && this.pointer.layer === layer;
        // C6 (c2d): only a paint or mask stroke puts pixels on the screen that are not in the tiles; a move, a scale or a
        // smudge leaves them there (the smudge writes into the tiles), so those gestures draw the tiles like any frame
        // (a liquify stroke on the screen only, once it has moved something: every other pass draws the tiles, since a stroke
        // is not in the document until it lands; and before its first dab a skipped tile shortcut would reach the mirror)
        const painting = gesture && (this.pointer.kind === "layerpaint" || this.pointer.kind === "maskpaint" || (!!vp && !!vp.screen && this.liquifyOn(layer)));
        const full = ctx.canvas.width === this.width && ctx.canvas.height === this.height;
        const matched = this.matchActive(layer) && !gesture && (vp || full);
        // C3: a plain tile-backed layer in a region pass draws the part of itself the view shows, at
        // the view's level, straight from its tiles. A mask, a colour match or a live stroke has
        // prepared a canvas, and the canvas backend keeps the display pyramid.
        if (vp && !matched && !painting && !this.liveMask(layer) && isTilePixels(layer.px)) {
            this.drawTilesInto(ctx, layer.px, layer.x, layer.y, layer.w, layer.h, vp);
            return;
        }
        // C5: the layer a live stroke runs on, and a layer whose transparency mask sits on the same
        // tile grid, in a region pass: composed inside the region only, at the pass's resolution.
        // layerWithStroke and `_masked` below are canvases as large as the layer, filled from the
        // layer's display mirror. C6 (c2): the screen keeps its scratch for a live stroke (layerRegionView:
        // a dab redraws only its box); every other pass, and a masked layer without a stroke, composes the
        // layer into a scratch of the pass target's size (drawLayerPass), whatever the pass's size.
        const liquify = !!vp && vp.screen && this.liquifyOn(layer);
        if (vp && !matched && (this.liveStrokeOn(layer) || liquify || (this.liveMask(layer) && this.tileMaskOf(layer)))) {
            if (!(vp.screen && (this.liveStrokeOn(layer) || liquify))) { this.drawLayerPass(ctx, layer, vp); return; }
            const live = this.layerRegionView(layer, vp);
            if (live) { ctx.drawImage(live, vp.x, vp.y, vp.w, vp.h); return; }
            // a region that is not whole destination pixels: the layer as it is for this frame
            if (liquify) { this.drawLayerPass(ctx, layer, vp); return; }
        }
        // C6 (c) 7b: a colour-matched layer on tiles, in any region pass, is matched in the part its region shows, from its
        // tiles and its mask at the pass's level: no display mirror, no Skia pyramid, no `_masked`
        if (matched && vp && this.matchFromTiles(layer)) {
            const e = this.matchedRegionView(layer, vp, ctx.canvas);
            if (!e) return;
            if (!e.plain) ctx.drawImage(e.canvas, 0, 0, e.sw, e.sh, e.x, e.y, e.w, e.h);
            else if (this.liveMask(layer)) this.drawLayerPass(ctx, layer, vp);
            else this.drawTilesInto(ctx, layer.px, layer.x, layer.y, layer.w, layer.h, vp);
            return;
        }
        // C6 (b3): a sampled pass (the wand's and the bucket's boxes, a plugin's flatten) matches the part of the
        // layer its region shows, not the whole layer (the canvas backend; tiles take matchedRegionView above)
        if (matched && vp && vp.sample) {
            const part = this.layerMatchedPart(layer, ctx.canvas, vp);
            if (part) ctx.drawImage(part.canvas, part.x, part.y, part.w, part.h);
            return;
        }
        const src = matched ? this.layerMatchedPixels(layer, ctx.canvas, vp, opts) : this.layerPixels(layer, true);
        ctx.drawImage(this.displaySource(src, vp ? (layer.w * vp.sx) / src.width : 1, !!(vp && vp.screen)), layer.x, layer.y, layer.w, layer.h);
    }

    matchActive(layer) {
        return !!(layer.match && layer.match.strength > 0 && layer.kind !== "filter" && !this.isControl(layer) && !this.isReference(layer));
    }

    markMatchChanged(layer) {
        layer._mcache = null;
        layer._mcacheView = null; layer._mcacheSample = null;
        layer._mstats = null;
        const v0 = this.compositeVersion;
        this.uploaded.baseHash = null;
        this.uploaded.controlHash = null;
        // C6 (c) 7c: the layer's own shared statistics do not depend on its match settings (their key holds the source),
        // only on its pixels and what is below it: a strength tick keeps them, and only the layers above match again
        for (const slot of ["_mstatsSample", "_mstatsSampleRun", "_mstatsStack", "_mstatsStackRun"]) if (layer[slot] && layer[slot].version === v0) layer[slot].version = this.compositeVersion;
    }

    /**
     * The layer's pixels with their colour statistics matched to the composite
     * below (per-channel mean and spread, ratio clamped to 0.5..2, like the
     * stitch's colour match). Source: the surroundings (a ring around the
     * layer's opaque area) or the pixels underneath it. Cached per composite
     * version and settings.
     */
    layerMatchedPixels(layer, below, vp = null, opts = {}) {
        const m = layer.match || {};
        const strength = Math.min(1, Math.max(0, (m.strength || 0) / 100));
        const px = this.layerPixels(layer, true);
        // in a region pass the match is applied to the pyramid level that is actually drawn
        const out0 = vp ? this.displaySource(px, (layer.w * vp.sx) / px.width, !!vp.screen) : px;
        const skip = !!opts.skipFilters;
        const key = JSON.stringify([m.strength, m.source, layer.x, layer.y, layer.w, layer.h, out0.width, out0.height, skip]);
        const slot = vp ? (vp.sample ? "_mcacheSample" : "_mcacheView") : "_mcache";
        const c = layer[slot];
        if (c && c.version === this.compositeVersion && c.key === key) return c.canvas;
        const st = this.matchStats(layer, below, vp, out0, opts);
        const out = st && strength > 0 ? matchCanvas(out0, st, strength) : out0;
        layer[slot] = { version: this.compositeVersion, key, canvas: out };
        return out;
    }

    /** A colour-matched layer whose region passes read its tiles (C6 c 7b): its pixels on tiles, its mask on the same grid. */
    matchFromTiles(layer) {
        return !!layer.px && isTilePixels(layer.px) && (!this.liveMask(layer) || !!this.tileMaskOf(layer));
    }

    /**
     * The colour-matched pixels of the part of `layer` a region pass shows (C6 c slice 7b), for a layer on tiles
     * (`matchFromTiles`): `{ canvas, sw, sh, x, y, w, h }` - draw `sw x sh` of the canvas (fractional at the layer's last
     * row and column) at `x, y, w, h` in the image - or `{ plain: true }` when there are no statistics (draw the layer
     * unmatched, from its tiles), or null when the region holds nothing of the layer.
     *
     * The pixels are the layer's region canvas at the pass's level, masked by the mask's region canvas on the same
     * grid, and matched. `layerMatchedPixels` matched the layer's whole display mirror, or the Skia pyramid level of it
     * the pass drew: 572 MB for the mirror and 197 MB for the pyramid of a full-size layer at 15000 x 10000, three more
     * 572 MB canvases for a masked one (`_masked` and two mirrors), and a match of up to 600 MB per miss at 1:1.
     *
     * Kept per pass kind (`_mcacheView` for the screen and the navigator, `_mcacheSample` for a sampled pass) under the
     * region canvases' origin and size, not the view's: a pan inside their tile of margin reuses the match. The
     * statistics object is part of the key, so a new one (a change below, a drop on a landing) matches again; so do
     * `chainEpoch`s, which move when the chains of a display read's stale cells land.
     */
    matchedRegionView(layer, vp, below) {
        const m = layer.match || {};
        const strength = Math.min(1, Math.max(0, (m.strength || 0) / 100));
        // first: a statistics miss may run a pass of its own, which takes region canvases and scratches the view reads below
        const st = this.matchStats(layer, below, vp, null);
        if (!st || !(strength > 0)) return { plain: true };
        const px = layer.px, mask = this.liveMask(layer) || null;
        const fx = layer.w / px.width, fy = layer.h / px.height;
        const level = this.tileLevel(fx * vp.sx);
        const display = !!(vp.screen || vp.display);
        const rect = [(vp.x - layer.x) / fx, (vp.y - layer.y) / fy, (vp.x + vp.w - layer.x) / fx, (vp.y + vp.h - layer.y) / fy];
        const rc = px.regionCanvas(rect, level, display);
        if (!rc) return null;
        // the canvas holds whole tiles, its last row and column the clamp past the pixels' own edge (as drawTilesInto)
        const sw = Math.min(rc.canvas.width, (px.width - rc.x) / rc.f);
        const sh = Math.min(rc.canvas.height, (px.height - rc.y) / rc.f);
        if (!(sw > 0) || !(sh > 0)) return null;
        const cw = Math.ceil(sw), ch = Math.ceil(sh);
        // a separate pixels object: its region canvas does not replace the layer's
        const mrc = mask ? mask.regionCanvas(rect, level, display) : null;
        const slot = vp.sample ? "_mcacheSample" : "_mcacheView";
        const key = JSON.stringify(["region", m.strength, m.source, layer.x, layer.y, layer.w, layer.h, level, display, rc.x, rc.y, cw, ch,
            px.version, px.chainEpoch || 0,
            mask ? [mask.version, mask.chainEpoch || 0, mrc ? [mrc.x, mrc.y, mrc.canvas.width, mrc.canvas.height] : -1] : -1]);
        const c = layer[slot];
        if (c && c.region && c.key === key && c.stats === st) return c.region;
        let src = rc.canvas;
        if (mask || cw !== rc.canvas.width || ch !== rc.canvas.height) {
            src = this.passScratch("_matchRegion", cw, ch);
            const x = src.getContext("2d");
            x.setTransform(1, 0, 0, 1, 0, 0);
            x.globalAlpha = 1;
            x.globalCompositeOperation = "copy";
            x.drawImage(rc.canvas, 0, 0, cw, ch, 0, 0, cw, ch);
            if (mask) {
                // the mask's region canvas may start at another tile (it is kept while the range stays inside it)
                x.globalCompositeOperation = "destination-in";
                if (mrc) x.drawImage(mrc.canvas, (mrc.x - rc.x) / rc.f, (mrc.y - rc.y) / rc.f);
                else x.clearRect(0, 0, cw, ch);
            }
            x.globalCompositeOperation = "source-over";
        }
        const out = matchCanvas(src, st, strength);
        const region = { canvas: out, sw, sh, x: layer.x + rc.x * fx, y: layer.y + rc.y * fy, w: sw * rc.f * fx, h: sh * rc.f * fy };
        layer[slot] = { version: this.compositeVersion, key, stats: st, canvas: out, region };
        return region;
    }

    /**
     * The colour-matched pixels of the part of `layer` a sampled pass shows (C6 b3), with where they go in the image:
     * `{ canvas, x, y, w, h }`, or null when the pass's region misses the layer. The statistics are the whole
     * layer's, as `layerMatchedPixels` takes them; only the pixels matched are cut to the region, one source pixel
     * wider on every side for the draw's filtering.
     *
     * The wand's and the bucket's fine boxes are a few hundred pixels of a layer that can be 2048 px and more: each
     * box matched the whole layer (a GPU pass and a readback of its size, 200 ms at 15000 x 10000 behind the queue
     * the box's own composite had just filled). Before C6 (b2) those boxes computed their own statistics from the
     * box, found too few pixels of the layer's surroundings in it, and stored null in the screen's slot: the match
     * was skipped, and the screen showed the layer unmatched until the composite changed.
     */
    layerMatchedPart(layer, below, vp) {
        const m = layer.match || {};
        const strength = Math.min(1, Math.max(0, (m.strength || 0) / 100));
        const px = this.layerPixels(layer, true);
        const out0 = this.displaySource(px, (layer.w * vp.sx) / px.width, false);
        const fx = out0.width / layer.w, fy = out0.height / layer.h;   // source pixels per image pixel
        const cx0 = Math.max(0, Math.floor((vp.x - layer.x) * fx) - 1), cy0 = Math.max(0, Math.floor((vp.y - layer.y) * fy) - 1);
        const cx1 = Math.min(out0.width, Math.ceil((vp.x + vp.w - layer.x) * fx) + 1), cy1 = Math.min(out0.height, Math.ceil((vp.y + vp.h - layer.y) * fy) + 1);
        if (cx1 <= cx0 || cy1 <= cy0) return null;
        const key = JSON.stringify([m.strength, m.source, layer.x, layer.y, layer.w, layer.h, out0.width, out0.height, cx0, cy0, cx1, cy1]);
        const c = layer._mcacheSample;
        if (c && c.version === this.compositeVersion && c.key === key && c.part) return c.part;
        const st = this.matchStats(layer, below, vp, out0);
        const cw = cx1 - cx0, ch = cy1 - cy0;
        let crop = out0;
        if (cx0 > 0 || cy0 > 0 || cw < out0.width || ch < out0.height) {
            crop = makeCanvas(cw, ch);
            crop.getContext("2d").drawImage(out0, cx0, cy0, cw, ch, 0, 0, cw, ch);
        }
        const out = st && strength > 0 ? matchCanvas(crop, st, strength) : crop;
        const part = { canvas: out, x: layer.x + cx0 / fx, y: layer.y + cy0 / fy, w: cw / fx, h: ch / fy };
        layer._mcacheSample = { version: this.compositeVersion, key, canvas: out, part };
        return part;
    }

    /**
     * Mean and spread of the layer and of what it is matched against, both at 256 px.
     *
     * A region pass (the screen, the navigator, a sampled pass: the eyedropper, the wand's and the bucket's passes, a
     * plugin's flatten) takes the entry `sampledMatchStats` keeps per layer per change (C6 c slices 7a and 7c): the
     * screen, the navigator and every sampled pass match a layer with the same statistics, which do not move with the
     * view. The full-resolution flatten (exports, runs, uploads) keeps its own, from the whole composite below the layer
     * and the layer's own pixels (`out0`), cached per composite version.
     */
    matchStats(layer, below, vp, out0, opts = {}) {
        if (vp) return this.sampledMatchStats(layer, !!vp.forRun, !!(vp.screen || vp.display), !!opts.skipFilters);
        const m = layer.match || {};
        const skip = !!opts.skipFilters;
        const key = JSON.stringify([m.strength, m.source, layer.x, layer.y, layer.w, layer.h, skip]);
        const cached = layer._mstats;
        if (cached && cached.version === this.compositeVersion && cached.key === key) return cached.stats;
        below = typeof below === "function" ? below() : below;
        const s = Math.min(1, 256 / Math.max(layer.w, layer.h));
        const sw = Math.max(2, Math.round(layer.w * s)), sh = Math.max(2, Math.round(layer.h * s));
        const pad = Math.max(4, Math.round(Math.max(sw, sh) * 0.08));
        const pw = sw + 2 * pad, ph = sh + 2 * pad;
        // layer alpha and the composite below, both padded, at statistics resolution
        const lay = makeCanvas(pw, ph);
        const lctx = lay.getContext("2d");
        lctx.drawImage(out0, 0, 0, out0.width, out0.height, pad, pad, sw, sh);
        const ld = lctx.getImageData(0, 0, pw, ph).data;
        const bel = makeCanvas(pw, ph);
        const bctx = bel.getContext("2d");
        const padImg = pad / s;
        const bs = below.width / this.width;
        bctx.drawImage(below, (layer.x - padImg) * bs, (layer.y - padImg) * bs, (layer.w + 2 * padImg) * bs, (layer.h + 2 * padImg) * bs, 0, 0, pw, ph);
        const bd = bctx.getImageData(0, 0, pw, ph).data;
        const stats = this.statsOfMatch(layer, lay, ld, bd, pad);
        layer._mstats = { version: this.compositeVersion, key, stats };
        return stats;
    }

    /**
     * The statistics of a padded layer picture `lay` (its bytes `ld`) against the backdrop bytes `bd` of the same size:
     * the layer's opaque pixels against a ring around them (the blurred alpha reaches, the alpha itself does not), or
     * against the backdrop under them. Null below 64 pixels on either side.
     */
    statsOfMatch(layer, lay, ld, bd, pad) {
        const m = layer.match || {};
        const pw = lay.width, ph = lay.height;
        const blur = makeCanvas(pw, ph);
        const bl = blur.getContext("2d");
        try { bl.filter = `blur(${pad * 0.6}px)`; } catch (_) { /* ignore */ }
        bl.drawImage(lay, 0, 0);
        bl.filter = "none";
        const bld = bl.getImageData(0, 0, pw, ph).data;
        const under = m.source === "underneath";
        const sum = [0, 0, 0], sq = [0, 0, 0], tsum = [0, 0, 0], tsq = [0, 0, 0];
        let ns = 0, nt = 0;
        for (let i = 0; i < ld.length; i += 4) {
            const a = ld[i + 3];
            if (a > 127) {
                for (let ch = 0; ch < 3; ch++) { const v = ld[i + ch]; tsum[ch] += v; tsq[ch] += v * v; }
                nt++;
                if (under && bd[i + 3] > 0) { for (let ch = 0; ch < 3; ch++) { const v = bd[i + ch]; sum[ch] += v; sq[ch] += v * v; } ns++; }
            } else if (!under && bld[i + 3] > 6 && bd[i + 3] > 0) {
                for (let ch = 0; ch < 3; ch++) { const v = bd[i + ch]; sum[ch] += v; sq[ch] += v * v; }
                ns++;
            }
        }
        if (!(ns >= 64 && nt >= 64)) return null;
        const meanS = sum.map((v) => v / ns), meanT = tsum.map((v) => v / nt);
        const stdS = sq.map((v, ch) => Math.sqrt(Math.max(1e-6, v / ns - meanS[ch] * meanS[ch])));
        const stdT = tsq.map((v, ch) => Math.sqrt(Math.max(1e-6, v / nt - meanT[ch] * meanT[ch])));
        return { meanS, meanT, scale: stdS.map((v, ch) => Math.min(2, Math.max(0.5, v / stdT[ch]))) };
    }

    /**
     * The colour-match statistics every sampled pass uses (C6 c slice 7a): one entry per layer per change (and per
     * `forRun`, which decides whether control and reference layers are in the backdrop), taken from the layer's
     * **whole** padded surroundings at 256 px, whatever pass asks first.
     *
     * Before, a sampled pass took the screen's statistics when they were there and otherwise made its own from its
     * own region. The eyedropper's 1 x 1 pass and a fine box of the wand hold a few hundred pixels of the ring at most:
     * they stored null, and every sampled pass after them drew the layer unmatched until the composite changed (a
     * 512 px picture after an eyedropper click was 102 levels off on 95,172 bytes). A drop of the screen's statistics
     * between the wand's coarse and fine pass (a chain landing) made the wand select a different region.
     *
     * The backdrop is a sampled pass of its own over the padded box, of the layers below this one (`upTo`), and the
     * layer is drawn from its own pixels at the same scale.
     *
     * C6 (c) 7c: the screen and the navigator take this entry too (`display`). They read the levels the screen shows, so
     * a whole change of a 15000 x 10000 layer builds no chain on the main thread for them; an entry read that way while
     * chains are on their way in the mips worker is `provisional`: it goes when they have landed (and the screen draws
     * again with the entry made then), and a reader that wants exact levels makes it again at once. Read with every chain
     * there, display and exact levels are the same bytes.
     */
    sampledMatchStats(layer, forRun, display = false, skipFilters = false) {
        const m = layer.match || {};
        // a filter-free pass (`pictureInput` for the depth model) reads the picture below without its filter
        // layers, so its statistics are its own entry, never the screen's or a run's
        const key = JSON.stringify([m.source, layer.x, layer.y, layer.w, layer.h, !!skipFilters]);
        const slot = forRun ? "_mstatsSampleRun" : "_mstatsSample";
        const c = layer[slot];
        const valid = c && c.version === this.compositeVersion && c.key === key;
        if (valid && (display || !c.provisional)) return c.stats;
        // the layer, masked, at the statistics' scale
        const { lay, ld, pad, pw, ph, fx, fy, box } = this.matchLayerPicture(layer, display);
        // the composite of the layers below it over the same box, at the same scale
        const idx = this.layers.indexOf(layer);
        const under = this.sampleRegion("image", box, Math.min(fx, fy), { forRun, upTo: Math.max(0, idx), display, skipFilters: !!skipFilters });
        const bel = makeCanvas(pw, ph);
        const bctx = bel.getContext("2d", { willReadFrequently: true });
        bctx.drawImage(under, 0, 0, pw, ph);
        const bd = bctx.getImageData(0, 0, pw, ph).data;
        const stats = this.statsOfMatch(layer, lay, ld, bd, pad);
        const sch = display && this.tileMode ? chainScheduler() : null;
        const entry = { version: this.compositeVersion, key, stats, provisional: !!(sch && sch.pending) };
        layer[slot] = entry;
        const redraw = () => { this.sceneSig = null; this.drawSoon(); this.drawThumb(); };
        // an exact reader replaced the entry the screen drew with
        if (valid && c.provisional) redraw();
        if (entry.provisional) sch.settled().then(() => { if (layer[slot] !== entry) return; layer[slot] = null; redraw(); });
        return stats;
    }

    /**
     * The layer, masked, padded, at the colour-match statistics' scale (256 px on its long side), with its bytes:
     * `{ lay, ld, pad, pw, ph, fx, fy, box }`, `box` the padded rectangle in image coordinates. A layer on tiles is read
     * from its tiles and its mask at that scale, exact or (`display`, the screen's statistics) from the levels the screen
     * shows; any other from the display pyramid of its canvas.
     */
    matchLayerPicture(layer, display) {
        const { pad, pw, ph, fx, fy } = this.matchGeometry(layer);
        const box = [layer.x - pad / fx, layer.y - pad / fy, layer.x + layer.w + pad / fx, layer.y + layer.h + pad / fy];
        const lay = makeCanvas(pw, ph);
        const lctx = lay.getContext("2d", { willReadFrequently: true });
        lctx.imageSmoothingEnabled = true;
        lctx.setTransform(fx, 0, 0, fy, pad - layer.x * fx, pad - layer.y * fy);
        if (this.matchFromTiles(layer)) {
            const vp = { x: box[0], y: box[1], w: box[2] - box[0], h: box[3] - box[1], sx: fx, sy: fy, display };
            this.drawPixelsInto(lctx, layer, layer.px, vp);
            if (this.liveMask(layer)) {
                lctx.globalCompositeOperation = "destination-in";
                this.drawPixelsInto(lctx, layer, layer.maskPx, vp);
                lctx.globalCompositeOperation = "source-over";
            }
        } else {
            const src = this.layerPixels(layer, true);
            lctx.drawImage(this.displaySource(src, (layer.w * fx) / src.width, false), layer.x, layer.y, layer.w, layer.h);
        }
        lctx.setTransform(1, 0, 0, 1, 0, 0);
        const ld = lctx.getImageData(0, 0, pw, ph).data;
        return { lay, ld, pad, pw, ph, fx, fy, box };
    }

    /** The colour-match statistics' picture of a layer: 256 px on its long side (`sw` x `sh`, scale `fx`, `fy`), `pad` around it, `pw` x `ph` in all. */
    matchGeometry(layer) {
        const s = Math.min(1, 256 / Math.max(layer.w, layer.h));
        const sw = Math.max(2, Math.round(layer.w * s)), sh = Math.max(2, Math.round(layer.h * s));
        const pad = Math.max(4, Math.round(Math.max(sw, sh) * 0.08));
        return { s, sw, sh, pad, pw: sw + 2 * pad, ph: sh + 2 * pad, fx: sw / layer.w, fy: sh / layer.h };
    }

    flattenToCanvas(opts = {}) {
        // E5: Chromium makes a canvas above its limit without complaint and draws nothing into it; a picture of nothing
        // must not be saved, uploaded or sent to a model
        if (this.huge) throw new Error(`this ${this.width} × ${this.height} document is larger than any canvas (268 MP): it is written as PNG, PSD or ORA at its full size, and read in boxes`);
        const prev = this.viewPass;
        this.viewPass = null;   // exports, runs and uploads always see the full-resolution composite
        try {
            const c = makeCanvas(this.width, this.height);
            this.drawComposite(c.getContext("2d"), opts);
            return c;
        } finally {
            this.viewPass = prev;
        }
    }

    /**
     * How the full-resolution composite is read in bands (docs/PLAN_BCE.md §E2): `{ reach }` when a band composited with
     * that margin above and below equals the whole flatten there (`boxReach`: pointwise layers 0, a blur its radius), or
     * null when only the whole flatten gives those pixels (a colour-matched layer, a scaled one, a filter that reads the
     * whole picture) and the caller keeps its canvas. Only on tiles, and only with the pool's PNG parts.
     */
    bandPlan(opts = { forRun: true }) {
        if (!this.tileMode || !this.base || !partsUsable() || InpaintEditor.bands === false) return null;
        const o = { forRun: !!opts.forRun, upTo: opts.upTo == null ? null : opts.upTo };
        let reach = this.boxReach([0, 0, this.width, this.height], o), inexact = false;
        if (!Number.isFinite(reach)) {
            // B item 7 part 3: a colour-matched layer is the one reason left for no margin that the stack path takes (its
            // statistics from point samples of the tiles); the bands are then the program's, or nothing (`stackOnly`: no
            // region pass falls in for them, the caller keeps its whole flatten)
            if (!this.huge && InpaintEditor.stacks !== false && this.stackPlan({ ...o, filters: true })) return { reach: 0, rows: 0, inexact: true, stackOnly: true };
            // E5: above the canvas limit there is no whole flatten to take instead. The bands are then what a region pass
            // at full resolution draws: a colour-matched layer with the statistics the screen uses (`sampledMatchStats`,
            // at most a few levels from the whole flatten's, docs/PLAN_BCE.md §C6 c 7c), a scaled layer resampled per band
            if (!this.huge) return null;
            reach = this.boxReach([0, 0, this.width, this.height], { ...o, loose: true });
            inexact = true;
        }
        // a wide margin (a film look's halation is 1.2 % of the long side: 544 px at 15000) is composited twice per band,
        // so the bands grow with it; never more than a canvas holds
        const r = Math.ceil(reach);
        let rows = Math.max(TILE_SIZE, Math.min(2048, Math.ceil((2 * r) / TILE_SIZE) * TILE_SIZE));
        while (rows > TILE_SIZE && this.width * (rows + 2 * r) > CANVAS_MAX_PIXELS / 2) rows -= TILE_SIZE;
        if (this.width * (rows + 2 * r) > CANVAS_MAX_PIXELS) return null;
        return { reach: r, rows, inexact };
    }

    /**
     * The rows `y0` to `y1` of the full-resolution composite as RGBA8 (a typed array of its own): a region pass at level
     * 0 over those rows and `reach` more on either side, drawn into a CPU canvas and read there. The pass's own canvas is
     * never read back itself: a hundred `getImageData` calls on canvases of the GPU make Chromium put every new canvas
     * in software (CLAUDE.md, traps).
     */
    readBand(y0, y1, opts, reach = 0) {
        const W = this.width;
        const kt = Math.min(reach, y0), kb = Math.min(reach, this.height - y1);
        const big = this.sampleRegion("image", [0, y0 - kt, W, y1 + kb], 1, { ...opts, pad: 0 });
        const c = document.createElement("canvas");
        c.width = W; c.height = y1 - y0;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        try {
            ctx.drawImage(big, 0, -kt);
            return ctx.getImageData(0, 0, W, y1 - y0).data;
        } finally {
            big.width = 1; big.height = 1;
            c.width = 1; c.height = 1;
        }
    }

    /**
     * The composite as a PNG written in bands: `{ blob, hash, width, height }`, or null when it cannot be (`bandPlan`)
     * and the caller flattens into a canvas. `each(data, y0, y1)` sees every band before it goes to the workers (the
     * flatten writes its new base from them). The picture must not change while its bands are read: a change restarts
     * the read once, a second one fails it.
     */
    async encodeComposite(opts = { forRun: true }, { hash = false, texts = null, chunks = null, each = null, progress = null } = {}) {
        if (opts && opts.forRun) await this.relightSettled();
        // B item 1: a plain stack is composited by the workers that pack it, from the tiles; `each` wants the rows here
        const stack = each ? null : await this.stackSource(opts);
        if (stack) {
            try {
                const r = await encodeRows(stack.source, { hash, texts, chunks, progress });
                if (r) return { ...r, width: this.width, height: this.height, stack: stack.layers };
            } finally { stack.release(); }
        }
        const plan = this.bandPlan(opts);
        if (!plan) return null;
        for (let round = 0; ; round++) {
            const version = this.compositeVersion;
            const changed = () => this.compositeVersion !== version;
            // B item 7 part 2: with filter layers in an otherwise plain stack the workers composite the bands and the GPU
            // filters their bytes (`programBand`); `bandSource` falls back to the region pass band by band
            const bands = await this.bandSource(opts, plan);
            if (!bands) return null;
            try {
                const r = await encodeBands(this.width, this.height, async (y0, y1) => {
                    if (changed()) throw new Error("the picture changed");
                    const data = await bands.read(y0, y1);
                    if (each) each(data, y0, y1);
                    return data;
                }, { hash, texts, chunks, progress, rows: bands.rows });
                if (!r) return null;
                if (changed()) throw new Error("the picture changed");
                return { ...r, width: this.width, height: this.height, program: bands.program(), programTiming: bands.timing() };
            } catch (err) {
                if (String(err && err.message).includes(NO_PROGRAM)) return null;   // a matched stack without its program: the caller flattens whole
                if (!/the picture changed/.test(String(err && err.message))) throw err;
                if (round >= 1) throw new Error("the picture changed while it was written; try again");
            } finally {
                bands.release();
            }
        }
    }

    /**
     * How the bands of the composite are read (`bandPlan` said they can be): `{ rows, read(y0, y1), program(), release() }`.
     * A stack with filter layers that `stackPlan` takes is held as a program and read through `programBand`; everything
     * else, and every band after the GPU path failed, is the region pass (`readBand`). `program()` says how many bands
     * came the new way. With the plan's `stackOnly` (a colour-matched layer, B item 7 part 3) there is no region pass
     * to fall back on: null when no program can be held, and a failed band throws NO_PROGRAM to the caller.
     */
    async bandSource(opts, plan) {
        const o = { forRun: !!opts.forRun, upTo: opts.upTo == null ? null : opts.upTo };
        let prog = this.huge ? null : await this.holdStack(this.stackPlan({ ...o, filters: true }), o);
        if (prog && !prog.steps) { prog.release(); prog = null; }
        const rows = prog ? this.programRows(prog, this.width) : 0;
        if (prog && !rows) { prog.release(); prog = null; }
        if (!prog && plan.stackOnly) return null;
        let done = 0;
        const reader = prog ? this.programReader(prog) : null, timing = prog ? prog.timing : null;
        return {
            rows: prog ? rows : plan.rows,
            read: async (y0, y1) => {
                if (prog) {
                    try {
                        const data = await reader.read([0, y0, this.width, y1], null, y1 < this.height ? [0, y1, this.width, Math.min(this.height, y1 + rows)] : null);
                        done++;
                        return data;
                    }
                    catch (err) {
                        if (!String(err && err.message).includes(NO_PROGRAM)) throw err;
                        prog.release(); prog = null;
                        if (plan.stackOnly) throw err;
                    }
                }
                // a band of the program's height fits a canvas whenever one of the plan's does: the rows are at most the plan's cap
                return this.readBand(y0, y1, opts, plan.reach);
            },
            program: () => done,
            timing: () => (timing ? Object.fromEntries(Object.entries(timing).map(([k, v]) => [k, Math.round(v)])) : null),
            release: () => { if (prog) { prog.release(); prog = null; } },
        };
    }

    /** Upload the composite as a PNG named by its hash: in bands when it can be read that way (E2), else from a canvas. */
    async uploadComposite(opts, prefix) {
        const r = await this.encodeComposite(opts, { hash: true });
        if (r) return { ref: await uploadBlob(r.blob, `${prefix}_${r.hash}.png`), hash: r.hash };
        return uploadCanvas(this.flattenToCanvas(opts), prefix);
    }

    maskToCanvas() {
        const c = makeCanvas(this.width, this.height);
        const ctx = c.getContext("2d");
        const src = this.sel.readRect(0, 0, this.width, this.height).data;
        const out = ctx.createImageData(this.width, this.height);
        const d = out.data;
        for (let i = 0; i < src.length; i += 4) {
            const a = src[i + 3];
            d[i] = a; d[i + 1] = a; d[i + 2] = a; d[i + 3] = 255;
        }
        ctx.putImageData(out, 0, 0);
        return c;
    }

    /**
     * Bake the visible layers into the base. It is a `canvas` step, like a merge into the base: with
     * no step and the history kept, an older `layers` step put the baked layers back on top of a
     * base that already held them (a multiply layer applied twice).
     */
    flatten() { return this.trackEdit(this.flattenNow()); }   // undo waits for the upload (see extendCanvas)

    async flattenNow() {
        if (this._turning) { this.setStatus("Wait for the turn to finish."); return; }
        if (!this.base || !this.layers.length) return;
        if (this.pending) this.cancelPending();
        let before = null, pushed = false;
        try {
            this.setStatus("Flattening ...");
            before = this.snapshot({ kind: "canvas" });
            // E2: the upload and the new base from the same bands, without a canvas of the picture
            let px = null, ref, hash;
            const banded = await this.encodeComposite({ forRun: true }, {
                hash: true,
                each: (data, y0, y1) => {
                    if (y0 === 0) { if (px) px.release(); px = this.pixels.Layer.empty(this.width, this.height); }
                    px.writeRect({ data, width: this.width, height: y1 - y0 }, 0, y0);
                },
            });
            if (banded) {
                hash = banded.hash;
                ref = await uploadBlob(banded.blob, `n${this.node.id}_base_${hash}.png`);
            } else {
                if (px) px.release();
                const flat = this.flattenToCanvas({ forRun: true });
                ({ ref, hash } = await uploadCanvas(flat, `n${this.node.id}_base`));
                px = this.pixels.Layer.fromCanvas(flat);   // C6 (d): not the upload decoded again
            }
            pushed = true;
            this.pushUndoSnapshot(before, { tracked: true, label: "Flatten" });
            this.layers = this.layers.filter((l) => this.isControl(l) || this.isReference(l));
            this.activeLayerId = null;
            this.refsMutated();
            this.base = { ref, px };
            this.uploaded.baseHash = hash;
            this.uploaded.baseRef = ref;
            this.renderLayers();
            this.renderHistory();
            this.draw();
            this.drawThumb();
            this.notifyChanged();
            this.setStatus("Flattened into base layer (control and reference layers kept; Ctrl+Z takes it back).");
        } catch (err) {
            if (!pushed) this.releaseSnapshot(before);
            console.error(err);
            this.setStatus(String(err.message || err), failKind(err));
        }
    }

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

    /**
     * An outline that is still being dragged, drawn the way marching ants are: a solid
     * black line first, the dashed white one over it. A single white line is invisible on
     * a white image, which is why Photoshop and Krita never draw one.
     */
    /**
     * The brush outline under the cursor. The coloured ring sits on a dark halo, because on
     * its own a one pixel line in the paint colour disappears over its own paint: a brush
     * wider than the layer then looks like a tool that fills rectangles instead of a brush
     * that is simply bigger than what is being painted on.
     */
    drawBrushRing(ctx, s) {
        const brushTools = ["select", "deselect", "paint", "erase", "smudge", "tone", "clone", "heal", "remove", "liquify"];
        if (!this.hover || !brushTools.includes(this.tool)) return;
        ctx.save();
        const colour = this.tool === "paint" ? this.color : (this.tool === "erase" || this.tool === "deselect" ? "#ffd166" : "#fff");
        const ring = (r, dash) => {
            ctx.setLineDash(dash ? [3 / s, 3 / s] : []);
            ctx.lineWidth = 3 / s;
            ctx.strokeStyle = "rgba(0,0,0,0.8)";
            ctx.beginPath(); ctx.arc(this.hover[0], this.hover[1], r, 0, Math.PI * 2); ctx.stroke();
            ctx.lineWidth = 1 / s;
            ctx.strokeStyle = colour;
            ctx.beginPath(); ctx.arc(this.hover[0], this.hover[1], r, 0, Math.PI * 2); ctx.stroke();
        };
        const tip = (this.tool === "paint" || this.tool === "erase") ? this.brushTip() : null;
        if (tip) {
            // the box the stamp will cover, long side = the brush size, turned with the stroke when following it
            const k = this.brushSize / Math.max(tip.canvas.width, tip.canvas.height);
            const w = tip.canvas.width * k, h = tip.canvas.height * k;
            ctx.translate(this.hover[0], this.hover[1]);
            if (this.tipRotate && this._tipAngle) ctx.rotate(this._tipAngle);
            ctx.setLineDash([]);
            ctx.lineWidth = 3 / s; ctx.strokeStyle = "rgba(0,0,0,0.8)";
            ctx.strokeRect(-w / 2, -h / 2, w, h);
            ctx.lineWidth = 1 / s; ctx.strokeStyle = colour;
            ctx.strokeRect(-w / 2, -h / 2, w, h);
            ctx.restore();
            return;
        }
        ring(this.brushSize / 2, false);
        if ((this.tool === "paint" || this.tool === "erase") && this.activeHardness() < 0.98) ring((this.brushSize / 2) * this.activeHardness(), true);
        ctx.restore();
    }

    antsStroke(ctx, path, s) {
        ctx.lineWidth = 1 / s;
        ctx.setLineDash([]);
        ctx.strokeStyle = "#000";
        path();
        ctx.setLineDash([4 / s, 3 / s]);
        ctx.strokeStyle = "#fff";
        path();
    }

    /**
     * Selection as a marching-ants outline: the mask shifted by a screen pixel in eight directions minus the mask, filled
     * with a moving stripe pattern. `shift` ([dx, dy] image pixels) draws it moved (a patch drag), the selection unchanged.
     */
    drawMarchingAnts(ctx, shift = null) {
        const W = this.canvas.width, H = this.canvas.height;
        if (!this.antsCanvas || this.antsCanvas.width !== W || this.antsCanvas.height !== H) this.antsCanvas = makeCanvas(W, H);
        const a = this.antsCanvas.getContext("2d");
        const s = this.view.scale, vx = this.view.x, vy = this.view.y;
        a.setTransform(1, 0, 0, 1, 0, 0);
        a.globalCompositeOperation = "source-over";
        a.globalAlpha = 1;
        a.clearRect(0, 0, W, H);
        a.imageSmoothingEnabled = s < 1;
        const r = 1.25;
        // nine draws of the selection: never at full size (the view's level, and on tiles only the
        // part the view shows, straight from the tiles)
        const view = this.viewportRegion();
        // moved: the selection's part that lands in view is the view's region moved back
        const region = shift && view ? { ...view, x: view.x - shift[0], y: view.y - shift[1] } : view;
        for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
            this.applyViewTransform(a, dx, dy);
            this.applyTilt(a);
            if (shift) a.translate(shift[0], shift[1]);
            // the moved pass reads as a sampler (not `display`): on tiles it would otherwise take the screen's region slot
            // and the unmoved pass would rebuild it again, two whole regions a frame while the patch drags
            this.drawSelectionInto(a, s, region, !shift);
        }
        this.applyViewTransform(a);
        this.applyTilt(a);
        if (shift) a.translate(shift[0], shift[1]);
        a.globalCompositeOperation = "destination-out";
        this.drawSelectionInto(a, s, region, !shift);
        a.setTransform(1, 0, 0, 1, 0, 0);
        a.globalCompositeOperation = "source-in";
        if (!this.antsPattern) {
            const tile = makeCanvas(8, 8);
            const t = tile.getContext("2d");
            t.fillStyle = "#fff"; t.fillRect(0, 0, 8, 8);
            t.fillStyle = "#000";
            t.beginPath();
            t.moveTo(0, 0); t.lineTo(4, 0); t.lineTo(8, 4); t.lineTo(8, 8); t.lineTo(4, 8); t.lineTo(0, 4); t.closePath();
            t.fill();
            this.antsPattern = a.createPattern(tile, "repeat");
        }
        const offset = Math.floor(Date.now() / 120) % 8;
        try { this.antsPattern.setTransform(new DOMMatrix().translate(offset, 0)); } catch (_) { /* old browsers: static stripes */ }
        a.fillStyle = this.antsPattern;
        a.fillRect(0, 0, W, H);
        a.globalCompositeOperation = "source-over";
        const t = ctx.getTransform();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(this.antsCanvas, 0, 0);
        ctx.setTransform(t);
        if (!this.antsTimer) {
            // keep the ants walking while a selection is shown; stops itself when there is none or the editor closes
            this.antsTimer = setInterval(() => {
                if (!this.isOpen || this.selectionDisplay !== "ants" || !this.getBounds()) { clearInterval(this.antsTimer); this.antsTimer = null; return; }
                if (!this.pointer) this.drawSoon();
            }, 120);
        }
    }

    draw() {
        this.drawScene();
        this.drawOverlays();
        this.watchChains();
    }

    /**
     * While mip chains are in the mips worker (C6 b), wait for the next batch to land and draw again: the frame
     * after a whole change of a large layer or mask showed a stale or coarse picture of the tiles still on their
     * way, and the rows' thumbnails did too. Nothing is kept when nothing is on its way.
     *
     * What a landing redraws depends on whose chains landed (C6 b2):
     * - The selection's: only what is drawn over the scene (the tint, the marching ants, the quick mask, the
     *   navigator). No filter layer and no colour match ever reads the selection, so the scene and the view's caches
     *   stay. The exception is a live stroke clipped to the selection, whose view scratch is clipped by the
     *   selection's region canvas (`layerRegionView` keys on its `chainEpoch`): the scene is drawn again for it.
     * - The base's, a layer's or a mask's: the scene is drawn again at once, and the view's filter outputs and colour
     *   matches of the layers above the lowest landed one are dropped once no chain is on its way any more
     *   (`staleViewCachesAbove`). Dropping all of them at every landing ran the match (three readbacks) and the filter
     *   pass again per batch of 128 chains, 16 to 20 times per whole change at 15000 x 10000, each 75 to 545 ms
     *   behind a busy GPU queue.
     */
    watchChains() {
        const sch = chainScheduler();
        if (this._chainWatch || !sch.pending) return;
        this._chainWatch = true;
        sch.landing().then((stores) => {
            this._chainWatch = false;
            // `screen`: the stores whose chains a reader of the screen asked for. A landing only a thumbnail asked for
            // (a layer at 1:1, a hidden one) changes nothing on the screen, and dropping the view's caches for it ran a
            // colour match and a filter pass again per batch (the C6 b review)
            const screen = stores.screen || stores;
            const base = screen.has(this._basePx);
            const landed = [];
            for (const l of this.layers) {
                if (!stores.has(l.px) && !(l.maskPx && stores.has(l.maskPx))) continue;
                if (screen.has(l.px) || (l.maskPx && screen.has(l.maskPx))) landed.push(l);
                this.redrawThumbsOf(l);
            }
            let scene = base || landed.length > 0;
            if (scene) this.staleViewCachesAbove(base, landed);
            else if (!sch.pending) this.dropStaleViewCaches();   // the last batch was another store's
            // a live stroke's sparse store: the view scratch of the gesture is built again from its region canvases
            const p = this.pointer, sb = p && p.stroke;
            if (sb && sb.px && screen.has(sb.px)) { scene = true; this._strokeViewSig = null; }
            const sel = !!this.sel && screen.has(this.sel);
            if (sel && sb && p.clip) scene = true;
            if (scene) this.sceneSig = null;
            if (scene || sel) {
                this.drawSoon();
                this.drawThumb();   // the navigator (the node's; the app has none mounted)
            }
            this.watchChains();
        });
    }

    /**
     * Chains of the base (`base`) or of `landed` layers (their pixels or their masks) landed (C6 b2): the view's own
     * caches of every layer above the lowest of them were made from the picture the landing replaced. A filter layer's
     * output is made from everything below it, and a colour match's statistics (and so its matched pixels) from what is
     * under the layer; the matched layer's own pixels come from its exact display canvas, not from mips, and a layer
     * below the landed one reads nothing of it. Their full-resolution caches never saw a stale mip.
     *
     * They are dropped once, when no chain is on its way any more, not per landing: the screen shows the previous
     * filter output and match meanwhile, as it shows the coarse picture, and the frame after the last landing is exact.
     *
     * The same layers' caches of sampled passes (`sampleRegion`: a plugin's `flatten({ maxSize })`, the film panel,
     * the wand's coarse flood) go too. A sampled pass reads exact mips, but it takes the colour match's statistics
     * from the screen's slot when they are there (`matchStats`), and a sampled pass while the chains were on their
     * way kept matched pixels (and a filter output made from them) from the statistics of the coarse picture past the
     * settle (the C6 b2 review: 5 to 6 levels on about 45,000 bytes of a 512 px flatten at 4000 x 3000).
     */
    staleViewCachesAbove(base, landed) {
        const st = this._viewStale || (this._viewStale = { base: false, layers: new Set(), watch: false });
        if (base) st.base = true;
        for (const l of landed) st.layers.add(l);
        const sch = chainScheduler();
        // the last landing: dropped here, in the landing's own callback, which runs before the continuations of
        // mipsSettled() (a reader that draws right after it sees the fresh match)
        if (!sch.pending) { this.dropStaleViewCaches(); return; }
        // otherwise when nothing is on its way any more, also when the rest of the queue was dropped without a landing
        if (st.watch) return;
        st.watch = true;
        sch.settled().then(() => { st.watch = false; this.dropStaleViewCaches(); });
    }

    /** The drop `staleViewCachesAbove` put off; draws again when it dropped anything. */
    dropStaleViewCaches() {
        const st = this._viewStale;
        if (!st || (!st.base && !st.layers.size)) return;
        let from = st.base ? -1 : Infinity;
        for (const l of st.layers) {
            const i = this.layers.indexOf(l);
            if (i < 0) { from = -1; break; }   // removed meanwhile: the layers above it moved down
            if (i < from) from = i;
        }
        st.base = false;
        st.layers.clear();
        let dropped = false;
        for (let i = from + 1; i < this.layers.length; i++) {
            const l = this.layers[i];
            // no draw for them: nothing on the screen came from them. The colour-match statistics stay: an entry read while
            // chains were on their way is provisional and goes when they have landed (C6 c 7c, `sampledMatchStats`)
            l._fcacheSample = null; l._mcacheSample = null;
            if (!l._fcacheView && !l._mcacheView) continue;
            l._fcacheView = null; l._mcacheView = null;
            dropped = true;
        }
        if (!dropped) return;
        this.sceneSig = null;
        this.drawSoon();
        this.drawThumb();
    }

    /**
     * Resolves when no mip chain is on its way in the mips worker (C6 b): a test or a benchmark that reads the
     * screen right after a whole change waits for this and then draws, and reads the exact picture.
     */
    mipsSettled() {
        return chainScheduler().settled();
    }

    /**
     * Downsample 16-bit depth map for quarter-size shadow march.
     */
    downsampleDepth(src, srcW, srcH, dstW, dstH) {
        // on a SharedArrayBuffer where the page is isolated, as the depth map itself (inpaint_maps.js `makeMap`): the quick
        // march reads it in stripes where it lies (K12, inpaint_relight.js `marchOnPool`)
        const shared = typeof SharedArrayBuffer === "function" && typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
        const dst = shared ? new Uint16Array(new SharedArrayBuffer(dstW * dstH * 2)) : new Uint16Array(dstW * dstH);
        for (let dy = 0; dy < dstH; dy++) {
            const sy = Math.min(srcH - 1, Math.floor(((dy + 0.5) / dstH) * srcH));
            const sRow = sy * srcW;
            const dRow = dy * dstW;
            for (let dx = 0; dx < dstW; dx++) {
                const sx = Math.min(srcW - 1, Math.floor(((dx + 0.5) / dstW) * srcW));
                dst[dRow + dx] = src[sRow + sx];
            }
        }
        return dst;
    }

    /**
     * Resolves when a pending nudge or wheel step is committed and every relight layer's full shadow map is computed
     * for its lights (`relightIdle`): what a run and an export wait for. `also`: a relight layer to settle even when it is
     * hidden (a relight render reads its own maps for the light map).
     */
    async relightSettled(also = null) {
        this.flushPendingDebounces();
        await this.relightIdle(also);
    }

    /**
     * Resolves when every relight layer's full shadow map is computed for its current lights (F2.7): what a reader of
     * the picture a run sees waits for (a crop, a screenshot, a plugin's settled flatten), so it reads neither the quick
     * map of a light on the move nor the map of where a light was. Unlike `relightSettled` it leaves a pending nudge as it
     * is: a read pushes no undo step. Each round waits for the jobs there are when it starts (a drag goes on adding quick
     * ones); a light moved during the wait starts another round, three at most. Hidden relight layers are not read
     * (`also` is one that is, whether shown or not).
     * @param {any} [also]
     */
    async relightIdle(also = null) {
        for (let round = 0; round < 3; round++) {
            for (const l of this.layers || []) {
                if (l.kind === "filter" && l.filter === "relight" && (l === also || this.shown(l))) this.ensureRelightMaps(l);
            }
            const jobs = this._relightPending ? Array.from(this._relightPending) : [];
            if (!jobs.length) return;
            await Promise.all(jobs);
        }
    }

    /** The relight_shadow marches in flight over all layers, quick and full (the K0b harness waits on it). */
    relightMarching() {
        return this._relightMarches || 0;
    }

    isRelightActive() {
        const l = this.activeLayer();
        return !!(l && l.kind === "filter" && l.filter === "relight");
    }

    ownLightPos(layer) {
        const stats = this.belowStats(layer, false);
        const fit = stats?.fit;
        const l0 = (fit && Array.isArray(fit.l0) && fit.l0.length >= 3) ? fit.l0 : [0, 0, 1];
        const cx = this.width * 0.5;
        const cy = this.height * 0.5;
        const spread = Math.min(this.width, this.height) * 0.35;
        return [cx + l0[0] * spread, cy + l0[1] * spread, l0];
    }

    hitLight(layer, ix, iy) {
        if (!layer || !layer.params || !Array.isArray(layer.params.lights)) return null;
        const lights = layer.params.lights;
        const s = this.view.scale;

        // 1. Aim handles (spot lights)
        for (let i = lights.length - 1; i >= 0; i--) {
            const l = lights[i];
            if (l && l.on !== false && l.type === "spot" && Array.isArray(l.aim)) {
                if (Math.hypot(ix - l.aim[0], iy - l.aim[1]) <= 14 / s) {
                    return { light: l, mode: "aim", index: i };
                }
            }
        }

        // 2. Light rings
        for (let i = lights.length - 1; i >= 0; i--) {
            const l = lights[i];
            if (!l) continue;
            const rScreen = Math.max(10, Math.min(36, 18 - ((l.dist || 0) / 100.0) * 8));
            const hitRadius = (rScreen + 6) / s;
            if (Math.hypot(ix - l.x, iy - l.y) <= hitRadius) {
                return { light: l, mode: "light", index: i };
            }
        }

        // 3. Own light handle
        const [ox, oy, l0] = this.ownLightPos(layer);
        if (Math.hypot(ix - ox, iy - oy) <= 16 / s) {
            return { mode: "own_light", pos: [ox, oy], l0 };
        }

        return null;
    }

    updateLightsCursor(ix, iy) {
        if (!this.isRelightActive()) {
            this.viewEl.style.cursor = "";
            return;
        }
        const layer = this.activeLayer();
        const hit = this.hitLight(layer, ix, iy);
        if (hit) {
            if (hit.mode === "aim") {
                this.viewEl.style.cursor = "crosshair";
            } else if (hit.mode === "light") {
                this.viewEl.style.cursor = "move";
            } else if (hit.mode === "own_light") {
                this.viewEl.style.cursor = "copy";
            }
        } else {
            this.viewEl.style.cursor = "crosshair";
        }
    }

    drawLightsOverlay(ctx) {
        if (!this.isOpen || !this.isRelightActive() || this.hideLightHandles) return;
        const activeLayer = this.activeLayer();
        if (!activeLayer || !activeLayer.params || !Array.isArray(activeLayer.params.lights)) return;
        const lights = activeLayer.params.lights;
        const selId = activeLayer._selectedLightId;
        const s = this.view.scale;
        const invScale = 1.0 / s;

        // 1. Fitted original light ("own light")
        const [ox, oy] = this.ownLightPos(activeLayer);
        const or = 14 * invScale;
        ctx.save();
        ctx.strokeStyle = "rgba(180, 180, 180, 0.7)";
        ctx.lineWidth = 1.5 * invScale;
        ctx.setLineDash([3 * invScale, 3 * invScale]);
        ctx.beginPath();
        ctx.arc(ox, oy, or, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(180, 180, 180, 0.9)";
        ctx.beginPath();
        ctx.arc(ox, oy, 2.5 * invScale, 0, Math.PI * 2);
        ctx.fill();

        ctx.font = `600 ${(10 * invScale).toFixed(2)}px system-ui, sans-serif`;
        const ownText = "own light";
        const tw = ctx.measureText(ownText).width + 6 * invScale;
        const th = 13 * invScale;
        ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
        ctx.fillRect(ox - tw / 2, oy + or + 3 * invScale, tw, th);
        ctx.fillStyle = "rgba(220, 220, 220, 0.9)";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(ownText, ox, oy + or + 3 * invScale + th / 2);
        ctx.restore();

        // 2. Active lights
        for (let i = 0; i < lights.length; i++) {
            const l = lights[i];
            if (!l) continue;
            const x = l.x;
            const y = l.y;
            const isSelected = l.id === selId;
            const colorHex = lightColorHex(l.color);
            const rScreen = Math.max(10, Math.min(36, 18 - ((l.dist || 0) / 100.0) * 8));
            const r = rScreen * invScale;

            ctx.save();

            // Spot aim line and aim handle
            if (l.type === "spot" && Array.isArray(l.aim)) {
                const [ax, ay] = l.aim;
                ctx.save();
                ctx.strokeStyle = colorHex;
                ctx.lineWidth = 1.5 * invScale;
                ctx.setLineDash([4 * invScale, 3 * invScale]);
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(ax, ay);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.strokeStyle = colorHex;
                ctx.lineWidth = 1.5 * invScale;
                ctx.beginPath();
                ctx.arc(ax, ay, 6 * invScale, 0, Math.PI * 2);
                ctx.stroke();
                ctx.fillStyle = colorHex;
                ctx.beginPath();
                ctx.arc(ax, ay, 2 * invScale, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }

            // Outer halo if selected
            if (isSelected) {
                ctx.strokeStyle = "rgba(74, 144, 217, 0.5)";
                ctx.lineWidth = 5 * invScale;
                ctx.beginPath();
                ctx.arc(x, y, r + 2 * invScale, 0, Math.PI * 2);
                ctx.stroke();
            }

            // Main ring
            ctx.strokeStyle = colorHex;
            ctx.lineWidth = (isSelected ? 2.5 : 1.5) * invScale;
            if (l.on === false) {
                ctx.setLineDash([4 * invScale, 4 * invScale]);
            } else {
                ctx.setLineDash([]);
            }
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);

            // Inner glyph
            if (l.type === "point") {
                ctx.fillStyle = colorHex;
                ctx.beginPath();
                ctx.arc(x, y, 3 * invScale, 0, Math.PI * 2);
                ctx.fill();
            } else if (l.type === "sun") {
                ctx.fillStyle = colorHex;
                ctx.beginPath();
                ctx.arc(x, y, 2.5 * invScale, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = colorHex;
                ctx.lineWidth = 1.2 * invScale;
                const ray = 5 * invScale;
                ctx.beginPath();
                ctx.moveTo(x - ray, y); ctx.lineTo(x + ray, y);
                ctx.moveTo(x, y - ray); ctx.lineTo(x, y + ray);
                ctx.stroke();
            } else if (l.type === "spot") {
                const aim = l.aim || [x, y + 100];
                const angle = Math.atan2(aim[1] - y, aim[0] - x);
                const halfCone = ((l.cone || 30) * Math.PI) / 180;
                ctx.strokeStyle = colorHex;
                ctx.lineWidth = 1.2 * invScale;
                const cr = 6 * invScale;
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(x + cr * Math.cos(angle - halfCone), y + cr * Math.sin(angle - halfCone));
                ctx.arc(x, y, cr, angle - halfCone, angle + halfCone);
                ctx.lineTo(x, y);
                ctx.stroke();
            }

            // Number badge
            const bx = x + r * 0.72 + 6 * invScale;
            const by = y - r * 0.72 - 6 * invScale;
            const br = 7 * invScale;
            ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
            ctx.beginPath();
            ctx.arc(bx, by, br, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = isSelected ? "#7cc7ff" : "rgba(255, 255, 255, 0.4)";
            ctx.lineWidth = 1 * invScale;
            ctx.stroke();
            ctx.font = `bold ${(9 * invScale).toFixed(2)}px system-ui, sans-serif`;
            ctx.fillStyle = isSelected ? "#7cc7ff" : "#ffffff";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(String(i + 1), bx, by);

            ctx.restore();
        }
    }

    /**
     * Ensures normals and visibility maps for a relight filter layer are up to date.
     * Manages layer._relight cache and dispatches worker pool jobs.
     * @param {any} layer
     * @param {{ quick?: boolean }} [opts]
     */
    ensureRelightMaps(layer, { quick = false } = {}) {
        const depthMap = (this.maps && this.maps.depth) || null;
        if (!depthMap || !depthMap.data || depthMap.w <= 0 || depthMap.h <= 0) return;

        const cache = layer._relight || (layer._relight = {
            key: null,
            normals: null,
            vis: null,
            visQuick: null,
            depthQuick: null,
            fit: null,
            pending: new Set(),
        });

        const mapVersion = depthMap.dataVersion ?? depthMap.version ?? 0;   // the normals read the data alone
        const depthScale = relightDepthScale(layer.params);
        const sigma = Number.isFinite(layer.params?.sigma) ? Number(layer.params.sigma) : 2.0;
        const mapLongSide = Math.max(depthMap.w, depthMap.h);
        const scaleZ = (depthScale / 100.0) * mapLongSide;

        // Normals cache
        const nKey = `${mapVersion}_${depthScale}_${sigma}`;
        if ((!cache.normals || cache.normals.key !== nKey) && !cache.pending.has("n:" + nKey)) {
            cache.pending.add("n:" + nKey);
            const p = (async () => {
                try {
                    const pool = editorPool();
                    if (pool && !pool.off) {
                        const res = await pool.run("relight_normals", {
                            depth: depthMap.data,
                            w: depthMap.w,
                            h: depthMap.h,
                            scale: scaleZ,
                            sigma,
                        }, [], { priority: quick ? INTERACTIVE : NORMAL });
                        cache.normals = {
                            data: new Uint8Array(res.normals),
                            w: depthMap.w,
                            h: depthMap.h,
                            key: nKey,
                        };
                    } else {
                        const normals = heightNormals(depthMap.data, depthMap.w, depthMap.h, scaleZ, sigma);
                        cache.normals = {
                            data: normals,
                            w: depthMap.w,
                            h: depthMap.h,
                            key: nKey,
                        };
                    }
                    cache.key = nKey;
                    this.markFilterChanged(layer, { soon: true });
                } catch (err) {
                    console.warn("relight_normals failed:", err);
                } finally {
                    cache.pending.delete("n:" + nKey);
                }
            })();
            this._relightPending.add(p);
            p.finally(() => this._relightPending.delete(p));
        }

        // Shadow maps: a channel per light under relightVisKey, the keys pickVis reads (docs/PLAN_RELIGHT_FIXES.md F2.5)
        const shadows = Number.isFinite(layer.params?.shadows) ? Number(layer.params.shadows) : 60;
        if (shadows === 0) return;   // pickVis hands an all-lit map; the maps stay as they are for when the shadows come back
        const mapKey = relightMapKey(depthMap);
        const lights = Array.isArray(layer.params?.lights) ? layer.params.lights : [];
        const targetW = quick ? Math.max(1, Math.floor(depthMap.w / 4)) : depthMap.w;
        const targetH = quick ? Math.max(1, Math.floor(depthMap.h / 4)) : depthMap.h;
        const stamp = () => (cache.ticket = (cache.ticket || 0) + 1);

        let targetVis = quick ? cache.visQuick : cache.vis;
        if (!targetVis || targetVis.w !== targetW || targetVis.h !== targetH) {
            const visData = new Uint8Array(targetW * targetH * 4);
            let keys = [null, null, null, null], tickets = [0, 0, 0, 0], seq = 0;
            const full = cache.vis;
            if (quick && full && full.data && full.w && full.h) {
                const srcVis = full.data;
                const srcW = full.w;
                const srcH = full.h;
                for (let dy = 0; dy < targetH; dy++) {
                    const sy = Math.min(srcH - 1, Math.floor(((dy + 0.5) / targetH) * srcH));
                    const sRow = sy * srcW;
                    const dRow = dy * targetW;
                    for (let dx = 0; dx < targetW; dx++) {
                        const sx = Math.min(srcW - 1, Math.floor(((dx + 0.5) / targetW) * srcW));
                        const sIdx = (sRow + sx) * 4;
                        const dIdx = (dRow + dx) * 4;
                        visData[dIdx] = srcVis[sIdx];
                        visData[dIdx + 1] = srcVis[sIdx + 1];
                        visData[dIdx + 2] = srcVis[sIdx + 2];
                        visData[dIdx + 3] = srcVis[sIdx + 3];
                    }
                }
                // the full map at a quarter of its size: current for every light that has not moved since it was made, so
                // a drag marches only the light it moves, and its first frames show the shadows from before the drag
                if (Array.isArray(full.keys)) keys = full.keys.map((k) => (k ? k.slice(0, -1) + "q" : null));
                if (Array.isArray(full.tickets)) tickets = full.tickets.slice();
                seq = full.seq || 0;
            } else {
                visData.fill(255);
            }
            if (!quick) {
                // a new full map (a depth map of another size): newer than any quick map, which belongs to the old one
                seq = cache.seq = (cache.seq || 0) + 1;
                cache.visQuick = null;
            }
            targetVis = { data: visData, w: targetW, h: targetH, keys, tickets, seq };
            if (quick) cache.visQuick = targetVis;
            else cache.vis = targetVis;
        }

        let marchDepth;
        if (quick) {
            if (!cache.depthQuick || cache.depthQuick.w !== targetW || cache.depthQuick.h !== targetH || cache.depthQuick.mapVersion !== mapVersion) {
                cache.depthQuick = {
                    data: this.downsampleDepth(depthMap.data, depthMap.w, depthMap.h, targetW, targetH),
                    w: targetW,
                    h: targetH,
                    mapVersion,
                };
            }
            marchDepth = cache.depthQuick.data;
        } else {
            marchDepth = depthMap.data;
        }
        const scaleFactor = targetW / depthMap.w;
        const marchScale = scaleZ * scaleFactor;
        // the K0b harness (docs/PLAN_WASM_BUILD.md §4.5): a "start" mark for a call that posts marches, made at its first;
        // "landed" for each answer, "idle" when the layer's last march in flight has answered
        let run = null;
        // K12 (§4.5): each march is a pool group of its own (a page-wide sequence number: a layer's id and its cache's
        // tickets repeat in a second tab of the same document and after a deep release; then the layer, the channel, the
        // size, the ticket), cut into stripes by marchOnPool. A full march of a channel supersedes the one still on its way for it (the light moved on,
        // went off, or came back to the key the channel holds): the older one's queued stripes are cancelled and its
        // pending key is freed at once, so the light can march there again. A quick march is never cancelled: the quick
        // map trails the pointer, an older answer still lands over an older one. K12b: a full march's stripes go through
        // the pool's feed (at most the route relightFeed, else the pool's size + 1, stripes of all full marches posted at
        // once), so other NORMAL pool work waits for about one stripe; a quick march's go at once (INTERACTIVE).
        const fullMarches = cache.fullMarches || (cache.fullMarches = [null, null, null, null]);
        const supersede = (i) => {
            const m = fullMarches[i];
            if (!m) return;
            fullMarches[i] = null;
            m.superseded = true;
            cache.pending.delete(m.pendingKey);
            const pool = editorPool();
            if (pool && !pool.off) cancelMarch(pool, m.group);   // its stripes in the feed too (K12b)
        };
        // the depth map's name for the workers' resident copy of it (px.js `_slot`): its data, the march's size
        const depthKey = `${mapKey}:${quick ? "q" : "f"}:${targetW}x${targetH}`;

        for (let i = 0; i < 4; i++) {
            const l = lights[i];
            const vKey = relightVisKey(l, depthScale, mapKey, quick);
            if (vKey === null) {
                if (!quick) supersede(i);
                if (targetVis.keys[i] !== null) {
                    for (let idx = 0; idx < targetW * targetH; idx++) {
                        targetVis.data[idx * 4 + i] = 255;
                    }
                    targetVis.keys[i] = null;
                    (targetVis.tickets || (targetVis.tickets = [0, 0, 0, 0]))[i] = stamp();
                    targetVis.seq = cache.seq = (cache.seq || 0) + 1;
                }
                continue;
            }

            const pendingKey = `v:${quick ? "q" : "f"}:${i}:${vKey}`;
            if (targetVis.keys[i] === vKey) {
                if (!quick && fullMarches[i] && fullMarches[i].pendingKey !== pendingKey) supersede(i);
                continue;
            }
            if (cache.pending.has(pendingKey)) continue;
            if (!quick) supersede(i);
            cache.pending.add(pendingKey);
            const chan = i;
            const ticket = stamp();
            const march = { group: `relight${nextPartsSeq()}:${layer.id}:${chan}:${targetW}x${targetH}:${ticket}`, pendingKey, superseded: false };
            if (!quick) fullMarches[chan] = march;
            if (!run) run = markStep("relight_maps", "start", { quick, lights: 0, w: targetW, h: targetH });
            run.lights++;
            cache.marching = (cache.marching || 0) + 1;
            this._relightMarches++;
            const p = (async () => {
                try {
                    const lm = lightToMap(l, depthMap, { depth_scale: depthScale });
                    const lightVec = [
                        (lm.mx / depthMap.w) * targetW,
                        (lm.my / depthMap.h) * targetH,
                        lm.mz * scaleFactor,
                        l.type === "sun" ? 1 : 0,
                    ];
                    const diff = Number.isFinite(l.diffusion) ? Number(l.diffusion) : 30;
                    const radius = (diff / 100.0) * (0.05 * Math.max(targetW, targetH));
                    const bias = 0.005 * marchScale;
                    const taps = quick ? 1 : 4;
                    const steps = quick ? 16 : 32;

                    let vChan;
                    const pool = editorPool();
                    const posted = performance.now();
                    if (pool && !pool.off) {
                        const stripes = kernelRoute("relightStripes"), feed = kernelRoute("relightFeed");
                        vChan = await marchOnPool(pool, {
                            depth: marchDepth,
                            w: targetW,
                            h: targetH,
                            scale: marchScale,
                            light: lightVec,
                            radius,
                            taps,
                            steps,
                            bias,
                            key: depthKey,
                        }, {
                            priority: quick ? INTERACTIVE : NORMAL,
                            group: march.group,
                            stripes: stripes === undefined ? STRIPES_PER_WORKER * pool.size : stripes,
                            budget: quick ? 0 : (feed === undefined ? pool.size + 1 : feed),
                        });
                    } else {
                        vChan = shadowMarch(marchDepth, targetW, targetH, marchScale, lightVec, radius, taps, steps, bias, 0, targetH);
                    }
                    // Into the map of this size that is there now (a quick map seeded again meanwhile takes it too). A march for
                    // the key the channel wants now (the light, the relief scale and the depth map at landing) always lands
                    // and outranks any older march still on its way; one for a light that has moved on lands only in the
                    // quick map and only over an older march: during a drag the quick map trails the pointer instead of
                    // waiting for it to stop. pickVis tells current from trailing by the keys.
                    const tv = quick ? cache.visQuick : cache.vis;
                    const current = vKey === this.relightChannelKey(layer, chan, quick);
                    markStep("relight_maps", "landed", { chan, quick, current, ms: Math.round((performance.now() - posted) * 10) / 10 });
                    if (tv && tv.w === targetW && tv.h === targetH && tv.keys[chan] !== vKey) {
                        const tickets = tv.tickets || (tv.tickets = [0, 0, 0, 0]);
                        if (current || (quick && ticket > (tickets[chan] || 0))) {
                            for (let idx = 0; idx < targetW * targetH; idx++) {
                                tv.data[idx * 4 + chan] = vChan[idx];
                            }
                            tv.keys[chan] = vKey;
                            tickets[chan] = current ? stamp() : ticket;
                            tv.seq = cache.seq = (cache.seq || 0) + 1;
                            if (!quick) this.dropQuickVis(layer);
                            this.markFilterChanged(layer, { soon: true });
                        }
                    }
                } catch (err) {
                    // a superseded march's cancelled stripes (the pool's CancelledError): a newer march of the channel took over
                    if (!(err && err.cancelled)) console.warn(`relight_shadow channel ${chan} failed:`, err);
                } finally {
                    cache.marching--;
                    this._relightMarches--;
                    if (!cache.marching) markStep("relight_maps", "idle", { quick });
                    if (!march.superseded) cache.pending.delete(pendingKey);   // a superseded one's key was freed when it was, and may be a newer march's now
                    if (fullMarches[chan] === march) fullMarches[chan] = null;
                    // the channel still lacks the key it wants now and no march for that key is on its way (a light turned
                    // off and on while its march ran, a march for a key left behind): ask for one
                    const want = this.relightChannelKey(layer, chan, quick);
                    const tvNow = quick ? cache.visQuick : cache.vis;
                    if (want && tvNow && Array.isArray(tvNow.keys) && tvNow.keys[chan] !== want
                        && !cache.pending.has(`v:${quick ? "q" : "f"}:${chan}:${want}`) && this.layers.includes(layer)) {
                        this.markFilterChanged(layer, { soon: true });
                    }
                }
            })();
            this._relightPending.add(p);
            p.finally(() => this._relightPending.delete(p));
        }
        if (!quick) this.dropQuickVis(layer);
    }

    /**
     * The key shadow channel `chan` of a relight layer wants now: its light, relief scale and the depth map as they are
     * (`relightVisKey`), null for a light that is off.
     * @param {any} layer
     * @param {number} chan
     * @param {boolean} quick
     */
    relightChannelKey(layer, chan, quick) {
        const p = layer.params || {};
        return relightVisKey((Array.isArray(p.lights) ? p.lights : [])[chan], relightDepthScale(p), relightMapKey(this.maps && this.maps.depth), quick);
    }

    /**
     * A relight layer's quick shadow map goes once its full map is current for its lights (F2.5): the next drag or slider
     * preview seeds a quick map from the full one, instead of showing the shadows of an earlier drag in its first frames.
     * @param {any} layer
     */
    dropQuickVis(layer) {
        const cache = layer && layer._relight;
        if (!cache || !cache.visQuick) return;
        if (relightVisCurrent(cache.vis, layer.params?.lights, relightDepthScale(layer.params), relightMapKey(this.maps && this.maps.depth), false)) {
            cache.visQuick = null;
        }
    }


    /**
     * Everything the composited image depends on. While it stays the same the last
     * scene canvas is reused and only the overlays (ants, cursor, handles) are redrawn.
     */
    sceneSignature() {
        const v = this.view;
        const p = this.pointer, q = this.pending;
        const parts = [this.pixelVersion, this.compositeVersion, this.width, this.height,
            this.canvas.width, this.canvas.height, Math.round(v.x * 8), Math.round(v.y * 8), v.scale, v.angle || 0,
            this.peekBase ? 1 : 0, this.compare ? `${this.compare.a}:${this.compare.b}:${this.compare.split}` : 0,
            this.compareShow || 0, this.filterPreview || 0, this.viewTilt() || 0,
            this.maskView ? `${this.maskView.id}:${this.maskView.mode}` : ""];
        for (const l of this.layers) {
            parts.push(l.id, this.shown(l) ? 1 : 0, l.opacity, l.blend, l.role, l.x, l.y, l.w, l.h,
                l.kind === "filter" ? l.filter + JSON.stringify(l.params || {}) + (this.mapsOf(l).length ? `:${this.mapsVersion || 0}` : "") : "",
                l.match ? `${l.match.strength}:${l.match.source}` : "", l.maskPx ? (l.maskOff ? 2 : 1) : 0, l.maskEdit ? 1 : 0);
        }
        if (p) parts.push("p", p.kind, p.layer ? p.layer.id : "");
        if (q) parts.push("q", q.mode, q.angle || 0, q.points ? q.points.join(",") : "");
        return parts.join("|");
    }

    drawScene() {
        if (!this.isOpen) return;
        const ctx = this.ctx;
        const W = this.canvas.width, H = this.canvas.height;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, W, H);
        if (!this.base) return;
        const s = this.view.scale;
        if (!this.sceneCanvas || this.sceneCanvas.width !== W || this.sceneCanvas.height !== H) {
            this.sceneCanvas = makeCanvas(W, H);
            this.sceneSig = null;
        }
        if (this.sceneSig !== this.sceneSignature()) {
            const sctx = this.sceneCanvas.getContext("2d");
            sctx.setTransform(1, 0, 0, 1, 0, 0);
            sctx.globalAlpha = 1;
            sctx.globalCompositeOperation = "source-over";
            sctx.clearRect(0, 0, W, H);
            this.applyViewTransform(sctx);
            this.applyTilt(sctx);
            sctx.imageSmoothingEnabled = s < 1;
            this._pyramidBudget = 1;
            this._pyramidPending = false;
            this.drawSceneImage(sctx, W, H);
            this._pyramidBudget = Infinity;
            this.sceneSig = this.sceneSignature();   // caches filled while drawing count as part of this scene
            if (this._pyramidPending) {
                // a source still has to build its level: draw again, sharper, on the next frame
                this.sceneSig = null;
                this.drawSoon();
            }
        }
        ctx.drawImage(this.sceneCanvas, 0, 0);
        this.applyViewTransform(ctx);
        ctx.imageSmoothingEnabled = s < 1;
        this.drawSceneOverlays(ctx);
    }

    /** The image itself: the base alone while peeking, the compare split, or the composite. */
    drawSceneImage(ctx, W, H) {
        if (this.peekBase) {
            const bs = this.basePx;
            // C6 (c2f): on tiles the peek is the view's composite of the base alone, from the base's tiles (the atlas on the
            // GPU path, its region canvas on Canvas 2D), shown stale or coarse until its chains land like any frame. The
            // whole base drawn through displaySource was its display mirror and a GPU copy of it (at 0.5 and up) or a Skia
            // pyramid (below): 572 MB and more at 15000 x 10000 on the first peek after a change.
            if (bs && isTilePixels(bs)) this.drawViewComposite(ctx, { baseOnly: true });
            else if (bs) ctx.drawImage(this.displaySource(bs, this.view.scale, true), 0, 0, this.width, this.height);
            return;
        }
        if (this.compare && this.compare.a && this.compare.b) {
            // A left, B right: two passes with the other result hidden; caches are invalidated between them
            const split = Math.min(0.95, Math.max(0.05, this.compare.split ?? 0.5));
            for (const side of ["a", "b"]) {
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.beginPath();
                if (side === "a") ctx.rect(0, 0, W * split, H); else ctx.rect(W * split, 0, W * (1 - split), H);
                ctx.clip();
                this.applyViewTransform(ctx);
                this.applyTilt(ctx);
                this.compareShow = this.compare[side];
                this.uploaded.baseHash = null;
                this.drawViewComposite(ctx);
                ctx.restore();
            }
            this.compareShow = null;
            this.uploaded.baseHash = null;
            this.applyViewTransform(ctx);
            return;
        }
        this.drawViewComposite(ctx);
    }

    cleanMaskView() {
        if (!this.maskView) return;
        const l = this.layers.find((x) => x.id === this.maskView.id);
        if (!l) { this.maskView = null; return; }
        if (this.maskView.mode !== "effect" && !l.maskPx) { this.maskView = null; return; }
        if (this.maskView.mode === "effect" && (l.kind !== "filter" || !(l.params && l.params.limit))) { this.maskView = null; return; }
    }

    /** Selection, crop frame, layer handles and the tool cursors, on top of the scene. */
    drawSceneOverlays(ctx) {
        const s = this.view.scale;
        // what sits on the picture turns with the straighten preview; the frame, the guides and the grid stay level
        const tilt = this.viewTilt();
        if (tilt) { ctx.save(); this.applyTilt(ctx); }
        // a patch drag: its preview under the outline, and the outline where the drag has taken it
        const patch = this.pointer && this.pointer.kind === "patchdrag" ? this.pointer : null;
        if (patch) this.drawPatchPreview(ctx, patch);
        this.drawLiquifyFreeze(ctx);
        const shift = patch && patch.moved && (patch.d[0] || patch.d[1]) ? patch.d : null;
        if (this.selectionDisplay === "tint" || this.quickMask || !this.getBounds()) {
            // an empty selection on tiles (no tile) draws nothing: its draw made a display mirror as large as the
            // image, and a GPU copy of it at 0.5 or more, for transparent pixels (C2's final review)
            if (!this.selectionHasNoTiles()) {
                ctx.globalAlpha = this.quickMask ? 0.5 : 0.4;
                const region = this.viewportRegion();
                if (shift) { ctx.save(); ctx.translate(shift[0], shift[1]); }
                this.drawSelectionInto(ctx, s, shift && region ? { ...region, x: region.x - shift[0], y: region.y - shift[1] } : region);
                if (shift) ctx.restore();
                ctx.globalAlpha = 1;
            }
        } else {
            // the outline stays where the selection is, and a second one follows the drag
            this.drawMarchingAnts(ctx);
            if (shift) this.drawMarchingAnts(ctx, shift);
        }

        if (this.tool === "object" && this.hoverObjectCanvas && !this.spaceDown) {
            // the object under the cursor, red shape shown in cyan
            ctx.save();
            ctx.globalAlpha = 0.5;
            try { ctx.filter = "hue-rotate(180deg)"; } catch (_) { /* old canvas */ }
            ctx.drawImage(this.displaySource(this.hoverObjectCanvas, s), 0, 0, this.width, this.height);
            ctx.restore();
        }

        if (this.mapView === "depth" && !this.spaceDown) {
            const map = (this.maps && this.maps.depth) || this.depth;
            if (map) {
                const proxy = this.depthProxy2048(map);
                if (proxy) {
                    const xf = map.xf || [this.width, 0, 0, this.height, 0, 0];
                    ctx.save();
                    ctx.transform(...xf);
                    ctx.drawImage(proxy, 0, 0, 1, 1);
                    ctx.restore();
                }
            }
        } else if (this.showDepthMap && this.depth && !this.spaceDown) {
            this.drawDepthOverlay(ctx);
        }

        if (this._rangeTint && !this.spaceDown) {
            ctx.save();
            ctx.globalAlpha = 0.4;
            if (this._rangeTint.xf) {
                ctx.transform(...this._rangeTint.xf);
                ctx.drawImage(this._rangeTint.canvas, 0, 0, 1, 1);
            } else if (this._rangeTint.box) {
                const [bx, by, bw, bh] = this._rangeTint.box;
                ctx.drawImage(this._rangeTint.canvas, bx, by, bw, bh);
            } else {
                ctx.drawImage(this._rangeTint.canvas, 0, 0, this.width, this.height);
            }
            ctx.restore();
        }

        this.cleanMaskView();
        if (this.maskView && (this.maskView.mode === "overlay" || this.maskView.mode === "alone")) {
            const vl = this.layers.find((l) => l.id === this.maskView.id);
            if (vl && vl.maskPx) {
                const vw = this.canvas.width, vh = this.canvas.height;
                const region = this.viewportRegion();
                if (this.maskView.mode === "overlay") {
                    const sc = this.passScratch("maskOverlay", vw, vh);
                    const sctx = sc.getContext("2d");
                    sctx.save();
                    try {
                        sctx.setTransform(1, 0, 0, 1, 0, 0);
                        sctx.globalCompositeOperation = "source-over";
                        sctx.globalAlpha = 1;
                        sctx.clearRect(0, 0, vw, vh);
                        sctx.fillStyle = "#ff0000";
                        sctx.fillRect(0, 0, vw, vh);
                        sctx.globalCompositeOperation = "destination-out";
                        this.applyViewTransform(sctx);
                        if (tilt) this.applyTilt(sctx);
                        this.drawMaskInto(sctx, vl, s, region, true);
                    } finally {
                        sctx.restore();
                    }
                    ctx.save();
                    ctx.setTransform(1, 0, 0, 1, 0, 0);
                    ctx.globalCompositeOperation = "source-over";
                    ctx.globalAlpha = 0.5;
                    ctx.drawImage(sc, 0, 0);
                    ctx.restore();
                } else if (this.maskView.mode === "alone") {
                    const lx = vl.kind === "filter" ? 0 : vl.x;
                    const ly = vl.kind === "filter" ? 0 : vl.y;
                    const lw = vl.kind === "filter" ? this.width : vl.w;
                    const lh = vl.kind === "filter" ? this.height : vl.h;
                    ctx.save();
                    ctx.fillStyle = "#000000";
                    ctx.globalAlpha = 1;
                    ctx.globalCompositeOperation = "source-over";
                    ctx.fillRect(lx, ly, lw, lh);
                    ctx.restore();
                    const sc = this.passScratch("maskAlone", vw, vh);
                    const sctx = sc.getContext("2d");
                    sctx.save();
                    try {
                        sctx.setTransform(1, 0, 0, 1, 0, 0);
                        sctx.globalCompositeOperation = "source-over";
                        sctx.globalAlpha = 1;
                        sctx.clearRect(0, 0, vw, vh);
                        sctx.fillStyle = "#ffffff";
                        sctx.fillRect(0, 0, vw, vh);
                        sctx.globalCompositeOperation = "destination-in";
                        this.applyViewTransform(sctx);
                        if (tilt) this.applyTilt(sctx);
                        this.drawMaskInto(sctx, vl, s, region, true);
                    } finally {
                        sctx.restore();
                    }
                    ctx.save();
                    ctx.setTransform(1, 0, 0, 1, 0, 0);
                    ctx.globalCompositeOperation = "source-over";
                    ctx.globalAlpha = 1;
                    ctx.drawImage(sc, 0, 0);
                    ctx.restore();
                }
            }
        }

        if (this.getBounds()) {
            const [x, y, w, h] = this.cropRect();
            ctx.save();
            ctx.setLineDash([6 / s, 4 / s]);
            ctx.lineWidth = 1.5 / s;
            ctx.strokeStyle = "#4a90d9";
            ctx.strokeRect(x, y, w, h);
            ctx.restore();
        }

        // reference layers: cyan frame with their batch index
        const refs = this.referenceLayers();
        if (refs.length) {
            ctx.save();
            ctx.lineWidth = 1.5 / s;
            ctx.strokeStyle = "#7cc7ff";
            ctx.fillStyle = "#7cc7ff";
            ctx.font = `${Math.max(11, 13 / s)}px system-ui, sans-serif`;
            ctx.textBaseline = "top";
            refs.forEach((l, i) => {
                ctx.setLineDash([5 / s, 3 / s]);
                ctx.strokeRect(l.x, l.y, l.w, l.h);
                ctx.setLineDash([]);
                const label = refBadge(i);
                const tw = ctx.measureText(label).width + 8 / s, th = Math.max(11, 13 / s) + 4 / s;
                ctx.globalAlpha = 0.85;
                ctx.fillRect(l.x, l.y, tw, th);
                ctx.globalAlpha = 1;
                ctx.fillStyle = "#10202c";
                ctx.fillText(label, l.x + 4 / s, l.y + 2 / s);
                ctx.fillStyle = "#7cc7ff";
            });
            ctx.restore();
        }
        const maskLayer = this.layers.find((l) => l.maskPx && l.maskEdit && this.shown(l));
        if (maskLayer) {
            ctx.save();
            ctx.lineWidth = 2 / s;
            ctx.strokeStyle = "#ff66cc";
            ctx.setLineDash([4 / s, 4 / s]);
            ctx.strokeRect(maskLayer.x, maskLayer.y, maskLayer.w, maskLayer.h);
            ctx.restore();
        }

        const active = this.activeLayer();
        const pend = this.pending;
        if (pend && pend.layer) {
            ctx.save();
            ctx.lineWidth = 1 / s;
            ctx.strokeStyle = "#ffb347";
            ctx.fillStyle = "#ffb347";
            const r = HANDLE_PX / s / 2;
            if (pend.mode === "rotate") {
                const l = pend.layer;
                const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
                ctx.translate(cx, cy); ctx.rotate(pend.angle); ctx.translate(-cx, -cy);
                ctx.strokeRect(l.x, l.y, l.w, l.h);
                const handles = this.layerHandles(l);
                for (const name of ["nw", "ne", "sw", "se"]) { const [hx, hy] = handles[name]; ctx.fillRect(hx - r, hy - r, r * 2, r * 2); }
                ctx.fillStyle = "#1e1e1e";
                for (const name of ["n", "s", "w", "e"]) { const [hx, hy] = handles[name]; ctx.beginPath(); ctx.arc(hx, hy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
                ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
            } else if (pend.mode === "distort") {
                ctx.beginPath();
                pend.points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
                ctx.closePath();
                ctx.stroke();
                for (const [x, y] of pend.points) ctx.fillRect(x - r, y - r, r * 2, r * 2);
            } else if (pend.mode === "warp") {
                const n = pend.n;
                ctx.setLineDash([3 / s, 3 / s]);
                for (let j = 0; j <= n; j++) { ctx.beginPath(); for (let i = 0; i <= n; i++) { const [x, y] = pend.points[j * (n + 1) + i]; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); }
                for (let i = 0; i <= n; i++) { ctx.beginPath(); for (let j = 0; j <= n; j++) { const [x, y] = pend.points[j * (n + 1) + i]; j ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); }
                ctx.setLineDash([]);
                for (const [x, y] of pend.points) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
            }
            ctx.restore();
        } else if (active && (this.tool === "transform" || this.tool === "paint" || this.tool === "erase")) {
            ctx.save();
            ctx.lineWidth = 1 / s;
            ctx.strokeStyle = "#ffb347";
            // a multi-selection: each selected layer's outline dashed, the handles on the box around all of them
            const group = this.tool === "transform" ? this.groupBox() : null;
            if (group) {
                ctx.setLineDash([4 / s, 4 / s]);
                for (const l of group.layers) ctx.strokeRect(l.x, l.y, l.w, l.h);
            }
            const box = group || active;
            ctx.setLineDash(this.tool === "transform" ? [] : [4 / s, 4 / s]);
            ctx.strokeRect(box.x, box.y, box.w, box.h);
            if (this.tool === "transform") {
                const r = HANDLE_PX / s / 2;
                ctx.fillStyle = "#ffb347";
                const handles = this.layerHandles(box);
                for (const name of ["nw", "ne", "sw", "se"]) { const [cx, cy] = handles[name]; ctx.fillRect(cx - r, cy - r, r * 2, r * 2); }
                ctx.fillStyle = "#1e1e1e";
                for (const name of ["n", "s", "w", "e"]) { const [cx, cy] = handles[name]; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
            }
            ctx.restore();
        }

        if (tilt) ctx.restore();
        if (this.tool === "canvas" && this.width) this.drawCanvasFrame(ctx);
        if (this.snapGuides && this.pointer && (this.pointer.kind === "move" || this.pointer.kind === "scale")) {
            ctx.save();
            ctx.strokeStyle = "#ff66cc";
            ctx.lineWidth = 1 / s;
            ctx.setLineDash([6 / s, 4 / s]);
            for (const gx of this.snapGuides.x) { ctx.beginPath(); ctx.moveTo(gx, -1e5); ctx.lineTo(gx, 1e5); ctx.stroke(); }
            for (const gy of this.snapGuides.y) { ctx.beginPath(); ctx.moveTo(-1e5, gy); ctx.lineTo(1e5, gy); ctx.stroke(); }
            ctx.restore();
        }

        const p = this.pointer;
        if (p && p.kind === "rect") {
            ctx.save();
            this.antsStroke(ctx, () => {
                if (p.ellipse) {
                    ctx.beginPath();
                    ctx.ellipse((p.start[0] + p.cur[0]) / 2, (p.start[1] + p.cur[1]) / 2, Math.abs(p.cur[0] - p.start[0]) / 2, Math.abs(p.cur[1] - p.start[1]) / 2, 0, 0, Math.PI * 2);
                    ctx.stroke();
                } else {
                    ctx.strokeRect(p.start[0], p.start[1], p.cur[0] - p.start[0], p.cur[1] - p.start[1]);
                }
            }, s);
            ctx.restore();
        }
        if (p && p.kind === "object" && p.moved && p.startImg && p.curImg) {
            ctx.save();
            ctx.strokeStyle = "#4a90d9";
            ctx.lineWidth = 1.5 / s;
            ctx.setLineDash([6 / s, 4 / s]);
            ctx.strokeRect(p.startImg[0], p.startImg[1], p.curImg[0] - p.startImg[0], p.curImg[1] - p.startImg[1]);
            ctx.restore();
        }
        if (this.lassoPoints && this.lassoPoints.length > 1) {
            ctx.save();
            this.antsStroke(ctx, () => {
                ctx.beginPath();
                ctx.moveTo(this.lassoPoints[0][0], this.lassoPoints[0][1]);
                for (const [x, y] of this.lassoPoints) ctx.lineTo(x, y);
                ctx.stroke();
            }, s);
            ctx.restore();
        }
        if (this.polyPoints && this.polyPoints.length) {
            const pts = this.polyPoints;
            ctx.save();
            this.antsStroke(ctx, () => {
                ctx.beginPath();
                ctx.moveTo(pts[0][0], pts[0][1]);
                for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
                if (this.hover) ctx.lineTo(this.hover[0], this.hover[1]);
                ctx.stroke();
            }, s);
            ctx.setLineDash([]);
            const r = 4 / s;
            ctx.fillStyle = "#fff";
            for (const [x, y] of pts) ctx.fillRect(x - r / 2, y - r / 2, r, r);
            // the first point is the closing target: a ring, larger when the cursor is within reach
            const closeNear = this.hover && pts.length >= 3 && Math.hypot(this.hover[0] - pts[0][0], this.hover[1] - pts[0][1]) <= 8 / s;
            ctx.strokeStyle = closeNear ? "#7cc7ff" : "#fff";
            ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], (closeNear ? 8 : 5) / s, 0, Math.PI * 2); ctx.stroke();
            ctx.restore();
        }
        if (this.shapePoints && this.shapePoints.length) {
            const pts = this.shapePoints;
            const closed = this.shapeOpts.kind !== "polyline";
            ctx.save();
            this.antsStroke(ctx, () => {
                ctx.beginPath();
                this.shapePointPath(ctx, pts, false, this.hover && !this.shapeDrag ? this.hover : null);
                ctx.stroke();
            }, s);
            ctx.setLineDash([]);
            const r = 4 / s;
            ctx.fillStyle = "#fff";
            for (const q of pts) ctx.fillRect(q.x - r / 2, q.y - r / 2, r, r);
            if (this.shapeOpts.kind === "bezier") {
                ctx.strokeStyle = "#7cc7ff";
                ctx.lineWidth = 1 / s;
                for (const q of pts) {
                    if (!q.hx && !q.hy) continue;
                    ctx.beginPath();
                    ctx.moveTo(q.x - q.hx, q.y - q.hy); ctx.lineTo(q.x + q.hx, q.y + q.hy);
                    ctx.stroke();
                }
            }
            // the first point closes the shape: a ring, larger when the cursor is within reach
            const closeNear = closed && this.hover && pts.length >= 2 && Math.hypot(this.hover[0] - pts[0].x, this.hover[1] - pts[0].y) <= 8 / s;
            ctx.strokeStyle = closeNear ? "#7cc7ff" : "#fff";
            ctx.lineWidth = 1 / s;
            ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, (closeNear ? 8 : 5) / s, 0, Math.PI * 2); ctx.stroke();
            ctx.restore();
        }
        if ((this.tool === "clone" || this.tool === "heal") && this.cloneSource) {
            // the source: a crosshair, and the point the brush copies from follows it: during a stroke at the stroke's
            // lining up, before one at the lining up the next press takes (the kept offset when Aligned, else the press)
            const o = this.cloneOpts || {}, pc = this.pointer && this.pointer.clone, hv = this.hover;
            const S = pc && pc.S ? pc.S : this.cloneSource, xf = pc ? pc.xf : this.cloneXf(o);
            const off = pc ? pc.off : (o.aligned && this.cloneOffset ? this.cloneOffset : null);
            const D = off ? { x: S.x - off.x, y: S.y - off.y } : hv ? { x: hv[0], y: hv[1] } : null;
            const q = hv && D ? (xf ? [S.x + xf.A[0] * (hv[0] - D.x) + xf.A[1] * (hv[1] - D.y), S.y + xf.A[2] * (hv[0] - D.x) + xf.A[3] * (hv[1] - D.y)] : [hv[0] + S.x - D.x, hv[1] + S.y - D.y]) : [S.x, S.y];
            if (o.overlay !== false && hv && D && !this.compare && !this.peekBase) this.drawCloneGhost(ctx, hv, D, S, xf, q);
            ctx.save();
            ctx.strokeStyle = "#7cc7ff";
            ctx.lineWidth = 1 / s;
            const cr = this.brushSize / 2 / (xf ? xf.k : 1), k = 6 / s;
            ctx.beginPath(); ctx.arc(q[0], q[1], cr, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(q[0] - k, q[1]); ctx.lineTo(q[0] + k, q[1]); ctx.moveTo(q[0], q[1] - k); ctx.lineTo(q[0], q[1] + k); ctx.stroke();
            ctx.restore();
        }
        if (p && p.stab && p.last && this.hover && (p.last[0] !== this.hover[0] || p.last[1] !== this.hover[1])) {
            // the stabiliser's string, from where the brush is to the cursor
            ctx.save();
            ctx.strokeStyle = "#7cc7ff"; ctx.lineWidth = 1 / s; ctx.setLineDash([4 / s, 3 / s]);
            ctx.beginPath(); ctx.moveTo(p.last[0], p.last[1]); ctx.lineTo(this.hover[0], this.hover[1]); ctx.stroke();
            ctx.restore();
        }
        if (!(p && p.kind === "pan") && !this.spaceDown) this.drawBrushRing(ctx, s);
    }

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

    getValue() {
        if (!this.base) return this.lastValueString || "{}";
        if (this.sel && !this.selectionEncoded) {
            if (this.width * this.height <= SYNC_ENCODE_PX) {
                this.selectionDataUrl = this.sel.toCanvas().toDataURL("image/png");
                this.selectionBox = null;
                this.selectionEncoded = true;
            } else {
                // a 100 MP toDataURL blocks the editor for seconds: encode in the background,
                // keep the last finished PNG until it lands
                this.encodeSelectionSoon();
            }
        }
        return JSON.stringify({
            width: this.width,
            height: this.height,
            base: this.base.ref,
            prompt: this.promptText,
            groups: this.groupsCopy(),
            layers: this.layers.map((l) => ({
                id: l.id, name: l.name, kind: l.kind, role: l.role || "none", blend: l.blend || "normal", ref: l.ref,
                x: l.x, y: l.y, w: l.w, h: l.h, opacity: l.opacity, visible: l.visible, mask: l.maskRef || null,
                ...(l.maskOff && l.maskPx ? { maskOff: true } : {}),
                ...(l.match && l.match.strength > 0 ? { match: l.match } : {}),
                ...(l.locked ? { locked: true } : {}),
                ...(l.alphaLock ? { alphaLock: true } : {}),
                ...(l.clip ? { clip: true } : {}),
                ...(l.group ? { group: l.group } : {}),
                ...(l.kind === "filter" ? { filter: l.filter, params: l.params, lut: l.lut || null, plate: l.plate || null } : {}),
                ...(l.kind === "text" && l.text ? { text: l.text } : {}),
                ...(l.relightOf ? { relightOf: l.relightOf } : {}),
            })),
            history: this.history.slice(-100).map((h) => ({ key: h.key, name: h.name, ref: h.ref, x: h.x, y: h.y, w: h.w, h: h.h, prompt: h.prompt, layerId: h.layerId, time: h.time, seed: h.seed, mode: h.mode, denoise: h.denoise,
                ...(h.negative ? { negative: h.negative } : {}), ...(h.refs && typeof h.refs === "object" ? { refs: { ...h.refs } } : {}),
                ...(orientIsUp(h.orient) ? {} : { orient: { ...h.orient } }), ...(validXf(h.xf) ? { xf: h.xf.slice() } : {}) })),
            selection: this.selectionDataUrl,
            // E5: where the selection's PNG goes when it holds a box of the mask and not all of it ([x, y, w, h])
            ...(this.selectionDataUrl && this.selectionBox ? { selectionBox: this.selectionBox } : {}),
            selections: (this.savedSelections || []).map((s) => ({ name: s.name, url: s.url, ...(orientIsUp(s.orient) ? {} : { orient: { ...s.orient } }), ...(validXf(s.xf) ? { xf: s.xf.slice() } : {}) })),
            guides: this.guides && (this.guides.x.length || this.guides.y.length) ? this.guides : undefined,
            seen: Array.from(this.seenResults).slice(-200),
            crop: this.cropSettings,
            upsample: this.upsampleSettings,
            gen: this.genSettings,
            negative: this.negativeText,
            settings: this.settings,
            refs: this.refSettings,
            cutout: this.cutoutSettings,
            // the node keeps its boxes in the workflow (the app saves pluginData beside the state: host.js)
            ...(host.boxesInEditor && this.pluginData && this.pluginData.boxes && Array.isArray(this.pluginData.boxes.boxes) && this.pluginData.boxes.boxes.length ? { boxes: this.pluginData.boxes } : {}),
            depth: this.depth ? {
                w: this.depth.w,
                h: this.depth.h,
                origW: this.depth.origW,
                origH: this.depth.origH,
                rw: this.depth.rw,
                rh: this.depth.rh,
                lo: this.depth.lo,
                hi: this.depth.hi,
                hash: this.depth.hash,
                version: this.depth.version,
                provider: this.depth.provider,
                ms: this.depth.ms,
                totalMs: this.depth.totalMs,
                thumb: this.depth.thumb ? Array.from(this.depth.thumb) : null,
            } : null,
            maps: (this.maps && Object.keys(this.maps).length > 0) ? (() => {
                const out = {};
                for (const [k, m] of Object.entries(this.maps)) {
                    if (!m) continue;
                    const j = mapToJSON(m);
                    if (j) out[k] = j;
                }
                return Object.keys(out).length > 0 ? out : undefined;
            })() : undefined,
        });
    }

    async setValue(value) {
        let state = null;
        try { state = typeof value === "string" ? JSON.parse(value || "{}") : (value || {}); } catch (_) { state = null; }
        if (!state || !state.base) return;
        const raw = typeof value === "string" ? value : JSON.stringify(value);
        if (raw === this.lastValueString && (this.base || this._loading)) return;
        this.lastValueString = raw;
        const token = (this._loadToken = (this._loadToken || 0) + 1);
        const stale = () => this._loadToken !== token;
        this._loading = true;
        try {
            // E5: the files of a document larger than any canvas are PNGs the browser's decoder has nowhere to put; they
            // are fetched and decoded as a stream into tiles. On tiles every other large file (the base the user opened,
            // a full-size layer) is decoded off the window too (`pixelsOffThread`); small ones load as they always did.
            // A file is fetched once: its pixels come from a reader (`{ px }`), or it is handed back (`{ blob }`) for the
            // <img>; on the canvas backend nothing is fetched here.
            const streamed = async (ref, Cls) => {
                if (!this.tileMode) return null;
                const blob = await (await fetch(viewUrl(ref))).blob();
                const px = await pixelsOffThread(blob, Cls);
                return px ? { px } : { blob };
            };
            const imageOf = async (got, ref) => (got && got.blob ? imageOfBlob(got.blob) : loadImageEl(viewUrl(ref)));
            const baseGot = await streamed(state.base, this.pixels.Layer);
            if (stale()) { if (baseGot && baseGot.px) baseGot.px.release(); return; }
            if (baseGot && baseGot.px) await this.setBasePixels(state.base, baseGot.px, { keepLayers: false });
            else {
                const img = await imageOf(baseGot, state.base);
                if (stale()) return;
                await this.setBase(state.base, img, { keepLayers: false });
            }
            this._rangeTint = null;
            this.mapView = null;
            this.maskView = null;
            this._pendingPick = null;
            this._pendingPickTarget = null;
            if (this.depthViewBtn) this.depthViewBtn.classList.remove("ipc-toggle-on");
            this.setPromptText(state.prompt || "", { history: "reset" });
            this.cropSettings = state.crop ? { ...CROP_DEFAULTS, ...state.crop } : { ...CROP_LEGACY };
            this.syncCropControls();
            this.upsampleSettings = { useCase: "auto", backend: "auto", ...(state.upsample || {}) };
            this.refreshSegmentBackends();
            this.genSettings = { ...GEN_DEFAULTS, seed: randomSeed(), ...(state.gen || {}) };
            if (host.boxesInEditor) {
                // the node's boxes come back with the workflow (getValue); a state without them has none
                if (!this.pluginData || typeof this.pluginData !== "object") this.pluginData = {};
                if (state.boxes && typeof state.boxes === "object" && Array.isArray(state.boxes.boxes)) this.pluginData.boxes = JSON.parse(JSON.stringify(state.boxes));
                else delete this.pluginData.boxes;
            }
            this.setNegativeText(state.negative || "");
            this.settings = state.settings && typeof state.settings === "object" ? { ...state.settings } : {};
            this.refSettings = { ...REF_DEFAULTS, ...(state.refs || {}) };
            this.cutoutSettings = { backend: "auto", ...(state.cutout || {}) };
            this.syncRefControls();
            this.syncGenControls();
            this.renderSettings();
            const textToRender = [];
            // groups as folders (PLAN_0_1_31 §6.5): the list, each layer's `group` below; normalizeGroups drops what does not fit
            this.groups = (Array.isArray(state.groups) ? state.groups : []).filter((g) => g && typeof g.id === "string").map((g) => ({
                id: g.id, name: String(g.name || "Group"), visible: g.visible !== false, locked: !!g.locked, collapsed: !!g.collapsed, parent: typeof g.parent === "string" ? g.parent : null }));
            this.activeGroupId = null;
            // a list drawn while a layer loads (an await below) must not drop a group whose layers are not in yet
            this.holdGroups = (this.holdGroups || 0) + 1;
            // what is left out says so (docs/PLAN_0_1_50.md Q4): a layer of a kind a newer version wrote without a file,
            // a filter layer that would not load, and a pixel layer whose file would not (by name: `missing`)
            let newer = 0, failed = 0;
            const missing = [], redrawn = [];
            this.leftOut = null;
            this._loadNote = null;
            // a text layer drawn again from its description (no file, or one that would not load): rendered after the loop
            const textLayer = (l, match = { strength: 0, source: "surroundings" }) => {
                const layer = { id: l.id, name: l.name, kind: "text", role: l.role || "none", blend: normalBlend(l.blend), ref: null, px: this.pixels.Layer.empty(1, 1), x: l.x, y: l.y, w: 1, h: 1, opacity: l.opacity ?? 1, visible: l.visible !== false, dirty: true, locked: !!l.locked, alphaLock: !!l.alphaLock, clip: !!l.clip, group: l.group || null, maskPx: null, maskRef: null, maskDirty: false, maskEdit: false, match, text: { ...TEXT_DEFAULTS, ...l.text } };
                this.layers.push(installLayerAliases(layer, this.pixels));
                this.textCounter = (this.textCounter || 0) + 1;
                textToRender.push(layer);
            };
            try {
                for (const l of state.layers || []) {
                    if (l.kind === "filter") {
                        try {
                            const pixels = this.pixels.Layer.empty(this.width, this.height);
                            let maskPx = null;
                            if (l.mask && l.mask.filename) {
                                try { maskPx = this.pixels.Mask.fromImage(await loadImageEl(viewUrl(l.mask)), pixels.width, pixels.height); } catch (err) { console.warn("Inpaint Canvas: layer mask missing", l.mask, err); }
                                if (stale()) return;
                            }
                            let lutData = null;
                            if (l.lut && l.lut.ref) {
                                try { lutData = lutFromImage(await loadImageEl(viewUrl(l.lut.ref)), l.lut.size); } catch (err) { console.warn("Inpaint Canvas: LUT missing", l.lut, err); }
                                if (stale()) return;
                            }
                            let plateImg = null;
                            if (l.plate && l.plate.ref) {
                                try { plateImg = await loadImageEl(viewUrl(l.plate.ref)); } catch (err) { console.warn("Inpaint Canvas: grain plate missing", l.plate, err); }
                                if (stale()) return;
                            }
                            // an id that is not installed here (a plugin switched off, a document from elsewhere) is kept with
                            // its params: applyFilter passes the picture through, and the next save writes it back unchanged
                            const fid = typeof l.filter === "string" && l.filter ? l.filter : "grain";
                            this.layers.push(installLayerAliases({
                                id: l.id, name: l.name, kind: "filter", role: "none", blend: normalBlend(l.blend), ref: null, px: pixels,
                                x: 0, y: 0, w: this.width, h: this.height, opacity: l.opacity ?? 1, visible: l.visible !== false, dirty: false, locked: !!l.locked, clip: !!l.clip, group: l.group || null,
                                maskPx, maskRef: maskPx ? l.mask : null, maskDirty: false, maskEdit: false, maskOff: !!(maskPx && l.maskOff),
                                filter: fid, params: FILTERS[fid] ? { ...filterDefaults(fid), ...(l.params || {}) } : { ...(l.params || {}) }, lut: l.lut || null, _lutData: lutData,
                                plate: plateImg ? l.plate : null, _plateImg: plateImg,
                            }, this.pixels));
                            this.filterCounter += 1;
                        } catch (err) {
                            console.warn("Inpaint Canvas: filter layer skipped", l, err);
                            failed += 1;
                        }
                        continue;
                    }
                    if (l.kind === "text" && l.text && !l.ref) {
                        // never uploaded (editor closed without sync): render it again from its description
                        textLayer(l);
                        continue;
                    }
                    if (!l.ref) {
                        if (typeof l.kind === "string" && l.kind && !LAYER_KINDS.has(l.kind)) newer += 1;
                        continue;
                    }
                    try {
                        const got = await streamed(l.ref, this.pixels.Layer);
                        if (stale()) { if (got && got.px) got.px.release(); return; }
                        let pixels = got && got.px;
                        if (!pixels) {
                            const limg = await imageOf(got, l.ref);
                            if (stale()) return;
                            pixels = this.pixels.Layer.fromImage(limg);
                        }
                        let maskPx = null;
                        if (l.mask && l.mask.filename) {
                            try { maskPx = this.pixels.Mask.fromImage(await loadImageEl(viewUrl(l.mask)), pixels.width, pixels.height); } catch (err) { console.warn("Inpaint Canvas: layer mask missing", l.mask, err); }
                            if (stale()) return;
                        }
                        this.layers.push(installLayerAliases({
                            id: l.id, name: l.name, kind: l.kind || "result", role: l.role || "none", blend: normalBlend(l.blend),
                            ref: l.ref, px: pixels,
                            x: l.x, y: l.y, w: l.w, h: l.h, opacity: l.opacity ?? 1, visible: l.visible !== false, dirty: false, locked: !!l.locked, alphaLock: !!l.alphaLock, clip: !!l.clip, group: l.group || null,
                            maskPx, maskRef: maskPx ? l.mask : null, maskDirty: false, maskEdit: false, maskOff: !!(maskPx && l.maskOff),
                            match: l.match && typeof l.match === "object" ? { strength: +l.match.strength || 0, source: l.match.source === "underneath" ? "underneath" : "surroundings" } : { strength: 0, source: "surroundings" },
                            relightOf: l.relightOf || null,
                            ...(l.kind === "text" && l.text ? { text: { ...TEXT_DEFAULTS, ...l.text } } : {}),
                        }, this.pixels));
                        if (l.kind === "paint") this.paintCounter += 1;
                        if (l.kind === "text") this.textCounter = (this.textCounter || 0) + 1;
                    } catch (err) {
                        console.warn("Inpaint Canvas: layer missing", l.ref, err);
                        const name = String(l.name || l.id || "layer");
                        if (l.kind === "text" && l.text && typeof l.text === "object") {
                            // a text layer is drawn again from its description, as one never stored is (its mask, if it had
                            // one, is not: the mask's size is the rendered pixels')
                            const match = l.match && typeof l.match === "object" ? { strength: +l.match.strength || 0, source: l.match.source === "underneath" ? "underneath" : "surroundings" } : undefined;
                            textLayer(l, match);
                            redrawn.push(name + (l.mask && l.mask.filename ? " (without its mask)" : ""));
                        } else missing.push(name);
                    }
                }
            } finally { this.holdGroups--; }
            if (newer || failed || missing.length || redrawn.length) {
                this.leftOut = { newer, failed, missing: missing.length, names: missing, redrawn: redrawn.length, redrawnNames: redrawn, note: leftOutText(newer, failed, missing, redrawn) };
                this.setStatus(this.leftOut.note, "warn");
                this._loadNote = { note: this.leftOut.note, lines: LOAD_NOTE_LINES, until: Date.now() + LOAD_NOTE_MS };
            }
            this.normalizeGroups();   // a layer that failed to load may leave a group empty
            if (textToRender.length) {
                await loadFontList();
                if (stale()) return;
                for (const layer of textToRender) await this.renderTextLayer(layer, { keepScale: false });
                if (stale()) return;
            }
            // the labels the prompt was saved with, then remapped to the labels of what loaded: the same when every
            // layer came back, and a reference that failed to load gets its tokens parked instead of shifting the others
            if (host.refTokens) {
                this.refMap = labelMap((state.layers || []).filter((l) => l && l.role === "reference" && l.visible !== false).reverse());
                this.refsMutated({ restore: true });
            }
            this.history = (state.history || []).map((h) => ({ ...h }));
            this.savedSelections = Array.isArray(state.selections) ? state.selections.filter((s) => s && s.url).map((s) => ({ name: s.name || "Selection", url: s.url,
                ...(orientIsUp(s.orient) ? {} : { orient: { turn: ((s.orient.turn | 0) & 3), flip: !!s.orient.flip } }), ...(validXf(s.xf) ? { xf: s.xf.map(Number) } : {}) })) : [];
            this.guides = state.guides && Array.isArray(state.guides.x) && Array.isArray(state.guides.y) ? { x: state.guides.x.map(Number), y: state.guides.y.map(Number) } : { x: [], y: [] };
            this.renderSelectionList();
            for (const key of state.seen || []) this.seenResults.add(key);
            if (state.selection) {
                const sb = Array.isArray(state.selectionBox) && state.selectionBox.length === 4 ? state.selectionBox.map((v) => Math.round(+v) || 0) : null;
                if (!sb && this.huge) {
                    // E5: the whole mask of a document larger than any canvas, decoded as a stream into mask tiles
                    const blob = await (await fetch(state.selection)).blob();
                    const px = await pixelsFromPngStream(blob, this.pixels.Mask);
                    if (stale()) { px.release(); return; }
                    if (px.width === this.width && px.height === this.height) { this.sel.release(); this.sel = px; }
                } else {
                    const sel = await loadImageEl(state.selection);
                    if (stale()) return;
                    // over what setBase left (source-over, as always: a same-size restore keeps the old selection too);
                    // a PNG of a box of the mask (E5, `selectionBox`) into that box
                    if (sb) this.sel.drawInto([sb[0], sb[1], sb[0] + sb[2], sb[1] + sb[3]], (ctx) => ctx.drawImage(sel, sb[0], sb[1]));
                    else this.sel.drawInto(null, (ctx) => ctx.drawImage(sel, 0, 0));
                }
                // touched after the write: setBase's info line and first frame built the display
                // levels of the empty selection under the same version, and above 1 MP the bounds
                // came from those, so a restored selection counted as none
                this.touchSource(this.sel);
                this.selectionDirty = true; this.selectionLoose = false;
                // and encoded again: a getValue while the layers loaded (the app's autosave, ComfyUI
                // serializing the graph) stored the empty selection's PNG as up to date, and every
                // later save wrote that until the selection was changed by hand
                this.selectionSeq++;
                this.selectionEncoded = false;
                this.selectionDataUrl = null;
            }
            if (state.depth) {
                let thumb = null;
                if (Array.isArray(state.depth.thumb)) {
                    thumb = new Uint8Array(state.depth.thumb);
                } else if (typeof state.depth.thumb === "string") {
                    const bin = atob(state.depth.thumb);
                    thumb = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) thumb[i] = bin.charCodeAt(i);
                }
                this.depth = {
                    ...state.depth,
                    thumb,
                    u16: null,
                    raw: null,
                    stale: true,
                };
            } else {
                this.depth = null;
            }
            this.maps = {};
            if (state.maps && typeof state.maps === "object") {
                for (const [kind, j] of Object.entries(state.maps)) {
                    if (!j || !j.ref) continue;
                    try {
                        const map = await mapFromJSON(kind, j, async (ref) => loadImageEl(viewUrl(ref)));
                        if (stale()) return;
                        if (map) {
                            this.maps[kind] = map;
                            if (kind === "depth" && j.guide && !map.guide) {
                                this.setStatus("the depth map's guide is missing; Recompute restores the edges", "warn");
                            }
                        } else {
                            this.setStatus(`Map "${kind}" could not be loaded.`, "warn");
                        }
                    } catch (err) {
                        console.warn(`Inpaint Canvas: map "${kind}" missing`, j.ref, err);
                        this.setStatus(`Map "${kind}" missing: ${err.message || err}`, failKind(err));
                    }
                }
            }
            this.mapsVersion++;
            this.renderLayers();
            this.renderHistory();
            this.renderInfo();
            this.renderDepthRow();
            if (this.boxes) this.boxes.refresh(true);
            this.draw();
            this.drawThumb();
        } catch (err) {
            console.error(err);
            this.setStatus("Could not restore canvas: " + (err.message || err), failKind(err));
        } finally {
            if (!stale()) this._loading = false;
        }
    }

    /**
     * Called when the prompt is built: upload flattened image, mask and control, return the prompt JSON. `opts` (the
     * app): `refIds` the click's references (refLayersFor), `prompt` / `negative` the texts to send instead of the fields';
     * `boxes` ({ boxes, notes }, promptPayload's shape; `boxes` null: none, the selection goes as one) the boxes a run
     * sends while the Boxes switch is on, measured by the caller, instead of the document's (Generate new measures them
     * on the picture they were drawn on, before its fresh canvas replaces it). `area` (the app's Each area): one area of
     * the selection, `{ maskCanvas(), crop }`, whose mask goes instead of the selection's (never through the upload cache,
     * which stays the selection's) and whose crop the status line names.
     */
    async serializeForPrompt(opts = {}) {
        if (!this.base) return "{}";
        const id = this.node.id;
        const area = opts.area || null;
        await this.syncLayers();
        let baseRef = this.uploaded.baseRef;
        if (!this.uploaded.baseHash || !baseRef) {
            let hash;
            if (!this.layers.some((l) => this.shown(l) && !this.isControl(l)) && this.base.ref) {
                baseRef = this.base.ref;
                hash = "orig:" + this.base.ref.filename;
            } else {
                const up = await this.uploadComposite({ forRun: true }, `n${id}_base`);
                baseRef = up.ref; hash = up.hash;
            }
            this.uploaded.baseHash = hash;
            this.uploaded.baseRef = baseRef;
        }
        // the selection the mask below holds, read in the same tick (the app numbers the batch's pictures from it; the
        // node ignores the key)
        const hasSelection = area ? true : !!this.getBounds();
        let maskRef = this.uploaded.maskRef;
        if (area) {
            const c = area.maskCanvas();
            try { maskRef = (await uploadCanvas(c, `n${id}_mask`)).ref; } finally { c.width = 1; c.height = 1; }
        } else if (!this.uploaded.maskHash || !maskRef) {
            const up = await uploadCanvas(this.maskToCanvas(), `n${id}_mask`);
            maskRef = up.ref;
            this.uploaded.maskHash = up.hash;
            this.uploaded.maskRef = maskRef;
        }
        let controlRef = null;
        if (this.layers.some((l) => this.shown(l) && this.isControl(l))) {
            if (!this.uploaded.controlHash || !this.uploaded.controlRef) {
                const up = await uploadCanvas(this.flattenToCanvas({ controlOnly: true }), `n${id}_control`);
                this.uploaded.controlHash = up.hash;
                this.uploaded.controlRef = up.ref;
            }
            controlRef = this.uploaded.controlRef;
        }
        // Reference layers at their native size: the uploaded file itself when it is
        // untouched, otherwise the pixels with the mask applied (cached per layer).
        const references = [];
        const refLayers = this.refLayersFor(opts.refIds);
        for (const l of refLayers) {
            if (!l.maskPx && l.ref && !l.dirty) { references.push(l.ref); continue; }
            if (!l.exportRef) {
                const up = await uploadCanvas(this.layerPixels(l), `n${id}_ref`);
                l.exportRef = up.ref;
            }
            references.push(l.exportRef);
        }
        // the Boxes switch on and a run that takes boxes (docs/PLAN_NODE_BOXES.md §4): the document's boxes, the
        // references' layer ids and the id of the selection's box, for the node's nodes.py to write FLUX 3's rows (an older
        // node ignores them). In the app a local recipe takes them only when it declares the input its rows go to (its
        // `boxes`): the app's host wires that input to the node's box_prompt for the run.
        const promptSent = opts.prompt != null ? opts.prompt : this.promptText;
        let boxPart = {}, boxNote = "";
        const boxSwitch = this.genSettings.boxes ? host.boxSwitch(this) : null;
        if (boxSwitch && boxSwitch.takes) {
            const given = opts.boxes && typeof opts.boxes === "object" ? opts.boxes : null;
            const list = given ? (given.boxes || []) : this.pluginData && this.pluginData.boxes && Array.isArray(this.pluginData.boxes.boxes) ? this.pluginData.boxes.boxes : [];
            const p = given ? { boxes: list, notes: Array.isArray(given.notes) ? given.notes : [] } : promptPayload(list, refLayers);
            // each reference's @img label (img1 ..), so nodes.py can name a token in a description or the prompt as the
            // picture the batch holds ("image 3")
            const labels = this.refLabels();
            boxPart = { selectionBoxId: selectionBoxIdOf(promptSent), referenceIds: refLayers.map((l) => l.id), referenceLabels: refLayers.map((l) => (labels.has(l.id) ? `img${labels.get(l.id)}` : null)), ...((given ? Array.isArray(given.boxes) : list.length) ? { boxes: p.boxes } : {}) };
            boxNote = p.notes.join(" ");
        }
        const [x, y, w, h] = area && Array.isArray(area.crop) ? area.crop : this.cropRect();
        this.setStatus(`Queued crop ${w} × ${h} at ${x}, ${y}${references.length ? `, ${references.length} reference${references.length > 1 ? "s" : ""}` : ""}. Waiting for the result ...${boxNote ? " " + boxNote : ""}`, boxNote ? "warn" : undefined);
        return JSON.stringify({
            width: this.width,
            height: this.height,
            base: baseRef,
            mask: maskRef,
            hasSelection,
            control: controlRef,
            prompt: opts.prompt != null ? opts.prompt : this.promptText,
            layers: this.layers.length,
            crop: this.cropSettings,
            gen: this.genSettings,
            negative: opts.negative != null ? opts.negative : this.negativeText,
            settings: this.settings,
            references,
            refs: this.refSettings,
            ...boxPart,
        });
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
installParts(InpaintEditor, [PanelsPart, LayersPart, HistoryPanelPart, TextPart, TipsPart, HealPart, LiquifyPart, ShapePart, SelectPart, StackPart, SegmentPart, MasksPart, GeometryPart, PointerPart]);
bindSelect(InpaintEditor);
bindStack(InpaintEditor);
bindHeal(InpaintEditor);
bindLiquify(InpaintEditor);
bindShape(InpaintEditor);
bindLoad(InpaintEditor);

// everything the hosts use: Scumble's shell, commands and plugins, the node's extension (js/inpaint_node.js)
export { InpaintEditor, BLEND_MODES, DISSOLVE_SHADER, DISSOLVE_CLIP_SHADER, viewUrl, loadImageEl, makeCanvas, uploadBlob, uploadCanvas, CROP_DEFAULTS, GEN_DEFAULTS, FIXED_OUTPUTS, SETTING_SLOTS, TAIL_OUTPUTS, NODE_CLASS, STITCH_CLASS, isSettingOutput, settingIndex, linkOf, el, icon, iconButton, miniButton, selectInput, selectGrouped, numberInput, hostText, REF_FITS, REF_DEFAULTS, UPSAMPLE_CASES, randomSeed, STYLE, RELIGHT_STYLES, RELIGHT_LIGHT_TYPES, BRUSH_MAX, brushSizeToSlider, sliderToBrushSize };
