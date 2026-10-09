# Growing the Rust kernels (wasm) instead of rewriting the app

**Status (2026-10-09): planned, nothing built.** The user asked whether Scumble should be rewritten in Rust; the answer
(the same day) was no: the shell stays Electron (one Chromium on Windows and Linux, the ComfyUI window, the JS plugins,
the in-process MCP server, the Store package are all built on it), and **Rust grows where it already is: the pixel
kernels in `crates/px`, compiled to wasm**. The user: "schreibe auf den plan wasm kernel wachsen lassen" and "plane auch
was wir sinnvoll umbauen können". This file is that plan: what exists, which CPU paths are worth moving, in which
order, and the rules that keep pixels safe.

## 1. What exists

- `crates/px` (Rust 2021, `cdylib`, `miniz_oxide` + `adler2`, GPL-3.0) built by `python tools/build_px.py` into
  `renderer/editor/px/px.wasm` (SIMD128 + bulk memory, 120 KB) and `px_scalar.wasm` (the fallback, 107 KB); CI runs
  `--check` (the committed bytes must be what the source builds; a comment edit changes the bytes, panic locations
  carry line numbers, so rebuild after any `.rs` edit).
- 22 exports today: `match_pixels`, `dist_transform`, `flood`, `flood_shape`, `grow_mask`, `dilate`, `box_blurs`,
  `mip_half`, `mip_chain`, `chain_bytes`, `clamp_extend`, `deflate_part`, `adler32`, `filter_rows`, `unfilter_rows`,
  `lines_to_rgba`, `poisson_blend`, `pack_rows`, `pack_rows_cap`, `resample`, `smudge_dab`, plus the scratch
  management (`begin`, `apply`, `end`, `scratch_bytes`).
- Called from 19 renderer modules, in the two workers (`inpaint_worker.js`, `stitch_worker.js`) and on the main
  thread; the tiles are views on the `SharedArrayBuffer` arena, so a worker runs a kernel on the same bytes the
  main thread holds (a job's answer counts only if the tile's version is still the one it was made from).
- Measured wins so far (`docs/PERFORMANCE.md`): grow +16 on a 24 MP box 2.3-2.8×, wand across the picture 1.3-2.3×,
  mips 1.4-1.9×, the PNG and PSD writers' row filters and deflate in the worker pool.

**What is not a candidate:** the filters (WebGL2 shaders; the CPU twins exist for tests and the fallback), the
compositor's screen path (GPU atlas pages), the UI, the encoders already in Rust, the ONNX helpers (native
`onnxruntime-node`), and anything whose cost is the GPU readback rather than the arithmetic (`docs/PERFORMANCE.md`
"a readback costs whatever is queued before it").

## 2. The candidates, ranked

Rank by measured cost × how often it runs, with the current implementation, the expected gain (f32 / u8 loops on
SIMD128, measured on the kernels that moved already: 1.3-6×), the test tier (CLAUDE.md "Test by risk") and the test
that already pins the behaviour.

