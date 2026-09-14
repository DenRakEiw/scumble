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
| mask tiles | RGBA in C2, one channel in C5 (with the selection as mask tiles) | callers draw red / white into masks until then (§C2 "C2 as built") |
| bounds from mips | no: exact per-tile extents of the border tiles, every allocated tile holds a pixel | the kernel's rounded alpha loses an alpha-1 pixel at the first mip |
| the flag's precedence | `--tiles` / `--no-tiles`, then `SCUMBLE_TILES`, then a boolean `tiles` in settings.json, else on in dev and off packaged; per editor, fixed for its life; the node: `localStorage["inpaint_canvas.tiles"]` | a computed default must never be written (`settings.set` stores the merged object); pixels of one editor must blit and restore into each other (§C2 "C2 as built", step b) |
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
| E1 | 3 |
| E2 | 4 |
| E3 | 3 |
| E4 | 2 |
| E5 | 2 |
| E6 | 2 |

Fifty working days for one person on nothing else; ten weeks. C1 is the step most likely to
run over (277 sites, every one a coordinate system), and it is also the one that can ship
on its own at any point, because the canvas backend keeps the pixels identical.
