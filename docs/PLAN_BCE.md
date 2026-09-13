# Implementation plan: phases B, C and E of the tile engine

Written 2026-09-13 for the session that builds them. Read `CLAUDE.md` first, then
`docs/PLAN_TILES.md` (§0 the measurement, §1 the targets, §3 the design, §7 what phase A
built and found), `docs/PERFORMANCE.md` §4 (Chromium's limits) and §9 (phase A's numbers),
`docs/NEXT_PLAN.md` §4b, and the node's `DEVELOPMENT.md` §21 to §23. This file does not
repeat the why; it says **what to build, in which order, with which decisions already taken,
and which gate proves each step**. Where this file and `docs/PLAN_TILES.md` disagree, this
file wins: it was written after the code was read line by line.

Phase D (memory tiers: the utility-process tile store, demotion of background tabs) is
**not** in this plan. E does not need D. What that costs at the end is written in §5.

The user's decisions still open before the first line is written: §6 of `PLAN_TILES.md`
item 1 (the VRAM reading on their machine) and item 4 (the commitment to C, which includes
`NEXT_PLAN.md` 4b). The user's instruction of 2026-09-13 was to plan B, C and E in detail
and then have them built; treat that as the go for B and, after B's table, for C and E
**unless the user says otherwise after B**. Ask once, after B's table, in one sentence.

---

## 0. Ground rules for the whole job

- **Commits**: one per numbered step below, in the repo that step names, as DenRakEiw
  (`CLAUDE.md` "Working rules"), after that step's gate is green. Push after every step.
- **Gates run on a fresh dev instance with its own `--user-data-dir`** (memory
  `scumble-benchmark-hygiene`). Restart before every benchmark. Read the first run after a
  restart; the shared card swings the op rows by hundreds of ms.
- **Every existing gate keeps passing after every step**: `composite_test.py`,
  `editor_test.py`, `shape_test.py`, `brush_test.py`, `commands_test.py`, `film_test.py`,
  `glb_test.py`, `ailabel_test.py`, `size_test.py`, `transparent_test.py`,
  `generate_test.py`, `log_test.py`, `mcp_test.py`, and `smoke_test.py --no-helpers` (a
  real Flux run: check `/queue` first, never restart ComfyUI). Where a gate compares pixels
  against the old path, the tolerance and the reason are written next to the step.
- **No scratch files in the repo**; benchmark pages and one-off scripts go to the session
  scratchpad. Python that patches files writes with `newline=chr(10)`. Long heredocs in the
  Bash tool fail: write scripts with the Write tool.
- **The node repo** (`F:\Comfyui\...\ComfyUI-InpaintCanvas`) is the source of the editor
  until step C0 flips that. After C0, the app repo is the source and the node consumes a
  build. Nothing of B, C or E is written as a `sync_editor.py` patch.
- `package.json` is 0.1.10 with an unreleased `CHANGELOG.md` section. B ships nothing to
  users; C0 is 0.1.11; the tile engine is 0.2.0 (the first release where a document's memory
  no longer grows with its size), E is 0.2.x. Bump and open the section before the first
  change of each.

---

## 1. Phase B: the Rust spike (3 days)

**Purpose**: one table that decides the kernel language for C, by the 3× rule (≥ 3× on the
distance transform and on the mip refresh against the JS worker → Rust kernels; below that,
JS kernels, and the crate is deleted again). B changes nothing in the editor.

### B0. Toolchain (half a day, once)

Nothing Rust is installed on this machine (checked 2026-09-13: no `cargo`, no `rustup`, no
`~/.cargo`). Firefox is at `C:\Program Files\Mozilla Firefox\firefox.exe`. Node is 24.18.

```
winget install --id Rustlang.Rustup -e
rustup toolchain install stable
rustup target add wasm32-unknown-unknown
```

No `wasm-pack`, no `wasm-bindgen`. **Decision: the crate exports plain `extern "C"`
functions over linear memory and is loaded with `WebAssembly.instantiate` directly.** Reasons:
no generated JS glue to keep in sync with a CLI version, no allocator shim, the tiles that
the kernels work on are meant to live in wasm memory anyway (§B2), and the same `.wasm`
loads in a module worker, on the main thread, in Node (`node tools/px_bench.js`) and in
Firefox without a bundler. `wasm-opt` is optional; if used, it comes from the `binaryen`
npm package as a devDependency, never from PATH.

`crates/px/Cargo.toml`:

```toml
[package]
name = "px"
version = "0.1.0"
edition = "2021"
license = "GPL-3.0-only"

[lib]
crate-type = ["cdylib"]

[dependencies]
miniz_oxide = "0.8"      # MIT, pure Rust deflate for the PNG kernel

[profile.release]
opt-level = 3
lto = true
codegen-units = 1
panic = "abort"
```

`crates/px/.cargo/config.toml` builds two variants; the bench loads both:

```toml
[target.wasm32-unknown-unknown]
rustflags = ["-C", "target-feature=+simd128,+bulk-memory"]
```

The scalar variant is built with `RUSTFLAGS="-C target-feature=+bulk-memory"` overriding the
config (`tools/build_px.py` does both and writes `renderer/editor/px/px.wasm` and
`px_scalar.wasm`). `rust-toolchain.toml` pins `channel = "stable"` with the exact version that
built the committed binaries, so the CI rebuild reproduces them byte for byte.

**Committed artifacts**: the two `.wasm` files (expected 100 to 300 KB each) are committed,
so `npm ci` and a node user never need Rust. `build.yml` gets a `dtolnay/rust-toolchain@stable`
step that rebuilds and `cmp`s against the committed file and fails the build on a difference.
(Only if C decides for Rust; in B the crate lives on a branch `px-spike` and nothing touches
`build.yml`.)

### B1. The memory contract

