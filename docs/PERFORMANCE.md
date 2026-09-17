# High-resolution performance plan (2026-09-10)

Target: images of 6k–12k pixels on the long side (25–100 MP), five to ten layers, filter
layers and colour match on, and every interactive gesture (slider, pan, zoom, brush,
transform) at a steady 60 fps on a mid-range GPU. Above 100 MP is rare and may degrade
gracefully; below 4 MP everything is already fine.

This document holds what was measured, why it is slow, how other editors do it, the
limits Chromium imposes, and the implementation plan in phases. The editor code lives in
the ComfyUI node (`js/inpaint_canvas.js`) and is synced into the app; every change here
goes into the node first and comes back through `tools/sync_editor.py`.

## 1. What was measured (dev instance, RTX 5090, Chromium 152 / Electron 44)

| Document | Gesture | Time per frame |
|---|---|---|
| 2048 × 1152 | opacity slider tick | 3–5 ms |
| 10864 × 6062 (66 MP), one result layer | opacity slider tick | 250–400 ms |
| 66 MP | colour match slider tick | 350–900 ms |
| 66 MP | film look filter, full evaluation | 3.9 s (measured 2026-09-09) |

Isolated draw costs (offscreen, same machine): drawing the 66 MP `<img>` scaled to 25 %
costs 440 ms the first time and 9 ms afterwards while nothing else evicts it; a 66 MP
canvas drawn at 25 % costs 20–50 ms; a prebuilt quarter-size copy under 3 ms. Canvas 2D
is GPU-accelerated in the app (fresh canvas blits run in fractions of a millisecond);
readbacks with `getImageData` do not de-accelerate a canvas in this Chromium.

### 1b. After phase 1 (2026-09-10, `tools/perf_test.py`, same machine)

Synthetic documents, base image plus three full-size paint layers, one result layer with
colour match at 60 % and one grain filter layer, view 3326 × 1808 device pixels. Median of
the repeats, milliseconds:

| Gesture | 2048 × 1152 | 6000 × 4000 (24 MP) |
|---|---|---|
| opacity slider tick | 15.5 | 18.3 |
| colour match tick | 14.6 | 18.1 |
| filter slider tick | 10.9 | 18.2 |
| pan, per frame | 0.7 | 0.8 |
| wheel zoom step | 70 | 190 |
| redraw, nothing changed (hover, ants) | 0.0 | 0.0 |
| brush dab + frame | 0.1 | 0.1 |
| stroke commit (undo copy) | 0.5 | 0.6 |
| getValue (autosave) | 0.2 | 0.0 |
| full composite (export path) | 67 | 264 |

The compositor itself is no longer the cost: with the filter and the colour match switched
off a zoom step at 24 MP is **0.1 ms**. What is left is filter work, measured separately
(6 MP viewport): the colour match CPU loop **19 ms** per composite, and the grain filter
**100 ms** whenever the viewport size changes, because its noise field is generated pixel
by pixel on the CPU for exactly that size. Both are phase 2.

The viewport composite is exact: at 100 % zoom it is bit-identical to the full-resolution
composite (max difference 0 over blend modes, opacity, colour match, a levels filter and
the film look).

## 2. Why it is slow: the pipeline as it is

From the full map of `renderer/editor/inpaint_canvas.js` (line numbers of 2026-09-10):

**Every frame is a full-resolution frame.** `draw()` (6603) redraws everything: no dirty
rectangles, no partial repaint. With any filter or colour-matched layer visible,
`drawComposite` (6338) first composites all layers into `flatCanvas` at image size, then
blits that to the view. At 66 MP that is a clear, one draw per layer and one full blit of
264 MB of pixels per frame, whatever the zoom. Without filters the view is drawn straight
from the sources, but the sources are full size: the base `<img>` (never a canvas,
`this.base.img`) is larger than Chromium's GPU image cache, so it is re-decoded or
re-uploaded again and again; Chromium builds its downscale mip chain per upload.

**Sliders and gestures draw synchronously.** `drawSoon()` (rAF-coalesced) has three
callers (opacity, match, filter sliders); `draw()` is called directly from 101 sites,
among them every `onPointerMove` (3282), every wheel event, the brush size slider, and a
`setInterval(…, 120)` marching-ants timer (6596) that repaints the whole scene at 8 fps
whenever a selection exists. Layer-list actions rebuild the entire list DOM including a
thumbnail per row, then `draw()`, then `drawThumb()`, which runs a **second full
composite** at thumbnail size; its filter cache key includes the target size, so the
thumbnail and the view evict each other's filter result.

**Colour match applies its statistics on the CPU over the whole layer**
(`layerMatchedPixels` 6451–6479: `getImageData` / loop / `putImageData` on every cache
miss, and the cache is invalidated by every composite change). The statistics themselves
are cheap (256 px).

**GL filters copy twice per evaluation.** `inpaint_filters_gl.js` uploads the input
canvas as a texture on every call (668), renders (tiled above the 33 MP drawing buffer
cap, each tile a canvas resize), and hands the result back through `drawImage` from the
GL canvas into a fresh 2D canvas. Nothing stays on the GPU between two filter layers or
two slider ticks; the 1024 px preview (`filterPreview`) is the only shortcut.

**Hidden full-image work outside drawing** (these are what make "everything" feel slow at
high resolution, not only the sliders):

- `getValue()` (7052) encodes the selection as a PNG data URL (`selection.toDataURL`)
  whenever the selection changed; the autosave runs it 1.5 s after every change, for
  every open document. At 100 MP that is a multi-second synchronous encode and a string
  of hundreds of MB in the V8 heap.
- `snapshot()` (4493) stores undo steps as PNG data URLs of the whole layer: every brush
  stroke starts with a synchronous full-layer `toDataURL` on pointerdown.
- `selectionBounds()` (5568) reads the whole selection canvas back and scans it; it runs
  twice per `drawScene` while `selectionDirty`, which a selection-move gesture sets on
  every pointermove.
- Eyedropper, clone and heal call `flattenToCanvas()` (new full-image canvas plus a full
  composite) on pointerdown; magic wand and bucket do the same plus a full readback.
- Object hover keeps a `Uint16Array` id map at full resolution (200 MB at 100 MP) and
  rebuilds a full-image shape canvas per hovered id, blitted through `ctx.filter` each frame.
- Painting allocates a full-layer stroke canvas per stroke (plus a clip canvas when a
  selection exists) and, with a mask, rebuilds the masked preview every frame.
- Layer uploads to the mirror (`syncLayers`, 15 s after the last change) PNG-encode and
  SHA-1 whole layers on the main thread.

## 3. How the others do it

