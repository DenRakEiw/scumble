# Plan: the tile engine — performance at 15k and beyond

Written 2026-09-12 for DenRakEiw, after the 15k measurement in `docs/BUGS.md`. Read
`CLAUDE.md`, `docs/PERFORMANCE.md` (§3 how Krita and Photoshop do it, §4 what Chromium
allows, and the six phases that are done) and the 15k entry in `docs/BUGS.md` first. This
plan is the seventh phase of the performance work: the one the earlier phases left out on
purpose, because it changes the data structure every tool is written against.

Phase A is built (2026-09-13, on the user's "starte den geplanten Umbau, Phase 1"; §7 below
says what and what it measured). Phases B to F are not; each has a gate and none is to be
started without the user's go. **The step-by-step implementation plan for B, C and E, with
every technical decision taken, is `docs/PLAN_BCE.md` (2026-09-13); where it differs from
this file, it wins.**

---

## 0. Where we start

Measured on 2026-09-12 on a synthetic 15,000 × 10,000 document (base, three full-size paint
layers, one 2048² result layer, a film look), app freshly started, real pointer events:

- **Per-frame work is already at the screen's rate**: pan, a 400 px eraser stroke and its
  release take one 120 Hz frame (8.3 ms) at fit zoom and at 1:1; slider ticks 8 ms. Phases
  1 to 6 did their job. No drawing-path optimisation is left that a user would notice.
- **Whole-document steps still hold the main thread**: selection change 62 ms, undo 99 ms,
  bounds scan up to 754 ms, grow 321 ms, magic wand 2.1 s, bucket 1.6 s, the PNG of a
  whole layer 274 ms even with the worker, the first frame after a zoom to 1:1 58 to
  320 ms, the cold full composite 990 ms.
- **Memory is the finding that matters**: one such document holds **4.3 GB in the GPU
  process** (layers 1.8 GB, display pyramids 1.0 GB, base canvas 0.6 GB, selection canvas
  0.6 GB, compositor textures 0.2 to 1.26 GB). Two 15k documents in one session put the
  GPU process at 17 GB. Every layer is an accelerated Chromium canvas, i.e. a texture in
  VRAM, and the same pixels sit there two to three times (canvas, pyramid, compositor
  texture). On a 32 GB card shared with ComfyUI (20 to 29 GB after a local render),
  Photoshop (9.5 GB when it has a document open) and Krita, that is over-commitment, and
  Windows then pages GPU memory to system RAM. A frame that touches an evicted texture
  stalls. That is the stutter the benchmarks on an idle card do not show.

Krita and Photoshop are smoother for three reasons, none of which is "faster drawing":
pixels live in **tiles in system RAM**, the GPU holds **only the visible tiles** of a
mipmapped projection, and every operation is **per tile, native, multi-threaded**. This plan
brings those three properties to the editor, in the order that pays earliest.

## 1. Targets

Measurable, on the 15k document of the benchmark and on a 30k one, checked by the gates:

| Target | Today | Goal |
|---|---|---|
| GPU memory per open document | 4.3 GB at 150 MP, grows with the document | ≤ 300 MB, independent of the document size (visible tiles + mips) |
| System RAM per layer | 1× pixels in the GPU process + 33 % pyramid | 1× pixels + 33 % mips, evictable when hidden or in a background tab |
| Interactive gesture | 1 frame | 1 frame, including the first frame after a zoom |
| Main-thread block outside export | up to 2.1 s (wand) | ≤ 50 ms at 150 MP |
| Selection step (undo, bounds) | 62 to 754 ms | ≤ 5 ms (bounds free, undo = touched tiles) |
| Largest document with the GPU path | 16,384 px on a side | limited by RAM and disk only (30k gate) |
| Export / run of a 30k document | needs a full-resolution canvas (impossible above 268 MP) | streamed tile by tile, no full canvas |
| Undo memory | a step copies the touched rectangle or a whole canvas | a step holds only the touched tiles (copy on write) |

## 2. Does R or Rust help?

**R: no.** R is a statistics language; it has no place in an interactive pixel pipeline and
cannot run in the renderer or the browser.