- The module exports `memory`, `px_alloc(bytes) -> ptr`, `px_free(ptr, bytes)` (the global
  allocator is std's dlmalloc; no `wee_alloc`, it is unmaintained), and one function per
  kernel taking pointers and sizes. Every kernel is **pure over its arguments**: no globals,
  no allocation inside a kernel (the caller allocates in and out buffers), so the same
  function runs single-threaded in a worker and, later, in several workers with their own
  instance each.
- **Decision: one wasm instance per thread, own memory each; no wasm threads, no shared
  wasm memory.** Shared wasm memory needs `-Z build-std` on nightly plus atomics and a
  `--shared-memory` linker flag, and the node's browser cannot have `SharedArrayBuffer`
  anyway. A tile (256 KB) is copied into wasm memory before a kernel and out after it: a
  `Uint8Array.set` of 256 KB is about 10 µs on this machine; B3 measures it and writes it
  into the table, because the mip-refresh number only holds if that copy is small against it.
- JS side: `renderer/editor/px/px.js` exports `loadPx(url) -> { mem, alloc, free, ...kernels }`
  with a small arena on top of `px_alloc` (`arena.take(bytes)` / `arena.reset()` per job) so a
  kernel call is one `set`, one call, one `subarray`. Growth: `memory.grow` on demand; the JS
  side re-creates its `Uint8Array` view after every call that could have grown memory
  (`mem.buffer` changes identity on growth; a stale view is the classic wasm bug).

### B2. The five kernels and their JS twins

Every kernel has a JS twin in the same shape (typed arrays in, typed arrays out; the twin
is the code C would ship if Rust loses) so the table compares like against like, not Rust
against Canvas 2D. Twins live in `renderer/editor/px/kernels_js.js`; the Rust ones in
`crates/px/src/`. Signatures are the contract C is written against:

| Kernel | Rust | JS twin (source) | What it must do |
|---|---|---|---|
| mip halving | `mip_half(src, sw, sh, dst)` on RGBA8 straight alpha | new (`displaySource` does it with `drawImage`, which is not a twin) | 2×2 box filter **alpha-weighted** (straight alpha: average premultiplied, then unpremultiply; an unweighted average bleeds transparent black into edges, which is the "one or two levels" difference `PLAN_TILES.md` §5 warns about). Also `mip_chain(src, 256, out5)` for a whole tile: 128, 64, 32, 16, 8 in one call. |
| distance transform | `dist_transform(feature_u8, w, h, out_f32)` | `distanceTransform` in `inpaint_raster.js` | Felzenszwalb / Meijster squared EDT on a band; grow / shrink / feather are thresholds and ramps over it (`growMask` does that today). Band interface: the caller passes the padded box, never the whole selection. |
| flood fill | `flood(rgba, w, h, sx, sy, tol, contiguous, out_mask)` | `floodMask` in `inpaint_raster.js` | scanline flood, same tolerance metric as the JS (max channel difference), same result bit for bit. |
| source-over of a stack | `composite_tile(dst, n, srcs_ptr[], ops[], alphas[], masks_ptr[])` | new | for one tile: n sources over `dst`, each with an op (source-over, destination-out, source-atop, destination-in, copy), an opacity, and an optional 1-channel mask tile; **premultiplied maths, straight in and out**, W3C formulas as in `inpaint_compositor.js` (the nine blend modes come later in C, the op set is enough for the spike). |
| PNG rows | `png_filter_rows(rgba, w, rows, out)` + deflate via `miniz_oxide` | new, and the browser's native `CompressionStream("deflate")` as the third column | filter type per row by the libpng heuristic (sum of absolute values), then zlib. The point of this kernel is streaming (E), not speed; its row in the table is informational and **not part of the 3× rule**. |

Every twin gets a **unit test** in `tools/px_test.js` (Node, no Electron): random inputs,
Rust output equals JS output exactly for mip / flood / composite / filter rows, and to 1e-3
for the float EDT. Green before any benchmark is believed.

### B3. The benchmark and the table

`tools/px_bench.js` (Node 24, same V8 family as Electron 44, WASM SIMD on) and
`tools/px_bench.html` (a static page for Firefox, served from the scratchpad with
`python -m http.server`; opened by hand, the numbers copied into the table). Both import
`renderer/editor/px/bench.js`. Synthetic inputs at **96 MP (12,000 × 8,000) and 150 MP
(15,000 × 10,000)**: a tile column and a whole layer for the mips, a 4,096 × 4,096 band and
the whole selection for the EDT, a 4,096² region for the flood, a 4-layer tile stack for the
composite, a 4,096 × 256 band for the PNG rows. Five runs each, median, after two warm-ups.

The table goes into `docs/PERFORMANCE.md` **§10 "Phase B: the Rust spike"** with these
columns: kernel · input · JS twin ms · Rust scalar ms · Rust SIMD128 ms · speed-up · Firefox
SIMD ms · copy-in + copy-out ms (for the tile-sized inputs). Plus two rows that are not
kernels: **256 against 512 tiles** (mip chain and a 400 px dab's `composite_tile` count per
dab: 4 to 9 tiles at 256, 1 to 4 at 512, but 1 MB per tile and a coarser undo), and the
**boundary copy cost** (tile in JS memory copied in and out, against a tile that already
lives in wasm memory).

**Decision rule, written into §10 under the table**: Rust kernels in C if **both** the EDT
(4,096² band, SIMD column) and the mip chain (one 256 tile, SIMD column) are ≥ 3× the JS
twin **after** adding the copy cost. Otherwise JS kernels: the twins are the kernels, the
crate is deleted from the branch, and only §10 remembers it.

Expected outcome, so the session is not surprised: the EDT and the mip chain should clear 3×
(they are arithmetic over contiguous bytes, which is what SIMD128 is for); the flood will
not (it is branchy and pointer-chasing in both languages); the PNG row will lose to
`CompressionStream` (native zlib). If the mip chain misses 3× because the copy dominates,
the answer is still Rust *with tiles living in wasm memory* (B1's second bullet becomes
"tiles are allocated in the wasm arena") and the table says so.

Gate for B: `node tools/px_test.js` PASS, the §10 table filled in for Node and Firefox, the
decision sentence written, branch `px-spike` pushed. Three days.

**Outcome (2026-09-13, `docs/PERFORMANCE.md` §10): JS kernels.** The EDT band is 2.0 to 2.2×
and the opaque mip chain 2.0 to 2.4× in the interactive V8 (Electron renderer in front, Node),
the EDT 2.2× in Firefox. The expectation above was wrong for the EDT: its envelope pass is
branchy scalar code that SIMD128 does not touch. Found on the way, and binding for C and E:
tile buffers that are copied into each other start on a 4 KB boundary (4K aliasing made a
tile copy 16× dearer), and JS runs at about 60 % speed while Chromium's V8 efficiency mode is
on (Scumble not in front); wasm does not. Tile size stays 256. Today's `floodMask` is faster
than the flood twin, so C keeps its structure for the wand.

---

## 2. Phase C: the tile engine (4 to 6 weeks)

### C0. `NEXT_PLAN.md` 4b: the editor source moves into this repo (2 days, both repos)

Built exactly as `docs/NEXT_PLAN.md` §4b lists it, with these decisions taken:

1. **Generated copy, not a submodule.** The node's `js/` is written by
   `tools/build_node.py`; a node user's `git pull` keeps working.
2. **The node gets `js/host.js`** with the same surface as `renderer/editor/host.js`
   (every `host.*` the editor calls) and ComfyUI's `api` behind it. Every hook the sync
   patches added is now plain code in the editor calling `host.*`; the node's `host.js`
   answers with the ComfyUI behaviour or a no-op. Write it by walking the 49 rows of
   `docs/SYNC.md` top to bottom; each row becomes either a `host.*` call site in the editor
   (already there in the app copy) or a line in the node's `host.js`.
3. **Freeze**: `sync_editor.py` once more, commit both repos, record the node's `js/` tree
   hash in `docs/BUILD_NODE.md`. Then `renderer/editor/*.js` is the source; the "Synced from
   ComfyUI-InpaintCanvas" header line is removed from every file.
4. `tools/build_node.py` copies `renderer/editor/*.js`, `fonts/`, later `px/` and the
   workers, into the node's `js/`, keeps the node's own `host.js`, `inpaint_bridge.js` and
   the extension entry (the litegraph block that `sync_editor.py` cuts today becomes the
   node's `js/inpaint_node.js`, which imports the editor). It writes the hash it produced into
   the node's `DEVELOPMENT.md` header line so a hand edit there is visible.
5. Delete `tools/sync_editor.py` and `docs/SYNC.md` (keep its patch table as history in
   `docs/BUILD_NODE.md`). `CLAUDE.md` flips the rule.
6. `inpaint_filters_gl.js` and the compositor go to the node with this step. They guard
   themselves; check once in the ComfyUI browser tab that a filter layer and a pan work.

Gate: every app gate green; in the node, the browser gate `tools/editor_test.py` against the
node's headless tab on port 9333 (add a `--node` switch to the test that changes the
connection and skips the shell-only steps) plus one real run in the ComfyUI browser tab.
Release 0.1.11 with a CHANGELOG line "the editor is built from the app repo now; nothing
visible changes".

### C1. `LayerPixels`: the facade, with a canvas behind it (1 week)

**The single most important decision of C**: the migration of the 192 `.canvas`, 109
`.mask`, 84 `this.selection` and 52 `this.base` sites in `inpaint_canvas.js` (counted
2026-09-13; plus 4 in `host.js`, 3 in `commands.js`, 2 in `inpaint_export.js`, the plugin
`Document`) happens **once, to a facade that is still a canvas underneath**, with every gate
green and pixel-identical output, and ships as its own release. The tile backend then slots
in behind the facade (C2) as the only place where a flag lives. No site gets an
`if (tiles) ... else ...`; the old path stays reachable by flipping the backend, not by a
second code path at every site.

`renderer/editor/inpaint_pixels.js`:

```
class LayerPixels {                     // RGBA8, straight alpha
  width, height                         // in its own pixels
  version                               // bumped by every write (replaces canvas._dispVer)
  readRect(x, y, w, h) -> ImageData     // clamped; outside = transparent
  writeRect(imageData, x, y, op = "copy", alpha = 1)
                                        // op: copy | source-over | destination-out | source-atop | destination-in
  drawInto(rect, fn)                    // fn(ctx) draws into a scratch canvas of `rect`
                                        // (ctx translated so the caller keeps its own coordinates);
                                        // afterwards the scratch is written back with "copy" inside rect
  drawTo(ctx, dx, dy, dw, dh, level)    // paint the whole thing scaled into a 2D ctx (fallback display, thumbnails)
  bounds() -> [x0, y0, x1, y1] | null   // non-transparent extent (tiles: the tile set; canvas: a scan)
  touch(rect)                           // mark a region changed without writing (the stroke preview)
  clear(rect?), fill(rect, rgba)
  clone() -> LayerPixels                // copy-on-write in the tile backend, a blit in the canvas backend
  resized(w, h, { x, y }) -> LayerPixels // extend / crop canvas: the old content placed at x, y
  toCanvas(rect?) -> HTMLCanvasElement  // materialise (exports, uploads, the transform tool, legacy)
  static fromCanvas(c), fromImageData(d), fromImage(img), empty(w, h)
  bytes()                               // for memoryReport
}
class MaskPixels { same, one channel }  // layer masks and the selection
```

Rules for the migration, each with the sites it covers:

- **`layer.canvas` → `layer.px`, `layer.mask` → `layer.maskPx`, `this.selection` →
  `this.sel` (MaskPixels), `this.base.img` → `this.basePx`.** The old names become getters
  that throw `new Error("use layer.px")` in dev (`host.strict`) and materialise a canvas in
  a packaged build for one release, so a plugin that reaches into `rawLayer(key).canvas`
  keeps working with a console warning. `docs/PLUGINS.md` documents the deprecation.
- **Every `getImageData` on a layer, mask or the selection is a `readRect`**; every
  `putImageData` a `writeRect(…, "copy")`; every `drawImage(layer.canvas, …)` into another
  layer a `readRect` + `writeRect(…, "source-over")` when unscaled, else a `drawInto` on
  the target with `toCanvas` of the source rect (scaled draws stay Canvas 2D).
- **`drawInto` is for Canvas 2D work that must keep its look**: text (`renderTextLayer`),
  shapes (`paintShape`), the transform tool's `applyPending` (a scratch of the destination
  box; on a 15k layer that is one full-size scratch canvas per commit, which is allowed for
  a discrete operation and stays under Chromium's 268 MP; a per-tile mesh is not in C),
  clone / heal / smudge dabs, `drawMesh`, the GLB plugin's placement, the AI label.
- **Stroke buffers** (`StrokeBuffer`) become a `LayerPixels` of the target's size that is
  sparse in C2 and a small canvas in C1: `ensure(box)` → `drawInto(box, fn)`; the dab code
  (`layerDab`, `stampDab`, `selectionDab`, `shapeDab`) is unchanged inside `fn`.
  `clippedStroke`, `commitStroke`, `refreshStrokePreview`, `layerWithStroke`,
  `maskWithStroke`, `layerPixels` all take and return `LayerPixels`.
- **The compositor's `spec.layers[].source`** is a `LayerPixels` (C1: it hands back its
  canvas through `toCanvas()` internally; C3 replaces that). `displaySource(src, scale)`
  takes a `LayerPixels` and returns whatever the display path wants (C1: a pyramid level
  canvas as today; C3: a level number).
