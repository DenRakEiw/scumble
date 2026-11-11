# Item 56: line map and seams of the five long files

Read-only research, 2026-11-11, `F:\canvas` on `wasm-kernels` at `7608dcda`. Nothing was edited, built or run.
Method: every file parsed with acorn (`node_modules/acorn`, ecmaVersion latest); top-level declarations, class members,
object-literal properties and identifier references come from the AST, not from memory. Scripts in this scratchpad
(`map.js`, `regions.js`, `objmap.js`, `sections.js`, `topgroups.js`; raw dumps `*.json`, `iem.txt`, `host_props.txt`,
`cmd_props.txt`).

Caveats of the numbers:
- A line range is from a declaration's first token (or a method's key) to its last line. The comment block directly
  above a declaration belongs to it: a move takes the lines from the previous range's end + 1.
- "Reads module scope" lists every identifier inside the range that matches a top-level name of the file. A local
  variable that shadows a top-level name (e.g. a local `el`) is counted too, so the lists are a superset: grep before
  dropping an import.
- Sizes today (`wc -l`): `inpaint_canvas.js` 25,862, `host.js` 7,100, `shell.js` 3,582, `commands.js` 3,171,
  `recipes.js` 1,955 (CLAUDE.md item 56's counts are from 2026-11-07 and stale; its ICONS/STYLE lines too, see 1.3).

---------------------------------------------------------------------------------------------------------------------

## 1. renderer/editor/inpaint_canvas.js (25,862 lines, ES module)

### 1.1 Module scope (lines 1-2257)

- 15-56: 42 named imports from 41 modules (`./host.js` {api, host} at 15; `./px/kernels.js` twice, 20 and 52). No
  default or namespace import.
- 63-2256: 203 top-level statements in 13 natural groups (table below), then `class UploadCache` 2092-2115,
  `class StrokeBuffer` 2127-2256, `class InpaintEditor` 2258-25859, and one export list at 25862:
  `export { InpaintEditor, BLEND_MODES, DISSOLVE_SHADER, DISSOLVE_CLIP_SHADER, viewUrl, loadImageEl, makeCanvas, uploadBlob, uploadCanvas, CROP_DEFAULTS, GEN_DEFAULTS, FIXED_OUTPUTS, SETTING_SLOTS, TAIL_OUTPUTS, NODE_CLASS, STITCH_CLASS, isSettingOutput, settingIndex, linkOf, el, icon, iconButton, miniButton, selectInput, selectGrouped, numberInput, hostText, REF_FITS, REF_DEFAULTS, UPSAMPLE_CASES, randomSeed, STYLE }`
  (BLEND_MODES, uploadBlob, uploadCanvas are re-exports of imports). Inline exports: `RELIGHT_STYLES` 107,
  `RELIGHT_LIGHT_TYPES` 109-112, `BRUSH_MAX` 956, `brushSizeToSlider` 959, `sliderToBrushSize` 960.
- Mutable module state: `let CLIPBOARD` 2044 (written only by the `set clipboard` accessor 2262), `let sourceIdSeq`
  2077 (written only in `sourceTag` 2081). The one top-level loop (222-224) fills `ORIENT_SIGNS`; no DOM access at
  module evaluation (the module imports in plain Node: `tools/limit_test.js:67`, `tools/maps_test.js:73`).
- External importers of this module: `renderer/shell.js:5` {InpaintEditor, STYLE as EDITOR_STYLE};
  `renderer/commands.js:18` {viewUrl, loadImageEl, makeCanvas, BRUSH_MAX, BLEND_MODES, RELIGHT_STYLES,
  RELIGHT_LIGHT_TYPES}; `renderer/plugins.js:14` {el, icon, makeCanvas}; and in the cycle (they are imported by
  inpaint_canvas.js too): `inpaint_modal.js:7` {el, iconButton, miniButton, selectInput, numberInput, hostText,
  REF_FITS, REF_DEFAULTS, UPSAMPLE_CASES, randomSeed, brushSizeToSlider, sliderToBrushSize}, `inpaint_jobs.js:13` and
  `inpaint_encode.js:14` {InpaintEditor}; `inpaint_boxes.js:10` {el} (not imported by inpaint_canvas.js). Every
  exported name must stay exported from inpaint_canvas.js (a re-export `export { x } from "./y.js"` is fine for
  build_node.py's `EXPORT_LIST` regex, `tools/build_node.py:102`).

Module-scope groups (declares / reads / who uses them; class region ids are those of 1.2):

### T-head (63-146, ~84 lines): editorTileMode, hostText, constants, leftOutText, UNDO_LABELS
- declares: `editorTileMode`, `hostText`, `NODE_CLASS`, `STITCH_CLASS`, `MAX_UNDO`, `MAX_UNDO_BYTES`, `MAX_SNAPSHOTS`, `LAYER_PENDING_KEYS`, `RUN_GOING_TEXT`, `LAYER_KINDS`, `LOAD_NOTE_LINES`, `LOAD_NOTE_MS`, `RELIGHT_STYLES`, `RELIGHT_LIGHT_TYPES`, `leftOutText`, `UNDO_LABELS`
- reads imports: `host`, `pixelsOptions`
- reads other module-scope: none
- used by class regions: E02, E42, E45, E53, E54, E57, E62, E64, E78, E79
- used by other top-level groups: none

### T-orient (152-357, ~206 lines): orientation / transform-matrix / text-angle / auto-crop helpers
- declares: `composeOrient`, `orientOps`, `orientChain`, `orientIsUp`, `turnSize`, `turnPoint`, `turnRect`, `orientMatrix`, `xfOfOp`, `ORIENT_SIGNS`, `orientOfXf`, `snapNum`, `snapXf`, `validXf`, `xfIsIdentity`, `placeXf`, `normDeg`, `composeTextOrient`, `textTotalAngle`, `spinText`, `textBox`, `textStartFraction`, `autoCropFrame`, `frameInside`, `straightenXf`, `boxOnPixels`
- reads imports: `XF_IDENTITY`, `textAngle`, `textFrame`, `xfBox`, `xfMul`, `xfRotate`, `xfTranslate`
- reads other module-scope: none
- used by class regions: E05, E14, E15, E17, E18, E19, E20, E21, E28, E55, E65, E66, E79
- used by other top-level groups: none

### T-consts (359-383, ~25 lines): misc pixel and UI constants
- declares: `DOC_TURN_LABELS`, `MASK_RGB`, `REMOVE_MARK`, `PYRAMID_MIN_PX`, `PYRAMID_LEVELS`, `FLOOD_COARSE_PX`, `FLOOD_WHOLE_SHARE`, `SNAP_CANVAS_PX`, `SEL_BOX_MAX_PX`, `PSD_WINDOW`, `SYNC_ENCODE_PX`, `HANDLE_PX`, `SIDE_DEFAULT_PX`, `SIDE_MIN_PX`, `SIDE_MAX_SHARE`, `RULER_PX`, `CURSOR_CLASSES`, `TONE_DAB`, `FREQ_MAX_PX`
- reads imports: none
- reads other module-scope: none
- used by class regions: E05, E07, E08, E11, E12, E13, E17, E19, E20, E21, E25, E30, E33, E45, E47, E53, E55, E58, E59, E67, E75, E78, E79
- used by other top-level groups: none

### T-shaders (385-474, ~90 lines): emulated blend, dissolve, range preview GLSL
- declares: `EMULATED_BLEND_SHADER`, `EMULATED_BLEND_CLIP_SHADER`, `DISSOLVE_SHADER`, `DISSOLVE_CLIP_SHADER`, `RANGE_PREVIEW_SHADER`
- reads imports: `BLEND_FN_GLSL`, `WEIGHTS_GLSL`
- reads other module-scope: none
- used by class regions: E47, E51
- used by other top-level groups: none

### T-roles (475-488, ~14 lines): ROLES, TAIL_OUTPUTS, REF_DEFAULTS, REF_FITS
- declares: `ROLES`, `TAIL_OUTPUTS`, `REF_DEFAULTS`, `REF_FITS`
- reads imports: none
- reads other module-scope: none
- used by class regions: E02, E53, E61, E79
- used by other top-level groups: none

### T-load (494-949, ~456 lines): file/image loading: viewUrl, SVG, TIFF, PNG stream, pixelsFromImageFile, tileDiffBox, clampRect
- declares: `viewUrl`, `refKey`, `fileGone`, `snapImage`, `needImage`, `loadImageEl`, `SVG_RE`, `isSvgFile`, `layeredKind`, `storedExt`, `isTiffFile`, `tiffPoolUsable`, `pixelsFromTiff`, `psdOnPool`, `svgSize`, `rasterizeSvg`, `NO_PROGRAM`, `canvasRows`, `HUGE_MAX_SIDE`, `HUGE_MAX_PIXELS`, `pngReaderUsable`, `hugePngSize`, `pngIsPlainSrgb`, `pixelsFromPngStream`, `imageFileSize`, `pixelsOffThread`, `imageOfBlob`, `pixelsFromImageFile`, `tileDiffBox`, `clampRect`
- reads imports: `CANVAS_MAX_PIXELS`, `CancelledError`, `NORMAL`, `TIFF_EXT`, `TILE_SIZE`, `api`, `bandRows`, `canvasRoundTrip`, `editorPool`, `isOra`, `isPsd`, `isTiff`, `partsUsable`, `pngHeader`, `pngPartsOf`, `readPngParts`, `readTiff`, `readTiffBands`, `tiffKernels`
- reads other module-scope: InpaintEditor(L2258), makeCanvas(T-brushsize)
- used by class regions: E25, E26, E27, E28, E40, E41, E42, E45, E49, E53, E54, E56, E57, E59, E60, E65, E66, E70, E79
- used by other top-level groups: none

### T-brushsize (956-1000, ~45 lines): BRUSH_MAX, slider mapping, makeCanvas, cpuDab, patchMix, meanRGB, refBadge
- declares: `BRUSH_MAX`, `SIZE_STEPS`, `brushSizeToSlider`, `sliderToBrushSize`, `makeCanvas`, `cpuDab`, `patchMix`, `meanRGB`, `refBadge`
- reads imports: `host`
- reads other module-scope: none
- used by class regions: E05, E07, E11, E16, E20, E25, E26, E27, E28, E29, E30, E31, E32, E33, E34, E36, E37, E39, E40, E41, E42, E43, E44, E47, E49, E52, E53, E54, E57, E61, E66, E67, E68, E69, E70, E72, E75
- used by other top-level groups: T-load

### T-dom (1002-1083, ~82 lines): el, setFieldText, numberInput, selectInput, selectGrouped
- declares: `el`, `setFieldText`, `numberInput`, `selectInput`, `selectGrouped`
- reads imports: `mapOffset`
- reads other module-scope: none
- used by class regions: E03, E04, E06, E10, E12, E43, E55, E61, E62, E63, E64, E65, E76
- used by other top-level groups: T-icons

### T-mesh (1091-1168, ~78 lines): homography, drawTriangle, drawMesh
- declares: `homography`, `drawTriangle`, `drawMesh`
- reads imports: none
- reads other module-scope: none
- used by class regions: E05, E68
- used by other top-level groups: none

### T-backends (1181-1479, ~299 lines): withSpecDefaults, segment/upsample/cutout/object backends, crop/gen defaults
- declares: `withSpecDefaults`, `SEGMENT_BACKENDS`, `MIN_AUTO_CROP`, `CROP_DEFAULTS`, `CROP_LEGACY`, `GEN_DEFAULTS`, `FIXED_OUTPUTS`, `SETTING_SLOTS`, `randomSeed`, `autoSelectionParams`, `ensureMinSpan`, `UPSAMPLE_BACKENDS`, `availableUpsampleBackends`, `UPSAMPLE_CASES`, `segmentTermInstruction`, `upsampleInstruction`, `builtInUpsampleInstruction`, `availableSegmentBackends`, `CUTOUT_BACKENDS`, `availableCutoutBackends`, `isSettingOutput`, `settingIndex`, `linkOf`, `OBJECT_BACKEND`, `objectBackendAvailable`
- reads imports: `host`, `referencesRule`, `referencesText`
- reads other module-scope: none
- used by class regions: E02, E42, E53, E58, E61, E76, E78, E79
- used by other top-level groups: none

### T-icons (1485-1614, ~130 lines): ICONS, icon, iconButton, miniButton
- declares: `ICONS`, `icon`, `iconButton`, `miniButton`
- reads imports: none
- reads other module-scope: el(T-dom)
- used by class regions: E03, E04, E12, E43, E53, E55, E61, E62, E63, E64, E65
- used by other top-level groups: none

### T-style (1620-2037, ~418 lines): STYLE, injectStyle
- declares: `STYLE`, `injectStyle`
- reads imports: none
- reads other module-scope: none
- used by class regions: E02
- used by other top-level groups: none

### T-tail (2044-2256, ~213 lines): CLIPBOARD, stroke scratch consts, cachedMapTileStats, sourceTag, UploadCache, StrokeBuffer
- declares: `CLIPBOARD`, `STROKE_SCRATCH_KEEP_PX`, `STROKE_BAND`, `RMAX_CACHE`, `cachedMapTileStats`, `SOURCE_IDS`, `sourceIdSeq`, `sourceTag`, `UploadCache`, `StrokeBuffer`
- reads imports: `mapTileStats`, `rangeMax`
- reads other module-scope: none
- used by class regions: E01, E21, E23, E32, E33, E38, E40, E48, E50
- used by other top-level groups: none

### 1.2 class InpaintEditor (2258-25859): 756 members in 80 subject regions

756 members: 1 constructor, 715 methods, 10 accessors (`get/set clipboard` 2260/2262, `get/set selection` 2265/2270,
`get/set depth` 13370/13382, `get huge` 18918, `get/set base` 22110/22112, `get basePx` 22119, `get _basePx` 22121),
30 static members 18112-18236 (accessors `kernels`, `routes`, `parts`; methods `setRoute`, `workerJob`, `jobTimings`,
`stepMarks`, `pxCalls`, `pxTimed`, `pxSplit`, `pxInstances`, `measureGen`, `pendingJobs`, `resetPool`,
`referencedFiles`; 15 static fields `tiffBandRows` .. `patchPreviewMax`). **No `super`, no `#private` name, no
instance field declaration** in any member (AST check over all 756). No `extends`.

Columns: region, lines (first member's key to last member's end), lines, members, first .. last member, subject.

| id | lines | n lines | members | first .. last | subject |
|---|---|---|---|---|---|
| E01 | 2260-2273 | 14 | 4 | `clipboard` .. `selection` | accessors clipboard/selection (stay in class) **[get clipboard; set clipboard; get selection; set selection]** |
| E02 | 2275-2443 | 169 | 1 | `constructor` .. `constructor` | constructor (stays) |
| E03 | 2447-2616 | 170 | 7 | `buildNodeWidget` .. `drawMaskInto` | node widget, thumb, tile/selection/mask draw helpers |
| E04 | 2621-3027 | 407 | 5 | `buildModal` .. `updateSubbar` | modal chrome: subbar, options bar |
| E05 | 3029-3236 | 208 | 9 | `setTransformMode` .. `applyPending` | transform modes: pending perspective/warp mesh |
| E06 | 3238-3696 | 459 | 6 | `open` .. `renderRunProgress` | lifecycle: open/close/bindEvents, ask modal, status line, run progress |
| E07 | 3699-4001 | 303 | 5 | `activeHardness` .. `setBrushSize` | tools and keyboard: setTool, onKey, brush size |
| E08 | 4005-4258 | 254 | 14 | `resizeCanvas` .. `onWheel` | view: canvas size, coordinate maps, tilt, frame draw, zoom, wheel |
| E09 | 4262-4351 | 90 | 7 | `activeLayer` .. `applyGroupBox` | layer selection (active/multi), group box |
| E10 | 4353-4627 | 275 | 22 | `isControl` .. `moveReference` | reference layers and @img prompt tokens |
| E11 | 4640-4767 | 128 | 7 | `layerPixels` .. `updateCanvasCursor` | layer pixels with stroke, transform handles, cursors |
| E12 | 4769-4892 | 124 | 9 | `showPane` .. `applyStoredSideWidth` | side panes, flyouts, side width |
| E13 | 4894-5059 | 166 | 7 | `toggleRulers` .. `toggleCompare` | rulers, grid, guides, overlays, compare |
| E14 | 5062-5123 | 62 | 3 | `beginTextEdit` .. `endTextEdit` | inline text edit box |
| E15 | 5126-5317 | 192 | 11 | `setLayerGeometry` .. `flipLayer` | layer geometry, smart snapping, align/distribute, flip |
| E16 | 5328-5420 | 93 | 1 | `matchEdges` .. `matchEdges` | matchEdges (edge fit) |
| E17 | 5427-5646 | 220 | 8 | `turnedTilePixels` .. `turnDocumentNow` | rotate layer 90, turn document |
| E18 | 5657-5824 | 168 | 10 | `mapExtras` .. `fitFrame` | document-geometry helpers (maps, guides, snapshots of geometry, aspect) |
| E19 | 5826-5998 | 173 | 2 | `straightenDocument` .. `straightenDocumentNow` | straighten document |
| E20 | 6009-6373 | 365 | 25 | `frame` .. `canvasHandleAt` | canvas tool: frame, crop, resize, extend handles |
| E21 | 6377-7229 | 853 | 5 | `onPointerDown` .. `closePolygon` | pointer events (down/move/up), polygon close |
| E22 | 7231-7526 | 296 | 11 | `selectionDab` .. `selectedAt` | stroke core: dabs, stamps, stabiliser, finishStroke |
| E23 | 7529-8168 | 640 | 5 | `applyMaskToSelection` .. `cancelRange` | selection combine; select range (colour/depth range) |
| E24 | 8178-8369 | 192 | 1 | `selectLogits` .. `selectLogits` | selectLogits (SAM logits) |
| E25 | 8374-8618 | 245 | 7 | `selectRectangle` .. `floodRegionOf` | rectangle/shape selection, worker/tiles selection, flood |
| E26 | 8626-9085 | 460 | 15 | `sampleRegion` .. `programFinish` | sampling stack and band programs (sampleRegion, stackPlan, program*) |
| E27 | 9092-9530 | 439 | 13 | `floodStack` .. `readBox` | floodStack, brushSource, box/flood over tiles, passStores, readBox |
| E28 | 9533-9637 | 105 | 8 | `wandSelect` .. `toggleQuickMask` | wand, feather, saved selections, quick mask |
| E29 | 9642-9862 | 221 | 16 | `brushTip` .. `dabMask` | brush tips (ABR, picker), stamp/dab masks |
| E30 | 9873-10134 | 262 | 8 | `smudgeDab` .. `commitLayerPaint` | smudge, clone stroke, commitLayerPaint |
| E31 | 10147-10320 | 174 | 4 | `healBlend` .. `healWrite` | heal brush |
| E32 | 10327-10559 | 233 | 10 | `patchRefusal` .. `patchRun` | patch tool |
| E33 | 10570-10812 | 243 | 4 | `moveRun` .. `moveWrite` | content-aware move |
| E34 | 10824-10985 | 162 | 4 | `removeRun` .. `removeWrite` | remove tool |
| E35 | 10991-11021 | 31 | 3 | `heldEdit` .. `dropStroke` | held edits, dropStroke |
| E36 | 11036-11696 | 661 | 31 | `liquifyHint` .. `drawLiquifyInto` | liquify |
| E37 | 11699-11761 | 63 | 4 | `warmRemove` .. `drawCloneGhost` | warmRemove, clone ghost |
| E38 | 11764-11998 | 235 | 10 | `gradientDab` .. `cancelShape` | gradient and shape tool |
| E39 | 12001-12093 | 93 | 3 | `sampleCanvas` .. `bucketFill` | eyedropper, bucket fill |
| E40 | 12101-12640 | 540 | 26 | `strokeClip` .. `layerWithStroke` | stroke buffers: commit, preview, stroke passes |
| E41 | 12642-12844 | 203 | 10 | `fillSelection` .. `selectionFromLayer` | fill/copy/paste/clear selection, grow, selection from layer |
| E42 | 12848-13365 | 518 | 21 | `refreshSegmentBackends` .. `applyMaskFile` | select by text, prompt upsample, SAM objects, mask files |
| E43 | 13370-14209 | 840 | 23 | `depth` .. `mapStale` | depth map, maps, depth edit, filter-preview cancel helpers **[get depth; set depth]** |
| E44 | 14219-14318 | 100 | 2 | `extendCanvas` .. `extendCanvasNow` | extend canvas |
| E45 | 14326-15358 | 1033 | 42 | `snapUrl` .. `historyStepNow` | snapshots, undo/redo, history step |
| E46 | 15362-15441 | 80 | 5 | `clearSelection` .. `markLayerChanged` | clear/invert selection, change marks |
| E47 | 15462-15674 | 213 | 6 | `blendEmulated` .. `layerRectToImage` | emulated blends, frequency separation, dodge/burn |
| E48 | 15685-15719 | 35 | 3 | `bumpComposite` .. `makeUploaded` | bumpComposite, autosave, makeUploaded |
| E49 | 15723-16065 | 343 | 13 | `addFilterLayer` .. `filteredCanvas` | filter layers: add/type, fill, LUT/plate, filteredCanvas |
| E50 | 16075-16384 | 310 | 15 | `belowStats` .. `depthProxy1024Data` | below/picture stats, histograms, depth proxies |
| E51 | 16391-16619 | 229 | 3 | `setRangePreview` .. `handlePickOnce` | range preview, pick-once |
| E52 | 16632-16794 | 163 | 3 | `applyFilterLayer` .. `nextIsFilterLayer` | applyFilterLayer, filter chain |
| E53 | 16796-17348 | 553 | 23 | `markMaskChanged` .. `referenceBox` | layer masks, cutout, mask/layer menus, clip |
| E54 | 17355-17841 | 487 | 17 | `addImageLayers` .. `pickLayerAt` | image layers, thumbs, rename, solo, duplicate, merge |
| E55 | 17846-18106 | 261 | 8 | `addTextLayer` .. `addFontFiles` | text layers and fonts |
| E56 | 18112-18236 | 125 | 30 | `kernels` .. `referencedFiles` | static members (stay in class) **[static kernels; static kernels; static routes; static setRoute; static workerJob; static parts; static tiffBandRows; static pngStreamFrom; static imageWorkerFrom; static healBlend; static healBlendMax; static healSyncMax; static healSyncBox; static removeMaxHole; static liquifySyncMax; static liquifyBlockMax; static liquifyRateMs; static liquifyDabKernel; static liquifyPreviewMax; static patchPreviewMax; static jobTimings; static stepMarks; static pxCalls; static pxTimed; static pxSplit; static pxInstances; static measureGen; static pendingJobs; static resetPool; static referencedFiles]** |
| E57 | 18254-18592 | 339 | 9 | `psdSections` .. `cleanupFiles` | export: PSD/ORA/TIFF/PNG, cleanupFiles |
| E58 | 18595-18858 | 264 | 12 | `scanBounds` .. `renderInfoRows` | bounds, crop rect, info rows |
| E59 | 18867-19322 | 456 | 13 | `setBaseFromRef` .. `ownPixels` | base picture and file loading (PSD/ORA/TIFF/SVG) **[get huge]** |
| E60 | 19324-19479 | 156 | 7 | `addLayer` .. `addResults` | add/remove/move layers, addResults |
| E61 | 19481-20120 | 640 | 11 | `renderLayers` .. `openChoiceList` | layers panel render, group/mask rows, references panel, choice lists |
| E62 | 20123-20331 | 209 | 1 | `buildFilterControls` .. `buildFilterControls` | filter controls panel |
| E63 | 20340-20592 | 253 | 1 | `buildLimitBlock` .. `buildLimitBlock` | limit (range) block UI |
| E64 | 20602-21444 | 843 | 1 | `buildRelightBlock` .. `buildRelightBlock` | relight block UI |
| E65 | 21448-21609 | 162 | 4 | `renderHistory` .. `soloResult` | history panel, reusePrompt |
| E66 | 21616-21911 | 296 | 6 | `setBaseFromCanvas` .. `restoreResult` | new canvas dialog, restoreResult |
| E67 | 21923-22346 | 424 | 19 | `touchSource` .. `drawViewComposite` | display source, pyramid, base accessors (stay), GL compositor **[get base; set base; get basePx; get _basePx]** |
| E68 | 22349-22892 | 544 | 26 | `compositeCanvas` .. `drawLayer` | composite draw, groups, layer stack walk, drawLayer |
| E69 | 22894-23197 | 304 | 11 | `matchActive` .. `matchGeometry` | colour match |
| E70 | 23199-23425 | 227 | 9 | `flattenToCanvas` .. `flattenNow` | flatten, bands, encode composite |
| E71 | 23437-23477 | 41 | 4 | `syncLayers` .. `themeChanged` | syncLayers, drawSoon, theme |
| E72 | 23490-23601 | 112 | 4 | `drawBrushRing` .. `draw` | brush ring, marching ants, draw |
| E73 | 23619-23717 | 99 | 4 | `watchChains` .. `mipsSettled` | chain watch, view caches, mips |
| E74 | 23722-24293 | 572 | 12 | `downsampleDepth` .. `dropQuickVis` | relight runtime: maps, lights overlay |
| E75 | 24300-24756 | 457 | 5 | `sceneSignature` .. `drawSceneOverlays` | scene draw and overlays |
| E76 | 24763-24936 | 174 | 9 | `settingTargets` .. `syncBoxesRow` | settings targets, gen controls |
| E77 | 24949-25089 | 141 | 5 | `releaseCaches` .. `freeHelperModels` | releaseCaches, held pixels/files, helper models |
| E78 | 25096-25207 | 112 | 3 | `generate` .. `encodeSelectionSoon` | generate, notify, encodeSelectionSoon |
| E79 | 25209-25652 | 444 | 3 | `getValue` .. `serializeForPrompt` | getValue/setValue/serializeForPrompt |
| E80 | 25666-25858 | 193 | 2 | `memoryReport` .. `destroy` | memoryReport, destroy |

Largest single methods: `buildRelightBlock` 20602 (843 lines), `selectRange` 7555 (577), `onPointerDown` 6377
(415), `drawSceneOverlays` 24401 (356), `applySnapshot` 14877 (278), `ensureRelightMaps` 24000 (269), `setValue`
25287 (267), `buildOptsBar` 2704 (259), `buildLimitBlock` 20340 (253), `onKey` 3757 (238). A pure move keeps them
whole; splitting one is a rewrite, not item 56.

Regions that read the class itself (`InpaintEditor.<static>`, e.g. `InpaintEditor.stacks`, `.healBlendMax`,
`.psdOnPool`, `.bands`, `.removeMaxHole`): E25 E26 E27 E31 E32 E33 E34 E36 E39 E40 E57 E59 E67 E70 (and module-scope
T-load). Regions that read the module-scope classes: `StrokeBuffer` E21 E32 E33 E38 E40; `UploadCache` E48;
`CLIPBOARD` E01 only; `sourceTag` E50; `injectStyle` E02 (constructor, 2440). Regions that use `host`: E02 E06 E07
E10 E13 E17 E18 E19 E21 E32 E33 E34 E37 E42 E43 E49 E50 E53 E54 E56 E57 E58 E60-E66 E76-E79; `api`: E42 E53 E57 E77.

### 1.2b What each class region reads from module scope (and which `host.` members it calls)

- **E01** (2260-2273) module-local: `CLIPBOARD`; imports: `deprecatedPixels`; host.: none
- **E02** (2275-2443) module-local: `CROP_DEFAULTS`, `GEN_DEFAULTS`, `MAX_UNDO`, `MAX_UNDO_BYTES`, `REF_DEFAULTS`, `editorTileMode`, `injectStyle`, `randomSeed`; imports: `RunProgress`, `host`, `pixelsBackend`; host.: depthSupported
- **E03** (2447-2616) module-local: `el`, `icon`; imports: `MIP_LEVELS`, `TIFF_EXT`, `isTilePixels`; host.: none
- **E04** (2621-3027) module-local: `el`, `iconButton`, `numberInput`, `selectInput`; imports: `buildEditorModal`; host.: none
- **E05** (3029-3236) module-local: `HANDLE_PX`, `drawMesh`, `homography`, `makeCanvas`, `textTotalAngle`; imports: none; host.: none
- **E06** (3238-3696) module-local: `el`; imports: `LAYERED_EXT`, `TIFF_EXT`, `host`, `loadFontList`, `statusKindFor`; host.: isActive, mount, onEscape, pluginKey
- **E07** (3699-4001) module-local: `BRUSH_MAX`, `CURSOR_CLASSES`, `brushSizeToSlider`; imports: `host`; host.: onEscape, pluginKey, refTokens, removeSupported, toolChanged
- **E08** (4005-4258) module-local: `HANDLE_PX`; imports: none; host.: none
- **E09** (4262-4351) module-local: none; imports: none; host.: none
- **E10** (4353-4627) module-local: `setFieldText`; imports: `host`, `labelMap`, `remap`; host.: refLayout, refTokens
- **E11** (4640-4767) module-local: `CURSOR_CLASSES`, `HANDLE_PX`, `makeCanvas`; imports: `canvasOf`; host.: none
- **E12** (4769-4892) module-local: `SIDE_DEFAULT_PX`, `SIDE_MAX_SHARE`, `SIDE_MIN_PX`, `el`, `icon`, `iconButton`; imports: none; host.: none
- **E13** (4894-5059) module-local: `RULER_PX`; imports: `THEME`, `host`; host.: pluginOverlay
- **E14** (5062-5123) module-local: `textBox`, `textStartFraction`, `textTotalAngle`; imports: `fontCss`; host.: none
- **E15** (5126-5317) module-local: `composeTextOrient`; imports: none; host.: none
- **E16** (5328-5420) module-local: `makeCanvas`; imports: `fitLayerRGBA`, `workScale`; host.: none
- **E17** (5427-5646) module-local: `DOC_TURN_LABELS`, `HANDLE_PX`, `composeTextOrient`, `snapXf`, `turnRect`, `turnSize`, `xfOfOp`; imports: `failKind`, `host`, `xfMul`; host.: changed
- **E18** (5657-5824) module-local: `autoCropFrame`, `orientChain`, `orientIsUp`, `orientOfXf`, `placeXf`, `snapNum`, `snapXf`, `validXf`, `xfIsIdentity`; imports: `XF_IDENTITY`, `host`, `xfApply`, `xfBox`, `xfInv`, `xfMul`; host.: changed
- **E19** (5826-5998) module-local: `MASK_RGB`, `autoCropFrame`, `boxOnPixels`, `frameInside`, `normDeg`, `orientOps`, `snapXf`, `spinText`, `straightenXf`; imports: `CANVAS_MAX_SIDE`, `canvasSizeRefusal`, `failKind`, `host`, `pixelMap`, `renderText`, `xfApply`, `xfInv`, `xfMul`, `xfTranslate`; host.: changed
- **E20** (6009-6373) module-local: `HANDLE_PX`, `frameInside`, `makeCanvas`; imports: `FILTERS`, `canvasSizeRefusal`, `failKind`, `scaleFilterParams`, `uploadCanvas`, `xfScale`, `xfTranslate`; host.: none
- **E21** (6377-7229) module-local: `REMOVE_MARK`, `RULER_PX`, `StrokeBuffer`, `normDeg`; imports: `LIGHT_MAX`, `defaultLight`, `host`, `isTilePixels`, `selModeOf`, `selectionGco`; host.: pluginPointer, removeModel, selectBox
- **E22** (7231-7526) module-local: none; imports: `Stabiliser`, `pressureCurve`; host.: none
- **E23** (7529-8168) module-local: `cachedMapTileStats`; imports: `INTERACTIVE`, `RANGE_BAND_ROWS`, `SNAP_DEFAULT`, `SNAP_TAU`, `bytesSource`, `colourSimilarity`, `editorPool`, `hexToRgb01`, `markStep`, `maskToColorCanvas`, `nextPartsSeq`, `normalizeLimit`, `opp`, `passToMap`, `rangeRowBookkeeping`, `rangeTileClass`, `rangeWeight`, `snapField`, `snapParams`, `tileRows`, `tilesSource`, `u16Bilinear`; host.: none
- **E24** (8178-8369) module-local: none; imports: `INTERACTIVE`, `RANGE_BAND_ROWS`, `bytesSource`, `editorPool`, `isTilePixels`, `rectSource`, `storeArgs`, `tilesSource`; host.: none
- **E25** (8374-8618) module-local: `FLOOD_COARSE_PX`, `FLOOD_WHOLE_SHARE`, `InpaintEditor`, `clampRect`, `makeCanvas`; imports: `INTERACTIVE`, `TILE_SIZE`, `arenaEnabled`, `clipMaskToSelection`, `editorPool`, `editorWorker`, `floodMask`, `isTilePixels`, `maskBounds`, `maskToColorCanvas`, `selectionGco`, `stackInArena`, `storeArgs`, `workerCall`; host.: none
- **E26** (8626-9085) module-local: `InpaintEditor`, `NO_PROGRAM`, `makeCanvas`; imports: `EXPORT`, `FILTERS`, `OPS`, `TILE_SIZE`, `applyFilter`, `arenaEnabled`, `beginScope`, `editorPool`, `endScope`, `glMaxSide`, `glReleaseLargeSurfaces`, `isGLSurface`, `isTilePixels`, `partsFailed`, `partsUsable`, `readSurfaceBytes`, `releaseSurface`, `seedOfLayer`, `stackArgs`, `stackInArena`, `stackRows`, `surfaceFromBytes`; host.: none
- **E27** (9092-9530) module-local: `InpaintEditor`, `NO_PROGRAM`, `cpuDab`, `makeCanvas`; imports: `INTERACTIVE`, `TILE_SIZE`, `arenaEnabled`, `compositeBox`, `editorPool`, `isTilePixels`, `markStep`, `nextPartsSeq`, `partsFailed`, `partsUsable`, `stackArgs`, `stackInArena`, `storeArgs`, `tilesSource`; host.: none
- **E28** (9533-9637) module-local: `loadImageEl`, `makeCanvas`, `orientIsUp`, `orientMatrix`, `orientOfXf`, `validXf`, `xfIsIdentity`; imports: `XF_IDENTITY`, `selectionGco`, `xfMul`; host.: none
- **E29** (9642-9862) module-local: `cpuDab`, `makeCanvas`; imports: `THEME`, `TipPicker`, `failKind`, `noteRecentTip`, `readAbr`, `tipCanvas`; host.: none
- **E30** (9873-10134) module-local: `TONE_DAB`, `cpuDab`, `meanRGB`; imports: `SMUDGE_ALPHA_LOCK`, `SMUDGE_PICKUP`, `blurRGBA`, `hexToRgb`, `sharpenRGBA`, `smudgeDabKernel`, `spongeRGBA`, `toneRGBA`; host.: none
- **E31** (10147-10320) module-local: `InpaintEditor`, `cpuDab`, `patchMix`; imports: `INTERACTIVE`, `TILE_SIZE`, `editorPool`, `nextPartsSeq`, `poissonBlendKernel`; host.: none
- **E32** (10327-10559) module-local: `InpaintEditor`, `StrokeBuffer`, `cpuDab`; imports: `failKind`, `host`, `refusal`; host.: removeModel
- **E33** (10570-10812) module-local: `InpaintEditor`, `REMOVE_MARK`, `StrokeBuffer`, `cpuDab`; imports: `INTERACTIVE`, `distTransform`, `editorPool`, `failKind`, `fromModel`, `hexToRgb`, `host`, `nextPartsSeq`, `poissonBlendKernel`, `removeCrop`, `toModelImage`, `toModelMask`; host.: removeInApp, removeModel
- **E34** (10824-10985) module-local: `InpaintEditor`, `cpuDab`; imports: `TILE_SIZE`, `failKind`, `fromModel`, `host`, `refusal`, `removeCrop`, `toModelImage`, `toModelMask`; host.: removeInApp
- **E35** (10991-11021) module-local: none; imports: none; host.: none
- **E36** (11036-11696) module-local: `InpaintEditor`, `makeCanvas`; imports: `LiquifyField`, `MIP_LEVELS`, `allocLiquifyWindow`, `freeLiquifyWindow`, `gridStep`, `isTilePixels`, `liquifyFalloff`, `liquifyPreview`, `thawPlane`; host.: none
- **E37** (11699-11761) module-local: `cpuDab`; imports: `host`; host.: removeModel, removeSupported, warmRemove
- **E38** (11764-11998) module-local: `StrokeBuffer`; imports: none; host.: none
- **E39** (12001-12093) module-local: `InpaintEditor`, `makeCanvas`; imports: `OPS`, `failKind`, `isTilePixels`, `rgbToHex`; host.: none
- **E40** (12101-12640) module-local: `InpaintEditor`, `STROKE_BAND`, `STROKE_SCRATCH_KEEP_PX`, `StrokeBuffer`, `clampRect`, `makeCanvas`; imports: `BLIT_MARGIN`, `OPS`, `TILE_SIZE`, `canvasOf`, `failKind`, `isTilePixels`; host.: none
- **E41** (12642-12844) module-local: `clampRect`, `makeCanvas`; imports: `growMaskBounds`, `isTilePixels`; host.: none
- **E42** (12848-13365) module-local: `OBJECT_BACKEND`, `RUN_GOING_TEXT`, `SEGMENT_BACKENDS`, `availableSegmentBackends`, `availableUpsampleBackends`, `hostText`, `loadImageEl`, `makeCanvas`, `objectBackendAvailable`, `segmentTermInstruction`, `upsampleInstruction`, `viewUrl`, `withSpecDefaults`; imports: `SUBFOLDER`, `api`, `checkNote`, `compare`, `failKind`, `host`, `namesFor`, `normalize`, `parse`, `refusal`, `remap`, `selectionGco`, `uploadCanvas`; host.: askLLM, connected, findObjects, objectsInApp, refTokens, selectPoint, upsampleInApp
- **E43** (13370-14209) module-local: `el`, `iconButton`, `makeCanvas`; imports: `FILTERS`, `GUIDE`, `INTERACTIVE`, `SNAP_DEFAULT`, `STALE_DIFF`, `WORK_MAX`, `deriveMap`, `editMap`, `editorPool`, `failKind`, `fingerprint`, `fingerprintDiff`, `host`, `makeMap`, `modelSize`, `packRG16`, `selectionOnMap`, `uploadCanvas`, `workSize`; host.: computeDepth, depthDetail, depthDetailSetting, depthInput, depthModel, getDepthDetail, pictureInput, setDepthDetail
- **E44** (14219-14318) module-local: `makeCanvas`; imports: `canvasSizeRefusal`, `failKind`, `uploadCanvas`, `xfTranslate`; host.: none
- **E45** (14326-15358) module-local: `LAYER_PENDING_KEYS`, `MAX_SNAPSHOTS`, `MAX_UNDO`, `MAX_UNDO_BYTES`, `SNAP_CANVAS_PX`, `UNDO_LABELS`, `fileGone`, `needImage`, `refKey`, `snapImage`, `tileDiffBox`; imports: `TEXT_DEFAULTS`, `TILE_SIZE`, `canvasToBlob`, `failKind`, `installLayerAliases`, `isTilePixels`; host.: none
- **E46** (15362-15441) module-local: none; imports: `invertMask`, `isTilePixels`; host.: none
- **E47** (15462-15674) module-local: `DISSOLVE_CLIP_SHADER`, `DISSOLVE_SHADER`, `EMULATED_BLEND_CLIP_SHADER`, `EMULATED_BLEND_SHADER`, `FREQ_MAX_PX`, `cpuDab`, `makeCanvas`; imports: `BLEND_OPS`, `EMULATED_BLENDS`, `OPS`, `canvasOp`, `compositeTile`, `freqSeparate`, `hash32`, `isGLSurface`, `markStep`, `mul255`, `runShader`, `surfaceToCanvas`, `toneLUT`; host.: none
- **E48** (15685-15719) module-local: `UploadCache`; imports: none; host.: none
- **E49** (15723-16065) module-local: `canvasRows`, `loadImageEl`, `makeCanvas`, `viewUrl`; imports: `FILTERS`, `applyFilter`, `bandRows`, `beginScope`, `endScope`, `failKind`, `fillPixels`, `filterDefaults`, `glChainUsable`, `host`, `isGLSurface`, `limitAlphaRows`, `lutFromCube`, `lutToCanvas`, `plateStats`, `releaseSurface`, `surfaceToCanvas`, `uploadBlob`, `uploadCanvas`; host.: getRelightSettings
- **E50** (16075-16384) module-local: `sourceTag`; imports: `FILTERS`, `colourSimilarity`, `colourStats`, `hexToRgb01`, `host`, `opp`, `passToMap`, `sampleMap`, `u16Bilinear`; host.: pluginReport
- **E51** (16391-16619) module-local: `RANGE_PREVIEW_SHADER`; imports: `colourSimilarity`, `glToCanvas`, `hexToRgb01`, `opp`, `rangeWeight`, `runShader`; host.: none
- **E52** (16632-16794) module-local: `makeCanvas`; imports: `EMULATED_BLENDS`, `canvasOp`, `drawSurfaceTo`, `glChainUsable`, `isGLSurface`, `isTilePixels`, `releaseSurface`, `seedOfLayer`, `surfaceToCanvas`; host.: none
- **E53** (16796-17348) module-local: `MASK_RGB`, `REF_FITS`, `RUN_GOING_TEXT`, `availableCutoutBackends`, `hostText`, `icon`, `loadImageEl`, `makeCanvas`, `viewUrl`, `withSpecDefaults`; imports: `SUBFOLDER`, `api`, `failKind`, `host`, `pixelMap`, `uploadCanvas`, `xfInv`, `xfMul`; host.: cutoutInApp
- **E54** (17355-17841) module-local: `LAYER_PENDING_KEYS`, `cpuDab`, `hugePngSize`, `imageFileSize`, `isSvgFile`, `isTiffFile`, `layeredKind`, `loadImageEl`, `makeCanvas`, `pixelsFromTiff`, `pixelsOffThread`, `rasterizeSvg`, `storedExt`, `viewUrl`; imports: `EMULATED_BLENDS`, `LAYERED_EXT`, `TIFF_EXT`, `canvasOp`, `failKind`, `fillPixels`, `host`, `installLayerAliases`, `isTilePixels`, `normalBlend`, `seedOfLayer`, `tiffInfo`, `uploadBlob`, `uploadCanvas`; host.: refTokens
- **E55** (17846-18106) module-local: `MASK_RGB`, `el`, `miniButton`, `normDeg`, `numberInput`, `orientOps`, `selectInput`, `spinText`, `textBox`, `textStartFraction`, `textTotalAngle`; imports: `FONT_CATEGORIES`, `SUBFOLDER`, `TEXT_DEFAULTS`, `addUserFont`, `failKind`, `fontList`, `loadFontList`, `pixelMap`, `renderText`, `textAngle`, `textFrame`, `uploadBlob`, `xfApply`, `xfInv`, `xfMul`, `xfRotate`; host.: none
- **E56** (18112-18236) module-local: `hugePngSize`, `imageFileSize`, `pixelsFromTiff`, `pixelsOffThread`; imports: `JOB_TIMINGS`, `STEP_MARKS`, `buildLayered`, `editorPool`, `encodeBands`, `encodeCanvas`, `encodeTilePixels`, `host`, `kernelRoutes`, `kernelsMode`, `liquifyDab`, `measureGen`, `partsUsable`, `pendingJobs`, `pngPartsOf`, `pxCalls`, `pxInstances`, `pxSplit`, `pxTimed`, `readPngParts`, `readTiffBand`, `readTiffBands`, `resetPool`, `setKernelRoute`, `setKernels`, `tiffPlan`, `uploadPixels`, `workerCall`; host.: editors, referencedTexts
- **E57** (18254-18592) module-local: `InpaintEditor`, `NO_PROGRAM`, `canvasRows`, `hostText`, `makeCanvas`; imports: `OraBandWriter`, `PsdBandWriter`, `SRGB_CHUNK`, `api`, `arenaEnabled`, `asciiJson`, `bandPause`, `bandRows`, `buildLayered`, `deflate`, `editorPool`, `failKind`, `host`, `isTilePixels`, `markStep`, `nextPartsSeq`, `partsFailed`, `partsFlights`, `partsRun`, `partsUsable`, `pngWithChunks`, `tiffPart`, `tileRows`, `writeTiff`; host.: exportCanvas, exportIsPlain, exportQuality, saveExport, workflowForPng
- **E58** (18595-18858) module-local: `MIN_AUTO_CROP`, `PYRAMID_MIN_PX`, `autoSelectionParams`, `ensureMinSpan`; imports: `canvasOf`, `host`, `isTilePixels`; host.: refTokens, widgetValue
- **E59** (18867-19322) module-local: `HUGE_MAX_PIXELS`, `HUGE_MAX_SIDE`, `InpaintEditor`, `PSD_WINDOW`, `hugePngSize`, `imageFileSize`, `imageOfBlob`, `isSvgFile`, `isTiffFile`, `layeredKind`, `loadImageEl`, `pixelsFromTiff`, `pixelsOffThread`, `psdOnPool`, `rasterizeSvg`, `storedExt`, `svgSize`, `viewUrl`; imports: `CANVAS_MAX_PIXELS`, `CancelledError`, `LayerPixels`, `MaskPixels`, `TIFF_EXT`, `editorPool`, `failKind`, `inflateAtMost`, `kernelRoute`, `markStep`, `normalBlend`, `partsUsable`, `pixelsOptions`, `readOra`, `readPsd`, `refusal`, `tiffInfo`, `uploadBlob`, `uploadPixels`; host.: none
- **E60** (19324-19479) module-local: `loadImageEl`, `viewUrl`; imports: `SUBFOLDER`, `failKind`, `host`, `installLayerAliases`, `normalBlend`; host.: refTokens
- **E61** (19481-20120) module-local: `ROLES`, `availableCutoutBackends`, `el`, `icon`, `miniButton`, `refBadge`, `selectGrouped`, `selectInput`; imports: `BLENDS`, `BLEND_GROUPS`, `FILTERS`, `host`, `labelMap`, `sameLabels`; host.: depthSupported, refTokens
- **E62** (20123-20331) module-local: `el`, `hostText`, `iconButton`, `miniButton`; imports: `FILTERS`, `FILTER_IDS`, `hexRgb`, `host`; host.: depthSupported
- **E63** (20340-20592) module-local: `el`, `iconButton`; imports: `buildRangeBar`, `host`, `normalizeLimit`, `normalizeStoredLimit`; host.: depthSupported
- **E64** (20602-21444) module-local: `RELIGHT_LIGHT_TYPES`, `RELIGHT_STYLES`, `el`, `iconButton`, `miniButton`; imports: `KELVIN_PRESETS`, `LIGHT_MAX`, `LIGHT_PRESETS`, `SPOT_GOBOS`, `applyLightPreset`, `defaultLight`, `host`, `lightColorHex`, `loraPercent`; host.: depthSupported, relightWhole, setRelightSettings
- **E65** (21448-21609) module-local: `el`, `loadImageEl`, `miniButton`, `orientIsUp`, `orientMatrix`, `validXf`, `viewUrl`; imports: `host`, `parse`, `remap`, `xfBox`, `xfMul`, `xfScale`; host.: refTokens
- **E66** (21616-21911) module-local: `boxOnPixels`, `loadImageEl`, `makeCanvas`, `orientIsUp`, `orientOps`, `validXf`, `viewUrl`; imports: `failKind`, `host`, `pixelMap`, `uploadCanvas`, `xfInv`, `xfMul`, `xfScale`; host.: newCanvasChoices, newCanvasChosen
- **E67** (21923-22346) module-local: `InpaintEditor`, `PYRAMID_LEVELS`, `PYRAMID_MIN_PX`, `makeCanvas`; imports: `BLEND_OPS`, `GLCompositor`, `LayerPixels`, `MIP_LEVELS`, `canvasOf`, `displayCanvasIfMade`, `isTilePixels`, `pixelsOptions`, `uploadPixels`; host.: none
- **E68** (22349-22892) module-local: `cpuDab`, `drawMesh`, `makeCanvas`; imports: `EMULATED_BLENDS`, `canvasOp`, `isTilePixels`, `seedOfLayer`; host.: none
- **E69** (22894-23197) module-local: `makeCanvas`; imports: `chainScheduler`, `isTilePixels`, `matchCanvas`; host.: none
- **E70** (23199-23425) module-local: `InpaintEditor`, `NO_PROGRAM`, `makeCanvas`; imports: `CANVAS_MAX_PIXELS`, `TILE_SIZE`, `encodeBands`, `encodeRows`, `failKind`, `partsUsable`, `uploadBlob`, `uploadCanvas`; host.: none
- **E71** (23437-23477) module-local: none; imports: `uploadPixels`; host.: none
- **E72** (23490-23601) module-local: `makeCanvas`; imports: none; host.: none
- **E73** (23619-23717) module-local: none; imports: `chainScheduler`; host.: none
- **E74** (23722-24293) module-local: none; imports: `INTERACTIVE`, `NORMAL`, `STRIPES_PER_WORKER`, `cancelMarch`, `editorPool`, `heightNormals`, `kernelRoute`, `lightColorHex`, `lightToMap`, `marchOnPool`, `markStep`, `nextPartsSeq`, `relightDepthScale`, `relightMapKey`, `relightVisCurrent`, `relightVisKey`, `shadowMarch`; host.: none
- **E75** (24300-24756) module-local: `HANDLE_PX`, `makeCanvas`, `refBadge`; imports: `isTilePixels`; host.: none
- **E76** (24763-24936) module-local: `FIXED_OUTPUTS`, `el`, `isSettingOutput`, `linkOf`, `numberInput`, `selectInput`, `settingIndex`; imports: `host`; host.: boxSwitch, graph, renderPresets, resultInputState, settingTargets
- **E77** (24949-25089) module-local: none; imports: `LayerPixels`, `api`, `chainScheduler`, `displayCanvasIfMade`, `failKind`, `host`, `releaseBoxBuffers`; host.: connected, freeHelpers
- **E78** (25096-25207) module-local: `RUN_GOING_TEXT`, `SEL_BOX_MAX_PX`, `randomSeed`; imports: `canvasToBlob`, `encodeTilePixels`, `failKind`, `host`, `isTilePixels`; host.: changed, queueGenerate
- **E79** (25209-25652) module-local: `CROP_DEFAULTS`, `CROP_LEGACY`, `GEN_DEFAULTS`, `LAYER_KINDS`, `LOAD_NOTE_LINES`, `LOAD_NOTE_MS`, `REF_DEFAULTS`, `SYNC_ENCODE_PX`, `imageOfBlob`, `leftOutText`, `loadImageEl`, `orientIsUp`, `pixelsFromPngStream`, `pixelsOffThread`, `randomSeed`, `validXf`, `viewUrl`; imports: `FILTERS`, `TEXT_DEFAULTS`, `failKind`, `filterDefaults`, `host`, `installLayerAliases`, `labelMap`, `loadFontList`, `lutFromImage`, `mapFromJSON`, `mapToJSON`, `normalBlend`, `promptPayload`, `selectionBoxIdOf`, `uploadCanvas`; host.: boxSwitch, boxesInEditor, refTokens
- **E80** (25666-25858) module-local: none; imports: `TILE_SIZE`, `canvasOf`, `chainScheduler`, `displayCanvasIfMade`, `isTilePixels`, `scratchStats`; host.: none

### 1.3 ICONS and STYLE (verified; CLAUDE.md's 1359 / 1494 are stale)

- **ICONS** `const ICONS = {` 1485-1592 (header comment 1481-1483), then `icon(name, size)` 1594-1596 (the only
  reader of `ICONS`, 1595), `iconButton` 1598-1605, `miniButton` 1607-1614; both buttons call `el` (1002-1007). No
  `${...}` inside ICONS (0 interpolations). Consumers: `icon` 8 calls in the file + `renderer/plugins.js:14`;
  `iconButton` 30 calls + `inpaint_modal.js:7`; `miniButton` 36 calls + `inpaint_modal.js:7`. Class regions using
  them: E03 E04 E12 E43 E53 E55 E61 E62 E63 E64 E65.
- **STYLE** ``const STYLE = ` `` 1620-2029 (header comment 1616-1618; 410 lines of CSS, 0 interpolations, so it reads
  no module scope), `injectStyle()` 2031-2037 (the only in-file reader of STYLE, 2035; touches `document` only when
  called). Consumers: `injectStyle()` in the constructor (2440); STYLE through the export list (25862) to
  `renderer/shell.js:5` (`STYLE as EDITOR_STYLE`, used at shell.js:34 inside `@layer app { }`, before the editor's
  own `injectStyle` finds the `ipc-style` element, shell.js:30-34).
- **Tests that read STYLE as text by this file's path:** `tools/skins_test.js:190` (`styleOf`: regex
  `` /\n(?:export )?const STYLE = `\n([\s\S]*?)\n`;\n/ ``), `:299` (`styleOf(read("renderer/editor/inpaint_canvas.js"))`,
  throws "no STYLE block in inpaint_canvas.js"), `:616` (byte proof source `style: { file: "renderer/editor/inpaint_canvas.js" }`,
  runs only with a BASE commit set, and reads BASE's text, so an old BASE still works). A STYLE move needs these two
  paths changed (or a re-pointing of `styleOf`'s file). `tools/skins_test.js:654-659` (`byte_proof_theme_defaults`)
  reads colour literals at fixed line numbers 2728, 2763, 2731, 2739, 2740, 4909 of BASE's inpaint_canvas.js: only
  valid for the BASE it was written for; a later BASE after any move breaks it.
- Both blocks are self-contained leaf modules: STYLE + injectStyle (`inpaint_style.js`, ~422 lines with the header)
  and ICONS + icon/iconButton/miniButton with the DOM helpers they need (see T-dom, T-icons below; ~215 lines).

### 1.4 Seams in inpaint_canvas.js

**Mechanics that decide how a region can move** (evidence below in section 6):

1. **Module-scope helpers first, as plain functions/consts (option a).** They have no `this`; a new leaf module
   exports them by name, inpaint_canvas.js imports them back and re-exports the public ones. Leaf modules that read
   `InpaintEditor` (T-load: `InpaintEditor.psdOnPool`, `.pngStreamFrom`, `.imageWorkerFrom`, `.tiffBandRows`) join
   the existing cycle and may read it only inside functions (the inpaint_jobs.js / inpaint_encode.js rule,
   docs/BUILD_NODE.md:88-102).
2. **Class regions via a mixin (option b).** Safe facts: no `super`, no `#private`, no instance fields. Hazards:
   - `Object.assign(InpaintEditor.prototype, obj)` turns the 10 accessors into plain values (it reads the getter) and
     makes the methods enumerable (class methods are not). Use `Object.defineProperties(proto,
     Object.getOwnPropertyDescriptors(obj))` with `enumerable: false`, and throw on a name already on the prototype:
     no linter sees a duplicate across files (`no-dupe-class-members`, eslint.config.mjs:26, sees one class body).
     Keep the statics (E56) on the class; keep the accessors in the class or move them as descriptors.
   - **Evaluation order.** ComfyUI imports every `.js` of the node's `js/` in an unknown order
     (docs/BUILD_NODE.md:84-99). If a mixin module M imports inpaint_canvas.js (C) and C installs M's object at C's
     evaluation, then "M first" evaluates C before M's body: a `const`/`class` export of M is still in its TDZ and
     the install throws. Two ways that hold in every order: (i) **M never imports C** (it imports the leaf modules of
     step 1; the 14 regions that read `InpaintEditor.<static>` then need the statics from a leaf or
     `this.constructor`, a text change), or (ii) M exports a **function declaration** installer
     (`export function installX(C) { ... }`, hoisted, initialized before any module body runs) that C calls after
     the class; the methods' object literal is then built inside it (one indentation level deeper). Either way the
     install call stays in inpaint_canvas.js, never at M's top level.
   - Node runs: `tools/limit_test.js:67` and `tools/maps_test.js:73` import inpaint_canvas.js in plain Node and call
     `InpaintEditor.prototype.<m>` with a fake `this` (`limit_test.js:110-229` filterKey, effectViewOf, mapsOf,
     filterInfo, setFilterType; `maps_test.js:173-476` clipTargetOf, clipBaseOf, passStores, drawComposite,
     geometryToken, setMap, setMapMeta, cancelMapMeta, mapExtras, followGeometry, memoryReport, ...). They keep
     working if the install happens when C evaluates and no mixin module touches the DOM at its top level.
   - A moved method that calls `host.X` is still seen by build_node.py only if its new file is in `FILES`
     (`tools/build_node.py:39-47`, scanned at 166-167), and that file must itself `import { host } from "./host.js"`
     (`build_node.py:145-148`).

**Candidate modules, module scope (option a, plain named exports):**

| seam | lines | ~lines | reads | used by | notes |
|---|---|---|---|---|---|
| style | 1616-2037 | 422 | nothing | E02 (`injectStyle` 2440), shell.js:5 | skins_test.js:299/616 read the path |
| dom + icons | 1002-1083, 1481-1614 | 215 | `mapOffset` (reftokens.js) | 13 / 11 class regions, inpaint_modal.js, inpaint_boxes.js, plugins.js | re-export el, icon, iconButton, miniButton, selectInput, selectGrouped, numberInput |
| orient | 151-357 | 207 | `XF_IDENTITY, xfBox, xfMul, xfRotate, xfTranslate` (inpaint_resample.js), `textAngle, textFrame` (inpaint_text.js) | E05 E14 E15 E17-E21 E28 E55 E65 E66 E79 | pure math; one top-level loop (222-224) fills ORIENT_SIGNS at evaluation, no DOM |
| shaders | 385-474 | 90 | `BLEND_FN_GLSL`, `WEIGHTS_GLSL` | E47, E51 | DISSOLVE_SHADER / DISSOLVE_CLIP_SHADER are public exports |
| mesh | 1091-1168 | 78 | nothing | E05, E68 | homography, drawTriangle, drawMesh |
| backends | 1181-1479 | 299 | `host` (members nodeTypes, upsampleBackends, upsampleInstruction, cutoutBackends, objectsInApp), `referencesRule`, `referencesText` | E02 E42 E53 E58 E61 E76 E78 E79 | needs `import { host }`; many public exports (CROP_DEFAULTS, GEN_DEFAULTS, FIXED_OUTPUTS, SETTING_SLOTS, isSettingOutput, settingIndex, linkOf, UPSAMPLE_CASES, randomSeed) |
| load | 494-949 | 456 | 19 imports (tiff, png, layered, pool, bands, `api`), `InpaintEditor` statics, `makeCanvas` | 19 class regions | **K20c (ag-chain-p-9) edits 752-757**: after K20c only |
| consts (head, consts, roles, brush size) | 63-146, 359-383, 475-488, 950-1000 | 170 | `host` (`hostText`: host.text; `refBadge`: host.refTokens), `pixelsOptions` | almost every region | `makeCanvas`, `HANDLE_PX`, `el` are the most shared names; move them before any class region |
| stroke/upload classes | 2039-2256 | 218 | `mapTileStats`, `rangeMax` | E21 E23 E32 E33 E38 E40 E48 E50 | `let CLIPBOARD` (2044) must stay with its accessor (E01, written at 2262) or become an object property; `let sourceIdSeq` stays with `sourceTag` |

**Candidate modules, class regions (option b), by subject:**

| seam | regions | lines | ~lines | reads InpaintEditor | risk tier (CLAUDE.md working rules) | notes |
|---|---|---|---|---|---|---|
| text tool | E14 + E55 | 5062-5123, 17846-18106 | 330 | no | normal | two blocks |
| transform / canvas geometry | E05, E15-E20 | 3029-3236, 5126-6373 | 1,455 | no | normal (pixels: turn, straighten, crop, resize are Full-ish) | 5126-6373 contiguous |
| pointer + keys | E07, E21 | 3699-4001, 6377-7229 | 1,156 | no | normal | the event core; reads StrokeBuffer |
| selection | E23-E28, E41, E46 | 7529-9637, 12642-12844, 15362-15441 | 2,390 | E25-E27 | normal / Full for the band programs (E26) | E26-E27 hold the stack/program machinery used by brushes too |
| brush tips, smudge, clone | E29-E30, E37 | 9642-10134, 11699-11761 | 550 | no | normal | |
| heal, patch, move, remove | E31-E35 | 10147-11021 | 875 | E31-E34 | normal | |
| liquify | E36 | 11036-11696 | 661 | yes | normal | |
| shape, gradient, bucket | E38-E39 | 11764-12093 | 330 | E39 | normal | |
| stroke buffers | E40 | 12101-12640 | 540 | yes | Full (writes tiles) | |
| select by text, upsample, objects | E42 | 12848-13365 | 518 | no | normal | uses `api` |
| depth and maps | E43 (+ E50's depth proxies) | 13370-14209 | 840 | no | normal | `get/set depth` 13370-13386 are accessors |
| history / undo / snapshots | E45 | 14326-15358 | 1,033 | no | **Full** (undo, restore) | |
| filters | E47-E52 | 15462-16794 | 1,333 | no | Full (pixels) | maps_test/limit_test call several of these on the prototype |
| masks, cutout, menus | E53 | 16796-17348 | 553 | no | normal | |
| layers panel and layer ops | E54, E60, E61 | 17355-17841, 19324-20120 | 1,285 | no | normal | |
| panels: filter / limit / relight UI | E62-E64 | 20123-21444 | 1,322 | no | light/normal | three single methods (209, 253, 843 lines) |
| export, bounds, load | E57-E59 | 18254-19322 | 1,069 | E57, E59 | **Full** (export writers) | **K20c edits E59 (19084-19259)** |
| history panel, new canvas | E65-E66 | 21448-21911 | 464 | no | normal | |
| compositor / display / flatten | E67-E70 | 21923-23425 | 1,503 | E67, E70 | **Full** (compositor) | `base`/`basePx`/`_basePx` accessors 22110-22121 |
| relight runtime + scene draw | E72-E75 | 23490-24756 | 1,267 | no | Full (pixels on screen) | skins_test.js:396-401 reads drawBrushRing, antsStroke, drawMarchingAnts (E72) by `\n    name(` in this file |
| persistence | E79 | 25209-25652 | 444 | no | **Full** (.scumble / autosave) | |
| stay in the class | E01, E02, E06, E56, E71, E76-E78, E80 | | ~1,500 | | | constructor, lifecycle, statics, syncLayers (quit_test.js:492-494 reads `syncLayersOnce`/`syncLayers` by text) |

Sum moved if all of option b goes: about 20,000 of the class's 23,600 lines.

---------------------------------------------------------------------------------------------------------------------

## 2. renderer/editor/host.js (7,100 lines, ES module, `// @ts-check`)

Top level: imports 17-65 (29 modules); helpers 29-446 (`sentTexts` 29, `HINT_NOTE` 41, `notesKind` 43, `PROXY` 67,
`boxesSchema` 75, `textOptions` 87, `SUBFOLDER` 93, `MAX_EXPORT_SIDE` 100, `EXPORT_PERCENTS` 101, `ENCODER_MAX_SIDE`
108, `SAVE_PIECE` 114, `capExportSide` 123, `API_SIZES` 131, `listeners` 141, `STATE_KEYS` 145, `hashString` 148,
`fmtMB` 160, `documentQuestion` 167-217, `normPath` 220, `docMeta` 229, `plainObject` 237, `RUN_GOING` 240,
`AREA_RECIPE_CHANGED` 242, `AREA_STOPPED` 244, `AREA_STOPPED_API` 245, `NOT_SENT` 247, `promptMissing` 253,
`RELIGHT_DEFAULTS` 262, `viaLine` 280, `KLEIN_RECIPES` 289, `SHAPE_ERROR` 291, `kleinRun` 299, `aspectOf` 311,
`upsampledNote` 320, `KLEIN_FEATURES` 329, `KLEIN_ENCODER_NAME` 331, `kleinEncoderHint` 340, `mosaicPixels` 373,
`runIdOf` 387, `KEY_BAND_ROWS` 394, `KEY_MASK_RGB` 396, `keyGreyRgba` 399, `keyHelper` 406, `providerEdit` 412,
`answeredSeed` 429, `upscaleWords` 435, `listWords` 442, `CLOSED_MAX` 446); `export const api = {` 448-498 (7
members: clientId, apiURL, fetchApi, queuePrompt, add/removeEventListener, dispatch); typedefs `EditorApi` 516 and
`EditorHost` 527-592 (read by `types/contracts.js:14-21`); `objectIds` 594, `let objectSeq` 595, `objectId` 596;
**`export const host = {` 603-6947** (one object literal, 330 properties: 260 methods, 70 data properties, no
getters/setters, no spread); then page-level wiring 6951-7100 (`window.scumble.comfy.onEvent` 6951, the
`api.addEventListener` handlers, `markLanded` 7025, `localRunEnded` 7032, `closedPromptEnded` 7039).

Methods address the object as `this` (207 of 260 use `this`); **no method names `host.` itself** (the cross-reference
scan finds `host` used only from the module helpers and the wiring after 6947). So a region moved into its own object
literal and spread back (`export const host = { ...stateFields, ...keyMethods, ... }`) keeps `this` when called as
`host.x()`. The spread evaluates at host.js's evaluation, so the parts must be `const` objects of modules host.js
imports and that do not import host.js back (a cycle would put them in their TDZ), or function-declaration factories.

host object regions:

| id | lines | properties | first .. last | subject |
|---|---|---|---|---|
| H01 | 604-634 | 24 (0 methods, 0 use this) | `editor` .. `_types` | host: state fields |
| H02 | 640-783 | 16 (13 methods, 13 use this) | `configure` .. `newBoxes` | configure, relight/depth settings, server status, realism support, crop limits, box switch |
| H03 | 785-921 | 11 (11 methods, 11 use this) | `setApiSize` .. `hookStatus` | attach, editor registry, events, hookStatus |
| H04 | 932-1265 | 12 (12 methods, 9 use this) | `exportState` .. `syncExportRow` | export: state, pixels, size row, canvas, quality |
| H05 | 1267-1371 | 22 (15 methods, 12 use this) | `toolChanged` .. `loadObjectInfo` | plugin hooks, editor lookup, mount, nodeTypes, loadObjectInfo |
| H06 | 1378-1526 | 8 (7 methods, 7 use this) | `boxPromptSlot` .. `modeChanged` | box plans, onConnected, restore, setRecipe, modeChanged |
| H07 | 1530-1899 | 25 (20 methods, 18 use this) | `presets` .. `renderPresets` | presets and LoRAs (local + Comfy Cloud), renderPresets |
| H08 | 1908-2113 | 14 (14 methods, 10 use this) | `missingSettingFiles` .. `wantsTransparent` | setting files, relight models, applyPreset, recipe mode, settingTargets, providerParams, transparency |
| H09 | 2135-2380 | 9 (8 methods, 5 use this) | `refPrompt` .. `boxContext` | reference prompt, ref layout, comfy plan, boxContext |
| H10 | 2390-2519 | 1 (1 methods, 1 use this) | `runProvider` .. `runProvider` | runProvider |
| H11 | 2525-2881 | 9 (9 methods, 6 use this) | `upscaleFactorFor` .. `buildUpscaleButton` | upscale (factor, refusals, runUpscale, landWholePicture, runComfyUpscale, button) |
| H12 | 2892-3020 | 1 (1 methods, 1 use this) | `runGenerate` .. `runGenerate` | runGenerate |
| H13 | 3024-3166 | 16 (13 methods, 12 use this) | `promptTemplates` .. `uploadResult` | prompt templates, brush tips, generate-new hooks, uploadResult |
| H14 | 3168-3418 | 23 (21 methods, 17 use this) | `_providerRuns` .. `uploadInput` | provider runs, run rows, tracking, progress events, uploadInput |
| H15 | 3421-3637 | 7 (5 methods, 3 use this) | `_pictureRuns` .. `cancelComfyPrompt` | ComfyUI picture runs (comfyPictureRun, events, cancel) |
| H16 | 3640-3993 | 5 (5 methods, 5 use this) | `setRealismValues` .. `realismWhole` | Realism Pass (passPicture, realismWhole) |
| H17 | 3998-5035 | 45 (38 methods, 28 use this) | `keyStored` .. `keyComfy` | key green/blue screen (in-app engine stub, Route B ComfyUI, landKey) |
| H18 | 5038-5396 | 2 (2 methods, 1 use this) | `relightSend` .. `relightWhole` | relightWhole |
| H19 | 5404-5758 | 5 (5 methods, 2 use this) | `queueGenerate` .. `ensureOnServer` | queueGenerate, state refs, ensureOnServer |
| H20 | 5761-5959 | 10 (9 methods, 9 use this) | `workflowForPng` .. `referencedFileKeys` | workflowForPng, buildGenerateExtras, setNodeParam, saveExport, changed, bundle, saveAll, file refs |
| H21 | 5963-6272 | 19 (15 methods, 8 use this) | `_docSaves` .. `reopenClosed` | documents: save/open, dirty, closed tabs |
| H22 | 6283-6946 | 46 (36 methods, 29 use this) | `helpers` .. `freeHelpers` | helpers: LLMs, SAM2 objects, cutout, segment, depth, freeHelpers |


(H01 holds 24 data properties; more data properties sit inside H02-H22 next to the methods that own them, e.g.
`relightSettings` 659, `_closedPrompts` 1332, `_loraInfo` 1594, `_providerRuns` 3168, `_pictureRuns` 3421,
`keyStored` .. `keyEngine` 3998-4042, `_docSaves` 5963, `closed` 6221, `helpers` 6283, `removeSupported` 6419,
`depthSupported` 6422, `refTokens` 6428, `boxesInEditor` 6431.)

What each section reads from the rest of host.js (module scope; `@H00` = the helpers block 1-602):

- **H00** 1-602 (602) imports, module helpers (texts, hints, document question, Klein, key helpers), api object, EditorApi/EditorHost typedefs, objectId: uses from other sections: host@H01
- **H01** 603-639 (37) host: state fields: uses from other sections: none
- **H02** 640-784 (145) configure, relight/depth settings, server status, realism support, crop limits, box switch: uses from other sections: API_SIZES@H00, RELIGHT_DEFAULTS@H00, boxesSchema@H00, comfyprompt@H00, loraPercent@H00, planFrame@H00, realism@H00, textOptions@H00
- **H03** 785-931 (147) attach, editor registry, events, hookStatus: uses from other sections: API_SIZES@H00, CLOSED_MAX@H00, buildAreaButton@H00, glReleasePool@H00, plainObject@H00
- **H04** 932-1266 (335) export: state, pixels, size row, canvas, quality: uses from other sections: ENCODER_MAX_SIDE@H00, EXPORT_PERCENTS@H00, MAX_EXPORT_SIDE@H00, canvasSizeRefusal@H00, capExportSide@H00, refusal@H00
- **H05** 1267-1377 (111) plugin hooks, editor lookup, mount, nodeTypes, loadObjectInfo: uses from other sections: api@H00
- **H06** 1378-1529 (152) box plans, onConnected, restore, setRecipe, modeChanged: uses from other sections: CLOSED_MAX@H00, api@H00, comfyprompt@H00, loraPanel@H00, plainObject@H00, promptPayload@H00, refusal@H00, syncAreaButton@H00
- **H07** 1530-1907 (378) presets and LoRAs (local + Comfy Cloud), renderPresets: uses from other sections: LORA_MODEL_CLASS@H00, MAX_LORAS@H00, api@H00, comboOf@H00, familyOf@H00, loraFolder@H00, loraMeta@H00, loraPanel@H00, loraTriggers@H00, missingLoras@H00, modelSource@H00, noSourceWords@H00, normalizeName@H00, refusal@H00, spliceLoras@H00, usableRows@H00
- **H08** 1908-2134 (227) setting files, relight models, applyPreset, recipe mode, settingTargets, providerParams, transparency: uses from other sections: loraPanel@H00
- **H09** 2135-2389 (255) reference prompt, ref layout, comfy plan, boxContext: uses from other sections: comfyLayout@H00, comfyRefSpec@H00, hasTokens@H00, listWords@H00, namesFor@H00, parse@H00, realism@H00, refName@H00, refusal@H00, remap@H00, resolveComfyMarkers@H00, toMarkers@H00
- **H10** 2390-2524 (135) runProvider: uses from other sections: AREA_RECIPE_CHANGED@H00, AREA_STOPPED_API@H00, NOT_SENT@H00, RUN_GOING@H00, SMALL_PX@H00, answeredSeed@H00, areaHint@H00, finishResultAsync@H00, frameOf@H00, notesKind@H00, prepareCropAsync@H00, promptMissing@H00, providerEdit@H00, refusal@H00, runIdOf@H00, sameRecipe@H00, selectionBox@H00, sentTexts@H00, smallBox@H00, smallBoxes@H00, smallNote@H00, viaLine@H00
- **H11** 2525-2891 (367) upscale (factor, refusals, runUpscale, landWholePicture, runComfyUpscale, button): uses from other sections: CANVAS_LIMIT_WORDS@H00, RUN_GOING@H00, answeredSeed@H00, bytesToImage@H00, canvasBytes@H00, canvasFits@H00, comfyprompt@H00, failKind@H00, finishResultAsync@H00, fitInCanvas@H00, largestFactor@H00, notesKind@H00, planFrame@H00, prepareCropAsync@H00, providerEdit@H00, refusal@H00, runIdOf@H00, upscaleWords@H00, viaLine@H00
- **H12** 2892-3023 (132) runGenerate: uses from other sections: HINT_NOTE@H00, bytesToImage@H00, genpresets@H00, hasTokens@H00, promptMissing@H00, providerEdit@H00, referenceBytes@H00, refusal@H00, runIdOf@H00, smallBoxes@H00, smallNote@H00, textOptions@H00, transparentPixels@H00
- **H13** 3024-3167 (144) prompt templates, brush tips, generate-new hooks, uploadResult: uses from other sections: SUBFOLDER@H00, api@H00, referencesRule@H00, referencesText@H00
- **H14** 3168-3420 (253) provider runs, run rows, tracking, progress events, uploadInput: uses from other sections: SUBFOLDER@H00, api@H00, areaState@H00, bytesToImage@H00, canvasBytes@H00, notesKind@H00, promptMissing@H00, providerEdit@H00, runEachArea@H00, runIdOf@H00, runSplitLayers@H00, viaLine@H00
- **H15** 3421-3639 (219) ComfyUI picture runs (comfyPictureRun, events, cancel): uses from other sections: api@H00, realism@H00
- **H16** 3640-3997 (358) Realism Pass (passPicture, realismWhole): uses from other sections: bytesToImage@H00, canvasBytes@H00, failKind@H00, mosaicPixels@H00, objectId@H00, realism@H00, refusal@H00
- **H17** 3998-5037 (1040) key green/blue screen (in-app engine stub, Route B ComfyUI, landKey): uses from other sections: KEY_BAND_ROWS@H00, KEY_MASK_RGB@H00, bytesSource@H00, canvasBytes@H00, failKind@H00, keyGreyRgba@H00, keyHelper@H00, keying@H00, readPng@H00, realism@H00, refineBandPlan@H00, refusal@H00
- **H18** 5038-5403 (366) relightWhole: uses from other sections: INTERACTIVE@H00, RUN_GOING@H00, applyFilter@H00, bytesToImage@H00, canvasBytes@H00, detailRatio@H00, editorPool@H00, failKind@H00, glToCanvas@H00, lightsToWords@H00, loraPercent@H00, objectId@H00, providerEdit@H00, realism@H00, refusal@H00, runIdOf@H00
- **H19** 5404-5760 (357) queueGenerate, state refs, ensureOnServer: uses from other sections: AREA_RECIPE_CHANGED@H00, AREA_STOPPED@H00, RUN_GOING@H00, api@H00, areaHint@H00, aspectOf@H00, boxesSchema@H00, comfyprompt@H00, genpresets@H00, kleinRun@H00, listWords@H00, loraWords@H00, notesKind@H00, promptMissing@H00, realism@H00, refName@H00, refusal@H00, sameRecipe@H00, sentTexts@H00, spliceLoras@H00, trimSlots@H00, viaLine@H00
- **H20** 5761-5962 (202) workflowForPng, buildGenerateExtras, setNodeParam, saveExport, changed, bundle, saveAll, file refs: uses from other sections: API_SIZES@H00, CLOSED_MAX@H00, SAVE_PIECE@H00, areasSoon@H00, docMeta@H00, hashString@H00, markStep@H00, withoutSecrets@H00
- **H21** 5963-6282 (320) documents: save/open, dirty, closed tabs: uses from other sections: CLOSED_MAX@H00, STATE_KEYS@H00, dialogs@H00, docMeta@H00, documentQuestion@H00, fmtMB@H00, hashString@H00, normPath@H00, refusal@H00
- **H22** 6283-6948 (666) helpers: LLMs, SAM2 objects, cutout, segment, depth, freeHelpers: uses from other sections: DEPTH_LARGE@H00, INTERACTIVE@H00, RUN_GOING@H00, editorPool@H00, failKind@H00, fusedSize@H00, modelSize@H00, referenceName@H00, roundHalfEven@H00, tileBoxes@H00
- **H23** 6949-7100 (152) server event wiring (top-level statements), markLanded, localRunEnded: uses from other sections: SHAPE_ERROR@H00, api@H00, host@H01, kleinEncoderHint@H00, realism@H00, upsampledNote@H00

Cross-section writes to top-level `let` (break on a move: an import is read-only): none.


**host.js seams.** Best candidates by size and isolation: H17 keying (3998-5035, 1,040 lines, 45 properties; reads
KEY_BAND_ROWS, KEY_MASK_RGB, keyGreyRgba, keyHelper from the helpers, which can move with it), H22 helpers (6283-6946,
666), H07 presets + LoRAs (1530-1899, 378), H16 Realism Pass + H18 relightWhole (3640-3993, 5038-5396, 720), H11
upscale (2525-2881, 367), H21 documents (5963-6272, 320, with `documentQuestion`, `normPath`, `docMeta`,
`hashString`, `fmtMB`, `STATE_KEYS`), H04 export (932-1265, 335). The helpers block H00 (29-446) splits by the same
subjects (Klein 289-363, key 394-410, export 100-127, documents 145-235).

**Hard constraints for host.js** (each breaks on a plain spread):
- `tools/build_node.py:120-124` `host_members()` takes the app's host members as every line matching
  `^    (?:async\s+)?NAME\s*(?:\(|:)` **in host.js** from `export const host = {` to the end of the file
  (`HOST_KEY`, :107). A member that moves into another file is no longer found, and `--check` then reports "the
  editor calls host.X, which renderer/editor/host.js does not have" (:169-170) for every editor-used member in it.
  Either keep members the editor calls in host.js, or teach `host_members()` to read the spread parts too (a tool
  change, which item 56 should do once, with a test).
- `tools/quit_test.js:485-490` reads host.js by path and matches bodies by `\n    saveAll() `, `\n    async restore(saved) `,
  `\n    bundle() ` (H20 5914, H06 1473, H20 5900).
- `tools/comfyrouter_test.js:965-969` reads host.js by path for `^const HINT_NOTE = /.../;$` (41).
- `tsconfig.check.json` `include` names `renderer/editor/host.js` alone; a part moved out is type-checked only if its
  file is added there and starts with `// @ts-check` (the file says the list "only grows, and a file joins it when it
  is clean"). `types/contracts.js:11-21` imports `api, host` and the `EditorApi` / `EditorHost` typedefs from this
  path: they stay here (or are re-exported).
- host.js is app-only (not in `FILES`, the node has its own `js/host.js`), so its parts need no node build; but
  `plugins/glb/main.js:15` imports `{ api }` from `/editor/host.js` and every test imports `host`/`api` from this path:
  both stay exported here.
- Page-level side effects at evaluation (6951 `window.scumble.comfy.onEvent`, the listeners): host.js already has
  them (it is app-only, so the node rule of docs/BUILD_NODE.md:88 does not bind it); keep them in host.js.

---------------------------------------------------------------------------------------------------------------------

## 3. renderer/shell.js (3,582 lines, ES module, not type-checked)

A script-like module: 391 top-level statements: 164 wiring statements (140 `ExpressionStatement`, 11 `IfStatement`,
8 `TryStatement`, 5 `for...of`) interleaved with the functions they wire, 143 functions (41 async), 34 `let`, 30
`const`, 19 imports, 1 export list. Imports 4-27 (`host, api` from `./editor/host.js`; `InpaintEditor, STYLE as EDITOR_STYLE`; commands,
plugins, assistant, help, skins, dialogs, prompt_field, reftokens, realism, comfyprompt, genpresets, inpaint_status,
easteregg). Exports: inline `showKeysNote` 862, `keysNote` 874, `openGenerateNew` 1502, `upFactors` 1681,
`openUpscale` 1924, `memoryReads` 2405, `renderUpdate` 2572, `releasePage` 2598, `updateLinks` 2605,
`updateQuestionDetail` 2642, `announceUpdate` 2674, `skipUpdate` 2729, `menuCommand` 3205, `cloudJobs` 3333,
`copySavedLoras` 3374; list at 3582: `newDocument, activate, closeDocument, canvasOnly, isCanvasOnly, openSettings,
openConsole, selectRecipe, loadRecipes, importRecipe, testConnection, connect, commands, plugins, watchMemory,
cardMemory, cardShortfall, saveBeforeRestart, recoverCloudResults` (tests use these through `import('./shell.js')`).

Sections (contiguous; each with the names it uses from other sections, `name@section`):

- **S00** 1-139 (139) imports, ipc kind, $, ui map, module state lets: uses from other sections: refPicturesOn@S01
- **S01** 140-334 (195) atlas/history settings, tabs: newDocument, activate, renderTabs, closeDocument, reopen, cycle: uses from other sections: InpaintEditor@S00, addCloudMode@S03, dialogs@S00, failKind@S00, forgetDocument@S00, genField@S06, genPresetOf@S06, genSyncRefs@S06, host@S00, modeOf@S03, newCanvasChoices@S06, newCanvasChosen@S06, openGenerateNew@S06, openSettings@S12, openUpscale@S07, providerKeyState@S03, providers@S03, recipes@S03, resolveRecipe@S03, saveDocumentFromUi@S15, selectRecipe@S03, settings@S00, ui@S00
- **S02** 335-441 (107) status line, auth rows, connect, testConnection, recipe model report: uses from other sections: activate@S01, comfyButton@S18, host@S00, lastProbe@S00, lastStatus@S00, newDocument@S01, recipes@S03, settings@S00, ui@S00
- **S03** 442-787 (346) Settings > Recipes: load/select/resolve recipes, provider choice, grouped recipe list, import: uses from other sections: $@S00, cloudGraphOf@S18, dialogs@S00, failKind@S00, host@S00, openRecipeInComfy@S18, settings@S00, ui@S00
- **S04** 788-955 (168) Settings > API providers: keys, keys note, compat LLM server: uses from other sections: host@S00, providers@S03, selectRecipe@S03, settings@S00, settingsGroup@S03, ui@S00
- **S05** 956-1091 (136) Settings > Models (LLM upsample models): uses from other sections: host@S00, refreshAssistantModels@S00, settings@S00, ui@S00
- **S06** 1092-1658 (567) Generate new dialog (genpresets, sizes, aspects, refs) and New canvas choices: uses from other sections: PromptField@S00, RefBar@S00, activate@S01, checkNote@S00, chosenProvider@S03, cloudModeOf@S03, commands@S00, compare@S00, docName@S01, genpresets@S00, host@S00, modeOf@S03, normalizeTokens@S00, providerLabel@S03, providerOptionLabel@S03, providers@S03, recipes@S03, referencesRule@S00, referencesText@S00, remap@S00, resolveRecipe@S03, selectRecipe@S03, settings@S00, ui@S00
- **S07** 1659-1981 (323) Upscale dialog: uses from other sections: activate@S01, chosenProvider@S03, comfyprompt@S00, commands@S00, failKind@S00, host@S00, providerLabel@S03, providerOptionLabel@S03, providers@S03, realism@S00, recipes@S03, selectRecipe@S03, settings@S00, ui@S00
- **S08** 1982-2058 (77) Settings > Prompts (templates): uses from other sections: host@S00, settings@S00, ui@S00
- **S09** 2059-2215 (157) Settings > Helpers: uses from other sections: dialogs@S00, fmtBytes@S11, host@S00, ui@S00
- **S10** 2216-2323 (108) Settings > Plugins; provider timer, cancel button: uses from other sections: $@S00, api@S00, host@S00, plugins@S00, reloadSkins@S00, renderTabs@S01, ui@S00
- **S11** 2324-2425 (102) GPU memory watch, file stats: uses from other sections: busy@S01, host@S00, ui@S00
- **S12** 2426-2545 (120) Settings > Generations; openSettings: uses from other sections: dialogs@S00, fmtBytes@S11, glFiltersAvailable@S00, historyDepth@S01, host@S00, lastStatus@S00, loadProviders@S04, plugins@S00, refPicturesOn@S01, refreshFileStats@S11, refreshGpuMemory@S11, renderAppearance@S00, renderCompat@S04, renderHelpers@S09, renderModels@S05, renderPlugins@S10, renderPrompts@S08, renderProviders@S04, renderRecipeList@S03, renderTileMode@S15, renderUpdate@S13, settings@S00, syncAuthRows@S02, ui@S00, wholeMB@S14
- **S13** 2546-2768 (223) updates: text, dialog, skip, install: uses from other sections: assistantActivity@S00, busy@S01, dialogs@S00, host@S00, settings@S00, ui@S00, userBusy@S00
- **S14** 2769-2867 (99) star / share note, About bits: uses from other sections: applyAtlasBudget@S01, applyHistoryDepth@S01, historyDepth@S01, host@S00, renderUpdate@S13, resetAssistant@S00, settings@S00, ui@S00, updateAction@S13
- **S15** 2868-3093 (226) Settings > tile mode; saveBeforeRestart; document save/open UI; pending documents: uses from other sections: REPO_URL@S14, busy@S01, canvasOnlyState@S00, dialogs@S00, host@S00, ipcKind@S00, leaveCanvasOnly@S16, openInto@S01, renderTabs@S01, settings@S00, ui@S00, windowFullScreen@S00
- **S16** 3094-3249 (156) canvas-only view; menuCommand: uses from other sections: $@S00, activate@S01, applySkin@S00, assistantOpen@S00, canvasOnlyState@S00, closeDocument@S01, cycleTab@S01, failKind@S00, helpOpen@S00, host@S00, importRecipe@S03, newDocument@S01, openConsole@S19, openRecipeInComfy@S18, openSettings@S12, openUpscale@S07, plugins@S00, realism@S00, reloadSkins@S00, reopenClosedTab@S01, saveDocumentFromUi@S15, toggleAssistant@S00, toggleHelp@S00, ui@S00, windowFullScreen@S00
- **S17** 3250-3332 (83) command requests, startup sequence: uses from other sections: activate@S01, commands@S00, dialogs@S00, docSummary@S00, editorOf@S00, host@S00, initSkins@S00, loadProviders@S04, loadRecipes@S03, newDocument@S01, openPendingDocuments@S15, plugins@S00, selectRecipe@S03, settings@S00, snapshotTurn@S00, takesPending@S15, waitForUser@S00
- **S18** 3333-3503 (171) cloud jobs, title-bar buttons, LoRA copy, cloud results, open recipe in ComfyUI: uses from other sections: $@S00, docName@S01, failKind@S00, host@S00, initAssistant@S00, initHelp@S00, loadRecipes@S03, newDocument@S01, openSettings@S12, recipes@S03, renderRecipeList@S03, selectRecipe@S03, showStatus@S02, toggleAssistant@S00, toggleHelp@S00, ui@S00, watchUserEdits@S00
- **S19** 3504-3582 (79) log console; export list: uses from other sections: activate@S01, canvasOnly@S16, cardMemory@S11, cardShortfall@S11, closeDocument@S01, commands@S00, connect@S02, host@S00, importRecipe@S03, isCanvasOnly@S16, loadRecipes@S03, newDocument@S01, openSettings@S12, plugins@S00, recoverCloudResults@S18, saveBeforeRestart@S15, selectRecipe@S03, testConnection@S02, ui@S00, watchMemory@S11

Cross-section writes to top-level `let` (break on a move: an import is read-only):
- `lastStatus` (declared S00 @123): written in S02:340
- `settings` (declared S00 @122): written in S02:378, S03:532, S03:561, S05:970, S06:1543, S07:1958, S08:2002, S08:2036, S12:2472, S13:2732, S14:2796, S14:2806, S14:2811, S14:2828, S14:2840, S14:2845, S14:2850, S14:2857, S15:2894
- `lastProbe` (declared S00 @124): written in S02:396
- `providers` (declared S03 @443): written in S04:789, S06:1191, S06:1193, S06:1195
- `windowFullScreen` (declared S00 @128): written in S15:3082, S15:3084
- `canvasOnlyState` (declared S00 @127): written in S16:3111, S16:3134
- `takesPending` (declared S15 @3048): written in S17:3323


**The Settings dialog is not one block.** `openSettings` is at 2471-2524 (S12) and calls the panels' renderers
spread over S02 (`syncAuthRows` 363), S03 (`renderRecipeList` 656), S04 (`loadProviders` 788, `renderProviders` 792,
`renderCompat` 889), S05 (`renderModels` 976), S08 (`renderPrompts` 1982), S09 (`renderHelpers` 2061), S10
(`renderPlugins` 2216), S11 (`refreshGpuMemory` 2406, `refreshFileStats` 2417), S13 (`renderUpdate` 2572), S14
(`wholeMB` 2798), S15 (`renderTileMode` 2868). Together about 1,700 lines of the file.

**Blocker: shared mutable `let`s.** An ES import is read-only, so these cannot move apart from their writers
without a state object or setter functions (a text change, not a pure move):
- `settings` (122) is reassigned in 19 places across S02, S03, S05-S08, S12-S15 (e.g. 378, 532, 561, 970, 1543,
  1958, 2002, 2036, 2472, 2732, 2796-2857, 2894).
- `providers` (S03, 443) is written in S04 (789) and S06 (1191-1195); `recipes` (442) only in S03.
- `lastStatus` 123 / `lastProbe` 124 written in S02 (340, 396); `canvasOnlyState` 127 in S16 (3111, 3134);
  `windowFullScreen` 128 in S15 (3082, 3084); `takesPending` (S15, 3048) in S17 (3323).
Sections with no cross-section write and few inbound names (easiest): S07 Upscale dialog (1659-1981), S06 Generate
new (1092-1658, but writes `settings` and `providers`), S09 Helpers (2059-2215), S11 GPU memory (2324-2425), S13
updates (2546-2768), S19 log console (3504-3582).

**Tests that read shell.js as text:** `tools/ark_test.js:332-333` (`const GEN_ASPECTS = [...]`, S06 1092),
`tools/genpresets_test.js:43-44` (`GEN_ASPECTS`, `GEN_RESOLUTIONS`, S06 1092-1093), `tools/quit_test.js:474-482`
(`window.scumble.state.onFlush(async (reason) => `, `startMode = await window.scumble.state.startMode()`,
`const saved = startMode === "safe" ? ...`, `async function saveBeforeRestart(say = () => {}, when = "the restart") `:
S15/S17), `tools/skins_test.js:193` + `:302` (`shellJsBits`: the line with `recipeNote.style.color`, shell.js:556 in
`selectRecipe`, S03, is the file's **only** `var(--sc-*)`; the census at skins_test.js:302-304 fails "no var(--sc-*)
at all in renderer/shell.js" if it moves out).

---------------------------------------------------------------------------------------------------------------------

## 4. renderer/commands.js (3,171 lines, ES module, `// @ts-check`)

Imports 17-33 (`api, host`; from inpaint_canvas.js `viewUrl, loadImageEl, makeCanvas, BRUSH_MAX, BLEND_MODES,
RELIGHT_STYLES, RELIGHT_LIGHT_TYPES`; filters, weights, relight, text, reftokens, realism, keying, genpresets,
comfyprompt, status, sizelimit, loras, lora_panel, eacharea, splitlayers). Helpers 35-901; typedefs `ParamFn` 589,
`CommandParam` 842, `Command` 857, `CommandDescriptor` 872, `CommandCore` 887 (read by `types/contracts.js:25-28`);
**`const COMMANDS = {` 903-2919** (99 commands, each an object literal; no methods directly on COMMANDS); tail
2922-3169 (`setFont`, `checkParams` 2935 (export), `applyParams` 2988 (export), `writeParams`, `filterStepLabel`,
`withExportPath`, `appInfo`, `describe` 3052 (export), `editorFor`, `newCanvasPreset` 3082, `aspectParts`,
`aspectText`, `sizeForAspect`, **`export const commands = {` 3142-3169** (version, names, has, describe, run, call,
register, unregister)). Other exports: `docSummary` 55, `layerSummary` 76, `findGroup` 145, `groupSummary` 155,
`findLayer` 159, `touch` 189, `shotCanvas` 210, `bounds` 313, `status` 367. Importers: `renderer/shell.js:8`,
`renderer/plugins.js:11` {commands, findLayer, layerSummary, touch, bounds}, `renderer/splitdialog.js:6`,
`types/contracts.js:12`, many tests by path.

COMMANDS, by group (property start lines): documents/recipes/plugins `ping` 905 .. `status` 1102; `new_canvas` 1116,
`load_image` 1149, `add_image_layer` 1170; selection `select_rect` 1192 .. `select_range` 1363; generation settings
`set_prompt` 1399 .. `upsample_prompt` 1530; runs `generate_new` 1545 (84 lines), `upscale` 1629, `realism_pass`
1683, `key_screen` 1707, `split_layers` 1757, `relight` 1786 (128), `generate` 1914, `cancel_run` 1964; layers
`list_layers` 2011 .. `set_mask` 2308; filters `filter_types` 2340, `add_filter` 2379, `set_filter` 2401; text
`add_text` 2432, `set_text` 2461; history `undo` 2486 .. `compare` 2540; canvas `extend_canvas` 2541 ..
`resize_image` 2615; export `export` 2657, `export_layer` 2679, `export_mask` 2685, `screenshot` 2691; depth
`depth_map` 2712 .. `depth_from_layer` 2818; misc `get_state` 2840, `set_status` 2841, `read_log` 2853,
`list_brush_tips` 2868, `set_brush` 2877.

Sections and their cross-references:

- **C00** 1-34 (34) imports: uses from other sections: none
- **C01** 35-202 (168) small utils, docSummary, layerSummary, refs report, findGroup/findLayer, touch: uses from other sections: host@C00, parse@C00, remap@C00
- **C02** 203-366 (164) shotCanvas, maskShot, bounds, generateEachArea, fileFrom: uses from other sections: clampInt@C01, findLayer@C01, host@C00, layerSummary@C01, makeCanvas@C00, refusal@C00, viewUrl@C00
- **C03** 367-591 (225) status(), target views, realism/key state, recipe readiness, LoRA views, memory: uses from other sections: MAX_LORAS@C00, bounds@C02, clampInt@C01, clampStrength@C00, cropView@C04, docName@C01, genpresets@C00, host@C00, lacksNodesText@C00, layerSummary@C01, loraHint@C00, missingLoras@C00, normalizeName@C00, recipeFamily@C00, refusal@C00
- **C04** 592-902 (311) param tables P, selection modes, text spacing, relight model, crop/setting rows, transform points, FILE_PARAMS: uses from other sections: RELIGHT_LIGHT_TYPES@C00, RELIGHT_STYLES@C00, host@C00, makeCanvas@C00
- **C05** 903-1115 (213) COMMANDS: ping .. status (documents, recipes, LoRAs, plugins): uses from other sections: AREA_CAP@C00, FAMILIES@C00, P@C04, REALISM_LABEL@C00, VERSION@C01, api@C00, appInfo@C15, clampInt@C01, describe@C15, docSummary@C01, documentMax@C03, filterNames@C00, folderFits@C00, groupByFolder@C00, host@C00, layerSpecOf@C00, loadNotes@C01, loraFolder@C00, loraHint@C00, lorasView@C03, memoryMB@C03, recipeFamily@C00, recipeReadiness@C03, serverUp@C03, status@C03
- **C06** 1116-1191 (76) COMMANDS: new_canvas, load_image, add_image_layer: uses from other sections: FILE_PARAMS@C04, P@C04, clampInt@C01, fileFrom@C02, host@C00, layerSummary@C01, newCanvasPreset@C15, requireImage@C01, touch@C01
- **C07** 1192-1398 (207) COMMANDS: select_*: uses from other sections: P@C04, SEL_MODES@C04, bounds@C02, clampInt@C01, findLayer@C01, host@C00, loadImageEl@C00, makeCanvas@C00, normalizeLimit@C00, pointList@C04, selMode@C04, touch@C01, until@C01
- **C08** 1399-1544 (146) COMMANDS: set_prompt .. upsample_prompt: uses from other sections: CROP_FILLS@C04, CROP_KEYS@C04, EXTEND_FILLS@C04, MAX_LORAS@C00, P@C04, agentRefs@C01, clampInt@C01, cropValue@C04, cropView@C04, host@C00, loraPanel@C00, lorasFromCall@C03, presetSummary@C04, refsReport@C01, settingRow@C04, until@C01
- **C09** 1545-2010 (466) COMMANDS: generate_new, upscale, realism_pass, key_screen, split_layers, relight, generate, cancel_run: uses from other sections: AREA_CAP@C00, COMMANDS@C05, LIGHT_PRESETS@C00, P@C04, REALISM_LABEL@C00, RELIGHT_FROM_LIGHTS@C04, RELIGHT_LIGHT_TYPES@C00, RELIGHT_MODEL@C04, RELIGHT_ROUTES@C00, RELIGHT_STYLES@C00, SPLIT_COUNT_DEFAULT@C00, SPLIT_TIERS@C00, agentRefs@C01, api@C00, applyLightPreset@C00, aspectText@C15, bounds@C02, checkParams@C15, clampInt@C01, defaultLight@C00, filterStepLabel@C15, findLayer@C01, generateEachArea@C02, groupSummary@C01, host@C00, keying@C00, lacksNodesText@C00, layerSummary@C01, normalizeLights@C00, rectMask@C02, refusal@C00, relightModel@C04, sizeForAspect@C15, targetSize@C03, touch@C01, until@C01, wait@C01, writeParams@C15, writeRelightModel@C04, writeTarget@C03
- **C10** 2011-2339 (329) COMMANDS: layers (list_layers .. set_mask): uses from other sections: BLEND_MODES@C00, MASK_OPS@C04, P@C04, TRANSFORM_MODES@C04, clampInt@C01, findGroup@C01, findLayer@C01, groupSummary@C01, host@C00, layerSummary@C01, mergedClip@C04, pendingSize@C04, pointList@C04, refuseLayer@C01, touch@C01, until@C01
- **C11** 2340-2485 (146) COMMANDS: filters and text: uses from other sections: FILTERS@C00, P@C04, TEXT_LINE_HEIGHT_TEXT@C04, TEXT_SPACING_TEXT@C04, checkParams@C15, filterStepLabel@C15, findLayer@C01, layerSummary@C01, setFont@C15, textSpacing@C04, touch@C01, writeParams@C15
- **C12** 2486-2540 (55) COMMANDS: undo/redo/history/snapshots/compare: uses from other sections: P@C04, touch@C01
- **C13** 2541-2711 (171) COMMANDS: canvas geometry, export, screenshot: uses from other sections: P@C04, SHOT_WHAT@C02, canvasSizeRefusal@C00, docName@C01, findLayer@C01, host@C00, refusal@C00, shotCanvas@C02, withExportPath@C15
- **C14** 2712-2919 (208) COMMANDS: depth, get_state, status/log, brush tips, set_brush: uses from other sections: BRUSH_MAX@C00, COMMANDS@C05, P@C04, clampInt@C01, findLayer@C01
- **C15** 2920-3171 (252) setFont, checkParams/applyParams/writeParams, describe, editorFor, new-canvas presets, commands object: uses from other sections: COMMANDS@C05, FILTERS@C00, P@C04, RELIGHT_ROUTES@C00, VERSION@C01, docSummary@C01, fontList@C00, genpresets@C00, host@C00, normalizeLights@C00, normalizeLimit@C00, requireImage@C01

Cross-section writes to top-level `let` (break on a move: an import is read-only): none.


**commands.js seams.** COMMANDS can become `const COMMANDS = { ...DOC_COMMANDS, ...SELECT_COMMANDS, ... }` with each
group in its own module (plain named `export const`), **spread in today's order**: the key order is the order of
`describe()` (3052), `list_commands`, the MCP tool list and `docs/COMMANDS.md` (`tools/commands_doc.py` builds it from
`commands.describe()` at runtime, :123). C09 (runs, 466 lines) and C14 (2712-2919) read `COMMANDS` itself (a command
calling another): a group module that imports COMMANDS from commands.js is in a cycle and may read it only inside a
`run` (never at its top level); the spread evaluates the group's `const` at commands.js's evaluation, so the group
modules must be evaluated first (commands.js imports them; they must not be the entry: they are app-only, loaded
only through commands.js, so that holds). The helper blocks C01-C04 and C15 are shared by most groups: move them to
a `commands_util.js` first. Typedefs `Command`, `CommandParam`, `CommandDescriptor`, `CommandCore`, `ParamFn` stay in
commands.js (types/contracts.js:25-28 import them from this path). A new file is checked by `npm run types` only if
added to `tsconfig.check.json` `include` with `// @ts-check`. No test reads commands.js as text (grep of tools/).

---------------------------------------------------------------------------------------------------------------------

## 5. electron/main/recipes.js (1,955 lines, CommonJS, `// @ts-check`)

Requires 9-13 (`node:path`, `node:fs/promises`, `{ app }` from `electron`, `./providers/refs`); typedefs 15-231
(`SettingRow` 29, `ShippedPreset` 42, `EditLimits` 53, `UpscaleFactor` 69, `TextShape` 81, `LoraDecl` 100, `TextRefs`
109, `ProviderVariant` 120, `Recipe` 142, `LocalUpsampler` 194, `UpsamplerRequest` 210, `LocalBoxes` 226) with
`PASS_LABEL` 48; `module.exports = { list, remove, save, importFile, fromWorkflow, fromPrompt, toPrompt, fromGraph,
fromCloudGraph, cloudMark, detectRoles, promotedOf, detach, userDir, _normalize: normalize }` at 1955. Required by
`electron/main/main.js:46` and by tests (`tools/*_test.js` through `require(path.join(ROOT, "electron", "main",
"recipes.js"))`, several inside a `Module._load` stub for `electron`, e.g. `tools/comfyprompt_test.js:43-48`,
`tools/ark_test.js:695-701`).

Declarations: `FIXED_OUTPUTS` 232, `SETTING_SLOTS` 233, `TAIL_OUTPUTS` 241, `PROMPT_SLOT` 242, `LOCAL_BOX_SCHEMAS`
245, `MOSS_LAYOUT` 246, `backendOutputName` 249, `tailOutputs` 260, `WIDGET_TYPES` 280, `SKIP_TYPES` 281,
`UI_WIDGETS` 283, `userDir` 285, `SAFE_ID` 291, `safeId` 292, `readId` 295, `readDir` 303, `TEXT_PROVIDERS` 328,
`TEXT_NAMED` 331, `TEXT_SIZES` 337, `TEXT_SIZES_DEFAULT` 341, `LIMITS_DEFAULT` 352, `editLimits` 359,
`FACTOR_DEFAULT` 383, `upscaleFactor` 390, `comfyFactor` 410, `comfyLimits` 428, `textModelOf` 436, `textVariant`
448, `textAspectsOf` 473, `textRefsOf` 494, `refsOf` 521, `comfyRefs` 536, `localBoxes` 563, `localUpsampler` 594,
`localNewImage` 657, `withoutUpsampler` 676, `lorasOf` 700, `normalize` 725-831, `shippedPresets` 839, `list` 861,
`remove` 869, `save` 882, `slug` 894, `readWidgets` 907, `storedSpec` 934, `specDefault` 941, `fromWorkflow`
964-1175, `CANVAS_PARAMS` 1179, `toPrompt` 1187, `fromPrompt` 1210, `GRAPH_KEEPS` 1256, `fromGraph` 1266,
`cloudMark` 1321, `markedInput` 1332, `fromCloudGraph` 1347-1484, `sizeTargets` 1494, `OUTPUT_ONLY` 1526,
`RESULT_NODES` 1527, `naturally` 1528, `promotedOf` 1536, `detectRoles` 1573-1720, `holdsCanvas` 1723,
`CANVAS_OUTPUTS` 1732, `DETACH_VALUES` 1733, `DETACH_DEFAULTS` 1734, `detach` 1752-1855, `hasVariants` 1858,
`looksLikePrompt` 1863, `userFileStems` 1868, `importFile` 1880-1953.

Sections and their cross-references (no top-level `let`; all plain functions, so option (a) applies everywhere):

- **R00** 1-231 (231) header, requires, recipe typedefs (JSDoc), PASS_LABEL: uses from other sections: none
- **R01** 232-327 (96) node output constants, tailOutputs, widget types, userDir, readDir: uses from other sections: app@R00, fsp@R00, normalize@R02, path@R00
- **R02** 328-860 (533) normalize() and its variant helpers (text, limits, factors, refs, boxes, upsampler, LoRAs), shippedPresets: uses from other sections: LOCAL_BOX_SCHEMAS@R01, MOSS_LAYOUT@R01, PROMPT_SLOT@R01, REF_NAME_DEFAULT@R00, list@R03, validRefName@R00
- **R03** 861-906 (46) list, remove, save, slug: uses from other sections: fsp@R00, path@R00, readDir@R01, safeId@R01, userDir@R01
- **R04** 907-1178 (272) readWidgets, storedSpec, specDefault, fromWorkflow (UI graph import): uses from other sections: FIXED_OUTPUTS@R01, SKIP_TYPES@R01, UI_WIDGETS@R01, WIDGET_TYPES@R01, backendOutputName@R01, tailOutputs@R01
- **R05** 1179-1320 (142) CANVAS_PARAMS, toPrompt, fromPrompt, fromGraph: uses from other sections: FIXED_OUTPUTS@R01, backendOutputName@R01, localBoxes@R02, looksLikePrompt@R08, lorasOf@R02, shippedPresets@R02, slug@R03, specDefault@R04, storedSpec@R04, tailOutputs@R01
- **R06** 1321-1493 (173) cloudMark, markedInput, fromCloudGraph: uses from other sections: LIMITS_DEFAULT@R02, REF_NAME_DEFAULT@R00, RESULT_NODES@R07, detectRoles@R07, looksLikePrompt@R08, promotedOf@R07, save@R03, sizeTargets@R07, slug@R03
- **R07** 1494-1857 (364) sizeTargets, promotedOf, detectRoles, holdsCanvas, detach: uses from other sections: FIXED_OUTPUTS@R01, LIMITS_DEFAULT@R02, PASS_LABEL@R00, REF_NAME_DEFAULT@R00, list@R03, looksLikePrompt@R08, lorasOf@R02, save@R03, withoutUpsampler@R02
- **R08** 1858-1955 (98) hasVariants, looksLikePrompt, userFileStems, importFile, module.exports: uses from other sections: cloudMark@R06, detach@R07, detectRoles@R07, fromCloudGraph@R06, fromGraph@R05, fromPrompt@R05, fromWorkflow@R04, fsp@R00, holdsCanvas@R07, list@R03, normalize@R02, path@R00, promotedOf@R07, remove@R03, save@R03, slug@R03, toPrompt@R05, userDir@R01

Cross-section writes to top-level `let` (break on a move: an import is read-only): none.


**recipes.js seams:** R02 normalize + variant helpers (328-860, 533 lines) as `recipes_normalize.js`; R04 UI-graph
import (907-1178, 272); R05 + R06 prompt / graph / Comfy Cloud conversions (1179-1493, 315); R07 roles and detach
(1494-1857, 364). Constraints: CommonJS `require` cycles return a partial `exports` object (R02 reads `list` from R03;
R06/R07 read `save`/`list` from R03; R05-R07 read `looksLikePrompt` from R08): split so the leaves (R01 constants,
R03 storage, `looksLikePrompt`) are required by the others, not the reverse. `tools/comfyprompt_test.js:67-70` reads
recipes.js by path for `const CANVAS_OUTPUTS = [...];` (1732, R07). `importFile` (1885) resolves the shipped folder
with `path.join(__dirname, "..", "..", "recipes")`: a move to a subfolder changes that path. `userDir` (285-287) calls
`app.getPath`: tests stub `electron` with `Module._load` only while `recipes.js` is required (e.g.
`tools/comfyprompt_test.js:43-48`), so a part that requires `electron` lazily, or is cached from an earlier stub
(`require.cache`), gets the wrong `app`. The typedefs (15-231) are what `tsconfig.check.json` checks `normalize()`
against; a part with `normalize` needs `// @ts-check` and an `include` entry, and its `@typedef` imports
(`import("./recipes.js").Recipe`). `PASS_LABEL` (48) must match `renderer/editor/realism.js` LABEL (comment at 47;
`tools/recipes_test.js:513` checks the recipe's name against `realism.LABEL`).

---------------------------------------------------------------------------------------------------------------------

## 6. Constraints, with evidence

**tools/build_node.py (the node build; docs/BUILD_NODE.md):**
- `FILES` (`tools/build_node.py:39-47`) is the explicit list of editor modules copied into the node's `js/`. A new
  module split out of inpaint_canvas.js must be added, or the node's import check fails ("imports from ./x.js, which
  is not there", :152-153) and the node breaks. Not needed for host.js, shell.js, commands.js, recipes.js (app-only;
  host.js is in `NODE_OWN` on the node side, :49).
- `--check` (:187-203): every `FILES` entry in the node's `js/` must equal its generated text, fonts and `px.wasm`
  equal, and the node's DEVELOPMENT.md must carry the tree hash; then `check_dir` (:132-160): each `js/` module
  parses as a module (`node --input-type=module --check`, :127-129), every `import { ... } from "./x"` resolves to an
  export of the target (`IMPORT_NAMED` :103, `EXPORT_DECL` :101 `^export (async)? function|class|const|let|var`,
  `EXPORT_LIST` :102 `^export {...}`; so **use `export const/function` or an export list, not `export default`**; a
  `import * as` is not resolved and not checked), and a module that uses `host.` must import `host` from `./host.js`
  (:145-148). `check_host` (:163-171) collects `host.<member>` (`HOST_USE` :106, a plain regex, comments included:
  docs/BUILD_NODE.md:19 says the boxes modules may not contain the text `host.` even in comments) over `FILES` only,
  and every member must exist in both hosts (node `js/host.js`, app `renderer/editor/host.js` via `host_members`
  :120-124). A moved editor method keeps its `host.X` visible only if its new file is in `FILES`.
- The gate `nodecopy` runs build_node.py + node_test.py on a scratch copy of the node (`tools/run_gates.sh:12-13`).
  docs/BUILD_NODE.md:84-99: no page-level side effects at import in `renderer/editor/`, and the existing cycle
  (inpaint_canvas.js <-> inpaint_jobs.js, inpaint_encode.js, inpaint_modal.js) is safe only because nothing reads
  another module's binding while it evaluates; that note says it was "checked with a scope walk and a Node run of
  all four entry orders" and `node_test.py` loads only inpaint_canvas.js first. Every new module in the cycle needs
  the same check.

**Circular imports today (inpaint_canvas.js):** it imports 41 modules (15-56). Of those, `inpaint_jobs.js:13` and
`inpaint_encode.js:14` import `InpaintEditor` back, `inpaint_modal.js:7` imports 12 names back; `inpaint_boxes.js:10`
imports `el` but is not imported by inpaint_canvas.js. host.js imports none of them (so no cycle through host).
`renderer/commands.js` and `renderer/plugins.js` import from inpaint_canvas.js and are not imported by it.

**Lint (`eslint.config.mjs`):** `npm run lint` = `eslint .` (package.json:30). `renderer/**/*.js` are linted as
browser ES modules (:57-65, `files` at :58) with the CORRECTNESS set (:20-34: `no-undef`, `no-import-assign`, `no-const-assign`,
`no-dupe-class-members`, `no-unused-vars` as a warning ...), so any new renderer file is covered automatically;
`electron/**/*.js` and `tools/**/*.js` as CommonJS (:90-95, `files` at :91). The config's own header (:1-5) records that the
2026-09-18 split was caught by `no-import-assign` (a `++` on an imported binding). Ignored: `**/js/inpaint_canvas.js`
(:48, the node build copy) and `.claude/**`.

**Types (`tsconfig.check.json`):** `npm run types` = `tsc --noEmit -p tsconfig.check.json` (package.json:31);
`checkJs` off, `include` is exactly `types/**/*`, `electron/main/recipes.js`, `renderer/commands.js`,
`renderer/editor/host.js`. inpaint_canvas.js and shell.js are not type-checked. Code moved out of the three checked
files stops being checked unless the new file starts with `// @ts-check` and is added to `include`.

**Tests that read these files as source text (they break on a move unless updated):**

| test | file read | what it matches |
|---|---|---|
| `tools/skins_test.js:190,299,616` | inpaint_canvas.js | the STYLE template (regex `\n(?:export )?const STYLE = \`\n`) |
| `tools/skins_test.js:396-401` | inpaint_canvas.js | bodies of `drawBrushRing`, `antsStroke`, `drawMarchingAnts` by `\n    name(` (E72) |
| `tools/skins_test.js:654-659` | inpaint_canvas.js at BASE | colour literals at fixed line numbers (only with a BASE set) |
| `tools/quit_test.js:492-494` | inpaint_canvas.js | `\n    async syncLayersOnce() ` body, `syncLayers() {` (E71) |
| `tools/quit_test.js:485-490` | host.js | `\n    saveAll() `, `\n    async restore(saved) `, `\n    bundle() ` |
| `tools/comfyrouter_test.js:965-969` | host.js | `^const HINT_NOTE = /.../;$` (41) |
| `tools/quit_test.js:474-482` | shell.js | onFlush handler, startMode lines, `saveBeforeRestart` signature |
| `tools/ark_test.js:332-333` | shell.js | `const GEN_ASPECTS = [...]` (1092) |
| `tools/genpresets_test.js:43-44` | shell.js | `GEN_ASPECTS`, `GEN_RESOLUTIONS` (1092-1093) |
| `tools/skins_test.js:193,302-304` | shell.js | the `recipeNote.style.color` line (556), the file's only `var(--sc-*)` |
| `tools/comfyprompt_test.js:67-70` | recipes.js | `const CANVAS_OUTPUTS = [...]` (1732) |
| `tools/build_node.py:120-124` | host.js | host members by 4-space indentation after `export const host = {` |

No test reads commands.js as text. `tools/mutation_round.py` targets `crates/px/src/*.rs` and `tools/px_test.js`
kill sets (:21, :281), not these files; `.claude/coord/tools/*` names none of the five. Tests that **import** these
files by path or URL (`import("./editor/inpaint_canvas.js")`, `import("./editor/host.js")`, `import("./shell.js")`,
`import("./commands.js")`, `require(.../recipes.js)`) keep working as long as every export stays exported from the
same file.

---------------------------------------------------------------------------------------------------------------------

## 7. Open branches that touch the five files (vs `wasm-kernels` 7608dcda, 2026-11-11)

`git branch --list "ag-*" pan-cost minimax`: 41 branches; 35 are ancestors of wasm-kernels (merged: 33 `ag-*`,
`pan-cost` 35da8d8e, `minimax` 72689bbd). Not ancestors:

| branch | tip | ahead / behind | five-file diff (`git diff --stat wasm-kernels...b`) | state |
|---|---|---|---|---|
| `ag-chain-p-9` (K20c) | e35b3a0d | 7 / 0 | `renderer/editor/inpaint_canvas.js` +100 -34 (also inpaint_layered.js, tools/layered_test.*) | **live**, needs-review; hunks at 37 (the `inpaint_layered.js` import line), 752-757 (after `HUGE_MAX_PIXELS`, T-load), 19084-19259 (`readLayered`, `checkLayeredSize`, `readPsdOnPool`, `loadLayered`: E59) |
| `ag-fix-small-3` (F-1) | 87612c33 | 3 / 0 | none of the five (assistant/index.js, inpaint_depthfx.js, inpaint_filters.js, inpaint_maps.js, tests); its worktree has uncommitted edits to `electron/main/assistant/index.js`, `tools/assistant_test.js` | live |
| `ag-fix-tiles` (T-1) | f218d136 | 6 / 0 | none of the five (inpaint_compositor.js, tools/composite_test.py) | live |
| `ag-chain-b-2` | 9eb81d21 | 1 / 238 | inpaint_canvas.js +19 -4 | stale: all 14 added lines checked are already on wasm-kernels (K29 merged another way) |
| `ag-fix-prov` | c6f690bf | 1 / 165 | recipes.js +21 -8, shell.js +6 -2 | stale: all 19 added lines checked are already on wasm-kernels (fix-prov merged) |
| `ag-chain-p` (K2) | cf50db4d | 2 / 213 | none of the five | K2 decided without code, not to be merged |

No worktree has uncommitted changes to any of the five files (`git -C <worktree> status --porcelain` over all 20
worktrees). So today only K20c conflicts: anything that moves T-load (494-949), E59 (18867-19322) or edits the import
block line 37 should wait for K20c's merge (CLAUDE.md item 56: "needs only K20c merged first"); a move elsewhere in
inpaint_canvas.js leaves K20c's hunks in place, but it still changes the file under a branch in review.

---------------------------------------------------------------------------------------------------------------------

## 8. An order that follows from the evidence (suggestion)

1. Tools first, once: `build_node.py host_members()` able to read spread parts (if host.js is split), a mixin
   installer helper with descriptors, `enumerable: false` and a collision throw, and the text-reading tests
   re-pointed (table in 6).
2. inpaint_canvas.js module scope, leaf modules with no cycle: style, dom + icons, orient, shaders, mesh, backends,
   consts, stroke/upload classes (each into `FILES`). After K20c: load.
3. inpaint_canvas.js class regions that read no `InpaintEditor` static and no K20c line, smallest risk first: text
   tool, panels (E62-E64), layers panel, masks, select by text, depth/maps, transform/geometry; then the Full-tier
   ones (history, filters, compositor, persistence, export/load) with both backends and a mutation round.
4. recipes.js (plain functions, CommonJS, leaves first), commands.js (groups spread in order), host.js (needs step 1),
   shell.js last (needs a state object for `settings` and five other `let`s first).
