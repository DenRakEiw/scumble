# Rust kernels: the build plan (Umbauplan, item 44)

**Status: planned 2026-10-23 against `dd61e97` on the branch `wasm-kernels`; K0a, K0b and K0c done 2026-10-23 (§7), next K1 (design `docs/PLAN_WASM_K1.md`).** The branch's
`renderer/` and `crates/` equal `main` at `7def997` plus `10b1a39`; the wasm ABI is 20 (`crates/px/src/lib.rs:47`,
`renderer/editor/px/px.js:14`). This file turns `docs/PLAN_WASM.md` (the ranking and its §5 "W0 as harvested") and the
W0 measurements of 2026-10-23 (`docs/measurements/w0_2026-10-23/`) into sessions. It joins six designs (the TIFF
reader, the PNG reader, select by range and its maps, the main-thread pixel loops, the brush and retouch kernels,
relight's march) and two critiques of them (feasibility; completeness and order), all made read-only the same day.
Every defect the critics found is folded in; what they refuted is dropped. Every effort figure is **inferred, not
measured**. Every line number is from `dd61e97`: grep the name before editing, earlier sessions move them.

**The user's decisions (2026-10-23):**
- **Rust wherever it is faster on the whole operation the user feels** (the wall time of the real job), however
  little; JS only where Rust is slower. The kernel time only finds where the time goes. (This answers the open question
  of `PLAN_WASM.md` §5.)
- **One bigger update:** many kernels developed on `wasm-kernels`, the intermediate commits and the measurement results
  pushed there, **one release at the end**, no small releases in between.
- **Test tiers** per CLAUDE.md "Working rules": pixel and data paths full (both backends, a mutation round, the 15k
  measurement), maps and selection normal.

## 1. The decision rule and the update's shape

### 1.1 What decides a route

1. **The median wall time of the whole operation**, at least three runs, each on a fresh instance, `--offline`, the
   window in front (V8's efficiency mode slows JS, not wasm, in a window behind: `docs/PERFORMANCE.md` §10), the A/B
   alternated in one session through the route map (§3.1).
2. **The tie rule:** when the medians differ by less than the run-to-run spread, Rust stays only if its kernel row is
   strictly faster; otherwise the twin. The same 15k row swings 2-3x between runs (wand across the picture 7,005 against
   3,142 ms wall, `w0-perf` / `w0-relight`), so one run decides nothing.
3. **Work on the window:** its wall is its longest block. A route that moves work onto the window reports both; it must
   not lengthen the longest block.
4. **Losers are routed, not deleted:** where the twin wins, `renderer/editor/px/kernels.js` routes that case (by mode,
   kind or size) to the twin with a comment citing the row, as `shadowMarch` does (`kernels.js:151-158`). An export no
   route uses is removed before the release (an ABI bump).
5. **Kernel rows, `PX_BENCH` rows and Node runs explain; they never decide.** Node ran about 40 % slower than
   Electron's V8 on the same relight row: never mix runtimes in one comparison.

### 1.2 The update's shape

- **Branch `wasm-kernels`, one session per sitting** (the user's rule since 2026-09-30): one row of §5, its commit, a
  folder `docs/measurements/<session>_<date>/` (raw logs plus `summary.txt` with the medians and the verdict), a row in
  a new `docs/PERFORMANCE.md` §16 "The kernel update", the hand-over line in CLAUDE.md "Where things stand", a CHANGELOG
  `## Unreleased` line for what the user notices; then **push the branch** (the user's decision, with
  `-c credential.helper='!gh auth git-credential'`), never `main`, no tag; then `/clear`.
- **Merge `main`** into the branch whenever main moves (as `dd61e97` did) and always before K40.
- **Stage by explicit path** and check `git diff --cached --name-status`: the checkout carries the user's untracked
  material and a modified `docs/TUTORIAL.md` that are not this plan's.
- **Stops** (§5): six points where the order is re-ranked from what was measured; the hand-over states the new order and
  the work goes on in it unless the user says otherwise.
- **Say the behaviour first** (memory note): a session that changes bytes the user can see (K14's sun, K37, K38, the
  optional P5, the TIFF quirk of question 6.4) states the effect in one plain sentence in the hand-over before it.
- **One release at the end** (K40, K41), only on the user's word, by `docs/RELEASING.md`.

### 1.3 Rules for every session

- Commit as DenRakEiw (`git -c user.name=DenRakEiw -c user.email=89697885+DenRakEiw@users.noreply.github.com`), no
  Claude trailer. Every app gate and measurement `--offline`; never the user's profile; one instance at a time.
- `python tools/build_px.py` after every `.rs` edit (a comment changes the bytes), then `--check` for both builds.
- `python tools/build_node.py --check`: the node ships `px/kernels.js`, `px/kernels_js.js`, `px/px.js`, `px/px.wasm`
  and the editor modules this plan touches (`tools/build_node.py:38-46`; `stitch.js` and `host.js` are app-only,
  `:35-37`). The node itself is built once, at the release.
- The mutation round runs on a copied tree (memory note `scumble-mutation-copy-tree`), Rust mutants rebuilt, a fresh
  instance per mutant (the renderer caches its modules); `git diff --stat` afterwards.
- Scripts with the Write tool, edits with Edit; check the 5-hour window between steps and stop at a committed state
  around 70-80 %.

### 1.4 Tiers

| What changes | Tier |
| --- | --- |
| A new, changed or removed Rust export | **full on the kernel:** the twin test on `px.wasm` and `px_scalar.wasm`, byte- or bit-exact, a mutation round on the kernel |
| A call site in a pixel or data path: file readers and writers, layer pixels, the compositor, stitch results, the liquify bake, dabs, frequency separation | **full:** the path's gates on `--tiles on` and `--tiles off`, a mutation round, the 15k measurement |
| A call site in maps and selections: range, wand, invert, combine, guided depth, relight's shadow maps | **normal:** one gate step on tiles plus the gates the change touches; the canvas backend only when its path changed |
| Routing between byte-identical implementations; harness rows | normal / light |

The range design labelled its sessions "normal"; its kernels are full by this table, its call sites normal.

## 2. The W0 numbers (15000 x 10000 unless named; 2026-10-23, offline, window in front)

All logs under `docs/measurements/w0_2026-10-23/`. `perf` rows print **blocked [wall]** (`tools/perf_test.py:432`),
except "full composite", which is the median [max] of three synchronous `flattenToCanvas` calls. The `w0-perf` stack
carries a `film.look` filter layer. "Inferred" marks every split no log gives.

| Operation | Measured (ms) | What is known of the split | Log |
| --- | --- | --- | --- |
| Open Scumble's own 15k PNG | wall 3,566, longest block 613 | `png_read` one job 2,448 (unfilter 1,080 with copies, delivery 10.5; inflate and framing about 1,360 inferred); window `_putBlock` 182 + `normalizeBlock` 111; mips 624 in 19 jobs; 546 of the block is `getProgramParameter` | `native_15k.log` open_the_file |
| `load_image` of that file by path | 2,821 | with the file read and the upload | `w0_bench_rerun.log` |
| JPEG load | 1,763 / 1,978 | not split (`image_read` reports decode / draw / read, never printed) | `w0_bench_rerun.log`, `w0_bench.log` |
| TIFF open (deflate + predictor, 79 strips, a noise picture) | 9,024; the PNG open in the same run 4,442 | not split; the codec inferred at 25-45 %; `loadTiff` also stores the picture as a PNG | `w0-tiff/tiffperf.log` |
| TIFF export (491 MB) | 6,226 | encode 4,289 (status line), about 1.9 s save outside it | `w0-tiff/tiffperf.log` |
| PNG export (235 MB; `saveExport` stubbed) | wall 2,070, block 46 | `png_part` 79 jobs 15,261 summed, compose 1,485 of it | `native_15k.log` export_png |
| PSD export (925 MB; `saveExport` stubbed) | wall 1,277, block 77 | `psd_part` 237 jobs 8,335 summed, not split | `native_15k.log` export_psd |
| Export with a depth limit (on a levels layer: the GPU limit, `limitAlphaRows` never ran) | composite_bands 1,746 / 79 blocked; layer_from_tiles 768; composite_canvas 3,669 / 2,480; layer_canvas 1,521; psd 1,967; psd_masked 2,295 | | `w0-limit/exportperf.log` |
| "Add the paint layer" (a harness canvas imported) | wall 1,326, block 1,198 | 160 `getImageData` 1,002 ms, 572 MB; the app's own *Add paint layer* reads nothing | `native_15k.log` |
| Select by range, depth, no snap | 1.4 s | 2,301 partial tiles; no main / worker split; rounded to 0.1 s | `w0-sel/selection.log` |
| Select by range, luma | 2.3 s | every tile full | `w0-sel/selection.log` |
| Select by depth with snap 50 | 1,291 | 40 of 2,360 edge tiles | `w0-edges/console.log` |
| Invert | native 285 wall = block; perf 295 [291] | loop 164, `tileExtent` + closure 60, `writable` 24 | `native_15k.log`, `w0-perf/perf.log` |
| Grow +16 / shrink -16 / feather 8 | 94 [748] / 55 [424] / 63 [524] | grow job: read 66, kernel 530, cut 109; shrink cut 100 | `w0-perf/perf.log`, `native_15k.log` |
| Bucket fill; in a 1000 px selection | 204 [667]; 194 [363] | not split | `w0-perf/perf.log` |
| Wand across the picture | native wall 2,164, block 676; perf 870 [7,005]; with relight 945 [3,142] | window "px kernels" 576 (a bucket that lumps `/px/`, `inpaint_raster.js` and wasm), flood 754, shape 223, `stack_into` 40 jobs 2,476 summed | `native_15k.log`, `w0-perf`, `w0-relight` |
| Wand on one object | perf 181 [451]; native disc 142 / 82 | | `w0-perf`, `native_15k.log` |
| JS against Rust, whole jobs | mips after a whole change wall JS 694 / Rust 929 (0.75x, kernel 995 / 531); wand object JS 158 / Rust 271 (0.58x, flood 3.1 / 6.3); wand band 2.4 MP JS 115 / Rust 158; wand band 15k JS 7,305 / Rust 2,498 (2.92x) | | `w0-pxjobs/pxjobs.log` |
| Full composite; PNG of the composite (Chromium's encoder) | 299 [2,794]; 20 [4,793] | canvas paths, no kernel helps | `w0-perf/perf.log` |
| Provider crop | wall 909, block 24, prep 259 | the stitch worker has no laps | `native_15k.log` |
| Frequency separation, a 4000^2 box | 2,762 | not split (the blur most of it, inferred) | `w0_bench_rerun.log` |
| Edgefit at 2048^2 | fit 172, warp 120 | | `w0_bench.log` |
| Stitch masks at 2048^2 | gauss 45, dilate 43 (Rust, with the mask build 6), the JS max + clamp 12 | | `w0_bench_rerun.log` |
| crc32 (JS, byte-wise) | 1.84 ms per MB | | `w0_bench.log` |
| Dabs on 256^2 | blur 11.9, sharpen 12.2, tone 0.48, sponge 1.44 | | `w0_bench.log` |
| `matchCanvas`'s CPU loop, 16.8 MP | 298 | the loop body copied | `w0_bench.log` |
| `mapHistogram` depth 4096 x 2731 | 8.7 first call, then cached | no kernel needed | `w0_bench.log` |
| Liquify | dab p50 at fit 1000 px 20.6; preview at 1:1 1000 px 20.8 / 32.6 / 98.7 (p50 / p95 / worst); land 37-116 | | `liquify_perf.log` |
| Relight kernels, 4096 x 2731, 4 taps 32 steps (Node) | point twin 3,876 / SIMD 4,821; spot 4,178 / 5,224; sun Rust 1,720 / twin 2,697 | | `px_bench_large.log` |
| Relight in the app, three lights | ticks only (filter slider 11.2); frame after a whole change at 1:1 486 with 2,376 chains built on the window (film.look: 47, 16); 192 px picture settled, block 848 | no row times the march | `w0-relight/perf.log` |
| Main-thread split per row | | | `native_15k.log` / `.json` |

## 3. Shared infrastructure first

### 3.1 One route map (K1)

Today `InpaintEditor.kernels = "js" | "rust"` (`renderer/editor/inpaint_jobs.js:28-29`) reaches the workers as one
global mode in every message (`:82`, `:132`, `:154`): it flips the mips and the composite together with the kernel
under test, which confounds a whole-operation A/B. Build once: `kernels.js` keeps `routes` (`{ name: value }`, e.g.
`flood: "auto"`, `inflate: "rust" | "native"`, `pngParts: "on" | "off"`, `relightStripes`, `march.point`), with
`setRoute(name, v)` / `route(name)`, carried by the pool's `defaults()` (`inpaint_jobs.js:132`) and the stitch worker's
messages, shown as `InpaintEditor.routes` for the harnesses. The global mode stays as the override. Every design's own
switch (`TIFF_INFLATE`, `setPngInflate`, `setMarchRoute`, `__bp.KERNELS`, `pngPartsFrom`, `relightStripes`) becomes an
entry of this map.

### 3.2 The instance lifecycle (K1; every later session inherits it)

- **Trap recovery.** The crate builds with `panic = "abort"` (`crates/px/Cargo.toml:23`); one index panic in a decoder
  traps the instance, possibly inside `dlmalloc`, and `kernels.js` keeps handing out the same `PX`. Decoders of file
  input are written so no index can panic (every bound returns a code), get random-byte fuzz cases, and on
  `WebAssembly.RuntimeError` the wrapper replaces the instance (as `kernels.js:50` does) and the call falls back to the
  twin.
- **Retention.** `PxArena.reset` keeps one chunk at the job's peak (`px.js:495-507`); `releaseIfLarge` acts only above
  256 MB (`kernels.js:20`, `:49-51`). TIFF bands would hold about 46 MB in each of 8 workers, a big blur brush 50-170 MB
  and a liquify window about 69 MB on the window. Add an end-of-operation release with a lower threshold, sized with the
  `mem:15000x10000` gate.
- **The window's release never ran.** It builds `new WebAssembly.Instance` synchronously on the main thread
  (`kernels.js:50`); Blink has refused synchronous instances of modules over 4 KB on the main thread before. K1 checks
  it once in Electron 44; if it throws, the window's release becomes async (`PX` null so the twins run, the new
  instance swapped in when `WebAssembly.instantiate` resolves). K27 (frequency separation, about 640 MB) and K39 (the
  grow fallback, about 1.5 GB) wait for this.
- **Resident data.** `_resident` keys by array identity and never frees (`px.js:313-322`): one slot per kind, freed when
  its key changes (relight's depth, the TIFF palette). Round-trip tables posted with every job go through the
  deduplication of `RESAMPLE_RT` (`inpaint_worker.js:768-775`), never one `_resident` per job.
- **Views.** Take every block first, then the views; read `u8()` again after any kernel call that may allocate; never
  pass a view of wasm memory into code that calls kernels (`compositeTile` inside `rowsOfStack` resets the same job
  arena).
- **Losing routes.** Whatever makes the mips and the small wand lose (§4.1) is fixed or routed here, before any new
  kernel is judged by the same rule.

### 3.3 Shared Rust pieces

- **One inflate** (`crates/px/src/inflate.rs`, K2): `inflate_z(src, len, flags, out, cap, need) -> isize` over
  `miniz_oxide` 0.8.9's `decompress` (already in `Cargo.lock`), flags for zlib header or raw, more input, and the Adler
  ignored once `need` bytes are out; the decompressor on the stack (about 11 KB of the 1 MB stack), never boxed per
  call; negative codes, never a panic. Used by TIFF (K16), the PNG parts (K7), the PSD ZIP channels and deflated ORA
  entries (K20). One A/B against `DecompressionStream` decides Rust or native once for all of them (Stop 2): whole
  strip, per part, in 1 and 8 workers. Native won the only deflate A/B so far, at 0.71x (`docs/PERFORMANCE.md`
  near 1149 and 1199).
- **crc32** (K3): an own slice-by-16 table (no new dependency: `tools/build_px.py:55` builds `--locked`; SIMD128 has no
  carry-less multiply, so the table is the ceiling) and `crc32Combine` in JS (zlib's GF(2) method).
- **One generic box pass** (K4): `maskf::box_rows` / `box_cols` (`crates/px/src/maskf.rs:80`, `:97`) made generic over
  a channel count C and `Norm { Div(f64), Mul(f64) }`, with f64x2 lanes. `box_blurs` (`:116`) keeps C = 1 and `Div` and
  so its bytes (px_test's `boxBlurs` cases). Users: the dab blur (K26, C = 4, `Mul`), the guided filter (K24), and
  through `box_blurs` the edges and stitch `gaussBlur`, haze, relight and depth.
- **Rounding helpers in one module:** `js_round` (half up, scalar and per lane: wasm's `f64x2.nearest` is ties-even),
  the `Uint8ClampedArray` store (`f64::round_ties_even`, NaN to 0), f32 stores `as f32`, ToInt32 through i64, no FMA;
  `exp`, `cos`, `sin` against V8 are settled by the twin test, and an exp-heavy path is routed by measurement.

### 3.4 Twin tests, benches, the ABI

- **`tools/px_test.js`** gains a helper that runs `px.wasm` and `px_scalar.wasm` against the twin on random, edge and
  fuzz inputs (odd `byteOffset` included), byte-exact for integers and bit-exact (u32 / u64 views) for floats; every
  allowed difference is a named rule with a count. `PX_BENCH` rows rotate the order, take medians, and add a cold first
  call on a fresh compile (V8 has no on-stack replacement for wasm, so a long first call may run baseline code).
- **A call counter per kernel** on the `Px` wrapper lets each touched gate step assert that the Rust path ran
  (relight's parity rule).
- **ABI:** each session that adds, changes or removes an export takes the next number at its commit (`lib.rs:47`,
  `px.js:14`, checked at `px.js:43`) and names it in the hand-over. `lib.rs`, `px.js`, `kernels.js`, `kernels_js.js`
  and `px_test.js` are merge points: one session at a time.

## 4. The clusters

### 4.1 X: the Rust routes that lose today (K1)

- **Today:** after a whole change the Rust mips are faster as a kernel (531 against 995 ms) and slower as a job (929
  against 694 ms wall); three of four release runs were 0.57-0.64x (`PLAN_WASM.md:128-131`). The wand on one object at
  15k: Rust 271 against JS 158 ms wall, the flood itself 6.3 against 3.1; the wand band at 2.4 MP 158 against 115. At
  15k across the picture Rust wins 2.92x. Candidate causes (inferred, never measured): a fresh instance re-grown and
  zero-filled after every `releaseIfLarge`; long first calls on V8's baseline tier; transfers and scheduling. Every new
  kernel inherits whichever it is.
- **Build:** a worker-side split per job (copy in, kernel, copy out, `memory.grow`, a first-call flag) printed by
  `tools/px_jobs.py`; the route map (§3.1) with a size route for the flood (threshold measured) and for the mips if
  their cause is not fixed; per-worker instance policy (keep a grown instance up to a ceiling, or pre-size it; one small
  warm-up call at pool start); the window's release check and the end-of-operation release (§3.2).
- **Tests:** `pxjobs --check` (same bytes either way), `pixels`, `selection`, `export` on tiles; px_test for the trap
  recovery. **Measure:** pxjobs at 2048 x 1152 and 15k, the native wand rows, `mem:15000x10000` for the ceiling (8
  workers x the ceiling stays resident).

### 4.2 P: the PNG reader, inflate and crc32 (K3, K6-K8)

- **Today:** `pixelsFromPngStream` (`renderer/editor/inpaint_canvas.js:677-694`) runs one `png_read` job
  (`inpaint_worker.js:483-492` → `readPng`, `inpaint_png.js:201-362`): `DecompressionStream("deflate")` (`:218`), the
  lines copied (`:346`), `png_unfilter_rows` in Rust through `px.js:153-166` (`png.rs:152-207`). The upload is awaited
  before the decode starts (`inpaint_canvas.js:18349`, question 6.5). The reader checks no CRC (`inpaint_png.js:236`,
  `:245`, `:258`), so crc32 costs the open nothing. A document open repeats the job per layer of 32 MP or more
  (`inpaint_canvas.js:24379-24384`, `:24481`).
- **Scumble's own PNG can be read in parts.** `PngStreamWriter.finish` (`inpaint_png.js:159-177`) writes a 2-byte zlib
  header IDAT, one IDAT per part, a 4-byte Adler IDAT; every part comes from a fresh `CompressorOxide` (`png.rs:20`),
  every part but the last ends on a sync flush (`:21`), parts never cross a tile row (`inpaint_bands.js:158-165`,
  `inpaint_png.js:64-66`): 79 parts at 15k. Each part inflates on its own; it does not unfilter on its own, since row 0
  is filtered against the previous part (`png.rs:105-106`).
- **crc32** (JS, `inpaint_png.js:23-34`) runs per IDAT part in the worker (`inpaint_worker.js:427` → `pngChunk`,
  `inpaint_png.js:37-45`: about 430 ms summed at 15k, at most about 55 ms of the export's wall), per ORA entry on the
  export's tail (`inpaint_bands.js:420-424` → `crcJob`, `inpaint_worker.js:473-476`: about 430 ms, inferred) and as a
  copy in `inpaint_export.js:259-273`.
- **K3 (P1):** `crc32(src, len, start) -> u32` and `png_chunk_frame(buf, data_len, kind) -> u32` (length and type in
  `buf[0..8]`, the CRC after the data); `pngPart` (`px.js:445`) frames in wasm and returns `{ bytes, adler, raw, chunk,
  crc }` with `bytes` a subarray of `chunk` (`px_test.js:1926` keeps working); `inpaint_png.js:30` keeps its export and
  routes inputs from a cut-off the bench sets; `OraBandWriter._add(name, blob, crc)` takes the CRC the writer combined
  from its parts. The byte-wise loop moves to `kernels_js.js` as the twin.
- **K6 (P2):** SIMD Up (`u8x16_add`), Average and Paeth (bpp 3 / 4, channels in i16x8 lanes, `i16x8_abs`, the
  predictor picked with `v128_bitselect` in the standard's tie order a, b, c) inside `png_unfilter_rows`
  (`png.rs:122-146`), no ABI change, the scalar build unchanged. Paeth and Average stay serial per pixel, so only the
  channels go wide: K0 counts the filter types in Scumble's own files before anyone expects more than about 1.3x.
- **K7 (P3):** `png_part_lines_cap(w)`, `png_part_decode(src, len, w, last, prev, rt, lines, cap, out, info) -> isize`
  and `png_part_finish(lines, rows, w, prev, rt, out, info) -> isize` on the shared inflate: inflate, the whole-line
  check, unfilter, RGBA and the round trip without leaving wasm memory; `info` = rows, the Adler of the lines, the first
  filter, opaque, needs_prev; codes -1 grow lines, -2 corrupt or a distance before the part's start, -3 a sync-flush or
  final-block mismatch, -4 not whole lines, -5 unknown filter. The round trip is the window's CPU-canvas table
  (`inpaint_resample.js:165-183`; a GPU canvas's table differs on 450 pairs, `:161-163`).
- **K8 (P4), the parted reader:** `pngPartsOf(blob)` checks the layout with 8-byte reads (8-bit RGBA, not interlaced,
  the 2-byte header IDAT, the 4-byte tail IDAT, IEND; any other file returns null after one header read) and
  `readPngParts`. Worker ops `png_part_read` (a Blob slice in) and `png_part_finish`. Parts launch in order, at most
  pool size + 2 ahead of the unfilter chain's head; **finish jobs run at `INTERACTIVE`** so the serial chain never
  waits behind queued decodes (`inpaint_pool.js:19`, `:104`); the part Adlers join with `adlerCombine`
  (`inpaint_png.js:50-61`) against the tail; any failure cancels the group, releases the pixels and falls back to
  today's `png_read`. Rows land with `putCanvasRows` (`inpaint_tiles.js:1400-1404`; the stream reader runs on tiles
  only, `inpaint_canvas.js:18352`, `:24380`). The native route N is `DecompressionStream("deflate-raw")` per part with
  `03 00` appended to **non-last parts only** (the last already ends in a final block, and Chromium rejects bytes after
  it); R against N follows Stop 2 and is confirmed on `open_the_file`. `readPng` stays as the reader for other
  encoders' files and the reference.
- **Optional:** P5, the writer's independent part starts (`png_filter_rows` limits row 0 of a part to None or Sub,
  `lib.rs:308`, `png.rs:66-110`; question 6.1); P6, a sequential Rust stream reader for other encoders' files, only if
  K2 shows miniz in wasm at 0.7x of native or better.
- **Tests:** the pins `px_test.js:233-270`, `:1913-1947`, `editor_test.py:6672`, `export_test.py:64` and `:800`. New:
  crc vectors (`"123456789"` → `CBF43926`), continuation, combine with zero lengths; the frame against `pngChunk`; SIMD
  unfilter on rows of 1-67 px with forced ties (the Paeth second-tie mutant must go red); part decode against the twin
  for widths 1, 255, 257, 700, 4097 and first filters 0-4, with and without `prev`; a sync-flushed stream with a shared
  window must give -2; fuzz. Gate step `a_scumble_png_opens_through_the_parted_reader` (a size not a multiple of 256,
  half-transparent pixels, the same hash as `png_read` and the image; a browser-encoded file takes `png_read`; a part
  failing once falls back with the same pixels); `export` (both backends), `document`, `docux`, `huge` once.
- **Measure:** `open_the_file` (3,566), `w0_bench` `png_open` (2,821), `docperf:15000x10000` open, `huge` at 30k for
  time and memory, a browser-encoded 15k PNG, `export_png`, an ORA export row. Expected (inferred): `png_read`
  2.45 s → about 1.0-1.3 s on today's files (the finish chain stays serial), about 0.4-0.6 s with P5.

### 4.3 S: the selection loops: combine, the wand's cut, invert, the grow fallback (K5, K9, K11, K39)

- **Today:** the wand's main-thread tail (676 ms block) is `applyTilesToSelection` → `TileMaskPixels.combine`
  (`inpaint_tiles.js:2560-2624`) → `tilesSource.read` + `combineRows` (`inpaint_raster.js:458-525`, `:286-371`; the 576
  ms attribution is inferred until K0 splits native's px bucket by function, `tools/native_test.py:510`). A regression
  since F4b (`a48bf83`), when the worker's tiles were written directly (1,426 / 151 in `docs/PERFORMANCE.md`'s B table).
  The worker's cut (`floodOverTiles`, `inpaint_worker.js:716-765`, cut `:731-752`) allocates 2,000 RGBA tiles of 256 KB
  (shape 223 ms); grow's and shrink's job cut takes 100-109 ms. Invert (`inpaint_tiles.js:2507-2552`): the u32 loop 164,
  `bounds()` rescanning edge tiles through `tileExtent` (`:615-636`) 60, copy-on-write 24. The grow fallback runs
  `growMask` on the window (`inpaint_canvas.js:12366-12371`, `inpaint_raster.js:97-135`) only when both worker routes
  return null.
- **K5:** `sel_combine(dst, size, src, src_stride, src_kind, bw, bh, mode, rgb, ext) -> u32` and `alpha_any(...)` in
  `crates/px/src/sel.rs`, the maths of `combineRows` (mode order of `SEL_MODES`, `inpaint_raster.js:268`; `mul255`,
  `:271`) in u32x4 lanes, the extent written as `tileExtent` does. An optional `view(rx, ry, rw, rh)` on `tilesSource`,
  `bytesSource` and `rectSource` (`inpaint_raster.js:403-525`); `read` stays. In `combine`: full tiles and a replace
  from an all-255 source use a JS `u32.fill` (the pattern at `inpaint_tiles.js:2524-2525`); a missing tile runs
  `sel_combine` once into an arena block and calls `writable` and copies out only when it reports a pixel (no
  `alpha_any` then combine, which copied the source twice); add / subtract on existing tiles with an empty source still
  run (they recolour). `t.ext` / `extVersion` are set right after the kernel's write (`writable` bumps the version when
  called, `inpaint_tiles.js:994`).
- **K9:** `flood_shape` gains `out_kind` and `cells` (an ABI change; `lib.rs:196-221`, `jobs.rs:105-168`): the region
  as 255 / 0 bytes in place of the dead input, one byte per 256^2 cell; the worker cuts only occupied cells into 64 KB
  alpha tiles, which K5 combines as kind 1; the flood's size route from K1; grow's and shrink's job cut uses the same
  cells.
- **K11:** `mask_invert(tile, size, bw, bh, rgb, ext) -> u32` with the extent over the whole tile; the big-endian
  branch stays JS. The copies stream about 1 GB at 15k (2,015 tiles x 2 x 256 KB), so expect 100-150 ms, not 50
  (inferred).
- **K39:** the grow fallback through `growMaskBounds` (`inpaint_canvas.js:12369`) only after K1's window release check:
  it grows the window's instance to about 1.5 GB (`jobs.rs:52-63`), and a renderer that is killed is not a catchable
  "out of memory".
- **Tests:** the pins `pixels_test.js:2135-2153`, `:2310`, `:2376-2432` (canvas-cpu against tiles, exact),
  `combine_test.js`, `selection_test.js`, `editor_test.py:4588-4606`, `px_jobs.py --check` (`:198-210`),
  `px_test.js:546-562`. New px_test twins: modes x kinds 0 / 1 / 2 / 4 x partial tiles (152, 16, 1, 255), the extent
  against a fresh `tileExtent`, `cells` against a JS count; px_jobs steps `invert` and `wand_add`. Gates `selection
  pixels editor pxjobs nodecopy` on tiles; K39 adds an editor step that forces the fallback on its own instance.
- **Measure:** native `invert` (285), `wand_whole_picture` (2,164 / 676) and a profiled `wand_whole_add`, the perf wand
  rows, grow / shrink, and select by range again (Stop 3: its 1.4 / 2.3 s run through the same combine).

### 4.4 C: the compositor remnants, compose in wasm memory (K10a-c)

- **Today, no design yet:** `png_part` spends 15,261 ms summed at 15k, compose 1,485 of it, about 37 MB/s of raw pixels
  per worker against 84 MB/s for deflate alone (`inpaint_png.js:19`): about half is not deflate (inferred). `psd_part`
  spends 8,335 ms, not split; the wand's `stack_into` 2,476 ms. Around the Rust `composite_tile`: `rowsOfStack`
  allocates a buffer per layer per job (`inpaint_worker.js:239-293`), `storeRows` gathers tiles into rows in JS
  (`:200`), dissolve's `hash32` and `clipCoverage` run in JS (`:258-281`), `px.compositeTile` copies the destination
  and every source in and out (`px.js:366-387`), and `pngPart`, `psdPackRows` and `zlib` copy the rows in once more
  (`inpaint_worker.js:409-443`).
- **Shape:** gather the tiles straight into the job arena, composite by pointer, then filter + deflate (PNG), predict +
  deflate (TIFF) or pack (PSD) in place, one copy out; dissolve and the clip coverage in Rust with their twins. It
  serves the PNG, TIFF and PSD writers, the PNG store after a TIFF, PSD or ORA open (`uploadPixels`), the wand's box
  and the flatten bands. K3's framing and K15's `tiffStrip` take a pointer from this path.
- **K10a** writes the design into this section (anchors, signatures, ABI), light; **K10b-c** build it, full: `export`,
  `layered`, `composite`, `pixels` on both backends, a mutation round, the 15k export rows (`export_png`, `export_psd`,
  `exportperf`, tiffperf's export) and the wand row.

### 4.5 L: relight's march: stripes, then an exact f64 kernel (K12-K14)

- **Today:** `ensureRelightMaps` (`inpaint_canvas.js:23170`, loop `:23299-23390`) posts one `relight_shadow` job per
  light, never split (`:23337-23349`): point and spot run the f64 twin (`kernels_js.js:1535-1639`), the sun Rust's f32
  `shadow_march` (`crates/px/src/relight.rs:102-224`) through `px.js:229-243`, which copies the whole depth map per
  call. Lights march side by side on 8 workers, so a release waits for the slowest light: about 2.7-2.9 s in the app at
  4096 x 2731 (`docs/PERFORMANCE.md` near 1593; inferred as the felt wait). No app row times it. The relight stack also
  shows 2,376 mip chains built on the window after a whole change at 1:1 (486 ms frame; film.look: 47 ms, 16 chains):
  inferred, full marches at `NORMAL` hold the pool and `INTERACTIVE` mips cannot preempt.
- **K12 (stripes, JS only):** `marchOnPool(pool, args, { priority, group, stripes })` in `inpaint_relight.js` marches
  into one SharedArrayBuffer `out` (both kernels write at `row0 * w`: `kernels_js.js:1564`, `px.js:237-241`), with 2-4x
  pool size stripes of at least 32 rows (about 100 ms each, a mip waits at most one stripe). Only when `depth.buffer` is
  a SAB; the node build is not isolated and keeps one job per light. The quick depth on a SAB (`:23284-23291`); a group
  per march (channel + size + ticket); the queued stripes of a superseded full march cancelled, never a quick march's;
  the group cancelled when `pool.map` rejects (`inpaint_pool.js:66-68`); `CancelledError` silent at `:23374`; the
  worker replies `{ row0, rows }` without a transfer (`inpaint_worker.js:1207-1212`). The one-slot resident depth copy
  (§3.2) comes here, or the Rust sun's stripes copy 22 MB each.
- **K13 (`shadow_march_f64`, scalar, byte-exact):** f64 in the twin's order. Every `Math.hypot` of the twin depends on
  the tap, not the pixel (`kernels_js.js:1555`, `:1581`): JS computes `normL*`, `dLen` and `(dir / dLen) * sunDist` per
  tap with the twin's own expressions and passes them in (no replica of V8's hypot). The twin gets the same hoist,
  bytes unchanged, so the sun's A/B runs against that faster twin. Bounds as float tests, then `to_int_unchecked` and
  unchecked loads; a guard in `kernels.js:151` sends non-finite lights or coordinates of 2^30 and more to the twin.
- **K14 (f64x2):** adjacent pixel pairs in lanes with active / blocked masks in the twin's exit order; f32x4 is
  rejected (never byte-equal; one flipped tap is 64 levels at 4 taps). The sun takes the fastest of f64, f32 and the
  hoisted twin (question 6.6); the losing export goes (ABI).
- **Optional K-L4:** the threads spike (question 6.7): a third build `px_mt.wasm` (nightly `build-std` with atomics,
  `tools/build_px.py:25-26` has none), one shared 4 GB address space that never shrinks, at most the stripe overhead to
  win (about 2 %).
- **Tests:** today `px_test.js:413-449` allows 1 level on maps of 128^2 or less. New: byte-exact on 512 x 341 and
  1024 x 682 per kind, taps 1 / 3 / 4 / 16, steps 1 / 16 / 32 / 64, a light on a pixel, below the surface, off the map,
  the sun straight up and grazing; S stripes equal one call. K12: the `relight` gate on tiles plus a step "three nudges:
  only the last key lands"; K13-K14: `relight` on both backends, mutants (flip `>=`, drop `rdz >= 0`, steps off by one,
  a lane-mask error).
- **Measure:** new `op()` rows in `tools/perf_test.py` under `perf:15000x10000,--filter=relight,--map=4096x2731`: one
  light moved → shadows landed; three lights; a drag step's quick map; pan at 1:1 during a march (worst frame); the first
  march after start; plus the two chain rows above, which must not get worse. Expected (inferred): three lights about
  2.9 → 1.2 s, one light about 2.7 → 0.4 s.

### 4.6 T: the TIFF reader and writer (K15-K19)

- **Open today:** `pixelsFromTiff` (`inpaint_canvas.js:541-562`) runs one `tiff_read` job (`inpaint_worker.js:462-470`
  → `readTiff`, `inpaint_tiff.js:574-593`): per strip a `blob.slice().stream()` and a new decoder (`:374-386`,
  `:413-421`), JS LZW and PackBits (`:299-356`, `:270-293`), `unpredict` (`:389-402`, 16-bit through `DataView`),
  `converter` (`:504-566`). Then `loadTiff` stores the picture as a PNG (`uploadPixels`, `inpaint_canvas.js:18388`:
  `png_part`, a SHA-1 of the whole PNG in one worker, the mirror write), which the PNG open does not do. The codec is
  inferred at 25-45 % of the 9.0 s: K0 splits it before any kernel is judged.
- **Export today:** `encodeTiff` (`inpaint_canvas.js:17785-17825`) → `tiffPartJob` (`inpaint_worker.js:448-456`):
  `rowsOfStack`, `tiffPart` (`inpaint_tiff.js:610-625`, the JS differencing `:613-621`), `Px.zlib` at level 2; encode
  4,289 ms, about 1.9 s save outside it (§4.12).
- **K15:** `tiff_unpredict`, `tiff_predict_rgba` (SIMD prefix sums for 8-bit RGBA), `tiff_to_rgba` (every branch of
  `converter`; RGBA8 straight is a copy) in `crates/px/src/tiff.rs`. Unpremultiplying keeps the twin's branches (A = 0
  gives RGB 0, A = 255 passes, `:555-556`; no division by zero). The sub-byte palette quirk (`:536`: the alpha sample is
  left at 0..15) is reproduced unless question 6.4 says fix both. `TIFF_JS` exported from `inpaint_tiff.js`, which stays
  free of imports (`:3-5`; `tools/tiff_test.js:54-55` loads copies), the Rust set handed in as `kernels`; `px.js`
  `tiffStrip` must give exactly the bytes of `tiffPart(args, p.zlib)`; `tiffPartJob` uses it; `tiffKernels()` looks up
  `rustPx()` per call (the release swaps the instance).
- **K16:** `tiff_unpack(compression, src, len, out, need) -> isize` for none, LZW (tables on the stack), deflate (the
  shared inflate, the Adler ignored once `need` is reached) and PackBits; codes -1 to -6, the messages stay in JS. The
  twin's `unpackStrip` stops at `need` too (a stated change: an error after the picture's bytes no longer depends on
  where the pieces break). The LZW twin's first-piece bug (`:335-341`) is fixed with a test.
- **K17:** `tiffPlan` and `readTiffBand` (one `blob.slice(...).arrayBuffer()` per contiguous band). **Tiled files
  unpack and unpredict per tile** (`tiff_unpredict(tile, tl, tileRow, tw, ...)`, as the twin at `:467`) and scatter into
  rows afterwards (`:476-481`), never one unpredict over assembled rows. `streamed` and the band size are decided by the
  band's RGBA bytes (rows x width x 4, a band at most about 64 MB), not the raw strip size: a one-strip 1-bit 15k file
  is 19 MB raw and 600 MB RGBA. One-worker A/B on the five variants.
- **K18:** parallel bands: op `tiff_band` carrying only `plan.bands[i]` and the per-file constants (not 10,000 strip
  entries per job); `pixelsFromTiff` gains a `later` parameter; bands at `NORMAL`, so an open never queues behind an
  export's `EXPORT` strips (`inpaint_pool.js:19-21`, `:104`); `writeRect` as each band lands; on any band error the group
  is cancelled and the open falls back to `tiff_read`; a knob `InpaintEditor.tiffBandRows` for the gate.
- **K19:** the writer's deflate: Rust level 2 against `CompressionStream` per strip in the workers. `CompressionStream`
  has no level and runs 6 (13 against 84 MB/s for miniz at 2, `inpaint_png.js:19`), so the A/B changes file sizes: the
  user's call (question 6.3). The route without a pool stays native (a synchronous wasm deflate would freeze the
  window). Optional T6: streaming push kernels for single-strip files, only if K0 / K17 show them slow.
- **Tests:** `tools/tiff_test.js` (70 checks over 48 fixtures) once with `kernels: null` and once with the Rust set;
  px_test `tiffCases` byte-exact on both builds (unpredict widths 1-1001 and padded rows, 16-bit LE / BE; every
  `converter` combination; all 65,536 alpha / colour pairs and 16-bit values; LZW, PackBits and deflate streams, cut and
  damaged, from `node:zlib` at levels 0 / 1 / 6 / 9) plus a tiled predictor-2 fixture at 8 and 16 bits with a width not
  a multiple of `tw`, a one-strip 1-bit file, an Adler-only damage that opens on both routes, and fuzz. The `tiff` gate on
  both backends with several-band fixtures; its 15k compare (`tools/tiff_test.py:315-321`) becomes one row per band plus
  a hash of the whole picture.
- **Measure:** `tiffperf:15000x10000` gains `--variant`: Scumble's own TIFF of the 15k photo
  (`dist/daily/adobe_15000x10000.jpg`, `tools/w0_bench.py:32`) decides (the gate's noise picture makes deflate and
  inflate run on incompressible data), plus Pillow LZW (one-row strips), Pillow PackBits, tifffile zlib in one strip,
  uncompressed and the noise file; marks in `loadTiff` (info, pixels, stored, base, settled) and `exportImage`. Expected
  (inferred): decode 2-4 s → about 0.6-0.8 s, the open about 9 → 6-7 s unless K10 also shrinks the store.

### 4.7 D: the PSD and ORA readers (K20a-c)

- **Today, no design and no row:** `readLayered` (`inpaint_canvas.js:18399-18420`) reads the whole file into one array
  (`:18401`), inflates with `inflateBytes` (`DecompressionStream`, `:565`), runs JS `unpackRows`, `unpredict` and
  `interleave` (`inpaint_layered.js:68`, `:92`, `:179`) and the mask loop (`inpaint_canvas.js:18407-18409`), takes each
  ORA layer through `createImageBitmap` and `Layer.fromImage` (`:18415-18417`, a GPU readback, about 1 s per 150 MP like
  the paint-layer row) and then stores the base as a PNG (`:18443`).
- **Reuse:** `tiff_to_rgba`'s planar mode (its 16 → 8 `(2v + 257) / 514` equals PSD's `Math.round(v / 257)`), PackBits
  with per-row lengths (`packbits_rows`), the shared inflate, and the parted PNG reader (Scumble's own ORA layers are its
  parted PNGs). K0 adds the rows (Scumble's own 15k PSD of 925 MB and ORA, opened); K20a writes the design here (light);
  K20b-c build it (full: the `layered` gate on both backends, a mutation round, the 15k rows).

### 4.8 M: select by range and its maps (K21-K25)

- **Today:** `selectRange` (`inpaint_canvas.js:7281-7787`) finds edge rows (`rangeMax`, cached, already Rust; then JS
  `edgeTiles`, `inpaint_edges.js:553-594`), reads the picture of edge rows one tile row at a time (`:7377-7416`), posts
  one `range_select` job per tile row (`:7418-7433`) to `rangeSelectJob` (`inpaint_worker.js:879-1195`): a fresh 64 KB
  per tile (`:941`), `snapField` (`inpaint_edges.js:73-127`, 16 taps, two `exp` each) or `u16Bilinear`, `rangeWeight`
  (`inpaint_weights.js:48-55`), `Math.round`; luma and colour go in 1024-row bands of 61 MB (`inpaint_canvas.js:
  7468-7541`); the results combine band by band (`:7444-7464`). All 150 MP are computed whatever the result. Guided
  depth: `depthGuide` (`inpaint_worker.js:852-856`) → `guidedFar` (`inpaint_depth.js:269-303`): the box sums are Rust,
  but each of six calls copies a 44.7 MB plane in and out (`px.js:191-198`) and allocates a `tmp` (`maskf.rs:118`), the
  rest is JS; the window's grey loop and `disparityRange` block (`inpaint_canvas.js:13019-13026`). `limitAlphaRows`
  (`inpaint_limit.js:205-242`) runs only for fill layers in the layered export (`inpaint_canvas.js:15294-15317`) and was
  never timed.
- **Exactness:** f64 in the twin's order, `js_round` per lane, `u16 / 65535` as f64, `exp` settled by the twin test;
  where Rust's exp loop loses, a class sends the tile to the twin (`crates/px/src/range.rs`, `guided.rs`).
- **K21:** `map_tile_stats` (min, max and the edge flag per doc tile over a window copy of the rows one tile row can
  read, never the 22 MB map) and `rangeTileClass` next to `rangeWeight`: full / empty / compute, exact because the
  bilinear value and the snap are convex combinations of window texels. The cache key holds `thresh = Math.round(tau *
  65535)` and whether snap is on (`inpaint_edges.js:557`). **Rows that post no job add 255 per in-image pixel, the
  bounds and the tile count exactly as `inpaint_worker.js:993-1006`**, through one JS helper the window and the tests
  share: they drive "Selected N %", the hint, the touched bounds and the returned tiles (`inpaint_canvas.js:
  7735-7762`). The picture span is cut to compute-class edge tiles.
- **K22:** `range_tiles_depth` (no scratch; partial tiles copied out with `slice`; snapped tiles to the twin if the
  measurement says so). **K23:** `range_tiles_rgba` (luma through three 256-entry product tables, colour one `exp`; one
  15.4 MB tile row copied from the band, never the band).
- **K24:** `guided_far` with `guided_far_scratch_bytes` on the generic box pass (one channel, `Div`); `bilinearResize`'s
  `wx` stored as f32 while `fy` stays f64 (`inpaint_depth.js:164-195`); `Ip` and `II` from the raw `I` and `p` before any
  in-place box pass (`:218-224`); the grey loop and `disparityRange` move into the job. Relight's `detailRatio`
  (`inpaint_relight.js:1928-2030`) and haze's guided filter (`inpaint_haze.js:196-198`) reuse it only if a row shows them.
- **K25:** `limit_alpha_rows` in chunks of at most 256 rows, after question 6.2 (the export snaps by the fill's own
  colour, `inpaint_limit.js:233`; the GPU stage by the picture below, `:34-37`; a `col` pointer fits either answer).
- **Optional:** `fuse_tiles` (only at 50 ms or more measured); the canvas backend's range and the `logit` source
  (`inpaint_worker.js:1092-1181`).
- **Tests:** the pins `weights_test.js` §9-11, `edges_test.js` §1-4, 8, 9, 12, `depth_test.js`, `edges_test.py` case e
  (the selection's SHA-1 on tiles `ab46130a9a542201cd4ec8cb0855ce240658090b`, identical after every session),
  `selection_test.py` with the cancel case 12 (`:262-295`: its limit must still leave rows that post jobs),
  `limit_test.js` §9 and `limit_test.py` case 7. New px_test `rangeCases` / `guidedCases` on both builds: maps turned
  and flipped, docs not a multiple of 256, lo / hi on a tile's min / max and ±1 ulp, inputs that land exactly on a half;
  mutants halo 2 → 1, the 1e-12 dropped, `round` → `floor(x + 0.5)`, δ = 0.
- **Measure:** the selection gate's `seconds` is rounded to 0.1 s (`inpaint_canvas.js:7752`, `selection_test.py:326`,
  `:486`): K0 times in ms and prints `jobTimings`. px_jobs rows `range_depth`, `range_depth_snap`, `range_luma`,
  `range_color`, `depth_guide`, `fill_limit`; an `exportperf` with a fill layer and a depth limit (new code: `--filter=`
  takes a filter-layer id, `export_test.py:1287`).

### 4.9 B: brush and retouch: dabs, frequency separation, liquify (K26-K31)

- **Today:** `smudgeDab` (`inpaint_canvas.js:9517`) calls `toneRGBA` / `spongeRGBA` (`:9573`) or `blurRGBA` /
  `sharpenRGBA` (`:9574`) from `inpaint_stroke.js:80-173` on the window: about 37 ms per dab for a 400 px brush (450^2,
  inferred). Frequency separation (`inpaint_canvas.js:15068-15100`, capped at 16 MP) blurs at r = 40 and splits on the
  window: 2.76 s. Liquify: `LiquifyField.dab` (`inpaint_liquify.js:216`, Map lookups per node), `previewBlock`
  (`:522`) per frame, the bake `liquifyBlock` (`:347`) through `liquifyStore` (`:466`, which already takes a ninth
  `kernel` argument) in the pool (`inpaint_worker.js:808-850`).
- **K26:** `blur_rgba`, `sharpen_rgba` (`crates/px/src/stroke.rs`) on the generic box pass with C = 4 and `Mul(1 / (2r +
  1))` (the twin computes `sum * k`, `inpaint_stroke.js:47`, `:54`), the column pass over `w * 4` contiguous f64x2,
  clamped stores ties-even, every output byte written (the arena is never zeroed). `kernels.js` imports the twins from
  `../inpaint_stroke.js` (no cycle); `inpaint_canvas.js:28` imports from `./px/kernels.js`.
- **K27:** `tone_rgba` (a fresh 256-byte LUT per stroke, copied in, never resident), `sponge_rgba` (the `Infinity`
  branches of `lim`, `:173`), `freq_split` (the loop of `inpaint_canvas.js:15081-15089` moved verbatim into
  `inpaint_stroke.js` as the twin); L and Hi copied out before `writeRect`; the 16 MP call grows the window's instance to
  about 640 MB, so K1's release check first (or a ring variant of about 270 MB).
- **K28:** `liquify_block` sharing `resample.rs`'s tap sums (i64 colour sums, `div_euclid`, `resample.rs:107-120`),
  passed as `liquifyStore`'s ninth argument at `inpaint_worker.js:842-848`, `inpaint_tiles.js:1853-1870` and
  `inpaint_pixels.js:519-523`.
- **K29:** `liquify_preview` with the window kept in `px.alloc` memory. It is freed on every way a stroke ends (pointer
  up, Escape, tool switch, tab close, an error; `p.liqWin` is only collected today, `inpaint_canvas.js:11203`,
  `:11242`); the kernel runs on `win.px`, never `rustPx()`; the twin reads a fresh view if the mode switches
  mid-stroke. Normal tier: the bake decides the pixels.
- **K30:** the dense JS twin `liquifyDabNodes` with `dab(..., kernel)` and the thaw planes; the Map-based `dab` = the
  dense twin = (later) Rust, three-way equal; measured alone (Stop 6: it may win back most of the Map cost).
- **K31:** Rust `liquify_dab`; the swirl's `cos` / `sin` (`:251`) compared over its domain, swirl modes routed to the
  twin if any bit differs.
- **Tests:** `stroke_test.js` (35), `liquify_test.js` (42), the editor steps (`editor_test.py:9887`, `:9942`, `:10007`,
  `:8569`, `:9061`, `:9275`), the `brush` gate; px_test twins byte-exact (sizes 1 x 1 to 450^2, r 0 / 1 / 2 / 8 / 40 /
  200, alpha edge values, odd `byteOffset`).
- **Measure:** `tools/brush_perf.js` knows only smudge, clone and heal (`:10`): it gains blur, sharpen, tone and sponge
  at 50 / 200 / 400 / 1000 px, fit and 1:1; `w0_bench` freqsep with sub-timers; `liquify_perf.js` with the route switch.
  Expected (inferred): a 400 px blur move at fit about 74 → 15-20 ms; freqsep 2.76 → 1.0-1.3 s; liquify preview 21 / 33
  → 5-8 ms, dab 20.6 → 6-8 ms.

### 4.10 E: stitch and edgefit, one block (K32-K35)

- **Today:** `stitchJob` (`stitch.js:860-897`, in `stitch_worker.js`) runs per-pixel JS: `maskFromAlpha` (`:85-90`),
  `maskMax` / `maskClamp` (`:92-93`), `erode` (`:102-110`), `maskToCanvas` (`:211-223`), `selectionBbox` (`:225-245`),
  `alphaMask` (`:528-537`), `colorMatch` (`:543-566`), the align copy (`:616-619`) and the final alpha (`:653-657`); the
  default crop runs colour match and align, so `fitLayerRGBA` (`edgefit.js:356`), `warpRGBA` (`:317`) and
  `warpCoverage` (`:339`) run at `stitch.js:620-631` too. The mainloops design (its C6 / C7) and the strokes design (its
  R6 / R7) edit the same lines: one block with one laps session.
- **K32:** laps in every stitch reply first, then `alpha_to_mask` (`((v as f64) / 255.0) as f32`), `mask_max_clamp`
  (`Math.max` NaN and ±0 semantics; `out` may alias `a`, never `b`), `mask_one_minus` / `erode_mask` (the composition
  kept: `1 - (1 - x) ≠ x` in f32), `mask_to_rgba` (white, luminance, the alpha mode), `mask_bounds_f32`.
- **K33:** `color_match_rgba` (f64 totals, sequential in the twin's order, ties-even stores; untouched below 64) and
  `blend_alpha` (with the align copy as a mode).
- **K34:** `edgefit_shrink` (fused; `a[i]` is stored as f32 but `g[i]` uses the unrounded double alpha,
  `edgefit.js:65-67`), `warp_rgba`, `warp_coverage`, routed in `kernels.js` like `resampleBlock` (`kernels.js:54-59`):
  `edgefit.js` imports nothing, so no seam on `fitLayerRGBA` is needed.
- **K35 (conditional):** `edgefit_levels`, only if K34's split shows the 512^2 fit as a measurable share; then also
  `matchEdges` (`inpaint_canvas.js:5101`) and a new editor step for `match_edges`. Otherwise record "stays JS, measured".
- **Tests:** `stitch_test.js` with each replaced loop kept verbatim as the reference, f32 bit for bit;
  `edgefit_test.js` (9); `editor_test.py:11598`; gates `generate size transparent` on both backends.
- **Measure:** native `provider_crop` (909) with the laps; `w0_bench` `stitch_masks_2048` (its first run threw in
  `Px._in`, `w0_bench.log`; the rerun passed), a new `stitch_align_2048` (the whole `finishResult` with align) and a
  4096^2 row; `edgefit_2048` split into shrink, fit, warp, coverage.

### 4.11 F: the bucket and the fallbacks (K36-K38)

- **K36:** `composite_masked_tile` (`compositeStroke`'s per-tile body, `inpaint_tiles.js:1366-1390`, fused) switched in
  for the stroke release and `inpaint_canvas.js:11838`; full. K0 first splits the bucket (204 [667]) with a profiled
  native row.
- **K37:** the bucket over tiles: `bucketFill` (`inpaint_canvas.js:11612-11643`) today floods a bitmap and round-trips
  a canvas through `_scratchDraw` (`inpaint_tiles.js:1442-1485`); the tile route uses K9's alpha tiles as coverage and a
  solid colour when the layer is tile pixels at scale 1 with a whole offset. It may differ from Skia by up to one level
  at opacity below 1 (question 6.4); a size threshold if small fills lose.
- **K38:** `matchCanvas`'s CPU fallback (`inpaint_filters.js:281-290`, reached when `applyMatchGL` returns null,
  `inpaint_filters_gl.js:1213-1219`) through `matchPixels` (`kernels.js:121-124`) in 4 MP chunks; within one level of
  today's loop, toward the GPU's f32 formula (question 6.4); a `w0_bench` row `match_fallback_16k`.
- K39 (the grow fallback) is in §4.3.

### 4.12 What the W0 numbers show outside the kernels

- **The export save** (G2): about 1.9 s of the TIFF export's 6.2 s is `host.saveExport` (`host.js:4315-4318`:
  `blob.arrayBuffer()`, an IPC copy, the write); the native export rows stub it out (`tools/native_test.py:172-178`), so
  a PSD export (925 MB) likely costs about 3.7 s more than its row (inferred). K0 measures a real save; streaming
  finished parts to main is JS / IPC work (question 6.8).
- **The pool size** (G3): `min(8, cores - 2)` (`inpaint_pool.js:25`) on a 24-thread machine; an A/B at 12 and 16 with
  `mem:15000x10000` is one row (question 6.3).
- **The shader link** (G6): 546 ms of the open's 613 ms block is a synchronous `LINK_STATUS` read right after linking
  (`inpaint_compositor.js:279`, `inpaint_filters_gl.js:684`, `:1026`); compiling at start in parallel is not a kernel
  (question 6.8).
- **Printed in K0, then decided:** the filter program's split `prog.timing` (`inpaint_canvas.js:8694`) for the wand
  with a filter in the stack; JPEG's `image_read` times (`inpaint_worker.js:501-526`, likely "stays native").
- **No row, low priority:** the remaining `uploadCanvas` callers (Chromium's encoder in one worker,
  `inpaint_upload.js:42-45`, `inpaint_worker.js:549-552`; perf's "PNG of the composite"), the ONNX pre- and
  post-processing at 15k, JPG / WebP export (`toBlob`, `inpaint_canvas.js:17901`).
- **Corrections for K0c to write:** `PLAN_WASM.md` row 2 overstates the histograms (luma and colour work on 256 px
  samples, `inpaint_canvas.js:15630-15661`, `:15707-15735`; depth is 8.7 ms once); `tools/png_test.js` named at
  `PLAN_WASM.md:48` does not exist; the paint-layer row is a harness readback (K0 fills it through tiles and relabels
  it). The `depth` gate falls to `run_gates.sh`'s default branch (`:142`) and a missing `tools/depth_test.py` (only
  `depth_test.js` exists): a `docs/BUGS.md` entry, outside this plan.

## 5. Sessions

Efforts in days, inferred. "Full" / "normal" / "light" per §1.4; a full kernel session runs the kernel's twin test and
mutation round and the call site's gates at its own tier. Every session ends with `build_px.py --check` (when Rust
changed), `build_node.py --check`, its measurement folder, the commit and the push of the branch.

| # | Content | Tier | Effort | Needs |
| --- | --- | --- | --- | --- |
| **K0a** | Harness I (readers and writers): `spent` / `timing` splits in `readTiff`, `tiff_read`, `tiff_part`, `readPng`, `png_part`, `psd_part`; marks in `loadTiff`, `exportImage`; tiffperf `--variant` with the six files; a real `saveExport` row; JPEG `image_read` printed; PSD / ORA open rows; `w0_bench` rows `tiff_inflate_15k`, `tiff_rows_256`, `png_inflate_15k` (whole and per part, 1 and 8 workers), the PNG filter-type count; an ORA export row | light | 0.75-1 | - |
| **K0b** | Harness II (maps, tools, kernels): range in ms with `jobTimings`; native's px bucket split by function, `prog.timing`, profiled `bucket_fill` and `wand_whole_add`; stitch laps; `brush_perf.js` modes; `liquify_perf.js` switch; freqsep sub-timers; `stitch_align_2048`, edgefit split; `match_fallback_16k`, `grow_fallback_15k`; px_jobs rows of §4.3 / §4.8; relight rows of §4.5; the paint-layer row through tiles; the px_test twin helper, call counters, `PX_BENCH` rows | light | 0.75-1 | - |
| **K0c** | **W0b baseline** on one build: every §2 row and every new row, three fresh runs each, plus `docperf:15000x10000`, `huge`, `mem:15000x10000`; `docs/measurements/w0b_<date>/`; the corrections of §4.12 | light | 0.5 | K0a, K0b |
| **K1** | §4.1 and §3.1-§3.2: the per-job split, the route map, the flood size route, the instance policy, trap recovery, the end-of-operation release, the window's release check | normal (pxjobs `--check`, `pixels`, `selection`, `export` on tiles) | 0.5-1 | K0c |
| | **Stop 1:** re-rank §5 by K0c's shares and K1's result; the hand-over says the order | | | |
| **K2** | The shared inflate (§3.3), its fuzz cases and the A/B against `DecompressionStream` | full | 1 | K1 |
| | **Stop 2:** Rust or native inflate, once for TIFF, PNG, PSD and ORA | | | |
| **K3** | P1: crc32, `png_chunk_frame`, `crc32Combine`, the ORA entry CRC from the writer | full | 0.5-1 | K1 |
| **K4** | The generic box pass (`maskf.rs`), `box_blurs` bytes pinned | full | 0.5-1 | K1 |
| **K5** | S: `sel_combine`, `alpha_any`, `AlphaSource.view`, the extent cache | full kernel, normal call site | 1 | K1 |
| | **Stop 3:** select by range and the wand at 15k again (the combine may be most of range's 1.4 / 2.3 s) | | | |
| **K6** | P2: SIMD unfilter | full | 0.5-1 | K0c |
| **K7** | P3: `png_part_decode` / `_finish` on the inflate, no app routing | full | 1 | K2, K6 |
| **K8** | P4: the parted reader in the app, R or N | full | 1-1.5 | K7 |
| | **Stop 4:** question 6.1 (P5) and 6.5 with the user, with K8's numbers | | | |
| **K9** | S: `flood_shape` `out_kind` / `cells`, alpha-tile cut, grow / shrink cut | full kernel, normal call site | 1 | K5 |
| **K10a** | C: the design of compose in wasm memory, written into §4.4 | light | 0.5 | K0c |
| **K10b** | C: gather + composite + PNG filter / deflate by pointer; the PNG writer and store on it | full | 1-1.5 | K10a, K3 |
| **K10c** | C: PSD pack and the wand's box on it; dissolve and clip coverage in Rust | full | 0.5-1 | K10b |
| **K11** | S: `mask_invert` | full kernel, normal call site | 0.75 | K5 |
| **K12** | L: stripes, SAB `out`, the one-slot depth copy, march groups and cancels | normal | 1 | K1 |
| | **Stop 5:** the stripes' efficiency and the chain rows decide K13-K14 and the threads spike | | | |
| **K13** | L: `shadow_march_f64` scalar, the per-tap constants, the twin's hoist, the guard | full | 1 | K12 |
| **K14** | L: f64x2 lanes, the sun's decision (question 6.6), the losing export removed | full | 1 | K13 |
| **K15** | T: `tiff_unpredict`, `tiff_predict_rgba`, `tiff_to_rgba`, `tiffStrip`, `TIFF_JS` | full | 1 | K0c, K10b |
| **K16** | T: `tiff_unpack` on the inflate, the twin stopping at `need`, the LZW fix | full | 1 | K2 |
| **K17** | T: `tiffPlan`, `readTiffBand`, per-tile unpredict, the RGBA-size rule, one-worker A/B | full | 1 | K15, K16 |
| **K18** | T: parallel bands, `later`, `NORMAL`, the fallback to `tiff_read` | full | 1 | K17 |
| **K19** | T: the writer's deflate A/B (question 6.3); optional T6 | full | 0.5 | K15 |
| **K20a** | D: the design of the PSD / ORA readers, written into §4.7 | light | 0.5 | K8, K17 |
| **K20b** | D: the PSD reader (channels, PackBits rows, ZIP through the inflate, planar to RGBA) | full | 1-1.5 | K20a |
| **K20c** | D: the ORA reader on the parted PNG route, no GPU readback | full | 0.5-1 | K20b |
| **K21** | M: `map_tile_stats`, the classes, the skipped-row bookkeeping, the cut picture span | full kernel, normal call site | 1 | K5 (Stop 3) |
| **K22** | M: `range_tiles_depth`, the snap's route by measurement | full kernel, normal call site | 1-1.5 | K21 |
| **K23** | M: `range_tiles_rgba` (luma, colour) | full kernel, normal call site | 0.75 | K22 |
| **K24** | M: `guided_far` on the box pass, grey and `disparityRange` into the job | full kernel, normal call site | 1 | K4 |
| **K25** | M: `limit_alpha_rows` | full | 1-1.5 | K22, question 6.2 |
| **K26** | B: `blur_rgba`, `sharpen_rgba` | full | 1 | K4 |
| **K27** | B: `tone_rgba`, `sponge_rgba`, `freq_split` | full | 1 | K26, K1's release check |
| **K28** | B: `liquify_block` | full | 1 | K1 |
| **K29** | B: `liquify_preview`, the window in wasm memory | normal (twin test exact) | 1 | K28 |
| **K30** | B: the dense twin `liquifyDabNodes` | full | 0.5 | K29 |
| | **Stop 6:** the dense twin's numbers decide K31 | | | |
| **K31** | B: Rust `liquify_dab`, the swirl's routing | full | 1 | K30 |
| **K32** | E: stitch laps and the mask kernels | full | 1 | K0b |
| **K33** | E: `color_match_rgba`, `blend_alpha` | full | 0.75 | K32 |
| **K34** | E: `edgefit_shrink`, `warp_rgba`, `warp_coverage` | full | 1 | K32 |
| **K35** | E: `edgefit_levels` (conditional on K34's split) | full | 1 | K34 |
| **K36** | F: `composite_masked_tile`, `compositeStroke` on it | full | 1 | K0b |
| **K37** | F: the bucket over tiles (question 6.4) | full | 1 | K9, K36 |
| **K38** | F: the `matchCanvas` fallback in chunks (question 6.4) | full | 0.5 | K1 |
| **K39** | S: the grow fallback routed | normal | 0.25 | K1's release check |
| **K40** | Release block: merge `main`; the W0b chain again with `mem`, `huge`, docperf, every row compared with W0b and losers routed back; exports nobody routes removed; the full gate list on both backends; the exe gates; the node built (`nodecopy`, `build_node.py`, `node_test.py`) after scanning the shipped editor files for tokens a registry scanner reads as networking (`.listen(` flagged node 0.4.0, `10b1a39`); CHANGELOG, `docs/PERFORMANCE.md` §16, `PLAN_WASM.md` status | full | 2-3 | all built sessions |
| **K41** | The release chain on the user's word (`docs/RELEASING.md`) | - | 0.5 | K40 |

**Optional, not in the total:** P5 (0.5, question 6.1), P6 (1-1.5), T6 (1), `fuse_tiles` (0.5-1), the canvas backend's
range and `logit` (0.5), the threads spike (1-1.5, question 6.7), the non-kernel items of §4.12 (1-2, question 6.8).

**Total (inferred):** about 40-48 working days for K0a-K41 (48 sessions; the 1-1.5 d rows may take two sittings),
about 46-56 with every optional row. The order follows felt cost x frequency: the opens (PNG, then TIFF and the
layered files), the wand and the writers, relight, then range, the brushes, the stitch and the rare fallbacks. Three
chains are independent of each other once K1 is in (L: K12-K14; B: K26-K31; E: K32-K35) and may move up at a stop.

## 6. Open questions for the user

Each session that needs one names it and asks before it starts; where the user says nothing by then, the suggested
answer is taken and the hand-over says so.

1. **PNG parts that start independent (P5).** Every PNG Scumble writes gets new bytes, so each layer's upload name (the
   hash of its bytes) changes and it is uploaded once more; files stay standard PNGs. Suggested: yes, after K8 has
   measured the gain (expected about 1.0-1.3 → 0.4-0.6 s per 15k open).
2. **The snap colour of a fill layer's limit in exports (K25).** The export snaps by the fill's own colour
   (`inpaint_limit.js:233`), the screen by the picture below (`:34-37`); the snap defaults differ too (`:220` against
   `inpaint_canvas.js:7323`). Suggested: the picture below and the screen's defaults, so the PSD matches the screen; a
   `docs/BUGS.md` entry first.
3. **File size and cores.** TIFF strips through the browser's deflate (level 6, smaller, slower) or Rust at level 2
   (K19); a pool above 8 workers (§4.12). Suggested: keep level 2 and Rust unless K19 shows the native route faster at
   level 2 parity; the pool size as an A/B only, changed on your word.
4. **Byte changes of at most one level, and one fix.** The `matchCanvas` fallback (K38, toward the GPU's own formula),
   the bucket over tiles (K37, against Skia at opacity below 1), and the TIFF reader's sub-byte palette files with
   alpha, whose alpha is left at 0..15 today (fix it in both twin and Rust, or keep the quirk). Suggested: yes to K38;
   K37 only if the tile route measures faster; fix the TIFF quirk.
5. **Upload while decoding.** The PNG open awaits the mirror upload before it decodes (`inpaint_canvas.js:18349`);
   running both at once is JS ordering, not a kernel. Suggested: yes, in K8.
6. **Relight's sun in f64 (K14).** Today's f32 sun differs from the twin on rare pixels; f64 makes Rust and the twin
   give the same bytes, so those pixels change once against 0.1.50. Suggested: yes.
7. **The wasm threads spike (#7).** A third build on a nightly toolchain, for at most about 2 % on the march.
   Suggested: skip, unless K12's parallel efficiency is below 0.85.
8. **The non-kernel items in this update** (§4.12): streaming the export save to main, the shader link at start, the
   pool size. Suggested: the save and the shader link as their own sessions after K39 if K0c confirms their shares; the
   pool size as information only.

## 7. As built

### K0a (2026-10-23)

Built by a workflow of five builders on disjoint files and two checkers, against one contract of names; the main loop
reviewed the renderer diff and ran everything once at 15k (`docs/measurements/k0a_2026-10-23/`).
- **Worker splits** (all in each job's `timing`, summed per op by `native_test.py`): `tiff_read` gets `readTiff`'s new
  optional `spent` (parse, wait, decode, copy, unpredict, convert, deliver, bands, pieces, codec; its return value
  unchanged); `png_read` adds parse, read, write, wait, copy beside unfilter and deliver (feed and drain overlap);
  `png_part` adds rows, prev, copyIn, filter, adler, deflate, copyOut (`px.js` `pngPart`'s optional `laps`) and chunk;
  `tiff_part` rows, predict, deflate (`tiffPart`'s optional `laps`); `psd_part` rows, pack; `crc` read, crc. A new
  benchmark op `inflate_bench` (ranges of a blob through `DecompressionStream`, whole or one stream per range with a
  tail, the PNG filter-type count by `stride`).
- **Window marks:** `markStep(op, step, extra)` in `inpaint_jobs.js`, `InpaintEditor.stepMarks(reset)`; ops `tiff_open`
  (start, info, pixels {writeMs}, stored, base), `export` (start {fmt}, ready, encoded {MB}, saved), `layered_open`
  (start {kind}, read, parsed {inflateMs}, layers {maskMs, rgbaMs, bitmapMs, fromImageMs}, stored, base, added), `save`
  in `host.js` (start, bytes {MB}, written). A harness takes durations per op, a `start` opening a run.
- **Harnesses:** `tiff_test.py --size WxH --variant noise|own|lzw|packbits|zlib1|raw|all` (the gate
  `tiffperf:15000x10000,--variant,<v>,--out,<dir>` with commas, `run_gates.sh`; the files kept in `--out` and reused, so
  one variant per fresh instance shares them); `native_test.py` rows `export_ora`, opt-in `save_png|psd|tiff|ora` (a real
  export by path, `--out`, `--keep`) and `open_psd|ora|tiff` (the saved file, else the blob the export row kept, through
  `loadFile`), the marks printed per row; `w0_bench.py` rows `files_15k` (`--files`, default `dist/w0_files`),
  `jpeg_open_15k`, `png_inflate_15k`, `png_filter_types`, `tiff_inflate_15k`, `tiff_rows_256`.
- **Not as planned:** the ORA export row is `native_test`'s `export_ora`, the PSD / ORA open rows open the export's blob
  (the PSD cannot be saved: next point). `save_psd` at 15k ends the renderer (oom): `docs/BUGS.md` "Saving an export of
  about 0.7 GB or more"; so question 6.8's export save is a fix now, not an option, and needs the user's place in the
  order at Stop 1.
- **For Stop 1** (one run each; K0c decides): the 15k PSD open blocks the window 14.3 s in `readPsd` (cluster D, K20);
  every TIFF / PSD / ORA open spends 1.9-2.7 s in `uploadPixels`' PNG store, where `png_filter_rows`' filter choice
  costs as much as deflate (a candidate the plan does not list); JS LZW 6.7 s on a one-row-strip file (K16); `convert`
  0.5-0.7 s on plain RGBA8 and `unpredict` 0.6-1.1 s (K15); the browser's inflate about 560 MB/s per worker, 2.9x on
  8 workers (the bar for K2, and K8's native route); Scumble's PNG rows 76 % Paeth, 23 % Average (K6).

### K0b (2026-10-23)

Built by a workflow of seven builders on disjoint files against one contract of names, each harness smoke-run on its own
instance and port, and two checkers (renderer diff, harnesses; no musts, the shoulds fixed by hand); the main loop ran
the gates and every new row once at 15k (`docs/measurements/k0b_2026-10-23/`, `docs/PERFORMANCE.md` §16).
- **Call counters** (`px.js`): one counter per kernel export and thread at module level (they survive `releaseIfLarge`);
  `this.exports` counts, `this.raw` does not (`px/bench.js` uses `raw`); `pxCalls(reset)`, re-exported by `kernels.js`;
  `InpaintEditor.pxCalls(reset)` for the window. Workers reset at a job's start in an idle worker and put
  `timing.pxCalls` on every reply with a `timing`; the stitch worker puts `pxCalls` on its replies, and
  `prepareCropAsync` / `finishResultAsync` carry them on the worker route. The single editor worker can overlap jobs
  that wait (png, export) and then counts both: a gate step that asserts a Rust path uses a pool job, the stitch worker
  or the window. The wrapper costs about 6-16 ns per call (Node).
- **Window marks:** `range` (start {source, mode, snap}, per backend and source edges / posted / held / combined with
  readMs, loopMs, combineMs; done {ms, tiles, pct}, also {cancelled} on a cancelled run; `selectRange` returns `ms`),
  `program` (fillBoxFromStack's filter branch: done {bands, pool, upload, filter, read, rows}, {failed} when a band
  throws; a luma / colour range runs two such boxes side by side, so read each done's own fields), `freqsep` (start,
  read, blur, split, written, done), `relight_maps` (start {quick, lights, w, h}, landed {chan, quick, current, ms} per
  march, idle {quick} per layer; `relightMarching()` counts the marches in flight over all layers: wait on it, since a
  deep `releaseCaches` drops a layer's cache and its idle can come early).
- **Laps:** `cropPixels` / `finishPixels` / `stitchJob` / both async routes (keys per loop of §4.10, the encodes and
  decode); `fitLayerRGBA({ laps })` adds shrink, ring, fit (`fit` is fitEdges alone; the whole edge fit is the three).
- **Harnesses:** `native_test.py` (px bucket by function, per-row px calls, `wand_whole_add`, `bucket_fill` last of all,
  the paint layer through `writeRect`, the stitch laps on the provider rows, the program marks); `perf_test.py`'s
  relight rows under `--filter=relight` (memory read before them); `px_jobs.py` rows `wand_add`, `invert`,
  `range_depth`, `range_depth_snap`, `range_luma`, `range_color`, `depth_guide`, `fill_limit` (after the old rows of each
  round, which run as in W0); `selection_test.py` range cases in ms with jobs and marks; `export_test.py --fill-limit`
  (`--filter=` already took any filter type; now validated); `w0_bench.py` `freqsep_4000`, `stitch_align_2048` /
  `_4096`, the `edgefit_2048` split, `match_fallback_16k` (WebGL refused through `glContext().max` for the call),
  `grow_fallback_15k`, `--size=WxH`; `brush_perf.js` blur / sharpen / tone / sponge and `KERNELS`; `liquify_perf.js`
  `KERNELS` and `KEEP` (it now closes its document); `px_test.js` `twinCheck` / `twinRun` (simd and scalar builds against
  the twin, odd offsets, byte- and bit-exact, named rules; first users range_max, dilate_mask, box_blurs), the counter
  checks, `benchMedians` and `coldCall` under `PX_BENCH`.
- **Not as planned:** `relight_shadow` replies carry no `timing`, so a march's landed ms is post to answer; with the
  twins (`kernels = "js"`) a luma / colour range reads the picture on the window (`partsUsable` wants Rust), so its JS
  / Rust A/B compares two read routes; px_test's always-printed one-shot timings stay single calls.
- **For Stop 1** (one run each; K0c decides): the window's JS combine is 76 % of select by depth's 1.6 s and 40 % of
  luma's 2.3 s, and 0.4 s of the wand's 0.54 s block (K5 pays twice); a fill layer with a depth limit costs about 11.5 s
  of a layered export at 15k (`limitAlphaRows` on the window; a PSD 17.3 s; K25, after question 6.2); the bucket over a
  15k band blocks the window 2.0 s in getImageData (K37's tile route); frequency separation blocks 2.4 s, the blur 2.1 s
  (K26-K27); relight's full march is about 4.2 s per light in the app, not 2.7-2.9 (K12-K14); a 1000 px blur or sharpen
  dab costs 263-278 ms per move at fit (K26); stitch at 4096^2 spends most in colorMatch, blur, dilate, warp and the
  encodes, and the edge fit's shrink outweighs fitEdges (K32-K34); the grow fallback fits on the window at 15k (944 ms,
  K39 is no memory risk there); the first call of a freshly compiled px.wasm runs 1.8-2.2x the warm median (Node), and
  every worker compiles its own module: a measured candidate for K1's losing Rust jobs; wand_object still loses
  (Rust 0.89x).

### K0c (2026-10-23)

The W0b baseline on one build (`8b4324f`..`249d882`, K0b's harness): every §2 row and every K0a / K0b row three times,
each group on a fresh instance (offline, tiles, the window in front; `w0b_chain.sh`, 2 h 22 min), then `docperf`, `mem`,
`huge` (30000 x 20000) and the Node bench once; the medians by a workflow of six readers, a writer and a checker (70
numbers recomputed from the raw logs, all right; 15 prose claims corrected). Every run rc=0; `mem` prints a FAIL line
(the GPU process +354 MB over its baseline) under its "ALL PASS". `docs/measurements/w0b_2026-10-23/summary.txt` holds
every row's median, spread and earlier single run, "The shares for Stop 1" and the tie rule's candidates.
- **The corrections of §4.12:** `PLAN_WASM.md` row 2 (the histograms need no kernel; the cost is the window's combine and
  `limitAlphaRows`) and row 6 (no `tools/png_test.js`); the paint-layer row was relabelled in K0b; the `depth` gate's
  missing test is in `docs/BUGS.md`.
- **The shares (medians; the ranking by felt cost x frequency is inferred):** B the retouch dabs (blur / sharpen 79 / 82
  ms per move at 400 px at fit, 244 / 256 at 1000 px, on the window; freqsep 2,213 with the window blocked 2,179); S the
  wand across the picture 1,733, blocking 492 (combineRows 322), invert 212 all blocking; M select by depth 1,701 (the
  combine 1,264), luma 2,445, snap 2,856, and `limitAlphaRows` 9.7-11.0 s of a layered export with a depth-limited fill;
  P every 15k PNG open 3,076 (`png_read` 2,146 off the window; the open's 497 ms block is the shader link); L the shadows
  land 3,813 after one light moves, 5,106 for the first march; E the stitch finish 938 / 2,895 at 2048^2 / 4096^2; C
  the exports and the PNG store after a non-PNG open (about 2 s); T TIFF opens 4.5-13.7 s; D the 15k PSD open 12,987 with
  the window blocked 9,796; F the bucket over a 15k band 2,885, blocking 1,466. X: no A/B row loses outside its spread
  now (wand_object Rust 127 / JS 152), and px_jobs' mips rows are contaminated (queued jobs run in the new mode).
- **Rows to pin before they decide anything:** relight's chain rows did different work per run (62 / 60 / 483), so K12's
  "must not get worse" cannot be checked on them yet; the Rust wand's read and shape are bimodal; single long brush blocks
  (one 6,140 ms move of a 1000 px blur in r1).