- **`snapshot` / `applySnapshot`** kinds `layer`, `layerfull`, `mask`, `text`, `canvas`,
  `selection`, `layerrect` all go through `clone()` / `readRect` of the facade; `snapUrl`
  (a PNG per step) is deleted. In C1 that is a blit per step, the same cost as today's
  `layerrect`; the whole-layer kinds cost a full copy until C4.
- **`getValue` / `setValue` / `syncLayers` / `uploadCanvas`** upload `px.toCanvas()`; the
  state JSON does not change shape.
- **Plugin `Document.getPixels` / `setPixels`** are `readRect` / `writeRect`; `addLayer`
  takes ImageData or a canvas as before; `rawLayer()` is documented as unstable one more
  time. `plugins/glb`, `plugins/ailabel`, `plugins/film/points.js` are checked against the
  new names.
- **`inpaint_export.js`** `layer(L, canvas = L.canvas)` takes `L.px.toCanvas()` in C1; E
  replaces it.

Order inside C1, each a commit with the gates named: (a) the module with the canvas backend
and its own unit test `tools/pixels_test.js` (Node with a tiny canvas shim, or CDP; ops,
clamping, `drawInto` write-back, `resized`); (b) base and layers' display path
(`composite_test.py` identical, 0 levels: the same canvas is drawn); (c) painting and the
stroke buffers (`brush_test.py`, `editor_test.py`); (d) selection (`editor_test.py`,
`shape_test.py`); (e) masks and `_masked` (`composite_test.py` masked step); (f) undo
(`editor_test.py` undo steps); (g) text, shapes, transform, clone, heal (`shape_test.py`,
`editor_test.py`); (h) plugins and commands (`film_test.py`, `glb_test.py`,
`ailabel_test.py`, `commands_test.py`); (i) exports, uploads, runs (`smoke_test.py
--no-helpers`, `size_test.py`, `generate_test.py`, `transparent_test.py`); (j) the deprecation
getters and `docs/PLUGINS.md`. `perf_test.py 15000x10000` within noise of §9 at the end.

Release 0.1.12: "no visible change; the editor's pixel access goes through one interface"
(apart from the bugs rule 11 of "C1 as built" removes, which the CHANGELOG names).

#### C1 as built: the decisions taken while building it (2026-09-13)

Written after an inventory of every pixel site (1,454 sites, 233 hazards: the editor, its
modules, both hosts, the plugins, the node's own `inpaint_bridge.js` / `inpaint_node.js` and
the tests). Where it differs from the text above, this wins; each difference says why.

**The module** (`renderer/editor/inpaint_pixels.js`, step a, contract test
`tools/pixels_test.py` + `tools/pixels_test.js`, byte for byte against a plain canvas):

- `readRect(x, y, w, h)` → ImageData; `writeRect(img, x, y, op = "copy", alpha = 1)`.
- `drawInto(rect, fn)`: `rect` is `[x0, y0, x1, y1]` in the pixels' own coordinates (null =
  all), rounded outward. The canvas backend runs `fn(ctx)` on the canvas's own context with
  the state reset to a fresh context's (transform, alpha, operation, styles, line, shadow,
  filter, smoothing, font, **and an empty path**) and clipped to the rectangle with a
  `Path2D`; it restores afterwards. So `fn` sets every piece of state it needs, never reads
  `ctx.canvas` or pixels back from `ctx`, and draws nothing outside `rect` that matters.
  Returns what `fn` returns. (The text above says "a scratch, written back with copy":
  that is the tile backend; a scratch plus a write-back in the canvas backend would round
  soft alpha through ImageData and break the 0-level gates.)
- `drawTo(ctx, ...drawImageArgs)`: the pixels as the source of one `drawImage` into
  another context, under that context's transform and clip. (The text above has
  `drawTo(ctx, dx, dy, dw, dh, level)`; every draw site used one of drawImage's three
  argument forms, so the facade takes them all. The level is C3's.)
- `blit(src, dx, dy, op, alpha, srcRect)` and `copyRect(rect)`: unscaled copies between
  pixels. "copy" is clearRect + source-over (never Chromium's whole-canvas "copy"); the
  whole-canvas operations (`destination-in`, `source-in`, ...) are clipped to the
  rectangle. Undo's `layerrect` / `selection` steps use these. (Added: a readRect +
  writeRect pair loses premultiplied precision at low alpha.)
- `clear(rect)`, `fill(rect, css)`, `bounds()`, `clone()`, `resized(w, h, {x, y})` (a new
  object, never in place), `toCanvas(rect?)`, `bytes()`, `static empty / fromCanvas (adopts)
  / fromImageData / fromImage(img, w, h)` (scaled like `imageToCanvas`).
- `version` is the canvas's `_dispVer`; `touch()` bumps it. **Writes do not bump it**: the
  editor's `touchSource` / `touchSourceRect` do, once, after the write, as today (a write
  that bumped it too would make `touchSourceRect` drop the pyramid on every dab). The
  scene cache (`pixelVersion`) is bumped by the same two calls.
- `canvasOf(src)`: the backing canvas of a LayerPixels (or a canvas as it is), **read-only**,
  for the display machinery only (`displaySource`, `touchSource*`, `sourceVersion`, the
  pyramid WeakMap, `releaseCaches`, `memoryReport`). C3 deletes those and this with them.
