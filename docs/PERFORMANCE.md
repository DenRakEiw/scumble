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

### Phase 3: off the main thread (2–3 days)

1. A worker with `OffscreenCanvas`: PNG encoding for autosave, undo snapshots (the
   dirty-rect copies from phase 1 as `ImageBitmap` transfers), layer uploads to the
   mirror (`toBlob` + SHA-1 in the worker), export. The main thread never encodes a
   whole layer again.
2. Full-resolution filter and match renders after a gesture run in the worker on its own
   WebGL2 context (Chromium supports WebGL2 in workers on OffscreenCanvas), with the
   result transferred back as an `ImageBitmap`. The viewport preview from phase 1 stays on
   the main thread, so the screen never waits for the full render.

### Phase 4: dirty rectangles and tiles (3–4 days)

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

### Phase 5: the WebGL2 compositor (1–2 weeks)

`drawComposite` becomes a render pass over the visible tiles: one quad per visible layer
tile, shader with blend modes (all Canvas 2D `globalCompositeOperation` modes the
editor exposes), opacity, mask multiply, colour match, then the filter chain from phase
2; the 2D canvas only carries overlays. Export, run and thumbnail render the full image
tile by tile from the same pass into an `OffscreenCanvas`. Sources: layer tiles from
phase 4, the base image as tiles, the selection texture. Memory budget: textures for
visible layers and their mips, tiles of hidden layers may be dropped and re-uploaded.
Behind the same interface a WebGPU backend can follow when the plugin shader API is
ported (a compatibility shim for `shade(vec4, vec2)` is possible with WGSL).

### Phase 6: memory (1 week, as needed)

- Undo as dirty-rect tiles, optionally compressed (Krita compresses every tile), capped
  by bytes instead of by step count.
- The objects id map at a bounded resolution (≤ 2048 px long side, already the SAM2
  output size) and scaled on use.
- Layers larger than the image, hidden layers and old results as tiles that can be
  evicted to the mirror on disk and reloaded (the mirror already stores every layer PNG).
- Electron: raise the V8 heap for the renderer (`js-flags --max-old-space-size`) only if
  a measurement shows heap pressure; the 8 GB process limit cannot be raised.

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

Targets: interactive frames ≤ 16 ms at 12k; full composite after release ≤ 1 s at 12k
without filters, ≤ 3 s with a film look; no synchronous main-thread block above 100 ms
outside export. Every phase also runs `tools/smoke_test.py --no-helpers`,
`tools/commands_test.py` and `tools/film_test.py` (the CPU / GPU filter twins must stay
within 3 levels).

## 8. What goes where

Everything in phases 1–5 is editor code and lands in the node repo first
(`ComfyUI-InpaintCanvas/js/`), then in the app through the sync. The worker (phase 3)
needs a module served by both hosts: the node serves it as a static file, the app through
`scumble://app/`. The GL compositor keeps the node's CPU fallback for browsers without
WebGL2 (the node runs in the user's browser; the app always has WebGL2).
