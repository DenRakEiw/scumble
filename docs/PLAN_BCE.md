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
  `ctx.canvas` or pixels back from `ctx`, and draws nothing outside `rect` that matters. The
  one piece of state `fn` does **not** set is the transform: it composes on the one it gets
  (rule 12).
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
12. **A `drawInto` callback composes on the transform it gets, it never sets one** (added after
    the final C1 review, finding drawinto-fn-absolute-settransform). `fn` receives a context
    whose current transform maps the pixels' own coordinates: the identity in the canvas
    backend, a translation by the rect's origin on C2's scratch of the rect. So `fn`, and every
    helper it hands the context to, may only compose (`scale`, `translate`, `rotate`,
    `transform`, `save` / `restore`), never `setTransform` / `resetTransform`, and never reads
    `getTransform()` as absolute; a callback that set an absolute transform would draw shifted
    by the rect's origin on the scratch (down and to the right, mostly off it). Changed for it,
    pixel-identical today (a scale composed on the identity is the same matrix to the bit):
    `bucketFill`, `fillSelection`, `clearSelectedPixels` (`ctx.scale(sx, sy)` instead of
    `setTransform(sx, 0, 0, sy, 0, 0)`) and `maskFromSelection` (`save` / `scale` / `restore`
    instead of a scale set and an identity set back); measured on 49 scale pairs up to 15k, the
    scale set and the scale composed on the identity are the same `getTransform()` every time,
    and the old and new bodies write the same bytes. The helpers: `stampDab` and `drawMesh` /
    `drawTriangle` already composed. `paintShape` keeps its absolute transform (with the stroke
    buffer's origin passed in) because its context is always a `StrokeBuffer`'s from `ensure()`,
    never one a `drawInto` hands out; composing on `ensure()`'s translation is **not** the same
    matrix (the context holds it in float32: the translation differed in 774 of 1,392 measured
    layer / buffer combinations up to 15k, by up to 0.004 px), so it is not pixel-identical and
    waits for C5, which moves stroke buffers into `drawInto` and has to measure that difference.
    `clipCanvasFor`, `refreshStrokePreview`, `clippedStroke` and the display code keep their
    absolute transforms because they draw into canvases of their own.
    `tools/pixels_test.js` checks the rule by where the pixels land (a point drawn at the rect's
    own coordinates, a scale and a translation composed inside `fn`, a scaled draw at an alpha),
    not by reading the matrix, so the same cases hold for the tile backend. For the same reason
    (added by C2 (a)'s review) `fn` does not call `putImageData` or `isPointInPath` /
    `isPointInStroke`, clips to rectangles on whole pixels only, and does not read or write the
    pixels it draws into through their own methods (both backends throw on that).

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

**The final C1 review (2026-09-13)** found twelve defects (thirteen findings, two of them the same), none introduced by C1 (0.1.11 had
each of them), all fixed with a counter-proof (every new `editor_test.py` step is red on the code
before the fix). What C2 to C4 have to keep, because each is a pairing a new backend can break:
**a forward write and its restore agree** (rule 2 now also covers a fill or clear on a layer mask:
the `mask` step restores by replacing, so the fill writes into a `clone()`); **a `layers` /
`canvas` step owns its nested objects** (`snapshotLayer`: text, params, match, LUT, plate, copied
as their own steps copy them); **undo and redo are queued** (`queueHistory`) and wait for an
edit that pushed its step and writes after an await (`trackEdit`: grow, feather, invert); a text
restore cancels a pending render; **the history is released, never dropped** (`clearUndo`, also
when a same-size image replaces the layers), and the redo steps leave the budget before it trims;
**a write is touched after it lands**, including the restored selection in `setValue` and the
`canvas` restore (which decodes before it puts anything back) and the selection brush's dab; **a
`toCanvas()` result is valid until the next write** (the header of `inpaint_pixels.js`), so
`snapUrl`'s encode fails instead of falling back to the canvas after the edit. Also fixed: the
export row's host listener kept every closed tab alive, and so did the allocation site of
`makeUploaded`'s literal with accessor closures (a class with a prototype accessor now); a
listener or closure that holds an editor must not outlive it.

**The C1 close-out (2026-09-13)** fixed what a second review confirmed, each with a counter-proof
(`editor_test.py` steps `undo_is_refused_while_a_stroke_or_a_drag_is_held`,
`undo_does_not_run_over_edits_made_while_it_loads`, `text_edit_steps_give_their_blob_urls_back`
and a sub-check of `selection_keeps_its_bounds_through_a_restore_above_1mp`, plus two
`node_test.py` steps; every sub-check red on the code before). Rule 12 above is one of them. For
C2 to C4 the history now works like this: **a history step decodes its images while the step is
still on its stack, then pops it, takes the redo copy and applies it in one synchronous run**
(`loadSnapImages`, a synchronous `applySnapshot(snap, images)`), so an edit made during a decode
can no longer land first and be overwritten; **`historyGen`** moves with every change a waiting
undo must not run over (`pushUndoSnapshot`, `clearUndo`, `addLayer`, `setBase`) and is read when
Ctrl+Z is pressed, so an undo stops with a status line when the picture changed after the key
(an edit during its decode, during its wait for a grow, a layer added during a canvas redo)
instead of taking back the wrong step. **Extend, crop, resize, merge into the base and flatten
are tracked edits** (`trackEdit`, bodies `*Now`) that push after their upload with
`{ tracked: true }`, which does not move `historyGen`: an undo pressed during the upload waits and
takes the operation back (untracked, it undid the step below and the late push released its redo
copy; a merge filtered the old layer object out of a restored list, now by id). **Flatten is a
`canvas` step** like a merge into the base (without one, an older `layers` step put the baked
layers back over a base that held them). **Undo and redo are refused while an editing gesture is
held** (`gestureHeld()`: anything but pan, split and guide), because the step on top is the
gesture's own, pushed at pointer down. **A text edit's `before` step is released** when it is not
pushed (cancel, unchanged Enter), and `destroy()` clears the history after `close()`, which
commits an open text edit. **`setValue` encodes the restored selection again** (`selectionSeq`,
`selectionEncoded`, `selectionDataUrl` reset after the write): a `getValue` during the restore had
stored the empty selection's PNG as current. `docs/PLUGINS.md` carries rule 12 for plugin authors.
A C2 backend has to keep the synchronous apply: a restore that awaits between taking its step and
writing it reopens the race.

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

#### C2 as built: the decisions taken while building it (2026-09-13)

C2 comes in two steps: **(a) the tile backend on its own**, with its contract test, not wired into
the editor (no change to `inpaint_canvas.js`, `host.js`, `stitch.js`, `commands.js`, `plugins.js`,
`shell.js`, `electron/`); **(b)** wires it in behind `ed.tileMode`. Where this differs from the text
above, this wins; each difference says why. Step (a):

**The module.** `renderer/editor/inpaint_tiles.js` exports `TileLayerPixels` and `TileMaskPixels`, one
class mixin applied to `LayerPixels` and to `MaskPixels`, so every existing `instanceof LayerPixels` /
`instanceof MaskPixels` check (the editor, `plugins.js`, the tests) holds for both backends, and
`clone()` / `copyRect()` / `resized()` keep the class. `pixelsBackend(tiles)` returns `{ Layer, Mask,
tiles }` of either backend (both classes also carry it as `static backend`), for step (b). The public
API is the canvas backend's, method for method, with its argument forms and results (`readRect`
converts, truncates and flips negative sizes like `getImageData`, with its errors: a `TypeError` for
a NaN, an infinity or a value outside 32 bits, `IndexSizeError` for a zero size, a `RangeError` where
the int arithmetic overflows; `writeRect` "copy" converts like `putImageData`). Tile-only extras: `tileCount`, `writable(tx, ty)`,
`tileAt`, `tileKeys`, `mips(tx, ty)`; module exports `isTilePixels`, `scratchStats`, `TILE_SIZE`,
`TILE_MAX_SIDE`, `CANVAS_MAX_PIXELS`, `MIP_LEVELS`. The module has no side effects at import (the node
rule of C0). It imports `px/kernels_js.js`, so `tools/build_node.py` now copies `inpaint_tiles.js` and
`px/kernels_js.js` into the node (`docs/BUILD_NODE.md` said "px/ goes with C2") and its import check
walks subfolders and resolves imports against the importing module's folder.

**Tiles.** 256 × 256, key `(ty << 16) | tx` in a `Map`, a side above 16,777,216 px refused with an
Error naming the limit. A tile is `{ data: Uint8ClampedArray(256·256·4), version, mips, frozen }`
(plus private caches); `data` has its own `ArrayBuffer`, which starts on a page (§B3's 4K aliasing
rule; a tile copied into another measured 3.2 µs). Straight alpha.

- **`MaskPixels` tiles stay RGBA in C2** (decided 2026-09-13). The text above has `Uint8Array(256·256)`;
  but the selection is red and layer masks white with the coverage in alpha, and callers draw colours
  into both (`fill(null, "#ff0000")`, strokes, `destination-in` / `-out` draws). Single-channel mask
  tiles move to C5, with the selection as mask tiles.
- **`version`** is the object's, as in C1: it changes on `touch()` only. **A tile's `version` also
  changes on every write into it** (added: the mip and extent caches key on it, and a write is not
  followed by a touch everywhere, the tests least of all), and on `touch(rect)` for the tiles in
  `rect`. Tile versions come from one counter, so a dropped tile allocated again never repeats one.
- **Sparse.** A missing tile reads as transparent; writes allocate what they touch; a tile whose alpha
  is all zero after a write is dropped. The check runs on the touched tiles only, and only when the
  block written into a tile had zero alpha (the only way a tile can end up empty), which covers
  `clear`, "copy", `destination-out` and the other clearing operations, `drawInto` and blits. So
  **every allocated tile holds a pixel**, which `bounds()` relies on. A write of bytes a tile already
  holds leaves it alone (no copy, no version, no mirror sync), and a transparent write onto missing
  tiles allocates nothing.
- **Copy on write.** `clone()` shares every tile and raises its `frozen` counter (the number of other
  holders); `writable(tx, ty)` copies a tile while `frozen > 0` and lowers the counter, so a tile
  shared by the original and three clones is copied once per writer and the last holder writes in
  place (the case `tiles_clone_copy_on_write` counts it). Dropping or replacing a shared tile lowers
  the counter too. A holder that is garbage-collected without letting go leaves the count one too
  high: that costs the last holder one needless copy and never a write into a shared tile. There is
  no `release()` in C2; C4's undo steps need one.
- **Mips** are built lazily per tile with the kernel's `mipChain` (five levels, 128 to 8 px) and cached
  by the tile's version. **`bounds()` does not use them** (the text above tightens the box with them):
  the kernel's alpha is `(a0 + a1 + a2 + a3 + 2) >> 2`, so a pixel of alpha 1 is gone from the first
  mip on (asserted in `tiles_bounds`), and a mip cannot say that a region is empty. `bounds()` takes
  the tile set instead: since every tile holds a pixel, only the tiles of the outermost tile rows and
  columns can hold an edge, and their exact extents (one scan per tile, cached per tile version) give
  exactly the canvas backend's box.

**Bytes in.** Bytes that enter without a canvas (`writeRect` "copy", `fromImageData`) go through the
round trip a canvas gives straight alpha: a table of all 65,536 (channel, alpha) pairs, measured once
by `putImageData` / `getImageData` on a CPU canvas. 32,640 pairs change in that round trip and none
changes twice, so a read of the tile store gives back what the canvas backend gives back. (The first
read of a GPU canvas un-premultiplies 450 of the pairs one level differently; its later reads agree
with the table.) Everything read from a canvas (`getImageData`) is already in that form.

**The scratch path.** `drawInto(rect, fn)`, `writeRect` with an operation or an alpha below 1, `blit`
with an operation, and `fill` with a gradient or pattern run on a scratch canvas of the rectangle:
pooled by size class (powers of two from 64 per side up to 4096², at most 32,768 px a side, two per
class, 64 MP in the pool, other scratches made for the one use), an **`OffscreenCanvas`** with
`getContext("2d", { willReadFrequently: true })`, and
**`ctx.reset()` on every acquire**, which clears the pixels, the state, the save stack and the path, so
a callback that leaves a transform, alpha, operation, filter, shadow, path, clip or unbalanced
`save()` behind cannot reach the next use (`tiles_scratch_pool_no_state`). Then the tiles over the
rect are put in, the context is clipped to the rect when the scratch is bigger and translated by the
rect's origin (rule 12), `fn` runs, and the scratch is read back (in 4096² blocks) and written with
"copy" inside the rect. `writeRect` / `blit` with an operation make exactly the canvas backend's calls
on it. Also decided: a callback that throws still has what it drew written back (the canvas backend
keeps it too); a callback that returns a promise is an Error, and its scratch is not reused; a
scratch above 268 MP or 65,535 px a side is refused. Every other canvas the store makes (the
`writeRect` source, a blit source, `toCanvas`, the display mirror) is a `<canvas>` with a
`willReadFrequently` context filled by `putImageData` only, so it is on the CPU whatever
`setPixelsOptions` says.

- A tile-to-tile "copy" at alpha 1 copies bytes and **shares whole tiles** where both grids align
  (also up to both pixels' edges); a canvas-backend source is read with `readRect`; an overlapping
  copy of pixels onto themselves takes a copy-on-write snapshot first.
- A tile source is materialised **with a margin of two pixels** (`BLIT_MARGIN`) where the source goes
  on (measured: without a margin, a `source-over` blit at 0.35 came out 2,531 bytes apart, up to 4
  levels: Skia draws a sub-rectangle of an image by another path than a whole one; at a fractional
  position the draw samples the neighbours).
- **Canvas backend fix** found by the mixed-backend case: `blit(this, ..., "copy")` onto overlapping
  pixels cleared its own source before drawing it (the clearRect ran first). It copies the source
  rectangle first now, with the same two-pixel margin; no call site blits onto itself.
- A whole-canvas operation (`destination-in`, ...) of `writeRect` / `blit` is clipped to the
  destination rectangle **on whole pixels (outward) in both backends**: the scratch clips without
  anti-aliasing, a canvas with it, and the two agree on whole pixels only (no call site places one
  at a fraction).

**Strips.** `fromImage(img, w, h)` draws the whole (scaled) image translated by each strip's origin
into one scratch and reads it back, never a full-size canvas. **The strips are 4096 × 4096, not
4096 × 256** (the example above): a draw on a scratch translated by the strip's origin is not
byte-identical for a scaled image (measured: a 700 × 450 PNG scaled to 333 × 777 in 256-row strips,
6 bytes up to 2 levels; scaled to 5000 × 300, 10 bytes of 1 level where the second 4096-wide strip
starts), so an image of at most 4096 px a side is one untranslated draw and agrees to the byte, and a
bigger one is translated by multiples of 4096 only. A scratch of 64 MB instead of 4 MB; a 15k JPEG
took 635 ms against 547 ms with 256 rows (warm, measured). Chromium decodes a big `<img>` once and
keeps it for the strips (first draw 364 ms, the next ones 1.2 ms). `fromCanvas(canvas)` reads the
canvas with its own `getImageData` in 4096 × 256 strips and **does not keep it** (the canvas backend
adopts it), which is why the `layer.canvas` setter of a tile layer cannot see later writes into the
canvas it was handed.

**Canvases out.** `toCanvas(rect)` materialises the rect; `toCanvas()` always materialises everything
(a copy, like copy mode) and refuses above 268 MP with an Error that names E2's streaming, without
allocating anything. `resized(w, h, { x, y })` re-cuts the tiles at whole-pixel offsets (sharing
whole tiles when the offset is a multiple of 256). Every call site passes whole pixels (extend and
crop round theirs; `extend_canvas` rounds too), so a fractional offset, which the canvas backend
resamples, is repeated on a materialised canvas.

**The display mirror.** `canvasOf(src)` calls a method on both backends, `canvasForDisplay()` (no
import cycle: `inpaint_pixels.js` does not import the tile module). The canvas backend answers with its
canvas. The tile backend keeps one canvas per pixels object, made on first use, identity stable,
synced on every call from the tiles written since the last one (tracked by writes, not by version:
writes do not bump `version`), with `putImageData`, which ignores whatever state a caller left on its
context. Its `_dispVer` was first built as an accessor on `version`; **since step (b)'s review it is a
plain value that `touch()` sets, and assigning it does not change `version`** (the accessor kept the
pixels alive, below). Only the canvas backend keeps `version === _dispVer`, so code that bumps a display
canvas's `_dispVer` to invalidate does nothing to tile pixels: call `touch()`. Refused above 268 MP (C3
draws tiles instead). `drawTo` draws the mirror.

**Aliases and options.** `installLayerAliases`: the `canvas` / `mask` setters adopt into the layer's
current backend (its `px`, else its `maskPx`, else the canvas backend); a leftover own `canvas` /
`mask` value on a new layer object still becomes canvas pixels, because the function does not know
the editor's backend (step (b) passes it: `installLayerAliases(layer, editor.pixels)`). `setPixelsOptions({ software: true })`
is new: every canvas `inpaint_pixels.js` makes (`makeCanvas`, now exported with `resetContext` and
`WHOLE_CANVAS_OPS`) gets a `willReadFrequently` context. It is a diagnostic switch for the contract
test, off in the app.

**What Chromium did, measured in step (a) (for step (b) and C3 to C5).**

- **A plain canvas is rasterised on the GPU, a `willReadFrequently` canvas on the CPU**, and the two
  differ: tens of levels at anti-aliased edges and in gradients (up to 51 in the test's pictures,
  85 for the test picture with an arc, a stroke and a scaled draw at 2000 × 1500), and any amount of un-premultiplied colour where alpha is near
  zero. A getImageData does not move a canvas to the CPU. So the canvas backend in the app (GPU) and
  the tile backend (CPU scratch) do not agree to the byte on draws; on the CPU they do. Step (b)'s
  gates that compare pixels against stored references or expectations made on GPU canvases will
  see that; `composite_test.py` compares two display paths over the same pixels and should not.
- **Skia's CPU rasteriser is not exactly translation-invariant** for gradients, resampled images and
  the anti-aliased edges of curves and strokes. Gradients and resampled images round a few pixels a
  level or a few levels apart (an arc of radius 160 moved by (-100, -90): 15 bytes at 5 pixels, 2
  levels). **The editor's selection shapes differ by far more**: 150 ellipse marquees and 150
  selection-brush dabs drawn far from the origin on 3300 × 2300 came out 649 and 565 pixels apart,
  alpha up to 68 and 48 levels, and 28 and 7 pixels transparent on one side only (the review's
  measurement, repeated on the OffscreenCanvas scratch with the same numbers). So selection edges
  compared between the backends need an alpha tolerance, and a test must not assert that their
  `bounds()` agree. Lines, rectangles, polygons, unscaled images and most scaled draws agree to the
  byte. This is rule 12's float32 note again, and C5's stroke store inherits it.
- **A `willReadFrequently` `<canvas>` moves to the GPU for good once a GPU canvas is drawn into it**
  (a plain canvas, a plain OffscreenCanvas, a WebGL canvas, an ImageBitmap of a GPU canvas; `reset()`
  does not undo it and `getContextAttributes()` still says `willReadFrequently`): from then on it
  rasterises on the GPU and its read-back of untouched low-alpha pixels changes 1,350 bytes of the
  65,536 (value, alpha) pairs. An `OffscreenCanvas` with the same context stays on the CPU after each
  of those sources; against a CPU `<canvas>` it drew fonts (serif, sans, Arial, rtl, letter spacing),
  filters, shadows, patterns, gradients, fractional rectangles and images to the byte, and **clips
  without anti-aliasing** (an arc clip 588 bytes, up to 95 levels apart; a clip on whole pixels
  agrees). That is why the scratch is an OffscreenCanvas and the `drawInto` rules say "clip to whole
  pixels only".
- **A canvas side above 65,535 px** (both kinds) is made without an error and draws and reads nothing;
  a pooled scratch class of 65,536 px therefore erased the band it was drawn for.
- `img.decode()` never resolves in a hidden window (it waits for rendering); `onload` does.
- A `drawInto` callback with an unbalanced `save()` leaves the clip of that `drawInto` on the canvas
  backend's context (its `restore()` pops one level), so later draws into that layer are clipped;
  the tile backend's scratch is reset. Callers balance `save` / `restore`.
- `perf_test.py`'s `settle()` drained the GPU with a one-pixel `readRect`, which reads JS memory on
  tiles: step (b) reads the canvases the frames drew into instead.

**The test** (`tools/pixels_test.js`, `tools/pixels_test.py`). Every case runs three times: the
canvas backend as the app runs it (GPU; every check against a plain canvas holds as in C1), the
canvas backend with the software option (its canvases and the case's reference canvases on the CPU)
and the tile backend with the app's options (software off; only the case's reference canvases on the
CPU). Every output a case checks is recorded, and the records
of the CPU canvas run and the tile run are compared byte for byte; the GPU run against the tile run is
printed as information (`gpuVsTiles`). Tolerances, each with its cause and its exact measured count and
size in `TOLERANCES` (a change in either fails): `fill` with a linear gradient on a scratch at 60,0,
75 bytes, 2 levels; a 60 × 50 soft image scaled to 90 × 70 on a scratch at 120,110, 315 bytes, 5 levels
(low alpha); `fromImage` of a canvas and of an `<img>` scaled to 5000 × 300 across the 4096 strip
border, 10 bytes, 1 level each; the review's worst ellipse marquee (146 bytes) and brush dab (21
bytes), 30 of each (119 and 106 bytes), each 255 levels in red where a pixel is transparent on one
side only; all are the translation effect above, and a tolerance must be met exactly (a smaller
difference fails too). Twelve C2 cases were added:
sparse growth and shrink, copy on write with three clones, reads and writes across tile borders (255,
256, 257, negative, past the end), `bounds()` on tile borders and against the canvas backend (and why
not from the mips), `resized` with offsets across borders, `fromImage` unscaled and scaled (canvas,
bitmap, `<img>`), `fromCanvas`, `fromImageData`, `toCanvas(rect)` and the 268 MP refusal, the side
limit (a write into the last tile column), the display mirror, rule 12 on a scratch translated by
hundreds of pixels, the scratch pool carrying no state, `MaskPixels` on tiles, and blits between the
backends. Counter-proofs: the test goes red with each of six faults put into the tile store (writes
into shared tiles, empty tiles kept, the mirror not synced, no round trip, the scratch not reset,
`bounds()` looking at too few tiles).

**Timings** (printed by the test, not gated; the gate run of 2026-09-13, Electron's renderer on the
RTX 5090 machine, window in the background; `performance.now()` is clamped to 0.1 ms here):

| What | Canvas backend | Tile backend |
|---|---|---|
| a 400 px radial-gradient dab through `drawInto` on a 4096² layer with content, median of 60 (max) | 0.0 ms (0.1) queued on the GPU; 0.2 ms (110) with a one-pixel read-back after each | 0.5 ms (0.9), CPU, everything included; the layer is 256 tiles |
| `fromImage` of a 15,000 × 10,000 JPEG (decoded before) | 499 ms with a one-pixel read-back | 796 ms; 2,360 tiles, 590 MB |
| `clone()` of a full 6,000 × 4,000 layer | 9 ms with a one-pixel read-back | below 0.1 ms (384 tiles, 96 MB shared); the first write after it 0.1 ms |
| a tile copied into another (256 KB) | | 4.7 µs (no 4K aliasing) |

Four rows of the 15k image compared between the two `fromImage` results: 11,828 of 240,000 bytes a level
apart (the GPU draw). The scratch pool after the whole test: 15 canvases made, 94 reuses, 26.8 MP held.

**The review of step (a)** (four lenses, each finding checked by two verifiers) confirmed fourteen
findings, twelve distinct (two of the tests lens repeat the store lens's); each fix has a counter-proof,
a case of `pixels_test.js` that is red on a copy of the modules with that fix taken back (or the
review's fault put in):

- **The scratch moved to the GPU** once a GPU canvas was drawn into it, so the tile backend's output
  depended on which scratch had seen which source, and a `drawInto` that drew nothing rewrote 1,350
  low-alpha bytes and copied shared tiles: the scratch is an OffscreenCanvas, and a released scratch
  that reads the probe pixel (212, 24) back as a GPU canvas does is not pooled (`scratchStats().flipped`,
  never seen) (case `draw_into_scratch_stays_on_the_cpu`).
- **The store's own canvases were GPU canvases in the app** (`makeCanvas` without the software
  option), so the gate proved a configuration that does not ship: they are CPU canvases now and the
  tile run uses the app's options (`write_rect_ops`, `draw_to`, `blit_and_copy_rect`,
  `tiles_to_canvas_and_limits`, `tiles_display_mirror` go red without it). A fractional blit drew from
  the display mirror, a whole-layer canvas: it draws from the rectangle with the margin now, so a blit
  from pixels above 268 MP works (`tiles_to_canvas_and_limits`).
- **A scratch class above 32,768 px a side erased the band** it was drawn for (65,536 px canvases
  draw nothing): classes stop at 32,768 px, and a scratch, `toCanvas` or the mirror above 65,535 px
  a side is refused (`tiles_wide_draws`, a 40,000 px wide layer against the canvas backend).
- **`resetContext` missed the text state** the font shorthand does not reset (`letterSpacing`,
  `wordSpacing`, `direction`, `fontKerning`, `textRendering`, `fontStretch`, `fontVariantCaps`,
  `lang`), which `renderText` leaves on a text layer's canvas (`draw_into_text_state`).
- **`readRect` / `writeRect` converted a bad coordinate** (NaN, infinite, outside 32 bits) to 0 or a
  wrapped one where `getImageData` / `putImageData` throw: the tile backend converts as Chromium does,
  with the same error names (`read_write_rect`).
- **The canvas backend's self "copy" at a fraction** drew from a snapshot of exactly the rectangle,
  without the neighbours every other blit samples: the snapshot has the two-pixel margin
  (`tiles_blit_mixed_backends`).
- **A read or write of the pixels a `drawInto` callback draws into** was lost or stale on tiles: both
  backends throw on it now (`draw_into_does_not_reach_its_own_pixels`), and the `drawInto` rules in
  `inpaint_pixels.js` and `docs/PLUGINS.md` also forbid `putImageData`, `isPointInPath` /
  `isPointInStroke` and clips off whole pixels inside the callback.
- **The translation effect was documented tens of times too small** for the selection shapes (2
  levels against 68): the numbers above, and `selection_shapes_far_from_the_origin` pins them.
- **Test gaps**: the whole-tile share branch onto content with a mirror
  (`tiles_aligned_blit_copy_onto_content`), the tile caches after in-place writes
  (`tiles_caches_follow_in_place_writes`, mips against the kernel), dropped holders and transparent
  fills (`tiles_drops_and_transparent_fills`) and the column loops past 4096 px of `fromCanvas` and the
  write-back (`tiles_wide_draws`) each kill a fault that passed the suite before.

**Step (a)'s gates** (fresh dev instances, own profiles, strict), after the review's fixes: `pixels
editor composite commands shape brush nodecopy` ALL PASS; `--copy pixels editor composite` ALL PASS.

**Step (b): the tile backend wired into the editor behind the flag.** Built after an inventory of
every construction site, every `canvasOf` use, every path where pixels could cross editors and every
full-size `toCanvas()`.

- **The flag.** `electron/main/main.js` `tileMode()` decides once per window, in this order: the
  command line (`--tiles` / `--no-tiles`), the environment (`SCUMBLE_TILES=1` / `0`), `tiles` in
  `settings.json` when it holds a boolean the user put there, and otherwise the build (on in a dev
  run, off in the packaged app until C7). The default is resolved there and never written:
  `settings.set()` stores the whole merged object, so a computed default in `settings.DEFAULTS`
  would stick to whichever build saved first. It reaches the renderer as `--scumble-tiles=1|0` and
  `--scumble-tiles-from=<what decided>`, `electron/preload.js` exposes `window.scumble.pixels.tiles`
  / `tilesFrom`, and `renderer/shell.js` passes both to `setPixelsOptions({ tiles, tilesFrom })`
  (null when a host set none). No Settings row (C7 decides). Checked on dev instances with their own
  profiles: nothing set gives tiles ("dev build"); `{"tiles": false}` in settings.json gives canvases;
  `SCUMBLE_TILES=1` wins over that file; `--no-tiles` wins over `SCUMBLE_TILES=1` and `{"tiles": true}`;
  `--tiles` over `SCUMBLE_TILES=0`; and a `settings.set` of something else leaves no `tiles` key in a file
  that had none.
- **One backend per editor, for its life.** The constructor sets `ed.tileMode`, `ed.tileModeFrom`
  and `ed.pixels = pixelsBackend(tileMode)` (`{ Layer, Mask, tiles }`): the host's option when it
  set one, else `localStorage["inpaint_canvas.tiles"] === "1"` (the ComfyUI node's switch, read in
  the editor source, off by default; no new host member). Every construction goes through it: the
  34 sites of `inpaint_canvas.js` (`this.pixels.Layer.fromImage(...)`, ...) and the 4 of `plugins.js`
  (`this.editor.pixels`). `installLayerAliases(layer, backend)` converts a leftover own `canvas` /
  `mask` value into the backend it is given (all seven calls pass `this.pixels`); the alias setters
  adopt into the layer's own backend, as in step (a); `clone`, `copyRect` and `resized` keep their
  class. Pixels of the other backend can only come from outside the editor (a test, a plugin that
  made its own): `addLayer` passes `px` / `maskPx` through `ownPixels()`, which **throws in strict
  mode**, so a gate finds such a mix, and otherwise converts once with a warning. The mixing paths of
  the inventory needed nothing more: the clipboard holds a canvas that the pasting editor turns into
  its own pixels, undo steps hold pixels of their own editor, and stitch results, cutouts, the point
  prompt, the commands, the GLB, film and AI label plugins, `setValue` and merge / flatten all
  construct through `this.pixels`. `docs/PLUGINS.md` tells plugins not to assign pixels of their own
  or another document's. The `status` command answers `pixels: { tiles, from }`.
- **The display draws `canvasOf(px)`, never a `toCanvas()` copy.** `layerPixels(layer, display)`,
  `layerWithStroke(layer, display)` and `maskWithStroke(layer, display)` take a flag: with it an
  unmasked layer hands out its display canvas (the canvas itself on the canvas backend, the mirror on
  tiles; the same object every frame, synced from the writes). The masked cache `_masked` is always
  built from the display canvas, since it is drawn into right there. `display` is passed where the
  result is drawn at once and nothing keeps it: `drawLayer` (the view pass, the full-resolution
  composite, a pending transform's mesh), `glViewComposite`, `layerMatchedPixels`,
  `sampleRegion("layer")` and `sampleCanvas("layer")` (the layer and history thumbnails and
  `pickLayerAt`'s one-pixel read did too; the review took them off the display canvas, below). Exports, uploads, copy, merge, the helpers' source canvas,
  `serializeForPrompt` and stitch's references keep `toCanvas()`. The base, the selection and masks
  already went through `displaySource` → `canvasOf`. So the pyramid WeakMap and the compositor's
  texture map key on one canvas per pixels object in both backends, and C1's cost of copy mode goes
  with it: `composite_test.py`'s "no upload after a small pan", skipped in copy mode in C1, holds in
  copy mode and on tiles and is enforced in every mode now. `touchSourceRect` reads the display
  canvas right after the write (`canvasOf` syncs the mirror there), and `selectionExtent`'s
  `lvl === canvasOf(sel)` test holds on the mirror (a level is always a new canvas).
- **The level refresh reads a rectangle.** Level 0 of `touchSourceRect` draws from
  `pixels.displayRectSource(rect)`: the canvas itself at (0, 0) on the canvas backend (the same draw
  call as before), the rectangle alone as a CPU canvas on tiles, and the mirror there when the
  rectangle is above 4 MP. Measured on tiles at 8000 × 6000: with the mirror as the source, the frame
  after each move of a small selection drag spent 104 ms in `drawScene` (a draw from a changed CPU
  canvas into a GPU level; the canvas backend queues the same work on the GPU and returns in about a
  millisecond), from the rectangle 0.3 ms; a 40 MP rectangle materialised per move cost 260 to 320 ms
  against about 200 ms from the mirror, hence the 4 MP limit.
- **The selection drag** rewrote the whole selection on every pointer move (`drawInto(null)`, a
  full-size scratch per move on tiles). It now takes `selectionExtent({ exact: true })` at pointer down
  and per move clears the union of the outline's last and next extent, blits the extent to its new place
  ("copy", whole pixels) and refreshes the levels inside that box. Outside the union the selection is
  transparent before and after, so the selection pixels are those of the old code, **provided the
  extent holds every pixel with any alpha**: as first built it came from the 1/16 display level, which
  does not (the review, below). On tiles the extent is the tile set's exact `bounds()`; on the canvas
  backend it is the whole image (the old whole rewrite, GPU work there).
- **Memory.** `memoryReport()` reports pixels on tiles under the same slot names (`canvas`, `mask`,
  `_baseCanvas`, `selection`, the undo steps' `rectBytes` / `heldLayerBytes`) with `tiles` and the
  bytes of their allocated tiles, a tile shared copy-on-write counted once (layers first, then base,
  selection, undo; an undo step counts only tiles the live layers do not hold), a slot per display
  mirror, and at the top `tileMode` and `tiles` (`tiles`, `bytes`, `sharedTiles`, `mirrors`,
  `mirrorBytes`, the module's scratch pool); a canvas-backend report is unchanged. `mem_test.py`
  prints the tile and mirror bytes, which its canvas census cannot see. `releaseCaches({ mirrors:
  true })` also gives back the display mirrors of everything the editor holds (`heldPixels()`: layers,
  masks, base, selection, undo and redo steps), after the pyramid entries, textures and match caches
  keyed on them; the next frame makes and syncs them again (`releaseDisplay()`, 0 bytes on the canvas
  backend). The memory watch passes it for the tabs that are not in front and `host.freeHelpers` for
  the other tabs; the front tab's Free VRAM does not (a mirror is renderer memory, and making it again
  costs a putImageData per tile).
- **Tests.** Every test that builds pixels takes the editor's classes (`ed.pixels.Layer` / `.Mask` in
  `composite_test.py`, `perf_test.py`, `mem_test.py`, `editor_test.py`); strict mode would throw on a
  mix. `perf_test.py`'s `settle()` reads one pixel of the canvases the frames drew into and of the
  display canvases of the selection and the painted layer (and `gl.finish()`), not a `readRect`, which
  reads renderer memory on tiles; its selection writes are `clear` / `fill` of the rectangle instead of
  a whole-selection `drawInto`, which on tiles timed the harness. `pixels_test.js` has the case
  `display_rect_source_and_release`. `editor_test.py` has two new steps:
  `pixel_backend_is_the_one_the_flag_chose` (the backend is the one `SCUMBLE_TILES` asked for; the
  selection, the base, a layer and its `clone` / `copyRect` / `resized` are on it; `status` and
  `memoryReport` say so; the other backend's pixels are refused in strict mode; over the frames of a
  zoomed-out masked stack `toCanvas()` is never called, every display canvas stays the same object and
  the pyramid is finished and kept) and `editing_on_the_flags_backend_in_pixels_and_on_screen` (a
  real brush stroke with its `layerrect` step on the editor's backend, a fill, undo and redo of both;
  a duplicate that shares the original's tiles, a fill into the copy that copies the shared tile and
  leaves the original equal to the byte, a stroke into the copy, both undone back to the original's
  bytes; the selection dragged with the marquee: moved to the pixel, no move rewriting the whole
  selection), each checked in the layer's pixels and on the screen, in both modes.
- **No gate needed a tolerance, a per-mode reference or any other change for tile mode.**
  `composite_test.py` stayed identical to its stored references on tiles (full and view), and its
  GPU-against-2D and source-window numbers are the canvas backend's: its pictures enter the store as
  canvases read with `getImageData`, a canvas's un-premultiply followed by the mirror's premultiply
  gives the stored value back, and its writes into pixels are unscaled rectangles. The brush and
  editor strokes compare against references drawn in the same run and stay inside the tolerances they
  had. Where CPU and GPU rasterise differently (step (a)) no gate compares across the backends.
- **Counter-proofs** (`c2/b_mutate.py` in the session scratchpad: each fault put into the working
  tree, the gate run on tiles, the file put back and compared): the display taking `toCanvas()` copies
  (red: 81 copies in 12 frames and a pyramid never finished, the endless redraw of the inventory),
  the base on the canvas backend, a mix not refused, the selection drag writing the whole selection,
  the level refresh ignoring the rectangle's origin (red in `selection_brush_levels_follow_each_dab`),
  `displayRectSource` at the wrong origin and `releaseDisplay` keeping the mirror
  (`display_rect_source_and_release`): all seven red.
- **Measured, tile backend against the canvas backend** (dev instances on the RTX 5090 machine,
  window in the background, 8000 × 6000 with a selection, fit view; medians [max] in ms):

  | What | Canvas backend | Tile backend |
  |---|---|---|
  | smudge step (drawTo, clip, drawInto) | 0.3 [74] | 2.2 [263] |
  | frame after a smudge step | 18.2 | 13.4 |
  | `clipCanvasFor` (per smudge step) | 0.0 | 0.0 |
  | paint dab + frame | 11.1 | 12.1 |
  | stroke commit (undo copy, write, level refresh) | 29 | 22 (132 with the level refresh from the mirror) |
  | selection drag per move, 600 × 400 selection | 23 | 14 (140 from the mirror) |
  | selection drag per move, 7400 × 5400 selection | 28 | 237 |

  The smudge clip draws the selection's mirror into a small canvas and costs nothing measurable, so
  `clipCanvasFor` keeps its draw. `perf_test.py 6000x4000` runs in both modes with the new `settle()` (one run each, after `pixels` in the same instance, so for orientation, not against §9): pan 2.8 against 3.0 ms, wheel zoom 4.8 / 4.7, brush dab + frame 0.1 / 0.1, redraw with ants 0.1 / 0.2, undo step 9.3 / 10.6, the opacity tick 7.9 / 15.1, the stroke commit 1.0 / 38.9 (the canvas backend queues its work on the GPU), the full composite 0.3 / 9.2, and the selection operations, which on tiles materialise the whole selection for the worker and write the answer back through a whole-selection `drawInto`, grow 69 / 253, shrink 23 / 244, invert 22 / 224, feather 20 / 196, wand 82 / 246, bucket 92 / 138 ms blocked (C5 makes the selection mask tiles).
- **What stays for C3.** A write into large tile pixels shown zoomed out still costs a transfer of the
  mirror when their levels are rebuilt whole (a `touchSource` without a rectangle, the drag of a big
  selection above), and every pixels object that is displayed holds a mirror as large as itself in
  renderer memory next to its tiles (the 8000 × 6000 probe: 480 MB of tiles, 549 MB in three mirrors),
  plus, while it is shown at 0.5 or more, the screen's GPU copy of that mirror (VRAM, what the canvas
  backend holds anyway). `drawTo` still draws from the mirror, so a smudge, a fill of the selection or a
  clip made from the selection make one for what they read; a masked layer's cache is rebuilt from its
  mirror (one whole transfer per change of the layer, not per frame).
  The node's flavour follows `localStorage` and is gated with the switch off only (`node_test.py`).

**The review of step (b)** (three lenses, two verifiers per finding) confirmed six findings, five distinct,
and split one; each fix below has a counter-proof, a gate step that goes red with the fix taken back in a
copy of the app (`c2/mut-fix/run_mut.py` in the session scratchpad):

- **Mirrors for pixels nothing draws**: thumbnails now draw the tile store's `thumbnailCanvas()` (each
  tile's mips at the level whose long side stays at least 256 px, synced from the writes, released with
  the mirror, counted in `memoryReport().tiles`), `pickLayerAt` reads one pixel with `readRect`,
  `touchSourceRect` only touches pixels without a display canvas, and `selectionExtent()` on tiles is the
  tile set's exact `bounds()`, so a hidden layer, a rect write or a selection change in a background tab
  no longer undoes `releaseCaches({ mirrors: true })` (the review measured 5 mirrors, 240 MB; step
  `pixels_nothing_draws_get_no_display_mirror`, case `tiles_thumbnail_canvas`).