- `setPixelsOptions({ copy: true })` (the app's `--pixels-copy` switch): `toCanvas()` hands
  out copies, as the tile backend will. Running the gates this way proves that no call site
  writes into a handed-out canvas. A copy can sit on a different Chromium backing than its
  source (GPU vs software) and read back 1 level apart at low alpha; gates that compare
  handed-out canvases against the live ones need that tolerance in copy mode only.
- `installLayerAliases(layer)`: `canvas` / `mask` as **non-enumerable own accessors**
  (a spread copy carries `px` / `maskPx` and never calls them), converting a leftover own
  `canvas` / `mask` value. `deprecatedPixels(old, new)` warns once, or throws with
  `setPixelsOptions({ strict: true })`, which dev builds switch on in step (j) only: until
  then an unmigrated site keeps working through the alias, so every step's commit is green.

**The migration rules** (steps b to j):

1. **Layers**: `layer.px` (LayerPixels) and `layer.maskPx` (MaskPixels, **null** for no mask,
   never an empty mask). `installLayerAliases` runs wherever a layer object is made or
   re-made: `addLayer`, both spread restores in `applySnapshot`, `duplicateLayer`,
   `setValue`, the plugin `Document.addLayer`. The size of the pixels is their own
   resolution, never `layer.w` / `layer.h`.
2. **Replace, don't mutate** where the code replaces today: flip, rotate, crop, resize,
   extend, the transform commit, a text render, `applyMask`, `mergeDown`, a plugin's
   `setPixels` with another size, undo's `text` / `layerfull` / `mask` restores. Each assigns
   a new object (`layer.px = LayerPixels.fromCanvas(out)`), because the `layers` / `canvas`
   undo steps hold the old object by reference.
3. **Reads**: `drawImage(layer.canvas, ...)` into another context → `layer.px.drawTo(ctx, ...)`;
   `getImageData` → `readRect`; a canvas an API needs (a filter, `createImageBitmap`,
   `encodeCanvas`, `drawMesh`, a pattern, the worker) → `toCanvas()`, once per operation and
   never per inner loop.
4. **Writes**: `putImageData` → `writeRect`; a context taken from a layer and drawn into →
   `drawInto(rect, fn)` with the box the draw can touch (null when unknown); an unscaled
   copy from other pixels → `blit`. The `touchSource` / `markLayerChanged` /
   `markMaskChanged` / `markSelectionChanged` calls stay where they are and take the pixels.
5. **Selection**: `this.sel` (MaskPixels), null exactly when `this.selection` was null (the
   `!this.selection` guards, `pushUndo` above all, keep their meaning). Still red with the
   coverage in alpha in C1; layer masks still white with it in alpha. The editor keeps a
   deprecated `selection` accessor. The worker jobs get `this.sel.toCanvas()`; their answer
   comes back through `drawInto(null, ...)`.
6. **Base**: `this.base = { ref, img }` stays (its truthiness is "an image is loaded", its
   `ref` is the run input). `this.basePx` replaces `baseSource()` / `_baseCanvas`: built
   lazily from `base.img`, keyed on that object, which is exactly what `_baseCanvas` was.
   Pixel reads of `base.img` go through `basePx`. (The text above lists `this.base.img →
   this.basePx` as a rename; the `<img>` is released in C6.) One exception in C1:
   `resizeImage` keeps its scaled `drawImage(this.base.img, 0, 0, nw, nh)`, because a scaled
   draw of an `<img>` and of a canvas are not proven to resample to the same bytes; C6
   measures that before it releases the `<img>`.
7. **Undo**: `snapUrl` **stays** for the whole-layer steps (`layer`, `layerfull`, `text`,
   `mask`, the `canvas` step's selection), fed by `toCanvas()`. (The text above deletes it
   in C1: a canvas copy per step would put a 15k layer's 900 MB against the 384 MB budget
   and leave one undo step for smudge, filters and flips until C4 makes them tile refs.)
   `layerrect` and the canvas `selection` step hold `copyRect` pixels in `snap.px` and go
   back with `blit(..., "copy")`.
8. **What stays a canvas in C1**, because C3 / C5 delete it rather than migrate it:
   `StrokeBuffer` and the live previews (`strokePreview`, `maskPreview`, `maskedPreview`,
   `clipScratch`, `_livePreview`), `_masked`, the colour-match caches, the pyramid levels,
   `hoverObjectCanvas`, `flatCache`, `sceneCanvas`. `layerPixels()` / `layerWithStroke()` /
   `maskWithStroke()` keep returning a canvas (the display pixels, read-only); the commit
   of a stroke goes through the target's pixels. The filter layers' full-size placeholder
   stays `LayerPixels.empty(w, h)` (C2 makes it sparse).
9. **Not layers, same field name**: export descriptors (`exportLayerStack`, `buildLayered`,
   `inpaint_export.js`), `CLIPBOARD`, brush tips, `flatCache`, the GLB renderer, the film
   points cache, screenshot sources. Their `.canvas` stays.
10. **Outside the editor** in the step whose gate covers them: `host.js` (cutout input,
    point prompt into the selection, source canvases), `stitch.js` (selection, base ref,
    references), `commands.js`, `plugins.js`, the node's hand-written `js/inpaint_bridge.js`
    and `js/inpaint_node.js` (a commit in the node repo), and every `tools/*_test.py` that
    reaches into these properties (they must run in strict mode after step j).
11. **A write never inherits context state, and that is a deliberate output change** (decided
    in step (c)'s review). The 0.1.11 code wrote into a layer's own context and set only part
    of the state; the rest was whatever the code that made the canvas had left there. Four
    producers leave state on a canvas that becomes a layer's pixels: `flipLayer` (a mirror
    transform), `rotateLayer90` (a 90° transform), `applyPending` (`imageSmoothingQuality`
    "high") and `mergeDown` (the upper layer's `globalAlpha` and blend operation, and "high"
    smoothing). `drawInto`, `blit`, `clear` and `fill` start from a fresh context's state, as
    the tile backend's scratch will, so the facade cannot reproduce the inherited state, and
    the inherited behaviour was a bug each time: on a flipped or turned layer a smudge dab was
    written at the mirrored or turned spot, *Fill selection* on a merged layer blended with the
    merged layer's mode and opacity, *Clear* removed only part, and scaled or fractional draws
    on a transformed or merged layer resampled with a different filter. Every step that moves
    such a write lists it; the CHANGELOG carries what a user can see. Measured in step (c)
    (the review's A/B check, twins made by the real producers): with the reference context
    reset to a fresh state the old code and the migrated code agree to 0 bytes in all 48
    cases; with the inherited state, `commitStroke` agrees (it set everything it relies on)
    and smudge on a flipped / turned layer (86k to 290k bytes, up to 255 levels), fill and
    clear on a merged layer (up to 240k bytes) and bucket, fill, clear or smudge on a
    transformed layer (1k to 4.5k bytes) differ. **Known for step (f)**: `applySnapshot`'s
    `layer` restore draws into the layer's own context without resetting the transform or
    alpha, so in 0.1.11 undoing a fill after a flip puts the layer back mirrored (measured:
    237k differing bytes against the pixels before the fill, 0 on a plain layer); its
    migration fixes that and has to say so. **Fixed in step (f)** (the restore writes through
    `drawInto`): measured there, a merged-down layer with opacity below 1 also came back at
    that opacity (the leftover `globalAlpha`); after the fix, fill + undo gives the pixels
    before the fill to 0 bytes on a plain, flipped, turned and merged layer alike.

**Per step**: the step's sites, the gates below, a review of the diff, then the app commit,
`python tools/build_node.py`, `python tools/node_test.py`, the node commit, a push of both.
Every step runs `pixels`, `editor`, `composite`, `commands`, `shape`, `brush` on top of its
own gates. Step (j) runs every gate of §0 in strict mode, once more with `--pixels-copy`,
and `perf_test.py 15000x10000` against §9.

**C1 finished (step j, 2026-09-13).** The last sweep found no pixel reach through the old names
left in `renderer/`, `plugins/` or the node's hand-written `js/host.js`, `inpaint_node.js`,
`inpaint_bridge.js` (what is left named `.canvas` is rule 9's: stroke buffers, brush tips,
export descriptors, the clipboard, caches, the view canvas). Dev builds are strict now
(`renderer/shell.js` passes `window.scumble.pixels.strict`; `SCUMBLE_STRICT=0` turns it off; a
packaged build and the node warn once). Every test reaches pixels through `px` / `maskPx` /
`sel` / `basePx`, and `editor_test.py` has a permanent step for rule 11's undo fix (fill + undo on
a flipped, a turned and a merged layer gives the pixels before the fill). What the gates showed:
all fourteen app gates green in strict mode, green again with `--pixels-copy`, smoke (a real
Flux run) and node green. Copy mode found **no** write into a handed-out canvas; its two red
gates were harness effects, fixed in the tests: `pixels_test.js` read its own results through
`toCanvas()` (copies, 1 level apart at low alpha, and identity checks that only hold in share
mode; it reads through `readRect` and checks adoption with `canvasOf` now), and the source-window
step of `composite_test.py` counts uploads, which copy mode makes on every frame because a
layer's display pixels are a new copy each time (the counter is skipped in copy mode, the
pixels are compared in both). No comparison needed a copy-mode tolerance. The benchmark is
within noise of the build before C1 (`docs/PERFORMANCE.md` §9, "C1"; one row, the stroke commit,
reads 0.4 ms higher, below a twentieth of a frame).