**Rust: yes, for one part of the problem, and it is not the part the user feels first.**
It does not help the per-frame path (already on the GPU at the screen's rate), it does not
help the memory placement (that is the tile architecture, in any language), and it cannot
lift a Chromium limit. What it replaces is every loop that today runs over 150 million
pixels in JavaScript: mip generation, distance transforms, flood fill, compositing at full
resolution, colour statistics, brush stamping, PNG/PSD writing. Those are the 0.1 to 2 s
rows above. Rust brings SIMD (WASM SIMD128 in the renderer, AVX2 natively), real threads,
no garbage collector and no undefined behaviour, in a toolchain that targets both of our
hosts.

Two ways in, and they are not exclusive:

- **`wasm32-unknown-unknown` + SIMD128, loaded in the editor worker(s).** Runs in the app
  and in the node's browser alike (Chrome, Firefox, Safari 16.4+ all have SIMD). Memory is
  a linear `WebAssembly.Memory`, 4 GB in wasm32; Chromium 152 (Electron 44) and Firefox
  134+ also have **Memory64**, Safari does not. Tiles handed to a kernel as typed-array
  views are copied into the wasm memory once per call unless the tile itself lives there.
  Threads need `SharedArrayBuffer`, which needs cross-origin isolation: on `scumble://` we
  can send COOP/COEP from `protocol.handle` (or start Electron with
  `enable-features=SharedArrayBuffer`); on the ComfyUI page we cannot, so the node's copy
  runs the kernels single-threaded per worker with transfer instead of sharing. The kernels
  must therefore be written to work on a tile or a band, not on a shared whole.
- **A native addon (`napi-rs`) in an Electron utility process**, app only. Unlimited
  native memory (the renderer is capped at about 8 GB on Windows, `docs/PERFORMANCE.md`
  §4), rayon threads, mmap to disk. It cannot touch the renderer's memory: tiles go over a
  `MessagePort` as transferred ArrayBuffers (a copy per crossing). So it is the right home
  for the **warm tile store** (evicted layers, background tabs, undo history beyond the
  budget) and for batch work (export of a 30k document), not for anything per gesture.
  It also means prebuilt binaries per platform in `build.yml`.

What JavaScript could do instead: typed arrays in a worker pool with `SharedArrayBuffer`
do give threads, and phase 4 already moved the selection kernels into a worker. JS has no
SIMD, so a scalar JS kernel is 4 to 8× slower than SIMD128 on the same loop, and a worker
pool in JS costs the same isolation headache as WASM threads. Rust is the better tool for
the kernels; it is **not** a reason to rewrite the editor, which stays JavaScript.

**Recommendation.** Rust as the kernel language from phase C on, compiled to WASM for both
hosts, with a native addon only if phase D's measurement shows the renderer's memory cap
biting. **Decided by numbers, not by taste**: phase B is a three-day spike that builds five
kernels and benchmarks them against the JS worker at 96 and 150 MP. If the spike does not
show at least 3× on the distance transform and the mip refresh, the tile engine is built
with JS kernels and Rust waits.

## 3. The design

### 3.1 The tile store

- A layer's pixels are **256 × 256 RGBA8 tiles, straight alpha**, in `Uint8ClampedArray`s
  (256 KB each), addressed by `(tx, ty)`, **sparse**: a missing tile is transparent, so a
  15k layer with one brush stroke costs a handful of tiles, not 600 MB. Why 256: five
  mip levels down to 8 px fit in one halving chain, a 4096² atlas page holds 256 tiles,
  and a 400 px brush dab touches 4 to 9 tiles. Krita uses 64 (finer dirty tracking, more
  overhead per tile), Photoshop 128 K to 1 M bytes per tile. Phase B measures 256 against
  512 on the mip refresh and the dab path before the size is frozen.
- Straight alpha because PNG, `ImageData`, the plugin API and every `getImageData` site
  are straight; the compositor already premultiplies in the shader (W3C blend modes were
  verified premultiplied, `docs/PERFORMANCE.md` phase 5).
- Each tile carries a `version` and its **mips** (128², 64², 32², 16², 8²), refreshed
  lazily per dirty tile in a worker. The per-source pyramid of phase 1 goes away; its 33 %
  stays, but per tile and only for tiles that exist.
- The base image, layer masks and `_masked` slots are tile stores too; a mask is a one-
  channel store (64 KB per tile).

### 3.2 `LayerPixels`, the facade every tool goes through

`inpaint_canvas.js` has 125 `.canvas` sites, 70 `.mask` sites and 82 `selection` sites,
plus 22 places that allocate a canvas of the whole document or the whole layer (stroke
buffers, shape buffers, temp copies). All of them move behind one interface:

```
readRect(x, y, w, h) -> ImageData              // straight alpha, tiles gathered
writeRect(imageData, x, y, mode)               // source-over | copy | destination-out | source-atop
drawInto(rect, (ctx) => ...)                   // a scratch canvas of the rect for Canvas 2D work
tilesIn(rect), dirty(rect), version
```

`drawInto` is how text, shapes, transforms (scale / rotate / distort / warp), clone, heal
and the GLB plugin keep using Canvas 2D: they render into a scratch canvas of their
bounding box (never of the document) and write it back into the tiles. Their look does not
change. The plugin API keeps `getPixels` / `setPixels` as `ImageData` (that is `readRect` /
`writeRect`); a `layer.canvas` accessor materialises a canvas for one release with a
deprecation warning, then goes.

### 3.3 Display: the compositor draws tiles

The GPU compositor (`inpaint_compositor.js`) stops uploading one texture per source. Per
layer and mip level it keeps **atlas pages** (4096², 16 × 16 tiles at 256) filled on
demand with the tiles visible at the current zoom, uploaded with `texSubImage2D` straight
from the tile's typed array (no canvas round trip, no 0.6 to 1.0 ms synchronisation per
upload). A dirty tile re-uploads only itself. Pages are an LRU by bytes with a budget
(default 512 MB, a Settings › Rendering row, the memory watch lowers it under pressure).
`MAX_TEXTURE_SIZE` stops being a document limit, because no texture is larger than a page.