- **The selection drag lost faint isolated pixels** its 1/16-level extent rounded away (both backends):
  it takes `selectionExtent({ exact: true })`, the tile bounds on tiles and the whole image on canvases
  (the old whole rewrite, 0.2 ms a move on the main thread on a GPU selection canvas at 6000 × 4000; the
  display levels it then refreshed per move were GPU work this count missed, fixed by the final review
  below), and the drag step
  carries faint dots and a 3 × 3 block far from the rectangle (red with the level extent on either backend).
- **The screen drew CPU mirrors at zoom 0.5 or more** (44 ms a pan frame with a filter layer at
  6000 × 4000): `displaySource(src, scale, screen)` hands the screen (the view pass `drawViewComposite`
  marks `screen: true`, its overlays, the GPU compositor, a pending transform, never the navigator) a GPU
  copy of a tile mirror, made once per version, refreshed by rectangles in `touchSourceRect` and dropped
  when the screen asks that source for a level again; measured after the fix (`c2/rvd/zoomin.js`, median
  main thread / with a drain) a filter-layer pan at 1:1 3.6 / 12.8 ms (was 44 / 74.3), a selection drag move
  2.5 / 9.0 (was 17.5 / 86.5), a stroke commit 4.4 / 14.6 (was 41.4 / 85), and `perf_test.py` has a pan-at-1:1
  row (step `the_screen_draws_no_cpu_mirror_and_stale_textures_leave` counts every drawImage / texImage2D
  of a mirror; red with the mirror handed out and with the navigator counted as the screen).