What C2 inherits: **the aliases** (`layer.canvas` / `layer.mask` as non-enumerable accessors,
`editor.selection` as a class accessor; they go in the release after 0.1.12, with
`docs/PLUGINS.md`); **copy mode** as the model of the tile backend's `toCanvas()`, with its known
cost: `layerPixels()` / `layerWithStroke()` hand the display a copy per frame, so the identity-keyed
caches (the pyramid WeakMap, the compositor's source windows) rebuild every frame in that mode
until C3 takes the display off canvases; **the tolerance notes**: a copy can sit on another
Chromium backing and read back 1 level apart at low alpha, a canvas read back a few times moves
to software (step e), two canvases painted by the same code are not twins (step d), and a clip
tighter than Skia's bounds of a stroke changes the stroke (step d, pad by the line width);
**`canvasOf`** in the display machinery only; rule 6's `resizeImage` exception (C6); rule 7's PNG
undo steps (C4); and `perf_test.py`'s `settle()`, which drains the GPU queue with a one-pixel
`readRect` (hazard 214): a tile backend's `readRect` reads JS memory and drains nothing, so C2 has
to give the benchmark another way to wait for the GPU.

### C2. The tile store (1 week)

`renderer/editor/inpaint_tiles.js`, the second backend of `LayerPixels` and `MaskPixels`,
selected per editor by `ed.tileMode` (default from `settings.tiles`, on in dev, off in the
packaged build until C7's gate is green; the node's browser follows the same flag from
`localStorage`).

Decisions:

- **Tile size 256** unless B's table says 512 wins on the mip chain and the dab count (§B3).
  Key `(ty << 16) | tx` in a `Map`; a document side above 16.7 M px is refused with a message.
- **A tile is `{ data: Uint8ClampedArray(256·256·4), version, mips: Array(5) | null,
  frozen: false }`**; `MaskPixels` tiles are `Uint8Array(256·256)`. Mips (128, 64, 32, 16,
  8) are built lazily by the kernel (`mip_chain`) on the main thread at 50 to 100 µs a tile
  when the display asks for that level, in a worker when a whole layer changed (C6). Level
  5 and beyond (below 8 px a tile) are built per **document** from the level-5 mips: one
  small canvas for the whole layer at 1/64, the thumbnail and the object map read it.
- **Sparse**: a missing tile reads as transparent, `writeRect` allocates on demand, a tile
  whose alpha becomes all zero after a `destination-out` is dropped (checked on the tiles
  the write touched, by the kernel's return value). `bounds()` is the extent of the tile
  set, tightened by the mips' alpha of the border tiles (an 8 px mip says whether a border
  tile is empty on which side, so the box is within 32 px; `selectionBounds()` then scans
  only those border tiles for the exact edge, which is what `scanBoundsIn` does today with
  64 px strips).
- **Copy on write**: `clone()` shares every tile and sets `frozen` on both sides; a write
  into a frozen tile allocates a fresh tile first (`writable(tx, ty)`). Undo (C4) is the
  only user of `clone()` on whole layers; `frozen` is a counter, not a bool, so a tile shared
  by three undo steps and the document is copied once and stays shared by the steps.
- **Straight alpha in the tiles** (`PLAN_TILES.md` §3.1); `composite_tile` converts on the
  fly. **Memory: one 15k paint layer with a stroke is a handful of tiles; the base of a 15k
  photo is 2,352 tiles = 600 MB in renderer RAM** (typed arrays, outside the V8 heap but
  inside the renderer's ~8 GB; `PERFORMANCE.md` §4). That is the same bytes as today, moved
  from VRAM to RAM, which is the point.
- **`fromImage(img)` decodes in 4,096-row strips** through one scratch canvas of 4,096 ×
  256 and `readRect`, never a full-size canvas: a 15k base comes in as 40 strips × 59 tile
  columns in about the time `imageToCanvas` takes today. `toCanvas(rect)` materialises the
  rect only; without a rect it refuses above 268 MP (the caller has to use E's streaming).
- **`drawInto(rect, fn)`**: a scratch canvas of `rect` (pooled by size class, released to the
  pool after), filled from the tiles by `putImageData` per tile (a 400 px dab box is 4 to 9
  `putImageData` calls of 256², about 0.3 ms), `fn(ctx)`, then `getImageData` once and
  `writeRect(…, "copy")`. The stroke store makes this per-dab cost the whole cost of a dab.

Gate: `tools/pixels_test.js` runs every case against both backends and compares outputs
byte for byte (`drawInto` write-back, sparse growth and shrink, clone-then-write, bounds,
`resized`); `composite_test.py` still identical because the display still goes through
`toCanvas` of the visible rect in C2 (C3 changes that). `memoryReport()` counts tiles.

### C3. The compositor draws tiles (1 week)

`inpaint_compositor.js`, the GPU path. Decisions:

- **Atlas pages per (source, level)**: a page is a 4096² RGBA8 texture holding slots of
  `(256 >> level) + 2` px (a **one-pixel gutter** around every tile, filled with the
  neighbours' edge pixels by the store's `tileWithGutter(tx, ty, level)`, so `LINEAR`
  sampling at a tile edge does not bleed into the next slot; page capacity is 15 × 15 at
  level 0, 31 × 31 at level 1, …). Slots are allocated from a free list; a tile's slot is
  keyed by `(source, level, tx, ty)` and carries the tile version; a changed tile
  re-uploads its slot with `texSubImage2D` **from the typed array** (no canvas, no
  synchronisation wait; the 0.6 to 1.0 ms round trip of `PERFORMANCE.md` phase 5 is gone).
- **One instanced draw per (layer, level) per frame**: `drawArraysInstanced` over the
  visible tiles with a per-instance buffer of `{ tileRectInRegion(4), uvRectInPage(4) }`,
  rebuilt when the visible tile set or the region changes, reused on a pan inside the same
  tile set. Tiles of one layer never overlap, so the ping-pong structure of `composite()`
  stays: copy backdrop, draw the layer's instances reading the backdrop, swap. A layer whose
  tiles span two pages draws twice. Blend modes unchanged (the shader keeps `u_mode`);
  **three op modes are added** for the stroke store (source-over at opacity,
  destination-out, source-atop) and **a mask sampler** (`u_mask`, a page of the layer's
  `MaskPixels` at the same level) so `_masked` disappears: the shader multiplies the source
  alpha by the mask sample. Colour match stays the pass it is (`glMatchBackdrop`).
- **Level choice**: `level = clamp(floor(-log2(view.scale)), 0, 5)` per layer, from
  `layer.w * scale / px.width`; below level 5 the document-level small canvas is drawn as
  one texture. The pyramid budget (`_pyramidBudget`, "one level per frame") is deleted: a
  missing mip costs 50 µs per visible tile, computed on demand during the instance build.
- **Budget**: pages are an LRU by bytes, `settings.memory.atlasMB` default 512 (a Settings ›
  Rendering row; the memory watch of phase 6 lowers it under pressure instead of releasing
  caches). `stats()` reports pages and bytes; `memoryReport().compositor` shows them. The
  `WINDOW_PX` source windows of phase A item 4 are deleted along with `_texture` /
  `_source` (a source is never a canvas any more).
- **Canvas 2D fallback** (no WebGL2, or a lost context): `drawTo(ctx, …, level)` draws the
  visible tiles with `putImageData` into a per-editor scratch of the region at level
  resolution, then `drawImage` with the view transform. About 130 tiles on a 4K screen at
  level 0, 10 to 15 ms; acceptable for a fallback. `layerWithStroke` composes the stroke
  tiles per visible tile on that path.
- **The view pass and everything above it stay**: `viewportRegion`, `drawViewComposite`,
  the scene cache, the filter chain (filter layers still take the view-resolution canvas of
  everything below, produced by the compositor), the film shaders, overlays, ants.
- **Marching ants**: `drawMarchingAnts` takes `this.sel.toCanvas(region, level)` (the
  visible region of the selection mask at the view's level, cached by `sel.version` and the
  region) instead of `displaySource(this.selection)`; the nine draws are unchanged.

Gate: `composite_test.py` **re-baked once** (`--update`), the difference documented in the
test's header and in `docs/PERFORMANCE.md` §10: alpha-weighted box mips against Skia's
bilinear levels differ by up to 2 levels at exact halvings and by more on a hard edge at
fractional zoom (the fit value is reported, not gated, as §9 already says). The gpu-vs-2d
step compares the tile compositor against the Canvas 2D tile fallback (both from the same
tiles: expected ≤ 1 level). `perf_test.py 15000x10000`: pan, zoom, fit, first frame after a
zoom to 1:1 all ≤ 1 frame; `memoryReport()` no pyramid entries; GPU process ≤ atlas budget
+ 100 MB above start with one 15k document open.

### C4. Undo as tile references (3 days)

- One snapshot kind for pixels: `{ kind: "tiles", target: { layerId, which: "px" | "mask" }
  | { which: "selection" }, tiles: Map<key, Tile | null>, bytes }`. `snapshotRect(layer,
  rect)` freezes the tiles under `rect` and records them (null for a tile that did not
  exist). `applySnapshot` swaps them back, recording the current ones into the redo entry,
  and calls `markLayerChanged(layer, rect)` with the union of the tiles' rectangles.
  `layer`, `layerfull`, `mask`, `selection`, `text`'s pixel part and `canvas`'s selection
  part all become `tiles` snapshots (`clone()` for the whole-layer ones: O(tiles), no
  pixels copied until the next write). `bytes` counts only tiles the step holds
  **exclusively** (a frozen tile shared with the document costs nothing until it is
  replaced); `MAX_UNDO_BYTES` keeps its meaning.
- `releaseSnapshot` decrements `frozen`; a tile that reaches zero and is not the document's
  is garbage. No blob URLs, no PNGs in undo; `snapUrl` and `snapImage` are deleted.

Gate: `editor_test.py` undo steps (stroke, selection, transform, text, extend canvas,
crop, filter), `commands_test.py` undo/redo, `shape_test.py`; `perf_test.py` rows undo ≤ 5
ms and selection change ≤ 5 ms at 15k; a 30-step stroke history on a 15k layer holds only
the touched tiles (`memoryReport().undo`).

### C5. Painting into a stroke store, the selection as mask tiles (1 week)

- `StrokeBuffer` becomes a sparse `LayerPixels` at the target's resolution (`p.stroke`);
  `layerDab` / `stampDab` / `shapeDab` draw through `drawInto` (Canvas 2D rasterisation of
  the dab is **kept in C**: the brush look, the tips, the gradient hardness and the
  `brush_test.py` tolerance stay exactly what they are; a Rust dab rasteriser is a later
  measurement, not part of this plan). The compositor draws the stroke store's tiles over
  the layer with the gesture's op and `brushOpacity` (C3's op modes), clipped by the
  selection through the mask sampler when `p.clip`. `strokePreview`, `maskPreview`,
  `maskedPreview`, `clipScratch`, `clipCanvasFor`, `clippedStroke`,
  `refreshStrokePreview`, `releaseStrokeScratch` are deleted; `layerWithStroke` returns
  the layer's own store plus a `stroke` reference the compositor reads.
- **Commit** (`commitStroke`): per touched tile, `composite_tile(layerTile, strokeTile, op,
  brushOpacity, selectionTile?)` in the kernel (JS twin or Rust, whichever B chose), after
  the `tiles` snapshot of those tiles. Alpha lock is `source-atop`; erase is
  `destination-out`; a mask stroke composites into `maskPx` with the one-channel variant.
- **Selection**: `this.sel` is a `MaskPixels`. `selectionDab` draws into a stroke store of
  the mask (`drawInto` on an alpha scratch, written back as one channel). Rectangle,
  ellipse, lasso, polygon fills go through `drawInto` of their box. `selectionExtent`,
  `scanBounds`, `scanBoundsIn`, `cachedBounds`, `selectionDirty`, `selectionLoose` collapse
  into `sel.bounds()` (tile set + border-tile scan, C2). Grow, shrink, feather, invert,
  wand, bucket: the worker gets **tile bands** of the mask's bounding box plus the
  operation's halo (`n` for grow / shrink, `3·radius` for feather) and returns the tiles it
  changed; the flood of `floodRegion` samples the layer tiles under the box (`sampleRegion`
  keeps its coarse pass on a 2048 composite from mips and its box widening). Feather runs
  on the float EDT (a real Gaussian ramp on the distance), not `ctx.filter = blur` any
  more: the look of a feathered edge changes slightly and the CHANGELOG says so.
- `maskToCanvas()`, `selectionDataUrl`, `encodeSelectionSoon`, `SYNC_ENCODE_PX`: the state
  JSON keeps its `selection` PNG for compatibility with saved states, encoded from the
  mask's bounding box only (a small PNG with an offset; `setValue` reads both forms).

Gate: `brush_test.py` (tolerance 8 premultiplied, as today), `editor_test.py` (the erase
step that reads the screen, the marquee click, the outline on white, selection undo),
`shape_test.py`, `commands_test.py` selection commands; `perf_test.py` rows stroke ≤ 1
frame, release ≤ 1 frame, grow / shrink / invert ≤ 50 ms blocked at 15k, wand bounded
object ≤ 100 ms blocked; `memoryReport().scratch` without a selection canvas and without
preview canvases after a stroke.

### C6. Mips in the worker, thumbnails, hover, object map, colour match from mips (3 days)

- A whole-layer change (filter apply, `setPixels`, transform, paste, load) marks all its
  tiles' mips stale; `inpaint_worker.js` gets a `mips` job that takes a batch of tiles
  (transferred copies in C; the SAB path is E) and returns their mip chains, so the next
  frame after a big change is not 2,352 × 100 µs on the main thread. The display uses a
  stale mip until the fresh one lands (a version per mip level).
- `drawThumb`, `refreshLayerThumb`, `drawHistoryThumb`, `promptContextCanvas`, the film
  panel's `Document.flatten({ maxSize })`, the object map's ≤ 2048 source, `matchStats`'
  samples, the eyedropper's one pixel: all read the level whose size is nearest above the
  wanted size, through `sampleRegion`, which now composites tiles at a level (the CPU twin
  of the compositor, `composite_tile` with blend modes added).
- `baseSource()`, `_baseCanvas`, `imageToCanvas` for the base: gone; `this.basePx` is a
  `LayerPixels` filled by `fromImage` (C2). `this.base.img` is released after the fill (the
  `<img>` was 600 MB of decoded pixels re-uploaded by Chromium per draw).

Gate: `composite_test.py`, `film_test.py` (the panel thumbnails), `commands_test.py`
(`screenshot`, `sample.mean_color`), `smoke_test.py --no-helpers` (object map and cutout
still find their input); `perf_test.py` first frame after a filter apply ≤ 1 frame, full
composite row ≤ 300 ms at 15k (it is still a full-resolution flatten until E).

### C7. Both hosts, the flag, the release (3 days)

- The node's browser: `tools/build_node.py`, then `editor_test.py --node` and a real run in
  the ComfyUI tab; Firefox once by hand (a paint, a selection, an export). The Canvas 2D
  fallback is exercised by `composite_test.py`'s gpu-vs-2d step, and once by hand with
  `--disable-gpu`.
- `settings.tiles` on by default in the packaged build once every gate is green;
  `ed.tileMode = false` stays one release as the escape hatch (the canvas backend of C1),
  then the canvas backend is deleted in the release after.
- `mem_test.py 15000x10000 --rounds 4`: GPU process ≤ 300 MB above its start per open
  document (the atlas budget bounds it), renderer within 1.2× the tile bytes reported,
  closed documents fully collected (the phase 6 census).
- Docs: `docs/PERFORMANCE.md` §10 (C's numbers against §9's table, same rows), the node's
  `DEVELOPMENT.md` §24 (the tile rules: straight alpha, sparse, frozen counter, gutter,
  `drawInto` write-back, op modes), `docs/PLUGINS.md` (`rawLayer().canvas` deprecated,
  `getPixels` unchanged), `docs/BUGS.md` 15k entry closed with the measurement,
  `CHANGELOG.md` 0.2.0.

Gate: everything in §0, at 15k and at 30k for `perf_test.py` (interactive rows ≤ 1 frame; the
30k document is built per tile by the test, see E5, with three sparse paint layers, not
three full ones); `mem_test.py` as above; the installer built and the gates run against
`dist/win-unpacked/Scumble.exe` on its own profile (`CLAUDE.md` 2026-09-12 second block has
the recipe).

---

## 3. Phase E: full resolution per tile and the worker pool (2 weeks)

### E1. Cross-origin isolation and the worker pool (3 days)

- `electron/main/main.js` `protocol.handle`: every `scumble://app/` response carries
  `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
  Check `crossOriginIsolated === true` in the renderer at start and log it; every
  subresource is same-origin already (`/comfy/view` is proxied through the scheme, plugin
  files are served by the scheme, provider results come through IPC), so nothing else should
  break. If something does (an `<img>` from an external URL somewhere), route it through the
  mirror; never drop the headers.
- `renderer/editor/inpaint_pool.js`: `N = clamp(navigator.hardwareConcurrency - 2, 1, 8)`
  module workers (the same `inpaint_worker.js`, which loads the wasm once per worker when
  B chose Rust), a job queue with priorities (interactive mips first, export bands last),
  `pool.map(jobs)` returning in order, cancellation by job group (an export the user
  cancels).
- **The tile arena**: when `crossOriginIsolated`, tile `data` arrays are views into
  `SharedArrayBuffer` chunks of 64 MB (256 slots of 256 KB; masks 1,024 slots of 64 KB),
  allocated from a free stack, the chunk list posted to every worker once at creation and
  on growth; a job names tiles as `(chunk, slot)` and the worker reads them **without a
  copy**. A tile the main thread frees goes back to the free stack only after the job that
  reads it finished (a refcount per slot, incremented per job). Without isolation (the
  node's browser, Safari), the arena is plain `ArrayBuffer`s and jobs copy tiles in
  (`postMessage` with a copy, transfer of the result back); the job API is the same.
- **The kernels never share memory**: a wasm kernel copies its tile from the SAB into its
  own instance memory and back (B1). SIMD over a shared buffer would need the shared-memory
  wasm build we decided against.

Gate: `crossOriginIsolated` true in the app (logged, asserted by `log_test.py`); a `pool`
step in `pixels_test.js`: 2,352 tiles' mip chains through the pool on the SAB path and on
the copy path, identical results; mip refresh of a 15k layer ≤ 150 ms wall, ≤ 5 ms blocked.

### E2. Composite per band and the streamed PNG (4 days)

- `renderer/editor/inpaint_bands.js`: `compositeBand(doc, y0, y1, opts)` in a worker: for
  every visible layer (in `forRun` order, helpers left out as `drawLayersInto` does) the
  tiles that intersect the band rows, `composite_tile` with blend mode, opacity and mask,
  colour match applied per pixel from the layer's stored statistics (`matchStats` computed
  on the main thread from mips, passed in), and **filter layers rendered per band with a
  halo** (E3). The band is 256 rows (one tile row) by the document width; a 30k document is
  79 bands, distributed over the pool, each band a `Uint8ClampedArray` of `width × 256 × 4`
  (30 MB at 30k) that is transferred straight into the encoder.
- **PNG**: `PngStreamWriter` in the worker that owns the output: IHDR, then per band the
  rows filtered by the libpng heuristic (`png_filter_rows`, Rust or JS twin) piped through
  `CompressionStream("deflate")` (zlib format, exactly what IDAT holds, native and
  streaming; B's table decides whether `miniz_oxide` replaces it, and it will not unless it
  measured faster), IDAT chunks of 64 KB, CRC32 by table, IEND; the blob is assembled from
  chunk parts, never a full RGBA buffer. The `workflow` / `inpaint_canvas` tEXt chunks are
  written before the first IDAT (`pngWithText` on a blob goes away).
- `flattenToCanvas({ forRun })` callers become `flattenTo(kind, …)`: the export
  (`host.exportCanvas`: PNG streams, **JPEG and WebP composite through bands into one
  canvas up to 268 MP and refuse above with a message naming PNG**, because the browser has
  no streaming encoder for them, and the Size row's reduction happens per band before the
  canvas so a 30k document exported at 50 % is fine); the run (`stitch.prepareCrop` and
  `host.queueGenerate`'s crop): a `readRect` composite of the crop box through
  `compositeBand` on the box only, never the whole image; `commands.js` `screenshot` /
  `export_layer`; `Document.flatten()` without arguments (a box composite, or the streamed
  PNG when a plugin asks for a file).
- **Uploads** (`syncLayers`, `uploadCanvas`, `ensureOnServer`, the base after a flatten): a
  layer is streamed as a PNG from its tiles; the upload hash is the SHA-1 of the stream
  (`hashOf` moves into the writer). The local mirror and the node's `/inpaint_canvas/upload`
  route take a blob as before.
- **Decoding**: `fromImage` (C2) handles files the browser decodes (up to 268 MP through
  strips, `createImageBitmap(img, x, y, w, h)` per strip). Above that, **PNG only**, through
  `PngStreamReader` in a worker (`DecompressionStream("deflate")`, row unfilter in the
  kernel, tiles written per band). JPEG / WebP above 268 MP are refused with a message that
  names PNG. `svgSize` / `rasterizeSvg` stay as they are.

Gate: `tools/export_test.py`: a 6,000 × 4,000 document exported to PNG by the stream and by
the old `toBlob` path, decoded and compared (identical bytes of pixel data; the file bytes
differ by the deflate implementation), with a film look, a masked layer and a matched layer;
the `smoke_test.py` real Flux run (the run path composites the box); a 30,000 × 20,000
document (E5) exports to PNG in ≤ 30 s wall with ≤ 50 ms blocked and loads back through the
stream reader with the same pixels in four sampled tiles.

### E3. Filter layers per band with a halo (3 days)

- Every filter definition gets `halo(params, scale) -> px`: 0 for the colour filters
  (levels, curves, brightness / contrast, hue / saturation, colour balance, bw, invert,
  normalise, LUT), `ceil(3·sigma) + 2` for blur, 2 for sharpen, 0 for grain (the field is
  anchored at the image origin through `origin`, which the band passes as `[0, y0]`),
  document-sized for vignette (it needs its position, not its neighbours: `origin` plus the
  full size in `info`), and for the film pack per filter from `common.js` `blur()`'s sigma
  (halation, glow, light leak, structure, `useBlur` paths declare the largest sigma they
  use); plugin filters default to 0 and `docs/PLUGINS.md` documents the field. Normalise
  and every filter that reads global statistics (`colourStats`) get them from the main
  thread (from mips, as `matchStats` does) through `info.stats`, never from the band.
- The band composite in the worker renders a filter layer on `band + halo` rows and keeps
  the middle. **Which path**: a dedicated **GPU worker** (one, `inpaint_worker_gl.js`)
  runs `inpaint_filters_gl.js` on an `OffscreenCanvas` WebGL2 context (the module's two
  `document.createElement("canvas")` sites become `makeExportCanvas`-style helpers that
  pick `OffscreenCanvas` in a worker); the CPU workers do compositing and encoding and hand
  filter bands to it; without WebGL2 in workers the CPU twins run in the band's own worker
  (`info.cpu = true`, the same code `film_test.py` compares). The film pack's `chain` filters
  run through `scumble.gl` in that worker: `renderer/plugins.js` exposes the filter table
  and the GL API to workers by importing the plugin's filter module there (plugins declare
  `worker: true` in `plugin.json` when their filter module has no DOM dependency; the film
  pack does, the sample plugin does, the GLB and AI label plugins have no filters).
- `filteredCanvas` on the screen path is untouched (view resolution, the chain, the caches).

Gate: `film_test.py` gains a band step: the full-resolution export of a 4,000 × 3,000
document with every film filter, bands against a one-piece render, ≤ 1 level (the halo is
correct when the seams are invisible; a wrong halo shows as a 1-level line at every 256th
row, which the test asserts against explicitly); `export_test.py` with blur, sharpen,
vignette, grain and normalise layers; export of the 15k film-look benchmark document ≤ 3 s
wall, ≤ 50 ms blocked.

### E4. PSD and ORA streamed (2 days)

- `PsdWriter.layer()` takes bands, not a canvas: per layer, per channel, the PackBits rows
  are produced band by band and kept **compressed** (a 15k layer's four channels compress
  to a fraction of 600 MB; the row-length table PSD demands before the data is filled from
  the kept rows), the composite section the same way from `compositeBand`. Memory per export
  is the compressed output, never a decoded layer.
- `OraWriter`: zip **stored** entries with data descriptors (bit 3), each layer's PNG
  streamed by `PngStreamWriter`, `mergedimage.png` from the bands, the thumbnail from mips.
- `exportLayerStack` hands `{ px, maskPx, x, y, w, h, opacity, visible, blend }`; a scaled
  layer (`w ≠ px.width`) is resampled per band through `drawInto` of the band's box (Canvas
  2D, as `resizeForExport` does today), which keeps the 268 MP limit for **scaled** layers
  only and says so in the status line.

Gate: `export_test.py` PSD and ORA of the 6,000 × 4,000 document opened by the existing
readers in the test (the PSD parsed by the test's own minimal reader for sizes, offsets and
one row per channel; the ORA unzipped and each PNG decoded), pixels identical to the old
writers; the 30k document's PSD written in ≤ 60 s.

### E5. The 30k gate (2 days)

- `perf_test.py 30000x20000` and `mem_test.py 30000x20000`: the synthetic base is written
  **per tile** (a `fillTiles(px, fn)` helper the test calls through CDP, the same grid and
  markers as today's `paint()` but computed per tile, never through a 600 MP canvas), the
  paint layers are sparse (20 blocks each, as today, but only those tiles exist), the
  result layer 2048², the film look on top. Without phase D this is the honest limit of the
  renderer: base 2.4 GB of tiles plus sparse layers; **three full 30k paint layers would be
  7.2 GB more and are not in this gate** (that is D's job, and the plan says so in the
  CHANGELOG line for 0.2.x: "documents above 300 MP need their paint layers to stay sparse
  until the memory tiers land").
- The gate: the document opens (from a 30k PNG through the stream reader, ≤ 90 s), pan /
  zoom / a 400 px stroke and its release ≤ 1 frame, grow / invert ≤ 100 ms blocked, export
  to PNG and PSD (E2, E4), a loopback provider run through `generate_test.py`'s recipe on a
  1,024² selection, `smoke_test.py --no-helpers` with a real Flux run on the 15k document.

### E6. Finish (2 days)

`docs/PERFORMANCE.md` §10 completed (the E rows), the node's `DEVELOPMENT.md` §24 extended
(bands, halos, the pool, the two arena modes), `docs/PLUGINS.md` (`halo`, `worker: true`),
`docs/BUGS.md`, `CHANGELOG.md` 0.2.1 with the two limits stated plainly (JPEG / WebP above
268 MP, scaled layers in PSD / ORA above 268 MP), the installer built and every gate run
against the exe. Phase F's adaptive VRAM budget and Settings rows are **not** here; the
atlas budget row of C3 is the only new setting.

---

## 4. Decisions in one table (for the session that builds it)

| Question | Decision | Why |
|---|---|---|
| wasm glue | none: `extern "C"` + `WebAssembly.instantiate` | no CLI version to pin, loads everywhere, tiles in linear memory anyway |
| wasm threads | no; one instance per worker, tiles copied in and out | shared-memory wasm needs nightly and the node's browser has no SAB |
| kernel language | **JS** (B measured 2.0 to 2.4×, `PERFORMANCE.md` §10); the twins in `kernels_js.js` are the kernels, `floodMask` stays for the wand | `PLAN_TILES.md` §2, the 3× rule |
| tile size | **256** (B: a 400 px dab 1.6 ms of JS at 256 against 3.2 ms at 512; mips 1.14 against 1.30 ms per MP); tile buffers start on a 4 KB boundary | five mips to 8 px, 4 to 9 tiles per 400 px dab; 4K aliasing |
| alpha | straight in tiles, premultiplied inside kernels and shaders | PNG, ImageData, plugins are straight; the compositor already premultiplies |
| mip filter | alpha-weighted 2×2 box | no edge darkening; the one-time re-bake of `composite_test.py` refs |
| the flag | the backend of `LayerPixels`, never a branch at a call site | one migration to the facade (C1), the engine slots in behind it (C2) |
| Canvas 2D work | `drawInto(rect, fn)`: text, shapes, transform, dabs, clone / heal, GLB, label | their look does not change; a full-size scratch only for a discrete transform |
| dab rasterisation | Canvas 2D through `drawInto`, in C and E | the brush look and `brush_test.py`'s tolerance stay; a Rust dab is a later measurement |
| undo | copy-on-write tile refs, `frozen` counter | a step holds only what it changed; no PNGs |
| selection | `MaskPixels`, bounds from the tile set + border-tile scan | no readback of a GPU canvas ever again |
| feather | Gaussian ramp on the EDT | one kernel for grow / shrink / feather; look changes slightly, said in the CHANGELOG |
| compositor | atlas pages per (source, level), 1 px gutter, instanced draw per layer, mask sampler | no canvas round trip; `MAX_TEXTURE_SIZE` stops being a document limit |
| fallback display | `putImageData` of visible tiles at the level | works without WebGL2; 10 to 15 ms at 4K |
| isolation | COOP / COEP on `scumble://`, SAB arena when isolated, copy arena otherwise | same job API on both hosts |
| PNG deflate | `CompressionStream("deflate")` unless B measured Rust faster | native, streaming, zlib format |
| JPEG / WebP | through bands into one canvas, refused above 268 MP | no streaming encoder in the browser |
| filters at full res | per band with a declared `halo`, in a GPU worker (OffscreenCanvas WebGL2), CPU twins as fallback | the screen path stays as it is |
| phase D | not in this plan; the 30k gate keeps paint layers sparse | the renderer's ~8 GB cap is real without tiers |
| 4b | generated copy, node gets `host.js`, `tools/build_node.py`, C0 before any engine code | a crate, a wasm build and a worker pool are not sync patches |

## 5. What this plan leaves out on purpose

- **Phase D**: hidden layers and background tabs still hold their tiles in the renderer;
  four 15k documents open at once are 2.4 GB of base tiles each plus layers, inside one
  renderer process. The memory watch releases atlas pages, not tiles.
- **Phase F**: no adaptive VRAM budget; the atlas budget is one number in Settings.
- **A Rust dab rasteriser**, brush tips in the kernel, a per-tile transform mesh: each is a
  measurement first.
- **The blend modes in `composite_tile`** are needed by C6's `sampleRegion` and E2's bands;
  the spike's version has the five ops only. Add the nine modes in C6 with a unit test
  against the shader (the phase 5 premultiplied check, 2.3 levels).
- **Bit-exactness against 0.1.x**: a document exported before and after C differs by the
  mip change on the screen only; full-resolution exports (E) are identical for pixel
  layers and within 1 level for filter layers (the halo seams gate).

## 6. Time

| Step | Days |
|---|---|
| B0 to B3 | 3 |
| C0 | 2 |
| C1 | 5 |
| C2 | 5 |
| C3 | 5 |
| C4 | 3 |
| C5 | 5 |
| C6 | 3 |
| C7 | 3 |
| E1 | 3 |
| E2 | 4 |
| E3 | 3 |
| E4 | 2 |
| E5 | 2 |
| E6 | 2 |

Fifty working days for one person on nothing else; ten weeks. C1 is the step most likely to
run over (277 sites, every one a coordinate system), and it is also the one that can ship
on its own at any point, because the canvas backend keeps the pixels identical.