- **Krita**: pixels live in 64 × 64 tiles (`tiles3`), a stroke marks tiles dirty, and the
  canvas shows a *prescaled projection*: the merged image is kept as a pyramid of
  downscaled levels, updated per dirty rect in a thread pool, and the OpenGL canvas
  draws texture tiles of the level closest to the zoom. "Scale last": merge at full
  resolution, scale the merged result, never scale before merging (avoids seams).
  Sources: [Krita tile data format](https://community.kde.org/Krita/Tile_Data_Format),
  [Dmitry Kazakov, mipmapping for Krita's canvas](https://dimula73.blogspot.com/2009/07/mipmapping-for-kritas-canvas-subsys.html),
  [tile engine wrap-up](https://dimula73.blogspot.com/2009/08/gsoc-krita-tile-engine-wrap-up.html).
- **Photoshop**: the document is tiled (tile size a preference, 128 K–1024 K), and the
  *cache levels* preference (1–8) keeps downscaled copies of the composite for zoomed-out
  display and histogram; adjustment previews render at screen resolution and the full
  document is recomputed afterwards in the background.
- **Photopea**: every layer's pixels are stored as a WebGL texture; blending (all modes),
  masks and the UI composite (zoom, grid, selection highlight) run in shaders. Redrawing
  a 2048 × 1152 project with ten layers and three effects went from 850 ms on the CPU to
  55 ms with WebGL. Sources: [Photopea 1.3](https://blog.photopea.com/photopea-1-3.html),
  [Photopea 1.1](https://blog.photopea.com/photopea-1-1.html).

The common shape: keep sources on the GPU, composite only what is visible at the
resolution that is visible, update only what changed, and do the full-resolution work
later and elsewhere.

## 4. What Chromium and Electron allow

Measured in the running app and read from the Chromium tree on 2026-09-10:

| Limit | Value | Consequence |
|---|---|---|
| Canvas 2D max area (`kMaxCanvasArea`, [canvas_rendering_context_host.cc](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/html/canvas/canvas_rendering_context_host.cc)) | 32768 × 8192 = 268 MP | a 16k × 16k canvas is the ceiling; above it canvas creation fails |
| Canvas 2D max side (`kMaxSkiaDim`) | 65535 | not the binding limit |
| WebGL2 / WebGPU `MAX_TEXTURE_SIZE` in the app (ANGLE D3D11, RTX 5090) | **16384** | one texture holds up to 16k on a side; 12k images fit, larger ones need tiles. 97 % of Windows GPUs report ≥ 16383 ([web3dsurvey](https://web3dsurvey.com/webgl2/parameters/MAX_TEXTURE_SIZE)) |
| WebGL drawing buffer | about 33 MP (measured 2026-09-09) | a framebuffer for a 100 MP image must be tiled (already done in `renderTiled`) |
| WebGPU | available (`navigator.gpu`, `maxTextureDimension2D` 16384, buffers up to 2 GB) | compute shaders possible later; not required for the plan |
| V8 heap ([Electron memory cage](https://www.electronjs.org/blog/v8-memory-cage)) | 4 GB, pointer compression since Electron 14 | data URLs and big strings count here; typed arrays are outside but capped by the cage |
| Renderer process (Windows) | about 8 GB hard limit, closed as "not planned" ([electron#35218](https://github.com/electron/electron/issues/35218)) | canvases and images count towards it. 96 GB of system RAM do not change this: the limit is per Chromium renderer process, not the machine |
| GPU memory | the card's VRAM (32 GB here) | textures we own in WebGL stay; Chromium's own caches (decoded images, Skia) are small and evict, which is why the 66 MP `<img>` is re-uploaded per frame |

Practical consequences: at 12k × 8k one RGBA layer is 384 MB. Ten such layers as
canvases plus the composite, the selection, undo strings and the objects map run past
the 8 GB renderer limit; as GPU textures they are fine on a 16 GB+ card and tight on an
8 GB card. Memory, not speed, is the reason to keep tiles and pyramid levels in view for
the later phases, and to move undo and autosave off data URLs.

## 5. Architecture decision

Three options were weighed:

**A. Stay on Canvas 2D, add a pyramid and a viewport composite.** Sources get cached
downscaled levels; while a gesture runs, the composite is built only for the visible
region at screen resolution. Small, incremental, works with every existing tool; filters
and colour match keep their canvas round trips.

**B. WebGL2 compositor.** Every layer is a texture (tiled at 4096 or 8192 to stay under
`MAX_TEXTURE_SIZE` and to update per tile), with mip levels; the visible region is
composited in one shader pass per layer (blend modes, opacity, masks); filter layers and
colour match run in the same chain without leaving the GPU; the full-resolution result is
only rendered when something needs it (export, run, thumbnail) and then tile by tile. This
is Photopea's design and the only one that makes ten 12k layers with filters interactive.

**C. WebGPU.** Same as B with compute shaders and a cleaner API; available in this
Electron, but the GL filter code and plugin shader API (`registerGLFilter`,
`scumble.gl.shade`) are WebGL2 today. Not now; the compositor is written so that a
WebGPU backend can replace the WebGL2 one later (textures and passes behind one interface).

**Decision: A first, then B.** A removes the per-frame full-resolution work with a few
hundred lines and makes 6k–12k usable within days; B replaces the compositing core and is
the professional target. A's pyramid becomes B's mip levels, A's viewport composite
becomes B's render pass, nothing is thrown away. The hidden full-image work in §2 is fixed
in A regardless of the compositor, because none of it is a drawing problem.

## 6. Implementation plan

Each phase ends with the benchmark in §7 and a sync into the app. Effort is for one
person, tested.

### Phase 1: stop doing full-resolution work per frame — **done 2026-09-10**

What landed in the node (`js/inpaint_canvas.js`, synced into the app), in the order of the
list below; §1b has the numbers.

- `touchSource(src)` / `displaySource(src, scale)`: the display pyramid, halvings cached
  per source canvas in a `WeakMap` and dropped when the source's version is bumped. Live
  stroke previews carry `_livePreview` and are never cached. At most **one new level per
  frame** (`_pyramidBudget`); a frame that still wants a finer level draws with what it has
  and asks for another frame, otherwise the first zoom step after a change builds the chain
  of every source at once (200 ms at 24 MP).
- `baseSource()`: the base image is converted to a canvas once. As an `<img>` larger than
  Chromium's image cache it was re-decoded on every draw.
- `viewportRegion()` / `drawViewComposite()` / `viewPass`: the screen is composited only
  for the visible rectangle, at screen resolution, out of the pyramid levels; filters and
  colour match run on that small input. The region's **size** depends only on zoom,
  rotation and window size, never on the pan position, and it may reach outside the image:
  a size that changes per frame reallocated the viewport canvas on every pan step, which
  cost more (72 ms at 24 MP) than the composite. `flattenToCanvas` (export, run, upload,
  clipboard) always takes the full-resolution path.
- **Deviation from the plan:** the screen uses the viewport composite *always*, not only
  while a gesture runs. The plan wanted a full-resolution composite after the release; at
  24 MP with a film look that is a 3–4 s stall after every slider, and it buys nothing,
  because the viewport pass is bit-identical at 100 % zoom and below it only differs the
  way a downscale differs.
- Scene cache: `sceneSignature()` covers everything the composited image depends on
  (`pixelVersion`, `compositeVersion`, view, canvas size, per-layer geometry / opacity /
  blend / filter params / match, pointer, pending). While it stays the same the last scene
  canvas is blitted and only the overlays are redrawn, so the marching-ants timer, hover
  and rubber bands cost nothing. `drawScene` is split into `drawSceneImage` (cached) and
  `drawSceneOverlays` (every frame).
- The node thumbnail composites through a region pass at thumbnail scale instead of a
  second full-size composite, and the layer-row thumbnails draw from the pyramid.
- Marching ants, the selection tint and the object hover shape draw from the pyramid: nine
  draws of a 24 MP selection canvas per frame became nine draws of a level.
- One draw per frame: pointer move, wheel, brush size and the ants timer use `drawSoon()`.
- **Undo without full-image PNGs.** A brush stroke pushes a copy of the rectangle it
  touched (`snapshotRect`, tracked in `strokeBounds` during the dabs, taken in
  `commitStroke` before the stroke is applied) instead of a `toDataURL` of the whole layer
  at pointerdown. Everything else (`selection`, `layer`, `mask`, `text`, `layerfull`,
  `canvas`) encodes through `canvas.toBlob` into a blob URL off the main thread; the step
  holds the promise, `snapImage()` awaits it on undo, `releaseSnapshot()` revokes it.
  `MAX_UNDO_BYTES` (384 MB) caps the rect copies alongside `MAX_UNDO`.
- **Selection bounds without scanning.** `markSelectionChanged(bounds)` takes the new box
  when the caller knows it; `boundsAfter(mode, box)` computes it for rectangle, ellipse,
  lasso and polygon (a subtract still scans), and a selection move shifts the old box. The
  scan itself now reads the alpha as one 32-bit test per pixel with a per-row early exit.
- `getValue()` no longer blocks on `selection.toDataURL` above 16 MP: `encodeSelectionSoon`
  encodes in the background and calls `notifyChanged()` when it lands, so the autosave that
  follows carries the fresh selection; below 16 MP it stays synchronous and exact.
- Eyedropper, clone, heal, bucket and wand read `compositeCanvas()`, one cached
  full-resolution composite per composite version, instead of flattening on every press.

Known effects to keep in mind: the colour match statistics are cached per composite version
and taken from whatever the view showed when the composite last changed, so panning and
zooming never shift a matched layer's colours (the full-resolution path keeps its own
statistics); a layer change drops that layer's pyramid, so the next frame pays one halving
(phase 4's dirty rectangles fix that).

The original plan for reference:

### Phase 1 (planned)

1. **Display pyramid per source.** `displaySource(source, scale)` returns a cached
   level (½, ¼, ⅛ … built with `drawImage` chains or `createImageBitmap` with
   `resizeWidth`), chosen so the level is the smallest one at or above the screen scale.
   Sources: the base image (converted to a canvas once, so it is no longer an `<img>`
   that Chromium re-decodes), every layer canvas, the selection canvas, masks. Each source
   gets a version counter; `markLayerChanged`, the stroke commit, `markMaskChanged` and
   `markSelectionChanged` bump it and drop the levels. During a stroke the level of the
   painted layer is bypassed (drawn full size through the existing stroke preview) and
   rebuilt on commit.
2. **Viewport composite.** `drawComposite` gets a `region` (visible image rect) and a
   `targetScale`. While `interactive` is set (any pointer gesture, slider drag, wheel
   zoom, ants timer) it composites only the visible rect at screen resolution into a
   viewport-sized canvas: layers from their pyramid level, filters through
   `filteredCanvas` on that small input (this replaces the 1024 px `filterPreview`
   special case), colour match on the small input. On release (`change`, pointerup, a
   250 ms idle timer) the full-resolution composite runs once as today, so exports, the
   thumbnail and the run see exact pixels.
3. **One draw per frame, everywhere.** Replace the direct `draw()` calls of pointermove,
   wheel, brush size, layer-list actions and the ants timer with `drawSoon()`; the ants
   timer only redraws the overlay, not the scene (keep the last scene in a canvas and
   redraw ants over it). `renderLayers` stops rebuilding thumbnails per row on every
   action (thumbnails update on layer change only).
4. **Thumbnail from the viewport composite**, not from a second full composite; separate
   cache keys so view and thumb stop evicting each other.
5. **The hidden bombs.** `getValue()` keeps the selection PNG in a cache that is only
   rebuilt on save (not on every autosave tick) and encodes through `canvas.toBlob`
   asynchronously in the autosave path; `snapshot()` for brush strokes keeps a canvas
   copy of the stroke's bounding box instead of a data URL of the whole layer (a copy of
   the dirty rect, restored with `drawImage`); `selectionBounds()` tracks bounds
   incrementally (the union of stroke dabs, or the rect of a selection op) and only scans
   when nothing better is known, and never during a gesture; eyedropper, clone and heal
   sample from the last full composite (`flatCanvas`) instead of flattening again.

Expected result: 66 MP opacity tick from 250 ms to under 10 ms; match tick from 500 ms to
under 20 ms (statistics unchanged, application at viewport size); pan and zoom at 60 fps;
no multi-second stalls after a selection change or at the start of a stroke.

### Phase 2: colour match and filter work on the GPU — **done 2026-09-10**

After phase 1 the compositor was no longer the cost (a zoom step at 24 MP with the filter
and the match switched off: 0.1 ms). What was left was measured piece by piece on a 6 MP
viewport: the colour match pixel loop **19 ms** per composite, and the grain filter
**100–190 ms** whenever the viewport size changed, because it generated its noise field
cell by cell for exactly that size.

- **Colour match as a shader pass.** The pixel loop moved out of the editor into
  `matchCanvas(src, stats, strength)` in `inpaint_filters.js` (the node keeps it as the CPU
  path); the app patches it to try `applyMatchGL` first, mode 6 of the filter shader with
  the six statistics as uniforms. 19 ms → 4.6 ms. The two paths differ only through the
  premultiplied-alpha quantisation of the canvas round trip: at alpha 255 at most one
  level, growing as alpha falls (85 levels at alpha 1, where the pixel contributes about
  one level to the composite).
- **The grain field is a cached tile.** `grainNoiseCanvas()` in `inpaint_filters.js` repeats
  one 1024 × 1024 tile of cells (`grainTileCanvas`, cached per speckle / colour share /
  seed) at the cell size, and anchors it at the image origin through the new `info.origin`,
  so the grain sits still while the view pans and the preview size changes. The GPU module
  imports the same function instead of keeping its own copy, so both paths always see the
  same field. 194 ms → 2 ms per zoom step; the film look's CPU / GPU twins stay within the
  same 3 levels as before.
- **Incremental pyramid updates.** `touchSourceRect(src, x0, y0, x1, y1)` refreshes the
  cached levels inside a rectangle (each level from the one above it, `globalCompositeOperation
  = "copy"`) instead of dropping them. Selection dabs, a finished brush stroke and a
  selection stroke use it, so a dab no longer rebuilds a 96 MP pyramid (200 ms per frame).
- **Selection bounds through a level.** `selectionBounds()` scans the ⅛₆ level first (a
  covered cell keeps alpha: a single pixel is still 4 after four halvings) and only makes
  the box exact inside that region. 478 ms → 82 ms at 96 MP.
- **Renders larger than the drawing buffer go into a texture.** `renderToTexture()` renders
  the whole picture once into an off-screen RGBA8 texture (framebuffer attachments go up to
  `MAX_TEXTURE_SIZE`, not the drawing buffer's 33 MP) and copies it out with
  `blitFramebuffer` in pieces the drawing buffer can hold, instead of running the shader
  again for every tile with a canvas resize in between. Verified against the CPU path at
  2000 × 1000, 7000 × 5000 and 10864 × 6062: identical pixels, corner markers in place.

Measured afterwards (same setup as §1b, medians):

| Gesture | 2048 × 1152 | 6000 × 4000 | 12000 × 8000 (96 MP) |
|---|---|---|---|
| opacity slider tick | 8.8 | 6.2 | 8.2 |
| colour match tick | 8.5 | 6.1 | 7.6 |
| filter slider tick | 6.9 | 6.5 | 8.2 |
| pan, per frame | 1.1 | 1.2 | 1.4 |
| wheel zoom step | 2.1 | 2.1 | 6.2 |
| redraw, nothing changed | 0.0 | 0.0 | 0.0 |
| brush dab + frame | 0.1 | 0.1 | 0.1 |
| undo step | 37 | 46 | 80 |
| selection bounds scan | 6 | 19 | 81 |
| full composite (export path) | 14 | 32 | 150 |

A realistic film stack (film look + halation + grain) on a 96 MP document: 12–17 ms per
frame while dragging a slider, 7–9 ms for pan and zoom, 0.7 s for the full-resolution
export.

**Not done, on purpose: the ping-pong texture chain between filter layers.** The plan wanted
consecutive filter layers to stay on the GPU (one upload, one download for the whole chain).
The measurements above say a three-filter stack already fits the 16 ms budget, and the
remaining round trips are between *plugin passes* (halation blurs through `gl.shade`), which
would need the whole filter API to work on textures rather than canvases. That is the same
refactor the WebGL2 compositor in phase 5 brings anyway, so it waits for it rather than
being built twice.

**Which GPUs this needs.** Nothing here is vendor-specific: the editor draws through
Canvas 2D and WebGL2, which Chromium runs on ANGLE (D3D11 on Windows, GL/Vulkan on Linux)
for AMD, Intel and NVIDIA alike; CUDA is not involved anywhere in the editor. Every limit
that differs per card is read at run time (`MAX_TEXTURE_SIZE`, `MAX_VIEWPORT_DIMS`,
`drawingBufferWidth/Height`) and every GPU path falls back to the CPU twin when the context
is missing, lost or too small, which is also what the CPU / GPU comparison in
`tools/film_test.py` keeps honest. `blitFramebuffer`, `texStorage2D` and RGBA8 render
targets are core WebGL2, not extensions. Only the ONNX helpers (SAM2, background removal)
are hardware-specific, and they use DirectML on Windows, which covers AMD and Intel as well.

The original plan for reference:

### Phase 2 (planned)

1. Colour match as a GL filter (`match` shader with the six statistics as uniforms;
   statistics still computed on the 256 px thumbnails). The CPU loop stays as the
   fallback like every other filter.
2. `inpaint_filters_gl.js` keeps textures: an input texture per source canvas keyed by
   the source's version, ping-pong framebuffers for a chain of filter layers, and the
   final result read once into the 2D composite. A chain of three filter layers becomes
   one upload and one download instead of three of each. The plugin API keeps its
   signature (`shade(vec4, vec2)`, `scumble.gl.shade`), the texture cache sits behind it.
3. Full-resolution filter renders above 33 MP keep the tiling but render into a texture
   array instead of resizing the GL canvas per tile.

### Phase 3: off the main thread — **done 2026-09-10**

Measured first, on a 96 MP canvas, how long each operation actually blocks the main thread
(sampling the thread every millisecond and taking the longest gap), because wall time and
blocking are not the same thing here: `canvas.toBlob` runs 7.7 s but only holds the thread
for 0.75 s, `crypto.subtle.digest` almost not at all, and the PSD writer holds it for all
of its 4.1 s.

- **The editor has a worker** (`js/inpaint_worker.js`, synced into the app): a module
  worker created from `new URL("./inpaint_worker.js", import.meta.url)`, so the ComfyUI page
  and `scumble://app/` both serve it from next to the editor. Every reply carries the
  request's id; a job that fails, times out (`WORKER_TIMEOUT`, 3 min) or a worker that will
  not start makes the caller do the work on the main thread instead, so nothing depends on
  it being there.
- **PNG encoding and the upload hash** go through it (`encodeCanvas`, used by
  `uploadCanvas`, the undo snapshots and the autosave's selection PNG). The main thread only
  pays `createImageBitmap`, which snapshots the canvas at call time, so an undo step still
  captures the pixels as they were when the step was pushed (checked).
- **The layered exports** (PSD, ORA) go through it as well. The writers in
  `inpaint_export.js` became `PsdWriter` / `OraWriter`, which take their layers one at a
  time, so the worker packs each layer as its pixels arrive and only one layer is ever in
  flight; `buildPsd` / `buildOra` stayed as wrappers for the fallback. The module works
  without a `document` now (`OffscreenCanvas`, `convertToBlob`).

| Operation, 96 MP | main thread blocked before | after |
|---|---|---|
| PNG encode (upload, undo, autosave) | 738 ms | 17 ms |
| PSD export, one layer plus composite | 4146 ms | 101 ms |

The files are byte-identical to what the main thread produced, PNG, PSD and ORA alike, and
the upload hash matches.

**Not done, on purpose: the full-resolution filter and match renders in a worker.** The plan
wanted them on a second WebGL2 context. After phase 2 the full-resolution composite is
12–150 ms and a three-filter film stack export 0.7 s, all of it once per export or run, and
moving it would mean making the GL filter module and its plugin shader API work on
`OffscreenCanvas` in a worker. Phase 5 moves that code onto the GPU pipeline anyway.

The original plan for reference:

### Phase 3 (planned)

1. A worker with `OffscreenCanvas`: PNG encoding for autosave, undo snapshots (the
   dirty-rect copies from phase 1 as `ImageBitmap` transfers), layer uploads to the
   mirror (`toBlob` + SHA-1 in the worker), export. The main thread never encodes a
   whole layer again.
2. Full-resolution filter and match renders after a gesture run in the worker on its own
   WebGL2 context (Chromium supports WebGL2 in workers on OffscreenCanvas), with the
   result transferred back as an `ImageBitmap`. The viewport preview from phase 1 stays on
   the main thread, so the screen never waits for the full render.

### Phase 4: dirty rectangles and the selection — **done 2026-09-10**

What the plan asked for, measured against what was left after phase 3:

1. **Dirty rectangles for painting** were already there: phase 1 put the stroke into its own
   preview canvas and phase 2 added `touchSourceRect`, which refreshes the display levels
   inside the painted box instead of dropping them. A brush dab and its frame cost 0.1 ms on
   a 96 MP document, and the stroke's undo copy 0.4 ms, so nothing was left to do here.
2. **The selection work moved into the worker.** Grow, shrink, feather, invert, the magic
   wand and the bucket used to run on the main thread over the whole image; each of them
   held it for one to four seconds at 96 MP.
3. **Layer tiles** are deliberately not built: they are the data structure the WebGL2
   compositor needs, and building them before it would mean writing the upload path twice.
   Phase 5 brings them.

The selection work in detail:

- `inpaint_raster.js` owns the shared pieces now (`distanceTransform`, `growMask`,
  `invertMask`, `maskBounds`, and a canvas helper that works without a `document`), so the
  editor and the worker run the same code.
- The worker got two jobs: `selection` (grow, shrink, feather, invert) and `flood` (the
  wand's and the bucket's region, clipped to the selection, as a coloured shape). Pixels go
  over as ImageBitmaps and come back the same way.
- **Grow and shrink only touch the band around the selection**: the distance transform runs
  on the selection's bounding box padded by the radius, not on the whole image.
- **Every answer carries the new bounding box**, computed where the pixels already are, so
  the editor stops scanning for it afterwards. That was the largest part of what was left
  after the algorithms moved out (`markSelectionChanged` asks `renderInfo` for the size,
  which forced a scan of the whole selection).
- The results are pixel-identical to the main-thread path, and the reported bounds agree
  with an exact scan; undo and redo of a worker operation restore the previous selection.

| Operation, 96 MP | main thread blocked before | after |
|---|---|---|
| grow +16 | 3923 ms | 344 ms |
| shrink −16 | 3286 ms | 131 ms |
| invert | 1329 ms | 91 ms |
| feather 8 | 1014 ms | 113 ms |
| magic wand | 1964 ms | 261 ms |
| bucket fill | 1477 ms | 261 ms |

What is left blocking (100–350 ms) is the display level of the changed selection being
rebuilt once, plus `createImageBitmap`; it happens once per action, not per frame.

**Not done, on purpose: the selection as a `Uint8Array`.** The plan wanted one byte per
pixel instead of an RGBA canvas, for the memory. The canvas is what the marching ants, the
brush clip, the layer masks, every selection tool and the mask export draw from, so the
change is thirty call sites and buys memory, not speed. It rides along with phase 5, where
the selection becomes a texture anyway.

The original plan for reference:

### Phase 4 (planned)

1. **Dirty-rect compositing for painting.** A stroke marks the union rect of its dabs;
   the composite and the pyramid levels update only that rect (Krita's model). Brush
   strokes on a 100 MP layer then cost what the brush covers, not the layer.
2. **Selection as a typed array** (`Uint8Array`, one byte per pixel, 100 MB at 100 MP
   instead of 400 MB RGBA) with incremental bounds; grow / shrink / feather / invert on
   the array in the worker; the marching ants drawn from the pyramid level of the
   selection.
3. **Layer textures in tiles** (4096²) so a layer of any size fits `MAX_TEXTURE_SIZE`,
   only dirty tiles re-upload, and the WebGL2 compositor of phase 5 can composite tile by
   tile.

### Phase 5, step 1: the compositor stacks layers on the GPU — **done 2026-09-10**

`js/inpaint_compositor.js` (synced into the app) composites the visible region on the GPU:
every source canvas becomes a texture keyed by the version the editor already bumps
(`touchSource`), and each layer is one shader pass into a viewport-sized framebuffer.

**The blend modes were the risk, and they are settled.** The nine modes the editor exposes
follow the W3C compositing spec; the shader was checked against Canvas 2D over every
combination of colour and alpha at two opacities:

| | max | mean |
|---|---|---|
| premultiplied (what reaches the screen) | 2.3 levels | 0.3 |
| straight alpha | 85 levels | 0.5 |

The straight-alpha outliers all sit at alpha 1/255, where dividing by the alpha turns one
step of 8-bit rounding into 85 levels; the picture is the same. Two other things had to
match Canvas 2D exactly: a canvas texture's first row is its top while a framebuffer's is
its bottom (the layer pass samples flipped), and textures are uploaded **premultiplied** so
that scaling interpolates across transparent edges the way Canvas 2D does. Before that
second fix, 360 pixels of a test frame were up to 45 levels off, all of them on the edge of
a transparent hole in a scaled layer.

In the editor, on a document with all nine blend modes, a masked layer, a colour-matched
layer and text: **max 1 level over 1.5 million pixels, mean 0.026, nothing above 2**
(`tools/composite_test.py`, which renders the same view both ways in one run).

**What it does not do**, by design: it stacks *prepared* layer pixels. Masks, colour match,
the stroke preview and pending transforms stay in the editor, which hands over the canvas
it would have drawn, so every one of those keeps working untouched. `glCompositeUsable()`
falls back to Canvas 2D for filter layers, a running stroke, a transform, the compare
split, peek, exports and runs.

**The honest measurement.** Timing `drawViewComposite` on a 96 MP document, panning:

| Output size, layers | Canvas 2D median | Canvas 2D worst | GPU median | GPU worst |
|---|---|---|---|---|
| 1600 × 900, 7 | 0.0 ms | 0.2 ms | 0.1 ms | 0.2 ms |
| 3400 × 1900, 7 | 0.0 ms | 8.8 ms | 0.1 ms | 0.2 ms |
| 3400 × 1900, 15 | 0.0 ms | 9.8 ms | 0.1 ms | 0.2 ms |

The medians are the same. Phases 1 and 2 already removed the per-frame cost this phase was
written to remove: with a display pyramid the 2D path only blits a handful of small
canvases, and that is fast. What the compositor buys is the **worst case** - the 9 to 10 ms
spikes at a large window with many layers are gone, and those are what drop frames.

**What that means for the rest of phase 5.** The plan's premise ("the only design that makes
ten 12k layers with filters interactive") was written before phases 1 and 2 were measured.
Stacking is no longer the bottleneck, so the remaining steps should be judged one
measurement at a time rather than built out on the strength of the original estimate:

1. **The filter chain on the GPU** (ping-pong textures between filter layers, no canvas
   round trip per layer per frame) - this is where time still goes and is worth doing next.
   **Done, see step 2 below**: it removed the round trips (14 per frame to 5 for a film
   stack) and with them 0.45 ms per extra filter layer, and it found the next thing in the
   way, the Canvas 2D blur inside halation.
2. **Layer tiles** above `MAX_TEXTURE_SIZE`, needed for sources over 16384 px on a side;
   today the compositor returns null there and Canvas 2D takes over, which works.
3. **The full-resolution path** (export, run, thumbnail) through the same passes - only
   worth it if a measurement shows the 2D path costing something at that point. Step 2
   measured it: above about 12 MP the GPU chain is slower than the canvas path, so this
   needs the memory work of phase 6 first, not more passes.

### Phase 5, step 2: the filter chain stays on the GPU — **done 2026-09-10**

**What was measured first.** The cost of the filter path is not the shader and not the
pixels: a round trip canvas → texture → canvas costs **0.6 to 1.0 ms whatever the size**
(0.70 ms at 1865 × 1205, 1.00 at 2560 × 1440, 0.60 at 3400 × 1900), because each end of it
synchronises the 2D canvas with the WebGL context. A hand-written ping-pong prototype (one
upload, five shader passes between two framebuffer textures, one blit out) ran the same
five passes in **0.1 ms**, against 3.2 ms for five `applyFilterGL` calls. And a realistic
film stack pays seven of those round trips per frame, because the film look alone is four
stages (colour, halation extract, halation, grain) and every stage went through a canvas.
So the mechanism was worth building; how much it buys depends on what else the stack does.

**What it is.** `inpaint_filters_gl.js` grew render targets. A `GLSurface` is an RGBA8
texture with a framebuffer; with `info.chain` a pass writes into one instead of a canvas,
and reads one instead of uploading. Surfaces are stored top down like a canvas texture
(the new `u_dstTop` uniform flips the fragment mapping when the target is a surface), so no
shader, plugin or caller has to know where its input came from. `beginScope()` /
`endScope(keep)` give every surface a run took back to a pool except the one it returns;
`glChainStats()` counts uploads, read backs and passes, which is what the benchmark reads.

Two places had to learn about it:

- **Inside one filter.** `applyFilter` hands a plugin's `apply()` the texture as it is when
  the filter declares `chain` (the film pack does: everything there runs through
  `makeRunner` and the helpers in `common.js`, which resolve a surface only where they
  really read pixels — `open`, `copyCanvas`, `blur`). Every other `apply()` is a pixel loop
  and still gets a canvas through `glToCanvas`. Without that distinction the resolve at the
  top of `applyFilter` broke the chain at every plugin filter, which is exactly what the
  first measurement showed (3 uploads instead of 1).
- **Between filter layers.** `drawLayersInto` carries the chain through the layer loop;
  `applyFilterLayer` takes it in and hands it on when the layer covers its input one to one
  (no mask, opacity 1, blend normal, no preview downscale) and another filter layer follows,
  otherwise `flushFilterChain` draws it onto the canvas. **The pixels do not change**: a
  result that goes onto the canvas is drawn over the composite exactly as before, and the
  chain is flushed underneath it first, so only the *upload of the next filter's input* is
  saved, never the compositing order. `tools/composite_test.py` checks this in one run,
  chain on against chain off: view and full-resolution composite are **identical, 0 levels**.

**The result** (`python tools/perf_test.py --chain 6000x4000`, 1865 × 1205 view, pan,
median ms per frame; "round trips" are uploads + read backs per frame):

| filter layers | chain | chain off | round trips, chain | off |
|---|---|---|---|---|
| invert | 0.8 | 0.7 | 1 + 1 | 1 + 1 |
| invert × 3 | 1.4 | 1.8 | 1 + 2 | 3 + 3 |
| invert × 5 | 1.5 | 2.9 | 1 + 2 | 5 + 5 |
| film look | 2.7 | 3.4 | 1 + 2 | 4 + 4 |
| film look + halation + grain | 5.5 | 5.8 | 1 + 4 | 7 + 7 |

So an extra filter layer costs about **0.6 ms before and 0.15 ms after**, a single filter
layer is unchanged, and the film look alone is a fifth faster. The full film stack barely
moves, and that is the honest finding of this step: **what is left in it is the two
Canvas 2D blurs inside halation.** `blur()` uses `ctx.filter = blur(σ)`, so the chain has
to touch down on a canvas there and then wait for that blur before it can go on — the
round trips fell from 14 to 5 and the frame stayed at 5.5 ms. The next lever for the film
stack is therefore a **blur as a shader pass**, not more chaining. It is not built here
because it would change the look of every blur-based film filter (Skia's three box blurs
against a separable gaussian) and `tools/film_test.py` compares the two paths against each
other, not against a fixed picture: that is a decision about the film pack's output, not a
performance detail, and it belongs to the user.

**Where the chain is used, and where it is not.** `CHAIN_MAX_PIXELS` is 10 MP, and the
reason is the pool, not the mechanism. Full-resolution composite with the film stack, with
`glChainStats().surfacesMade` next to the time:

| | chain | new textures per frame | chain off |
|---|---|---|---|
| 8.3 MP | 6.3 ms | 0 | 8.3 ms |
| 12 MP | 7.3 ms | 2 | 9.7 ms |
| 16.2 MP | 20.0 ms | 7 | 10.4 ms |
| 24 MP | 35.6 ms | 7 | 13.4 ms |

At 16.2 MP a surface is 65 MB and seven are alive at once, which is 455 MB against a
`POOL_BUDGET` of 320: `trimPool` destroys all of them every frame and `texStorage2D`
builds them again. The same run with the budget raised to 1200 MB, purely as a test:
16.2 MP 9.0 ms against 8.7, **24 MP 10.2 ms against 19.7**, 40 MP 160 against 175, and
zero new textures per frame. So the chain scales past 16 MP as soon as its working set
fits; what does not scale is a fixed byte cap. A fixed *large* cap is the wrong answer
(680 MB of idle textures on a card that ComfyUI shares is how the helpers end up paging,
see the 125 s object map in CLAUDE.md), so the cap stays at 10 MP until phase 6 gives the
pool a policy. A screen pass is 2 to 8 MP even on a 4K window, so the interactive path is
on the chain and export, run and thumbnail keep the path they had. Open question for the
user: on a 5K or 6K display the viewport pass itself is 15 to 20 MP, which would put it
above the cap - if that is a real target, the pool policy moves up the list.
`ed.filterChainOff = true` switches the chain off at run time (that is what the test uses).

`tools/perf_test.py` (the ordinary run) is unchanged within noise after this step: pan 1.3
to 1.5 ms, slider ticks 6 to 7.4 ms, redraw 0.0 ms at 2.4 / 24 / 96 MP. It also picks the
film look again instead of falling back to grain — it asked `window.FILTERS`, which the app
does not define.

### Phase 5, the two bugs the compositor shipped with — **fixed 2026-09-10**

Both were reported by the user on 0.1.3 and both come from the same place: the GPU path
takes its input from caches that the Canvas 2D path never needed.

1. **A brush stroke or an erase did not reach the screen.** `touchSourceRect` refreshes the
   cached pyramid levels inside a rectangle instead of dropping them, which is what makes a
   dab cheap (phase 1), and for that it deliberately left `_dispVer` alone. The compositor
   keys its texture cache on exactly that number, so after the stroke it re-used the
   texture from before it. The stroke was in the layer canvas and in every export; only the
   screen showed the old pixels, which reads as "the layer jumps back". Now the rect touch
   raises the version, carries the pyramid entry to the new version (the levels were
   refreshed, so they stay valid) and raises the version of every level it redrew.
2. **Colour match did nothing.** The match takes its statistics from what is under the
   layer, and Canvas 2D reads that off the target it has been drawing into. In a GPU pass
   nothing is drawn into that target yet - `drawViewComposite` clears it before the pass -
   so the ring around the layer was empty, `matchStats` found no samples and returned null,
   and the slider moved without an effect. `glViewComposite` now hands
   `layerMatchedPixels` a thunk that composites the stack below the layer into a canvas of
   its own (`glMatchBackdrop`); `matchStats` resolves it only on a cache miss, so panning
   pays nothing and a slider tick pays one extra composite. Measured on a 24 MP document
   with a 2.8 MP matched layer: pan 0.1 ms with and without the match, a slider tick 4.3 ms
   on the GPU path against 3.4 ms on Canvas 2D. If the extra composite fails, the frame
   falls back to Canvas 2D (`err.glBail`) instead of drawing the layer unmatched.

3. **A whole layer vanished from the screen after an erase stroke nowhere near it** (found
   2026-09-11, fixed in 0.1.8; reported with a screen recording of a 2236 x 1853 result layer
   on a 15k document, 400 px eraser at 43 %, the ring 550 image px clear of the cat). This one
   is in the same function but is **not** the compositor's: `touchSourceRect` redrew the
   touched rectangle of each pyramid level with `globalCompositeOperation = "copy"`, meant as
   "replace the rectangle, alpha included". In Chromium `copy` applies to the **whole
   canvas**: everything outside the drawn rectangle is cleared as well. After one stroke the
   level held nothing but the strip around the stroke, and both paths draw from that level
   below 0.5 zoom (Canvas 2D through `displaySource`, the GPU through the texture of the
   level), so the picture lost the layer while its pixels, its thumbnail and every export kept
   it. Zooming past 0.5 brought it back, a re-zoom rebuilt the level, which is why it looked
   random. The rectangle is now cleared with `clearRect` and redrawn with `source-over`, which
   is the same result inside the rectangle and leaves the rest alone. `tools/editor_test.py`
   has the case (`erase_stroke_keeps_the_rest_of_the_layer_on_screen`): real pointer events
   on a zoomed-out result layer, the strip under the stroke has to turn white on screen and a
   block 580 px away has to stay green; on the old code the block reads white. The two
   earlier reproductions of the report missed it because they checked the layer's pixels and
   a full-resolution composite, and neither goes through a display level.

**Why `composite_test.py` passed anyway**, and what it does now. Its document always had a
colour-matched layer, but the test drew the Canvas 2D shot first and `layerMatchedPixels`
caches its result per composite version, so the GPU shot re-used the canvas the 2D path had
matched - the two paths agreed because they shared one cache. And nothing in the test ever
changed pixels through a rectangle touch, so the stale texture never showed. The gpu-vs-2d
step now drops the match statistics before every shot, so each path takes them off its own
backdrop, and erases into a paint layer the way the eraser commits a stroke before it
compares. On the code before the fix that step fails with 174 levels of difference on
51,300 pixels; after it, 1 level, as before.

The original plan for reference:

### Phase 5 (planned)

`drawComposite` becomes a render pass over the visible tiles: one quad per visible layer
tile, shader with blend modes (all Canvas 2D `globalCompositeOperation` modes the
editor exposes), opacity, mask multiply, colour match, then the filter chain from phase
2; the 2D canvas only carries overlays. Export, run and thumbnail render the full image
tile by tile from the same pass into an `OffscreenCanvas`. Sources: layer tiles from
phase 4, the base image as tiles, the selection texture. Memory budget: textures for
visible layers and their mips, tiles of hidden layers may be dropped and re-uploaded.
Behind the same interface a WebGPU backend can follow when the plugin shader API is
ported (a compatibility shim for `shade(vec4, vec2)` is possible with WGSL).

### Phase 6: memory, and what a long session does to the GPU — **done, 2026-09-10**

> The plan this phase was worked through is `docs/PHASE6_PLAN.md`; the node's
> `DEVELOPMENT.md` §21f holds the rules that came out of it. What follows is the
> measurement and what it changed.

**The symptom.** A `levels` slider tick cost 45 ms instead of 8 and a pan frame 47 ms
instead of 4 after four 96 MP documents had been built and closed in one page. Seen twice
before the phase started, on builds either side of phase 5 step 2, so neither new nor
caused by the filter chain.

**Step 1, the instrumentation** (`tools/mem_test.py`, and it stays):

- a new IPC `app:metrics` (`electron/main/main.js`, `electron/preload.js`) returns
  `app.getAppMetrics()` plus what the renderer can say about itself. The bytes that matter
  are in the **GPU process**, which is why nothing measured before phase 6 ever saw them.
  `performance.measureUserAgentSpecificMemory()` was never an option: it needs cross-origin
  isolation, which `scumble://` does not have, so it had been returning null all along.
- `ed.memoryReport()` (node repo) says what one editor holds: layers, masks, the four cache
  slots per layer, the display pyramids, undo (rect copies and the layer canvases the
  snapshots hold), the compositor's textures, the objects map, the scratch canvases.
  `GLCompositor.stats()` and `glPoolStats()` are the GPU-side counterparts.
- **a census of every canvas the page ever made**: the test wraps `document.createElement`
  before anything is built and keeps a `WeakRef` plus the line that allocated it. After a
  forced collection it reports what is still alive, how much, and where it came from.
  That is the instrument that did the work.

**What it found, and it was none of the six hypotheses.** With four 96 MP documents built
and closed, 301 canvases holding **18.8 GB** were still alive and the GPU process stood at
19 GB. A heap snapshot (`HeapProfiler.takeHeapSnapshot` through CDP, then the shortest path
from the GC root) named the retainer in one line: `host._listeners` to a wrapped handler, to
the plugin's own handler, to its closure, to a `Document`, to the editor. **Every panel a
plugin builds registers listeners that close over that tab's document, and nothing ever
removed them.** Both bundled plugins do it (`plugins/film/main.js`,
`plugins/sample/main.js`), so every document ever opened stayed alive with its whole layer
stack.

The fix is in `renderer/plugins.js`, not in the drawing code:

- listeners registered while a panel is being built belong to that panel instance
  (`buildScope`), and go when the panel does;
- `host.on("removed")` unmounts the panel of a closed tab and takes it out of `reg.els`
  and `reg.buttons`, which are Maps keyed by the editor;
- the panel's own `destroy` hook runs there too. The editor is still usable in that event:
  `removeEditor` emits it before the shell calls `destroy()`.

Because the plugins bypass the api handed to `build()` and keep the one from `activate()`,
the scope is a module variable rather than an argument: it catches the mistake whichever
object the plugin uses.

**Measured, 96 MP, four rounds of build, bench, close, forced collection**
(`python tools/mem_test.py 12000x8000 --rounds 4`, fresh instance, medians):

| | round 1 | round 4 | round 4, before the fix |
|---|---|---|---|
| pan frame | 3.6 ms | 4.1 ms | 47.2 ms |
| levels slider tick | 9.0 ms | 10.0 ms | 50.0 ms |
| live canvases after the collection | 1 (4 MB) | 7 (34 MB) | 301 (18830 MB) |
| renderer, private | 94 MB | 97 MB | 1588 MB |
| GPU process, private | 1784 MB | 1526 MB | 17617 MB |

**Three smaller things went with it**, each measured, none of them the cause:

- `GLCompositor.dispose()` **loses its context** (`WEBGL_lose_context`) and zeroes its
  canvas. A context is otherwise only dropped when its canvas is collected and Chromium
  keeps at most 16 per page. Worth about 130 MB of the floor.
- the compositor's texture cache is bounded **in bytes** (`TEXTURE_BUDGET`, 1 GB) with a
  count cap behind it, and never evicts a texture the current frame used. A count of 48 was
  meaningless: one level-0 texture of a 96 MP source is 384 MB. In practice one open 96 MP
  document holds 206 MB there.
- `ed.releaseCaches({ deep })` gives the caches back and returns the bytes; **Free VRAM**
  calls it and says "Freed N MB of caches".

**The GPU floor, and what it is.** After the leak was gone, opening and closing four 96 MP
documents left the GPU process about **1.3 GB above** its 240 MB start, flat across rounds
and scaling with the largest document seen (660 MB after 2 MP documents). It is not lost:
`releaseCaches({ deep: true })`, the surface pool plus the shared context's drawing buffer
and source texture, brings it back to **+58 MB**. So the floor is memory the GL path holds
for reuse, and the escape hatch reclaims it.

**What still costs, and is not a leak.** Four 96 MP documents *open at the same time* are
19 GB of live layer pixels, and a pan frame there costs 40 ms
(`python tools/mem_test.py 12000x8000 --rounds 4 --keep`). Nothing is retained wrongly:
close them and everything comes back within a few seconds. It is simply more than Chromium
will accelerate, and it is what the memory watch is for.

**Step 3, the escape hatch** (`renderer/shell.js` `watchMemory`): every 30 seconds, while
the GPU process is above `settings.memory.gpuLimitMB` (default 3072, the row is in
Settings › Rendering, 0 switches it off), the caches of the tabs that are not in front are
released; a tab that is busy or under the pointer is skipped, and the active document is
never touched. One console line per trigger with the numbers. `releaseCaches` deliberately
does **not** draw: a background tab that redrew there would rebuild everything it just gave
up. The `status` command reports `memory: { gpuMB, rendererMB }`, so an MCP client can see
it too.

**Hypotheses from the plan, ticked.** H1 (canvas churn on the hot path) real but small: the
GL filter path made 24 canvases holding 3 GB across four documents, all of them collected
once the retainer was gone. H2 (a closed document releases late) **wrong in its diagnosis**:
the documents were not waiting for a collection, they were reachable. H3 (texture cache
capped by count) real, 206 MB per open document, now bounded in bytes. H4 (the surface pool)
not a factor: 34.5 MB, no foreign-generation surfaces in any run. H5 (the shared GL canvas
resized per call) part of the GPU floor, released by `glReleasePool()`. H6 (context count)
fixed as a precaution. **Not built, and not needed**: `dropCanvas` and explicit canvas
ownership, undo as dirty-rect tiles, layer eviction to the mirror, the objects map at a
bounded resolution. Once nothing holds a canvas, the collector and the GPU process do the
rest within a second or two, measured rather than assumed.

**Traps worth keeping.** Reading GPU memory needs patience: the shared image behind a
collected canvas is released asynchronously, and a document that was just closed keeps its
layers until the upload `close()` started has read them. Closing four 96 MP tabs at once
held 19 GB for a few seconds and then dropped to 34 MB, so `mem_test.py` reads both numbers
until they stop falling instead of waiting a fixed time. And take the heap snapshot early:
the census tells you *what* survived, only the retaining path tells you *why*.

## 7. Benchmark and test plan

`tools/perf_test.py` (to write in phase 1): drives the dev instance through
`tools/cdp.py`, loads synthetic images at 2k, 6k and 12k on the long side with three
paint layers, one result layer with colour match and one film look filter, and measures
with `performance.now()` around `draw()` and with frame timestamps over 60 frames:

- opacity slider tick, match slider tick, filter slider tick (interactive path)
- pan (60 pointermove events), wheel zoom (10 steps), fit view
- brush stroke of 60 dabs at 40 px on a paint layer
- full-resolution composite after release, export to PNG
- autosave tick after a selection change, undo push at stroke start
- memory: `performance.measureUserAgentSpecificMemory()` and the process working set

`python tools/perf_test.py --chain [size]` is the second entry point: one document, five
stacks of filter layers, panned with the GPU filter chain on and off, with the round trip
counters from `glChainStats()` next to the times (phase 5, step 2).

`tools/mem_test.py` (phase 6) is the memory walk. It builds one 96 MP film-look document
per round, benchmarks a pan frame and a levels slider tick, closes the tab and forces a
collection, and prints one row per phase: the private bytes of the renderer and of the GPU
process, the canvases that are still alive with their total size, the compositor's
textures, the surface pool, undo, and the three timings. At the end it lists what survived,
the line that allocated it, and whether the targets held. `--rounds n` sets the number of
rounds, `--keep` leaves every tab open instead (four 96 MP documents at once), and a size
argument replaces the default `12000x8000`. It needs no ComfyUI and uploads nothing.
Restart the app before every run: the numbers drift within a session, which is the whole
reason the phase exists.

Targets: interactive frames ≤ 16 ms at 12k; full composite after release ≤ 1 s at 12k
without filters, ≤ 3 s with a film look; no synchronous main-thread block above 100 ms
outside export. Every phase also runs `tools/smoke_test.py --no-helpers`,
`tools/commands_test.py` and `tools/film_test.py` (the CPU / GPU filter twins must stay
within 3 levels).

## 9. Phase A of the tile plan (2026-09-13)

`docs/PLAN_TILES.md` phase A, the quick wins inside the current model, built and measured on
the 15,000 × 10,000 document of the 2026-09-12 entry in `docs/BUGS.md`. The node's
`DEVELOPMENT.md` §23 has the rules. Fresh instance per run; the benchmark's discrete rows
drain the GPU queue before they start (`settle()` in `perf_test.py`), because the 60 stroke
frames issued in a tight loop before them left the GPU with 1.8 GB of blits per frame and the
"undo" and "selection change" rows were measuring that backlog.

| Step, 150 MP, main thread held | before (2026-09-12) | after phase A (2026-09-13) |
|---|---|---|
| selection change | 50 to 62 ms | 5 to 6 ms |
| selection bounds scan (warm / first after a big change) | 84 ms, worst 754 | 6 ms, first 460 to 490 (the readback waits for the GPU) |
| undo of a stroke (with a film look on top) | 90 to 99 ms | 42 ms, of which about 30 is the film look's re-render of the view; without a filter layer about 10 |
| grow +16 / shrink / invert | 202 / 352 / 325 ms | 112 / 131 / 54 ms |
| feather 8 | 221 ms | 398 ms (unchanged path, noise) |
| magic wand, a bounded object | not measured (the old path floods the whole image) | 360 ms blocked, 0.8 s wall |
| magic wand, a band across the whole picture | 1049 ms, 3.3 s wall | 1062 ms, 4.2 s wall (the old one-pass path; a box above 40 % of the picture goes there) |
| bucket fill (the perf test's spot, under a matched layer and a film look) | 721 to 1646 ms | 12 to 16 ms alone, 490 to 620 in the benchmark's sequence (GPU waits of the composite of the box) |
| stroke buffer for a 400 px eraser stroke, 40 dabs | 600 MB, plus 600 MB clip, plus 600 MB clip scratch | 19 MB buffer, 19 MB clip scratch |
| live preview per stroke frame | three full-size blits (1.8 GB) | the dab's rectangle |
| the 600 MB preview canvas after the stroke | kept | given back (above 16 MP) |
| compositor textures at 1:1, a 24 MP document, two sources | 183 MB (whole sources) | 69 MB (windows), a pan inside the margin uploads nothing |
| film panel thumbnails per change | a full flatten, 1.9 s | a 192 px composite |

Findings worth more than the numbers:

- **A readback on a GPU canvas costs what is queued before it.** `getImageData` of 2048² on
  the selection canvas took 75 ms once and 658 ms the next time; the difference was the fill
  in between. So the wins came from fewer and smaller readbacks (strips instead of the box,
  the extent instead of the canvas, statistics kept instead of re-read), not from faster
  loops. It also means the op rows of the benchmark move by hundreds of ms between runs on a
  shared card; take the first run after a restart and read the wall times with them.
- **The film panel flattened the whole document at full resolution on every change**
  (`plugins/film/main.js`, 1.9 s at 15k), which is why any operation looked slower than it
  was. `Document.flatten({ maxSize, box })` composites at a size, through the same region
  pass the screen uses; the GLB dialog's backdrop uses it too.
- **A `willReadFrequently` selection canvas is not a saving**: it sits in the GPU process
  just the same in Chromium 152, fills 9× slower and reads back only a little faster.
- **`imageSmoothingQuality: "low"` on the 2:1 pyramid levels gives the same pixels** and
  measured 4 ms against 145 for the first level once, but the same measurement swung to 245 ms
  in the next round; drowned in queue waits. Not changed; worth a quiet measurement.
- **The compositor and Canvas 2D resample a level differently at a fractional zoom-out**
  (up to 50 levels on a hard edge at fit, 2 at exactly half, 1 at 1:1), with and without the
  source windows alike. `composite_test.py` reports the fit value and gates the rest.
- **A small stroke buffer starts as a software canvas** and grows onto the GPU; twenty
  overlapping soft dabs blend a few levels differently on the CPU than on the GPU. Invisible,
  but a pixel-exact gate against the old path fails without a tolerance.

### C1: the pixels behind one interface, measured at 15k (2026-09-13)

`docs/PLAN_BCE.md` §C1: every read and write of a layer's, a mask's, the selection's and the
base's pixels goes through `LayerPixels` / `MaskPixels` (a canvas underneath). The end-of-C1
check is `perf_test.py 15000x10000` within noise of the numbers above. §9 has only the rows
phase A changed, so the build before C1 (97bb94c, the 0.1.11 tag) was measured next to it on
the same card the same afternoon: each run a fresh instance with its own profile, three runs
of each build, alternating (C1 run in strict mode, which only changes what an old property
name does). Medians in ms; the op rows are main thread blocked.

| row | §9 (phase A) | before C1, 3 runs | C1, 3 runs |
|---|---|---|---|
| opacity / match / filter slider tick | | 7.5–8.1 / 7.9–9.2 / 7.3–8.1 | 6.8–9.5 / 7.9–9.6 / 7.1–8.1 |
| pan / wheel zoom | | 2.6–3.0 / 2.7–3.1 | 2.9–3.0 / 2.8–2.9 |
| redraw with ants / brush dab + frame | | 0.2 / 0.1 | 0.1–0.2 / 0.1 |
| stroke commit | | 0.7 / 0.8 / 0.8 | 1.6 / 1.2 / 1.2 |
| undo of the stroke | 42 | 48 / 44 / 40 | 479 / 48 / 42 |
| selection change | 5 to 6 | 1.4 / 1.3 / 1.2 | 1.1 / 1.4 / 0.6 |
| selection bounds scan (warm, first) | 6, 460–490 | 6.4–7.5, 505–520 | 6.7–9.0, 488–1184 |
| full composite (warm, cold) | | 6.2–7.6, 661–739 | 0.8–7.1, 686–5208 |
| grow +16 / shrink / invert | 112 / 131 / 54 | 233–296 / 210–403 / 34–44 | 105–248 / 85–332 / 33–50 |
| feather 8 | 398 | 326 / 365 / 367 | 918 / 300 / 389 |
| magic wand, the whole-picture band | 1062 | 553 / 548 / 506 | 3421 / 822 / 723 |
| magic wand, an object / bucket fill | 360 / 490–620 | 341–368 / 481–525 | 266–326 / 523–535 |
| PNG of the composite (worker) | | 16–19 | 14–56 |

**Verdict: within noise.** The first C1 run (the first in the table's C1 column) came right
after a gate run that had rendered on ComfyUI, and its undo, feather, wand and cold composite
were several times the rest; neither the build before C1, measured right after it, nor the
two C1 runs after that showed it. The two rows that stayed apart were measured again, six
times each on one document per build (`wand + feather + stroke + undo` in a loop): the band
wand 707 against 703 ms blocked, feather 312 against 309, a 60-dab stroke's commit 39.8
against 36.3 ms (ranges 29–43 and 32–43), its undo 645 against 587 (512–702 and 556–600).
The stroke commit row of the benchmark is one sample of about a millisecond and reads 0.4 ms
higher in every C1 run; the commit writes through `drawInto` with the stroke's box as a clip
since C1 step (c). The call itself costs 0.004 ms on the main thread (measured, the context
reset included); where the rest of the 0.4 ms goes was not found (the clip is the likeliest
candidate). It is below a twentieth of a frame, once per stroke, and C5 replaces that commit.
Memory: `mem_test.py 2048x1152 --rounds 1` leaves the same 50 live canvases (128 MB) and
the same GPU process margin before and after C1.

### C2: the tile store behind a flag, canvas mode against main (2026-09-14)

`docs/PLAN_BCE.md` §C2: the tile store is the second backend of the pixels interface, chosen per editor by
`ed.tileMode` (on in dev runs, off in the packaged app). The question for the merge is whether **canvas mode**
(what ships) is as fast as main c6bc6a6; tile mode is measured for the record and for C3. Every run is a fresh
dev instance with its own profile. **The harness is the branch's `perf_test.py` on both builds** (run on main
from a scratch copy): main's own has no "pan at 1:1" row and drains differently, which alone moved some worst
values 2 to 3x on the same build. Ranges over the runs; frame rows are medians [worst], operations main thread
blocked. Noise seen between runs of one build: frame medians 0.3 to 0.5 ms, worst values 2 to 3x, operations at
15k 2 to 4x; a row counts as slower only when every run of one build is above every run of the other.

**15000 × 10000** (main: 5 runs; canvas mode: 3 runs of the final code; tiles: 1 run)

| row | main | canvas mode | tiles |
|---|---|---|---|
| opacity / match / filter slider tick | 6.8–7.5 / 7.0–9.1 / 6.9–8.5 | 6.6–8.2 / 7.1–7.9 / 5.8–7.3 | 7.9 [66] / 6.3 / 7.0 |
| pan / wheel zoom / pan at 1:1 | 2.6–2.7 / 2.6–3.6 / 2.5–2.7 [310–316] | 2.6–2.7 / 2.4–3.1 / 2.7–3.0 [318–321] | 2.8 / 2.7 / 36.1 [171] |
| redraw with ants / brush dab + frame | 0.1–0.2 / 0.1 | 0.1–0.2 / 0.1 | 0.2 [458] / 0.1 [28] |
| stroke commit / undo of it | 1.1–1.6 / 40–47 | 1.0–1.1 / 41–53 | 284 / 18.7 |
| selection change / bounds scan | 0.8–2.1 / 6.0–10.3 [430–450] | 1.0–1.5 / 6.2–7.8 [435–457] | 18.9 / 10.6 [12.6] |
| full composite (warm [cold]) | 6.1–7.3 [592–643] | 6.1–7.5 [607–664] | 89 [1599] |
| grow +16 / shrink / invert / feather | 222–308 / 91–310 / 33–43 / 114–392 | 246–302 / 229–383 / 33–38 / 111–283 | 1175 / 1286 / 1519 / 1513 |
| magic wand, band / object; bucket | 511–714 / 305–472; 480–654 | 501–695 / 437–474; 482–521 | 2354 / 4424; 1134 |
| fill / clear of a 100 px selection, undo of the fill (new rows) | 665–914 / 557–605 / 1562–1564 (2 runs) | 756–900 / 554–625 / 1458–1623 | 182 / 74 / 73 |
| PNG of the composite (worker) | 6–107 | 6–12 | 13 |

**6000 × 4000** (main: 5 runs, the new rows 2; canvas mode: 2 runs; tiles: 1 run)

| row | main | canvas mode | tiles |
|---|---|---|---|
| slider ticks | 7.3–9.4 / 6.6–8.5 / 6.9–8.0 | 7.8–7.9 / 6.8–6.9 / 6.8–6.9 | 8.6 / 8.2 / 8.3 |
| pan / wheel zoom / pan at 1:1 | 2.7–2.9 / 4.1–5.1 / 2.7–2.8 [40–69] | 2.7–2.8 / 4.4–4.6 / 2.6–2.7 [41–42] | 2.6 / 3.3 / 3.1 [12.7] |
| stroke commit / undo / selection change | 0.8–1.4 / 7.7–10.6 / 0.5–1.2 | 1.0–1.2 / 8.6–9.1 / 0.6–1.3 | 35.5 / 16.3 / 4.2 |
| bounds scan / full composite | 2.3–3.7 [74–171] / 0.4–1.0 [58–67] | 2.4–3.1 [74–84] / 0.2–0.4 [62–71] | 1.1 [12] / 10.6 [174] |
| grow / shrink / invert / feather | 21–85 / 19–23 / 15–21 / 18–21 | 24–25 / 17 / 14–18 / 18–19 | 256 / 176 / 196 / 203 |
| wand band / object; bucket | 91–125 / 46–54; 85–101 | 96–100 / 50; 85–120 | 247 / 137; 113 |
| fill / clear 100 px, undo of the fill | 103–116 / 108–120 / 159–164 | 127–167 / 98–114 / 158–160 | 24 / 26 / 20 |

**Verdict: canvas mode is within noise of main in every `perf_test` row.** The rows nearest an edge (15k undo
52.7 in one run, 6000 bucket 120 in one run) are single runs whose other samples sit inside main's range. The
6000 × 4000 fill row read 127 and 167 against main's 103 and 116, so the same three operations were timed three
times each per run with the review's probe (`rvfinal_fillcost.js`, two runs of main, three of canvas mode):
8000 × 6000 fill 10.4 to 26.7 ms main thread against 10.4 to 12.6 on main (with the GPU drain 59 to 141 against
77 to 143), 12000 × 8000 fill 20 to 57 [543 to 880] against 21 to 56 [591 to 887], the undo 540 to 861 against
548 to 983: the same. The canvas-mode fill, clear and undo of the fill run exactly main's code (a PNG undo step and a whole-image write
on that backend), which is why they cost what main's do: C4 turns those steps into tile references. The first
15k canvas run in the step (b) measurement (undo 520, band wand 3348, bucket 1156, cold composite 3691) did not
come back in six canvas runs since.

**What `perf_test` does not measure, and was slower on the branch before the final review** (`c2/cm`,
`c2/cf` in the session scratchpad):

| selection drag per pointer move, zoom 0.6 | main | branch before (b510dc1) | final |
|---|---|---|---|
| 15k, GPU wait per move (`seldrag2.js`, no filter / filter) | 6.3–6.5 / 7.0–7.2 | 43.9–46.3 / 34.2–34.9 | 6.5–8.8 / 7.4–7.8 |
| 6000 × 4000, the same | 6.3–6.5 / 6.7–6.8 | 8.7–10.6 / 10.6–12.0 | 6.3–8.8 / 6.5–9.0 |
| 15k, selection canvas on the CPU (`seldrag.js`): handler / GPU wait | 118–131 / 717–788 | 156–171 / 733–765 | 123–126 / 750–781 |
| 6000 × 4000, the same | 17.2–19.2 / 100–109 | 20.6–23.7 / 108–113 | 18.6–19.3 / 98–104 |
| the fixer's zoom-in script reaches Blink's canvas acceleration latch | 0 of 3 | 6 of 7 | 0 of 3 |

The branch refreshed the selection's four display levels (built by the pointer-down's undo step) on every move
and, on a CPU selection canvas, cleared the image twice per move; canvas mode runs main's rewrite again.

**Tile mode, the fixes of the final review** (a 100 px selection on a paint layer, `rvfinal_fillcost.js`,
main thread ms, three samples; the canvas backend's numbers with a GPU drain in brackets):

| | before | region only | final (region, level refresh in the box) | canvas backend |
|---|---|---|---|---|
| fill, 12000 × 8000 | 705–1111 | 206–288 | 2.0–2.1 (first 97) | 21–57 [182–275] |
| clear, 12000 × 8000 | 457–607 | 207–235 | 2.1–4.7 | 1.7–20 [46–154] |
| undo of the fill, 12000 × 8000 | 829–1135 | 243–279 | 18.5–22 | 310–478 |
| fill / clear / undo, 8000 × 6000 | 419–443 / 302–377 / 455–456 | 105–139 / 105–110 / 138–143 | 2.7–3.2 / 2.5–5.0 / 12–13 | 10–12 / 2–12 / 143–154 |

The review's 20000 × 12000 script on tiles (a base, a full paint layer and its duplicate at 1:1, fills, a flip,
exports, extend, flatten, each undone): before, the flip's PNG undo step failed to encode ("Readback of the
source image has failed") at 19.6 GB of renderer memory and the sync, the exports and flatten failed after it;
after, every step passes, the renderer at the flip 15.9 GB and at its peak 18.7 GB (the four mirrors, 3.66 GB,
and the screen's 4.9 GB of GPU copies at 1:1 stay for C3). A flip of a 16000 × 12000 layer in bands 1.2 to
1.6 s, a turn 1.8 to 2.0 s, against 1.7 to 2.2 s for the canvas path it replaced.

**Memory** (`mem_test.py 12000x8000 --rounds 2`, step (b)'s code, unchanged by the review in canvas mode): GPU
process after free 449 MB in two canvas runs against 451 on main (a third canvas run 813, not repeated); tile
mode holds the layers in the renderer (3.55 GB built against 0.49 GB) and five times the compositor's texture
bytes (1033 against 202 MB); after close and a collection both return to 3 live canvases.

### C3 steps (a) and (b): the compositor draws tiles (2026-09-14)

`docs/PLAN_BCE.md` §C3 "C3 as built" has the decisions. Measured on the dev instance in tile mode,
15000 × 10000, `perf_test.py`, first run after a restart. The benchmark's document always carries a
filter layer, so its old frame rows stay on the Canvas 2D path and are unchanged by C3; three rows
were added that hide the filter layer, so the GPU compositor takes the stack:

| row (15000 × 10000, tiles) | before C3 (main 2462b30~1) | after |
|---|---|---|
| pan at 1:1, GPU stack (30 frames, median) | 0.1 ms [0.2] | 0.1 ms [0.2] |
| pan at fit, GPU stack | 0.1 ms [0.2] | 0.3 ms [3.7] |
| **first frame fit → 1:1, GPU** | **1026.9 ms** | **34.9 ms** |
| pan at 1:1, Canvas 2D (a filter layer in the stack) | 40.2 ms | 41.1 ms |
| compositor memory for the document | a 600 MB CPU mirror per source plus a GPU copy of it | 91.3 MB in 43 atlas pages (9,541 slots) + 32.3 MB of source textures |

Read it this way: the **steady** pan was already cheap before C3, because C2's review gave the screen
a cached GPU copy of each tile mirror. What C3 removes is the *making* of those two full-size
canvases — which is a whole second the first time the view reaches 1:1 — and the gigabyte they hold
afterwards. The pan at fit costs 0.2 ms more than the single cached level canvas did: 2,400 instanced
tiles a frame against one textured quad. Rebuilding the instance buffer per frame cost 1.9 ms, which
is why the tile rectangles are in image coordinates and the region is a uniform (§C3 "as built").

Unchanged by C3 and still the tile backend's cost: everything that goes through Canvas 2D (a filter
layer in the stack, a live stroke, a transform, compare / peek, exports and runs) still draws the
display mirror, so `pan at 1:1` stays at 41 ms and the mirror is still made for those paths. That is
the next step of C3.

**Step (c), the selection's overlay** (same document and machine):

| row (15000 × 10000, tiles) | before | after |
|---|---|---|
| `redraw with ants`, worst frame | 391 to 479 ms | 70 to 73 ms |
| the document's display pyramids | 955.8 MB | 768.1 MB |
| the selection's own display | a pyramid of the whole mask | one region canvas, 9.2 MB |

The median of that row is 0.1 ms either way: what cost hundreds of milliseconds was the frame that
*built* the selection's display levels, and the ants rebuild them after every selection change.
`perf_test.py`'s footer now prints what the display costs on tiles — on this document still
**6 mirrors, 2877 MB** and 768 MB of pyramids, all of it the Canvas 2D path's, which is what the rest
of C3 has to move.

**Step (d), the Canvas 2D path** (the same document; every frame of it is Canvas 2D, because the
benchmark's stack carries a `film.look` filter layer):

| row (15000 × 10000, tiles) | before | after |
|---|---|---|
| pan at 1:1 (30 frames, median) | 41.1 ms | 2.5 ms |
| opacity slider tick | 56.5 ms | 8.0 ms |
| selection change | 103 ms | 21 ms |
| undo step | 66 ms | 18 ms |
| selection bounds scan | 11.4 ms | 2.0 ms |
| the document's display pyramids | 768.1 MB | 196 MB |

and A/B on one document (a 15k base, one full paint layer, a filter layer), the same build with the
branch on and off: the first three draws at fit 0.2 / **341** / 0.3 ms → 0.1 ms each, the first frame
of a brush stroke 218 → **355** ms. So 559 ms of stalls became 355 in one place: the live stroke's
preview still copies the layer's display mirror into a full-size canvas, which is C5's. That is the
last mirror the screen makes; the op rows of this run are not comparable with the ones above, because
ComfyUI was holding the card by then (`stroke commit` measured 845 ms with the branch on **and** off).

**Pixel agreement.** `composite_test.py` compares the two paths at 1:1 now as well: on tiles the
compositor agrees with Canvas 2D to **1 level** there, over the whole test document (nine blend
modes, a masked layer, a colour-matched one, a text layer, after an erase). At a fractional zoom the
two differ by design — alpha-weighted box mips per tile against Skia's bilinear halvings of the whole
canvas — up to **42 levels** on a hard edge at fit, 2 at an exact halving; that row is reported, not
gated, as §9's `fit` row already was.

## 10. Phase B: the Rust spike (2026-09-13)

`docs/PLAN_BCE.md` §1, built on the branch `px-spike` (commits fe9bf0e B0 to 8ab3706). Five
kernels in Rust (`crates/px`, `wasm32-unknown-unknown`, rustc 1.98.1, a SIMD128 and a scalar
build, plain `extern "C"` exports) and their JS twins (`renderer/editor/px/kernels_js.js`, the
same signatures, the same bytes out: `tools/px_test.js` compares every kernel of both builds
with its twin byte for byte, and the twins with today's `distanceTransform` / `floodMask` and
with first principles). Benchmark `renderer/editor/px/bench.js`, run by `tools/px_bench.js`
(Node) and `tools/px_bench.html` (browsers, served cross-origin isolated). Ryzen 9 7900X3D,
nothing else running, five runs each after two warm-ups, median; a short kernel is repeated
until a run lasts 25 ms.

**Before any number was believed**, an adversarial review of the kernels (three lenses,
every finding verified by a second agent) found the comparison unfair in both directions,
and both were fixed first (commit 3fd468a): the JS mip twin read RGBA byte by byte (a word
version gives the same bytes 1.8× faster, and the rule row had cleared 3× only because of
it); the JS composite twin chose its operator per pixel (1.4 to 1.6×); the Rust SIMD mip path
decided "opaque" per row, so a paint layer lost to its own scalar build; ImageData's
`Uint8ClampedArray` mixed with `Uint8Array` levels made the twins' element access polymorphic
(1.7 to 2× in Electron's V8; every twin now views its input as `Uint8Array`).

**Columns.** "JS twin", "Rust scalar" and "Rust SIMD128" time the kernel alone, with its data
already where it runs; "copy" is what a caller with JS-side tiles pays on top (inputs into wasm
memory, result out); **speed-up = JS ÷ (SIMD + copy)**, the figure the rule reads. The main
columns are the **Electron 44 renderer** (Chromium 152, V8 15.2, a focused window: see the
efficiency mode below), the Firefox columns are Firefox 155. The two rule rows are bold; they
were fixed before the first run: the mip chain of one **opaque** 256 tile (a photo base, 2,352
of them at 15k) and the EDT of a 4,096² band.

| kernel | input | JS twin ms | Rust scalar ms | Rust SIMD128 ms | copy in + out ms | speed-up | without copy | Firefox JS ms | Firefox SIMD ms | Firefox speed-up |
|---|---|---|---|---|---|---|---|---|---|---|
| **mip chain** | one 256² tile, opaque (photo base) | 0.075 | 0.059 | 0.033 | 0.005 | **1.97×** | 2.23× | 0.093 | 0.019 | 4.04× |
| mip chain | one 256² tile, paint layer (soft alpha) | 0.080 | 0.050 | 0.033 | 0.005 | 2.10× | 2.39× | 0.102 | 0.024 | 3.52× |
| mip chain | a tile column at 96 MP (32 tiles) | 2.51 | 2.07 | 1.18 | 0.289 | 1.71× | 2.13× | 3.96 | 0.606 | 4.51× |
| mip chain | a tile column at 150 MP (40 tiles) | 3.69 | 2.75 | 1.58 | 0.468 | 1.80× | 2.33× | 4.11 | 0.797 | 3.22× |
| mip halving | whole layer at 96 MP (12,000 × 8,000 → level 1) | 92.8 | 69.3 | 40.1 | 19.8 | 1.55× | 2.31× | 109 | 21.2 | 2.66× |
| mip halving | whole layer at 150 MP (15,000 × 10,000 → level 1) | 143 | 109 | 58.5 | 30.2 | 1.62× | 2.45× | 180 | 39.8 | 2.56× |
| **distance transform** | 4,096² band (grow / shrink / feather) | 213 | 106 | 93.5 | 3.31 | **2.21×** | 2.28× | 210 | 93.1 | 2.18× |
| distance transform | whole selection at 96 MP | 1,101 | 604 | 544 | 19.2 | 1.96× | 2.03× | 1,243 | 556 | 2.15× |
| distance transform | whole selection at 150 MP | 1,792 | 956 | 872 | 30.7 | 1.99× | 2.06× | 1,929 | 836 | 2.22× |
| flood fill | 4,096² region, contiguous, tolerance 32 (8.5 MP filled) | 129 | 44.4 | 44.0 | 3.40 | 2.72× | 2.93× | 206 | 51.7 | 3.72× |
| composite | 4-layer stack over one 256² tile (over, over + mask, erase, atop) | 1.35 | 1.06 | 0.269 | 0.021 | 4.68× | 5.04× | 1.53 | 0.257 | 5.51× |
| PNG rows (filter) | 4,096 × 256 band | 37.1 | 27.5 | 19.1 | 0.315 | 1.90× | 1.94× | 49.5 | 20.5 | 2.38× |
| PNG rows (deflate) | the filtered band (4 MB), zlib level 6; JS is `CompressionStream("deflate")` | 161 | 224 | 226 | 0.141 | 0.71× | 0.71× | 104 | 225 | 0.46× |
| tile size | mip chain of one 512² tile (5 levels, to 16²) | 0.341 | 0.255 | 0.137 | 0.022 | 2.14× | 2.48× | 0.385 | 0.072 | 4.08× |
| tile size | one stroke tile over a layer tile, 256² (a 400 px dab touches 4 to 9, on average 6.56) | 0.239 | 0.216 | 0.069 | 0.008 | 3.10× | 3.47× | 0.244 | 0.069 | 3.16× |
| tile size | one stroke tile over a layer tile, 512² (a 400 px dab touches 1 to 4, on average 3.16) | 1.01 | 0.856 | 0.276 | 0.032 | 3.27× | 3.65× | 1.10 | 0.249 | 3.91× |

Node 24.18 (V8 13.6), the plan's own measuring environment, agrees with the renderer: mip
chain of the opaque tile JS 0.090 / SIMD 0.033 / copy 0.005 ms, **2.38×**; EDT band JS 202 /
SIMD 95.9 / copy 3.95 ms, **2.02×**; composite 4.84×; flood 2.61×; PNG deflate 0.71×. Five
repeated fresh-process runs of the two rule rows in Node: mip 2.24 to 2.74×, EDT 1.84 to 2.04×.

The two rows that are not kernels:

- **256 against 512 tiles.** A 400 px dab costs 6.56 × 0.239 = 1.57 ms of JS composite at 256
  and 3.16 × 1.01 = 3.18 ms at 512 (with Rust 0.51 against 0.97 ms); the mip chain costs 1.14 ms
  per MP at 256 and 1.30 at 512. 256 wins both, and keeps the finer undo. **Tile size 256.**
- **The boundary copy**: one 256² tile into wasm memory and its result out, 0.007 to 0.008 ms
  in every engine, against 0 for a tile that already lives there. That is 4 to 15 % of the
  kernels above, and it is only that small because of the next finding.

Findings worth more than the numbers:

- **The EDT cannot be decided by SIMD.** About 70 % of it is Felzenszwalb's lower envelope, a
  data-dependent loop over a stack of parabolas that neither build vectorises (the column
  sweeps do vectorise, which is the small scalar-to-SIMD step). What the column measures is
  wasm scalar code against V8: 2.0 to 2.3×, the same in Chromium, Firefox and Node. A variant
  with the envelope in f32 (allowed by the plan's 1e-3) measured 2.4× in a scratch build. The
  plan's expectation that the EDT "should clear 3× as arithmetic over contiguous bytes" was
  wrong for this algorithm. The twin itself is 2.3× faster than today's `distanceTransform`
  (213 against 494 ms on the band): C gains that either way.
- **V8's efficiency mode moves the JS column by 1.5 to 2×, and only the JS column.** Chromium
  switches it on for a renderer that is not in front (V8 then holds back optimised
  compilation); wasm code is not affected. The same page in an Electron window that opened
  behind others measured the rule rows at mip 2.95 to 3.15× and EDT 3.36 to 3.88× (five of six
  fresh launches; the sixth opened in front and measured 2.13× and 2.48×);
  forced with `--js-flags=--efficiency-mode` 2.87 to 3.25× and 3.54 to 3.65×; with
  `--no-efficiency-mode` 1.83 to 1.97× and 2.29 to 2.42×; in a focused, always-on-top window
  without flags 1.92 to 1.99× and 2.05 to 2.22×. The interactive case is a window in front, so
  the table above uses it. The consequence for C and E: **JS work that runs while Scumble is
  not in front (an export the user waits out in another window, a headless MCP session) runs
  at about 60 % speed**; wasm would not. That is the one place a Rust kernel could be worth a
  second measurement later (E's band export in workers), not a reason to overturn the rule.
- **4K aliasing made the boundary copy 16× dearer.** A 256 KB `TypedArray.set` from a JS tile
  into a `px_alloc` block measured 53 to 66 µs in Chromium, Firefox and Electron's Node mode
  and 3.5 µs in Node, and not for every block. Cause: dlmalloc hands out a page start plus its
  8-byte header, a tile-sized ArrayBuffer starts on a page, so the destination lies 8 bytes past
  the source modulo 4,096 and every store of the copy waits for a false dependency (on one
  buffer: 56 µs at a distance of exactly 8 mod 4,096, 3.2 to 3.8 µs at every other distance).
  Blocks of 16 KB and more now start on a page (commit 5226689). **Rule for C and E: tile
  buffers that are copied into each other (the SAB arena, worker transfers, a wasm heap) start
  on a 4 KB boundary.**
- **Native deflate wins.** `CompressionStream("deflate")` is 1.4× (Chromium) to 2.2× (Firefox)
  faster than miniz_oxide at the same level: E2's PNG writer streams through it, as planned.
  The PNG filter row is JS 37 against SIMD 19 ms for a 4,096-wide band, 1.9×.
- **Today's `floodMask` beats the flood twin** (67 against 129 ms in the renderer, 112 against
  130 in Node): the twin's typed span stack, its `fill` per span and its non-inlined
  comparison cost more than the original's array stack. C keeps `floodMask`'s structure for
  the wand (with `sampleRegion`'s bounded box) and the twin is not the reference there.
- **Firefox runs the SIMD mips 1.7× faster than V8** (0.019 against 0.033 ms a tile) and its JS
  twins slightly slower; the node's Firefox users would see the largest Rust gain, but not on
  the EDT (2.2×).

**Decision (the plan's 3× rule, both rows, copy included): the EDT band is 2.0 to 2.2× and the
opaque mip chain 2.0 to 2.4× in the interactive V8 (Electron renderer in front, Node), and the
EDT 2.2× in Firefox, so neither clears 3×: phase C is built with the JS kernels, the twins in
`kernels_js.js` are its kernels (flood excepted, above), tile size 256, tile buffers on page
boundaries, and the crate is deleted from the branch.** The Rust code stays reachable in the
history of `px-spike` (commit c75c4f1 is the last one that has it, with the benchmark
`renderer/editor/px/bench.js`, `tools/px_bench.js` and `tools/px_bench.html`).

## 11. Phase C, the tile engine, where it stands (2026-09-16)

The rows of §9's table on the same synthetic 15,000 × 10,000 document (`tools/perf_test.py 15000x10000`, base, three
full-size paint layers, a 2048² colour-matched result, a film look), tile engine on, on the tree after C4
(`dist/gates/gates/s4-perf-after2`; `docs/PLAN_BCE.md` §C3 to §C6 and "C4 as built" hold each step's A/B). Main thread
held, milliseconds; the benchmark's discrete rows swing by a factor of 2 to 10 between runs on a shared card.

| Step, 150 MP | 2026-09-12 (before A) | after phase A | tiles, 2026-09-16 |
|---|---|---|---|
| pan (fit / 1:1, Canvas 2D path with the film look) | 8.3 ms | - | 2.6 / 2.7 ms |
| pan on the GPU stack (1:1 / fit) | - | - | 0.2 / 0.3 ms |
| first frame after a zoom to 1:1 | 58 ms, once 320 | - | 1.2 ms (GPU stack) |
| brush dab and its frame | - | - | 1.2 ms |
| stroke commit | 13 ms | - | 20 ms |
| selection change | 62 ms | 5 to 6 ms | 21 ms |
| undo of a stroke | 99 ms | 42 ms | 26 ms |
| selection bounds scan | 83 ms, worst 754 | 6 ms, first 460 to 490 | 2 ms, worst 22 |
| grow +16 / shrink / invert / feather | 321 / 180 / 70 / 135 ms | 112 / 131 / 54 / 398 ms | 223 / 238 / 941 / 251 ms |
| magic wand, a band across the picture / an object | 2076 ms | 1062 / 360 ms | 1803 / 688 ms |
| bucket fill | 1646 ms | 490 to 620 ms | 623 ms |
| PNG of the composite (worker) | 274 ms | - | 61 ms |
| full composite (warm) | 9 ms | - | 99 ms, worst 2287 |
| screenshot 1024 / prompt context | about 2 s each | - | 40 / 68 ms |
| film point add under a film look | - | - | 2174 ms (a whole flatten below the points) |

Memory (`tools/mem_test.py 15000x10000 --rounds 4`, `dist/gates/gates/c7-mem-tiles` and `-canvas`), one such document
built per round, then closed and collected:

| | canvases (tile engine off) | tiles |
|---|---|---|
| renderer, document open | 0.7 GB | 3.1 to 4.3 GB |
| GPU process, document open, above its start | +6.1 to +6.7 GB | +0.6 to +1.4 GB |
| GPU process after the fourth close and a collection, above its start | +297 MB | +199 MB |

What moved and why: the display mirrors and Skia pyramids (C3, C5, C6 c), the undo copies (C2, C4) and the full-resolution
readers of small pictures (C6 c) are gone on tiles; the pixels moved from GPU canvases into renderer memory. The rows that
got slower than phase A's (selection change, invert, the band wand, the full composite) read or write the whole picture;
that is phase E's (full resolution per tile and a worker pool). §C7's own memory bound (at most 300 MB of GPU process per
open document, the renderer within 1.2× the tile bytes) is not met; `mem_test.py` does not report the tile bytes yet.

## 12. Phase R: the kernels where they run (2026-09-17)

`docs/PLAN_BCE.md` §2b. Phase B's crate is back (`crates/px`, rustc 1.98.1, both builds byte for byte as at c75c4f1, plus
`clamp_extend` for edge tiles, ABI 2), and the editor's worker can run its pixel kernels from `px/px.wasm`
(`InpaintEditor.kernels = "rust"`, off by default; the loader is imported only then). `tools/px_jobs.py` runs the real
jobs through the editor on a 15,000 × 10,000 document (a gradient base with discs and a full-size paint layer), JS and Rust
alternating by round, and checks at 2,048 × 1,152 that both give the same bytes (every chain, the selection after grow,
shrink and both wands, the composited band). A mutation of each Rust path (the flood's tolerance off by one, the edge
tiles' clamp left out, one EDT value) turned that check red.

**Rule (B's):** Rust where the kernel is at least 3× its JS twin, copies included, on the real job. The JS column uses
the twin everywhere (see below for the grow job, which did not). Medians of three rounds, two runs on fresh instances,
Ryzen 9 7900X3D; **the window was not in front in either run**, which slows the JS column only (V8's efficiency mode, §10)
and so favours Rust. "kernel" is the kernel's part of the worker job (for Rust with the copies into and out of wasm
memory), "job" the whole worker job, "wall" the operation on the main thread.

| job at 15,000 × 10,000 | kernel JS ms | kernel Rust ms | kernel | job JS / Rust ms | job | wall JS / Rust ms | wall |
|---|---|---|---|---|---|---|---|
| mips, every base tile (2,360 in 19 batches) | 503 / 537 | 407 / 353 | **1.24× / 1.52×** | = kernel | | 958 / 973, 859 / 903 | 0.95 to 0.98× |
| mips after a whole change (2,301 chains, until settled) | 554 / 677 | 394 / 320 | **1.41× / 2.12×** | = kernel | | 1,898 / 1,679, 1,900 / 1,432 | 1.13 to 1.33× |
| grow +16, 24.4 MP box (EDT) | 288 / 274 | 127 / 120 | **2.28× / 2.28×** | 676 / 465, 734 / 417 | 1.45 to 1.76× | 922 / 671, 1,054 / 618 | 1.37 to 1.71× |
| shrink −16 (EDT) | 327 / 316 | 134 / 129 | **2.43× / 2.44×** | 581 / 444, 730 / 436 | 1.31 to 1.67× | 805 / 689, 981 / 690 | 1.17 to 1.42× |
| wand, a band across the whole picture (153 MP flooded) | 741 / 751 | 554 / 541 | **1.34× / 1.39×** | 2,492 / 2,232, 2,506 / 2,227 | 1.12× | 4,661 / 3,880, 4,132 / 3,719 | 1.11 to 1.20× |
| wand, a bounded region (3.1 MP) | 2.6 / 3.5 | 2.3 / 2.4 | 1.13× / 1.46× | 40 / 35, 37 / 34 | 1.10 to 1.15× | 432 / 501, 658 / 472 | 0.86 to 1.39× |
| **composite band**, one tile row (59 tiles, 4 layers over the base) | 148 | 30.5 | **4.85×** | = kernel | | 149 / 32 | 4.72× |

(Two figures in a cell are the two runs; the band ran in the second only.) Parts of the jobs, JS / Rust, second run:
grow reads the box 125 / 113 ms, scans its bounds 44 / 40, builds the feature 36 / 35, writes 52 / 53, scans the result's
bounds 42 / 43; the whole-picture wand reads 747 / 707 ms, flood 751 / 541, bounds 231 / 261, the shape canvas 770 / 782.

What the numbers say:

- **Mips are not a kernel question any more.** B measured the chain alone at 0.075 against 0.033 ms a tile; in the job it
  is 0.21 to 0.23 against 0.14 to 0.17 ms, because each chain is a new 87 KB buffer (both sides) and the tile's bytes
  arrive by transfer. The wall time of a whole change is the scheduler, the landings and the frames; Rust moves it by 0.95
  to 1.33×.
- **The EDT stays at B's 2.3 to 2.4×** (the lower envelope does not vectorise, §10), and it is under half of the grow
  job: the rest is reading the selection out of a canvas and four byte scans, the same in both.
- **The flood is a quarter of the wand**: reading 150 MP out of a canvas, the bounds scan and the shape canvas are the
  other three quarters, and `floodMask` is already faster than the twin B wrote (§10). A Rust flood makes the wand 1.1×.
- **Memory**: a Rust flood copies the picture into the worker's wasm memory (600 MB plus the mask and the span stack at
  15k), and wasm memory never shrinks: the editor's worker would keep about 0.8 GB for the rest of the session.
- **The composite clears the rule on the real tiles** (4.85×, B measured 4.68× on random ones): E2's band composite is
  the one kernel phase E builds on Rust.

That was the decision by B's 3× rule. **The user overruled the rule the same day: Rust wherever it is faster, however
little; JS only where Rust is slower.** So every kernel above went to Rust, and the loops around the EDT and the flood,
which the table shows to be most of those jobs, went with them.

### 12.1 Rust by default (2026-09-17)

- `renderer/editor/px/kernels.js` is the kernel module the editor imports (the tile store, `inpaint_raster.js`, the worker):
  the Rust build once this thread has loaded it (the window and each worker load their own instance when the module is
  imported), the JS twins before that and wherever wasm cannot load. The window's CSP gained `'wasm-unsafe-eval'`.
- **Whole jobs in one call** (`crates/px/src/jobs.rs`): `grow_mask` is `growMask` and the bounds scan of its result;
  `flood_shape` is the flood, the clip to the selection, the count, the bounds and the shape's pixels, written over the
  picture's own buffer, which `putImageData` then takes as an `ImageData` over wasm memory without a copy.
- **wasm memory never shrinks**: after a call that grew an instance past 256 MB (a whole-picture flood at 15k takes about
  1.4 GB with a selection clip) the thread replaces it with a fresh instance of the same compiled module
  (`releaseIfLarge`), and the old memory is collected.
- The Rust `deflate_zlib` (miniz_oxide) is gone: `CompressionStream` was faster (§10). The crate has no dependency left,
  and `tools/build_px.py` remaps paths, so the binaries hold no path of the machine that built them; a build in another
  folder gives the same bytes, and `build.yml` checks the committed ones against the source.
- The node ships `px/kernels.js`, `px/px.js` and `px/px.wasm` (`tools/build_node.py` copies the binary).

`tools/px_jobs.py` at 15,000 × 10,000 on a fresh instance, "js" forcing the twins in every thread (window not in front):

| job | pixel work JS / Rust ms | | worker job JS / Rust ms | | wall JS / Rust ms | |
|---|---|---|---|---|---|---|
| mips, every base tile | 517 / 378 | 1.37× | 517 / 378 | 1.37× | 1,009 / 718 | 1.41× |
| mips after a whole change | 616 / 329 | 1.87× | 616 / 329 | 1.87× | 1,729 / 1,659 | 1.04× |
| composite band (59 tiles) | 165 / 27 | 6.10× | 165 / 27 | 6.10× | 177 / 28 | 6.28× |
| grow +16 | 518 / 185 | 2.80× | 847 / 313 | 2.71× | 1,040 / 573 | 1.81× |
| shrink −16 | 510 / 170 | 2.99× | 685 / 290 | 2.36× | 966 / 578 | 1.67× |
| wand over the whole picture | 1,606 / 687 | 2.34× | 2,630 / 1,391 | 1.89× | 4,572 / 3,058 | 1.50× |
| wand, bounded region (six rounds of its own) | 19 / 5.3 | 3.61× | 69 / 52 | 1.33× | 161 / 145 | 1.11× |

"Pixel work" is everything a job does after reading its pixels out of a canvas and before writing them back (for the wand
the selection read and the shape's `putImageData` included). What is left is Chromium's: `getImageData` of the picture
(0.7 s of the whole-picture wand), `putImageData`, and the scheduler and landings of the mips. The bounded wand's wall in
the full run (670 / 765 ms) followed the whole-picture wand's chains; alone it is the row above.

Gates: `node tools/px_test.js` (every Rust kernel of both builds against its twin, `grow_mask` against `growMask` +
`maskBounds`, `flood_shape` against `floodMask` + clip + count + bounds + shape; a mutation of each whole-job kernel red),
`px_jobs.py --check` (the same bytes from both kernel sets in the app), `run_gates.sh` with the tile engine on and off.

**Found on the way:** grow and shrink still ran the old `distanceTransform`, not the twin C was meant to take from B. They
run the twin now (the same f32 values, `tools/px_test.js`): a 6,032 × 4,032 band, the grow job's at 15k, takes 255 to 304
ms against 538 to 575 in Node.

## 13. Phase E: files from rows, documents above the canvas limit (2026-09-17)

`docs/PLAN_BCE.md` §3 ("E1 as built", "E2 to E5 as built") has what was built and why it is not the plan's worker
compositor. The numbers, this machine (8 pool workers), the user's ComfyUI holding the card throughout:

| | before E | E |
|---|---|---|
| mips settled after a whole change of a 15k layer, fit / 1:1 [longest block] | 394 / 320 ms | 137 / 127 ms [51 / 45] |
| 2,352 mip chains through the pool: by arena slot / by copy | | 59 ms / 123 + 78 ms |
| a full 15k paint layer as a PNG (autosave, upload) [longest block] | 1.2 s [186 ms] | 0.78 s [6 ms] |
| 15k composite as a PNG, 3 paint layers + levels | 3.4 s [2.4 s] | 6.2 s [0.7 s], 11 MB against 37 MB |
| the same with the film look | 8.2 s [3.1 s] | 9.5 s [1.2 s] |
| 6000 × 4000 PSD, 3 layers | 1.07 s, blocked | 0.76 s |
| deflate of a filtered 4 MB band, one thread: miniz_oxide level 1 / 2 / 3 / 6 (ratio) | | 55 / 47 / 88 / 308 ms (0.416 / 0.349 / 0.353 / 0.327) |
| 30000 × 20000: open from a 1.1 GB PNG / PNG export / PSD export (3.7 GB) | refused | 9.6 s / 10.5 s / 13.7 s |
| … grow 16 / invert / invert back (blocked) | | 48 ms / 0.53 s / 1.2 s |

Where a band's time goes (15000 × 256 rows, `tools/export_test.py --perf`): the region pass builds a region canvas per
layer from its tiles (`putImageData`, about 40 ms a layer for the two bands it covers), the draw into the CPU canvas
5 ms, the read 10 to 25 ms; 130 ms a band on average with four layers, 5.2 of the 6.2 s. The pool is not the limit: eight
workers deflate 600 MB in about a second. `perf_test.py`'s other rows are within their noise of the run before E (the
wand's whole-image band read 2.1 to 7.0 s in three runs of one build while ComfyUI ran a job, and 3.5 s on the commit
before in the same minute).

## 14. Phase N1: what the browser still costs (2026-09-17)

`docs/PLAN_BCE.md` §3b. Nothing was built; two measuring tools were: `tools/native_test.py` (the rows, split) and
`tools/native_limits.py` (the memory limits). Each run on a fresh offline instance with its own profile, tiles on, Rust
kernels, Ryzen 9 7900X3D, 95 GB of RAM, RTX 5090 (ComfyUI idle, holding 17 GB of the card), the window not in front.

**How a row is split.** The main thread from a CPU profile of the row (CDP `Profiler`, 0.5 ms samples; V8 names the
browser's natives, so `getImageData` is a frame of its own): *browser 2D* is time inside Canvas 2D, ImageBitmap and Blob
natives; *copies* is the self time of the functions that only move tile bytes into and out of an `ImageData`
(`regionCanvas`, `imageDataOf`, `_putBlock`, `releaseScratch`, `readBand`); *GPU* is time inside WebGL calls, `getError`
among them, which is where the thread waits for the GPU process; *pixel JS* is pixel loops in JS on the main thread;
*idle* is waiting for workers, the decoder or the GPU process. Workers from the `timing` parts of their jobs, summed over
the workers (CPU time, not wall): pixel work against reads and writes of canvases inside the worker. Wrappers around the
same calls count the bytes. The profiler costs nothing measurable (a run without it: every row within 5 %, bar the noise
of the exports). Milliseconds.

### 15,000 × 10,000 (150 MP; a base from a 276 MB PNG, one full paint layer)

| row | wall | longest block | main: browser 2D | main: copies for it | main: GPU | main: pixel JS | main: rest | main idle | worker: pixel work | worker: canvas I/O | browser share of the wall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| open the PNG (image element, then 13 reads) | 3,158 | 2,102 | 1,737 | 139 | 86 | 0 | 516 | 958 | 541 (mips) | 0 | **59 %** (+ the decode, in idle) |
| pan / zoom, 160 frames | 315 | | 13 | 3 | 65 | 0 | 304 | | | | none: 0.1 to 0.5 ms a frame, 11 ms when every frame brings new tiles |
| a stroke of 60 dabs and its release | 279 | | 240 | 21 | 1 | 0 | 44 | | | | 94 % of little: 1.6 ms a frame, release 77 ms |
| grow +16 (24 MP box) | 722 | 206 | 162 | 38 | 31 | 69 | 57 | 516 | 315 | 160 | **50 %** |
| shrink −16 | 603 | 201 | 157 | 33 | 12 | 41 | 52 | 410 | 190 | 162 | **58 %** |
| invert | 204 | 204 | 4 | 0 | 0 | 169 | 49 | | | | 2 % (the loop is JS on the main thread) |
| wand, a band across the picture (58 MP selected) | 4,218 | 1,626 | 2,029 | 273 | 1,114 | 96 | 116 | 740 | 531 | 1,274 | **about 85 %** (pixel work 627 of 4,218) |
| wand, one disc | 133 | 61 | 35 | 55 | 0 | 6 | 24 | | 6 | 33 | about 90 % of little |
| a provider run's crop and stitch (1024 px selection) | 2,485 | 2,485 | 57 | 4 | 0 | 2,430 | 27 | | | | 2 % (`dilate` in `stitch.js`: 1,901) |
| export PNG (235 MB) | 3,510 | 191 | 1,758 | 1,014 | 9 | 0 | 530 | 319 | 9,641 (8 workers) | 0 | **79 %** |
| export PSD (925 MB) | 3,861 | 147 | 1,599 | 875 | 0 | 0 | 897 | 609 | 12,580 | 0 | **64 %** |

Bytes that crossed, from the wrappers: the wand reads 572 MB out of canvases on the main thread (12 `getImageData`) and
the same picture again in the worker, makes two ImageBitmaps of 583 MB, and writes 1,236 MB back in 4,666
`putImageData`; an export writes 1.8 GB of tiles into region canvases (`putImageData`), draws 4 GB of sources and reads
572 MB back; opening reads 572 MB in 13 pieces; grow reads 93 MB twice and writes 203 MB in 854 pieces. Messages to workers
carry no pixels any more (E1's arena): 0.0 MB cloned on every row.

### 30,000 × 20,000 (600 MP, above every canvas; a 1.1 GB PNG, a sparse paint layer)

| row | wall | longest block | main: browser 2D + copies | main: GPU | main: pixel JS | worker: pixel work | worker: canvas I/O | browser share |
|---|---|---|---|---|---|---|---|---|
| open through the stream reader | 9,640 | 159 | 610 | 102 | 329 | 7,397 (`png_read`, one worker: the browser's inflater and, in JS, the row filters; corrected in `docs/PLAN_BCE.md` §3b "B item 5 as built") + 1,584 mips | 0 | 6 % |
| pan / zoom | 211 | | 14 | 67 | | | | none: 0.06 to 0.4 ms a frame |
| stroke and release | 490 | | 463 | | | | | 2.3 ms a frame, release 133 ms |
| grow +16 (96 MP box) | 3,556 | 953 | 933 | 334 | 192 | 1,735 | 739 | **47 %** |
| shrink −16 | 2,886 | 920 | 896 | 446 | 121 | 998 | 835 | **60 %** |
| invert | 689 | 689 | 5 | | 596 | | | 1 % |
| wand across the picture | 4,647, then **refused** | 2,019 | 1,628 | 1,776 | 135 | 763 | 2,370 | works 4.6 s before it says the document is larger than any canvas |
| provider crop and stitch | 2,525 | 2,525 | 83 | | 2,454 | | | 3 % |
| export PNG (1.1 GB) | 11,765 | 306 | 7,131 | 16 | 4 | 64,500 (8 workers) | 0 | **61 %** |
| export PSD (3.7 GB) | 12,071 | 409 | 7,462 | 0 | 0 | 19,923 | 0 | **62 %** |

### The memory limits, measured

| | |
|---|---|
| typed arrays in the renderer (64 MB buffers, every page touched), `ArrayBuffer` and `SharedArrayBuffer` alike | **15.5 GB**, then `RangeError: Array buffer allocation failed`; the renderer lives. Not the 8 GB read in an issue |
| one `WebAssembly.Memory` | 4 GB (grown to 3.75 GB in 256 MB steps without a refusal) |
| a full 15k paint layer | +0.82 GB of renderer (0.56 GB of arena tiles, the rest its mip chains), +30 to 90 MB of GPU process |
| full 15k layers in one document until it ends | **18 layers over the base** (16.0 GB of renderer, 11 GB of arena, GPU process 1.16 GB, pan at 1:1 still 0.2 ms); the 19th throws the `RangeError` out of `TileLayerPixels.writable`, uncaught |
| four 15k documents, each a base and a full paint layer | 6.8 GB of renderer, 1.0 GB of GPU process, pan 0.1 ms: far from the limit |
| 30k | a full layer is 3.3 GB with its chains: a base and **three** full layers, or fewer with a whole-picture selection (2.4 GB as RGBA tiles) |
| GPU process per open 15k document without a filter layer | +0.25 GB (§C7 read +0.6 to +1.4 GB with the film look's surfaces) |

### What the numbers say

- **The browser's share is large on five rows** (open, grow / shrink, the wand, both exports: a half to 85 % of the
  wall), and nothing on the rows drawn every frame (pan, zoom, a stroke's frames).
- **Every one of those costs is the editor using a canvas as its pixel path, not Chromium being in the way.** The export
  builds region canvases from tiles and reads them back; the wand composites to a canvas, reads it, ships a bitmap, reads
  it again in the worker and draws the shape through another canvas; grow reads its mask out of a canvas twice; opening
  decodes into an image and reads it in bands. Since E1 the tiles lie in shared memory that every worker can read, and
  since R the kernels are Rust: all five rows can run over tile memory without a canvas, inside Electron.
- **Two rows are slow for reasons no shell changes**: `stitch.js` `dilate` is a max filter of O(w · h · radius) in JS
  (1.9 of the crop's 2.5 s on a 1,492 px patch), and the stream reader takes 12 ms a megapixel on one worker against
  about 6 for Chromium's own decoder (**not** a JS inflate, as this said at first: the inflater is the browser's and
  is the limit, `docs/PLAN_BCE.md` §3b "B item 5 as built").
- **Memory is not where it was feared**: 15.5 GB of typed arrays, 18 full 15k layers. A 30k document with more than three
  full layers is the one case that needs tiles outside the renderer (option C).

### 14.1 After B items 1 to 5 (2026-09-17)

`docs/PLAN_BCE.md` §3b has each item "as built". One full run of `tools/native_test.py 15000x10000` on a fresh offline
instance, the same machine and document as the tables above, wall / longest block in milliseconds:

| row | before B | after B 1 to 5 | item |
|---|---|---|---|
| open the PNG | 3,158 / 2,102 | **2,694 / 134** | 5 (the stream reader) |
| grow +16 | 722 / 206 | **499 / 39** | 3 |
| shrink −16 | 603 / 201 | **345 / 18** | 3 |
| invert | 204 / 204 | 211 / 211 | not moved (item 6 would) |
| wand across the picture | 4,218 / 1,626 | **1,426 / 151** | 2 |
| wand, one disc | 133 / 61 | 110 / 65 | 2 |
| a provider run's crop and stitch | 2,485 / 2,485 | **524 / 524** | 4 (still one block) |
| export PNG | 3,510 / 191 | **1,842 / 41** | 1 |
| export PSD | 3,861 / 147 | **1,281 / 70** | 1 |
| pan / zoom, a stroke's frames | 0.1 to 2 ms a frame | the same | none needed |

What these rows still hold of the browser: the coarse pass of the wand (a 2,048 px canvas), the stitch's canvases (0.26
s), Canvas 2D for a stroke, and everything on a document with a filter layer, a blend mode or a colour match, which
keeps the region pass for exports and the canvases for the wand.

## 8. What goes where

Everything in phases 1–5 is editor code and lands in the node repo first
(`ComfyUI-InpaintCanvas/js/`), then in the app through the sync. The worker (phase 3)
needs a module served by both hosts: the node serves it as a static file, the app through
`scumble://app/`. The GL compositor keeps the node's CPU fallback for browsers without
WebGL2 (the node runs in the user's browser; the app always has WebGL2).