- **A display canvas kept its pixels alive** through the mirror's `_dispVer` accessor (750 MB after 4
  flips at 1:1): it is a plain value `touch()` sets (after 4 flips and a collection nothing of the old
  pixels is alive, renderer 635 MB against 1,408), and the compositor drops a texture no composite asked
  for in 300 composites (`TEXTURE_STALE`, `stats().sourceBytes`), which the canvas backend needed too
  (case `version_and_canvas_of`; the screen step's held canvas and its three flips, red without either).
- **The drag's on-screen check never ran** (guarded by a tint display no gate profile has): the drag step
  zooms to 0.2, shows a tint and reads the screen before pointer up, the new place tinted and the old
  place white (red when only the new place's levels are refreshed).
- **Pixels of the other backend made inside the editor** (the split finding; nothing in the tree does it)
  are found by `checkBackend` in `touchSource` / `touchSourceRect` (strict mode throws) and by a sweep of
  every open editor's `heldPixels()` after each `editor_test.py` step (a flip onto the other backend is red
  at the check, and with the check taken out at the sweep).

Also measured: in this session's zoom-in probe the canvas backend fell into main-thread raster (a pan with
a filter layer 17 ms, a stroke move 60 ms) once a drag ran with a filter layer in the stack, on the build
before the review as well; in that state the whole-image drag rewrite costs about 100 ms a move against 18
with the level's extent. Keeping the GPU copies after a zoom out cost the stroke commit about 10 ms, hence
the drop; and the bounds scan on tiles no longer builds the selection's levels, so that build moved to the
first frame that shows them (`perf_test.py` ants redraw worst 76 ms, the scan's worst from 84 to under 12).

**Step (b)'s gates** (fresh dev instances, own profiles, strict): `--tiles on pixels editor composite
commands shape brush film glb ailabel size transparent generate log mcp nodecopy` ALL PASS;
`--tiles off` the same list ALL PASS; `--copy --tiles off pixels editor composite commands` ALL PASS
(`gates/c2b-tiles`, `c2b-canvas`, `c2b-copy` in the session scratchpad; `pixels` again in all three
after its new case). After the review's fixes the same three runs again (`gates/c2b-final-tiles`,
`c2b-final-canvas`, `c2b-final-copy`): ALL PASS, ALL PASS, ALL PASS (no stored reference, tolerance or per-mode expectation changed; `composite_test.py` identical to its references in all three).

**The final C2 review** (2026-09-14: canvas mode measured against main c6bc6a6 with the same harness,
`docs/PERFORMANCE.md` §9 "C2"; three lenses, two verifiers per finding) confirmed eight findings and split
one. Each fix has a counter-proof: a copy of the app with the fix taken back (`c2/mut-final/run_mut.py` in
the session scratchpad, 14 runs) is red in `editor_test.py`, all but one in the new step
`c2_final_review_drag_undo_steps_writes_mirrors_report_limits`, which runs in both modes:

- **The selection drag on canvases redrew the selection's display levels on every move** (the four levels
  the pointer-down's undo step built, 35 to 46 ms of GPU work a move at 15k against 6 to 7 on main, 1.5x at
  6000 × 4000), and with the selection canvas on the CPU its box clear plus "copy" blit cleared the image
  twice (a handler of 156 to 171 ms against 118 to 131): only tiles take the box path now, canvases run
  0.1.12's whole rewrite and `touchSource` again (after: 6.5 to 8.8 ms at 15k, handler 123 to 126; red: 24
  level draws in six moves at zoom 0.6). The step (b) fixer's zoom-in script no longer reaches Blink's
  canvas acceleration latch (0 of 3 runs, 6 of 7 before).
- **Undo of a mask brush stroke failed on both backends** since the C1 close-out ("could not load true": the
  history loaded a `layerrect` step's `mask` flag as an image); found while fixing the above, and present on
  main c6bc6a6: the flag is not an image any more (red on either backend).
- **On tiles no undo step holds a PNG** (C1 rule 7 stays for canvases): a whole-layer step (`layer`,
  `layerfull`, `mask`, `text`), the canvas step's selection and a selection step above 16 MP hold a
  copy-on-write `clone()` / `copyRect()`, restored by handing the clone back (`layer` in place, a "copy" blit
  that shares its tiles and refreshes the levels over the tiles that differ), counted as no bytes like the
  PNG it replaces. The PNG took a full-size CPU canvas and a bitmap per step, and on a 20000 × 12000 flip it
  failed to encode, so the flip could not be undone and exports failed after it; the review's script now
  passes every step on tiles (red: a PNG step, `snapUrl` called, whole `toCanvas()`).
- **Flips and turns on tiles move bytes in bands of 256 rows** (`turnedTilePixels`) instead of a full-size
  copy, a GPU canvas and a read back, and move them exactly (red: whole `toCanvas()`, and the canvas path's
  premultiplied draw changes low-alpha bytes).
- **Fill selection, clear selected pixels and mask from selection on tiles** write the selection's exact
  extent mapped into the layer (`selectionWriteRegion`) and refresh the levels in that box: a 100 px
  selection at 12000 × 8000 from 705 to 1111 / 457 to 607 / 829 to 1135 ms (fill / clear / undo) to 2 / 2 to
  5 / 19 to 22 (red: whole-layer `drawInto`; levels rebuilt, for the fill and for the undo).
- **An empty selection on tiles is not drawn** (tint overlay, navigator): it made a mirror as large as the
  image and a GPU copy of it at 0.5 or more for transparent pixels (red: a mirror).
- **Pixels that leave the document into a step give their display caches back** (`releaseDetachedDisplays`
  after every push and every undo / redo: mirror, thumbnail, levels, GPU copy, textures); a removed layer
  kept a mirror for the life of the step (red: three mirrors kept).
- **An image above 268 MP is refused on tiles** (`setBase`, before anything changes) and a selection encode
  whose `toCanvas()` throws neither throws out of `getValue` nor sets `_selEncoding` for good (the first
  autosave had stored the tab as "{}" and no selection was saved in that tab again); `load_image` answers a
  load that failed in a tab with a picture with the status line's error (red: a fake 20000 × 14000 image
  taken; `getValue` throwing).
- **The memory report's shared-tile counting is gated**: the reported tiles are the distinct tiles held, a
  duplicate's slot counts the shared tiles once, an undo step's rect bytes leave out tiles the layers hold
  (red with either dedupe taken out).
- **The canvas backend's selection extent loses isolated pixels in the undo step and the bounds scan**
  (since phase A): recorded in `docs/BUGS.md`, not fixed (an exact extent there is a full readback).
- **Docs**: step (a)'s `_dispVer` sentence is corrected in place, and step (b)'s drag bullet says what its
  0.2 ms did not count. The split finding (what C3 and C6 inherit) is answered below.

Tests changed with the fixes, on tiles only: `undo_does_not_run_over_edits_made_while_it_loads` (a fill's
step has nothing to decode, so its undo lands before the stroke), `undo_step_whose_encode_failed_says_so`
(nothing to lose: the undo puts the layer back) and the edit step's copy-on-write check (the original's
tile may still be shared by undo steps: its counter must cover every other holder). `perf_test.py` has three
new rows: a fill and a clear of a 100 px selection and the undo of that fill. No stored reference,
tolerance or per-mode expectation of any other gate changed.

**C2 finished.** The tile store is the second backend of `LayerPixels` / `MaskPixels`, the editor runs on it
behind `ed.tileMode` (on in dev, off in the packaged app), and canvas mode matches main in every measured row
(`docs/PERFORMANCE.md` §9 "C2"; the rows nearest an edge were timed again and are the same). **The final
review's gates** (fresh dev instances, own profiles, strict): `--tiles on pixels editor composite commands shape
brush film glb ailabel size transparent generate log mcp nodecopy` ALL PASS, `--tiles off` the same list ALL
PASS, `--copy --tiles off pixels editor composite commands` ALL PASS (`composite_test.py` identical to its
references in all three, `tools/refs/` untouched), and `smoke_test.py --no-helpers` with a real Flux run on
ComfyUI in both modes PASS (69 s on tiles, 62 s on canvases; the queue empty before and after each).

**What C3 inherits** (and C4 to C6):

- **The display scaffolding to delete with the mirrors** (C3): the tile store's `canvasForDisplay()` mirror
  (`_cpuMirror`, `_mirrorDirty`), `displayRectSource()` and the level-0 refresh through it,
  `displaySource(src, scale, screen)`'s `screen` with `gpuCopy()` / `pyramidEntry().gpu` and
  `viewPass.screen`, `releaseDisplay()`, `releaseCaches({ mirrors })`, `releaseDetachedDisplays()` /
  `scheduleDetachedRelease()`, `selectionHasNoTiles()`, the compositor's `TEXTURE_STALE` age limit (the
  atlas LRU replaces it), and `thumbnailCanvas()`. **The per-document level-5 canvas of the decisions above
  was not built**: `thumbnailCanvas()` stands in for the thumbnails (per pixels object, at the level whose
  long side stays at least 256 px) and the object map still reads the base; C3 decides whether that canvas
  is built for its "below level 5" draw, and C6 whether thumbnails keep this or go through `sampleRegion`.
- **What tile mode still costs** (15000 × 10000, `perf_test.py`, one run, against canvases): stroke commit
  284 ms (1 ms), grow / shrink / invert / feather 1.2 to 1.5 s blocked (0.04 to 0.3 s), band wand 2.4 s and
  object wand 4.4 s (0.5), bucket 1.1 s (0.5), cold composite 1.6 s (0.6), pan at 1:1 median 36 ms (3), the
  ants redraw's worst 458 ms; renderer memory 3.55 GB for a 12000 × 8000 document built (0.49 GB) and five
  times the compositor's texture bytes. At 20000 × 12000 with two full layers at 1:1: four mirrors of
  3.66 GB plus 4.9 GB of GPU copies, renderer peaks of 16 to 19 GB; a flip of a 16000 × 12000 layer takes
  1.2 to 1.6 s and a turn 1.8 to 2.0 s in bands (the canvas path took 1.7 to 2.2 s for the flip), and the
  first frame after it makes the new pixels' mirror.
- **Whole-selection operations for C5**: a marquee / lasso / polygon (`applyShapeToSelection`) still
  rewrites the whole selection through `drawInto(null)`; grow, shrink, invert, feather, the wands and the
  bucket materialise the whole selection for the worker and write the answer back whole; `drawTo` reads the
  mirror (smudge, the stroke clip); a masked layer's `_masked` is rebuilt from its mirror per change; a
  fill on a mask replaces the mask with a clone (rule 2), which makes its mirror again. **Single-channel mask
  tiles** also move to C5 (RGBA in C2).
- **For C4**: `release()` of shared tiles (a step that is dropped leaves its tiles' `frozen` counters one
  too high: a needless copy on the next write, never a write into a shared tile) and the bytes of the clone
  steps (counted as none now, like the PNGs they replace; C4 counts the tiles a step holds alone); PNG steps
  stay on canvases.
- **For C6**: rule 6's `resizeImage` exception (a scaled draw of `base.img`) is untouched by C2.
- **The node** follows `localStorage["inpaint_canvas.tiles"]` and is gated with the switch off only; nothing
  has run the node's flavour with tiles on.

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

#### C3 as built: the decisions taken while building it (2026-09-14)

Steps (a) and (b) are in (`main`, one commit each). What is **not** built yet is at the end of
this section; C3 is not finished.

**(a) The tile store hands out atlas slots** (`inpaint_tiles.js`, commit "C3 (a)"):

- **`tileWithGutter(tx, ty, level, out)`** is one slot: the tile at `level` (0 to `MIP_LEVELS`),
  **premultiplied** RGBA8, `(256 >> level) + 2` px a side, written into a buffer the caller keeps.
  Null when the tile is not allocated, which is the atlas's "nothing to draw here". `GUTTER`,
  `levelSide(level)` and `slotSide(level)` are exported with it.
- **Premultiplied**, because the atlas is sampled with `LINEAR` and straight alpha bleeds the colour
  of transparent pixels across an edge. The shader divides the alpha out again, exactly as it always
  did for the canvas uploads (which Chromium premultiplied on the way in). The forward table is
  Skia's `SkMulDiv255Round`, the inverse of the store's own round trip.
- **The gutter** is what stops a `LINEAR` sample at a slot's edge from reaching the next slot in the
  page: a neighbour that exists gives its edge row or column, a missing one reads as transparent (a
  missing tile is transparent), and past the image's own edge the tile's edge line is repeated, which
  is what a texture clamped to its edge gave when a layer was one texture.
- **`extendTile()`**: the last tile of a row or a column gets a clamp-extended copy before its mips
  are built. Halving the valid part alone mixes the last valid line with a transparent one wherever
  the valid width or height is odd, so the image's own edge would fade by a level of mip. The copy is
  kept on the tile, by its version, and only edge tiles ever have one (about `w/256 + h/256` of them).
  `thumbnailCanvas()` was deliberately **not** moved onto it: it has the same fringe, and that is C6's
  to decide with the rest of the thumbnails.
- Gate: `tools/pixels_test.js` case `tiles_atlas_slots` checks every tile of a 601 × 501 document at
  every level against an independent reconstruction from `readRect` (clamp-extended, halved
  alpha-weighted, premultiplied with Skia's rounding, the gutter taken from the neighbour the rule
  names). Red without the clamp extension, without the gutter and without the premultiply.

**(b) The compositor draws the tiles** (`inpaint_compositor.js`, `inpaint_canvas.js`, commit "C3 (b)"):

- **Pages per (pixels object, level)**, as the plan wanted, but the page is **sized to what is asked
  for**: at most `ATLAS_MAX_PER` = 16 slots a side and at most 4096 px, and the first page of a
  (pixels, level) is no larger than the tiles that frame wants. The plan's fixed 4096² page is 64 MB
  whatever the level, which at level 5 (a slot of 10 px) would be a page for 167,000 slots; this way
  level 0 is 15 × 15 slots (59 MB, which is what 225 level-0 tiles *are*) and level 5 is 160 px.
- **A slot** is keyed by the tile key inside its entry and carries the tile's `version`, so a tile
  that changed is re-uploaded with `texSubImage2D` **from the typed array** and nothing else is. A
  full page takes the slot of the tile drawn longest ago (never one of this frame).
- **One instanced draw per (layer, page)**: `drawArraysInstanced` over `{ rect(4), uv(4) }` per tile.
  **The rects are in image coordinates and the region is a uniform** (`u_region`), which the plan did
  not say: with clip-space rects the buffer has to be rebuilt on every pan, and at fit on a 15k
  document that is 2,400 tiles a frame, 1.9 ms against 0.3. The buffers are cached per entry and
  rebuilt only when the visible tile set, the pixels' version, the layer's rectangle or the atlas's
  generation changes (a page deleted or a slot that changed hands bumps the generation).
- **The blend shader is the one it was**: `BLEND_GLSL` is shared by the quad program and the atlas
  program, which differ only in how they sample. The three op modes for the stroke store and the
  `u_mask` sampler of the plan are **not** built (see below), so a masked layer still goes through
  its `_masked` canvas and the display pyramid.
- **The editor**: `glLayerSpec(px, ...)` hands a tile store over as itself with the level to draw,
  `floor(-log2(scale))` clamped to the mips a tile carries; everything else (a colour-matched layer,
  a masked layer's `_masked`, the canvas backend) keeps `displaySource`. So **a tile-backed layer the
  compositor draws has no display mirror, no GPU copy of one and no pyramid entry at all.** The
  plan's "below level 5 the document-level small canvas is drawn as one texture" was **not** needed:
  at level 5 a 30k × 20000 document is 9,126 tiles of 8 px, 3.7 MB of pages and one instanced draw.
- **The budget** is `settings.memory.atlasMB`, default 512, a row in Settings › Rendering; pages are
  an LRU by bytes with an age of 300 composites. `stats().atlas` and therefore
  `memoryReport().compositor.atlas` report pages, slots, bytes and uploads; `releaseCaches` counts
  the atlas in what it frees and the memory watch counts it for the front tab. The watch does **not**
  lower the budget under pressure (the plan's wording); it releases the pages with the caches.
- **`forgetPixels()`**: the atlas pages of pixels that leave the document go with them
  (`releaseDetachedDisplays`), like the mirrors of C2's final review.

**The trap this step cost an afternoon**: Chromium applies `UNPACK_PREMULTIPLY_ALPHA_WEBGL` to an
**ArrayBufferView** upload too (the WebGL spec says the unpack switches apply to DOM sources and
`ImageData` only). A canvas source uploaded earlier in the same frame — a masked or colour-matched
layer — leaves the switch on, and every partly transparent tile pixel was then premultiplied twice:
a text layer lost its anti-aliased edge (65 levels on 1,389 pixels) while every layer on its own was
exact. Both switches are set explicitly before each slot upload now.

**Measured** (15000 × 10000 on tiles, `perf_test.py`, three new rows with the filter layer hidden so
the compositor takes the stack — the benchmark's document always has one, which is why C3 changes
none of its old rows):

| row | before C3 | after |
|---|---|---|
| pan at 1:1, GPU stack | 0.1 ms | 0.1 ms |
| pan at fit, GPU stack | 0.1 ms | 0.3 ms |
| **first frame fit → 1:1, GPU** | **1027 ms** | **35 ms** |

and the compositor holds **91 MB in 43 atlas pages** where the old path made a 600 MB CPU mirror per
source plus a GPU copy of it. The steady pan was already cheap on both: C2's GPU copy of the mirror
is cached too. What C3 removes is the *making* of it.

**Gates.** `composite_test.py`'s gpu-vs-2d step now shoots **at 1:1 as well**, where neither path
resamples, and that is the row it gates on tiles: the tile compositor has to agree with Canvas 2D to
the level there (max 1). At a fractional zoom the two legitimately differ — the compositor draws the
tiles' alpha-weighted box mips, Canvas 2D the Skia level — so that row is reported, exactly as the
window step's `fit` row already was. The window step checks the **atlas** on tiles instead of the
source windows (pages for both sources, bytes far below the whole sources, and a pan **back**
uploading nothing), and `editor_test.py` checks that a layer the atlas draws has neither a display
mirror nor a pyramid entry and gives its pages back when it is removed. Runs: `--tiles on` and
`--tiles off` with `pixels editor composite commands shape brush film glb ailabel size transparent
generate log mcp nodecopy` ALL PASS, `--copy --tiles off pixels editor composite commands` ALL PASS.
Every fix has a counter-proof (the unpack switch, `forgetPixels`, the tile path itself, the clamp
extension, the gutter, the premultiply: each mutation red).

**(c) The selection's overlay is drawn from the mask's own tiles** (commit "C3 (c)"):

- **`regionCanvas(rect, level)`** on the tile store: the part of the pixels a view shows, at a level,
  as a CPU canvas built from the tiles' mips. Whole tiles with one tile of margin around the
  rectangle, kept while the range asked for stays inside it (so a pan only rebuilds when it leaves
  it), synced from the tiles written since the last call like the display mirror, released with it
  and counted in `memoryReport().tiles.regions`. Its last row and column carry `extendTile`'s clamp,
  so the caller crops the draw to the image itself.
- **`drawSelectionInto(ctx, scale, region)`** draws the mask over the image rectangle it covers: on
  tiles that region canvas at `floor(-log2(scale))`, on canvases the display pyramid's level, exactly
  as before. The tint, the nine draws of the marching ants and the navigator's thumbnail take it.
- Measured (15000 × 10000, tiles): the worst frame of `redraw with ants` **391 to 479 ms → 70 to
  73 ms**, the document's display pyramids **956 → 768 MB**, and the selection's whole share of the
  display is now **one region canvas of 9.2 MB**. `perf_test.py`'s footer says what the display costs
  on tiles (mirrors, region canvases, pyramids), which is the number the rest of C3 has to move.
- Gate: `editor_test.py` step `selection_overlay_is_drawn_from_the_mask_itself`, which runs on **both**
  backends against the same expected pixels.

**(d) Canvas 2D draws a tile layer from its own tiles too** (commit "C3 (d)"):

- **`drawTilesInto(ctx, px, x, y, w, h, vp)`** draws the part of a tile store a region pass shows, at
  the view's level, from step (c)'s region canvas; `drawLayer` takes it for a plain layer (no mask, no
  colour match, no live stroke on it) while a view pass runs. So the path the editor uses whenever the
  GPU compositor stands down — a filter layer in the stack, a live stroke, a transform, compare and
  peek — needs neither a display mirror of the whole layer nor a Skia pyramid on it.
- A tile store keeps a region canvas **per level, two at a time** (the screen's and the navigator's,
  `REGION_LEVELS`), and a whole rebuild is **one `putImageData`** of a buffer the tiles are copied into
  row by row: one call per tile was 2,400 calls at fit on a 15k document.
- Measured (15000 × 10000, tiles, with the benchmark's `film.look` layer, so every frame is the Canvas
  2D path): **pan at 1:1 41 → 2.5 ms**, the opacity slider 56 → 8, a selection change 78 → 21, an undo
  step 66 → 18, the selection's bounds scan 11 → 2, the document's **display pyramids 768 → 196 MB**.
- **What it moved rather than removed**: A/B on one document (a 15k base, a full paint layer, a filter
  layer) the first three draws at fit were 0.2 / 341 / 0.3 ms and are 0.1 each; the **first frame of a
  brush stroke** went 218 → 355 ms. The live preview still copies the layer's display **mirror** into a
  full-size canvas (2 mirrors, 1.1 GB at 15k), and that is now the only thing in the tree that makes a
  mirror for the screen. 559 ms of stalls became 355 in one place, and the stroke store of **C5** is
  what takes it away.
- Gate: `editor_test.py`'s backend step adds a filter layer, checks the compositor really stands down,
  and that the plain layer still has no display mirror and no pyramid entry and was drawn from its
  tiles.

**What C3 still owes** (the plan's §C3, not built):

- **The live stroke's preview** is the last user of a tile store's display mirror: `layerWithStroke`
  copies the whole layer into a full-size canvas at the first dab (355 ms and 1.1 GB at 15k). That is
  C5's stroke store, so `canvasForDisplay`, `displayRectSource`, the level refresh in
  `touchSourceRect` and `releaseCaches({ mirrors })` stay until then — as does the full-resolution
  Canvas 2D path of exports, runs and the flattened composite, which is phase E's.
- **The mask sampler** (`u_mask`) and the three op modes for C5's stroke store, so `_masked` and the
  live stroke preview stop being canvases.
- Therefore `WINDOW_PX` / `_source` / `_texture`, `_pyramidBudget` and the display pyramid are **not**
  deleted, and `memoryReport()` still has pyramid entries whenever one of those paths ran.

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

#### C4 as built (2026-09-16): undo steps share whole tiles and let them go

C2 had already replaced the undo steps' PNGs with copy-on-write clones on tiles, so what §C4 above describes was mostly
there; `dist/c6map/critic.md` (WRONG, the `snapshotRect` item; MISSED, the redo copy) named what was left.

**Before.**
- `snapshotRect` put its box at `floor(x) - 2`, and `copyRect` shares a tile only when the copy starts on the tile's
  corner: a stroke's step copied every tile its box overlapped into a new one. The same for a selection step's extent.
- The redo (and undo) copy of a `layerrect` step was taken again through the padded box: it grew by 6 px per round trip.
- Nothing ever put a tile's `frozen` count down. A tile a step had shared once stayed frozen after the step was gone, and
  the document's next write into it copied the whole tile for nothing.

**What was built.**
- `inpaint_tiles.js` `release()`: every tile's `frozen` down by one, the map emptied. `inpaint_pixels.js` has a no-op.
- `releaseSnapshot` releases a step's own `px`, `maskPx`, `selPx`. The restores that put a step's pixels into the
  document take them out of the step first: a canvas step's selection, a mask step, a text step, a `layerfull` step.
  A `layers` / `canvas` step's layers and base are the document's objects by reference and are never released.
- `snapshotRect` on tiles grows its box to whole tiles; `snapshotRect(..., exact)` takes a step's box as it is (the copy
  `historyStepNow` takes for the other stack). `snapshotSelection` on tiles grows the extent to whole tiles too.

**After.** In a 4000 x 3000 layer: a stroke's step shares the layer's tiles until the stroke writes, then holds exactly the
originals of the tiles it touched (1 for 1); 30 strokes hold 58 tiles for 56 touched tiles (a tile two strokes touched is
held by both); two undo / redo round trips keep every box; a dropped step that froze 12 tiles leaves none frozen.
`perf_test.py 15000x10000` A/B in one session: "undo step" 43.0 → 25.6 / 26.3 ms, "stroke commit" 17.7 → 16.2 / 20.0,
"selection change" 20.0 → 20.7 / 21.3; "undo of that fill" read 37 → 361 → 29 ms over the before and two after runs (the
row that swung the same way in 7b's runs), the rest within noise. **§C4's gate bound (undo and selection change at most
5 ms at 15k) is not met and does not fit the rows:** "selection change" writes a third of the picture (5000 x 3333 px)
into the mask, and "undo step" awaits the history queue and its frame. Not broken down further.

**Gate.** `editor_test.py` `undo_steps_share_whole_tiles_and_let_them_go` (the pixels on both backends, the tile counts on
tiles): (o) a dropped step leaves no tile frozen; (i) one stroke's step shares, is on the tile grid and holds exactly the
touched tiles after the write; (ii) 30 strokes hold no more tiles than they touched; (iii) 30 undos, 30 redos and a second
round trip give the pixels back and keep the boxes; (iv) a write into the layer leaves the pixels the redo steps hold;
(v) no tile of the layer or the selection frozen after the history is gone; (vi) the undo of a crop, twice, puts the
selection back. Five mutations, each red (fresh instances): no alignment ("did not share"), `release()` a no-op ("left 12
tiles frozen"), the redo copy not exact (the boxes grew to 1280 x 1280 and more), a canvas step's selection left in the step
("a second undo of the crop lost the selection"), a mask step's mask left in the step (`editor` in full:
`a_new_mask_and_a_neighbours_write_reach_the_screen`, "the first mask back: the screen shows nothing").

**Runs:** `s4-all-tiles` (editor pixels composite shape brush film glb ailabel size transparent generate log mcp llm toapis
nodecopy): all PASS but `editor`, `closed_tabs_are_collected` `[false, false, false, true]` (the known flake; its third
appearance on 2026-09-16), `s4-editor-tiles2` PASS; `s4-all-canvas` (editor pixels composite film glb mcp shape brush) ALL
PASS.

**Left:** `pointer.orig` of a selection move and `layer._textUndo` still hold clones that are never released (too high a
count only costs a copy). The memory report still does not count `t.mips`, `t.edge`, `THUMB_MIPS`, `PREMUL` or the
compositor's `tileBufs` (critic MISSED).

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
  the layer's own store plus a `stroke` reference the compositor reads. The dab code inside
  `drawInto` obeys C1 rule 12: `paintShape` stops setting its absolute transform (with the
  buffer's origin) and composes on the context it gets, which moves its translation by up to
  0.004 px in float32 (measured in C1); `shape_test.py` and a byte count against the C1 build
  say whether that is visible.
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

#### Where C5 starts, as the tree stands after C3 (2026-09-14)

The plan above is unchanged; this is only the list of sites and the numbers to beat, so the session
that builds C5 does not have to find them again. Everything named here is in
`renderer/editor/inpaint_canvas.js` unless it says otherwise.

**(1) The stroke store — this is what finishes C3.** After C3 (d) the live preview is the **only**
thing left that makes a tile store's display mirror: `layerWithStroke` (5384) asks
`canvasOf(layer.px)` and `refreshStrokePreview` (5352) copies the whole layer into `strokePreview`, a
canvas as large as the layer. Measured A/B on a 15000 × 10000 document (a base, one full paint layer,
a `film.look` layer): **the first frame of a brush stroke is 355 ms and leaves 2 mirrors, 1.1 GB**,
while every other frame of that document is now 0.1 ms. The sites: `StrokeBuffer` and
`newStrokeBuffer` (5253), `clipCanvasFor` (5262), `clippedStroke` (5281), `commitStroke` (5304),
`refreshStrokePreview` (5352), `layerWithStroke` (5384), `maskWithStroke` (3050), and the scratch
canvases `strokePreview` / `maskPreview` / `maskedPreview` / `clipScratch` that
`releaseStrokeScratch` keeps. The compositor's side is `_drawTiles` in `inpaint_compositor.js`: the
op modes and the `u_mask` sampler of §C3 that C3 did not build are exactly what the stroke store and
`_masked` need, so they belong to this step now.
`perf_test.py`'s `brush dab + frame` row (worst 182 ms at 15k, median 0.1) and `stroke commit (undo
copy)` are the rows that must move; read them **without ComfyUI on the card** (it changes the op rows
by 3 to 5×).

**(2) The selection on mask tiles.** What still materialises the whole mask, with the numbers from
C2's hand-over (15000 × 10000, blocked on the main thread, against 0.04 to 0.5 s on canvases):
`applyShapeToSelection` (4371) rewrites all of it through `drawInto(null)`; grow, shrink, invert and
feather **1.1 to 1.6 s**; the band wand **2.4 s** and the object wand **1.0 to 4.4 s**; the bucket
**1.1 s**; `selectionDab` (4230); `floodRegion` and `sampleRegion` (4508); `drawTo` (the smudge and
the stroke clip) reads the mirror. Those seconds are the largest numbers left in tile mode by a wide
margin — larger than anything C3 moved.

**What C3 leaves in place for them**: `regionCanvas(rect, level)` and `_levelBytes(tx, ty, level)` in
`inpaint_tiles.js` (the view's part of a store from the tiles' mips, two levels kept),
`tileWithGutter` for the atlas, and `drawTilesInto` / `drawSelectionInto` / `tileLevel` in the
editor. A band of tiles for the worker is `_keysIn` plus `readRect` per band; the answer comes back
through `writeRect`, which already shares whole tiles when a block covers one.

**Do not start with C4.** C2's final review already replaced the undo steps' PNGs with copy-on-write
clones, so a step shares its tiles and the measured cost is small (`undo step` 18 ms, the whole undo
budget 4.3 MB on the benchmark document). What C4 still owes is exact byte accounting and the
`frozen` counter a dropped step leaves one too high (a needless copy on the next write, never a wrong
pixel) — a short clean-up after C5, not before it.

#### C5 as built: the decisions taken while building it (2026-09-14)

**(a) The live stroke is composed in the region the pass draws** (`inpaint_canvas.js`, commit "C5 (a)"):

- **`liveStrokeView(layer, vp)`** is the layer as a region pass shows it while a stroke runs on it:
  a scratch of the **pass's own size** (1865 × 1198 on this screen, not 15000 × 10000), holding the
  layer's visible part at the pass's level with the stroke buffer over it at the brush opacity and
  the gesture's operation, and the mask multiplied in afterwards. `refreshStrokeView` redraws only
  the dab's rectangle, clipped to whole destination pixels so what a dab does not touch stays the
  bytes the frame before drew; `maskStrokeView` is the same scratch for a stroke on the mask itself.
  `drawLayer` takes it whenever a region pass draws the gesture's layer, and `layerWithStroke` /
  `maskWithStroke` stay for the full-resolution consumers (a run, an export, a flattened composite),
  which is phase E's path anyway.
- **What it replaces**: `layerWithStroke` makes a canvas as large as the layer and fills it from the
  layer's display canvas at the first dab — on a tile store that canvas is its display **mirror**,
  which had to be built first. Measured on a 15000 × 10000 document (base, one full paint layer, a
  `film.look` layer, so every frame is the Canvas 2D path): the first dab plus its frame **180.6 →
  0.9 ms**, the mirrors alive during the stroke **2 (1144 MB) → 0**, the display pyramids **187.8 →
  0 MB**. `perf_test.py`'s `brush dab + frame` worst frame **199.2 → 0.9 ms** and `stroke commit`
  **242.9 → 36.5 ms**. On the **canvas backend** (the packaged default) the same change takes the
  scratch during a stroke from 1733.8 to 1170.2 MB, 572 MB less, with every frame row inside noise.
- **The base is a plain layer too.** `drawLayersInto` still drew `basePx` through `displaySource`,
  so a tile document with a filter layer in it made a whole-image mirror (572 MB) and a Skia pyramid
  (188 MB) for the base alone, before any stroke. It takes `drawTilesInto` now, like every other
  plain layer since C3 (d). Counter-proof: with that one branch disabled the probe reports the
  mirror and the pyramid back, exactly those two numbers.
- **`clipCanvasFor`** (the stroke's clip to the selection, and the smudge's per-step clip) took the
  **whole** selection as a canvas, which on tiles is the selection's display mirror: 572 MB for a
  clip of a few hundred pixels. On tiles it materialises the box it needs from the selection's tiles
  instead, with a margin of `BLIT_MARGIN` so a fractional draw samples the neighbours as a draw from
  the whole thing does. On canvases the selection *is* its canvas, so the draw stays what it was (a
  crop would allocate once per smudge step).
- **What changed in what you see**: the preview composes the stroke at the **display's** resolution,
  where it used to compose at the layer's and let the display shrink the result. At a zoom below 1:1
  the soft edge of a live stroke is therefore drawn slightly differently from the pixels the commit
  finally writes; at 1:1 the two are the same to 2 levels, which is what the gate asserts. The
  CHANGELOG says so.
- **Gate**: `editor_test.py` step `live_stroke_preview_shows_what_the_commit_writes`, on both
  backends: six gestures (paint, paint clipped to a selection, erase, alpha lock, a masked layer, a
  stroke on the mask) at 1:1, each comparing the screen just before the commit with the screen just
  after it over a 540 × 240 px readback, plus a "reach" measurement first so the comparison cannot
  pass on a preview that drew nothing, plus "no display mirror and no pyramid entry" on tiles for
  the gestures whose layer has no mask (a masked layer still goes through its `_masked` canvas,
  which is C3's remaining `u_mask` work). Six mutations, each red: the brush opacity dropped from
  the preview (66 levels), the stroke 8 px off (124), an erase drawn as a paint (179), the dab's
  rectangle not redrawn (157), the mask drawn over instead of multiplied in (223), and the base's
  tile branch disabled (the mirror and the pyramid come back).

**(b) The stroke is clipped and applied band by band** (`inpaint_canvas.js`, commit "C5 (b)"):

- **What it costs before.** Measured on a 15000 x 10000 document, a stroke of 40 dabs right across
  the picture, clipped to a full-image selection: the dabs and their frames **870.6 ms**, the commit
  **1312.6 ms**, and alive at once the buffer (561 MB), `p.clipCanvas` (561 MB) and `clipScratch`
  (561 MB) — `clippedStroke` rebuilt a clipped copy of the **whole buffer** on every frame, and the
  commit was one `drawInto` of the whole box (on tiles a 561 MB scratch, read back in blocks).
- **`strokePatch(p, target, x, y, w, h)`** is the buffer's pixels for one rectangle of the target
  with the selection multiplied in, drawn into a scratch of that rectangle; **`strokeBands`** yields
  the rectangles, at most `STROKE_BAND` (1024) a side. `commitStroke` and `refreshStrokePreview` walk
  them. `clippedStroke`, `p.clipCanvas`, `p.clipOf` and `clipScratch` are gone; `clipCanvasFor` stays
  for the band's clip and for the smudge's per-step clip.
- **`StrokeBuffer.cells`**: the cells of a `STROKE_BAND` grid over the target that a dab has actually
  drawn into. The buffer's *rectangle* is the union of every dab, so a diagonal stroke's box is the
  whole picture while the dabs touched a few per cent of it: walking the box committed 150 bands of
  which 135 were empty (1071 ms), walking the cells commits the 15 that hold pixels.
- **The live preview's clip is taken at the display's resolution**: `drawStrokeInto` draws the buffer
  and then `drawSelectionInto` with `destination-in` into a scratch of the **destination** rectangle
  it is refreshing (at most the window), never a copy of the stroke at the layer's resolution.
- **Measured after**: the same stroke's dabs and frames **870.6 → 29.4 ms**, the commit **1312.6 →
  281.6 ms**, the two clip canvases **1122 MB → 0**. In `perf_test.py`'s own document (base, three
  full paint layers, a colour-matched result, a `film.look` layer), two new rows: `stroke across the
  picture (40 dabs)` **2635 → 720 ms** blocked and `its commit, band by band` **1097 → 447 ms**. What
  is left of the 720 ms is the buffer growing: `ensure()` reallocates and copies a canvas that ends
  at 561 MB, which is the sparse stroke store's to remove.
- **Gate**: `editor_test.py`'s `stroke_buffers_cover_the_gesture_not_the_layer` now builds its live
  preview reference **independently** (the layer, plus the whole buffer clipped to the whole
  selection, in canvases the size of the layer — the very thing C5 stopped making) instead of
  comparing the incremental preview against `clippedStroke`, and checks that every band is at most
  1024 a side and that no scratch the gesture leaves is bigger. Its tolerance went from 1 to 4
  premultiplied levels, for the reason the committed comparison already carried: the live path
  composes in band-sized canvases, which Chromium keeps in software, and the reference in
  layer-sized ones, which are on the GPU (measured 1.7). Three mutations, each red: a cell a dab drew
  into dropped (the erase step's stroke does not reach the screen), the band's clip not applied (79
  levels), the band drawn 6 px off (77).

**(c) The stroke buffer is a sparse store on tiles** (`inpaint_canvas.js`, commit "C5 (c)"):

- `StrokeBuffer` takes the editor's backend. On **tiles** it is a `LayerPixels` of the target's own
  size (`px`), sparse: a dab allocates the tiles it touches and nothing else, so a stroke from
  corner to corner never reallocates and never holds a canvas of its bounding box. On **canvases**
  it stays the growing canvas it has always been (`cx, cy, cw, ch`), because a store of the target's
  size there *is* the whole target. `x, y, w, h` is the box every dab together covered on both.
- **`draw(x0, y0, x1, y1, fn)`** replaces `ensure()`: `fn(ctx)` draws in the target's own
  coordinates, clipped to the padded box, and is a `drawInto` of the sparse store on tiles. Both
  paths now clip to that box, which they did not before. `layerDab`, `cloneDab`, `gradientDab`,
  `shapeDab` and `finishShape` take it; `paintShape` **composes** its transform instead of setting
  one (C1 rule 12), so the buffer's origin is no longer part of it; `p.gradient` is cached per
  context as well as per radius, because on tiles every dab draws on a scratch of its own.
- **Two sites the change forced into the open.** `shapeDab` redraws its shape from nothing on every
  move and cleared the whole buffer for it; with a box it has to draw in the box it had *before* as
  well, or the shape it passed through stays on the screen (the commit never wrote it — only the
  preview showed it). And the **gradient** rebuilds its whole buffer on every move, so it keeps the
  canvas buffer on both backends: a sparse store would allocate every tile of the target and read a
  scratch of the whole layer back per move.
- **`PAD`** is 32 on the canvas buffer (headroom, so a growing stroke does not reallocate every dab)
  and **2** on the sparse store, where 32 px on every side of every dab is a third more scratch to
  fill and read back for nothing: the callers pad their own box by what the brush reaches.
- **Measured** (15000 x 10000, tiles, the 40-dab stroke across the picture clipped to a selection):
  the buffer holds **560.7 MB → 26.5 MB** (106 tiles, 26 band cells), the commit 281.6 → 277.4 ms,
  and the dabs with their frames 29.4 → **47.7 ms** — 0.4 ms a dab more, which is the scratch a
  `drawInto` fills and reads back. On `perf_test.py`'s own document (a heavier stack, so the frame
  dominates) the two rows read 720 → 620 ms and 447 → 486 ms, inside that document's noise. The
  headline of this step is the memory, not the time.
- **Gates**: `editor_test.py` gains `a_stroke_across_the_picture_keeps_only_the_tiles_it_touched`
  (a diagonal stroke on 4000 x 3000: the store is the target's size, holds under a quarter of its
  box's bytes, and writes the same picture as a buffer of the whole box, ≤ 8 premultiplied levels,
  with a "the stroke really painted" floor first) and
  `gradient_tool_keeps_the_canvas_buffer_and_fills_the_layer` (driven through the real pointer
  handlers; the gradient tool had no gate at all before). `shape_test.py` gains
  `a_shape_dragged_smaller_leaves_nothing_behind`, and the preview step gains a shape case, which is
  where the stale shape actually shows. Six mutations, each red: `paintShape` setting an absolute
  transform, the extent 40 px short, a shrinking shape drawn only in its new box (93 levels on the
  preview), the gradient taking a sparse store, the store made half the target's width (153 levels
  on the committed stroke), and the earlier three of step (b).

**(d) The mask is a sampler, not a canvas** (`inpaint_compositor.js`, `inpaint_canvas.js`, commit "C5 (d)"):

- **What it costs before.** A layer with a transparency mask went through `layer._masked`: a canvas
  as large as the layer, cleared and rebuilt from the layer's display canvas with `destination-in`
  on every change of the pixels or the mask. Measured on a 15000 x 10000 document with one masked
  layer, tiles on: `_masked` **572.2 MB**, two display mirrors (the layer's and the mask's)
  **1144.4 MB**, a Skia pyramid on `_masked` **143.1 MB**, and a mask edit inside a box — what a
  mask brush stroke does — **253.3 ms**, because the whole canvas was rebuilt for it.
- **`u_mask`**: the atlas shader takes a second sampler and `u_hasMask`, and multiplies the source's
  premultiplied value by the mask's alpha, which is what `destination-in` with the mask does on
  Canvas 2D. The instance carries `a_muv`, the same tile's slot in the **mask's** own atlas pages, so
  an instance is now `{ rect(4), uv(4), muv(4) }` and the groups are keyed by the *pair* of pages a
  draw binds. A tile the mask does not have is transparent, and a transparent mask hides what is
  under it, so that tile of the layer is not drawn at all. `_upload` came out of the tile loop,
  because the mask's tiles are uploaded the same way.
- **`tileMaskOf(layer)`** is the mask a tile path may take: on the same backend and with the same
  tile grid. A mask of another size is scaled onto the layer, which only `_masked` can do, and a
  colour match or a live stroke still prepares a canvas.
- **The Canvas 2D path** (a filter layer in the stack) takes the region scratch of step (a):
  `liveStrokeView` became **`layerRegionView`**, which runs for a live stroke *or* a tile-backed
  mask, keyed by the gesture when there is one and by the layer when there is not.
- **Measured after**, the same document: `_masked` **572.2 → 0 MB**, the mirrors **1144.4 → 0**, the
  pyramid **143.1 → 0**, a mask edit inside a box **253.3 → 1.2 ms**, a pan 0.4 → 0.2 ms. **1.86 GB
  and 200x on the edit a mask brush makes.**
- **The one row that got worse, and why**: a change that touches the **whole** mask ("mask from
  selection", invert, a filter on the mask) went **17.6 → 157 ms**. `touch()` without a rectangle
  bumps every tile's version, so every visible mask tile has its mip chain rebuilt on the main
  thread — about 2,400 of them at fit on a 15k document, 50 µs each. That is the same cost a
  whole-layer change has carried since C2, and it is **C6's** ("a whole-layer change marks all its
  tiles' mips stale; `inpaint_worker.js` gets a `mips` job"). A mask brush stroke passes its box and
  is the 1.2 ms row.
- **Gates**: `composite_test.py`'s document already carries a masked layer with a gradient mask, and
  its gpu-vs-2d step at 1:1 is what holds the shader to Canvas 2D (max 1 level).
  `editor_test.py`'s backend step now reads the **screen** where the masked layer's mask has no tile
  at all and where it lets the layer through, and asserts that a masked tile layer has no `_masked`
  canvas, no mirror of its pixels, no mirror of its mask and no pyramid entry — on the GPU path and
  again with a filter layer in the stack, on Canvas 2D. The preview step's masked cases lost their
  exception for `_masked`. Four mutations, each red: the shader ignoring the mask (189 levels), the
  mask uv half as wide (90), no tile mask offered (`_masked` and the mirror come back), and a tile
  the mask does not have drawn unmasked (the hidden half of the layer appears on screen).
- **Not built, and why**: the plan's **three op modes** for drawing the stroke store through the
  compositor. Measured after steps (a) to (c) on a 15000 x 10000 document whose stack the compositor
  can take: with the compositor standing down for the gesture, the first frame of a stroke is
  21.9 ms and every frame after it 0.1 ms median, 0.2 worst. The op modes would save that one frame
  and the 18.4 MB of region canvases it builds; they are not what is left to pay for on this
  document, and the selection's seconds are. The note stays here so the next session does not have
  to measure it again.

**(e) Grow, shrink, feather and invert work on the box, not on the picture** (commit "C5 (e)"):

- **`selectionInWorker(kind, args, { halo, whole })`** sends the selection's own bounding box plus
  the operation's halo -- `|n| + 2` for grow and shrink, `3r + 2` for feather -- and writes the
  answer back inside it. Outside that box nothing can change: the mask is empty there and these
  operations only move an edge. It used to send the **whole** mask, which at 15000 x 10000 is a
  600 MB canvas materialised from the tiles, copied into an ImageBitmap, transferred, and written
  back over a scratch of the same size. The worker's bounds come back in the box's own pixels and
  are moved into the image; `markSelectionChanged` gets the box, so the display levels are
  refreshed there instead of everywhere.
- **Invert** has no box to work in -- its result covers everything the selection does not -- so on
  tiles the mask inverts **its own tiles** (`TileMaskPixels.invert()`), word by word, a tile that
  had nothing filled in one `fill` call. A pixel the invert leaves fully transparent is written as
  all zero, because a canvas stores premultiplied and un-premultiplies such a pixel to 0, 0, 0, and
  the two backends have to agree byte for byte. `MaskPixels.invert()` is the canvas backend's twin.
- **`applyShapeToSelection`** with `mode: "replace"` clears the mask (on tiles that **drops** the
  tiles) and then draws the shape in its own box, instead of a `clearRect` of the whole image inside
  a `drawInto(null)`, which on tiles is a scratch of the whole image.
- **Measured** (15000 x 10000, tiles on, blocked [wall] ms, `perf_test.py`): grow **1288 [4237] →
  273 [2305]**, shrink **1207 [3298] → 271 [1514]**, feather **1386 [2366] → 229 [592]**, invert
  **1535 [2742] → 1047 [1047]** (it no longer waits for a worker round trip either). On the
  **canvas backend**: grow 140 [2322] → 75 [1252], shrink 208 [1751] → 90 [1337], feather
  272 [1492] → 260 [465], invert unchanged within noise. The benchmark's selection is 16 % of the
  picture; a smaller one gains more, which is the point of the box.
- **What is left, and what it is**: the magic wand (2,381 ms blocked on a band across the whole
  picture, 760 on a bounded object) and the bucket (696) are untouched. They flood pixels, not mask
  tiles, and their cost is in `floodShape` / `sampleRegion`, which already crop to a box; that is
  the next measurement, not a re-run of this one.
- **Gates**: `pixels_test.js` case `mask_invert` (the rule itself -- 255 - alpha in the selection's
  red -- on a 601 x 501 mask whose last tile column and row are partly outside the image, inverted
  twice to get the alpha back, and the canvas run compared with the tile run byte for byte);
  `editor_test.py` step `grow_feather_and_invert_are_the_answers_a_whole_image_run_gives`, which
  runs `growMask` over the whole mask itself as the reference for grow and shrink, checks that a
  feather leaves nothing beyond `3r + 2` and keeps a soft edge, and that an invert is 255 - the
  alpha everywhere with the bounds of the whole picture. Four mutations, each red: grow without its
  halo (255 levels on 32,732 pixels), feather with a halo of 1 (the undo step's extent no longer
  covers the feathered tail), the worker's bounds not moved into the image, and three rows of a
  newly allocated tile left out of the invert.

#### Where C5 leaves the magic wand and the bucket, measured (2026-09-14)

The wand and the bucket were **not** changed, and this is why, so the next session starts from a
measurement instead of the plan's sentence. A magic wand on a 15000 x 10000 picture whose region is
a band across the whole of it (62 million pixels selected, `wandSelect` 4,378 ms wall):

| part | ms |
|---|---|
| `sampleCanvas`: the full-resolution composite the flood reads | 153 |
| `floodShape`: the flood itself, in the worker, over 150 M pixels | 3,118 |
| `applyShapeToSelection`: writing a 15000 x 10000 answer into the mask | 1,661 |

So the flood is three quarters of it and runs **in the worker** (which is why the row blocks the
main thread for 2.4 s of 6 s wall), and phase A's coarse-then-fine box already keeps a *bounded*
region off this path: the object wand is 760 ms. What is left for a whole-picture region is a flood
over the whole picture, which is a kernel and a band question (phase E), not a mask-tile one.

**A trap worth keeping**: the 1,661 ms write was tried band by band, the way C5 (b) bands a stroke,
and got **30 times worse** (1,661 → 49,525 ms). A stroke's bands each draw from a small buffer; the
wand's answer is one canvas of 15000 x 10000, and 150 sub-rectangle draws from a canvas that size
cost far more than one whole draw of it. Reverted. If that write is to be cut, the answer has to
arrive as pixels the mask can take by `writeRect` (the worker already has the flood's mask as a
typed array before it makes a canvas of it), not as a canvas to be re-read in pieces.

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

#### C6 as built: the decisions taken while building it (2026-09-14)

**(a) The atlas is keyed right** (`inpaint_tiles.js`, `inpaint_compositor.js`, `inpaint_canvas.js`):

C6 changes how tile versions and mips reach the screen, so the three ways the atlas could draw pixels the
document no longer holds were fixed first. Each was reproduced on the screen of a tile-mode instance (GPU
path) before it was touched. All three are tile mode only: the canvas backend never reaches the atlas, and
its region view runs only for a live stroke, which is keyed by the gesture. So no CHANGELOG bullet.

- **A new pixels object had the version of the one it replaced.** A tile store's `version` started at 0 and
  was 1 after its first `touch()`. The atlas's instance cache is keyed on `px.version` and `mask.version`
  but not on which mask, and `layerRegionView`'s signature (the Canvas 2D path of a masked tile layer) on the
  same two numbers. Reproduced on a 2400 x 1600 layer: "mask from selection" on the left half and then on the
  right half gave two masks at version 1, and the screen kept the left half, on the GPU path (the key hit and
  bound the first mask's pages, which were still alive: see the next item) and on the Canvas 2D path with a
  filter layer in the stack. The undo that puts the first mask back (a clone, 0 then 1, against a live mask at
  1) did the same. **Fix**: a tile store's version comes from one module-wide sequence (`pixelSeq`), at
  construction and on every `touch()` and `invert()`, as a tile's version always did. Two pixels objects can
  never share a version, so every cache keyed on it (the instance key, the region view's signature, the
  mirror's `_dispVer`) tells them apart without keying on the object as well. One number rather than an
  (id, version) pair, because the hole was in two places and a third signature would have to remember the
  pair. The canvas backend keeps its per-canvas `_dispVer`: the caches that read it key on the canvas too.
  The `LayerPixels` contract in `inpaint_pixels.js` says so.
- **Replaced pixels were never forgotten.** A flip, a turn, a new mask, a restore or a text render replaces
  the pixels object, and its undo step holds a *clone*. The replaced object was in neither the document nor a
  step, so `releaseDetachedDisplays` never passed it to `forgetPixels`, and the atlas, a `Map` keyed on the
  pixels, kept it and every tile it had. Measured on 15000 x 10000, one full paint layer at fit, flipped three
  times: atlas records 2 → 5, pages 20 → 50, 20.9 → 52.2 MB (10.4 MB of pages per flipped-away object). After
  a forced collection all three objects were alive, with 1,770 MB of tiles shared with the steps' clones.
  After `clearUndo()` and another collection they were still alive, holding **2,432.9 MB** of tiles, mips and
  edge copies nothing else held. 297 composites later their pages aged out and they went. **Fix, in two
  places**:
  1. The compositor holds its pixels **weakly**: one record per pixels object, holding a `WeakRef` to it and
     found through a `WeakMap`. A record whose pixels were collected is dropped at the next composite. Nothing
     in the atlas can keep tiles alive any more, whichever site forgets to say it replaced something.
  2. **`retainPixels(live)`**: `releaseDetachedDisplays` drops every record whose pixels the document does
     not hold (base, selection, layers, masks). Before, it dropped only pixels a step holds. The release is
     now also queued by every whole change of a layer or a mask (`markLayerChanged` / `markMaskChanged`
     without a rectangle, which is what every replacement ends with), and by `setBase` and the `basePx` getter
     when they replace the base. A restore goes through `setBase`, whose release runs at the restore's next
     await, when the old layers are already gone. Undo steps and undo / redo already queued it.

  After the fix the same three flips leave 2 records, 20 pages and 20.9 MB, and nothing of the flipped-away
  objects survives a collection, even while the undo steps are still there. Pixels the document still draws
  keep their pages: the frame after the release uploads nothing.
- **The gutter was not part of a slot's validity.** A slot holds its tile plus a one-pixel gutter of its eight
  neighbours' edge lines (C3 a), but it counted as current by its own tile's version only. `touch(rect)`
  bumps only the tiles the rectangle overlaps. Reproduced on a 1024 x 1024 red layer, the view off the pixel
  grid, comparing the screen after a write with the same view drawn from released caches:
  - A blue fill of [256, 0, 512, 1024] announced with exactly that box: **76 levels on 2,307 bytes** at 0.75
    (level 0) and **104 on 1,230** at 0.2 (level 2).
  - The undo of a fill selection over the same column, a `layer` step restored over whole tiles
    (`tileDiffBox`): the same 76 and 104, measured with the old rule put back into the fixed tree (the
    mutation below).

  At 0.35 and 0.1 the same writes read 0: whether a fragment centre falls within half a texel of the slot's
  edge depends on the view's phase.

  A **brush dab** did not reproduce at levels 0 to 3. Its commit rectangle is the dab padded by
  `brushSize / 2 + 2`, so a dab whose pixels reach a tile's last column also bumps the tile past it. At level
  L the gutter reads the neighbour's last 2^L columns, so a dab whose pixels stop 2 to 2^L − 1 px short of a
  border has the defect at level 2 and up. That follows from the code and was not measured.

  **Fix**:
  - The slot records the versions of the eight tiles its gutter was made from: `gutterVersions(tx, ty)` on
    the tile store, 0 for a neighbour that is missing or outside the image. `_upload` compares them as well as
    the tile's own version.
  - When only a neighbour changed, only the gutter is made (`tileWithGutter(..., ring = true)`) and uploaded:
    four `texSubImage2D` calls of one line each, counted in `stats().atlas.gutterUploads`, not in `uploads`.

  Widening `touch(rect)` by 2^level px was the other way, and it costs more: it rebuilds the neighbours' mip
  chains and re-uploads whole slots. Measured on 15000 x 10000, the first frame after a 700 px square write
  (median of 12, two alternating runs):

  | | at 1:1 | at fit |
  |---|---|---|
  | old rule | 4.0 to 5.5 ms, 12 uploads | 2.4 to 2.8 ms |
  | neighbour versions, whole slots re-uploaded | 9.4 to 9.8 ms, 24 uploads | 3.2 to 3.3 ms, 30 uploads |
  | neighbour versions, the gutter alone | 4.4 to 6.4 ms, 12 uploads plus the ring | 3.0 to 3.4 ms |

  A whole touch at fit is 250 to 285 ms in every variant; the 2,360 lookups cost 0.25 ms of it.
- **A trap on the way**: the first reading of the undo case undid the selection step that `select_none` had
  pushed, not the fill. Marching ants move between two reads, so the "stale" and the "fresh" screen differed
  by 218 levels whatever the atlas did, before and after the fix alike. A screen comparison clears the
  selection *after* the undo, and the gate checks that the undo stack is empty and the selection still there.
- **Gates**:
  - `editor_test.py` gains `a_new_mask_and_a_neighbours_write_reach_the_screen`, run on both backends:
    - A second mask from selection, read from the frame the operation drew itself (nothing draws again until
      the pointer moves) and after frames of its own, then from released caches, then the undo and the
      removal, on the GPU path and again with a filter layer in the stack.
    - The border writes at 0.75 and 0.2 against released caches, ≤ 2 levels, with a "the write reached the
      screen" floor. Each write is read with the view moved by 0 to 3 image pixels at 0.75 and 0 to 4 at 0.2,
      which starts the composite's region on every pixel of one sampling period. The rows must have run on
      the GPU compositor, and on tiles each write must have uploaded a neighbour's gutter.
  - The screen step gains (5), on tiles:
    - After three flips, every atlas record is of pixels the document draws, the flipped-away objects have no
      pages, and the live layer keeps its pages and uploads nothing on the next frames.
    - A layer replaced and announced by a whole change, and then a mask the same way, give their old pages
      back, one at a time, because either change's release takes both.
    - The base replaced by `setBase` with a new image (layers kept), and then by a new `base.img` that the
      `basePx` getter finds on the next frame, gives its old pages back each time.
    - A layer replaced without telling anybody, and the flipped-away objects no step holds, are collected
      after a forced collection before the pages could age out. The step's 320 aging frames moved to
      `SCREEN_STEP_TAIL`, after that check.
  - `pixels_test.js` gains `tiles_gutter_versions_and_ring`: `gutterVersions` against an independent reading
    of the neighbours, changed by a write into a side or a diagonal neighbour, by a neighbour allocated and
    by one dropped, not by a tile two away; and the ring written byte for byte as the full slot has it, the
    interior untouched, at every level.
- **Mutations, each red**:

  | mutation | red |
  |---|---|
  | versions counted per object again | the second mask's own frame on the GPU path, and on the Canvas 2D path its frame, the frames after it and the undo |
  | the release forgets only what a step holds | the atlas keeps 2 records of pixels it does not draw, 13 MB each |
  | the atlas holds its pixels strongly | the unannounced replacement is still alive after a collection |
  | `markLayerChanged` without a rectangle queues no release | the replaced layer keeps its 13 MB of pages |
  | `markMaskChanged` without a rectangle queues no release | the replaced mask keeps its 26.6 MB of pages |
  | `setBase` queues no release | the replaced base keeps its 26.6 MB of pages |
  | the `basePx` getter queues no release | the old base pixels keep their 26.6 MB of pages |
  | the ring upload throws (the editor falls back to Canvas 2D) | the border rows: "ran on Canvas 2D", "uploaded no gutter", "the GPU compositor failed during the step" |
  | a slot current by its own version | 76 levels on 2,307 bytes and 104 on 1,230, both writes |
  | the gutter-only upload without its side columns | the same 76 and 104 |
  | the ring path writing the interior | the unit case: "the interior was written" |
  | `gutterVersions` without the diagonals | the unit case: the versions against the neighbours |

  Before the second version of the mask and screen checks, two of these stayed green:
  - Versions per object on the GPU path: the release queued by the whole mask change drops the old mask's
    record, which moves `atlasGen`, so every frame *after* the operation was right. The operation's own
    frame was the wrong one, and that is the frame the user keeps seeing.
  - The two release queues, while both replacements were checked together.
- **The review's fixes** (three findings on the gates, each confirmed by two verifiers):
  - The border rows recorded the path and the gutter uploads but never checked them, so with the ring upload
    made to throw the editor fell back to Canvas 2D for good and the step passed comparing Canvas 2D with
    itself (0 levels, 0 gutter uploads); they now fail on Canvas 2D, on a write that uploaded no gutter (8
    and 12 in clean runs) and on `compositorOff` at the end, and that mutation is red.
  - Whether one view position sees a stale gutter depends on where the region starts, which follows the
    window's width, not on the view's +0.37 px: with the old slot rule the 0.75 rows missed it at 3 of 6
    consecutive widths (canvas 961, 962 and 1436 px), and only the 0.2 rows kept the step red; with the view
    moved over one sampling period the 0.75 rows are red at all six (2 to 3 of the 4 shifts, 11 to 98 levels).
  - The `setBase` and `basePx` getter queues had no counter-proof (the whole editor gate stayed green with
    them suppressed); the screen step's base rows are red without either one (26.6 MB kept). The call at the
    end of `setValue` was removed rather than proven: in a restore on tiles either it or `setBase`'s release
    alone gave the old base's and layer's 13 MB each back, and only with both suppressed did they stay, so
    nothing could show it.
- **Runs** (fresh instances, strict): `--tiles on` and `--tiles off` with `pixels editor composite commands
  shape brush film glb ailabel size transparent generate log mcp nodecopy` ALL PASS, and `--copy --tiles off
  pixels editor composite commands` ALL PASS, on the first try each after the review's fixes as well. Before
  them two runs failed for reasons outside this change:
  - `commands_test.py` hung twice, once per backend, in `Page.captureScreenshot` after its last step (every
    step `[ok]`, the posterize shot written, the window shot not), and ran into the runner's 420 s timeout.
    It passed alone, in a bisect run of `pixels editor composite commands` against the same code, and in
    both full re-runs. This is the flake `CLAUDE.md` already names.
  - `composite_test.py` failed once on tiles with a `KeyError`: its view shot was 1200 x 794 against the
    reference's 1200 x 800, because the editor canvas was 6 px shorter in that window. The size check
    returns no `bytes` key, which the failure message then asks for. It passed on the re-run.


**(b) Mips off the main thread** (`inpaint_tiles.js`, `inpaint_compositor.js`, `inpaint_worker.js`, `px/kernels_js.js`,
`inpaint_canvas.js`):

- **What it cost before**, measured on 15000 x 10000 (a painted base and one full paint layer, tiles on, the window
  in front, a 1865 x 1198 view; fit is level 3, all 2,360 tiles visible). Blocked ms of the frame after the change
  (`markLayerChanged` / `markMaskChanged` / `markSelectionChanged`, the layer list and the draw; the operation's own
  band copies are not in it), two runs each:

  | change | fit, GPU | fit, Canvas 2D | 1:1, GPU | 1:1, Canvas 2D |
  |---|---|---|---|---|
  | a filter in place (every tile written) | 571-608 | 534-577 | 244-286 | 234 |
  | a flip (new pixels) | 613-645 | 603-609 | 247-250 | 255-302 |
  | mask from selection (a new mask) | 578-785 | 536-705 | 250-253 | 251-302 |
  | invert of a selection | 288-414 | 277-408 | 36-47 | 36-38 |
  | a whole touch after a 100 px write | 274-283 | 4-5 | 14-15 | 5-6 |

  Where it went, for the flip at fit on the GPU path: the layer list's thumbnail **250 ms** (2,360 mip chains built
  into a scratch it threw away, and 2,360 `putImageData` of 8 x 8 px that together cost 2.5 ms), the frame's atlas
  **311 ms of chains** (`mips()`, 2,262 interior tiles) plus 28 ms for the 98 edge tiles' clamp copies and chains,
  26 ms of `tileWithGutter`'s premultiply, 6 ms of 2,360 `texSubImage2D`, 3 to 5 ms of instances and slot lookups;
  the release step (a) added 0.1 ms. So every chain was built **twice** at fit (4,622 chains: the thumbnail's and the
  atlas's) and once at 1:1, where the thumbnail alone was the 230 to 280 ms. On the Canvas 2D path the region
  canvas's rebuild (one `putImageData`) was 4 to 12 ms and its per-tile dirty path 2,360 puts of 32 x 32 in 4 to 6
  ms: the "180 ms" the code's comment quotes did not reproduce. The whole touch was 2,262 chains and 2,360 uploads for
  tiles whose pixels had not changed. Invert's 32 to 52 ms in `markSelectionChanged` is its `renderInfo` (the new
  selection's bounds and the crop), not mips, and so is the rest of its 1:1 row.
- **Built, in the order the plan asked for:**
  1. **`touch()` gives no tile a new version.** Every write into a tile goes through `writable` (a new version, or a
     copy that is a new tile object), `_share` or `_dropTile` (another tile object or none); `grep` finds no other
     writer of `t.data`, the kernels included. So a touch only moves the pixels' own version, and a whole touch after
     a write of one tile keeps every other tile's extent, mips, edge copy and atlas slot. It also no longer makes a
     tile an undo step shares stale for the step. `pixels_test.js` `tiles_touch_keeps_tile_caches` holds it: the
     other tiles keep their object, version, chain buffer and slot stamps, and the clone's tiles are untouched by a
     touch through either holder. The canvas backend's `touch` is unchanged.
  2. **No chain is built twice where the screen needs it.** The thumbnail takes the chain a tile keeps, and rebuilds
     one a tile owns in that tile's buffer. A tile that has no chain of its own gets none from the thumbnail (the
     review, below): its levels go into a scratch, and a chain from the worker that only a thumbnail asked for is
     handed to the thumbnail's cell and dropped. `thumbnailCanvas` and `regionCanvas` rebuild with one `putImageData`
     when a quarter or more of their cells are dirty (a new region canvas always did; a new thumbnail does now too),
     and copy small cells word by word.
  3. **The mips job and the scheduler.** `inpaint_worker.js` has a `mips` job: a batch of tile bytes (copies,
     transferred) in, each tile's chain back, and for an edge tile also the chain of its clamp-extended bytes
     (`clampExtend` moved into `kernels_js.js`, so both threads run the same code); the chains and the tile buffers
     go back transferred (the reply line transfers what a job names in `transfer`). `ChainScheduler` in
     `inpaint_tiles.js` owns the asks: a **display** reader (`regionCanvas(..., true)`, `thumbnailCanvas(true)`,
     `tileWithGutter(..., display)`, `slotStamps`) that finds no exact chain may still build `CHAIN_SYNC_BUDGET`
     (16) of them in the current task; beyond that it asks the scheduler, which copies the bytes in a microtask and
     posts batches of up to 128 tiles (the first 32, while the pool of buffers the worker gives back fills), one at
     a time. An answer is installed only on the tile object it was made from and at the version it was made from; a
     later write discards it (`dropped`). Readers that are not display readers (`mips()`, the wand's and the film
     panel's `sampleRegion`, `tileWithGutter` without the flag) stay exact and build on the spot, as before, and a
     cell a display reader left stale is put again exactly when such a reader asks for it.
  4. **What the screen shows meanwhile.** A tile that kept a chain (a write in place, or a copy on write, which
     takes the original's buffers read-only and never writes into them) shows that previous chain; a tile that has
     none (new pixels: a flip, a turn, a new mask, a restore, a load) shows its bytes **sampled nearest**. On the GPU
     path such a tile is drawn from a slot at the **coarse level** (level 5, 10 px a side, its own edge as its
     gutter: `coarseSlot`, `_uploadCoarse`). Measured in one build on the flip at fit: nearest sampling into the
     level's own slots (34 px, the gutter read from the neighbours) made the draw 71 to 82 ms, the coarse slots 36
     to 37; after the later tightening the coarse slots' draw is 9 to 10 ms. The plan's other option, a synchronous
     chain for the visible tiles only, is the 311 ms above at fit, where every tile is visible. A slot at the tile's
     level that already holds a picture keeps it until the chain lands. Stamps replace the slot's version: a tile's version where the bytes are exact, -1 - the chain's
     sequence for a stale chain, -0.5 - the version for a coarse picture, for the tile and its eight neighbours
     (`slotStamps`), so a landing re-uploads exactly the slots that showed something else. The region canvases and
     the thumbnail keep a `stale` set; a landing (`_chainLanded`) moves those cells to `dirty` and, when a reader of
     the screen asked for the chain, moves the pixels' `chainEpoch`, which the atlas's instance key and
     `layerRegionView`'s signature read (the selection's too, since the review).
  5. **The editor.** A module-level transport sends the batches to a **mips worker of its own** (the same module):
     measured with a whole-picture magic wand running when a flip at fit asks for its chains, the screen was exact
     2.4 to 2.6 s after the flip with its own worker and 3.1 to 3.5 s on the shared one, which runs the flood first
     (the rest of that wait is the wand's own main-thread work, blocked for 1.2 s and 0.5 s, during which no landing
     can be installed). `watchChains()` waits for landings while chains are pending; for the document's pixels that
     got some it redraws their thumbnails where they are shown (`redrawThumbsOf`: the layer list, the reference list,
     the result list), and when a reader of the screen had asked for them (`landing().screen`) it drops the view's
     filter and colour-match caches (they were made from the stale picture) and draws again, the navigator too.
     `drawThumb` watches the chains it asks for itself. `ed.mipsSettled()` resolves when nothing is on its way.
     Without a worker (or after it fails) the transport is gone and every chain is built where it is read, as before.
- **Measured after**, the same document and view (blocked ms of the frame after the change; "settled" is the wall
  time from the end of the operation's task until no chain is on its way):

  | change | view | GPU before | GPU after | settled [worst landing frame] | Canvas 2D before | Canvas 2D after | settled [worst landing frame] |
  |---|---|---|---|---|---|---|---|
  | a filter in place | fit | 571-608 | **12-25** | 554-1233 [14-34] | 534-577 | **18-20** | 428-431 [3-30] |
  | a filter in place | 1:1 | 244-286 | **24** | 403-422 [1-2] | 234 | **21-22** | 412-419 [2-3] |
  | a flip | fit | 613-645 | **18** | 385-403 [6-11] | 603-609 | **24-25** | 406-469 [3-4] |
  | a flip | 1:1 | 247-250 | **25-26** | 415-432 [1] | 255-302 | **25** | 447-473 [3-4] |
  | mask from selection | fit | 578-785 | **21-24** | 665-775 [15-19] | 536-705 | **24-25** | 736-879 [5-6] |
  | mask from selection | 1:1 | 250-253 | **25-26** | 402-426 [1] | 251-302 | **24** | 396-408 [2-3] |
  | invert of a selection | fit | 288-414 | **50-53** | 336-352 [2] | 277-408 | **50-101** | 360-493 [4-5] |
  | invert of a selection | 1:1 | 36-47 | **39-54** | 45-58 | 36-38 | **39-40** | 44-45 |
  | a whole touch after a small write | fit | 274-283 | **4** | 44-45 | 4-5 | **4** | 43-45 |
  | a whole touch after a small write | 1:1 | 14-15 | **3-4** | 47-48 | 5-6 | **5-6** | 43-46 |

  (About 45 ms of "settled" is the probe's own floor: a GL finish, a 40 ms wait and a frame. The in-place filter's
  1,233 ms and its 34 ms landing frame are one run of two, with the 600 MB the operation's band copies left to
  collect; its other run settled in 554 ms.)

  A whole change of a layer or a mask at 15k: **12 to 26 ms instead of 530 to 790**, and the screen exact about
  0.4 s later (0.7 to 0.9 s for a new mask, whose landings walk the layer's tiles with the mask's). At 1:1 the 230
  to 300 ms of the thumbnail are gone; the 15 to 17 ms left in the draw there are the 40 level-0 slots' premultiply
  and upload, which C3's "first frame fit -> 1:1" row already had. The whole touch is 3 to 6 ms on both paths.
- **What the goal of one frame did not get, and why**: at fit on the GPU path a flip is 18 ms and the in-place filter
  12 to 25; the other whole changes are 21 to 26 ms, one frame and a half. What is left in them: the layer list's
  thumbnail, 6 to 8 ms for 2,360 cells and their asks of the scheduler; the draw's 2,360 coarse slots and their
  uploads, 9 to 10 ms at fit; at 1:1 the level-0 uploads above. **Invert** stays at 50 ms and more: 33 to 70 ms of
  it is `markSelectionChanged`'s `renderInfo`, which reads the new selection's bounds (`getBounds`, over tiles whose
  extents are all new) and the crop worked out from them: not a mip cost, and 32 to 52 ms before as well. The landing frames of a new mask on
  the GPU path reach 15 to 19 ms. Each is named for the next session rather than built here.
- **Not built, and why**: a version per mip level: a stale chain is one picture of the tile, and the stamps
  say which one a slot holds, which is all the display needs. An upload budget per frame for exact slots (the
  landing frames of a new mask reach 14 to 19 ms at fit because the layer's own tiles are walked again with the
  mask's). The **smudge tool** is untouched: it reads the layer's display mirror (572 MB) and makes a pyramid of it
  per move, 420 to 750 ms a move at 15k before and after; this step's touch change does not reach it (its cost is
  the mirror and the pyramid, not tile versions).
- **Gates**:
  - `pixels_test.js` gains three cases. `tiles_touch_keeps_tile_caches` (above). `tiles_mips_job_matches_the_kernel`:
    a real worker gets the tiles of a 601 x 501 store (an interior tile, and edge tiles 89 and 245 px short) and its
    chains and edge chains are the main thread's byte for byte, the buffers transferred both ways.
    `tiles_display_chains_through_a_scheduler`, with a scheduler whose worker answers when the case says so: a new
    store's display slot is coarse (its pixel the nearest sample, premultiplied) and builds no chain without budget;
    the region canvas marks every cell stale; the answer installs every chain, moves `chainEpoch`, makes the stale
    cells dirty, and the display slots and the region canvas are then those of an exact twin; a write in place shows
    the tile's previous chain; a second write while the answer is away drops the answer (the chain is not installed,
    `dropped` counts it) and the next answer is exact; a copy on write shows the original's chain and edge chain and
    building its own writes into neither; the thumbnail builds no chain the tiles have and keeps the ones it builds;
    a budget of two builds two chains in a task and has its budget back in the next. The review added to it: (5b) the
    original's last holder rebuilding in place writes into neither buffer a copy reads; (6) the thumbnail keeps no chain
    on a tile that had none and rebuilds an owned one in its buffer; (6b) a chain only a thumbnail asked for is handed
    to its cell, kept nowhere, leaves `chainEpoch` alone, and a whole rebuild of the thumbnail does not ask again;
    (8) the queue goes newest first and a cell still shown stale keeps its tile ahead; (9) a write outside a region
    canvas's tiles marks none of its cells; (10) `regionCanvas` at levels 3 to 5 (the word copies) against cells put
    together by hand, exact, as coarse blocks of nearest samples, and after a landing.
  - `editor_test.py` gains `a_whole_change_builds_its_mips_in_the_worker_and_the_screen_ends_exact` (both backends,
    the GPU path and with a filter layer in the stack): a flip of a 4000 x 3000 layer at fit builds at most
    `CHAIN_SYNC_BUDGET` chains in its task and asks for the rest (16 and 177); after `mipsSettled()` the screen is
    the view drawn from caches released with the region canvases and thumbnails (`releaseCaches({ mirrors: true })`;
    without them the Canvas 2D path's reference was drawn from the same region canvases as the screen, and a cell left
    coarse matched itself: the review) and every chain a tile keeps as exact is the kernel's; a flip with a batch
    really in flight followed by an in-place fill with thin stripes drops the late answers and the settled screen shows
    the fill; `releaseCaches` empties the scheduler's pool. Tolerance 3 levels on the GPU path: the settled screen took
    its level-1 slots in the order the chains landed, the released view in reading order, and the page is sampled up
    to 3 levels apart at the stripes' edges in another place of the page (the slots read back exact in both; 0 with the
    coarse slots off and on the code before this step).
  - The review added three steps. `mips_landings_redraw_every_thumbnail_and_the_screen_only_where_it_asked`: a flip,
    a reference layer added, the result list drawn and a rename opened while the chains are away; once they land the
    layer's row, the reference's row and the result item were each last drawn from the thumbnail as it is (the exact
    one), no list was rebuilt and the rename is open; at 1:1 a hidden layer's flip keeps no chain on its tiles and its
    landing leaves the view's caches. (Compared by the thumbnail a canvas was drawn from, not as pixels: the same
    thumbnail drawn into two 40 x 28 canvases came out 29 levels apart on 2,251 bytes or identical, run by run.)
    `a_clipped_stroke_takes_the_selection_its_mips_land_with`: 40 dabs clipped to a selection inverted while its chains
    are held back 3 s; once they land the live preview is its scratch built again. The film panel's flatten 500 ms
    after a change draws the layer through the stroke's scratch for the whole picture and made every rebuild happen
    anyway, so the step lets it run first and fails if a sampled pass comes during the gesture.
    `the_navigator_watches_the_chains_it_asks_for`: a 2400 x 1600 base at fit (level 0) with the navigator mounted as
    the node mounts it; its region canvas holds no landed cell it did not draw. On the canvas backend the released view is a reference only on the GPU path: with a filter layer in the
    stack that backend's view before and after `releaseCaches()` differs by 31 levels on about 726,000 bytes with no
    change at all (measured with and without the flip), which has nothing to wait for.
  - Waits added where a step reads the screen or counts uploads right after a whole change: `editor_test.py`'s edit
    step `settle` and step (a)'s `frame`, the final review step before it counts the fill's uploads (it failed once
    with 85 uploads for 70 tiles: the landing of the layer's own chains counted as the fill's), `composite_test.py`'s
    build, view shot, gpu-vs-2d step and every window comparison; `perf_test.py`'s new rows.
  - `perf_test.py` gains "frame after a whole change" at fit and at 1:1 on the GPU stack (the paint layer replaced by
    a flip, the frame `markLayerChanged`, the layer list and the draw make), each with "mips settled [longest block]",
    and "frame after a whole touch" at fit. Since the review the benchmark waits for the first frame's chains before
    its first row and before the fit pan on the GPU stack, the block hides the colour-matched result too, "settled"
    ends when `mipsSettled()` resolves (it held a fixed 50 ms wait), the bracket is the longest gap of a 1 ms timer
    while the chains land (a landing's own work runs outside `draw()`, which the old "worst frame" timed alone), and
    two rows count the chains built in the frame, asked for, landed and handed to a thumbnail.
- **Mutations, each red**:

  | mutation | red |
  |---|---|
  | a late chain installed without the version check | pixels: "a chain of the bytes before the second write was installed"; editor: "no late answer was dropped", "the settled screen does not show the second write", "a chain kept as exact is not the chain of its tile's bytes" |
  | a stale picture never replaced when the fresh chain lands (`_chainLanded` does nothing) | pixels: "the landing did not move the pixels' chainEpoch"; editor, GPU path only (the 2d row read 0, blind to it until the review): the settled screen against released caches 164 levels on 454,873 bytes after the flip, 184 on 195,129 after the fill |
  | the copy on write builds its chain into the chain it shares | pixels: "building the copy's chain wrote into the chain the original's holders read, at byte 2648" |
  | `thumbnailCanvas` builds its own chain again, into a buffer it does not keep (replaced by the review's rule: the thumbnail keeps no chain on a tile without one) | pixels: "the thumbnail built 0 chains for 6 tiles and mips() then 6 more" |
  | `touch()` gives every tile a new version again | pixels: `tiles_display_mirror` "touch() gave a tile a new version", `tiles_touch_keeps_tile_caches` "tile 1,0: a touch gave it a new version" |
  | the landing keeps the view's filter and colour-match caches | editor, Canvas 2D path: 42 levels on 127,675 bytes after the flip |
  | a slot keeps a stale picture after its chain is exact | editor, GPU path: 184 levels on 195,127 bytes after the fill |

  Each ran on a fresh tile-mode instance, and the source was restored and compared byte for byte afterwards.
- **The review's fixes** (a three-lens review, two refuting verifiers per finding; every finding below was confirmed by
  both, the last by one, and each fix has its counter-proof in the table after the list):
  - *A clipped stroke kept the clip of the selection before an invert* (races): `layerRegionView`'s signature carries
    the selection's `chainEpoch`, so the stroke's scratch is built again when the selection's chains land.
  - *A landing rebuilt both layer lists under an open rename* (races): a reference row is not in the layer list, so
    `refreshLayerThumb` fell back to `renderLayers()` on every batch; `watchChains` now redraws a landed layer's
    thumbnails in place wherever they are (`redrawThumbsOf`) and never rebuilds a list.
  - *The result list's thumbnails stayed coarse* (races): `redrawThumbsOf` redraws the result items made from the
    layer too (`canvas[data-hist]`).
  - *A copy's stale picture became the other holder's new pixels* (races): when a copy on write takes the original's
    chain and edge chain, the original stops owning them, so its last holder's rebuild allocates.
  - *The navigator's chains were watched by nobody* (races, node only): `drawThumb` calls `watchChains()`.
  - *The thumbnail kept a full chain on every tile of every layer* (cost, major; 196 MB a hidden 15k layer, and nothing
    released it): a tile without a chain buffer of its own gets none from the thumbnail. Its levels go into a scratch,
    a chain only a thumbnail asked for (`request(..., screen = false)`) is handed to the cell and dropped, and the
    thumbnail keeps that cell (`th.cells`, at most its own size) while the tile keeps its version. Found while fixing:
    without the kept cell a rebuild of the whole thumbnail (a batch landing on a quarter of its cells) asked for the
    handed tiles again, for good: 1.8 million requests in a few minutes on the check instance.
  - *A landing only a thumbnail asked for dropped the view's caches* (cost): the landing reports the stores a reader
    of the screen asked for (`landing().screen`), and only those move `chainEpoch` and drop the filter and colour-match
    caches.
  - *A write outside a region canvas rebuilt it whole* (cost): `_changed` marks only the cells a region holds.
  - *A replaced store's chains went first* (cost): the queue is flushed newest first, an entry asked for again goes to
    its end, and a region canvas's cells still shown stale keep their tiles ahead (`touch`), so the pixels on the
    screen go before the pixels a later whole change replaced. (A liveness test would not catch a flip: the replaced
    pixels still hold the tile at its key.)
  - *The released view of the 2d rows was drawn from the same region canvases* (gates, major): the step releases the
    caches with the region canvases and thumbnails, and its second write adds thin stripes, so a coarse cell is not
    the exact one; the M2 row above says what the step saw before.
  - *The perf block moved every row below it, and "inside the noise" was wrong* (gates, major): four runs with the block
    after the last row are the A/B of the old rows, the benchmark waits for its first frame's chains and before the fit
    pan, and the table below says what moved; the block itself went back where it measures the change it names.
  - *"In flight" counted queued tiles* (gates): the step asserts `flight > 0` and reports queued and in flight apart.
  - *"Settled" held a 50 ms wait and the worst frame missed the landings' own work* (gates): see `perf_test.py` above.
  - *No gate compared the region canvas's word copies* (gates): `pixels_test.js` (10).
  - *No gate read a row after a landing* (gates): the thumbnails step.
  - *The CHANGELOG bullet read as if a whole change no longer froze the window* (gates): it says what went (the tiles'
    preparation for the screen) and what stays (0.8 s for a flip, 1.2 to 1.4 s for mask from selection at 15k).
  - *memoryReport said nothing of the chains and the scheduler's pool* (cost, one verifier): the report's `tiles` has
    `chains` and `chainBytes` (a buffer a copy shares counted once) and `chainPoolBytes`, and `releaseCaches` empties
    the pool (32 MB at most, kept from the first whole change until the app quit) when nothing is on its way. The
    refuting verifier was right that the chains were missing from the report before this step; the pool is new here.

  | review mutation | red |
  |---|---|
  | the stroke's view key without the selection's `chainEpoch` | editor `a_clipped_stroke_takes_the_selection_its_mips_land_with`: 255 levels on 103,985 bytes (green until the step let the film panel's flatten run first and drew the tint: that flatten rebuilt the scratch anyway, and the moving ants made the step fail twice in ten editor runs on the fixed code) |
  | a landing refreshes rows through `refreshLayerThumb` | editor thumbnails step: "the landings rebuilt the layer lists 3 times", "the open rename was taken", the result item stale |
  | a landing leaves the result list's thumbnails | editor thumbnails step: "the result list's item was last drawn from a thumbnail its chains' landing changed afterwards" |
  | the original keeps owning the chains its copy reads | pixels (5b): "the original's rebuild wrote into the chain its copy shows, at byte 0" |
  | `drawThumb` does not watch its chains | editor navigator step: "the navigator's region at level 2 keeps 0 stale and 54 landed cells it never drew" |
  | the thumbnail keeps a chain on every tile | pixels (6): "the thumbnail built 6 chains to keep on tiles that had none"; editor: "a hidden layer at 1:1 kept 192 chains on its tiles" |
  | the thumbnail keeps no cell for a tile without a chain | pixels (6b): "the thumbnail after the landing differs from an exact one at byte 0" |
  | a thumbnail-only landing drops the view's caches | editor thumbnails step: "a landing only a thumbnail asked for dropped the view's caches" |
  | a write marks cells outside a region canvas | pixels (9): "a write outside the region marked 1 of its cells dirty" |
  | the queue goes oldest first | pixels (8): "the batch after B asked holds 0 of B's tiles and A's older ones went first" |
  | a stale region cell does not keep its tile ahead | pixels (8): "the cells still shown stale did not bring their tiles ahead of B's newer ones" (green until (8) read a store whose second read touches its stale cells without putting them again) |
  | a landing moves `chainEpoch` but leaves the region canvases' stale cells | editor whole-change step, 2d path: 42 levels on 136,485 bytes after the flip |
  | the flush waits for a timer | editor whole-change step: "no batch of chains was in flight when the second write came (192 queued)" |
  | `releaseCaches` keeps the scheduler's pool | editor whole-change step: "releaseCaches kept 128 buffers of the mips scheduler's pool" |
  | the region canvas's word copy drops the level's offset | pixels (10): "level 3, exact: differs at byte 1 (51 against 36)" |
  | a landing redraws no thumbnail | editor thumbnails step: the layer's row, the reference's row and the result item each "last drawn from a thumbnail its chains' landing changed afterwards" |

- **`perf_test.py`** (15000 x 10000, tiles on, a fresh instance each, the card not freed, as the run before the change).
  The build's two runs (`c6b-perf-on`, `-on2`) put the new block before the stroke rows; the review showed that this
  compared the old benchmark on the old tree with a new benchmark that replaces a paint layer twice before those rows,
  so they were no A/B, and "the other rows are inside the noise" was wrong (the PNG encode's blocked time went from 30
  to 232-244 ms, `getValue` from 0 to 8 ms, the fit pan on the GPU stack from 0.3 to 2 ms). After the fixes:

  - **The rows the benchmark had before**, from four runs with the new block moved after the last row, so they run on
    the document as before (`c6b-final-perf` to `-perf4`), against the log before C6 (b) (`c6b-perf-before`):

    | row | before | after (four runs) |
    |---|---|---|
    | pan at fit, GPU stack | 0.3 ms [6.8] | 0.3 ms [5.9-6.9] |
    | undo step | 27.7 ms | 10.9-14.6 ms |
    | selection change | 26.9 ms | 19.0-20.5 ms |
    | stroke commit (undo copy) | 21.2 ms | 17.3-21.3 ms |
    | full composite | 112.9 ms | 90.4-102.1 ms |
    | getValue (autosave) | 0.0 ms | 5.3-7.6 ms |
    | invert, blocked | 1215 ms | 740-824 ms |
    | magic wand (an object), blocked | 676 ms | 188-259 ms |
    | bucket fill, blocked | 562 ms | 335-353 ms |
    | stroke across the picture (40 dabs), blocked | 620 ms | 146-161 ms |
    | its commit, band by band, blocked | 562 ms | 604-698 ms |
    | PNG of the composite, blocked [wall] | 30 ms [3930] | 88-284 ms [3758-4558] |

    The fit pan's 2 ms was the benchmark's: its first frame's chains were still in the worker when the synchronous pan
    ran, so it panned over coarse slots; the benchmark waits for them now. `getValue` (median of three; its maximum,
    the whole selection's `toCanvas` for the background encode, is 104-141 ms before and after) and the PNG encode's
    blocked time moved without the block and were not broken down. Grow, shrink and feather swing between 200 and 800
    ms from run to run as they did before C6 (b), and the wand's whole-image band stays at 4.6 to 5.6 s (phase E).
  - **The new rows**, with the block where it was (`c6b-final-perf5`), now with the colour-matched result hidden as
    well as the filter layer (a whole change under it invalidates its match, which is not a mips cost):

    | row | build (match shown) | after the review |
    |---|---|---|
    | frame after a whole change, fit | 29.1 / 32.8 ms | 28.5 ms; 16 chains built here, 2,360 asked |
    | &nbsp;&nbsp;mips settled [longest block] | 703-718 ms [frame 15-16] | 702 ms [141] |
    | frame after a whole change, 1:1 | 52.1 / 55.4 ms | 38.7 ms; 16 built, 82 asked |
    | &nbsp;&nbsp;mips settled [longest block] | 90-113 ms [frame 7] | 35 ms [6] |
    | frame after a whole touch, fit | 18.8 / 18.9 ms | 12.9 ms |

    The longest block while a whole change's chains land at fit is **141 ms**, which the old "worst frame" could not
    see: a check instance traced it to the film panel, whose thumbnails flatten the document 500 ms after a change
    through `sampleRegion`, a reader that is not a display reader and builds the chain of every tile it needs on the
    main thread, 2,360 of them at 15k (`main` 2,360 after the 1:1 flip there, while the frame had asked the worker for
    2,344). That is also why the 1:1 row asks for 82: the flatten after the fit row built the rest. Named for the next
    step; the plan kept `sampleRegion` exact on purpose.
- **Runs** (fresh instances, strict): the build's final tree `--tiles on` (`c6b-tiles3`) and `--tiles off` (`c6b-canvas6`)
  with `pixels editor composite commands shape brush film glb ailabel size transparent generate log mcp nodecopy`
  ALL PASS, and `--copy --tiles off pixels editor composite commands` (`c6b-copy5`) ALL PASS. On the way:
  - The new step failed on the canvas backend three times for reasons in the step: its layer's canvas was shrunk
    after `fromCanvas`, which that backend adopts as the pixels (the flip showed nothing), and then the Canvas 2D
    path's released view differed as described above.
  - `c6b-tiles2` failed `c2_final_review_drag_undo_steps_writes_mirrors_report_limits` with 85 uploads for 70 tiles:
    the layer's own chains landed while the step counted the fill's uploads. It waits for `mipsSettled()` first now.
  - `c6b-canvas4` failed `live_stroke_preview_shows_what_the_commit_writes` (shape, 90 levels) and `composite_test.py`'s
    window step (0 uploads, 63 levels at half), right after a check instance of mine had been closed; `c6b-copy4`
    straight after it and `c6b-canvas5` passed both, with no change in between.

  After the review's fixes: `--tiles on` (`c6b-final-tiles2`), `--tiles off` (`c6b-final-canvas2`) with the fifteen gates
  and `--copy --tiles off pixels editor composite commands` (`c6b-final-copy2`) ALL PASS, and `perf:15000x10000`
  (`c6b-final-perf5`) PASS. On the way `c6b-final-tiles` failed the new clipped-stroke step once on correct code (the
  marching ants an earlier step leaves on moved between its two screens; eight editor runs, `c6b-diag1` to `-diag8`,
  failed it once more, then it drew the tint and passed `-diag9` to `-diag11` and the final gate), and a first perf pass with the block at the end measured
  its rows on a document the operation rows had given display mirrors (187 and 772 ms frames), which is why the block
  went back.

**(b2) The A/B of the three rows, and the selection's landings** (`inpaint_canvas.js`, `tools/perf_test.py`,
`tools/editor_test.py`):

- **The A/B.** Three `perf_test.py` rows moved the wrong way in (b) and were not broken down: `getValue` 0 → 5-8 ms, "its
  commit, band by band" 562 → 604-698 ms, "PNG of the composite" 30 → 88-284 ms blocked. They were measured against a
  worktree of 00a3ade (A) with one script on both trees: perf_test.py's document and every row before the three, the (b)
  whole-change block left out. Each run on a fresh tile-mode instance: a first pair (B0, then A0), then alternating A1 B1 A2 B2
  A3 B3, plus a profiled run of
  each, a traced run of B and a `getValue` check. 15000 x 10000, view 1865 x 1198 at fit, the ComfyUI queue empty.

  | run | getValue 2nd / 3rd ms | commit blocked [wall] ms | PNG blocked [wall] ms | chains landed in the PNG row | stroke across (40 dabs) | invert |
  |---|---|---|---|---|---|---|
  | A0 | 0 / 0.1 | 421 [421] | 139 [3861] | - | 626 | 1072 |
  | A1 | 0.1 / 0.1 | 452 [452] | 28 [3702] | - | 613 | 1085 |
  | A2 | 0 / 0 | 458 [458] | 28 [3812] | - | 667 | 1153 |
  | A3 | 0.1 / 0 | 677 [677] | 73 [3934] | - | 717 | 968 |
  | A profiled | 0 / 0 | 459 [459] | 75 [3930] | - | 765 | 1019 |
  | B0 | 4.4 / 4.6 | 547 [547] | 194 [4183] | 1255 | 111 | 689 |
  | B1 | 8.3 / 7.9 | 534 [467] | 281 [4628] | 1383 | 171 | 668 |
  | B2 | 7.7 / 8.0 | 657 [574] | 220 [4536] | 1383 | 221 | 737 |
  | B3 | 11.1 / 9.0 | 621 [539] | 227 [4547] | 1255 | 188 | 655 |
  | B profiled | 8.0 / 7.4 | 652 [581] | 313 [4386] | 1255 | 179 | 666 |
  | B traced | 7.1 / 7.2 | 594 [594] | 217 [3711] | 1127 | 163 | 633 |

  - **`getValue`: the benchmark's timing, not a cost of (b).** `getValue` stringifies `selectionDataUrl`, the selection's
    PNG from the background encode, 3.74 MB at 15k. In B the 1.5 s autosave timer (`host.changed` → `saveAll` →
    `getValue` → `encodeSelectionSoon`) fires during the benchmark's `await ed.mipsSettled()` waits, so by the row the PNG
    has landed and the JSON is 3,745,427 characters; in A those awaits resolve at once and the JSON is 2,166 characters.
    With the encode landed A's `getValue` is 7.1-7.8 ms too (B 7.3-8.1), and without the data URL both are 0.1 ms. The
    cost is real in use (every autosave, both trees) and old.
  - **The commit: the probe window and garbage collection, not the chains in flight.** Wall of the synchronous commit: A
    421-677 (median 458 of the five runs), B 467-594 (median 561 of the six, 547 without the traced run). In B the probe's longest gap also swallows the frame after the commit
    (35-82 ms), which in A is a gap of its own. The profiles: `commitStroke` 302 / 324 ms inclusive (A / B), the garbage
    collector 202 / 339 ms. The hypothesis that the collector is busy with the 1,500-2,100 selection chains the stroke's
    clip left in flight was measured on the tree of 987961b, three runs each, a fresh instance each, the CPU profile
    around the commit alone:

    | before the commit | chains pending | commit blocked [wall] ms | GC in the commit's profile | `commitStroke` inclusive |
    |---|---|---|---|---|
    | nothing | 2,057 | 592 [518], 531 [531], 659 [582] | 234, 260, 340 ms | 336, 307, 321 ms |
    | `await ed.mipsSettled()` (433-576 ms) | 0 | 561 [561], 629 [629], 715 [715] | 308, 371, 364 ms | 309, 332, 420 ms |

    With nothing in flight the commit is no faster and the collector no less busy: the garbage is the commit's own. The
    largest self entry of the commit's profile is the collector (234-371 ms) in five of the six runs, and the band
    `getImageData` (191-303 ms) in the sixth and the next in the other five. Not changed here.
  - **The PNG row: the landings of the rows before it.** The encode itself did not change (A 28-75 ms blocked). In B
    1,127-1,383 chains land during the row, in batches of 128, all but the last two the **selection's**, asked for by the
    rows before: the 40-dab stroke's clip asks for 2,349 selection chains (the selection was just filled over the whole
    picture), invert for 1,999, the wand for 1,452. Every landing that reached the selection counted as a screen hit in
    `watchChains`, which dropped **every layer's `_fcacheView`, `_mcacheView` and `_mstatsView`** and `sceneSig` and drew
    again. The perf document has a colour-matched result and a film look filter layer, so each such draw ran `matchStats`
    again (three readbacks, the backdrop's waiting for the GPU queue) and the filter pass: matchStats 75, 110, 143, 370, 543
    ms, applyFilterLayer 30-100 ms (once 3,136 ms behind the wand's GPU work). The PNG row's blocked time was one such draw.
- **Who reads the selection, checked before the change.** The selection's mip chains are read only by `drawSelectionInto`
  (a display region canvas), whose callers are the tint and the quick mask in `drawSceneOverlays`, the marching ants
  (`drawMarchingAnts`, also an overlay), the navigator's `drawThumb`, and `drawStrokeInto` for a live stroke clipped to
  the selection, whose view scratch `layerRegionView` keys on `sel.chainEpoch` (b). None of them is part of the scene
  canvas except that scratch. Everything else reads the selection's exact pixels and no mip: `drawLayerThumb` does not draw
  it; the compositor never gets it; `filteredCanvas` / `applyFilterLayer` and `matchStats` read the composite of the layers
  (a filter layer's own mask through `maskPx.drawTo`); plugins read `readRect` (`Document.selection` in
  `renderer/plugins.js`) and draw their overlays each frame outside the scene; `promptContextCanvas` uses `sel.drawTo`;
  exports, uploads and `clipCanvasFor` use `readRect`, `toCanvas` or `drawTo`.
- **Which view caches a landing of a layer makes stale, measured.** The matched layer's own pixels in a view pass come from
  its display canvas (`layerPixels(layer, true)` → the mirror, or `_masked` from mirrors), never from mips, so a landing of
  its own chains changes nothing of its match; its statistics and so its matched pixels read what is under it; a filter
  layer's output reads everything below it; a layer below the landed one reads nothing of it. On perf_test.py's document
  (15000 x 10000, fit, level 3; Paint 1 to 3, the matched result, the film look), each scenario from a settled screen,
  counted from the end of the operation until `mipsSettled()`, two runs per rule, a fresh instance each, the card free.
  "Screen" is the settled screen against the view drawn from released caches with every pyramid level built (the first
  version of the script re-matched while the result's display pyramid was still being built, one level per frame, and read
  62 levels on the result's rectangle with no operation at all):

  | scenario | rule | landings | draws, total ms | colour matches / filter passes again | screen |
  |---|---|---|---|---|---|
  | invert of a 40 % selection | (b) | 16 (selection) | 16, 171-182 | 16 / 16 | 0 |
  | | (b2) | 16 | 16, 10.5-11.7 | 0 / 0 | 0 |
  | whole selection, then 40 clipped dabs, pointer held | (b) | 20 (2,349 selection, 91 stroke) | 19-20, 157-166 | 19-20 / 0 (the filter is off during a gesture below it) | 0 |
  | | (b2) | 20 | 20, 37-42 | 0 / 0 | 5 levels on 73,548 bytes, the result's rectangle |
  | flip of Paint 1, the match and the filter above it | (b) | 19 (Paint 1) | 19, 223-239 | 19 / 19 | 0 |
  | | (b2) | 19 | 19, 34-37 | 1 / 1 | 0 |
  | flip of Paint 1 moved to the top, both below it | (b) | 20 | 20, 210-238 | 20 / 20 | 0 |
  | | (b2) | 20 | 20, 26-27 | 0 / 0 | 0 |

  A match or filter pass costs 5-12 ms here, with nothing else on the card; the (b) A/B's 75-545 ms were each of them
  behind the GPU work of the rows before. A rule tried on the way that kept every cache for a layer landing ("keep") left
  the screen stale by 69 levels on 51,242 bytes after the flip below the match and the filter, and matched the reference
  after the flip above them; so the caches below the landed layer stay, the ones above go. The 5 levels of the held stroke:
  during a gesture nothing re-runs the match of a layer above the stroke (its statistics are keyed on the composite
  version, which the commit moves), as on the canvas backend; the (b) rule re-ran it only because the selection's landings
  dropped it, and the reference drops it too. The commit makes it exact. The longest block after the two flips in this
  table is the film panel's flatten 500 ms after a change (135-301 ms, `sampleRegion` building exact chains: C6 c's); after
  the invert it did not run and after the held stroke it took 3 ms.
- **Built** (`watchChains`, `staleViewCachesAbove`, `dropStaleViewCaches`):
  - A landing of the **selection's** chains draws again (`drawSoon`, the navigator) and drops no view cache and no
    `sceneSig`: the scene canvas is reused and the overlays are drawn from the landed cells. For a live stroke clipped to
    the selection (`pointer.stroke` with `pointer.clip`) the scene is drawn again, because its view scratch is clipped by
    the selection's region canvas; the first version of the rule without it left that stroke's preview 77 levels off on 117,037 bytes at 15k.
  - A landing of the **base's**, a **layer's** or a **mask's** chains (a reader of the screen asked for them) draws the
    scene again at once and records the base or the layers. When no chain is on its way any more, `_fcacheView`,
    `_mcacheView` and `_mstatsView` of every layer **above the lowest recorded one** are dropped (all of them for the base,
    or when a recorded layer was removed meanwhile) and the view is drawn again, once. The drop runs in the last landing's
    own callback, which runs before the continuations of `mipsSettled()`, so a reader that draws right after it sees the
    fresh match; a `settled()` waiter covers a queue whose last entries were dropped without a landing.
  - The same drop also nulls `_mcacheSample` and `_fcacheSample` of those layers, without a draw of its own (review fix).
    A sampled pass (`sampleRegion`: a plugin's `flatten({ maxSize })`, the film panel's flatten 500 ms after a change)
    reads exact mips but takes the match's statistics from the screen's slot, `_mstatsView`, when they are there; one that ran
    while the chains were on their way cached matched pixels (and a filter output made from them) from the coarse
    picture's statistics, and they outlived the settle until the composite version moved: a 512 px flatten after
    `mipsSettled()` was 6 levels on 44,434 bytes off (GPU path) and 2 on 9,053 (with an invert filter above) at 4000 x
    3000.
  - A sampled pass takes the screen's statistics when they are valid and otherwise makes its own in `_mstatsSample`; it
    never writes `_mstatsView` any more (found while gating the review fixes). The film panel's 192 px flatten that ran
    between the settle's drop and the next screen frame made the screen's statistics from its own small picture, and the
    whole matched layer stayed 5 levels off until the composite changed again: a full `editor` gate run failed the step's
    (ii) screen with 5 levels on 355,031 bytes on both paths, and a run that put a 192 px flatten there on purpose read 5
    on 368,150. A 1 x 1 eyedropper pass that came first after a change could store null statistics in that slot too (the
    hand-over's probable bug; not measured). `_mstatsSample` is reset wherever
    `_mstatsView` is, and dropped with the sampled caches at the settle. What is left: a sampled pass that comes first
    after a change still keys its own statistics on the layer only, so a partial one (the eyedropper's box, the wand's fine
    box) sets them for the sampled passes after it, the film panel's among them, until the screen has drawn (and a matched
    picture cached from them until the composite changes); statistics of a pass whose region does not hold the layer's
    ring are C6 (c)'s.
  - Once per frame instead of once per batch would not have helped: the batches land 20-40 ms apart (16 landings in 324-378
    ms after the invert above), more than a frame, and each one ran the match again. Meanwhile the screen shows the previous filter
    output and match, as it shows the coarse picture of the tiles; with a filter layer covering the view that picture turns
    sharp in one step when the last chain lands (0.74-0.95 s after a flip at 15k) instead of sharpening per batch.
  - The canvas backend never has a chain on its way (`watchChains` returns at once): no change there, so no CHANGELOG
    bullet (tile mode is off in the installed app).
- **`perf_test.py`**: `op()` waits for `ed.mipsSettled()` before its probe starts, so a row is not charged with the landings
  of the rows before it, and the probe runs until `mipsSettled()` after the operation, so "blocked" includes the landings
  and redraws the operation caused; "wall" stays the operation's own time (the docstring says so). A new row under invert,
  "its landings: re-runs [longest block until settled]", counts the screen's colour matches and filter passes run again
  while the inverted selection's chains land; its bracket is the longest block from the end of the invert until they have
  landed, whatever held the window (the review renamed it from "[longest block]": it is not a landing's block). Three runs on the final tree (`c6bf-perf1` to `-perf3`) and two with the `watchChains`
  change reverted, the same benchmark (`c6bf-perf-reverted`, `-reverted2`), alternating:

  | row | reverted | final |
  |---|---|---|
  | invert, blocked [wall] | 971 [968], 671 [671] | 864 [864], 1042 [1041], 820 [819] |
  | &nbsp;&nbsp;its landings: re-runs [longest block until settled] | 30 [514 ms], 32 [51 ms] | 0 [258 ms], 0 [400 ms], 0 [360 ms] |
  | stroke across the picture (40 dabs) | 170, 150 | 155, 168, 167 |
  | its commit, band by band | 622, 590 | 610, 623, 587 |
  | PNG of the composite | 26, 68 | 55, 48, 27 |
  | getValue (autosave) | 7.7, 6.8 ms | 7.6, 8.9, 5.2 ms |
  | frame after a whole change, fit; settled [longest block] | 35.3; 653 [127], 27.0; 678 [123] | 29.0; 653 [119], 30.7; 691 [132], 27.6; 607 [94] |

  - One more run on the tree with the review fixes (`c6bf-final-perf`, the ComfyUI queue empty before and after): invert
    949 [949], its landings 0 [356 ms], stroke across the picture 168, its commit 624, PNG of the composite 11, getValue
    7.4 ms, magic wand (an object) 488, bucket fill 750, the frame after a whole change at fit 26.5 ms, settled 713 ms
    [146].
  - The PNG row is back at the encode's own 26-68 ms on both trees: what (b) charged it was the landings of the rows before,
    which `op()` now waits for. The commit and `getValue` rows are as the A/B above explains.
  - The longest block while the invert's chains land on the final tree is not a landing's draw (0 re-runs; the traced
    landings, `ChainScheduler._land` with its flush, take 3-6 ms). A traced run (`encodeSelectionSoon`, `getValue`, the
    draws, readbacks over 15 ms) puts the selection's background encode (170-209 ms) and a gap of 260-376 ms in that
    window, on both trees. The gap sits between two landings and nothing traced ran in it; what held the thread there
    (the delivery of a worker reply, a collection of landed chain buffers, something else) was not attributed.
  - "magic wand (an object)" and "bucket fill" read 591-868 and 335-962 ms blocked on the final tree against 280-281 and
    315-353 reverted in these runs. A traced pair of the same rows read the other way round (final 276 and 348, reverted 512
    and 574): the rows are the flood's `applyShapeToSelection` (268-345 ms), the selection's encode and readbacks behind
    the GPU queue, and they move by that much from run to run. Grow, shrink and feather swing between 190 and 570 ms as
    before.
- **Gates**:
  - `editor_test.py` gains `landings_of_the_selection_leave_the_filter_and_the_colour_match` (both backends; on the canvas
    backend nothing lands, the counts stay 0 and the screens are checked as they are). A 4000 x 3000 document at fit (level
    1), a painted layer, a colour-matched result over part of it, the selection shown as a tint; on the GPU path, and with
    an invert filter layer on top on the Canvas 2D path. (i) An invert of a rectangle selection asks the worker for chains
    (156), and from the end of its frame until they have landed and been drawn the screen passes run `matchStats` and
    `filteredCanvas` again 0 times; the screen as the landings left it, with no frame of the step's own, is the view drawn
    from released caches (`releaseCaches({ mirrors: true })`, then the view caches made again once every pyramid level is
    there) within 3 levels. (ii) A flip of the painted layer below the match (192 chains asked for, two batches) runs the
    match again exactly once, and on the 2d path the filter, and the screen as the landings left it is the released view
    within 3 levels. Measured: re-runs 0,0 and 1,0 (GPU), 0,0 and 1,1 (2d); the screens 0 to 2 levels.
    The review found that the step checked "at least once" and never exercised the lower bound or the base, so a return
    to the (b) rule for a layer's landings stayed green; it gained three parts. (iii) A flip of a layer on top of the stack
    (20 chains) runs the match and the filter below it again 0 times, and the screen is exact. (iv) A 512 px flatten
    (`sampleRegion`, as `flatten({ maxSize: 512 })`) right after a screen frame of a flip, with 192 chains on their way,
    and the same flatten after they have landed equals the flatten with the sampled caches made again (0 levels). (v) The
    base replaced under the layers (`setBaseFromCanvas`, `keepLayers`; 176 chains) runs the match again once, and on the
    2d path the filter. (vi) A 192 px flatten right after `mipsSettled()` of a flip, before the screen's next frame: the
    screen as the landings left it is the released view within 3 levels. The re-runs are counted as changes of the view's
    slots in any region pass (a navigator pass would count). Measured: (iii) 0,0 exact 0 on both paths, (iv) 0 on 0
    bytes, (v) 1,0 (GPU) and 1,1 (2d), (vi) 1 level (GPU) and 0 (2d).
  - `a_clipped_stroke_takes_the_selection_its_mips_land_with` (b) reads the screen as the landings left it as well, before
    its own frames, and compares it with the preview built again: 1 level on 115 bytes. Its frames of its own had hidden
    the rule (the mutation below stayed green before).
- **Mutations, each red** (tile mode, a fresh instance each, the source restored and compared byte for byte):

  | mutation | red |
  |---|---|
  | a landing of the selection's chains drops every layer's view caches (the (b) rule) | the new step: "the landings of the selection's chains ran the colour match 2 and the filter 0 times again" (GPU), "2 and 2" (2d) |
  | a landing of the selection's chains draws nothing | the new step: the screen after the selection's landings 93 levels on 638,953 bytes (GPU), 95 on 638,024 (2d) |
  | a landing of a layer's chains drops no view cache | the new step: "the colour match above the flipped layer did not run again" on both paths, the filter's on 2d, the screen 7 levels on 393,967 bytes (GPU) and 33 on 784,176 (2d) |
  | a landing of the selection's chains does not draw the scene for a stroke clipped to it | `a_clipped_stroke_takes_the_selection_its_mips_land_with`: "the screen the landings of the selection's chains left is not the live preview built again (255 levels on 106,829 bytes)"; green before the step read that screen |
  | the settle leaves the sampled passes' caches (the code before the review fix) | the new step's (iv): 6 levels on 44,434 bytes (GPU), 2 on 9,053 (2d); with the statistics slot below in place, 6 on 44,434 and 1 on 2,300 |
  | the settle drops the sampled matched pixels but not the filter output made from them | (iv) on the 2d path: 2 levels on 9,053 bytes; with the slot, 1 on 2,300 |
  | a sampled pass makes its statistics in the screen's slot (the code before the second fix) | (vi): the screen 5 levels on 355,676 bytes (GPU) and 355,440 (2d) |
  | a landing of a layer's chains drops every layer's view caches (the (b) rule; green on the step before the review) | (ii): the match 3 times again (and the filter 3 times on 2d), once expected, and the same for (v); (iii): the match 1 and the filter 0 (GPU) / 1 (2d) times again below the layer on top. A first run, before (vi) and the slot, read (ii) as 1 and failed on its screen (5 levels on 355,031 bytes) and on (iii) |
  | the drop ignores the lowest landed layer and takes the layers below it too | (iii): the match 1 and the filter 0 (GPU) / 1 (2d) times again |
  | a landing of the base's chains is not recorded | (v): the match 0 times again on both paths, the filter 0 times on 2d |

  Not proven by a gate: the `settled()` waiter for a queue whose last entries were dropped without a landing (the gate
  steps read the screen after waits that also cover it).
- **Runs** (fresh instances, strict): `--tiles on` (`c6bf-tiles`) and `--tiles off` (`c6bf-canvas`) with `pixels editor
  composite commands shape brush film glb ailabel size transparent generate log mcp nodecopy` ALL PASS; `--copy --tiles off
  pixels editor composite commands`: `c6bf-copy` failed on `commands_test.py` running into the runner's 420 s timeout
  after every step had printed `[ok]` (the known `Page.captureScreenshot` hang), `c6bf-copy2` ALL PASS with no change in
  between; `perf:15000x10000` PASS in all five runs above.
- **Runs after the review fixes** (fresh instances, strict): the first `c6bf-final-tiles` failed `editor` on the (ii) screen
  (5 levels on 355,031 / 355,469 bytes: the statistics race above, which led to `_mstatsSample`) and `commands` on the
  known hang after every step printed `[ok]`; the first `c6bf-final-canvas` failed the new (vi) on its GPU path with 193
  levels on 1,145 bytes, most likely the default selection brush's ring under a real pointer over the window (the ring
  alone is 203 levels on 576 bytes at fit), so the step now takes the marquee tool. After that: `c6bf-final-canvas`,
  `c6bf-final-tiles` (the 15 gates each) and `c6bf-final-copy` (`--copy --tiles off pixels editor composite commands`)
  ALL PASS, `c6bf-final-perf` PASS. Each mutation in the table above ran on a fresh tile-mode instance with the source
  restored and compared byte for byte.

**(b3) The wand and the bucket after (b2), and a sampled pass that matches only what it shows** (`inpaint_canvas.js`,
`tools/editor_test.py`):

- **The question.** The (b2) review's benchmark runs read "magic wand (an object)" at 488-868 ms and "bucket fill" at
  335-962 ms blocked on the (b2) tree, against about 280 and 315-353 with (b2)'s `watchChains` change reverted, and called it
  noise. Settled with 726dc66's `perf_test.py` on both trees: a worktree of 987961b (A) against 726dc66 (B), fresh tile-mode
  instances, alternating A1 B1 ... A4 B4, 15000 x 10000, the ComfyUI queue empty before and after every run:

  | run | invert's landings: re-runs [longest block] | magic wand (an object), blocked [wall] | bucket fill, blocked [wall] |
  |---|---|---|---|
  | A1-A4 | 32 [46-65 ms] | 248 [415], 293 [625], 332 [706], 330 [837] | 298 [645], 308 [655], 339 [728], 480 [956] |
  | B1-B4 | 0 [231-362 ms] | 424 [1018], 321 [716], 655 [1124], 424 [929] | 821 [1398], 427 [830], 769 [1405], 342 [801] |

  So the rows did move the wrong way. The same two operations repeated six times each on the benchmark's document with none of
  the rows before them (two instances per tree, the same `op()` probe) did not: blocked A 166-232 / 186-299 ms, B 132-264 /
  139-248 ms (wand / bucket), walls A 284-369 / 454-536, B 301-563 / 490-710. What the rows are charged with is the state the
  rows before leave.
- **Broken down** with a trace of both rows in the full benchmark (`matchStats`, `filteredCanvas`, `layerMatchedPixels`,
  `sampleRegion`, the draws, `getImageData` over 2 ms, the probe's gaps), one run per tree, then again for the fix:
  - On B every fine box of the flood colour-matched the **whole** matched result (2048 x 2048): `layerMatchedPixels` in the
    sampled pass 196-224 ms (its `matchStats` 0 ms, the screen's statistics), and the film look pass behind it 138-164 ms
    waiting for the GPU. Since (b2) a sampled pass takes the screen's valid statistics, and `layerMatchedPixels` then matches all
    of its source for a box of a few hundred pixels.
  - On A the same passes took 16.9 ms, all of it their own `matchStats` (two 296 x 296 readbacks) and nothing for the match:
    a landing of the selection had dropped `_mstatsView` between the coarse and the fine pass, the box computed statistics from
    its own few hundred pixels, found fewer than 64 of the layer's surroundings, and stored **null** in the screen's slot. The
    match was skipped inside the wand, which is why A was cheaper. Forcing that drop between the passes on a 6000 x 4000 document
    reproduces it on A, and on B and the fix too, where the null goes to `_mstatsSample` instead: the flood then reads the matched
    layer unmatched and the wand selects a different region on all three trees ([1200, 1000, 3648, 3048] against [1200, 1200,
    1600, 1800] without the drop). That race is the one (b2) left to C6 (c) and stays there (statistics that do not depend on the
    pass, slice 7).
  - The rest of the rows' longest block is the same work on both trees, placed differently: the selection undo copy
    (`snapshotSelection`, 143-175 ms on A and on the fix) and a scene composite of 60-80 ms, which on A a landing ran during the
    flood's wait and on B lands in the operation's own last draw.
- **Built**: `layerMatchedPart(layer, below, vp)`. A sampled pass (`vp.sample`) matches the part of the layer its region shows,
  one source pixel wider on every side for the draw's filtering, with the whole layer's statistics, and draws that part where it
  sits (`drawLayer`); the cache slot `_mcacheSample` keys on the part. The screen and the full-resolution flatten keep
  `layerMatchedPixels`. Both backends take it; the pixels are unchanged (0 levels, below).
- **After**, traced: the part costs 7-27 ms per box and the film look behind it 31-51 ms. The rows themselves stay noisy on the
  fix: three alternating runs against B's 440 [1074], 686 [1056], 635 [1072] (wand) and 394 [922], 789 [1522], 411 [870]
  (bucket) read 542 [831], 552 [1372], 4294 [5046] and 795 [1302], 541 [1168], 971 [1578], and two more 260 [591] / 590 [910]
  and 382 [785] / 556 [1221]. The 4.3 s wand is one run of five and was not broken down. The repeated operations on the fix:
  blocked 144-227 / 147-228 ms, walls 336-432 / 509-686.
- **Gate**: `editor_test.py` `a_sampled_pass_matches_only_the_part_of_a_matched_layer_it_shows` (both backends). A 3000 x 2000
  base, a colour-matched 1200 x 900 layer at 700, 500, the screen's statistics made. A `sampleRegion` over a box that cuts the
  layer's left edge, at scale 1 and at 0.5, matched at most 302 x 302 of the layer's source pixels (measured 301 x 302, the whole
  layer 1200 x 900), and its pixels are the same box cut out of a pass over the whole layer within 1 level (measured 0 on both
  backends); floor: the box's pixels of the layer are 15 levels from the layer's own.
- **Mutations, each red** (tile mode, fresh instance, the source restored and compared):

  | mutation | red |
  |---|---|
  | the part is the whole layer again | "a 1 pass over a box matched [1200,900] source pixels of the layer" |
  | the part cut two source pixels too tight on every side | "the 1 pass over the box differs from the pass over the whole layer by 148 levels on 2694 bytes" |

**(c1) Box reads at level 0** (`inpaint_canvas.js`, `inpaint_filters.js`, `renderer/plugins.js`, `plugins/film/points.js`,
`plugins/film/filters.js`, `plugins/sample/main.js`, the three gates, `tools/perf_test.py`, `docs/PLUGINS.md`):

- **Measured before** (15000 x 10000, tiles on, `perf_test.py` with the new rows at its end, on bc3814d; two runs, the second
  through a worktree of it, the ComfyUI queue empty):

  | row | before | after |
  |---|---|---|
  | film point add, the film look under it, blocked [wall] | 5076 [5069], 5128 [5117] | 362 [349], 261 [256] |
  | `sample.mean_color`, 1000 px selection, film look and matched result shown | 5254 [5254], 5220 [5220] | 5110 [5042], 4479 [4479] |
  | the same with the filter layer and the matched result hidden | 2615 [2615], 2789 [2788] | 154 [149], 306 [304] |
  | bucket in a 1000 px selection (inside a disc of the base) | 328 [629] | 348 [536] |

  On a 15000 x 10000 base with a film look the point's colour read itself is 2.7-3.9 ms (box padded by 0 or 128 px) and
  3.4-5.9 ms (256 px); the whole `film.add_point` command 11-12 ms. The row's blocked time is the frame the new points
  layer draws. `mean_color` with the film look shown stays a whole flatten by design (below). The bucket row did not move: the
  whole selection materialised per fine round (a 572 MB canvas holding a few tiles) was not what held the window longest; the
  row was not broken down further.
- **The film control points' colour** (the user's decision): the 3 x 3 mean at full resolution of the points layer's
  **input** under the point, the picture its shader compares every pixel with. Before, `sampleColor` read a 256 px copy
  of that input left by the last full-resolution `apply` (stale after any change below; nothing dropped it), or else
  `doc.flatten()`: the whole composite with the points' own effect and the layers above. Now one `flatten({ box, below:
  <points layer>, pad: 128 })`; `apply` no longer makes the copy. `below` is `drawLayersInto`'s new `upTo` (the loop, the
  filter chain's look-ahead and `drawComposite`'s filter test stop at that index), which match §4's statistics pass wants too
  (`sampleRegion(..., { upTo })`). The pad, measured on a 1600 x 1200 textured base with bright discs: the box read against a
  crop of the whole flatten (max level difference in the box; the 3 x 3 mean's difference in the points' colour space):

  | filter below | pad 0 | 8 | 16 | 32 | 64 | 128 | 256 |
  |---|---|---|---|---|---|---|---|
  | glow (40 px) | 5 | 5 | 5 | 4 | 1 | 0 | 0 |
  | halation (30 px) | 2 | 2 | 2 | 2 | 0 | 0 | 0 |
  | tonal contrast (40 px) | 7 | 10 | 11 | 9 | 1 | 1 | 1 |
  | structure (3 px), film b&w | 14, 7 | 0, 1 | 0, 0 | 0 | 0 | 0 | 0 |
  | Gaussian blur 4 / 64 px | 28 / 28 | 1 / 29 | 0 / 30 | 0 / 24 | 0 / 2 | 0 / 1 | 0 / 1 |
  | the film look (portra 400), a 300 x 200 box | 8 | 7 | 7 | 7 | 7 | 6 | 4 |

  128 px, where the blur-based film filters at their default radii meet the whole picture. The film look's own halation is
  sized from the long side of what a pass composites (1.2 % of it) and never matches the whole picture's in a box: at the
  centre of that picture 0 (no highlight near), 1 level with CineStill 800T, 2-8 on a 300 x 200 box. The grain field is
  anchored at the image's origin and reads 0 at every pad.
- **`sampleRegion(..., { pad })`**: the box composited with a margin (clamped to the image) and handed back as a CPU canvas of
  the box. **`readBox(box, { upTo })`**: the full flatten's pixels of the box: padded by `boxReach`, the sum of the visible filter
  layers' **`reach`** (a new optional field of a filter definition: a number or a function of the params, the image pixels a
  result pixel reads around it; plugins pass it through `filters.register`). Infinity, and so the whole flatten cut out
  (`compositeCanvas`, kept per composite version), when a filter declares none (normalise, vignette, frame, light leak, the look
  with halation, any plugin filter that does not say), a colour-matched layer is near the padded box, or a layer near it is
  drawn scaled, at a fractional position or through a pending transform. Measured on tiles against the whole flatten: a text
  layer (rendered at twice its size) 1 level at opacity 1 and 2 at 0.8 on its anti-aliased edge; a layer at a fractional
  position 13 levels on its last column and row; an unscaled layer at a whole position 0; the canvas backend 0-1. Declared:
  grain, levels, curves, brightness / contrast, hue / saturation, colour balance, black & white, invert, LUT, bleach bypass,
  cross processing, split toning and the sample's posterize 0; blur, sharpen, halation, glow, tonal contrast and structure
  `ceil(3 * radius) + 4`; film b&w 16; control points 16 with structure, else 0. With a blur in the stack the padded box comes
  out within 1-3 levels of the whole flatten (Skia's blur of a smaller canvas: sharpen 12 px 2-3 at any pad).
- **`Document`**: `flatten({ below, pad, exact })` (`exact` with a box: `readBox`); `selection()` reads the bounds
  (`sel.readRect` of the bounds, the W x H mask filled row by row: the contract unchanged), and `selection({ box: true })` hands
  back the bounds' mask alone. `flatten()`, `getPixels()` and `selection()` without options keep their contracts.
- **The sample plugin**: `mean_color` with a selection and *Selection to new layer* read `selection({ box: true })` and
  `flatten({ box: bounds, exact: true })`; `mean_color` without a selection stays the whole `getPixels()` (the user's decision,
  phase E). The probe tool reads one 256 px square per square the cursor enters (`exact`), kept until the document changes: not a
  flatten per change, not a pass per hover (a readback per pixel would count toward Chromium's acceleration latch).
- **The bucket's fine rounds** take `sel.toCanvas(box)` for their clip instead of `toCanvas()` of the whole selection per round;
  a whole-image flood keeps `toCanvas()` (the canvas backend's own canvas, no copy).
- **The filter cache key trap** (critic §2): `filteredCanvas` keyed a sampled pass on its size and origin only, so a full
  resolution box at the origin after the film panel's 192 px picture of the whole image (both 192 x 128 at 0, 0) got the
  panel's filter output. The key carries the pass's `w`, `h`, `sx`, `sy` now.
- **Not built, and why**: a box read for scaled layers (the 1-2 levels above; `exact` would not be exact), and a colour-matched
  layer's statistics for a box (slice 7). `mean_color` with the perf document's film look shown stays a whole flatten: its
  halation depends on the pass's size. The level choice for a scaled layer in a sampled pass at scale 1 was tried (level 0 for
  every layer, so a text layer draws like the flatten): it did not make the text layer exact on tiles and would have changed the
  eyedropper's and the flood's picture of downscaled layers against the canvas backend, so it was taken out again.
- **Gates** (both backends):
  - `film_test.py` `add_point_command`: counters on `flattenToCanvas` and on `Document.flatten` without options stay 0 and
    no display mirror is made (tiles); point 1's colour is the whole flatten below the points layer (`upTo`) within 1e-6; after a
    full-resolution flatten a paint layer under the points gets a red / green edge at x = 400 and point 2 on that edge takes the
    new colour; point 3 inside point 1's reach under a blue layer above the points layer takes the colour below both, and the
    step checks that the whole picture there differs.
  - `commands_test.py` `selection`: `mean_color` of a 100 x 50 mask equals the mean of the whole flatten's thresholded pixels
    exactly (pixels and rgb), no flatten, no mirror, every `sel.readRect` within the bounds (three reads of 100 x 50);
    `Document.selection()` and `selection({ box: true })` equal the thresholded whole selection byte for byte.
    `plugin_action_and_undo`: *Selection to new layer* clear of the text layer: no flatten, no mirror, the copy equals the whole
    flatten's masked pixels exactly; over the text layer: one flatten, the same exactness. `plugin_tool_and_panel`: 20 hovers
    over three squares clear of the text layer say the whole flatten's rgb, no flatten, at most three canvases read back, no
    mirror; the square with the text says the same through one flatten.
  - `editor_test.py` `wand_and_bucket_flood_a_region_not_the_image`: the bucket inside a selection that cuts the right blob
    (the box path, one round) reads its part of the selection (680,625 px, not 15,000,000) and fills inside, not outside.
    New `a_sampled_pass_keys_its_filter_output_on_its_box_and_scale`: a 192 x 128 box at full resolution after a 192 px pass of
    a 1200 x 800 picture with an invert filter layer equals the flatten (0 levels).
- **Mutations, each red** (tile mode, fresh instance, the source restored and compared):

  | mutation | red |
  |---|---|
  | the points' colour from `doc.flatten()` again | "placing a point flattened the picture: {flatten: 1, whole: 1}" |
  | the points' box one pixel to the right | "point 1's colour [0.3157, -0.0621, 0.1863] is not the picture below it [0.3153, -0.0630, 0.1867]" |
  | the points' box of the whole composite (no `below`) | "point 3 took [0.1465, -0.1073, 0.8339] with the points' own effect or the layer above in it" |
  | the bucket's rounds read the whole selection | "the bucket read the whole selection for a box: [15000000]" |
  | `mean_color`'s box one pixel to the right | "mean_color ... rgb [35,22,128] is not the whole flatten's ... [34,22,128]" |
  | `selection()` reads its bounds one column short | "mean_color {pixels: 4950} is not the whole flatten's {pixels: 5000}" |
  | the probe reads `getPixels()` | "the probe flattened the picture 3 times" |
  | the filter key without the pass's box and scale | "differs from the flatten by 255 levels on 59240 bytes: it took the other pass's filter output" |
  | the selection box readers read the whole picture too | "mean_color with a selection flattened the picture 1 times" |
- **Review fixes** (a review of (b3), (c1) and (c2) with two refuting verifiers per finding; commit 10def79, each fix with a counter-proof
  that is red when the fix is taken back, tile mode unless named):
  - The control points' shader and CPU path measured a point from the pass's own corner, so an exact box over a point (`mean_color`,
    *Selection to new layer*, the probe) came back without its effect (126 levels), and so did the screen at zoom in any region pass
    that does not start at the origin (both backends, since phase 1): both paths add `info.origin` (`u_origin`), so `reach` 0 / 16 holds.
    Gate: `film_test.py` `points_in_a_box_away_from_the_origin` (both backends) reads an exact box over a point at 1100, 800 against the
    whole flatten (0 levels, the point moves it by 126), `mean_color` of a selection there (exact), a pass at 0.5 over a region that does
    not start at the origin against the pass over the whole image (1 level), and the CPU path with an origin against the GPU path (1).
    Red: the shader without the origin ("an exact box over the point differs from the whole flatten by 126 levels"), the CPU path without it
    ("the CPU path over the point's region changed 0 levels").
  - A point's colour came from a box padded by a fixed 128 px whatever lies below, so under a filter whose picture depends on the whole image
    (a vignette 40 levels off near the corner, normalise up to 6, the look's halation up to 14) it was not the points layer's input.
    `sampleColor` reads `flatten({ box, below, exact: true })` now: padded by the declared reach, or cut out of the whole flatten below the
    points layer. Under the perf document's film look (its halation) the point add is that whole flatten again: 264 → 5063-5401 ms [5054-5396],
    as before (c1); without the filter layers 81-130 ms before and 109-143 after (a new row). Gate: the same step puts a vignette under the
    points and a point at 1500, 1120: its colour is the flatten below within 1e-6, where the 128 px box gives L 0.53 against 0.35. Red: the
    padded read back ("the point under a vignette took [0.5316, ...], the picture below the points layer is [0.3513, ...]").
  - `sampleRegion`'s `pad` was whole image pixels and the margin was drawn back at `Math.round((pb[0] - x0) * scale)`, so at a scale below 1
    `flatten({ box, maxSize, pad })` was the box moved by half a pixel of the canvas (88 levels at 0.5). The margin is whole pixels of the
    canvas handed back now, clamped to the image in whole pixels, and drawn back at whole pixels; at scale 1 it is the margin it was. Gate:
    `commands_test.py` `selection` (both backends): three boxes at 0.5, 0.37 and 0.3, one clamped at the corner, equal the unpadded box
    (0 levels). Red: the old margin ("differs from the unpadded box by 88 levels on 348 bytes").
  - A level-0 box read (a point add, the probe, a plugin's box, the wand's fine boxes) was a third level in a pixels object's two-level
    region LRU and pushed out the screen's level after the film panel's read, so the next frame rebuilt the screen's whole region per store.
    A read that is not for the screen now uses a display region at its level when that holds the range, and otherwise one region of its own
    (`"sample"`), never a display one. Measured at 4000 x 3000 at fit (screen level 1, a levels filter layer, 6 stores; screen, panel
    flatten, point add, screen, five times, two instances per tree): the point add 77-124 ms with 6 screen-level rebuilds (56-73 ms of them)
    → 16-20 ms and none. The wand at 15000 x 10000 no longer rebuilds the screen's level-3 regions either (4 of its 12 rebuilds before).
    Gate: `pixels_test.js` (8b): a sampled box at level 0 after two display reads leaves both display regions in place, has its own region,
    a sampled read inside the screen's region uses it, a write marks the sampled region's cell, `releaseDisplay` gives it back. Red: the
    shared slot back ("a sampled box at level 0 pushed out a display region: [3,0]").
  - `readBox`'s fallback kept its whole flatten in `flatCache` after the composite changed (572 MB of GPU canvas at 15000 x 10000 until the
    next whole flatten). The upload cache's version bump lets a `flatCache` of an older version go. Gate: `plugin_action_and_undo` (both
    backends): the flatten *Selection to new layer* over the text layer made is not held once the copy it added changed the composite. Red
    on both backends ("the whole flatten of the box read over the text is still kept after the composite changed").
  - The (b3) gate compared the box pass with a pass over the whole layer, which goes through `layerMatchedPart` as well, so a part matched or
    placed wrong moved both alike (a one-pixel shift of the part stayed green, and so did the whole editor and composite gates). The step
    now also compares the box at 1:1 with the screen at 1:1 on Canvas 2D, which draws the whole layer matched with the same statistics:
    0 levels on both backends. Red: the part one pixel lower ("differs from the screen at 1:1 by 207 levels on 636 bytes", 205 on canvases).
  - `CHANGELOG.md`: the point and sample plugin bullets say their numbers are tile mode's, and the point bullet says a filter that depends on
    the whole picture still flattens what is below, and that the point's effect stays in place when zoomed in.
  - `bucket in a 1000 px selection` read 270-348 [425-554] ms before and 346-593 [490-892] after in the perf runs. Traced (15000 x 10000,
    both trees in one script): the bucket builds the same 8 regions on both (L2 and L0 of 4 stores); a bucket right after a whole flatten
    and a change costs 612-671 ms on this tree against 241-281 without, and 793-1182 against 272-407 on the tree before (which also rebuilt
    the screen's L3 there). The row sits after the point add under the look, which is a whole flatten again; the bucket itself did not get
    slower. The second pair of perf runs and the traces ran while the user's own ComfyUI job held the card.

**(c2) The holes in region passes** (`inpaint_canvas.js`, `tools/editor_test.py`, `tools/perf_test.py`): region passes that still made
a display mirror, a `_masked` canvas or a Skia pyramid on tiles, one commit each.

- **Measured before** (15000 x 10000, tiles on, `perf_test.py`'s new "C6 (c2)" rows on 81210d1; each row from released display
  caches, "MB" the display mirrors of the pixels the row is about; the mask on Paint 3 and on the film look is its left half):

  | row | before |
  |---|---|
  | magic wand (an object) with a masked full-size layer, blocked [wall] | 1828 [2853], 1319 [2324], 1431 [2585] ms; 1144 MB and `_masked` |
  | pan at fit, 30 frames, the film look masked (Canvas 2D path), median [worst] | 3.1 [4.7] ms; 572 MB |
  | peek at fit, first frame | 558 ms; 572 MB |
  | peek at 1:1, first frame | 202 ms; 572 MB |
  | move drag of a full-size paint layer at fit, first frame [worst of the next 5] | 425 [11] ms; 572 MB |
  | eyedropper, Sample: the masked layer (first pick) | 1044 [1042] ms; 1144 MB and `_masked` |
  | magic wand inside a square of that layer, Sample: the layer | 192 [469] ms (the eyedropper's mirrors still there) |

- **(c2a) A masked tile layer, or a layer a live stroke runs on, outside the screen's stroke.** `drawLayer` sent every region pass
  through `layerRegionView`, the screen's scratch for a live stroke (`strokeView`, its signature, the gesture's dirty box). A pass
  whose size was not a whole number of pixels got null back and fell to `layerPixels`: the flood's coarse pass on a 3:2 picture
  (2048 x 1365.33 at 15k), a glb backdrop, a 1024 px screenshot: a `_masked` canvas, the layer's and the mask's mirrors and a
  pyramid of `_masked` per masked layer. A pass of a whole size took the scratch from the screen: a 192 px film panel flatten during
  a stroke resized it and the next frame rebuilt it whole, and two masked layers took it from each other every frame. **Built**:
  `drawLayerPass(ctx, layer, vp)` for every pass except the screen's live stroke: the layer's pixels, the stroke over them
  (`drawStrokeInto` with the pass's whole rectangle as its clip scratch), then the mask, or the mask with its stroke from a second
  scratch, destination-in, into a scratch of the pass target's size with the pass's transform (`passScratch`: kept up to
  `STROKE_SCRATCH_KEEP_PX`, a canvas of its own above it), drawn at identity with the layer's alpha and blend mode as `ctx` has them.
  A masked layer without a stroke on the screen is composed per frame now instead of from `strokeView`: the masked pan row 3.1 [4.7]
  → 3.8 [14.8] ms median [worst] at fit. **After**: the wand with the masked layer 322 [640] ms, no mirror, no `_masked`.
  - Gate: `live_stroke_preview_shows_what_the_commit_writes` (both backends): after the fourth dab of each of the six gestures a
    sampled pass of 115 x 76.8 px (not a whole size) leaves `strokeView`, its signature, `_strokeViewOf` and the dab box waiting
    for the next frame as they were, and on tiles makes no `_masked` and no mirror of the layer or its mask; the before / after
    commit comparison stays within 2 levels (measured 0-2 tiles, 0 canvas). For the masked gestures, after the commit, a 1:1 pass
    over the mask's edge and one where the mask has no tile equal the whole flatten byte for byte (0 on both backends).
  - Mutations, each red: every pass through `layerRegionView` again ("paint_clipped: a sampled pass made a display mirror of the
    layer or its mask"); the pass scratch is `strokeView` ("took the screen's stroke scratch: kept false, sig false"); the pass drops
    the gesture's dab box ("... dirty false"). A branch that cleared the scratch where `drawTilesInto` of the mask returned false
    stayed green under its mutation: `regionCanvas` is null only outside the mask's pixels, where the layer drew nothing either, so
    the branch was taken out.
- **(c2b) The active layer as the sample source** (`sampleRegion("layer")`: the eyedropper, the wand and the bucket with the tool
  bar's Sample set to the layer). It drew `displaySource(layerPixels(l, true))`: the layer's mirror, or `_masked` and the layer's
  and the mask's mirrors, and a Skia pyramid below half size. **Built**: on tiles, with no live stroke and a mask on the layer's
  grid (or none), the layer's region canvas at the pass's level (`drawPixelsInto`) and then the mask's, destination-in (the canvas
  holds this layer only). The canvas backend keeps its path. **Measured** on the same document, the masked Paint 3 active, released
  caches first: the eyedropper 1044 [1042] ms and 1144 MB plus `_masked` → 19 [12] ms and none; the wand inside one of the layer's
  squares 192 [469] ms (the eyedropper's mirrors still there) → 159 [332] ms and none.
  - Gate: `wand_and_bucket_flood_a_region_not_the_image` (both backends) paints two discs joined by a one-pixel line into its
    layer and masks the left half: the eyedropper picks the disc's colour inside the mask and reports "Transparent" outside it;
    the wand selects exactly the flood of the layer's masked pixels (784,704 px, 0 wrong: across the line to the mask's edge and
    no further); a 1900 x 700 box read at 1:1 equals the masked pixels within 2 levels (measured 1, the discs' anti-aliased edge
    through a premultiplied canvas); on tiles no mirror of the layer or its mask and no `_masked`.
  - Mutations, each red: the tile branch off ("the layer as the sample source made a display copy: px, mask, masked"); no
    destination-in ("the eyedropper on the masked layer: ... outsideStatus: Colour #20a040 picked").
- **(c2c) A filter layer's mask in a region pass.** `applyFilterLayer` masked the filter's output with `maskPx.drawTo`: on tiles the
  mask's display mirror (572 MB, synced per written tile) and a sub-rectangle draw of it per pass, on every screen frame with a
  masked filter layer (a filter layer puts the screen on Canvas 2D), the film panel, the eyedropper and the flood's passes. A mask
  stroke on the filter layer drew `maskWithStroke`: a full-size live preview filled from that mirror. **Built**: in a region pass
  with a tile mask, the mask's region canvas at the pass's level drawn with the transform from the pass's rectangle to the
  mask canvas; during a mask stroke on the layer, the mask and the stroke over it (`drawStrokeInto`, the filter layer's rectangle
  being the image) in a scratch of the pass's size (`_filterMaskView`), destination-in. The full-resolution pass (`vp` null: exports,
  runs) and the canvas backend keep `drawTo` / `maskWithStroke`. **After**: the masked filter pan row 3.8 [15.9] ms, no mirror of the
  mask (572 MB before, 3.1-3.8 ms median then too).
  - Gate: new `a_masked_filter_layer_reads_its_mask_from_tiles` (both backends): a 2400 x 1600 textured base, an invert filter layer
    masked to x < 1100, 1:1. The screen over the mask's edge equals the whole flatten (0 levels on both backends) and made no mirror
    of the mask; a sampled pass at 0.08 is the inverted plain pass left of the edge and the plain pass right of it (0 and 0
    levels) and made no mirror; eight erasing dabs on the mask: the screen before the commit is the screen after it (0 levels, the
    stroke changed 67,500 bytes by up to 191), and on tiles no `maskPreview` and no mirror during the gesture (the canvas backend
    still makes its preview, as before).
  - Mutations, each red: the tile branch off ("the screen made the filter mask's display mirror"); the mask's transform without the
    pass's x ("the screen with the masked filter layer differs from the flatten by 203 levels on 226800 bytes"); the stroke through
    `maskWithStroke` again ("made a full-size preview or the mask's mirror: maskPreview true, mirror true").
  - Review fix (10def79): `_filterMaskView` was never given back (`releaseCaches` did not list it, so Free VRAM and the background-tab
    memory watch left it for the tab's life), and `memoryReport` counted none of `_passView`, `_passMaskView`, `_filterMaskView`. Both lists
    have them now; the step checks after the stroke that the kept scratch is counted and that `releaseCaches({ deep, mirrors })` drops all
    three. Red: the release list without it ("releaseCaches kept the pass scratches [_filterMaskView]"), the count without them
    ("memoryReport does not count the pass scratches").
- **(c2d) A move, scale or smudge gesture in a region pass.** `drawLayer` skipped the tile branch for any gesture on the layer, so a
  transform-tool move or scale, a text layer's drag and a smudge drew `layerPixels`: the layer's mirror, and a GPU copy of it at 1:1
  or a Skia pyramid at fit, on the first frame of every drag after a write (the drag keeps the screen on Canvas 2D). **Built**: only
  a paint or mask stroke keeps a layer off its tiles (`painting`); `matched` still goes by `gesture` (a colour match waits for the end
  of any gesture, as before). A move at 1:1 rebuilds the region canvas when it leaves the one-tile margin, as a pan does; a scale
  changes the level. **After**: the move drag's first frame 425 [11] ms and 572 MB → 0.1 [0.2] ms (the CPU time of the frame; the
  draws of the region canvases are queued on the GPU) and no mirror. The smudge's own dab still reads the layer's mirror
  (`smudgeDab` → `target.drawTo`, 400-750 ms a move at 15k): its own step, `CLAUDE.md` item 5, not this one; the pending transform's
  mesh preview (`drawLayer`'s `pending` branch) keeps its mirror too (map S7: a gesture preview, measured first before it is built).
  - Gate: the display step (`pixel_backend_is_the_one_the_flag_chose`, both backends) drags a full-size paint layer 36 px in six
    frames at 0.2 on Canvas 2D (`compositorOff`, released caches first): on tiles no mirror and no pyramid of the layer, its region
    canvas drawn, and the drag's last frame is the frame after the pointer is let go (0 levels on both backends).
  - Mutation, red: the tile branch skipped for any gesture again ("a move drag made a display mirror or a pyramid of the tile layer:
    mirror true, pyramid true, regions 0").
- **(c2e) A layer's row thumbnail during a stroke on it.** `drawLayerFitted` drew a row whose layer a paint or mask stroke runs on from
  `layerPixels(layer, true)`: the full-size live preview (`strokePreview`, and `maskedPreview` / `maskPreview` for a masked layer),
  filled from the layer's display mirror and the mask's, up to four canvases of 572 MB at 15000 x 10000, for a picture of 40 px. It
  runs when a row is drawn during the gesture: the layer's chains landing (`redrawThumbsOf`) within a second of a whole change, or a
  run's result arriving (`renderLayers`, `renderHistory`). **Built** (map S4, option a): on tiles the row comes from the layer's
  thumbnail during a stroke too, the mask's thumbnail destination-in. **What the user loses**: a row drawn during the gesture shows the
  layer as it was before the stroke, not the stroke in progress. Nothing after the commit changes: the commit redraws no row, so the
  row showed the pre-stroke picture there as well until the list is drawn again. The canvas backend keeps its path (the live
  previews are its display canvases). Option b, the stroke composed into the row at the thumbnail's level, was not built: it reads the
  stroke store with `screen` asks whose landings rebuild the screen's scratch, for a 40 px picture of a stroke that is on the screen.
  - Gate: `live_stroke_preview_shows_what_the_commit_writes`, after the fourth dab of each gesture `renderLayers()`: on tiles the row
    was drawn from the layer's `thumbnailCanvas` (1 call), with no `strokePreview`, `maskedPreview` or `maskPreview` and no mirror of
    the layer or its mask (the canvas backend: 0 thumbnail calls and its previews, as before).
  - Mutation, red: the live branch back ("paint_clipped: the layer's row drawn during the stroke did not come from its thumbnail:
    thumbs 0, previews [true, false, false]").
- **(c2f) The peek as a base-only region pass.** `drawSceneImage` drew the whole base through `displaySource(basePx, scale, true)`
  while peeking: the base's display mirror plus a GPU copy of it at 0.5 and up, or plus a Skia pyramid built one level per frame
  below (`glCompositeUsable` refused the peek, so the whole image went through Canvas 2D). **Built**: on tiles the peek is
  `drawViewComposite(ctx, { baseOnly: true })`: the GPU compositor with the base's spec alone (`glCompositeUsable` takes a base-only
  pass whatever the layers are), or the Canvas 2D region pass with `drawLayersInto`'s layer loop skipped. It is a screen pass, so a
  base whose chains are in the worker shows its stale or coarse picture until they land, and `watchChains` draws again. The canvas
  backend keeps its peek. **After**: the first frame of a peek at fit 558 ms → 60 ms, at 1:1 202 → 18 ms, and no mirror (572 MB
  before). The picture on tiles is now the normal view's picture of the base: the old peek at fit came from Skia's pyramid and was up
  to 61-62 levels from the view's mips on this step's textured base (the canvas backend's peek still is, measured and reported).
  - Gate: new `peek_shows_the_base_from_its_tiles` (both backends, the GPU path and Canvas 2D): a 3000 x 2000 textured base under an
    opaque magenta paint layer, at fit, released caches first. Without the peek the screen at the layer's centre is magenta, with it
    the base's colour; on tiles the peek equals the normal view with the layer hidden (0 levels on both paths) and made no mirror and
    no pyramid of the base. Right after a new base (`setBaseFromCanvas`, layers kept) on Canvas 2D the peek's frame built no chain
    itself (0; the new base's frame had asked for them already).
  - Mutations, each red: the old `displaySource` draw ("gpu: the peek differs from the view with every layer hidden by 61 levels on
    709781 bytes", before the mirror check); the layers drawn in the peek ("gpu: the peek still shows the layer: 255,0,255").
- **Runs** on the last of these commits (fresh instances, strict): `--tiles on` (`c6c1-tiles`) and `--tiles off` (`c6c1-canvas`) with
  `pixels editor composite commands shape brush film glb ailabel size transparent generate log mcp nodecopy` ALL PASS, `--copy --tiles
  off pixels editor composite commands` (`c6c1-copy`) ALL PASS, `perf:15000x10000` (`c6c1-perf`) PASS, each on the first try; the
  ComfyUI queue empty before and after. The (c2) rows there: the wand with the masked layer 347 [694] ms, the eyedropper with Sample
  set to it 15 [10], the wand inside its square 276 [473], the masked pan 4.0 [11.1], peek 60 at fit and 20 at 1:1, the move drag's
  first frame 0.3 ms, no mirror in any of them; the benchmark's footer holds 1 display mirror of 16 MB (the colour-matched result's)
  and 5.3 MB of pyramids, against 2 mirrors of 588 MB and 193 MB before (c2). Between the slices, `c6c1a-canvas` failed editor's
  `closed_tabs_are_collected` (the last of four closed tabs alive after the collection) and `commands_test.py` on the known hang
  after every step printed `[ok]`, and `c6c1a-canvas2` (editor, commands) the same two; `c6c1a-canvas3` (editor) and `-canvas4`
  (commands) passed with no change in between, and the full editor test on the canvas backend passed on bc3814d and on (c1) alike.
- **Runs after the review fixes** (10def79, fresh instances, strict, each on the first try): `c6c1-final-tiles` and `c6c1-final-canvas`
  with the same fifteen gates ALL PASS, `c6c1-final-copy` ALL PASS, `c6c1-final-perf` PASS with the ComfyUI queue empty before and after.
  Its rows against `c6c1-perf`: the point add under the look 264 → 5401 ms (the whole flatten below, above), without the filter layers
  114; `mean_color` with the look 4339 → 4303, plain 197 → 62; the bucket in a selection 270 [425] → 480 [852] (above); the (c2) rows
  unchanged within noise (the wand with the masked layer 338 [538], the eyedropper 34 [6], the wand in its square 138 [327], the masked pan
  3.9 [11.3], peek 50 at fit and 17 at 1:1, the move's first frame 0.2 ms, no mirror); the footer the same (1 mirror of 16 MB, 5 region
  canvases of 46.1 MB, 5.3 MB of pyramids). Two more pairs of perf runs on the tree before and this one, alternating: see the review fixes
  under (c1).

#### C6 (c3) and slice 4 as built (2026-09-16): a read that has the worker build its levels

Slice 3 of `dist/c6map/c/critic.md` §5 ("a one-shot exact reader in `inpaint_tiles.js`") and slice 4 ("async readers on
slice 3"), built together because slice 3 alone moves no row: nothing in the tree would have called it.

**What it was.** `sampleRegion` at a level — the film looks panel's 192 px thumbnails, the GLB dialog's backdrop, the
magic wand's coarse pass — runs `drawTilesInto` with `display` false, and `_levelBytes` then builds every missing mip
chain with `plainChain` **on the main thread** and keeps it on the tile. Measured on a synthetic 15000 x 10000 document
(three stores: the base and two full-size paint layers), each row right after a flip of one paint layer, so that layer's
tiles have no chain:

| read | in one task | chains built here | chains left on the tiles |
|---|---|---|---|
| `flatten({ maxSize: 192 })`, level 5 | 509.7 ms | 2,088 | +185.5 MB |
| `flatten({ maxSize: 1024 })`, level 3 | 611.6 ms | 2,360 | +221 MB |
| `sampleRegion` at 256 px | 463.6 ms | 2,360 | +221 MB |
| `readBox` 1000 x 1000 at level 0 (the control) | 62.6 ms | 0 | 0 |

After the four rows the document held **669 MB** of chains that nothing on the screen wanted.

**What was built.**
- `TilePixels.primeRegion(rect, level)` asks the scheduler for the chains of the **interior** tiles of the range, with
  `screen` false (the landing must not move `chainEpoch` or drop the screen's view caches) and `keep` false (the chain is
  handed over and dropped). `request(store, key, t, vw, vh, screen, keep)` took `keep` as a parameter for this; it was a
  field derived from `screen` before.
- Each landing reaches the job through `_chainLanded`, which slices **only the level the read wants** out of the handed
  chain into a cell: 256 bytes a tile at level 5 against 87 KB for the chain. `_levelBytes` reads those cells, for
  **exact reads only** — a display read has to take the same decision `_stampAt` takes, or the atlas would build a slot
  from a cell under a stamp that reads stale at the very next frame (a counter-proof covers it).
- **The edge tiles are left out on purpose.** Their chain is the clamp-extended `edgeChain`, and `_land` never hands the
  worker's `exts` over (it installs them or drops them). There are 98 of them against 2,262 interior tiles at 15k, about
  13 ms, and leaving them on the old path is what makes the primed read byte-identical to the read before it.
- `_primed` is a **Set** of jobs, not one slot: a second read (the film panel's while the GLB backdrop is on its way)
  must not take the first one's landings away and leave it waiting. A job also settles on `sch.settled()`, because a
  landing whose tile the store has replaced since is dropped by `_notify` and would otherwise never reach it.
- `PRIME_CELL_BUDGET` is 48 MB of cells: 579 KB for a whole 15k layer at level 5, 9.3 MB at level 3, but 148 MB at
  level 1, where the picture asked for is a 7500 x 5000 canvas of its own anyway. Over the budget the read builds its
  chains itself, as before.
- Editor side: `passStores(source, box, scale, opts)` (the stores a pass reads, with the level and rectangle each is read
  at), `primePass`, and `sampleRegionSettled`, which primes, awaits and then runs the ordinary `sampleRegion`.
- Plugin side: `Document.flatten({ settled: true })` returns a promise (`docs/PLUGINS.md`, "A picture that does not
  freeze the window"). The film looks panel's `render()` is async and holds its `busy` flag across the await; the GLB
  dialog opens at once and fills its backdrop when it arrives; `floodRegion`'s coarse pass awaits.

**After**, same document, same method:

| read | held the main thread | wall clock | chains left |
|---|---|---|---|
| `flatten({ maxSize: 1024 })`, level 3 | **46.6 ms** (was 700.6) | 1193 ms | **+32.7 MB** (was 221) |
| the flood's coarse pass at 256 px | **95.2 ms** (was 621.3) | 1217 ms | **+32.7 MB** (was 221) |

The trade is explicit: the window keeps repainting, and the picture arrives about half a second later.

**The picture is the same picture.** Against a full-resolution `flattenToCanvas` scaled down, in one state, at
2048 x 1152 and at 15000 x 10000 and at levels 3 and 5: `settled` and `sampleRegion` differ by **0 bytes**, and both are
the same 2 to 73 levels from the scaled flatten (the mip chain against Skia's downscale, which is older than this step).

**Gates.** `pixels_test.js` `tiles_primed_exact_read_builds_no_chain_here` (levels 3 and 5 on a 1100 x 900 store with a
fake transport: 12 interior tiles asked for, 12 cells, byte-equal to the exact read, 8 edge chains built here, no chain
kept on an interior tile, `chainEpoch` unmoved, the cells released; plus a tile that owns a stale buffer, a write after
the landing, the atlas's stamp, no transport, level 0). `editor_test.py`
`a_settled_read_builds_its_levels_in_the_worker_not_here` (a 3000 x 2000 document: the same picture byte for byte, 6
chains built here against 76 primed, no mirror, no cells left, and the plugin API's promise).

**Six mutations, each red** (and this is where a trap sits: **the renderer caches the ES module it imported at start**,
so a mutation only reaches a gate through a *fresh instance*. The first round patched the file with the app running and
all five mutations came out green, which proved nothing):
- the prime asks with `screen = true` → "the prime moved chainEpoch";
- the prime keeps the chains → "0 cells, expected 12";
- the cell is cut out one level off → the typed-array length;
- the edge tiles are primed too → "20 tiles asked for, expected the 12 interior ones";
- the cell's version is not checked against the tile's → a write after the landing is not seen;
- the primed cells are visible to a display read → "a display read and the atlas disagree: 1219 against -1219.5".

**What this does not do.** The whole-flatten readers (`promptContextCanvas`, `screenshot`, the helper inputs, exports and
runs) are slices 5 and 6 and phase E; the colour-match work is slice 7. A read at level 0 primes nothing, because it
reads no chain: `readBox`'s 62.6 ms at 15k is composition, not levels.

#### C6 (c) slice 5 as built (2026-09-16): the prompt context and `screenshot` read levels

Slice 5 of `dist/c6map/c/critic.md` §5.

**What it was.** Two readers made a whole-picture composite at full resolution for a picture of at most 1024 px:
- `promptContextCanvas()`, the picture a language model is shown for upsampling (and for "select by text" with a term
  taken from the prompt): `flattenToCanvas({ forRun: true })`, the crop drawn down, and the selection drawn up to ten
  times through `sel.drawTo`, which on tiles is the selection's display mirror;
- the `screenshot` command, which the MCP instructions tell an agent to call after most changes: the same flatten, a
  layer through `px.drawTo` (its mirror) and the tint through `sel.drawTo`.

**What was built.**
- `promptContextCanvas()` is **async** now (its three callers already were: `host.upsampleInApp`, `upsamplePrompt`,
  `segmentByText`). On tiles the picture is `sampleRegionSettled("image", crop, scale, { forRun: true })`, so the
  chains come from the worker as in slices 3 and 4, and the selection is one exact read of its own tiles
  (`selectionCanvasSettled`), drawn nine times for the ring instead of nine scaled draws of the mirror. On canvases
  the old body runs unchanged.
- `drawSelectionInto(ctx, scale, region, display = true)`: `display` false reads exact levels. The screen's callers
  keep `true`; a picture that is not the screen must not show coarse cells or ask for screen chains.
- `selectionCanvasSettled(box, scale, w, h)` in the editor: the selection over a box at a scale as a canvas whose alpha
  is the mask, primed through `sel.primeRegion`, null on the canvas backend.
- `screenshot` is `shotCanvas(ed, a)` (exported from `renderer/commands.js` for the gate) plus the layer outlines and
  the JPEG. On tiles: the image through `sampleRegionSettled`, a layer through `primeRegion` and `drawTilesInto` (still
  unmasked, as before), the tint through `selectionCanvasSettled`. The node's own hand-kept `screenshot` in
  `js/inpaint_bridge.js` is not touched (the node runs tiles off).

**Measured**, `perf_test.py 15000x10000`, tiles on, new rows, the renderer files of 01cc8d0 against this step in the same
session (each row starts from released mirrors; [MB] is what the row itself made):

| row | before: blocked [wall], MB | after: blocked [wall], MB |
|---|---|---|
| `screenshot` 1024 (MCP) | 2122 [2120], 1717 MB | **286 [449], 0 MB** |
| prompt context, no selection | 1887 [1816], 1733 MB | **68-485 [68-446], 16 MB** |
| prompt context, 1000 px selection | 1985 [1983], 1717 MB | **94-724 [94-665], 16 MB** |

The after rows swing between runs (two runs given); the op rows have always done that on the shared card. The 16 MB
that is left is the colour-matched result's display mirror (a 2048 x 2048 layer), found by listing the owners of every
mirror before and after the row: that is `layerMatchedPixels`, slice 7b's. The screenshot row reads 0 only because an
earlier row had already made that mirror.

**The picture.** On canvases both readers are **byte-identical** to the old code (the gates compare against a copy of
the old body in the same instance). On tiles the picture is box-filtered levels instead of a bilinear draw of the whole
flatten: on a smooth 3000 x 2000 document the mean difference is 0.19 levels at 1024 px, and 0.4 % of the bytes differ
by more than 4 levels (edges, which the old draw stair-stepped); at 256 px about 2 %.

**Gates.** `editor_test.py` `prompt_context_reads_levels_not_a_flatten` (four cases: no selection, an ellipse ring and
the green fill over a crop above 1024 px, a small ring; no flatten, no mirror, no cells left, the ring's and the fill's
pixel count within 15 % of the old picture, the multiply layer in the picture) and `commands_test.py`
`screenshot_reads_levels` (image at 1024 and 256, editor, a layer at 300 and at scale 1; no flatten, no mirror, no
cells left, the layer's block in the picture, scale 1 within 1 level). Runs: `s5-tiles2` and `s5-canvas` (commands,
editor) ALL PASS; `s5-tiles` failed once on the screenshot tolerance (2.1 % of the bytes over 4 levels at 256 px against
a 2 % bound; the bound is 5 % and a mean of 2 levels now) and on `closed_tabs_are_collected`, which passed on the re-run
and touches none of this code.

The other gates: (fresh instances, own profiles, strict): `s5-tiles2` and `s5-canvas` (commands editor) ALL PASS;
`s5-all-tiles` (pixels composite shape brush film glb ailabel size transparent generate log llm toapis nodecopy) and
`s5-all-canvas` (pixels composite film glb llm) PASS; `mcp` failed on both only because `tools/mcp_test.py` looked for
`test_base.png` in `%APPDATA%/Scumble` whatever `--user-data-dir` said, and that file is no longer in the user's own
profile. It reads the image from the profile it is given now; `s5-mcp-tiles` and `s5-mcp-canvas` PASS.

**Five mutations, each red** (each against a fresh instance):
- the prompt context's tile branch off → "the prompt context flattened the picture 1 times";
- `selectionCanvasSettled` returns null → "the screenshot made 1 display mirrors" and the same in the prompt step;
- the layer screenshot through `px.drawTo` → "layer 300: the screenshot made 1 display mirrors";
- the ring's offsets dropped → "369 magenta pixels against the old picture's 7398";
- the screenshot's image through the flatten → "the screenshot flattened the picture 1 times".

**Not gated:** a read with `display` true where false is meant. On a document whose selection chains are all present
it reads the same bytes, and a gate that catches it needs the selection's chains to be missing while the screen does
not draw; the screen draws on its own frames during the awaits, so such a check would be a flake.

#### C6 (c) slice 6 as built (2026-09-16): the helper models' inputs read levels and upload nothing

Slice 6 of `dist/c6map/c/critic.md` §5, after `dist/c6map/c/objects.md` §2 to §5.

**What it was.** The in-app helper models look at a 1024 x 1024 squash, and every one of their inputs was made at full
resolution first:
- the object map (the object tool, O): `ensureObjects` awaited `segmentSource()` before it knew SAM2 runs in-app, which
  flattened the picture, encoded it as a PNG in the worker and uploaded it through the local mirror, **only for its hash**
  (the in-app path threw the upload's `ref` away). Then `host.findObjects` flattened it again (`sourceCanvas`) for the
  model input. In "active layer" mode both were a whole-layer copy on a grey canvas as large as the image;
- the point prompt's re-encode (`segmentPoint`, when the embedding is gone) made the same input again;
- the cutout (`cutoutInApp`) read `layer.px.toCanvas()`, a whole-layer copy on tiles.

**What was built** (the app host only; the node's host has no in-app models and is unchanged):
- `host.objectInput(editor, layer)`: on tiles the image is **one uniform region pass** at `max(1024 / W, 1024 / H)`
  through `sampleRegionSettled` (so no axis is scaled up, and filters and colour-match statistics see an unsquashed
  picture), then the squash. A layer is drawn with its mask from its own tiles at the same level, into a scratch, over
  grey; a filter layer, a layer under a live stroke or a mask off the tile grid keep the old path. On canvases the old
  input, byte for byte.
- `host.cutoutInput(editor, layer)`: the layer's own pixels (no mask) from its levels at the larger of the two squash
  scales, squashed onto black; `toCanvas()` on canvases, as before.
- `host.inputHash(image)`: SHA-1 of the 4 MB input. The map is keyed `image:<hash>` or `layer:<id>:<hash>`, and so is the
  SAM2 embedding in the main process: equal inputs share both, a visibility round trip or an undo back to the same
  picture runs nothing.
- `ensureObjects` takes the in-app branch **before** `segmentSource`, so nothing is flattened, encoded or uploaded there;
  `uploaded.baseRef` (which a ComfyUI run reuses) is not touched. The ComfyUI path keeps `segmentSource` and its upload,
  because there the upload is the model's input.
- **The hover's staleness test.** It re-checked the map while `uploaded.baseHash` was null, which only the upload used to
  set; without the upload every pointer move would have read and hashed the input. An in-app map now carries the
  `compositeVersion` it was checked at (`objects.version`, also on the "same hash" early return), and the hover compares
  that. Every `baseHash = null` bumps `compositeVersion` (`UploadCache`), so the stamp sees every change the old test saw.
- `host.helperCall(name, args)`: the three IPC calls go through one member, so a gate can stand in for the model.

**Measured**, `perf_test.py 15000x10000`, tiles on, the new reader and the old one in the same run (`s6-perf`):

| row | blocked [wall] | mirrors made |
|---|---|---|
| object map input, from levels | **174 ms** [174] | 16 MB |
| the same the old way (one flatten) | 1955 ms [1955] | 1733 MB |
| cutout input of a full-size paint layer, from levels | **38 ms** [38] | 0 |
| the same the old way (`toCanvas`) | 571 ms [571] | 0 |

The old object path did the flatten **twice** plus a PNG encode and an upload of the whole picture; the row shows one of
them. The 16 MB is the colour-matched result's mirror, as in slice 5 (slice 7b).

**The picture.** On canvases the three inputs are byte-identical to the old ones. On tiles, against the old input on the
8000 x 5000 gate document: the image mean 0.20 levels (1,643 of 4 M bytes over 24), the masked layer on grey 0.02, the
cutout at most 1 level. The SAM2 answer may move by a few objects on real photos; nothing gates on object ids.

**Not in this step, measured in the gate:** in "active layer" mode `applySegmentIds` clips the answer with `layerAlpha`,
a full-resolution read of the layer that still makes its mirror and its mask's (two mirrors on the gate document) —
`objects.md` §9 "bigger change C". The label map at image size (`Uint16Array(W*H)`, 286 MB at 15k), the hover shapes
(`objectShape`, a W x H canvas per hovered object) and the point prompt's W x H mask are bigger changes A and B; they are
the object tool's largest costs and are still there.

**Gate.** `editor_test.py` `helper_inputs_read_levels_and_upload_nothing`, both backends, the model a stand-in through
`host.helperCall`: an 8000 x 5000 document (level 2) with a paint layer that is half transparent and a masked layer.
- image source: one model call, the key the map's hash, no upload, `baseRef` untouched, no flatten, no whole-layer copy
  and no mirror at the moment the input reaches the model (on canvases: exactly the one flatten it always was);
- nothing changed, and a visibility round trip: no second model call, the map stamped with the composite version;
- 20 hovers read nothing; after a write the next hovers read once and run the model once, with a new hash;
- the point prompt's re-encode (the embedding thrown away) sends the map's own input, byte for byte, under its key;
- the layer source: its map keyed on the layer, no copy or mirror while reading, no primed cells held;
- the cutout: no `toCanvas`, the transparent half black;
- each input against the old one: identical on canvases, mean at most 2 levels and at most 1 % of the bytes over 24 on
  tiles.

Runs: `s6-tiles` (editor) PASS; `s6-canvas` failed only `closed_tabs_are_collected` (two of the four closed tabs still
alive, a 223 s run; the same pattern once in slice 5 on tiles), `s6-canvas2` (editor commands) ALL PASS.
`s6-all-tiles` (commands pixels composite shape brush film glb ailabel size transparent generate log mcp llm toapis
nodecopy) and `s6-all-canvas` (commands pixels composite film glb mcp) ALL PASS.

**Seven mutations, each red** (each against a fresh instance):
- the object input's tile branch off → "the object input flattened or copied a whole layer: flatten 1, mirrors 4";
- `ensureObjects` back through `segmentSource` first → "0 object runs, expected 1";
- no version stamp → "hovers after a write read the input 2 times, expected 1";
- the hash from `compositeVersion` instead of the input → "an unchanged picture ran the model again";
- the layer source through `sourceCanvas` → "the layer source copied or mirrored: mirrors 2 (masked, mask)";
- the cutout input through `toCanvas` → "the cutout input copied the whole layer";
- the re-encode from the old reader → "the re-encode's input is not the map's: max 48".

**Not run:** a real SAM2 or RMBG model on this code. The gate profile has no model files, and the IPC shape is unchanged
(the same 1024 x 1024 RGBA bytes and key format); `smoke_test.py` without `--no-helpers` with a linked model folder is
the check if one is wanted.

#### C6 (c) slice 7a as built (2026-09-16): sampled passes share one colour-match statistics entry

The first step of slice 7 of `dist/c6map/c/critic.md` §5 ("7a the null-stats bug"), after `dist/c6map/c/match.md` §1
and the race (b3) reproduced and left here.

**The bug, reproduced red first on both backends** (`editor_test.py` `sampled_passes_share_the_colour_match_statistics`
against the unchanged code): a sampled pass (`sampleRegion`: the eyedropper, the wand's and the bucket's passes, a
plugin's flatten, the film panel) took the screen's statistics when they were there and otherwise computed its own from
**its own region** into `_mstatsSample`. A 1 x 1 eyedropper pass that came first after a drop holds no ring: it stored
null, and every sampled pass after it drew the matched layer **unmatched** until the composite changed. On a 3000 x 2000
document with a red layer matched to a grey surrounding, a 512 px picture after an eyedropper click was **102 levels off
on 95,172 bytes** against the same picture alone, and the eyedropper itself picked the unmatched red (200, 60, 60) where
the matched flatten has grey (106, 106, 112). (A first run read the same red for another reason: a step before had left
the tool bar's *Sample* on the layer, which reads the layer unmatched on purpose; the step sets it to the image now.)

**What was built** (`renderer/editor/inpaint_canvas.js`):
- `sampledMatchStats(layer, forRun)`: one entry per layer per change (`_mstatsSample`, and `_mstatsSampleRun` for a
  pass with `forRun`, whose backdrop leaves control and reference layers out), taken from the layer's **whole padded
  surroundings** at 256 px, whatever pass asks first. The layer is drawn from its own pixels at that scale (from its
  tiles with its mask, or its canvas), the backdrop is a sampled pass of its own over the padded box of the layers below
  it (`upTo`). Both read exact levels.
- `matchStats` hands every sampled pass (`vp.sample`) to it; the screen and the full-resolution flatten keep their own
  statistics (`_mstatsView`, `_mstats`), so the screen and exports do not change in this step.
- `statsOfMatch(layer, lay, ld, bd, pad)`: the loop over the layer and its ring, split out of `matchStats` so both use it.
- `sampleRegion` puts `forRun` on its pass.
- A chain landing no longer drops the sampled statistics (`dropStaleViewCaches`): they read exact levels, which a
  landing does not change. Every other reset lists `_mstatsSampleRun` beside `_mstatsSample`, and `bumpComposite`
  forwards it like the other slots.

**After:** the same document reads 0 bytes of difference between the 512 px picture after an eyedropper click and alone,
the eyedropper picks the matched grey, the wand with the statistics dropped between its coarse and its fine pass selects
the same region as without, and after a paint layer below is painted dark over part of the ring the eyedropper follows
the matched flatten again (61, 65, 76).

**What moved:** `a_sampled_pass_matches_only_the_part_of_a_matched_layer_it_shows` compares a sampled pass with the
screen at 1:1, which still takes its statistics from the view: 3-4 levels on 49-588 bytes now (0-2 before). Its bound is
6 until slice 7c puts the screen on the same entry and the bound back to 2; the (b3) mutation it guards (a part matched
or placed wrong) is 148 levels. `perf_test.py 15000x10000` before and after in the same session: every row within the
runs' noise (wand 1767 / 2013 and 821 / 687 ms, bucket 618 / 585, `sample.mean_color` 1258 / 1380, film point add
1832 / 1708, colour match tick 9.0 / 8.7).

**Gate.** `sampled_passes_share_the_colour_match_statistics`, both backends: (i) the eyedropper first after a drop,
then a 512 px picture; (ii) the same picture first after a drop, byte for byte; the eyedropper's colour within 12 levels
of the matched flatten and not the unmatched colour; (iii) the wand with a drop between its passes selects the same
bounds; (iv) after a paint layer below is painted over part of the surroundings (the version moves, the layer's slots
stay), the eyedropper follows the flatten again. Runs: `s7a-fix2-on` / `-off`, `s7a-fix3`, `s7a-fix3-canvas`,
`s7a-fix4` (editor) PASS; `s7a-all-tiles` (editor commands pixels composite shape brush film glb ailabel size transparent
generate log mcp llm toapis nodecopy) and `s7a-all-canvas` (editor commands pixels composite film glb mcp) ALL PASS.

**Three mutations, each red** (fresh instances):
- sampled passes back to statistics from their own region → "a 512 px picture after an eyedropper click differs from the
  same picture alone by 102 levels on 95172 bytes";
- the shared entry without its padding (no ring in its backdrop) → the (b3) step, "18 levels on 179853 bytes";
- the entry never recomputed (the version not checked) → "after a change below the layer the eyedropper's colour is far
  from the matched flatten's: picked 106,106,112, flatten 61,65,76". A first version of (iv) moved the layer with
  `set_layer x`, which clears the layer's slots itself, and this mutation stayed green; the paint below is the path that
  does not.

**Not gated:** the `forRun` split (no control or reference layer in the gate document) and the backdrop's `upTo` (a
layer's own pixels in its backdrop change only the "underneath" source, which the gate does not use).

**Seen once, not reproduced:** `helper_inputs_read_levels_and_upload_nothing` (slice 6) failed "primed cells were left
behind" in one run on the tree with the unfinished 7a step (`s7a-red2`); two runs right after and every run since
passed.

**Left for 7b to 7d:** the screen's statistics (`_mstatsView`) still come from the view and the screen, the navigator and
sampled passes can disagree by a few levels (7c, the user's decision (a)); the matched layer's pixels in a region pass
still come from its display mirror and a Skia pyramid (7b); the match on the GPU path is a canvas per miss (7d).

#### C6 (c) slice 7b as built (2026-09-16): a colour-matched layer is matched from its tiles

The second step of slice 7 of `dist/c6map/c/critic.md` §5, after `dist/c6map/c/match.md` §3 (GPU option A: the matched
region as a canvas source; option B, uniforms in the atlas shader, is 7d).

**Before.** A colour-matched layer in any region pass (the screen on the GPU stack and on Canvas 2D, the navigator, every
sampled pass) was matched on its whole display mirror (`layerMatchedPixels`), or on the Skia pyramid level of it the pass
drew, and a masked one on `_masked` and two more mirrors. On the 15000 x 10000 benchmark with its full-size masked paint
layer matched: **1144 MB** of mirrors and `_masked` for every row below, a first frame at 1:1 of **837 ms**, a pan over it
at 1:1 of 53 ms a frame (109 worst), and the document's display pyramids 196 MB.

**What was built** (`renderer/editor/inpaint_canvas.js`, `inpaint_compositor.js`):
- `matchFromTiles(layer)`: the layer on tiles, its mask (if any) on the same grid.
- `matchedRegionView(layer, vp, below)`: the statistics first (a miss may run a pass of its own, which takes region
  canvases and scratches), then the layer's region canvas at the pass's level, masked by the mask's region canvas
  (`destination-in`, drawn at its own origin: it is kept while the range stays inside it) in a pass scratch, and
  `matchCanvas` on that. Returns `{ canvas, sw, sh, x, y, w, h }` (`sw`, `sh` fractional at the layer's last row and column:
  the canvas holds whole tiles and the clamp past the edge), `{ plain: true }` without statistics, or null. Kept in
  `_mcacheView` (screen, navigator) or `_mcacheSample` under the region canvases' origin and size, the level, the pixel and
  mask versions and `chainEpoch`s, and the statistics object itself: a pan inside the tile of margin reuses the match.
- `drawLayer` takes it for every region pass on tiles (a plain result draws through `drawTilesInto`, or `drawLayerPass`
  with a mask); `layerMatchedPart` (b3) stays for the canvas backend.
- `glViewComposite` hands it over as a canvas source with `cropW` / `cropH`. The compositor's quad shader has `u_uvMax`,
  and a source's quad ends at the crop (`composite()`, also for a window of a large source).
- `matchStats`' screen branch reads the layer's side at 256 px from its tiles and mask at display levels
  (`matchLayerPicture`, shared with `sampledMatchStats`, which reads exact levels), not from the pass's pyramid level.
- `dropStaleViewCaches` drops the lowest landed layer's own `_mstatsView` / `_mcacheView` too when it is matched: they are
  read from its own display levels now.
- `passStores` primes a matched layer on tiles like any other.
- The canvas backend is unchanged (`composite_test.py`'s view identical to its reference).

**After** (`perf_test.py 15000x10000`, tiles, same session, A/B by stashing the renderer; the second "after" run in
brackets where the first one read high):

| row | before | after |
|---|---|---|
| matched masked layer, fit: first frame [settled] | 43.2 [4.0] ms | 14.4 [0.3] (18.0 [0.2]) |
| the same at 1:1: first frame [settled] | 837.0 [2.2] | 126.8 [0.7] |
| pan at 1:1 over it, median [worst] | 53.1 [109.1] | 3.4 [32.1] |
| eyedropper over it | 29.5 | 91.0 (33.4) |
| magic wand over it, blocked [wall] | 311 [1141] | 352 [589] (293 [497]) |
| mirrors and `_masked` each of those rows made | 1144 MB | 0 |
| footer: display pyramids | 196 MB | 0 |
| footer: source textures of the compositor | 32.3 MB | 0.3 |
| first frame fit -> 1:1, GPU | 18.0 | 1.4 |
| prompt context / object map input, mirrors made | 16 MB | 0 |

The 16 MB the slice 5 and 6 rows still showed was the benchmark's matched result's mirror; it is gone. The footer's two
mirrors after the run (1144 MB) are the "the same the old way" rows' own. Every other row within the runs' noise ("undo
of that fill" read 49 / 284 / 59 ms over three runs).

**What moved:**
- On tiles the screen's statistics read the layer exactly where the pass drew a smaller pyramid level: `composite_test.py`'s
  stored view differs by 3 levels on the matched 260 x 180 layer, and only there (0 before 7b, A/B). The view step allows 3
  on tiles, with the reason; slice 7c moves the screen's statistics again.
- `a_sampled_pass_matches_only_the_part_of_a_matched_layer_it_shows`: the screen against a sampled pass at 1:1 reads 6
  levels on 1314 bytes on tiles (3-4 on 49-588 before); its bound is 8 until 7c. The size bound on the matched part does
  not apply on tiles (the part is a region canvas, which a read that holds the range reuses whatever its size).
- Against the old path the screen differs by up to 10 levels on 8 to 10 bytes zoomed out and up to 20 on about 500 bytes
  at 1:1 on a layer drawn scaled (tile mips against Skia's pyramid at the blocks' edges); a 512 px picture by up to 34 on
  about 400 of 741,376 bytes.

**Gate.** `editor_test.py` `a_colour_matched_layer_draws_from_its_own_tiles`, both backends: a 4100 x 2900 document, a
full-size matched layer with a mask on its grid and a small one drawn scaled whose levels end inside a pixel (1401 / 8).
On the GPU stack and on Canvas 2D: zoomed out at a fixed 0.4 (its edges a tenth into a screen pixel: the GPU rasterises
by pixel centres) and at 1:1, no mirror, pyramid or `_masked` of either layer (tiles); the screen against the old path
with the same statistics object (at most 0.5 % of bytes over 8 levels) and, at the small layer's right and bottom edges,
at most 24 levels; a floor (the match moves the screen by more than 20); a pan by three tiles at the same region size
against the match made again (at most 1 level); a change under the small layer and a flip of it, each against the
statistics and match made again. Then the eyedropper, a 512 px picture (against the old path) and the wand's box passes
on a small block, with no mirror. `editor_test.py` also takes `SCUMBLE_EDITOR_ONLY=step,step` to run the first step,
those and the cleanup.

**Seven mutations, each red** (fresh instances):
- the key without the region canvases' origins → the pan, "124 levels on 1534516 bytes";
- the mask not applied → "1065400 bytes by more than 8 levels (max 143)";
- the GPU quad not cropped → the edges, 96 levels; the 2D draw not cropped → the edges, 42 levels;
- the key without the statistics object → the change below, "60 levels on 44375 bytes";
- `matchFromTiles` false (the old path) → "a display mirror of a matched layer was made";
- the landed layer's own caches not dropped → the flip, 2 levels (weak, but red).

Three of them were green on the first version of the step, each for a reason in the test: the pan changed the region's
size (the key moved anyway), the small layer ended on a whole pixel at its level, and its edge was matched to the
colour around it (it has a white last column now). A mutation of the quad shader alone (the texture squeezed by less than
a level pixel) stayed green and was replaced by the draw past the edge, which is the error that shows.

**Runs:** `s7b-all-tiles` (editor pixels composite shape brush film glb ailabel size transparent generate log mcp llm toapis
nodecopy): all PASS but `editor` (`a_settled_read_builds_its_levels_in_the_worker_not_here` "took no cell from the
worker", a step without a matched layer; PASS on the re-run `s7b-all-tiles2`) and `composite` (the known `KeyError 'bytes'`
crash of its own failure message, fixed; then the stored view, above). `s7b-composite-tiles` and `-canvas` PASS;
`s7b-all-canvas` (editor pixels composite film glb mcp) ALL PASS. No `commands` or `smoke`: the user's ComfyUI is in use.

**Left for 7c / 7d:** the screen's statistics are still the screen's own (`_mstatsView`); the match is still a canvas per
miss (7d moves it into the atlas shader, which also removes the per-miss upload).

#### C6 (c) slice 7c as built (2026-09-16): one statistics entry for every pass, and the measurement for (b)

The user's decision (a) of 2026-09-15 (`dist/c6map/c/decisions.md` 1), after `dist/c6map/c/match.md` §4.

**Before.** The screen and the navigator took a colour-matched layer's statistics from the target of whichever pass
missed first after a change (`_mstatsView`, the region the view showed then), a sampled pass from the layer's whole
surroundings (`_mstatsSample`, 7a). The screen, the navigator and the eyedropper disagreed by a few levels
(`a_sampled_pass_matches_only_the_part_of_a_matched_layer_it_shows` read 3 to 6 levels between the screen at 1:1 and a
sampled pass), and the screen's colours after a change depended on where the view was. The GPU stack composited the
stack below a matched layer a second time for its statistics (`glMatchBackdrop`).

**What was built** (`renderer/editor/inpaint_canvas.js`):
- `matchStats` hands every region pass to `sampledMatchStats(layer, forRun, display)`; only the full-resolution flatten
  keeps `_mstats`. `_mstatsView` and `glMatchBackdrop` are gone.
- The screen and the navigator read the entry with `display`: the layer at 256 px and the backdrop pass (`sampleRegion`
  takes `display` now) read the levels the screen shows, so no chain is built on the main thread for them. An entry read
  that way while the mips worker has chains on their way is `provisional`: it is dropped when they have landed (and the
  screen and the thumbnail draw again), and a reader that wants exact levels (every sampled pass) makes it again at once.
  With every chain there display and exact levels are the same bytes. The filter cache key of a pass holds `display`.
- `markMatchChanged` keeps the layer's own shared entries (their key holds the source; a strength tick changes neither
  the layer's pixels nor what is below it); matched layers above still match again.
- `dropStaleViewCaches` no longer drops statistics (7b's own-layer drop is gone: `_mcacheView`'s key holds the
  `chainEpoch`s, and statistics read from stale cells are provisional).

**After.**
- `a_sampled_pass_matches_only_the_part_of_a_matched_layer_it_shows`: screen against sampled pass **0 levels on tiles**
  (was 6); its bound is 2 on tiles. On canvases 5 levels on 294 bytes (the screen matches the layer's GPU copy, the pass
  its CPU pyramid), bound 6 as before.
- `composite_test.py`: the stored view differs by up to 3 levels on the matched layer on **both** backends now (the
  references were taken with the view's own statistics); the view step allows 3, the full-resolution composite stays
  identical, gpu-vs-2d max 1.
- `perf_test.py 15000x10000`, before (on acbbda5) and after: the slider ticks under the matched result 7.9 / 7.6 / 7.7 ms
  before, 12.6 / 11.5 / 11.4 after the first build (each tick re-made the statistics with a backdrop pass of their own:
  the view's target had been free), 9.2 / 8.9 / 8.5 with `markMatchChanged` keeping the layer's own entry. The first frame
  at 1:1 over the full-size matched layer 110 / 112-129 ms, and its settled frame 0.4 → 34-36 ms: the provisional entry is
  made again once the chains have landed, once. Eyedropper over it 46 / 16-58, wand 321 / 276-325. The rest within noise.

**Gate.** `editor_test.py` `colour_match_statistics_are_one_entry_for_every_pass` (both backends; (ii) and (iii) on tiles
with a worker), a 4000 x 3000 document with a full-size striped paint layer under a matched 1600 x 1200 layer: (i) the
screen at fit, a pan, 1:1, the navigator's thumbnail, the eyedropper, a 512 px picture, the wand and ten strength ticks
make no new entry; (ii) after a flip of the paint layer the screen's entry is provisional and not the exact one, and after
the landing it is the exact one and the screen equals the screen with it made again; (iii) the eyedropper right after
another flip takes exact statistics. Six mutations, each red (fresh instances): the screen on an entry of its own; never
provisional; no drop after the landing; an exact reader taking a provisional entry; the backdrop and the layer read at
exact levels (the provisional entry is already exact, so (ii) proves nothing); a strength tick dropping the layer's own
entry ("made 11").

**Runs:** `s7c-all-tiles` (editor pixels composite shape brush film glb ailabel size transparent generate log mcp llm toapis
nodecopy) and `s7c-all-canvas` (editor pixels composite film glb mcp) ALL PASS on the build before the `markMatchChanged`
change; after it `s7c-fin-tiles` (editor composite pixels film mcp) ALL PASS, `s7c-fin-canvas` (editor composite) failed
`closed_tabs_are_collected` (the known flake, `[false, false, false, true]`) and `s7c-fin-canvas2` (editor) PASS.

**The measurement for (b)** (decision 1 of `dist/c6map/c/decisions.md`: exports on the same entry; for the user, not
decided here). Eight of the user's photos (1080 x 1440 to 6036 x 3018, from their ComfyUI `input` folder, read locally
only), in each a result layer cut from another part of the same photo (30 % of each side), a colour cast
(x1.12 / 0.96 / 0.84 + 10, or x0.9 / 1.05 / 1.1 - 8), a soft round alpha edge, matched at 100 % against its surroundings
and underneath: 32 cases. Compared: the matched layer (pixels with alpha >= 128) with today's full-resolution statistics
against the same with (box) the shared entry, box means of the tiles' levels, and (point) point samples of the
full-resolution layer and composite at 256 px, nearest. Worst of each photo's four cases, levels per channel:

| photo | size | box: mean / p99 / max | point: mean / p99 / max |
|---|---|---|---|
| a football scene | 4800 x 3584 | 1.04 / 4 / 10 | 0.46 / 3 / 9 |
| a car composing | 1080 x 1440 | 0.38 / 2 / 2 | 0.33 / 2 / 5 |
| a wide landscape (`1 2.jpg`) | 6036 x 3018 | **5.45 / 12 / 16** | 1.89 / 5 / 8 |
| `3.jpg` | 2048 x 2048 | 1.30 / 3 / 5 | 0.89 / 3 / 5 |
| `54566cffh.jpg` | 2999 x 2999 | 0.99 / 2 / 4 | 0.67 / 2 / 6 |
| `555555555555.jpg` | 2202 x 2202 | 0.43 / 2 / 4 | 0.26 / 2 / 2 |
| `5674576.jpg` | 4608 x 3712 | 0.33 / 2 / 2 | 0.04 / 1 / 2 |
| `180sz.jpg` | 4054 x 2280 | 0.66 / 3 / 4 | 1.32 / 4 / 6 |

Over all 32 cases the mean difference is 0.81 levels with box means and 0.56 with point samples; p99 above 4 levels in 2
cases (box) and 1 (point). The outlier is the textured wide photo: box means average the texture away, so the spread the
match scales by drops (scale 0.89 → 0.79 in red on one case), which is what `match.md` §4 predicted. Point samples keep
the texture and stay within 8 levels everywhere. The statistics themselves cost 5 to 70 ms at full resolution and 5 to
22 ms from levels on these sizes (the full-resolution flatten around them dominates an export either way).

#### C6 (c) slice 7d as built (2026-09-16): the colour match on the GPU stack is uniforms

`dist/c6map/c/match.md` §3, GPU option B.

**Before (7b).** On the GPU stack a colour-matched layer on tiles was its region canvas matched into a new canvas per
change of the match (a strength tick, a pan past the region's margin, a landing) and uploaded as a texture of the
compositor, drawn through a cropped quad.

**What was built.**
- `inpaint_compositor.js`: the atlas shader has `u_match`, `u_meanS`, `u_meanT`, `u_mScale`, `u_mK`. After the mask it
  unpremultiplies the sample, applies `matchCanvas`' formula to the straight 0..255 values, clamps and premultiplies
  again. A tile store's spec carries `match: { meanS, meanT, scale, k }` or null; `_drawTiles` sets the uniforms per layer.
- `glViewComposite`: a matched layer on tiles (`matchFromTiles`) is the layer's own tile spec with its mask and `match`
  from the shared statistics entry (7c). No matched canvas, no upload, and the instance cache is untouched by the match.
- 7b's cropped canvas source (`cropW` / `cropH`, `u_uvMax`) is gone again: nothing hands the compositor a region canvas
  any more. The Canvas 2D path keeps `matchedRegionView`.

**After.** Against the Canvas 2D path (`matchCanvas` on each byte), inside the layer at 0.4 and at 1:1, a scaled layer with
a soft mask at 60 %: **max 2 levels, no byte over 2**. Eight strength ticks at 1:1: no `matchedRegionView` or
`layerMatchedPixels` call, no texture entry, no atlas or window upload. `perf_test.py 15000x10000` does not see the
change: its stack always shows a filter layer, so the screen takes Canvas 2D, and its GPU-stack rows hide the matched
result; every row within the runs' noise (A/B in the same session, `s7d-perf-before` / `-after`).

**Found on the way:** at the image's own border the GPU stack and Canvas 2D differ by 255 levels on about 8,700 bytes at
0.4 with no match at all (the step compares inside the layer, 3 screen pixels in). Not broken down.

**Gate.** `editor_test.py` `the_colour_match_on_the_gpu_stack_is_uniforms` (tiles with a GPU compositor; skipped
otherwise): the two views against Canvas 2D (at most 4 levels, at most 0.2 % of bytes over 2), a floor (the match moves the
screen by more than 20), and the strength ticks. Four mutations, each red: the sample not unpremultiplied (41 levels on
804,957 bytes), the uniform never switched on (the floor), the strength ignored (23 levels), the matched canvas path back
on the GPU stack ("made a matched canvas"). `a_colour_matched_layer_draws_from_its_own_tiles` still passes on the GPU
stack; its 7b GPU-crop mutation has nothing to mutate any more.

**Runs:** `s7d-all-tiles` (editor pixels composite shape brush film glb ailabel size transparent generate log mcp llm toapis
nodecopy) and `s7d-all-canvas` (editor pixels composite film glb mcp) ALL PASS.

#### C6 (d) as built (2026-09-16): the base holds its pixels, not an image

`dist/c6map/base.md` §7 (a map of d7234e4; line numbers have moved) and `critic.md`.

**Before.** `this.base` was `{ ref, img }`: the <img> the base was decoded from, kept for the life of the base and of every
canvas undo step (572 MB decoded at 15000 x 10000, invisible to the memory report), and `basePx` a getter that made the
pixels from it on the first read, keyed on the <img>'s identity. A crop, a resize, an extend, a merge into the base, a
flatten, "Generate new" and a new canvas each built the new base in a canvas, uploaded it, fetched it back as an <img> and
decoded that again on the next frame; an undo of any of them decoded the old <img> again (0.5 to 0.8 s at 15k, C2's
numbers). The resize drew the <img> itself.

**What was built** (`renderer/editor/inpaint_canvas.js`):
- `base` is an accessor over `{ ref, px }`; replacing it queues the release of the old base's atlas pages (the C6 a
  mechanism the getter used to trigger). `basePx` / `_basePx` read `base.px`.
- `setBase(ref, img)` makes the pixels at once and keeps no image; `setBasePixels(ref, px)` takes pixels the caller made;
  `checkBaseSize` is the 268 MP refusal of both.
- The producers keep the upload (the state, runs and uploads need the file) and take the pixels from their own canvas:
  crop `basePx.resized(...)` (on tiles it shares the old base's tiles; the upload reads a canvas made for it and let go,
  `uploadBase`), resize from a canvas of the pixels (`drawBaseInto`), extend / merge into the base / flatten / new canvas
  `fromCanvas` of the canvas they built, `setBaseFromCanvas` a copy of the caller's canvas (`fromImage`, because the canvas
  backend adopts a canvas it is given).
- The canvas undo step holds the base object with its pixels (free on tiles: the base is never written); an undo puts the
  same pixels object back. `heldPixels` and the memory report's step walk count a step's base.

**The resize, measured before the change** (the one question `base.md` §7.5 left): the same `imageSmoothingQuality =
"high"` draw from the <img> and from a canvas of its pixels, four of the user's photos (1080 x 1440 to 4800 x 3584) at 0.37,
0.5, 0.8 and 1.6: mean 0.2 to 0.7 levels, max 22, 0 to 3 % of the bytes over 2 (identical at 0.5 on tiles, 1 to 8 levels
max there on canvases). Two resamplers of the same quality; accepted.

**After.** `perf_test.py 15000x10000` A/B in the same session: "undo step" 41.8 → 26.7 / 30.6 ms, every other row within
noise (a first after-run read `screenshot` 366 ms and the prompt context 492 / 835 ms; the repeat read 73 / 71 / 129, the
before run 19 / 56 / 132). The benchmark builds its document with `setBase` and never undoes a canvas step, so the decode
this removes is not one of its rows.

**Gate.** `editor_test.py` `the_base_holds_its_pixels_not_an_image` (both backends; the sharing on tiles): the base has no
`img`; a crop shares 54 of its 70 tiles with the old base and its pixels are the old base's to the byte; a merge into the
base and a flatten give the composite they baked (0 levels); an extend and a resize give the new sizes; no `fromImage`
while editing; the memory report counts at least two whole bases in the steps; five undos bring the earlier base pixels
objects back and five redos the last one, with no `fromImage`. `the_screen_draws_no_cpu_mirror_and_stale_textures_leave`
replaces the base by assigning a new `{ ref, px }` where it assigned a new image. Four mutations, each red (fresh
instances): the setter queuing no release ("kept the old base pixels' atlas pages"), the crop copying instead of sharing
("shares no tile", `[0, 70]`), the report not counting a step's base (15.9 MB against the 50 MB floor), an undo decoding
the base again ("did not bring the extended base's pixels back").

**Runs:** `s6d-all-tiles` (editor pixels composite shape brush film glb ailabel size transparent generate log mcp llm toapis
nodecopy) and `s6d-all-canvas` (editor pixels composite film glb mcp transparent generate size) ALL PASS. `commands` and
`smoke` not run (the user's ComfyUI is in use); `commands_test.py` covers load_image and export through `setBase`.

**Left:** the merge into the base and the resize still read the whole base at full resolution (a canvas made and let go),
the upload of every new base is a full-resolution PNG (phase E streams both); `setValue` (a tab restored) still decodes
its base from the file, which is where the pixels come from.

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

#### The rest of §C7, as far as it went (2026-09-16)

After C6 (c) 7b to 7d, C6 (d) and C4, on 08db610 plus this commit.

- **The node's browser: not run.** `nodecopy` (`build_node.py` into a scratch copy of the node repo, `--check`,
  `node_test.py` against ComfyUI stand-ins) passes in every tile gate run of the day. A real run in the ComfyUI tab and the
  Firefox pass need the user's ComfyUI, which the user needs for their own work (2026-09-16); Firefox is installed
  (`C:/Program Files/Mozilla Firefox`). The node repo itself is still at 647db5d and was not built.
- **`--disable-gpu`** (dev, tiles, own profile, `dist/gates/gates/c7-nogpu`): WebGL2 stays available (Chromium's software
  renderer) and the compositor is used. `composite_test.py`: gpu-vs-2d max 2 levels (PASS); the stored references differ
  by up to 5 levels on 42 % (full) and 25 % (view) of the bytes, the source-window step reads 14 levels at half zoom (FAIL:
  its bound is 2). `editor_test.py` match steps: 7b and 7c PASS, `the_colour_match_on_the_gpu_stack_is_uniforms` 6 levels
  on 717 bytes over 2 against its bound of 4 (FAIL). All of it reads like software rasterisation (the references were
  taken on the card), not like wrong pixels; the bounds were not widened. Not broken down.
- **The memory gate: not met** (`mem_test.py 15000x10000 --rounds 4`, `run_gates.sh` takes `mem:15000x10000,--rounds,4`
  now). Closed documents are collected on both backends: the GPU process ends +199 MB above its start on tiles, +297 MB on
  canvases, and the canvases alive at the end are the filter module's four 1024² scratches. With the document open: tiles
  renderer 3.1-4.3 GB and GPU process +0.6 to +1.4 GB above its start (the bound is 300 MB), canvases 0.7 GB and +6.1 to
  +6.7 GB. The renderer against the tile bytes (1.2×) is not compared: `mem_test.py` does not report them. The walk's own
  "canvas upload" drift check read FAIL on tiles at 0.1 → 0.4 ms (below the timer's resolution in practice).
- **The 30k gate: not run.** `perf_test.py` builds its document from full-size canvases, which cannot exist at 30000 x
  20000 (above 268 MP); the per-tile build is E5's.
- **The docs:** `docs/PERFORMANCE.md` §11 (the tile engine's rows against §9's, and the memory walk), `docs/BUGS.md` 15k
  entry updated and left open for the user's own file, `docs/PLUGINS.md` already carried the deprecation of
  `rawLayer().canvas`. Not written: the node's `DEVELOPMENT.md` §24 (the node repo is not touched until a node version
  ships) and a 0.2.0 section (the version of the next release is the user's).
- **The installer and the exe gates:** `npm run dist` → `Scumble Setup 0.1.16.exe` (local, not published). Against
  `dist/win-unpacked/Scumble.exe` on their own profiles: `c7-exe` (no `--tiles`: the default, tiles; pixels editor composite
  brush film glb mcp) ALL PASS, `c7-exe-canvas` (`--tiles off`: pixels editor composite) ALL PASS. No `smoke`, no
  `commands` (the user's ComfyUI).

#### The default, as built (2026-09-15, for 0.1.13)

The user's decision: the tile engine is on by default in the installed app from 0.1.13, with a switch in Settings ›
Rendering; the canvas backend stays as the escape hatch; the node keeps its own default (off). Built ahead of the rest of
C7 (node browser, Firefox, the 30k gate, the docs list above), which stays open. **The default went on before §C7's own
gates were met**, on that decision: the `mem_test.py` bound above was not met (see "Not met" at the end of this section),
and the 30k and exe gates have not run.

- **The precedence** moved into `electron/main/tilemode.js` (`resolveTileMode({ argv, env, setting, packaged })`, no
  Electron, so `tools/tilemode_test.js` runs it in plain Node): `--tiles` / `--no-tiles`, then `SCUMBLE_TILES=1` / `0`,
  then a boolean `tiles` in settings.json, else **on** (`DEFAULT_ON`) in a dev run and in the packaged app alike, `from`
  "default" (it was "dev build" / "packaged build"). `packaged` is still passed and ignored, so the test pins that the
  installed app takes the same default. Still never written: `tiles` is not in `settings.DEFAULTS`.
- **The row** Settings › Rendering › Tile engine (`renderTileMode` in `renderer/shell.js`): the box shows the stored
  boolean, or the default while there is none, and a change writes `{ tiles: <checked> }`; opening the dialog writes
  nothing. The note says what this window runs and what decided it, from the new IPC `app:tileMode` (`window`: what
  `createWindow` resolved, `next`: the precedence with the settings as they are now, `setting`, `defaultOn`, `argv`,
  `env`). While the command line or `SCUMBLE_TILES` decides, the note says they win over the box; otherwise "Restart now"
  appears when the next start would differ. **Restart now** is a new IPC, `app:relaunch` (it did not exist; a few lines:
  `app.relaunch()` then `app.quit()`, refused while an agent is attached, whose session would end with it). The button
  saves first and asks when a document is still working. Checked by hand on a dev instance with its own profile: untick,
  Restart now, the new window runs canvases "from settings" with the document restored.
- **The release review's fixes to Restart now** (three findings, each confirmed by two verifiers on check instances):
  - *It lost the last edits.* It saved only the autosave bundle, which names each layer's uploaded file, and a layer is
    uploaded 15 s after its last change (`scheduleAutosave`): a layer filled 2.5 s before came back without its pixels
    (`layers: []`), an older layer with the file from before. `saveBeforeRestart()` in `renderer/shell.js` (exported for
    the gate) now runs `syncLayers()` on every editor first, and for a picture above `SYNC_ENCODE_PX` waits for the
    selection's background encode (at most 60 s; an encode that cannot start is not waited for), then saves the bundle.
    Checked by hand after the fix: the same fill, Restart now, the relaunched window holds the layer with its red pixel.
  - *An agent's or a headless process came back without a window.* `app.relaunch()` with no arguments reuses
    `process.argv`, so a `--mcp` process whose window the user had opened quit after the restart (its stdin gone), and a
    `--headless` one came back invisible holding the instance lock. `electron/main/restart.js` `relaunchArgs(argv)` drops
    `--mcp`, `--headless` and `--cmd` with its name and JSON (parseArgs' rule) and keeps everything else. Checked by hand
    on 9555 for both: the relaunched process has neither switch on its command line and a visible window.
  - *With an update downloaded, a plain quit runs its installer.* `autoInstallOnAppQuit` installs silently without
    `--force-run`, and the NSIS script kills every process under the install folder, the relaunched Scumble included (read
    from electron-updater's `BaseUpdater` / `NsisUpdater` and app-builder-lib's `allowOnlyOneInstallerInstance.nsh`; not
    run live, which needs a packaged build and a newer release). `restartPlan({ argv, updateState })` returns
    `{ install: true }` in the `downloaded` state and `app:relaunch` then calls `updater.install()` (`quitAndInstall(true,
    true)`, which starts the new version; that start has no command line, so the setting decides). The row's note says
    "Restart now also installs x.y.z" in that state.
- **Gate**: `editor_test.py` `tile_engine_row_writes_the_setting_and_names_its_source` (right after
  `pixel_backend_is_the_one_the_flag_chose`): `node tools/tilemode_test.js` (twelve cases: the default in a dev run and
  packaged, non-boolean settings ignored, the setting both ways, the environment over the setting, the command line over
  both, look-alike arguments ignored); then the row: opening writes nothing, the box and the note against the stored value
  and this window's source, main, the preload and the `status` command agree on `{ tiles, from }`, two clicks each write
  the boolean, and the next start takes it, or stays with the command line / environment and the note says so; the
  setting is put back (no key when there was none). Checked alone on four instances: nothing set, `SCUMBLE_TILES=1`,
  `--no-tiles`, `{"tiles": false}` in settings.json. The step also runs `node tools/restart_test.js` (ten cases: a plain
  command line kept, `--mcp` / `--headless` / `--cmd name json` dropped, look-alikes kept, a downloaded update installs, a
  downloading one does not). The next step, `restart_now_saves_the_edits_of_the_last_seconds`, calls
  `saveBeforeRestart()` (the button itself would end the instance) and reads `autosave.json` back: a paint layer filled a
  moment before has a file holding the fill, and on a 5000 × 4000 picture the saved selection is the one made just
  before, not the one before it.
- **Mutations, each red** (the source restored and compared byte for byte):

  | mutation | red |
  |---|---|
  | the row writes nothing | "click 1: the box is True but settings.json holds [False, None]" |
  | the fallback off in the packaged app again (`on: !packaged`) | tilemode_test: "nothing set, packaged app: {on: false}" |
  | the fallback off everywhere (`DEFAULT_ON = false`) | tilemode_test: "the default is false, not on"; in the app the step's plain-Node part first |
  | the setting ignored | tilemode_test: "the setting off: {on: true, from: default}" |
  | no `syncLayers()` before the save | "the saved document has no file for the layer painted just before the restart: {ref: null}" |
  | the selection encode not waited for | "the saved selection is not the one made just before the restart: {inNew: [0,0,0,0], inOld: [255,0,0,255]}" |
  | a downloaded update ignored | restart_test: "a downloaded update is installed instead: {args: [...]}" |
  | `--headless` kept | restart_test: "a --headless start comes back with its window" |
  | `--mcp` kept | restart_test: "an agent's --mcp process comes back as a window" |

- **Memory** (`mem_test.py 15000x10000 --rounds 2`, fresh dev instances, strict; the document is a painted base, three
  full-size paint layers, a colour-matched 2048 px result, a film look and a levels layer). Renderer / GPU process
  private MB:

  | | start | built (round 1, 2) | closed (round 1, 2) | after collection (round 1, 2) | free |
  |---|---|---|---|---|---|
  | tiles on | 87 / 208 | 4756 / 1647, 4325 / 2283 | 4780 / 5110, 4811 / 6310 | 250 / 333, 242 / 384 | 204 / 405 |
  | tiles off | 87 / 208 | 703 / 7819, 697 / 7238 | 1270 / 8888, 1266 / 8957 | 105 / 556, 107 / 345 | 107 / 370 |

  Pan 5.5 / 5.1 ms on tiles (the user's ComfyUI job was running during that run), 3.5 / 3.6 on canvases; the levels tick
  12.3 → 15.0 ms on tiles (the phase-6 drift check reads FAIL at +22 %), 10.3 → 8.9 on canvases. With the tabs kept open
  (`--keep`, tiles on only; canvases were not run that way, because two or three 15k documents on that backend put 15 to
  23 GB into the graphics process on the card the user's ComfyUI jobs use): two documents 7044-7056 / 2126-2296 built,
  9637 / 8703 closed; three 10426 / 3394 built, 12760 / 8828 closed, 234 / 349 after free. The renderer passed 8 GB
  without a crash (the "about 8 GB" in `PERFORMANCE.md` §4 did not bite here), but the pan was 64.6 ms and the levels tick
  63.8 ms with three open (5.1 and 11.1 with one), and the levels tick 49-58 ms with two. Not broken down. The
  `CHANGELOG.md` bullet tells users to close the tabs of large pictures they are not working on.
- **Runs** (fresh dev instances, strict, each on the first try): `rel-tiles` (`--tiles on`), `rel-canvas` (`--tiles off`)
  and `rel-default` (no `--tiles`: the new default, "default" in the backend step and the row) with `pixels editor
  composite commands shape brush film glb ailabel size transparent generate log mcp nodecopy` ALL PASS, `rel-copy`
  (`--copy --tiles off pixels editor composite commands`) ALL PASS. After the release review's fixes (above): `rel-final-tiles`
  and `rel-final-default` (the same fifteen gates) ALL PASS on the first try; `rel-final-canvas` (`--tiles off pixels
  editor composite commands`) failed once in `live_stroke_preview_shows_what_the_commit_writes` ("paint: the preview is
  not what the commit wrote (157 levels on 66399 of 518400 bytes)", a step the fixes do not touch; a known flake) and
  passed on the re-run with every step. No `smoke`, no `npm run dist` and no exe gates in this step: those belong to the
  release.
- **Not met: §C7's memory gate.** The run above is `--rounds 2`, not 4. With one document built the GPU process sits
  1.4 to 2.1 GB above its start (208 → 1647 / 2283 MB; with `--keep` 1405 for one, 2126-2296 for two, 3394 for three),
  against the bound of 300 MB per open document; the renderer was never compared with the tile bytes reported (the log
  prints none once no document is live). The "GPU process back within 300 MB of the baseline: PASS" line in the log is
  phase 6's check after closing, not this bound. Closed documents are collected, which is the part that holds. The
  levels-tick drift check reads FAIL (+22 %).
- **Measured in the release review, not broken down** (check instances, 15000 × 10000, the `perf_test.py` document):
  - *The whole flatten.* Cold `flattenToCanvas({ forRun: true })` after an edit: with the film look 4.7-11.4 s on tiles
    and 5.3-7.4 s on canvases, the window blocked 7-17 s per Generate on tiles and 8.7-10.9 s on canvases; without the
    film look 0.9-2.5 s on tiles against 0.22-0.31 s, blocked 2.8-4.9 s against 2.3-2.8. `promptContextCanvas` after a
    fill blocked 7.8-8.1 s on tiles. `perf_test.py`'s "full composite" worst (its cold call; the bracket nulls `flatCache`
    but does not bump `compositeVersion`) read 1.9-2.7 s in every C5 run and 4.9-8.0 s in every run since C6 (b).
  - *A stroke after other work.* The 40-dab stroke on a fresh document reads 30-47 ms of drawing and 268-339 ms to
    apply on tiles; `perf_test.py`'s rows, which run it after grow, shrink, invert, feather, the wands, the bucket and a
    fill / undo / clear on the layer, read 138-193 / 559-678, and adding that series before the stroke on a check instance
    gave 115-126 / 617-1608. It depends on the document's edit history.
  - *Whole-layer copies on tiles.* `layer.px.toCanvas()` of a full-size 15k layer 184-253 ms (0.0-0.1 on canvases, the
    layer's own canvas); the synchronous part of `syncLayers()` 151 ms against 1.2. Behind the autosave, the in-app
    background removal (`cutoutInApp`), select by text on a layer (`segmentSource`, `layerAlpha`) and select from layer.

#### The live stroke that did not show (0.1.13, fixed for 0.1.14)

- **Symptom** (the user, 2026-09-15 17:57, installed 0.1.13 with the tile engine on by default, a screen recording):
  with the eraser, and then with the brush, nothing but the first dab reached the screen while the button was down; the
  change appeared on the release, one step per stroke. Their picture: 17315 × 9257, a "merged copy" layer of 14246 ×
  2259 at (1719, 4514) over the base, the selection kept with marching ants, the eraser at 188 px and 43 %, zoomed out
  well below 0.5.
- **Reproduced** on `dist/win-unpacked/Scumble.exe` (0.1.13) with CDP mouse events and screenshots with the button still
  down: half way through and 500 ms after the last move the screen held the press dab only. Nothing varied changed it:
  tiles on or off, 4000 × 3000 or 17315 × 9257, the layer at the origin or not, fit or 1:1, ants or tint, a selection
  or none, a filter layer above, a hard tip, a pen. `drawScene` ran 37 times in 36 moves and rebuilt the scene once.
- **Cause.** The screen keeps its composited scene in `sceneCanvas` behind `sceneSignature()`, and the only input of
  that signature that moves during a gesture is `pixelVersion`, which `touchSource` / `touchSourceRect` raise. Up to
  4bd31a4 every dab called `touchSource(buffer.canvas)` after `StrokeBuffer.ensure()`. **28bfad0 (C5 c)** replaced
  `ensure()` with `draw(x0, y0, x1, y1, fn)` and dropped that call from `layerDab`, `cloneDab`, `gradientDab` and
  `shapeDab` with nothing in its place. From then on every frame of a stroke found the signature of the press and
  blitted that scene with the overlays over it (the ring and the ants kept moving); `layerRegionView`, which takes the
  dab's dirty box, was never reached again until the release, where `markLayerChanged` raised `pixelVersion`. The
  brush, the eraser, the clone tool, the gradient and a dragged rectangle lost their preview (measured, below); a
  stroke on a mask, heal, and the ellipse and freehand shapes go through the same four functions (read from the code).
  Smudge (which touches its target per dab) and the quick-mask brush (`touchSourceRect`) kept theirs.
- **First bad commit: 28bfad0**, on both backends (bisect with dev worktrees and the same CDP stroke: 7f01699 = 0.1.12
  and 4bd31a4 good on both; 28bfad0, every commit after it, and 5ee9918 = 0.1.13 bad). Not a tile bug and not caused by
  7a89601 (tiles on by default); 0.1.13 was the first release that carried C5.
- **Why no gate saw it.**
  - `editor_test.py` `live_stroke_preview_shows_what_the_commit_writes` set `ed.sceneSig = null` before every
    `ed.draw()` of the gesture and called `layerDab` / `shapeDab` and `draw` itself: it did by hand exactly what the dab
    had stopped doing, and it asks whether the preview is *right*, never whether a frame the app draws shows it *at all*.
  - `erase_stroke_keeps_the_rest_of_the_layer_on_screen` drives the pointer handlers but reads the screen after the
    release only. No gate read the screen during a real stroke.
  - `perf_test.py`'s "brush dab + frame" and "stroke across the picture" call `layerDab` then `draw()` without clearing
    the signature, so since 28bfad0 they timed a blit of the cached scene. Their medians did not move at 28bfad0
    (0.1 ms and 720 → 620-892 ms at C5 b / C5 c, inside the noise of that document), so they did not show it either.
- **Fix** (`renderer/editor/inpaint_canvas.js`): `strokeDirty()`, which every one of the four dab kinds already calls
  to record its dirty box, raises `this.pixelVersion` as well. Only the scene's key moves: no `touchSource` on the
  buffer (on tiles that is `px.touch()` on the sparse store; on canvases a `_dispVer` no reader of a stroke buffer
  looks at), no display level, no mirror, and the frame is the region preview C5 built (`layerRegionView` redraws the
  dab's box). The canvas backend gets exactly its 4bd31a4 behaviour back.
- **Gate.**
  - New `editor_test.py` step `live_stroke_reaches_the_screen_before_the_release` (right after the preview step; both
    backends through the gate runner's `--tiles on` / `--tiles off`). The user's case built the user's way: a textured
    10000 × 5000 picture, `select_rect` 1000, 1300, 7600 × 2400, copy merged, paste ("merged copy added (7600 × 2400 at
    1000, 1300)"), the copy inverted so an erase shows something, the selection kept with ants, a 188 px brush at 43 %.
    The setup asserts that the copy carries the picture's texture (at least 4 colours in 6 samples) on both backends.
  - Strokes are driven by `Input.dispatchMouseEvent` (press, 24 moves 40 ms apart, release) with `Page.bringToFront`,
    frames only from the app's `drawSoon`; the step never calls a dab or `draw` and never writes `sceneSig`. It fails
    with its own message when `requestAnimationFrame` does not run (a hidden window), when fewer than a third of the
    moves got a frame, and when the stroke's pointer is not where the step moved it half way and at the end (a real
    mouse over the window).
  - Rows: brush and eraser at 0.18 and at 0.45 (both asserted below 0.5; at 0.45 the layer is wider than the view)
    and at 1:1 (wider too); then a rectangle shape, the gradient and the clone tool at 1:1. **Every row sets its scale
    and centres its stroke**; nothing depends on the window's fitted scale.
  - The editor canvas is read (one `getImageData` of the stroke's rectangle) before the press; **half way and right
    after the last move with no rest**, two of the page's own frames after the move; after a 0.4 s rest with the button
    still down; and after the release once the chains settled.
  - Asserted:
    - right after the last move, and again after the rest, the screen shows ≥ 95 % of the pixels the release changes
      (outside the brush ring discs at the start and the end);
    - half way, with the hand moving, ≥ 90 % of the pixels behind the cursor for the brush, the eraser and the clone
      tool; for the shape and the gradient, which are redrawn whole per move, ≥ 10 % of what the release changes
      anywhere (measured 0.21 for the rectangle, which is a quarter of the last one half way, and 0.44 for the gradient);
    - the stroke changes ≥ 2000 pixels at all;
    - the rested frame equals the frame after the commit outside the ring discs, to 2 levels at 1:1 and to 20 zoomed
      out (measured on the textured copy: 2-3 on tiles; 7-12 at 0.18 and 3-5 at 0.45 on canvases, at DPR 1.5 and 1;
      never a byte over 30);
    - on tiles the stroke makes no display mirror of the layer, and the layer has none before it. The clone tool makes
      one (below) and is left out; it runs last, so its mirror cannot hide another tool's.
  - The preview step's blind spot: its gesture frames draw without `sceneSig = null` now (the dab loops, the frame
    before the commit, the "reach" floor and the shape case); the frames after the commit keep theirs.
  - **Red on 5ee9918's editor** (the fixed file swapped for HEAD's, strict dev instances; the first version of the
    step): on tiles and on canvases the new step fails every one of the nine strokes, "with the button still down the
    screen shows 0 of the 10831 pixels the release shows (0.000)" and the like, the end frame 201-255 levels from the
    frame after the commit; the preview step fails at its first case, "paint_clipped: the preview is not what the
    commit wrote (157 levels on 138452 of 518400 bytes)" (131984 on canvases).
  - **Green with the fix**, the final step, three fresh canvas-backend runs and one on tiles reading the same numbers:
    right after the last move 0.996-1.0 of the release's pixels, half way 0.996-1.0 behind the cursor (the DPR-1
    viewports included).
- **Mutations, each red** (strict dev instances, tiles unless named; the fixed file restored byte for byte after each;
  logs in the session's `bug-live/runs2` and `runs3`):

  | mutation | red |
  |---|---|
  | no bump in `strokeDirty` (0.1.13) | new step: every stroke, "right after the last move … shows 0 of the 10602 pixels", the rested frame 201-228 levels off (18 of 18 "0 of" checks at the end); preview step: "paint_clipped: … 157 levels" |
  | the bump in `layerDab` only | new step (first version): "1to1_shape / 1to1_clone / 1to1_gradient: … shows 0 of the 44491 / 52844 / 49656 pixels"; preview step: "shape: the preview is not what the commit wrote (93 levels on 355200 of 518400 bytes)" |
  | no bump; `onPointerMove` clears `sceneSig` after a stroke's dab instead | preview step: "paint_clipped: … 157 levels" (the new step passes: the pointer path is covered, a dab outside it is not) |
  | the bump kept, but `drawScene` rebuilds the scene only once the pointer has rested 100 ms (a 110 ms timer redraws) | new step: every stroke, "right after the last move … shows 0 of the 10602 pixels" and "half way … shows 0 of the 4593 pixels behind the cursor"; the rested checks pass, which is what the first version of the step read |
  | `gradientDab` makes the layer's display mirror (`canvasOf(layer.px)`) | new step: "1to1_gradient: the stroke made a display mirror of the layer" (the first version ran clone just before the gradient and could not see it) |
  | the test's setup empties the picture's canvas on both backends again | on canvases: "the merged copy is flat, not the picture: ["0,0,0,255"]" |
  | the old rows: `fitView()` for the zoomed-out rows, in a DPR-1 viewport (`Emulation.setDeviceMetricsOverride`, 1600 × 1000 and 1200 × 1000 CSS px) | canvases, editor canvas 1886 × 1292, fit 0.121: "z018_paint: … not the frame after the commit (22 levels, bound 20)"; tiles, 1286 × 1292: the setup throws "not inside the layer". The final step passes in both viewports on both backends |

- **Review round** (two lenses, two refuting verifiers per finding; all four confirmed and fixed):
  - *The picture's canvas was emptied on the canvas backend*, which adopts it: on `--tiles off` the rows painted on a
    flat black copy (which is also why the clone stroke changed about 7,100 pixels on canvases against 52,800 on tiles).
    The shrink is guarded by `ed.tileMode`, as at the three other sites in the file, and the setup asserts texture;
    the clone row now changes 53,907 pixels on canvases and 53,885 on tiles.
  - *The zoomed-out rows depended on the window*: `fitView()` gave 0.18 on the usual 1865 px canvas and 0.12 in a DPR-1
    window, where canvases went over the bound and a narrower canvas threw in the setup. The rows set their scale.
  - *The shots came after rests* (0.15 s before "half way", 0.4 s before "end"), so a preview that appears only once the
    hand stops passed. The shots are taken right after a move now; the rested frame is kept for the comparison with
    the commit only.
  - *The mirror check was vacuous for the gradient*, which ran after the clone row's mirror. Clone runs last, and a row
    whose layer already has a mirror fails.
  - *`perf_test.py`'s "stroke commit (undo copy)" timed the dab frames' backlog*: with the fix the 60 tight-loop dabs
    rebuild the scene, and the drain ran only after the commit row. The drain (`strokeView` added; display canvases only
    read if they exist, so the paint layer's mirror is not made before the commit) and a 300 ms rest now come before
    the commit; the row's bracket is the dabs plus the commit, without the drain.
- **Costs, A/B** (`perf_test.py 15000x10000`, tiles, fresh dev instances, not strict; "HEAD" is 5ee9918's editor file;
  medians, [the bracket]). With the harness as it was:

  | run | brush dab + frame | stroke commit (undo copy) [whole stroke] | stroke across the picture (40 dabs) | its commit, band by band |
  |---|---|---|---|---|
  | HEAD (`bug-live-perf-before`) | 0.1 [15.6] | 18.4 [40.9] | 143 | 500 |
  | HEAD | 0.1 [6.0] | 25.8 [38.7] | 172 | 646 |
  | fix (`bug-live-perf`) | 0.9 [6.2] | 67.5 [158.6] | 238 | 607 |
  | fix | 0.9 [5.2] | 162.3 [245.5] | 166 | 598 |

  With the drain before the commit (the harness committed with this fix; `bug-live-perf2-*`, and one run of the fix
  per variant of the drain):

  | run | brush dab + frame | stroke commit (undo copy) [dabs + commit] | undo step | stroke across the picture (40 dabs) | its commit, band by band |
  |---|---|---|---|---|---|
  | HEAD a | 0.1 [5.2] | 24.3 [36.7] | 34.3 | 129 | 652 |
  | HEAD b | 0.1 [6.4] | 20.5 [35.1] | 51.9 | 113 | 568 |
  | fix a | 0.9 [5.3] | 16.9 [99.9] | 44.0 | 164 | 688 |
  | fix b | 0.9 [5.9] | 17.8 [104.6] | 43.8 | 221 | 649 |
  | fix, drain without the rest | 0.9 [5.9] | 18.0 [100.7] | 43.4 | | |
  | fix, rest without the drain | 0.8 [5.7] | 17.6 [95.0] | 17.0 | | |
  | fix, neither (the old harness) | 0.8 [5.6] | 49.6 [130.8] | 35.7 | | |

  - "Brush dab + frame" and the dabs in the commit row's bracket **moved, by the frames**: since 28bfad0 those rows
    timed `layerDab` plus a blit of the cached scene. With the fix every dab's `draw()` rebuilds the scene again
    (0.9 ms, C5 (a)'s own "first dab plus its frame", 180.6 → 0.9 ms; the 60 dabs about 100 ms against 35).
  - **The commit itself did not move**: 16.9-18.0 ms on the fix against 20.5-24.3 on HEAD once the frames' backlog is
    drained first; 49.6-162 ms when it is not.
  - "Undo step" is one shot, not a median: 17-52 ms in these runs on both sides, 7.9-83 ms in the C6 runs.
  - "Stroke across the picture" (113-221) and "its commit" (568-688) stay inside the spread of these runs and of the C6
    runs before them (113-193 and 517-698).
  - No mirror: the new step checks it on tiles for every stroke but clone, and the preview step checks mirror and
    pyramid.
- **Seen on the way, not changed here:**
  - On tiles the clone tool makes a display mirror of the layer during a stroke, before and after the fix; the step
    leaves clone out of its mirror check.
  - `rel-final-canvas`'s one failure of the preview step in the 0.1.13 runs (above: "157 levels on 66399 bytes", filed
    as a flake) reads like this bug's red, but the step cleared `sceneSig` then; not reproduced.
  - One canvas-backend run of the step, among seven with identical numbers, read different pixel counts on several rows
    (the rectangle's release changed 14,964 pixels instead of 44,591, and half way showed 202). A real mouse over the
    window during that run is the likeliest reading; the step now checks where the stroke's pointer is and says so.

---

## 2b. Phase R: Rust kernels, after C7 and before E (2 to 3 days)

Decided with the user on 2026-09-15: once C7 is closed (C6 (c) slices 3 to 7, C6 (d), C4, the rest of
§C7) and the user has tested the tile engine on their own 15k file, the kernels get a second, real
chance in Rust, **before** phase E builds its worker pool on them.

- **What exists.** Phase B's crate is in the history at **c75c4f1** (`crates/px/`: `Cargo.toml`,
  `rust-toolchain.toml`, `.cargo/config.toml`, `src/{lib,mip,edt,flood,composite,png}.rs`) with its built
  `renderer/editor/px/px.wasm` / `px_scalar.wasm`, the loader `px.js` and the benchmark `bench.js`; it was
  deleted from the branch after B3. `git checkout c75c4f1 -- crates/px renderer/editor/px/px.js
  renderer/editor/px/bench.js` brings it back. No Rust toolchain is installed on this machine by default
  (§B0 says how).
- **Why again.** B measured the kernels **in isolation** and decided JS (EDT band 2.0 to 2.2×, opaque mip
  chain 2.0 to 2.4×, against the 3× rule, `PERFORMANCE.md` §10). Since then the engine exists: mips run in
  a worker (`ChainScheduler`), the flood runs whole-picture in the worker (3.1 s at 15k), grow / shrink /
  feather go through the EDT band by band, and phase E will run every kernel per band in a pool. R measures
  the kernels **where they now run** (the `mips` worker job, the wand's flood, the EDT band, a composite
  band) and with tiles living in wasm memory, which B only sketched (B1's second bullet).
- **The decision rule stays B's**: Rust where a kernel is at least 3× its JS twin after the copy cost, on
  the real job; otherwise the JS kernel stays and R leaves only its table in `PERFORMANCE.md`. The binding
  findings of B hold: tile buffers on a 4 KB boundary, V8's efficiency mode slowing JS (not wasm) in a
  window that is not in front, tile size 256.
- **Gate**: `node tools/px_test.js` with the Rust kernels bit-identical to the JS twins, the tile gates
  (`run_gates.sh --tiles on pixels editor composite commands`) and `perf_test.py 15000x10000` A/B against
  the JS kernels, in the same session.

#### Phase R as built (2026-09-17): the kernels measured where they run

`docs/PERFORMANCE.md` §12 has the table. What was built: the crate back from c75c4f1 (`crates/px`, `tools/build_px.py`,
`px.js`, both builds, `bench.js`, `tools/px_bench.*`) with `clamp_extend` added (ABI 2); `tools/px_test.js` holds every Rust
kernel of both builds to its twin again, the memory cases included; the worker runs its mips, grow / shrink and flood jobs
and a new `band` job (a row of tiles composited, no caller yet) from `px.wasm` when `InpaintEditor.kernels === "rust"`,
and every such job replies with the milliseconds of its parts (`InpaintEditor.jobTimings`); `tools/px_jobs.py` is the
benchmark and the byte check of both kernel sets. `growMask` takes the twin `distTransform` (it still ran
`distanceTransform`).

**The outcome by B's rule** was JS for mips (1.2 to 2.1×), EDT (2.3 to 2.4×) and flood (1.3 to 1.4×) and Rust for the band
composite (4.85×). **The user replaced the rule on 2026-09-17: Rust wherever it is faster, however little.** So (R2) every
kernel runs from `px.wasm` by default through `px/kernels.js` (the JS twins as the fallback, `InpaintEditor.kernels = "js"`
forces them), in the window and in both workers; and (R3) the grow and flood jobs became one Rust call each
(`grow_mask`, `flood_shape`), because the loops around their kernels were most of the job. An instance grown past 256 MB
is replaced after the call, so a whole-picture flood does not keep its gigabyte. `deflate_zlib` left the crate
(`CompressionStream` is faster), `build.yml` checks the committed binaries against the source, and the node ships
`px/kernels.js`, `px/px.js`, `px/px.wasm`. Numbers in `docs/PERFORMANCE.md` §12.1: grow 1.8×, whole-picture wand 1.5×, mips
1.4× wall; E2 builds its band composite on `composite_tile` (6.1×).

Gates: `node tools/px_test.js` PASS (both builds, bit for bit), `tools/px_jobs.py` byte check PASS with three mutations
red, `run_gates.sh --tiles on` and `--tiles off` with `pixels editor composite shape nodecopy` (the `commands` gate forwards
an upload to ComfyUI, which the user needs; not run). `perf_test.py 15000x10000` A/B is not needed: nothing runs Rust by
default, and `px_jobs.py` is that A/B on the jobs.

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

#### E1 as built (2026-09-17): the arena under every tile, the pool under the mip chains

- **E1a**: every `scumble://app/` response carries COOP / COEP, the window is cross-origin isolated, `log_test.py` asserts
  it.
- **The arena** (`renderer/editor/inpaint_arena.js`): `newTile` takes its bytes from `allocTileBytes`. In the app that is a
  256 KB slot of a 64 MB `SharedArrayBuffer` chunk; in the node's tab (not isolated) an `ArrayBuffer` of the tile's own, as
  before. **One slot size**: masks are RGBA tiles until C5's one-channel masks exist, so the plan's 64 KB mask slots are not
  built. A slot goes back through a `FinalizationRegistry` on the tile object, not through a refcount per job: tiles are
  shared between pixels objects and undo steps and nobody frees one by hand, and a job that names a slot holds the tile
  object until its answer is in (the scheduler's batch does), which is the same guarantee. A chunk nobody uses is dropped
  (the workers are told), except the last one. When a chunk cannot be allocated the tile gets its own buffer (`refused` in
  `arenaStats()`). What changed for a shared view: `u32Of` uses the view's offset; `imageDataOf` copies the tile into one
  scratch `ImageData` (an `ImageData` cannot sit on shared memory), good until the next call, which its three callers
  (`putImageData` at once) satisfy. `texSubImage2D` never sees a tile's own bytes (the atlas uploads slot buffers with
  gutters), and the kernels copy into wasm memory (`set` takes a shared view).
- **The pool** (`renderer/editor/inpaint_pool.js`): up to `clamp(hardwareConcurrency - 2, 1, 8)` workers of
  `inpaint_worker.js`, **started when a job finds every running one busy**, not ahead of need (a small document in a
  ComfyUI tab keeps one); three priorities (`INTERACTIVE`, `NORMAL`, `EXPORT`), `run`, `map` (answers in order),
  `cancel(group)` (queued jobs rejected with a `CancelledError`, a running one's answer dropped), a timeout per job, a worker
  that fails is dropped with its job. Every worker gets the arena's chunks before its first job and each change after it
  (`{ op: "arena", added, dropped }`, no reply).
- **The chain transport**: the editor's `mipsTransport` goes through the pool at `INTERACTIVE` and says `arena` and
  `flights` (the pool's size); `ChainScheduler` then names a tile in the arena as `{ chunk, slot, vw, vh }` instead of copying
  it, and only copied tiles count against the small first batches. A transport without `arena` (the tests' own, the one mips
  worker behind `InpaintEditor.mipsOnPool = false` or `mipsOnSharedWorker`) gets copies as before. **A worker may read a tile
  the main thread writes meanwhile**: every write goes through `writable()`, which moves the version first, and `_land` drops
  an answer whose tile moved on, so a torn chain is never installed. The worker never writes a shared tile: the JS twin's
  edge chain extends a copy (`clampExtend` used to run in place on the job's buffer).
- The flood, the selection jobs, PNG encoding and the PSD / ORA writers stay on the one editor worker (the writers are
  stateful); they move in E2 / E4.

**Gates.** `pixels_test.js` `pool_chains_by_slot_and_by_copy`: 2,352 tiles (12544 × 12288) through 8 workers by slot and by
copy, byte for byte the same and the kernel's on a sample; an edge tile by slot with both kernels, the document's bytes
untouched; the queue's order (`cancelled, first, interactive, normal, export`), a failing job, `map`'s order, a pool of one
starts one worker. `editor_test.py` `arena_slots_come_back_when_tiles_are_collected`: 600 tiles, collected, every slot
back and no chunk kept. `a_whole_change_builds_its_mips...` no longer expects copy buffers in the scheduler's pool when
the transport takes slots. Run on `--tiles on`: pixels editor composite commands brush film log PASS; `--tiles off`: pixels
editor composite brush PASS; `nodecopy` PASS (the copy path, the two new files in the node build).

**Measured** (15000 × 10000, this machine, 8 workers, the user's ComfyUI holding the card):

| | before E1 (phase R, one mips worker) | E1 |
|---|---|---|
| 2,352 chains through the pool, by slot: wall [blocked] | | 59 ms [5.5] |
| the same by copy: copies made here + wall | | 123 ms + 78 ms |
| `perf_test.py` mips settled after a whole change, fit: wall [longest block] | 394 ms | 169 ms [92] |
| the same at 1:1 | 320 ms | 138 ms [86] |

**The gate's two numbers**: the chains themselves are in budget (59 ms, 5.5 ms blocked). The document's refresh is **at the
edge of the 150 ms (138 to 169) and not within the 5 ms blocked**: the 86 to 92 ms block is the frame the landings cause
(the atlas slots with their gutters built and uploaded on the main thread, the thumbnails), which was 94 to 132 ms before
E1 too; with eight workers the landings arrive together, so it is one block instead of several. Building the slots in the
worker (it has the tile by slot now) is the way down and is not built.

**Seen once, not reproduced**: `a_settled_read_builds_its_levels_in_the_worker_not_here` failed with `requested: 0` in one of
five editor runs on E1 (`--tiles on`); the four others passed. Re-run before believing it.

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

#### E2 to E5 as built (2026-09-17): bands through the region pass, files from the pool

**What was kept of the plan, and what was not.** The plan had a second compositor: `compositeBand` in the workers on
`composite_tile`, filter layers in a GPU worker on an `OffscreenCanvas`, the colour match per pixel in the kernel. That
is a second walk of the layer stack, which CLAUDE.md names as where this design breaks, and every branch `drawLayer` has
(a scaled layer, a blend mode, a text layer, a pending transform, a colour match, 23 filters and the plugins' own) would
have needed a twin that gives Skia's bytes. **Built instead: a band is a region pass** at full resolution (`sampleRegion`
at scale 1, the pass the screen, the wand and `readBox` already use) with `boxReach`'s margin above and below, read on a
CPU canvas and handed to the pool, which does everything that is not compositing: PNG filtering and deflate, PackBits,
CRCs, hashes, PNG decoding. One compositor, one set of filter code, and the screen shows what the file holds. The price
is the region pass's speed on this thread (below); the plan's worker compositor stays the way to make plain stacks
faster, and the arena is what it would read.

**E2.**
- `renderer/editor/inpaint_png.js`: `PngStreamWriter`. A PNG's pixels are one zlib stream, and `CompressionStream` cannot
  flush, so it cannot be run in parallel (25 MB/s on one thread, §10: 24 s for a 15k picture). The px crate has
  **miniz_oxide** back (`deflate_part`: raw deflate, every part but the last ended on a **sync flush**, plus `adler32`):
  parts of about 8 MB are filtered (`png_filter_rows`) and deflated by any worker in any order and are one stream when
  written in order; the file is signature, IHDR, tEXt, an IDAT with the two zlib header bytes, each part's finished
  IDAT chunk (CRC made in the worker), an IDAT with the Adler-32 joined from the parts' own (`adlerCombine`), IEND, as a
  Blob of those pieces. Level 2: 84 MB/s a worker for 0.349 of the raw size (level 6: 13 MB/s for 0.327), and files
  less than half the size of the canvas encoder's (6.5 MB against 15.4 MB for the test document). `readPng` is the
  reader: chunk framing here, `DecompressionStream("deflate")`, the five row filters, every colour type at 1 to 16 bits,
  `tRNS`; interlaced files are refused. Held against the browser's decoder byte for byte.
- `renderer/editor/inpaint_bands.js`: **row sources** (`tileRows`: tile pixels, named by arena slot and read by the
  worker where they lie, held as a copy-on-write clone so a stroke meanwhile writes elsewhere; `bandRows`: a picture
  composited in bands; the editor's `canvasRows` for a canvas) and the writers over them (`writePng`, `PsdBandWriter`,
  `OraBandWriter`), with a bounded number of parts in flight.
- The editor: `uploadPixels` (layer and mask uploads of `syncLayers`, `uploadBase`), `encodeComposite` / `uploadComposite`
  (the PNG export, the flatten, which writes its new base from the same bands, the node's base upload), `bandPlan`,
  `readBand`. A band is composited into the pass's canvas and drawn into a `willReadFrequently` canvas that is read:
  a hundred `getImageData` calls on GPU canvases put Chromium's canvases in software. A change of the composite while
  bands are read restarts the read once and then fails it.
- A run (`stitch.js`): the crop box and the stitched region come from `readBox`, never from a whole flatten, and the
  selection is read in a window (`selectionWindow`: on tiles the box of the mask's pixels that are not zero) above 16 MP.
  Crop, masks and patch are byte for byte the whole-image way's (`export_test.py`).
- **Not built**: JPEG / WebP and the Size row through bands (they take the canvas path, and are refused above 268 MP);
  the uploads of the canvas-sized edits (resize, extend, merge into the base) still encode the canvas they drew.

**E3.** `reach` was the plan's `halo` already (C6 c1). What E3 adds is what made a reach impossible: a filter of the whole
picture took its geometry or its statistics from its input, so every pass had its own (the screen showed a vignette
around the view, a band would get a frame of its own). Now `info.full` / `info.origin` (`u_pictureSize`,
`u_pictureOrigin`, `pictureUv()` in plugin shaders) and `info.stats` (`wholeStats`, from a 256 px sampled pass of the
layers below, per composite version): the vignette, normalise, the film pack's frame, light leak and the look's halation
(1.2 % of the **picture's** long side; `reach(params, { width, height })`) are the same picture in every pass, have a
reach, and are exported in bands; bands grow with a wide reach (`bandPlan.rows`). No GPU worker: the filters run where
they always ran. `export_test.py` `filters_of_the_whole_picture_in_bands`: all 23 filters at 6000 × 4000 in bands against
the whole flatten, worst 1 level for the pointwise ones and the blurs, 2 where a contrast curve doubles the one level
the composite below differs by.

**E4.** `PsdBandWriter` gives `PsdWriter`'s bytes from row sources (a Rust `psd_pack_rows` held to the JS `packBits`; a
layer's channels become a Blob as soon as it is packed), `OraBandWriter` a stored zip of part-written PNGs with CRCs
from the pool. A layer on tiles at its own size without a mask is read from its tiles; any other is drawn into a canvas
of its size when its turn comes (one at a time), as before. 6000 × 4000, three layers: PSD 0.76 s (1.07 s before, on the
main thread), structure and records identical, pixels within the GPU canvas's un-premultiply (1 level on 343 bytes).

**E5.** `checkBaseSize` no longer stops at 268 MP (65,535 px a side and a gigapixel are what is left). A PNG above the
limit opens through `png_read` in a pool worker (bands back as `progress` messages, written with `writeRect`), and so do
the files of a restore. What else needed a canvas of the picture and was changed: the selection's PNG for the autosave
(now the box its tiles cover, `selectionBox`, or the whole mask written in parts), `select_rect` / `select_all` (a fill
of a box), the run's selection read. Above the limit `bandPlan` and `readBox` take a **loose** reach (no whole flatten
exists to fall back to: a colour-matched layer is matched with the statistics the screen uses, a scaled layer resampled
per band), and `flattenToCanvas` and `makeCanvas` refuse with a message instead of handing out a canvas that draws
nothing. New arena chunks are not zeroed a second time (a memset of the whole document when one is opened).
`--no-comfy` (`run_gates.sh --offline`) keeps a test instance off the server, so uploads of this size are not forwarded.

**Gates** (`--offline`, tiles on unless said): `export` (the 6000 × 4000 document: PNG parts, bands against the flatten,
every filter, a run's box, PSD and ORA, the flatten), `huge:30000x20000`, `pixels editor composite commands shape brush
film glb ailabel size transparent generate log mcp nodecopy toapis llm pxjobs` PASS; tiles off: `pixels editor composite
commands shape brush film glb ailabel size transparent generate` PASS. `node tools/px_test.js` PASS (the deflate parts
inflate as one stream with a valid Adler-32 in Node's zlib; PackBits equals the writer's). **Not run: `smoke`** (the
user's ComfyUI was in use), so the node's base upload in bands and a real run on the new crop path have not met a real
server.

**Measured** (this machine, 8 workers, the user's ComfyUI holding the card):

| | before | E |
|---|---|---|
| a full 15k paint layer as a PNG (autosave, upload): wall [longest block] | 1.2 s [186 ms] | 0.78 s [6 ms] |
| 15k composite as a PNG, 3 paint layers + levels | 3.4 s [2.4 s] | 6.2 s [0.7 s] |
| the same with the film look | 8.2 s [3.1 s] | 9.5 s [1.2 s] |
| 6000 × 4000 PSD, 3 layers | 1.07 s (blocked) | 0.76 s |
| 30000 × 20000 (600 MP): open from a 1.1 GB PNG | refused | 9.6 s [121 ms] |
| … PNG export / PSD export (3.7 GB) | | 10.5 s [199 ms] / 13.7 s [279 ms] |
| … pan, zoom, a stroke's frame; its release | | 0.1 to 1.8 ms; 55 to 77 ms |
| … grow 16; invert; invert back | | 48 ms [18]; 0.53 s; 1.2 s (blocked) |
| … restore from the autosave state | | 11.2 s [91 ms] |

**The plan's numbers that are not met**: the 15k film-look export in 3 s with 50 ms blocked (9.5 s, 1.2 s); 50 ms blocked
for the 30k PNG (199 ms); invert in 100 ms blocked at 30k (0.5 to 1.2 s). `docs/BUGS.md` has them with what would fix
them. Met: open ≤ 90 s (9.6), PNG ≤ 30 s (10.5), PSD ≤ 60 s (13.7), the screen within a frame, grow.

## 3b. Phase N: does a native Rust editor pay? (after E, 3 to 5 days of measuring, then the user decides)

Asked by the user on 2026-09-17 after phase R: would the editor be faster if **everything** were Rust (the interface, the
layers, the tile store, MCP)? The short answer given then: not the interface, the layer list, undo or MCP (microseconds to
a few milliseconds each), not the screen (the GPU draws it through WebGL; a native build would use the same card through
wgpu), and not the tile bookkeeping (a JS ↔ wasm call per small operation can cost more than it saves). What a native
editor would remove are **the browser's own costs**, and N measures what is left of them once phase E is built. **N builds
nothing**; it ends with a table, a recommendation and the user's decision.

### What is being weighed

1. **Pixel readbacks.** The whole-picture magic wand at 15k spends about 0.7 s in `getImageData` of the composite it floods
   and about 0.8 s in the answer's way back (`putImageData`, `transferToImageBitmap`, the write into the selection); grow
   reads its box out of a canvas (0.1 s). In a native editor pixels never live in a canvas.
2. **Memory limits of Chromium.** The renderer's cap (about 8 GB, from an issue, never measured here), 268 MP of Canvas 2D
   area, 65,535 px a side, a WebGL drawing buffer of about 33 MP, and wasm32's 4 GB per instance. Today they decide the
   largest document and how many large documents can be open (§5: phase D is not built).
3. **Copies.** One wand today goes canvas → ImageBitmap → worker canvas → ImageData → wasm memory → ImageData → canvas →
   ImageBitmap → main thread → selection tiles. Each hop of a 15k picture is 600 MB.

### What E (and D) already take away, so N measures after them

- E1's `SharedArrayBuffer` tile arena: workers read tiles without a copy (hops of item 3).
- E2's `compositeBand` from tiles: the wand, the bucket and the run's crop can read a band composite straight from the
  tiles instead of a canvas read back (most of item 1), exports never hold a full-size canvas (most of item 2's 268 MP).
- Phase D (not planned yet): tiles outside the renderer, which is the answer to the renderer's cap inside Electron.

### N1. The measurement (2 to 3 days)

- **Where the time goes**, on the rows people feel, at 15,000 × 10,000 and at E5's 30,000 × 20,000: open a file, the
  whole-picture wand, grow / shrink, a stroke and its release, pan / zoom at 1:1, export PNG and PSD, a provider run's crop.
  Each row split into (a) pixel work (JS or Rust), (b) browser boundaries (`getImageData`, `putImageData`,
  `createImageBitmap`, `drawImage` from a large canvas, structured clones and transfers, copies into and out of wasm),
  (c) GPU (uploads, readbacks, draws), (d) the rest (scheduler, layout, the main thread's own work). `px_jobs.py`'s `timing`
  parts are the start; the boundaries get the same timers.
- **The real memory limits** on the user's machine: the renderer's cap with typed arrays (allocate until it fails, in a
  test profile), the largest document the app opens with 1, 3 and 10 full-size paint layers, four 15k documents open at
  once, and the GPU process per document (§C7's gate, not met).
- **Copies**: the count and the bytes of every hop per row above.

### N2. The options, costed (1 to 2 days)

| option | what it is | removes | costs | risk |
|---|---|---|---|---|
| A. Stay | Electron + wasm kernels after E | what E removes | nothing | the remaining browser share stays |
| B. More Rust inside the app | the remaining hot paths as whole wasm jobs over tile memory (filters' CPU twins, colour-match statistics, feather, PackBits), read from the SAB arena | pixel work and the copies around it | days per path | small; the user's rule already asks for it |
| C. Native tile store | phase D with the store in a utility process or a `napi-rs` addon (Rust), the renderer holding only what is on screen | the renderer's memory cap | 2 to 4 weeks | IPC copies on promotion; two processes to keep consistent |
| D. Native editor | Rust + wgpu + a native UI (egui, iced or Slint), filters as WGSL, text through cosmic-text, brushes and shapes through tiny-skia or vello, no Electron | items 1 to 3 entirely | **4 to 8 months** for one person | brush and text look parity, the JS plugin API (needs an embedded JS engine or breaks), the ComfyUI node keeps the web editor (two editors, or the node frozen), Linux / Windows UI polish, re-deciding `CLAUDE.md`'s Electron decision |

Option D is the mega-sized part; A to C are not. Tauri is **not** an option for D's goal: it is a webview with the same
limits.

### N3. The decision

A recommendation written into this section with N1's table, by these questions:

- After E, what share of the wall time of the rows above is (b) browser boundaries? If it is small (say under a third on
  every row), A plus B is the answer.
- Does a document the user really works with (size, layer count, documents open at once) hit a memory limit? If yes,
  can C fix it? If yes, C before D.
- Only if a large share is left **and** C cannot fix the limits does D get its own plan (`docs/PLAN_NATIVE.md`: phases, the
  order, what ships in between, what happens to the node and the plugins), for the user to decide on.

Gate: the table in `docs/PERFORMANCE.md` (a new section), the recommendation here, the user's decision recorded in
`CLAUDE.md`.

#### N1 as measured, N2 costed, N3's recommendation (2026-09-17)

The tables are in `docs/PERFORMANCE.md` §14; the tools are `tools/native_test.py` (rows, split by a CPU profile of the
main thread, wrappers around the browser's calls and the workers' `timing` parts) and `tools/native_limits.py` (memory).

**N3's first question: after E, what share of the wall is browser boundaries?** Large on five rows at 15k: opening a PNG
59 %, grow / shrink 50 to 58 %, the whole-picture wand about 85 % (pixel work 0.6 of 4.2 s), PNG export 79 %, PSD export
64 %. Nothing on pan, zoom and a stroke's frames (0.1 to 2 ms). By the letter of §N3 ("under a third on every row") that
is not "A plus B" yet. **But the share is not the browser's price, it is this editor's path**: every one of those
milliseconds is the editor putting tiles into a canvas and reading them out again (`putImageData` of tiles into region
canvases, `getImageData` of composites, ImageBitmaps to the worker, a second read there). E did not take them away as
§3b expected, because E's bands are a region pass through a canvas and the wand, grow and the open path were not touched.
Since E1 the tiles are in shared memory and since R the kernels are Rust, so the same rows can run over tile memory in the
workers without a canvas. That is option B, and it removes what option D would remove on these rows.

**N3's second question: does a real document hit a memory limit?** No. Typed arrays end at 15.5 GB in the renderer (not
8), which is a base and 18 full paint layers at 15k, or four 15k documents with room for fourteen more layers. The one
case that does is 30k with more than three full layers (3.3 GB each). C would fix that and nothing else; it waits until
the user works at that size.

**N2, costed after the measurement.**

| option | removes, measured | costs | verdict |
|---|---|---|---|
| A. Stay | nothing | nothing | the five rows stay where they are |
| **B. The pixel paths over tile memory** | the browser's share of all five rows (list below) | **about 3 weeks** | **recommended** |
| C. Native tile store | the 15.5 GB cap | 2 to 4 weeks | not now: no document of the user's reaches the cap |
| D. Native editor | the same five rows as B, the cap, Canvas 2D rasterising (a stroke's frame is 1.6 ms today), WebGL's 33 MP buffer | 4 to 8 months, the plugin API, the node, the look of brushes and text | **not recommended**: B buys the measured part for a tenth of the time |

**B, as a list, in the order of what it buys** (each with its gate: the row in `native_test.py`, bytes equal to the path
it replaces):

1. **Exports: plain stacks composited in the pool from the arena** (`composite_tile`, 27 ms a tile row of four layers in
   R's table), the region pass kept for bands with a filter, a colour match or a blend mode. 15k PNG: 3.5 s, of which
   2.8 s are canvases; the deflate behind it is 9.6 s of CPU over eight workers, so about 1.5 s is the floor. This is also
   `docs/BUGS.md`'s "an export in bands is slower than the whole flatten". 3 to 4 days.
2. **The wand and the bucket over tiles in the worker**: the band composite from the arena, `flood_shape` on it, the
   shape written into mask tiles. 4.2 s today, 0.6 s of it pixel work; about 1.5 s expected (the composite of 150 MP is
   the new cost). It also ends the refusal at 30k after 4.6 s of work. 3 days.
3. **Grow, shrink, feather and invert on mask tiles from the arena** (no canvas on either side), invert in Rust in a
   worker. Grow 0.72 s, of which 0.32 s is the kernel. 2 to 3 days.
4. **`stitch.js`: `dilate` and the box blurs** as a running max / the EDT kernel that exists. 2.5 s of a provider run's
   crop, to well under 0.2 s. 1 day. The cheapest second on the list, and it blocks the window in one piece today.
5. **Opening a PNG**: the stream reader's inflate and unfilter in Rust (`png_read` is JS: 12 ms a megapixel), then decide
   by measurement whether every PNG goes through it (Chromium's decoder plus the reads is 21 ms a megapixel today).
   JPEG and WebP keep the browser's decoder. 2 days.
6. **One-channel masks** (C5's plan, not built): a whole-picture selection at 30k is 2.4 GB as RGBA tiles, and invert
   blocks 0.7 s there. 3 to 4 days.

**What B leaves to the browser, measured**: a stroke's Canvas 2D rasterising (1.6 ms a frame, release 77 ms), text and
shapes, the WebGL filters and their readback in exports with a filter layer, tile uploads on a far pan (11 ms a frame),
the 15.5 GB cap, wasm32's 4 GB per instance.

**Recommendation: A plus B, no C now, no D.** D gets its own plan only if, after B, a row people feel is still mostly
browser, or the user's documents reach the cap and C cannot hold them.

#### B item 4 as built (2026-09-17): the masks of a provider run

`stitch.js` `dilate` walked the whole radius for every pixel, twice, and `boxCol` read the mask with a stride of w.
Now `dilateMask` and `boxBlurs` are kernels (`px/kernels.js`, ABI 7): Rust `dilate_mask` (van Herk / Gil-Werman, the
vertical pass a row at a time) and `box_blurs` (the three passes of the gaussian in one call, f64 running sums in the
twin's order) in `crates/px/src/maskf.rs`, the twins in `kernels_js.js` (a monotonic queue per row, the columns as the
rows of the transposed mask; one running sum per column). **The same floats as the old loops, bit for bit**:
`node tools/stitch_test.js` holds `dilate` and `gaussBlur` to the loops they replaced (kept in the test), `node
tools/px_test.js` holds both Rust builds to the twins; a mutation of each (the queue's window, the column blur's edge,
the short windows at the ends of a line in Rust) turned its test red.

| 1,492 × 1,492 mask | old loop | twin | Rust simd |
|---|---|---|---|
| dilate by 47 (Node) | 370 ms | 43 ms | 19 ms |
| gaussian, three box blurs (Node) | 37 ms | 22 ms | 15 ms |
| **the row: a provider run's crop and stitch at 15k, 1,024 px selection** (`native_test.py provider_crop`) | 2,485 ms | 777 ms | **571 ms** |

**The 0.2 s of the list is not met.** What is left of the 571 ms: the kernels 206 (four dilations and five gaussians
over windows of up to about 2,000 px a side), per-pixel JS in `stitch.js` 190 (`colorMatch`, `stats`, `maskMax`,
`maskClamp`, `maskToCanvas`, 20 to 30 ms each), Canvas 2D 260 (`drawImage` 111 and `getImageData` 95: the region, the
resizes). It still blocks in one piece. The way on is the whole stitch in a worker, not more kernels; it is not on B's
list and waits for the user's word. Gates: `size transparent generate` on both backends, `pxjobs pixels nodecopy`, all
offline, ALL PASS.

#### B item 1 as built (2026-09-17): a plain stack is composited by the workers that pack it

- **`stackPlan`** (next to `boxReach`, the third walk of the stack): the base and every layer the composite shows, as
  `{ px, mask, x, y, alpha }`, or null as soon as one needs more than source-over of its own tiles at an opacity through
  a mask on its own grid: a filter layer, a blend mode, a colour match, a transform in progress, a live stroke, a scaled
  or fractional layer, a base that is not the document's size. `stackSource` checks that every tile is in the arena
  and holds copy-on-write clones, so the file is the picture of the moment of the call (no "the picture changed").
- **`stackRows`** (`inpaint_bands.js`) is a row source like `tileRows`: a part names, per store, the tile rows its image
  rows touch (and the row above, for the PNG filter). Layers with no tile there are left out of the part.
- **The worker** (`rowsOfStack`): the base's rows into a buffer, each layer's rows into a buffer of the same run (any
  offset, over the picture's edges, sparse), its mask's alpha as coverage, then **one `composite_tile` call over the
  whole run** (the kernel takes any pixel count), then `png_part` / `psd_part` as before. No canvas anywhere.
- Used by `encodeComposite` (PNG export, the run's base upload; not with `each`, which the flatten uses to take the
  rows on the main thread) and for the merged picture of PSD and ORA. `InpaintEditor.stacks = false` forces the bands.

| 15,000 × 10,000, base and a full paint layer (`native_test.py`) | before | now |
|---|---|---|
| export PNG (235 MB): wall / longest block / main thread idle | 3,510 / 191 ms / 9 % | **1,712 / 79 ms / 88 %** |
| export PSD (925 MB) | 3,861 / 147 ms | **1,253 / 69 ms** |
| compositing, summed over the workers | (2.8 s of canvases on the main thread) | 1.45 s of 12.9 s of `png_part` |

The PNG is now bound by the deflate (12.9 s of CPU over eight workers). **Against the flatten** (`export_test.py`
`a_plain_stack_is_composited_by_the_workers`, four partial layers, one masked off the grid, two over the picture's
edges): 4.4 % of the bytes one level apart, 9 of 25 million two levels, none more. Measured per kind of layer: the same
bytes as the GPU flatten for an opaque layer at 60 %, a masked one and a flat half-transparent one; one level on 3 to
10 % under soft alpha, never two; **a GPU and a CPU canvas of the same single layer differ by more** (two levels on 824
bytes). So the gate is two levels on at most 0.1 % of the bytes, not bytes equal. Three mutations of the worker (the opacity dropped, the mask dropped, a store's rows off by one) turned that step red. Gates on both backends, offline: `pixels editor composite commands film` and on tiles `export log mcp pxjobs nodecopy`, ALL PASS. **Not covered**: a document with a
filter layer, a blend mode or a colour match keeps the region pass (6.2 s at 15k with a levels layer, `docs/BUGS.md`);
blend modes in the kernel and a filter over worker-composited bands would be the next steps there.

#### B item 2 as built (2026-09-17): the wand and the bucket over tiles

- **`floodStack(sample)`** gives what the flood looks at as a stack plan: `stackPlan({ forRun: false })` for the image,
  or the active layer alone through its mask over nothing (`sampleRegion`'s two branches); null sends the flood the old
  way (a filter layer, a blend mode, a colour match, a scaled layer, the canvas backend, a document above the canvas
  limit). `floodRegion` holds the stack as clones for the whole click.
- **`floodOverTiles`**: one `SharedArrayBuffer` of the box (on the tile grid), filled by the pool, a tile row a job
  (`stack_into`: `rowsOfStack` straight into its part of the buffer, `INTERACTIVE`), then one `flood` job on it
  (`flood_shape`; the bucket's clip is the selection's tiles read by the worker as a store). No canvas, no bitmap, no
  `getImageData` on the way in.
- **The way out**: the bucket still takes the shape as a bitmap (it is drawn into a layer at an opacity and an
  operator). The wand asks for `out: "tiles"`: the worker cuts the shape into the tiles that hold any of it, and
  `applyTilesToSelection` writes them with `writeRect` (replace: after a `clear()`; add and subtract: merged with the
  tile that is there). No `putImageData`, no `drawInto` scratch.
- The coarse pass stays on a canvas of at most 2,048 px (10 ms).

| 15,000 × 10,000, base and a full paint layer (`native_test.py`) | before | now |
|---|---|---|
| wand across the picture (58,302,622 px selected, the same count and bounds): wall / longest block | 4,218 / 1,626 ms | **1,425 / 175 ms** |
| of it the flood job: read / flood / shape | 1,104 / 531 / 171 ms | 28 / 590 / 180 ms |
| main thread inside browser natives | 3,154 ms | 106 ms |

What is left: the flood itself (0.6 s, a quarter of it the copy of 600 MB into wasm memory), cutting the tiles (0.18 s),
writing 900 tiles into the mask on the main thread (the 175 ms block: `normalizeBlock` and `_putBlock`), the coarse pass.
**Gate**: `editor_test.py` `the_flood_over_tiles_is_the_flood_over_canvases` (layers off the grid and over the edge, a
masked one, replace / add / subtract / undo, every similar pixel, the layer as the source, the bucket in a selection:
the same selection and the same fill bytes as with `InpaintEditor.stacks = false`), and
`wand_and_bucket_flood_a_region_not_the_image` still holds the wand to a flood of the whole flatten, pixel for pixel. Three mutations (the cut tiles a row off, subtract that does not clear, a store's columns not moved to the box) turned one of the two red.
Where layers are partly transparent the composite under the wand can be a level off the canvases' (B item 1), so a
region's edge can move where a pixel sits exactly on the tolerance; `px_jobs.py --check` (a 35 % paint layer) still
gives the same selections.

#### B item 3 as built (2026-09-17): grow, shrink and feather on the mask's tiles

`selectionInWorker` first tries `selectionOverTiles`: the selection's box with its halo, put on the tile grid, goes to a
worker of the pool as a store (`storeArgs`; the mask is held as a clone); the worker reads the box from the arena
(`storeRows`), runs the job (`grow_mask`, or the browser's blur on an OffscreenCanvas for feather) and cuts the result
into tiles, comparing each as words with the tile it came from: **only tiles whose pixels changed go back**, an emptied
one as `{ empty }`. The main thread writes them (`writeRect`, `clear`). No canvas of the box, no bitmap, no scratch,
and no `blockEqual` over the whole box here.

| 15,000 × 10,000, a 6,000 × 4,000 selection (`native_test.py`) | before | now |
|---|---|---|
| grow +16: wall / longest block | 722 / 206 ms | **511 / 90 ms** |
| shrink −16 | 603 / 201 ms | **318 / 23 ms** |
| the job: read / kernel / cut | 155 / 315 ms, + 160 ms of canvases | 42 / 342 / 69 ms |

The EDT is now two thirds of a grow. **Invert stays where it is** (`sel.invert()` on the main thread, 0.2 s at 15k): its
result is every tile of the picture, and bringing 600 MB of tiles back from a worker costs more than the loop; it gets
four times cheaper with one-channel masks (item 6), or when workers may write tiles the main thread allocated for them.
**Gate**: `editor_test.py` `grow_shrink_and_feather_over_tiles_are_the_canvases`: grow, shrink and undo the same bytes and
bounds as with `InpaintEditor.stacks = false` (a hard rectangle, a soft radial blob, a block in the picture's corner);
growing a 2,048 px square writes its 17 edge tiles, not 81. **Feather is not the same bytes**: alpha up to 5 levels apart
on 0.8 % of the pixels (7 with a CPU canvas in the worker), colour equal wherever alpha is 32 and more. The blur is
Skia's on the GPU in both; the box it blurs lies on the tile grid here and tight around the selection there (that this
is the cause is not measured). The gate allows 8 levels. Three mutations (every tile sent back, the bounds left in the box's coordinates, an emptied tile not cleared) turned the editor gate red; gates on both backends, offline, ALL PASS.

#### B item 5 as built (2026-09-17): the PNG reader, and what N1 had wrong about it

**N1 called the stream reader's time "JS inflate". It is not**: `readPng` inflates through the browser's
`DecompressionStream`, natively and on another thread; what ran in JS was the undoing of the row filters. Timed now
(`readPng` returns `spent`, the worker's `timing` carries it): of 8.4 s for 600 MP, **3.8 s are the filters and the
RGBA rows, 0.14 s the delivery, and the rest is waiting for the inflater**, which hands over 2.4 GB at about 300 MB/s and
cannot be run in parallel on a single zlib stream.

- **`png_unfilter_rows`** (ABI 8, `crates/px/src/png.rs`, twin `pngUnfilterRows`): a band of lines undone in one call,
  Sub, Average and Paeth a pixel at a time with the channels side by side for pixels of 3 and 4 bytes, and 8-bit RGB /
  RGBA straight out as RGBA8. `readPng` collects a band of lines and calls it once. 256 rows of 15,000 RGB pixels, all
  Paeth, in Node: 30 ms against the twin's 71 (simd; the scalar build 44 against 48). `px_test.js` holds both builds to
  the twin (five filters, pixels of 1 to 8 bytes, the row above carried from call to call, an unknown filter type).
- **On the row it changes nothing that can be seen**: the 30k open is 10.6 s as before (8.4 s of `png_read` against
  7.4 to 8.1 s in earlier runs). The reader is bound by the inflater; the kernel only frees the worker's core. It stays
  because the user's rule is Rust wherever it is faster, and the twin is what it replaced.
- **What did move a row: every large plain PNG goes through the reader** (`hugePngSize`, `InpaintEditor.pngStreamFrom`
  = 32 MP; 0 turns it off). Through an image a 150 MP file was decoded, drawn and read back in 13 `getImageData` calls;
  as a stream a pool worker decodes it into tiles. Only files the reader reads exactly as the browser shows them: 8
  bits, not interlaced, and no `iCCP`, `gAMA` or `cHRM` chunk before the first `IDAT` (`pngIsPlainSrgb`), since the
  browser applies those and the reader does not.

| open a 276 MB PNG of 15,000 × 10,000 (`native_test.py`) | before | now |
|---|---|---|
| wall / longest block | 3,158 / 2,102 ms | **2,724 / 118 ms** |
| main thread inside `getImageData` | 1,717 ms | 0 |

**Gate**: `editor_test.py` `a_large_plain_png_opens_through_the_stream_reader` (the same base bytes through the reader
and through the image, partly transparent pixels included; a `gAMA` chunk or a size below the threshold keeps the
image), `export_test.py` `reader_matches_the_browser`, `px_test.js`. Mutations that turned them red: Paeth's second
tie, the gamma chunk ignored, a band's partial line dropped (a Paeth mutation of the first tie is equivalent: a tie
there means a = b). **Not done**: JPEG and WebP still open through an image and the reads (no reader of ours; a Rust
decoder would be the way), and a PNG with a profile does too.

#### B item 7 (agreed 2026-09-17, in place of item 6): the stacks `stackPlan` turns away

Item 6 (one-channel masks) is set aside: it pays at 30k, the user works up to 15k. What the user's documents hold is a
result layer with a colour match and often a film look, and those still take the region pass for an export and the
canvases for the wand. In this order, each with its row and its gate:

1. **Blend modes in `composite_tile`** (multiply, screen, overlay, darken, lighten, soft-light, hard-light, difference),
   Rust and twin, held to Canvas 2D within the levels two canvases differ by.
2. **Filter layers over worker-composited bands**: the stack below a filter from the workers into a shared buffer, the
   filter on the GPU as today, the rows read back once; no region canvases.
3. **A colour-matched layer**: its statistics from tiles, the match applied in the worker. Tied to the user's open
   decision (b) of C6 (c) 7c; ask before building it.

#### B item 7, part 1 as built (2026-09-18): the blend modes in `composite_tile`

- **The kernel** (ABI 9, `crates/px/src/composite.rs`, twin `blendOp` in `kernels_js.js`): ops 5 to 12 are multiply,
  screen, overlay, darken, lighten, soft-light, hard-light and difference (`OPS` carries the names a layer's `blend`
  has). The W3C formula in the kernel's premultiplied 8-bit integers: `r = mul255(sp, 255 − da) + mul255(dp, inv) +
  mul255(mul255(sa, da), B(cb, cs))`, never more than the alpha, `cb` the backdrop unpremultiplied as at the end; over
  an opaque backdrop that is `mul255(dp, inv) + mul255(sa, B)`. Soft-light's square root is a table of 256 16-bit
  values (`SOFT_D`, the same numbers in the crate and the twin), so no root is taken twice in two languages. The SIMD
  build takes four pixels at a time where all four backdrop pixels are opaque (seven modes; soft-light and every other
  block go the scalar way). A megapixel over an opaque tile in Node: multiply 2.2 ms against the twin's 22, overlay 2.7
  against 31, soft-light 12.9 against 32 (the scalar build 7.5 / 12.6 / 13.8).
- **`stackPlan`** no longer turns a blend mode away: an entry carries `op` (0, or the kernel's number), `holdStack`,
  `stackArgs` and `rowsOfStack` pass it on, and the worker hands `composite_tile` the ops instead of zeros. So the PNG
  export, the run's base upload, the merged picture of PSD and ORA, and the wand and the bucket take the worker path for
  such a document. `InpaintEditor.stackBlends = false` turns blend modes away again (the A/B switch).

| 15,000 × 10,000, base and a full paint layer in multiply (`native_test.py`, rows `blend_*`) | before | now |
|---|---|---|
| export PNG: wall / longest block | 3,416 / 157 ms | **1,786 / 36 ms** |
| export PSD | 3,756 / 164 ms | **1,187 / 70 ms** |
| wand across the picture | 3,937 / 1,206 ms | **1,088 / 112 ms** |

**Against the flatten** (`export_test.py` `blend_modes_are_composited_by_the_workers`: the four layers of the plain-stack
step, all in one mode, mode by mode): two levels at most in multiply, screen, darken, lighten and difference; three
levels on 66 to 382 of 25 million bytes in overlay, soft-light and hard-light, whose B has a slope of 2 to 4, so a
one-level difference below it is doubled. Mean 0.04 to 0.13 levels. The gate is three levels, and more than two on at
most 0.01 % of the bytes. `px_test.js` holds the twin to a plain reference and to both Rust builds bit for bit (every
mode, opaque and translucent backdrops, opacity, masks, tails) and to the specification's floats (1.5 levels over an
opaque tile). **The wand's region can end elsewhere than over the canvases.** Measured on a 15,000 x 10,000 gradient with
the benchmark's paint layer (35 % yellow) in multiply, both composites in one state (`E.stacks` off and on): one level
apart on 20 % of the bytes, never two, mean +0.009; the wand from the same click selects 40.5 million pixels over
tiles and 41.7 over canvases, its far edge 255 px nearer (11,364 against 11,619), which is one level of that gradient
under the multiply: the region ends where a pixel sits on the tolerance. At 6,000 x 4,000 the same document gives the
same selection both ways, and in normal mode the two composites are the same bytes. (The integer maths rounds B, the
two products and the sum; the shader rounds once. Exact 16-bit products, rounded once, would be the way to close it;
not built and not measured.) With flat colours the selection and the fill are the same bytes
(`editor_test.py` `the_flood_over_tiles_is_the_flood_over_canvases`, now with the patch in multiply too).
Three mutations turned a gate red: the twin's overlay with its arguments swapped and the SIMD screen without its
complement (`px_test.js`), the worker dropping the ops (the export step and the editor step). Gates, offline: tiles
`pixels editor composite commands film export log mcp pxjobs nodecopy`, canvas `pixels editor composite commands film`,
ALL PASS.

**Decided by the user on 2026-09-17: A plus B, no C, no D.** The user works up to about 15k, so item 6 goes last. Build
order: 4, 1, 2, 3, 5, 6.

---

## 4. Decisions in one table (for the session that builds it)

| Question | Decision | Why |
|---|---|---|
| wasm glue | none: `extern "C"` + `WebAssembly.instantiate` | no CLI version to pin, loads everywhere, tiles in linear memory anyway |
| wasm threads | no; one instance per worker, tiles copied in and out | shared-memory wasm needs nightly and the node's browser has no SAB |
| kernel language | **Rust wherever it is faster** (the user, 2026-09-17, replacing the 3× rule): `px/kernels.js` runs `px.wasm` in every thread, the JS twins (`kernels_js.js`, `floodMask`) are the fallback; whole jobs (`grow_mask`, `flood_shape`) are one call; `PERFORMANCE.md` §12.1 | `PLAN_TILES.md` §2, the 3× rule |
| tile size | **256** (B: a 400 px dab 1.6 ms of JS at 256 against 3.2 ms at 512; mips 1.14 against 1.30 ms per MP); tile buffers start on a 4 KB boundary | five mips to 8 px, 4 to 9 tiles per 400 px dab; 4K aliasing |
| alpha | straight in tiles, premultiplied inside kernels and shaders | PNG, ImageData, plugins are straight; the compositor already premultiplies |
| mip filter | alpha-weighted 2×2 box | no edge darkening; the one-time re-bake of `composite_test.py` refs |
| the flag | the backend of `LayerPixels`, never a branch at a call site | one migration to the facade (C1), the engine slots in behind it (C2) |
| Canvas 2D work | `drawInto(rect, fn)`: text, shapes, transform, dabs, clone / heal, GLB, label | their look does not change; a full-size scratch only for a discrete transform |
| dab rasterisation | Canvas 2D through `drawInto`, in C and E | the brush look and `brush_test.py`'s tolerance stay; a Rust dab is a later measurement |
| undo | copy-on-write tile refs, `frozen` counter | a step holds only what it changed; no PNGs |
| selection | `MaskPixels`, bounds from the tile set + border-tile scan | no readback of a GPU canvas ever again |
| mask tiles | RGBA in C2, one channel in C5 (with the selection as mask tiles) | callers draw red / white into masks until then (§C2 "C2 as built") |
| bounds from mips | no: exact per-tile extents of the border tiles, every allocated tile holds a pixel | the kernel's rounded alpha loses an alpha-1 pixel at the first mip |
| the flag's precedence | `--tiles` / `--no-tiles`, then `SCUMBLE_TILES`, then a boolean `tiles` in settings.json (the Settings › Rendering › Tile engine row writes it), else on, in the packaged app too since 0.1.13 (`electron/main/tilemode.js`, §C7 "the default, as built"); per editor, fixed for its life; the node: `localStorage["inpaint_canvas.tiles"]` | a computed default must never be written (`settings.set` stores the merged object); pixels of one editor must blit and restore into each other (§C2 "C2 as built", step b) |
| display in C2 | `canvasOf(px)` (the mirror on tiles) for everything drawn at once, `toCanvas()` for what is kept; level 0 refreshed from `displayRectSource` | a copy per frame rebuilt the pyramid and the texture map every frame; a draw from a changed CPU mirror into a GPU level cost about 100 ms at 48 MP |
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
| R (after C7, decided 2026-09-15) | 2 to 3 |
| E1 | 3 |
| E2 | 4 |
| E3 | 3 |
| E4 | 2 |
| E5 | 2 |
| E6 | 2 |
| N (after E: measure, cost, decide whether a native Rust editor pays) | 3 to 5 |

Fifty working days for one person on nothing else; ten weeks. C1 is the step most likely to
run over (277 sites, every one a coordinate system), and it is also the one that can ship
on its own at any point, because the canvas backend keeps the pixels identical.