| # | Path | Today | Where it costs | Expected | Tier | Existing test |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **Edge snap and the guided filter**: `inpaint_edges.js` `snapField`, `gaussBlur`, `resampleBilinearF32`, `fuseTiles`, `rangeMax`; `inpaint_depth.js` `guidedFilter`, `guidedFar`, `bilinearResize`, `disparityRange`, `farU16` | JS f32 loops over maps up to `WORK_MAX` 4096² (16.7 M samples), several passes each | every depth compute and every edge / detail pass of release 2 (R2-S3: about 1 s on a 15k picture) | 3-6× on the f32 passes; the pass drops under the frame budget for 2k maps | normal (maps, not pixels; the map is recomputed, never the only copy) | `tools/edges_test.js` (11 cases), the depth gate; the GLSL twin `SNAP_GLSL` stays the reference the CPU kernel must match |
| 2 | **Histograms and range selection**: the range bar's depth / brightness / colour histograms, `select by range` and the limit's CPU rows (`inpaint_limit.js` `limitAlphaRows`) | JS per-pixel over the whole picture (153 MP on 15k) | every drag of the range bar recomputes a selection tint; the histogram once per picture | 2-4×; u8 SIMD counts | normal (selection) / full for the limit rows (they decide a filter layer's alpha) | the `selection`, `limit` and `maskview` gates |
| 3 | **The compositor's CPU band**: the blend modes and masks when the composite is read on the CPU (exports, flatten, the wand's coarse pass, `readBand` / `readBox`) | JS per pixel; 165 ms per 59-tile band on the CPU against 27 ms on the GPU | every export and flatten of a document with blend modes; the wand's coarse pass | 3-5×; and one rounding of exact products instead of three 8-bit roundings (CLAUDE.md "three 8-bit roundings") | **full** (pixels; both backends, the mutation round, the 15k measurement) | the `composite`, `pixels`, `export`, `layered` gates and `tools/pixels_test.js` |
| 4 | **Heal, liquify, frequency separation, dodge and burn**: `inpaint_liquify.js` `liquifyBlock` (displacement field + resample), the heal patch (`poisson_blend` is Rust already, the patch search and blend around it are JS), the frequency split's blur and subtract | JS; heal 204 ms at 400 px, the first stroke up to 1.7 s; liquify per block | per brush stroke, so it is latency the user feels | 2-4×; the first-stroke cost is allocation, not arithmetic (measure first) | normal (one undo step; the stroke is replayable) | the `brush` gate, `tools/liquify_test.js` if it exists, else one new step |
| 5 | **Edgefit** (`edgefit.js`: `shrinkPlane`, `edgeRing`, `blur121`, `erode`, the Lucas-Kanade iterations) | JS at a work scale, small matrices | once per inpaint result (item 42) | 2×, but the whole fit is a fraction of a second already | normal | `tools/edgefit_test.js` (9 cases) |
| 6 | **The PNG reader's row path** | the browser's inflater (`DecompressionStream`), then `unfilter_rows` in Rust already; `png_read` 7.4 s on a 1.1 GB PNG, one worker | opening big PNGs | a Rust inflater (`miniz_oxide` is in the crate) lets the worker pool inflate IDAT parts in parallel only when the file was written with sync flushes (Scumble's own PNGs are); other files stay sequential | normal | `tools/png_test.js` / the `document` gate |
| 7 | **wasm threads** (shared memory + `wasm-bindgen-rayon`): one kernel over all cores without the JS worker-pool choreography | the pool today: JS splits a job into tiles, each worker runs the kernel | the big single-call jobs (wand across the picture, grow, a histogram) | unknown: a spike with one kernel, measured against the pool | - | the gates of whatever kernel the spike takes |

Not ranked, cheap when a module is open anyway: `alphaOf` / `grayOf` planes, the matting's alpha scaling, the TIFF
reader's unpacking (`pack_rows` exists for writing).

## 3. The rules

1. **Measure before and after, on the same session** (CLAUDE.md "Testing and benchmarking"): restart the app, settle
   the mips, A/B in one state, the card free. A kernel that is not measurably faster on a 15k document stays JS.
2. **The JS kernel stays as the reference and the fallback**, like `px_scalar.wasm` beside `px.wasm`: a plain-Node
   test runs both on the same bytes and demands equality within one level (u8) or 1e-5 (f32), on random data and on
   the edge cases the JS test already has. The GLSL twins keep their own twin test.
3. **Memory:** kernels take views on the arena or on a scratch in wasm memory, never a copy of a whole 15k plane;
   a wasm memory growth invalidates every view, so the scratch is sized before the loop (`scratch_bytes`), and a
   worker never writes a tile it was given by slot (CLAUDE.md "Tile engine code").
4. **Both builds:** SIMD and scalar, `python tools/build_px.py --check` before the commit, the gate of the touched
   path on both backends only when the kernel decides pixels (tier full), on tiles only otherwise.
5. **One kernel per session**, its test, its measurement row in `docs/PERFORMANCE.md`, one commit. No rewrite of a
   module around a kernel; the call site changes, the module's shape does not.

## 4. Order (sessions, after the Nik 9 block or interleaved when a session is free)

- **W0 (half a day):** the baseline rows for #1-#4 on `scene.jpg`, `skin.jpg` and the 15k file, with the tile
  profiler, so every later row has its "before"; a note in `docs/PERFORMANCE.md`.
- **W1:** #1, the f32 map kernels (`snapField`, the guided filter's box sums, `gaussBlur`, the bilinear resample),
  because release 2 runs them on every edge pass and they are self-contained f32 loops with tests.
- **W2:** #2, the histograms and `limitAlphaRows` (u8 counts and masks).
- **W3:** #3, the CPU blend band (full tier; the rounding question settled by measuring against exact floats first).
- **W4:** #4, the stroke kernels, each after a measurement that says where the time goes.
- **W5:** #7, the threads spike on one kernel; the decision whether the pool stays.
- #5 and #6 when their modules are open for another reason.

About 1-2 days per kernel including the measurement; W1-W3 are the ones that change what the user feels.