The view pass, the scene cache, the filter chain and the film pack shaders stay as they
are: they already work on the visible region at screen resolution. The Canvas 2D fallback
(the node in a browser without WebGL2) draws the visible tiles at the nearest mip with
`putImageData` into a per-level scratch; slower, but it works, and it is the path a lost
GL context lands on.

### 3.4 Painting

A dab is rasterised in the kernel (round tip, custom tips from `docs/BRUSHES.md`, spacing,
pressure, erase, alpha lock, the selection as a clip) into a **sparse stroke store** of the
same tile shape, and the compositor draws the stroke tiles over the layer while the button
is down. On release the stroke store is composited into the layer tiles at the stroke's
opacity (the semantics of today's stroke buffer, so a stroke over itself does not double).
There is no full-layer stroke canvas any more (today: 600 MB per stroke on a 15k layer).

### 3.5 Undo: copy on write

A step records `{ layer, tiles: Map<id, previousTileRef> }`. Tiles are immutable once
referenced by a step: a write to a referenced tile allocates a new one first. Untouched
tiles are shared between the document and every undo state, so a stroke costs its tiles,
a whole-layer filter costs the layer once, and the selection step costs the tiles the
selection changed in. `MAX_UNDO_BYTES` keeps its meaning; the whole-canvas snapshots
(`layer`, `layerfull`, `selection`, `canvas`) disappear.

### 3.6 Selection: a tiled mask

One byte per pixel in mask tiles: 150 MB at 150 MP instead of a 600 MB canvas. The set of
non-empty tiles **is** the bounding box, so the bounds scan disappears. Marching ants are
drawn from the visible tiles at the view's mip. Grow, shrink, feather, invert, wand and
bucket run per tile band in the kernel (the distance transform over the padded bounding
box of phase 4, now on bytes instead of RGBA), and wand / bucket sample the layer tiles
under the click instead of flattening the document first (which is the 2 s today).

### 3.7 Full resolution without a full canvas

Export, run, thumbnail, PSD/ORA and the `flatten` command composite **tile by tile** in
workers straight into the encoder: PNG rows are written as tile rows complete, PSD channels
per tile row. A 30k document exports without ever holding a 3.6 GB canvas. Filter layers
render per tile through the existing `renderTiled` / `GLSurface` path with a halo of the
filter's radius (halation and glow need one; colour filters need none).

### 3.8 Memory tiers

- **Hot**: tiles of visible layers of the active tab, typed arrays in the renderer.
- **Warm**: hidden layers, background tabs, undo history over budget — moved to the tile
  store in a **utility process** (plain Node `Buffer`s first; `napi-rs` only if a
  measurement asks for it), beyond the renderer's cap, over a `MessagePort` with transfer.
- **Cold**: the mirror on disk, which already holds every layer as PNG; a layer that has
  not been touched for a long time keeps only its mips hot.

Promotion is by demand (a tile is read), demotion by policy (a Settings row for the hot
budget, default 4 GB; the memory watch of phase 6 becomes this policy's timer). In the
node's browser there is no utility process: hot and warm are the same tier, cold is the
ComfyUI server.

### 3.9 Both hosts

The editor stays one code base in the node repo, synced. Everything above feature-detects:
WebGL2 or the Canvas 2D tile fallback, `SharedArrayBuffer` or transfer, utility process or
none, Memory64 or 4 GB. **This is the point to decide `docs/NEXT_PLAN.md` item 4b** (the
editor source moves into this repo and the node consumes a build): a Rust crate, a wasm
build step and a worker pool are exactly the things a sync script should not carry.

## 4. Phases and gates

Estimates are honest ranges for one person working on nothing else. Each phase ships behind
its own gate; A alone is a release.

### Phase A — quick wins inside the current model — **built 2026-09-13**

Everything here was measured on 2026-09-12 and needs no tiles. What was built is in §7;
the numbers are in `docs/PERFORMANCE.md` §9. The items as planned:

1. **The selection as a `Uint8Array` mask** with rect undo (the phase 1 pattern) and
   incrementally tracked bounds. Removes the 600 MB canvas, the 62 ms selection step, the
   99 ms undo and the 754 ms bounds scan. Ants and the mask-to-canvas conversions for the
   run path go through one `selectionCanvas()` cache.
2. **Stroke and shape buffers at bounding-box size**, not document or layer size (the 22
   `makeCanvas(this.width, this.height)` / `(layer.canvas.width, ...)` sites). A 15k
   stroke stops allocating 600 MB.
3. **Wand and bucket sample the layer under the click**, not `flattenToCanvas()`: 2.1 s
   and 1.6 s → the phase 4 numbers (about 260 ms), then the kernel.
4. **First frame after a zoom**: the compositor uploads the visible region of the level
   through a scratch canvas instead of the whole 600 MB source (58 to 320 ms → a few ms).
5. **Free VRAM releases the active tab's compositor cache too**, and the memory watch
   reads the card's free memory (Windows `\GPU Process Memory` counters via main) instead
   of only our own GPU process, so ComfyUI's 29 GB count.

Gate: `perf_test.py 15000x10000` rows selection change ≤ 5 ms, undo ≤ 5 ms, bounds scan
0 ms, wand / bucket ≤ 300 ms blocked; `memoryReport().scratch` without a selection canvas;
`composite_test.py`, `editor_test.py`, `shape_test.py`, `commands_test.py` unchanged.

### Phase B — the Rust spike (3 days)

A crate `crates/px/` (GPL-3.0 like everything else), `wasm32` + SIMD128 through
`wasm-bindgen`, loaded by `inpaint_worker.js`. Five kernels, each with the JS twin it
replaces: mip halving of a tile column, distance transform of a band, flood fill, a
premultiplied source-over of a tile stack, PNG row filtering + deflate. Benchmarked at 96
and 150 MP against the JS worker on this machine, and once in Firefox for the node.

Gate: a table in `docs/PERFORMANCE.md` §9. Decision rule: ≥ 3× on the distance transform
and the mip refresh → Rust kernels in phase C; below that, JS kernels and Rust waits.
Also measured here: 256 against 512 tiles, and the copy cost of a tile across the WASM
boundary with and without the tile living in wasm memory.

### Phase C — the tile engine (4 to 6 weeks)

The commitment. In the node repo, behind a flag until the gates pass:

1. `inpaint_tiles.js`: the tile store, mips, the mask store, copy-on-write.
2. `LayerPixels` and the migration of the 125 / 70 / 82 sites, tool by tool, each with its
   existing gate run after it (`shape_test.py`, `editor_test.py`, `brush_test.py`,
   `film_test.py`, `glb_test.py`, `ailabel_test.py`).
3. The compositor over atlas pages; the Canvas 2D tile fallback.
4. Painting into a stroke store; undo as tile refs; the selection as mask tiles.
5. Thumbnail, hover, object map and colour match reading from mips.

Gate: `composite_test.py` against `tools/refs/` (the references are re-baked once, with the
difference documented: our box-filter mips against Skia's bilinear levels), every gate
green, `perf_test.py` at 15k and 30k with the interactive rows ≤ 1 frame and no operation
row above 100 ms, `mem_test.py 15000x10000 --rounds 4` with the GPU process ≤ 300 MB above
its start per open document.

### Phase D — memory tiers (2 weeks)

The utility-process tile store (Node `Buffer`s), demotion of hidden layers and background
tabs, promotion on read, the hot budget row. Measured first: the renderer's real cap on
this machine with typed arrays (the 8 GB in `docs/PERFORMANCE.md` §4 is from an issue,
not from our own measurement). `napi-rs` only if the Node store's copy costs show up in
the promotion path.

Gate: `mem_test.py --keep` with four 15k documents open: renderer ≤ hot budget, GPU
process ≤ 300 MB per document, a pan frame in the active tab still 1 frame.

### Phase E — full resolution per tile and the worker pool (2 weeks)

Export, run, thumbnail, PSD/ORA streamed per tile; filter layers per tile with halo; the
COOP/COEP headers on `scumble://` and a pool of `navigator.hardwareConcurrency - 2`
workers over `SharedArrayBuffer` for mip refresh and compositing; transfer fallback for the
node.

Gate: a 30,000 × 20,000 document (600 MP, above the Canvas 2D area limit) opens, paints,
exports to PNG and PSD and runs through the loopback provider; `smoke_test.py` with a real
Flux run; export of the 15k film-look document ≤ 3 s wall, ≤ 50 ms blocked.

### Phase F — finish (1 week)

Adaptive VRAM budget from the card's free memory, the Settings rows, `docs/PERFORMANCE.md`
§9, the node's `DEVELOPMENT.md` §23 (the tile rules), `docs/PLUGINS.md` (the `layer.canvas`
deprecation), the CHANGELOG.

## 5. Risks

- **Bit-exactness.** Mips from a box filter differ from Skia's `imageSmoothingQuality:
  medium` levels by a level or two; `composite_test.py`'s references change once, and the
  tolerance is written down. Text, shapes and transforms keep Canvas 2D through `drawInto`,
  so their pixels do not change.
- **The migration is the risk, not the engine.** 277 sites across nine thousand lines, every
  one a chance to get a coordinate system wrong (image, layer, tile, screen). Tool by tool,
  gate after each, and the flag keeps the old path alive until the last gate is green.
- **Two hosts.** Every feature detection is a second path to test; the node's browser gate
  is `tools/editor_test.py` against the node's headless tab (port 9333), which today is not
  part of the app's routine.
- **Rust in the build.** A `cargo` step in `build.yml` and in the node's install; the node
  ships the built `.wasm` in `js/`, so a user of the node never needs Rust. A native addon
  would add per-platform binaries and is the reason to keep it out until measured.
- **Time.** A to F is three to four months without feature work. A and B are a week and a
  half and stand on their own; C is the decision.

## 6. What the user decides

1. **Confirm the VRAM reading** on your machine before anything is built: Task Manager ›
   Performance › GPU › dedicated memory while it stutters, and the same document right
   after a restart of ComfyUI. If the stutter goes with the free VRAM, phase A item 5 and
   phase C are the fix; if it does not, phase A's measured rows are still the fix for the
   discrete hitches and the VRAM part of the plan waits for a better reading.
2. **Phase A**: yes or no. No architecture change, one release.
3. **Phase B**: yes or no to the Rust spike. It decides the kernel language by numbers.
4. **Phase C**: the commitment, and with it `docs/NEXT_PLAN.md` item 4b (the editor source
   moves into this repo). Nothing in C starts before that decision.

## 7. Phase A as built (2026-09-13)

Built item by item in the node repo (commits 0c3ce45, 009320e, 9bf54c0, 5dd1dbb, DEVELOPMENT.md
§23 has the rules) and synced, item 5 in the app; each item has its gate step and its commit
in both repos. Measured on the 15,000 × 10,000 benchmark document of §0, a fresh instance
each time (`tools/perf_test.py 15000x10000`; the discrete rows now drain the GPU queue first,
so they measure their own cost and not the backlog of the frames before them):

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

Per item, what is different from the plan above:

- **A1 stayed a canvas.** The selection is still a GPU canvas: a `willReadFrequently` canvas
  was measured and lands in Chromium 152's GPU process just the same (it fills slower), and a
  `Uint8Array` behind 82 sites is phase C's job. What was built is the shape the old §7 drafted:
  the undo step copies the extent (from the 1/16 level, a canvas up to 16 MP, a PNG above), the
  bounds are scanned by 64 px strips from the edges of a known box, a subtract carries the old
  box as a superset, a rect undo keeps the display levels and only its row thumbnail, and a
  change keeps the colour-match statistics of the layers it cannot have touched. The measured
  finding behind all of it: on a GPU canvas a readback costs what is queued before it, not the
  copy; the 0.5 to 1.2 s readbacks of the 12th were that wait.
- **A2 as planned**, plus the live preview refreshed inside the dab's rectangle (it was three
  full-size blits per frame), the big preview canvases given back after the gesture, and the
  smudge clip drawn per dab. The pixels are within a few levels of the old way, because a small
  buffer starts as a software canvas (the gate compares premultiplied, tolerance 8).
- **A3 as planned** (coarse composite at 2048, the box at full resolution, widened where the
  region touches its edge), with two things the plan did not know: a sample pass must keep its
  own filter and match caches or it evicts the screen's (`viewPass.sample`), and the film
  panel's thumbnails were a full-resolution flatten of the whole document on every change
  (1.9 s at 15k, found inside the wand's blocked time; `Document.flatten({ maxSize, box })`
  now). The eyedropper composites one pixel. The whole-image wand stays the old cost, by the
  40 % rule.
- **A4 as planned** (`_source` in the compositor, 16 MP threshold, half a view of margin).
  Pixel-identical with and without the windows. Note that a document with a visible filter
  layer never reaches the compositor (the filter chain draws through Canvas 2D), so the win
  shows on documents without one; the benchmark document has a film look.
- **A5 as planned**, through `nvidia-smi` (tens of ms) or the WDDM counters (a second, used
  only). `settings.memory.cardMinFreeMB` (default 2048); when the card is that short the
  front tab's compositor textures and the GL pool go too, never its display levels.

What phase A could not do, by construction: the per-document memory. One 15k document still
holds 2.3 GB of layers, 0.95 GB of pyramids, 0.57 GB of base canvas and 0.57 GB of selection
canvas in the GPU process; only the stroke-time 1.8 GB and the compositor's whole-source
textures are gone. That is phase C. And the ops that read the whole selection (grow, shrink,
feather, invert) keep their phase 4 cost.

The decisions of §6 after phase A: 1 (the user's VRAM reading) is still open; 2 is done; 3
and 4 are open.

The old §7 drafts, for the record:

- **A1, the selection's undo copy.** `snapshot({ kind: "selection" })` returns the pixels
  inside the selection's *extent* (a canvas of that rectangle, `bytes` counted like a
  `layerrect` step) instead of `snapUrl(this.selection)`. The extent comes from a new
  `selectionExtent()`: the 1/16 display level of the selection with the *any alpha* test
  (`& 0xff000000`), padded by one cell, so a feathered tail is inside; empty → `{ empty: true,
  bytes: 0 }`. The known bounds travel with the snapshot when `selectionDirty` is false.
  The restore clears the canvas, draws the copy at its offset and calls
  `markSelectionChanged(bounds, rect)` with the union of the old extent and the copy's
  rectangle, so the display levels are refreshed in place, not rebuilt.
- **A1, the bounds scan.** `scanBounds` takes the alpha test as a parameter; a new
  `scanBoundsIn(box)` reads 64 px strips inwards from each edge of the coarse box and stops
  at the first selected pixel (top, then bottom, then left and right within those rows).
  `selectionBounds()` becomes extent → `scanBoundsIn`. A selection whose alpha never
  reaches 128 still reads the whole box (unchanged worst case).
- **A4, the compositor's window.** `inpaint_compositor.js`: sources above `WINDOW_PX`
  (16 MP) go through `_window(source, version, x0, y0, x1, y1)` instead of `_texture`: the
  part of the layer the view shows, in source pixels, plus a margin of half its size on
  each side, drawn into a scratch canvas and uploaded; the cache entry keeps `{ x, y, w, h,
  window: true }` and is reused while the needed rectangle stays inside it and the version
  is unchanged. `composite()` then draws the layer with the window's rectangle mapped back
  to image coordinates (`x: l.x + win.x / fx`, ...). Everything outside the window is
  off screen by construction. `stats()` counts the window's size, so `memoryReport`
  shows the saving.
- **A2, A3, A5** were not drafted. For A3 the intended shape is a two-pass flood: the
  region on a ≤ 2048 px composite of the whole image (the thumbnail's `viewPass` trick), its
  padded box composited at full resolution through the same trick, the flood inside that
  box in the worker with a "touched the border" flag that widens the box and repeats.
  `createImageBitmap(src, x, y, w, h)` crops without a full copy.
