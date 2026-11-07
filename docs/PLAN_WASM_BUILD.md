# Rust kernels: the build plan (Umbauplan, item 44)

**Status: planned 2026-10-23 against `dd61e97` on the branch `wasm-kernels`; K0a, K0b and K0c done 2026-10-23 (§7); K1a and K1b (K1's build, its measurements and defaults) done the same day; Stop 1 done and answered by the user 2026-10-24 (§7); G2 done on `main` and released as 0.1.51 2026-10-24; #0, D0 and K5 done 2026-11-06 (§7; K5 took ABI 21); Stop 3, W1, K12, Stop 5 and K12b done the same day (§7; Stop 5 keeps K13 / K14 and adds K12b; the user's answers: the threads spike decided after K14, G6 ends as a note, K12b into 0.1.52); next K4.** The branch's
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

- **Since D0 (2026-11-06, §7):** a PSD is read in the pool job `psd_read` (`inpaint_worker.js`, plain JS:
  `inpaint_layered.js` `readPsdStream`, readPsd's own parse sending each layer's RGBA and mask bands as soon as its
  channels are read); the window checks the size from the header and writes the bands into its pixels
  (`inpaint_canvas.js` `readPsdOnPool`). K20b puts the Rust reader into that job; the window's `readPsd` stays the
  fallback and the twin. An ORA is read on the window as below.
- **Before D0, no design and no row:** `readLayered` (`inpaint_canvas.js:18399-18420`) reads the whole file into one array
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

### K1a (2026-10-23): K1's build, no measurement yet

K1 was designed by a read-only workflow of four during K0c's chain (`docs/PLAN_WASM_K1.md`: two designs, a critic, a
writer; its §6 questions go with the suggested answers, question 1 says one session or K1a / K1b) and built by a workflow
of eight builders on disjoint files (S1-S8) with a smoke run and two checkers; their musts and shoulds were fixed by two
agents on disjoint files. Bytes never change: every route picks between byte-identical implementations, and with no
route set the behaviour is today's (no kernel route means Rust; `releaseMB` = `keepMB` = 256). No `.rs` edit, ABI 20.
- **`px.js` (S1):** `PxOutOfMemory`; `pxTimed(on)` switches per-export ms and the copy laps (`pxLaps()`: ms, first calls,
  copyIn / copyOut ms and MB, shared MB, alloc, grewMB; only while timed); `pxLapAdd`; `Px.trapped` set by any
  RuntimeError / RangeError from a raw export; `Px._reset(a)` keeps a result already written when the reset throws on a
  trapped instance (all 22 `finally` sites).
- **`kernels_js.js` (S2):** `floodScan` (`floodMask`'s loop moved verbatim) and `floodShape`, the twin of
  `Px.floodShape` (10,080 comparisons byte-equal on both builds).
- **`kernels.js` (S3):** the route map (`ROUTE_KINDS` flood / mips / releaseMB / keepMB, `setRoute`, `route`,
  `kernelRoutes`, `routeOverrides`, `adoptRoutes`; `rustPx(name, size)`), the instance lifecycle (`renew(why)`: sync, else
  in the background; on a failed background load after a release or idle the old, sound instance comes back; trap and oom
  never), `recovered(p, err, name)` (the call falls back to the twin once, an in-place kernel never runs twice,
  `floodShape`'s `use` at most once), `pxSettled`, `pxSplit`, `pxInstances`, the idle trim (`IDLE_MS` 2 s above `keepMB`,
  armed by every Rust call through the wrappers on the window and by a job's end in a worker).
- **Workers (S4):** `adoptRoutes(msg.routes)` and `pxTimed(msg.split)` per job, `await pxSettled()` before a job, ops
  `px_probe` and `px_stats`, `timing.gen` and `timing.pxSplit`; `inpaint_raster.js` `floodMask` on `floodScan`; the
  stitch worker adopts the routes.
- **Window (S5):** the pool takes a job's fields (kernels, routes, gen, split) when it is queued, not when it is sent
  (the contamination K0b / K0c saw); `measureGen`, `pendingJobs`, `resetPool`; `InpaintEditor.routes`, `setRoute`,
  `pxTimed`, `pxSplit`, `pxInstances`.
- **Harnesses (S6-S8):** `px_test.js` splitCases, routeCases, trapCases, lifecycleCases (it takes about 8 s longer: the
  trim waits); `px_jobs.py` `--ab NAME=A:B`, `--set`, `--split`, `--fresh-pool`, the settle before every row, route-ran
  assertions, `window_release`, the `flood_ladder_<s>` rows keyed on the box job (the 15k wand's coarse 2.8 MP pass kept
  apart), traps read from every thread, NOT COUNTED (exit 2) with the window behind, failed runs never appended;
  `run_gates.sh` `pxjobs` and `pxprobe:`; new `tools/px_probe.py` (`--cold`, `--regrow`, `--retention`) and
  `tools/ab_median.py` (medians of three runs, the spread, the tie rule on the same KERNEL parts for both arms).
- **For K1b** (the smoke runs at 2048, not a verdict): M5's one-instance figures point at V8 sharing code across
  workers; M6 must read the split's `first` figures, not the wall (new workers load inside the row); the flood ladder means
  something only at 15k.

### K1b (2026-10-23): K1's measurements and defaults

`docs/PLAN_WASM_K1.md` §3 at 15000 x 10000 (`docs/measurements/k1b_2026-10-23/run2/`, `summary.txt`; a first try is in
the folder above it: `run_gates.sh` turns every comma into a space and split the `--only` lists, and the harnesses did
not bring the window to the front; `px_jobs.py` and `px_probe.py` now call `Page.bringToFront`; five runs px_jobs did not
count, the window behind, were run again). Three fresh runs each, the medians and verdicts by an analyst, every default
confirmed by an adversarial checker.
- **M1 (clean of contamination):** Rust wins every row, JS / Rust: mips_direct 537 / 396, mips_whole 583 / 562 (a tie,
  Rust by the kernel row), band 152 / 29, wand_band 4,653 / 2,127, wand_object 160 / 114 (K0b's loser now wins). The
  split (`--split`) costs less than the spread, so decision runs keep it.
- **M2 (mips route):** Rust on both rows (579 / 396 and 641 / 575, inside the spread, Rust's kernel row faster); Rust's
  copies in and out (87-225 ms a row) are about as large as its kernel: margin left, not a loss. **No mips entry.**
- **M3, M4 (flood route on one read route):** Rust beyond the spread on wand_band and wand_add, a tie on wand_object
  (125 / 131, Rust by the kernel row); the ladder: Rust at every step from a 0.26 MP box to 150 MP. **No flood entry.**
  Of the legacy flip's wand_band gap (2,525 ms) the flood route is 632 and the read route about 1,900-2,100 (inferred).
- **M5:** A0 ≈ B0 ≈ warm in all three rotations: V8 shares compiled code across the workers' isolates; posting the
  Module saves only the compile (0.3-0.4 ms); no warm-up. The process's one cold call is the window's first (1.6-2.0x).
  M6 was not run (no felt row shows a cold call).
- **M7:** re-growing costs about 0.07 ms per MB (9.1 ms at 128 MB), below every wand row's spread; **keepMB 256 -> 16**
  (`kernels.js` `DEFAULT_ROUTES`): after a stubbed 15k PNG export the pool keeps 11.7 MB instead of 288 MB.
- **M8:** the window's synchronous release works in Electron 44 (sync in 3 of 3, the new instance 1.1 MB, the twin's
  bytes): K27 and K39 are unblocked.
- Gates after the default: pxjobs selection pixels editor brush export PASS on tiles; px_test PASS.

### Stop 1 (2026-10-23)

Re-ranked by a workflow of a ranker and a critic from K0c's shares (`docs/measurements/w0b_2026-10-23/summary.txt`) and
K1b (`docs/measurements/k1b_2026-10-23/run2/summary.txt`); the ranker's order was corrected for two musts (the PSD
open's 9.8 s block left last and nobody asked; K1b's M9, the check of keepMB 16 on the wand rows, cut to one run) and
several shoulds (K27 right after K26, the bucket after the M chain, K25 on its own needs). The table below is the order
the work goes on in unless the user answers otherwise; the felt-cost ranking is inferred (no row counts how often a
case occurs).

#### The order after Stop 1 (the critic's corrected table)

| # | session | content | basis | needs |
|---|---|---|---|---|
| 0 | M9 + second open | K1's M9 as written: M3 and M4 without `--ab`, three runs each; mem once, compared with K0c's +354 MB. One native_test row that opens the file twice in one instance | K:140-141; W:11-12, 37, 40 | K1b |
| 1 | **G2** | The IPC probe at 600 / 800 MB, then the save in pieces. Gate step: a real 15k PSD save with the paint layer, then open_psd from that file. Full tier | B:63-64 (300 / 500 MB saved, 700 MB ends the renderer); W:63-67 (png 2,560 / blk 396, tiff 2,438 / 428, ora 6,879 / 842) | q6.8 (Q1) |
| 2 | **D0** (only on the user's yes) | readPsd's `unpackRows`, `interleave` and mask loop into a pool job, plain JS. Full tier (a file reader) | W:68-69: open_psd 12,987, blk 9,796 (unpackRows 6,012 + interleave 2,432) | G2, Q2 |
| 3 | **K5** | S: `sel_combine`, `alpha_any`, `view`, the extent cache | W:47-49 wand 1,733 / blk 492 (combineRows 322 + read 67), add 1,760 / 566; W:144-145 range depth 1,701 (combine 1,264), luma 2,445 (combine 944) | K1, #0 |
| | *Stop 3* | Range and wand measured again; may reorder #9-#16 | | |
| 4 | **K12** | L: stripes, SAB `out`, the depth slot, march groups. Pin the chain rows first | W:97-101 one light landed 3,813, three lights 4,525, first march 5,106; W:92-93 (chain rows 62 / 60 / 483) | K1 |
| | *Stop 5* | Stripe efficiency decides K13-K14 and the threads spike | | q6.7 |
| 5 | **K4** | The generic box pass | No felt row; it enables K26 and K24 | K1 |
| 6 | **K26** | B: `blur_rgba`, `sharpen_rgba`. Pin the 6,140 ms move; add a dab after a 2 s pause | W:170-177 79 / 82 per move at 400 px, 244 / 256 at 1000 px, the dab 96-99 % of the move; W:252-253; K:138-139 | K4 |
| 7 | **K27** | B: `tone_rgba`, `sponge_rgba`, `freq_split` | W:154 freqsep 2,213, blk 2,179 (blur 1,884); W:174-175 tone / sponge 70 / 88 per move at 1000 px | K26, M8 (K:107-109) |
| 8 | **G6** (here if #0's second open also blocks, else after #21) | The shader link at start, in parallel. Normal tier | W:39-40 blk 497, getProgramParameter 441 (first open of a fresh instance) | q6.8, #0 |
| 9 | **K9** | S: `flood_shape` `out_kind` / `cells`, the alpha-tile cut | W:48 shape 163; W:44-45 grow / shrink cut 74 / 65 | K5 |
| 10 | **K11** | S: `mask_invert` | W:46 invert 212, all blocking (loop 115, tileExtent 34) | K5 |
| 11 | **K21** | M: tile classes, skipped rows, the cut span | W:136 colour 4,943; W:144-145 | K5 (Stop 3) |
| 12 | **K22** | M: `range_tiles_depth` | W:133-134, 139 range_depth 1,123 / 1,170; snap 2,856 (read 1,287 + combine 989) | K21 |
| 13 | **K25** | M: `limit_alpha_rows` and the export / screen snap | W:108-109 fill_limit_rows 9,782; psd_fill_limit 14,287, blk 378 | K22, q6.2 |
| 14 | **K23** | M: `range_tiles_rgba` | W:135-136 JS 4,556 / 4,943; W:140-142 (no clean A/B) | K22 |
| 15 | **K36** | F: `composite_masked_tile` | W:85 bucket 80 [243]; in a 1000 px selection 172 [288] | K0b |
| 16 | **K37** | F: the bucket over tiles | W:55-56 2,885, blk 1,466 (getImageData 1,067 for 572 MB) | K9, K36, q6.4 |
| 17 | **W1** | SIMD for the writer's filter choice in `png_filter_rows`. Same bytes, no ABI change. Full tier | W:58 filter 4,571 / deflate 7,075; W:62 ORA filter 13,068; W:115 own-TIFF store 5,743 / 5,577; W:156 | K1, Q3 |
| 18 | **K2** | Shared inflate, fuzz cases, A/B against native | W:158-159 png 1,048 / 978 / 360; tiff 1,043 / 334 | K1 |
| | *Stop 2* | Rust or native inflate for every reader; P6 decided (miniz at 0.7x native or better) | | |
| 19 | **K6** | P2: SIMD unfilter | W:39-40 unfilter 944 of 2,146; W:159 rows 75.6 % Paeth; W:243 (spread 461) | K0c |
| 20 | **K7** | P3: part decode / finish | Kernel rows only | K2, K6 |
| 21 | **K8** | P4: the parted reader, upload while decoding | W:39-40 open 3,076 (png_read 2,146); W:185 docperf open 5,762; P:212-213 (per layer of 32 MP or more) | K7, q6.5 |
| | *Stop 4* | P5 | | q6.1 |
| 22 | **K32** | E: stitch laps, mask kernels | W:54 maskMax 25 + maskClamp 19; W:149 JS max + clamp 12; W:161-162 finish 938 / 2,895 (dilate and blur already Rust) | K0b |
| 23 | **K33** | E: `color_match_rgba`, `blend_alpha` | W:54 colorMatch 79; W:163 437 at 4096² | K32 |
| 24 | **K34** | E: `edgefit_shrink`, `warp_rgba`, `warp_coverage` | W:148 shrink 78, warp 80; W:163 warp 310, shrink 251 | K32 |
| 25 | **K13** | L: `shadow_march_f64` scalar, hoist, guard | What K12 leaves (Stop 5); W:191 point routed 3,344 (twin 3,348, simd 3,984; explains only) | K12 |
| 26 | **K14** | L: f64x2; the sun decided | W:192 sun simd 1,505 / twin 2,684 (explains only) | K13, q6.6 |
| 27 | **K24** | M: `guided_far`; grey and disparityRange into the job | W:137 depth_guide 1,379 / 1,357 (job 655 / 552) | K4 |
| 28 | **K3** | P1: crc32, frame, combine | W:150 1.63 ms/MB; W:209-210, 244-245 (not visible in the wall) | K1 |
| 29 | **K10a** | C: the design | No row | K0c |
| 30 | **K10b** | C: gather, composite, filter, deflate by pointer | W:57-58 export_png 1,960 (compose 1,328, chunk 911); W:218 store 1,981-2,480 | K10a, K3 |
| 31 | **K10c** | C: PSD pack, the wand's box, dissolve / clip | W:59-60 pack 5,220, rows 3,106; W:48 stack_into 2,517 | K10b |
| 32 | **K15** | T: unpredict, predict, `tiff_to_rgba`, `tiffStrip` | W:114 own TIFF 4,907 (unpredict 762, convert 478); W:160 tiff_rows_256 2,204 | K0c, K10b, q6.4 |
| 33 | **K16** | T: `tiff_unpack`, the LZW fix | W:117-118 lzw 13,690 (JS LZW 6,321); packbits 7,428 | K2 |
| 34 | **K17** | T: plan, band reader, per-tile unpredict | One-worker A/B | K15, K16 |
| 35 | **K18** | T: parallel bands | W:112-119 opens 4,453-13,690 | K17 |
| 36 | **K20a** | D: the design | No row | K8, K17 |
| 37 | **K20b** | D: the PSD reader (Rust inside D0's job) | W:68-69 (the wall D0 leaves; the full freeze if D0 is refused) | K20a |
| 38 | **K20c** | D: the ORA reader | W:70-71 open_ora 7,491, blk 1,047 (bitmap 1,915 + fromImage 1,220) | K20b |
| 39 | **K28** | B: `liquify_block` | W:180 land 142 / 122 | K1 |
| 40 | **K29** | B: `liquify_preview`, plus a dab after a 2 s pause | W:180-181 preview p50 19 / 16, worst 78 / 74; K:138-139 | K28 |
| 41 | **K30** | B: dense twin | W:180 dab p50 18 / 16 | K29 |
| | *Stop 6* | Decides K31 | | |
| 42 | **K31** | B: Rust `liquify_dab` | Stop 6's rows | K30 |
| 43 | **K19** | T: writer deflate A/B (optional T6 after it) | W:116, 246 export own 2,141 (1,726-2,577) | K15, q6.3 |
| 44 | **K35** | E: `edgefit_levels` (conditional) | W:148 fitEdges 53 of 134 | K34 |
| 45 | **K38** | F: `matchCanvas` fallback | W:165 242 = blk, only without WebGL | K1, q6.4 |
| 46 | **K39** | S: grow fallback | W:166 growMask 852 / growMaskBounds 665 | M8 (K:107-109) |
| 47 | **K40** | Release block (the pool A/B rides here as information) | — | all built |
| 48 | **K41** | Release chain, on the user's word | — | K40 |

**If D0 is refused:** D stays at #36-38. The only other way forward is to narrow K20b's Needs to K2, K15's reader half and K16, which splits K15 and changes §5.

**How often:** none of the frequency judgments above is measured. As in the proposal, they are inferred.

#### Asked of the user before #1

1. **(q6.8) The save fix and the other non-kernel items.**
   - Should G2 (the save in pieces, after the 600 / 800 MB IPC probe) go first on the branch and ship in the one release?
   - Or should a 0.1.51 hotfix of the save also go out from `main` now? 0.1.50 has the bug, and a hotfix moves main, which then has to be merged into the branch.
   - Should the shader link (G6) be its own session, placed by the second-open row?
   - Should the worker pool size stay information only, as an A/B row in K40?
2. **(New, the same kind as 6.8) D0.** Should the 15k PSD open's window loops (`unpackRows`, `interleave`, the mask loop) move into a pool job as plain JS right after G2? The window would stop freezing for 9.8 s, but the open would still take about 13 s until K20b's Rust reader. The alternatives:
   - narrow K20b's Needs, which splits K15;
   - leave D at the end (#36-38).
3. **(Information, an addition to the plan) W1.** A new session that makes the PNG writer's filter choice SIMD, with the same bytes and no ABI change. It goes in at #17 unless the user objects.

#### The user's answers (2026-10-24) and the order they set

Asked with a recommendation each (researched in the code); the user took every recommendation:
- **Q1, the save crash: a hotfix 0.1.51 from `main`.** G2 is built on `main` (it touches only `renderer/editor/host.js`
  and main's file-save IPC, no kernel: the export goes to main in pieces of about 64 MB appended to the temp file, not as
  one `Uint8Array` in one message), with its gate step (a real 15k PSD save with the paint layer, then `open_psd` from
  that file) and the IPC probe at 600 / 800 MB first; then released as 0.1.51 by `docs/RELEASING.md` (prepared locally,
  asked once before the chain; the Store update may carry the open 0.1.48-0.1.50 with it); then `main` is merged into
  `wasm-kernels`. The user's rule "one release at the end" is for the kernel work; a fix of released code is not.
- **Q1, the shader link (G6): its own short session (about half a day), after K5 and W1.** The compositor is made per
  editor (`inpaint_canvas.js` `compositor()`, about :21506), so the 0.44 s block is likely paid per opened document:
  the session first opens a second document; a cheap second link (Chromium's program cache) means compiling at start in
  idle time is enough, else `KHR_parallel_shader_compile` (poll `COMPLETION_STATUS_KHR` instead of reading
  `LINK_STATUS` right after the link; check once that Electron 44 offers it).
- **Q2, D0: yes, right after G2.** Its pool job is the one K20b later puts Rust into; G2 makes real 15k PSD files to open.
- **Q3, W1: yes, at #4, right after K5.** `png.rs` `filter_row` is scalar (five filters byte by byte, Paeth computed
  again for the output); all five filters depend on the raw bytes only, so the sums go 16 bytes wide and the chosen row
  is kept, not recomputed; same choice, same bytes, no ABI change. It runs in every layer upload, every PNG export and
  every store after a TIFF / PSD / ORA open.

**The order from here:** G2 on `main` -> 0.1.51 -> merge `main` into `wasm-kernels` -> #0 M9 -> D0 -> K5 (Stop 3) -> W1 ->
K12 (Stop 5) -> G6 -> then the critic's table above from K4 on (K4, K26, K27, the E chain, the M chain with K25, K9,
K11, the bucket K36-K37, the P chain, ...).

### G2 (2026-10-24): on `main`, released as 0.1.51

- **The probe** (fresh instances, one `window.scumble.file.save` of bytes made in place): 500 MB saved, 600 and 800 MB
  ended the renderer (oom, -536870904). The IPC message itself was K0a's open question: about 512 MiB a message.
- **Built** (main `feee54a`): `electron/main/filesaves.js` (pieces appended to a temp beside the target from
  `docfile.tempFor`, listed for the sweep, renamed at the end; the owner a webContents id, a page's generation so a save
  opened while its page reloaded is dropped; a rename refused with BUSY or a hard link written in place; a symbolic link
  saved through; a folder, a read-only file and a full drive refused before a write; a held temp stays listed);
  `docfile.tempFor` cuts the temp's name to 255; `host.js` `saveExport` in 64 MB pieces (`SAVE_PIECE`); preload
  `file.saveStart / saveWrite / saveFinish / saveAbort`; main drops a page's saves on its reload (app URLs only), its
  renderer's end and at `will-quit`; `file:save` goes through the same writer.
- **Checked:** a review workflow (4 reviewers, 15 verifiers: 10 findings, all fixed); `tools/filesaves_test.js` (17
  cases); the `export` gate's saves checks on both backends (600 MB in 10 counted pieces read back whole, a cancel, a
  file drop, a reload); the mutation round (module 26 of 26 red; the wiring red but the navigation's URL test, which
  neither a script's navigation nor a CDP drop reaches); a real 15k PSD of 925 MB saved in 4.5 s (block 124 ms) and
  opened from that file in 19.4 s (block 13.6 s: D0). `docs/measurements/g2_2026-10-24/`.
- **Rode along** on the user's word: the skins Comfy and Black Forest. 0.1.51 published 2026-10-24T01:44:48Z.
- **Merged into this branch** the same day: `saveExport` keeps K0a's marks (start, pieces, written), `docs/BUGS.md`
  drops the K0a entry. Next: #0 M9 and the second open, then D0.

### #0 M9 and the second open (2026-11-06)

K1's M9 (`docs/PLAN_WASM_K1.md` §3) and one new native_test row, at 15000 x 10000 on `51f5ea5` plus the row, every run a
fresh instance (offline, tiles; `docs/measurements/m9_2026-11-06/`, `m9_chain.sh`, `summary.txt`). No app code changed.
The card held 3.3 GB of desktop apps (the user's installed Scumble was open); ComfyUI was not running. Every px_jobs run
PASS with the window in front; three tries the window was behind (NOT COUNTED) counted on the next try.
- **Harness:** `native_test.py` row `open_again` (opt-in, right after `open_the_file`): the same file opened again into a
  new tab, so a new editor and a new GPU compositor whose programs are compiled and linked again; the two opens are
  printed side by side. `compileShader`, `getShaderParameter`, `linkProgram` and `getProgramParameter` are counted in
  every row's boundaries now.
- **M9-M3** (the wand rows, no `--ab`, `--split`, three runs; `ab_median.py`): Rust (the default, keepMB 16) 1,917 on
  wand_band, 114 on wand_object, 1,998 on wand_add, against K1b's M3 Rust 1,900 / 131 / 2,038 and M1s 2,090 / 108; each
  difference inside the spread or in Rust's favour, and Rust beats the legacy JS flip on all three rows. **keepMB 16 costs nothing measurable:**
  no row of the six runs renewed an instance for idle; the large wand jobs give their 644-657 MB back by releaseMB 256
  anyway, and wand_object grows 2.3 MB, below 16. The liquify window (about 69 MB) is not on these rows.
- **M9-M4** (the ladder, three runs): Rust wins at every step from 256 (0.26 MP), at or below K1b's M4 Rust at every
  step (8192: 1,463 against 1,631). No flood entry, nothing to change in `px/kernels.js`. native_test's wand rows before
  and after a flood default were not run: none landed.
- **mem** (`mem:15000x10000,--rounds,3`, once as asked plus one run added for the spread): the GPU process ends +447 and
  +495 MB above its start, against K0c's one run of +354 (the same FAIL line under ALL PASS; pan, levels and upload
  PASS); the renderer ends about 300 MB higher too. Not from keepMB (inferred: the wasm memories live in the renderer,
  and a lower keepMB only lowers it); with one K0c run the old spread is unknown, so this is a note, not a regression
  found. §11's 300 MB bound was already not met on tiles.
- **The second open** (three fresh instances, then a restart on the third one's profile): the first open on a fresh
  profile 2,796 wall, block 453, of which the link wait (`getProgramParameter`, 3 calls) 397; the second open into a new
  tab 2,318 wall, block 29, link 1.5 (medians). The compositor was made new in the second tab, so its programs came back
  from Chromium's program cache. A restart on the same profile does not pay it either (block 46, link 1.7). So K0c's
  0.4-0.5 s open block is paid once per profile with a cold GPU cache (inferred: the first open after an install, or
  after a driver or Chromium change).
- **What it decides:** G6 does not move up to #8; it stays where the user put it (its own short session after K5 and
  W1, after K12 in the order). Its gain is one block of about 0.4 s once per profile, so whether G6 still runs or ends
  as this note is the user's call when it comes up.

Next: D0.

### D0 (2026-11-06): the PSD reader in a pool job, plain JS

The order after Stop 1, #2 (the user's yes of 2026-10-24), on `bbff117`; full tier. `docs/measurements/d0_2026-11-06/`
(`summary.txt`; the chains `d0_chain.py`, `d0_ab.py`; `twin15k.py`; `mutation/`).
- **Built:** `inpaint_layered.js`: readPsd's body is `decodePsd(input, inflate, stream)`, and `readPsd` is
  `decodePsd(.., null)`, byte for byte the old path (the merged picture's decode moved into `mergedPlanes`).
  `readPsdStream` is the same parse for a worker: each layer's pixels and mask go out as RGBA bands of 256 rows
  (`onRows`) as soon as its channels are read, and its planes are dropped, so one layer's planes are held at a time (a
  record without pixels drops its planes too); the merged picture is read only when no layer has pixels, the one case
  `loadLayered` shows it (a third of the old parse at 15k is gone). `inpaint_worker.js` job `psd_read`: the worker reads
  the blob itself (the window makes no array of the file) and drops the array at the end. `inpaint_canvas.js`:
  `psdOnPool`, `readPsdOnPool` (the size checked from the header's 26 bytes before the job is queued; each band written
  into `Layer` / `Mask` pixels by `writeRect` as it arrives, about 12 ms a 15k band, never a tile written by a worker;
  the status line counts the layer and its rows), `checkLayeredSize`; `loadLayered` and `addImageLayers` take
  `compositePx`. An open that is over (a later open, a closed tab: `loadFile`'s `later` reads `_destroyed` too) stops its
  job at the next band and releases its layers, masks, merged picture and base. `inpaint_pool.js`: a stop the caller asked
  for (an `onProgress` that throws, a cancel mid-stream) is counted as `stopped`, not `lost`, so it never switches the
  pool off.
- **The job's contract** (what K20a and K20b build on): in, `{ blob, rowsPerBand }`; the window has checked signature,
  version, mode, depth and then the size from the header (a refusal of the first four is the reader's, in its words);
  out, `progress` messages `{ index, mask, rgba, w, h, y0, rows }` (the buffer transferred), a layer's pixel bands
  before its mask bands (white with the mask as alpha, what the editor's `Mask` is made from); the reply readPsd's answer
  with `index` in place of a layer's `rgba`, its `mask` without `data`, `composite` an index (only for a file without
  layers) or null; or `{ failed }` with the reader's message, thrown on the window without a second read. A job that
  cannot run before its first band (no pool, a lost worker, an op no worker knows) falls back to the window's `readPsd`;
  after a band it is an error (a second read on the window needs more memory still). Timing: read, channels, inflate,
  interleave, mask, deliver, bands.
- **The marks on the pool route:** no `read` step; `parsed` (`route: "pool"`) includes the band writes; `layers` is 0,
  with `rgbaMs` / `maskMs` as extras. So `mark total` is not comparable across the two routes; compare `open_psd`'s wall.
- **The review** (a workflow on the first build: 19 findings, none rejected): the size refusal had thrown from
  `onProgress`, which the pool counted as a lost worker (two on a small machine switched the pool off) after the worker
  had read the whole file; a superseded or closed tab's read ran on and kept its pixels; any failure fell back to a
  second read; the gates `blendmodes` and `groups`, the Photoshop-written fixture, a same-state A/B and the docs were
  missing. All fixed. Left as is: no backpressure on the bands, and two tabs may now read 15k PSDs at once on two workers
  (each near the old single open's peak, inferred); no busy flag for an open (a tab without a base closes without asking
  anyway); `InpaintEditor.psdOnPool` stays a class switch like `mipsOnPool` and `pngParts` (it picks where the reader
  runs; K20b's JS / Rust choice inside `psd_read` becomes a route of `px/kernels.js`).
- **Numbers** (15000 x 10000, the real 925 MB PSD of G2's kind saved through `saveExport` and opened from its file; three
  counted fresh runs each, medians): the same-state A/B on the final build (`after/`, the routes alternating, the card at
  5.1-7.0 GB): pool wall **10,971** [10,736-12,882], block **1,847** [1,805-1,920]; the window's reader wall 16,582
  [15,422-17,858], block 10,970 [9,698-12,141]: the block -83 %, the wall -34 %. The baseline on `bbff117` (`before/`,
  the card at 3.3 GB): wall 14,015, block 8,968. The worker's `psd_read` 5.4 s (read 0.3, channels 3.1, interleave 2.0)
  where the window's parse took 10.1 s; the window idle 7.9 s of the open instead of 3.8.
- **Where the block left is:** not in the reader. A long-task probe on a fresh profile (`after/longtasks_first_open.json`)
  finds no long task between `start` and `stored`; the 1.7 s before `start` is `load_image`'s read of the whole file into
  the renderer, and on a profile's first document the 0.55 s shader link after `stored` (G6). Ctrl+O sends the file the
  same way: `docs/BUGS.md` "Ctrl+O sends the whole file to the window in one message", for the user to place at a Stop.
- **Tests:** the twins (byte identity): `node tools/layered_test.js` (45 PSDs, bands of 3 and 256, 122 checks),
  `--twin-file` on the 15k file and on `tools/fixtures/blendmodes/blendmodes.psd` by SHA-256; the `layered` gate's step
  `the_pool_and_the_window_read_a_psd_alike` (seven PSDs through both routes in this backend's pixels, the refusals,
  the fallback, the stops, a worker lost mid-read) on both backends; `twin15k.py`, the 15k file in the app, equal on
  tiles and canvas with the same hashes. Gates on tiles: lint types layered export document pxjobs blendmodes groups
  pixels clip PASS; on canvas the same but pxjobs (tiles only by design) PASS. The mutation round: module 20 of 21 red
  (a zero-area header's merged picture survives, cosmetic), wiring 22 of 22 red (four after the step got their cases).
- **Not measured** (inferred): the open's peak memory (the worker holds the file's array and one layer's planes, about
  1.5 GB at 15k, where `readPsd` held every plane, every RGBA buffer and the merged picture on the window); a 15k layer
  with a full-size mask (`maskMs` 0 in every 15k row; masks are covered by the small files and the twins).
- **What K20b fills:** the Rust reader inside `psd_read` (the unpacks, the prediction and the interleave as kernels,
  the same messages and answer), with its own route for the JS / Rust choice; the window's `readPsd` stays the twin and
  the fallback. The ORA reader is still the window's (K20c).

Next: K5.

### K5 (2026-11-06): the selection's combine in Rust

The order after Stop 1, #3, on `4bfdd74`; full tier on the kernel, normal on the call site.
`docs/measurements/k5_2026-11-06/` (`k5_chain.sh`, `summarize.py`, `before/` and `after/` with their `summary.txt`,
`gates/`, `mutation/`).
- **Built (ABI 21):** `crates/px/src/sel.rs` `sel_combine(dst, size, src, src_stride, src_kind, bw, bh, mode, rgb, ext)
  -> u32`: `combineRows`' maths (the order of `SEL_MODES`, the exact `mul255`) in u32x4 lanes, one loop per (kind,
  mode) pair by const generics, the scalar build per pixel; source kinds 0 none / 1 alpha bytes / 2 full / 4 RGBA;
  mode + 8 for a new tile (its old alpha 0, all of it written: no zero fill, no copy in); 1 with the whole tile's extent
  as `tileExtent` finds it, 0 for an empty tile, 2 refused. The twin `kernels_js.js` `selCombine` (in place, u32 words
  on an aligned little-endian tile, one 64 KB table per mode) and `alphaAny`; `px.js` `Px.selCombine(dst | null, ...,
  write)` (dst only read; the source copied as its span, or a band's long rows packed; `write()` once and only for a
  non-empty result; the twin's length refusals); `kernels.js` `selCombine` on the route `selCombine` ("kernel"), trap
  recovery as `floodShape`'s. `inpaint_raster.js` `view(rx, ry, rw, rh)` on `rectSource`, `bytesSource` and
  `tilesSource`: `{ kind, data, off, stride }` without a copy, or null for `read` (a region across the source's edge or
  two of its tiles, a short buffer, a fractional origin). `TileMaskPixels.combine`: the view, else `read`; nothing over
  a missing tile skipped; full coverage under replace or add one `u32.fill`; else `selCombine`; the extent kept
  (`t.ext`, `extVersion`) right after the write; an empty result drops the tile; the colour clamped and rounded per
  channel as a tile's bytes stored it (in `invert` too). The canvas backend's `combineRows` is unchanged.
- **The `alpha_any` choice:** §4.3 and §5 list a Rust `alpha_any`, but §4.3's own design runs `sel_combine` once on a
  missing tile (no `alpha_any` then combine, which copied the source twice): a Rust export would have no caller, and
  §1.1 rule 4 removes unrouted exports. Only the twins' route asks the JS `alphaAny` (a missing tile is made only where
  the source covers something, the combine's promise).
- **The review** (a workflow over the first build: 16 findings, 4 must, 6 should, 6 nice): fixed are the A/B, the
  after-runs, the mutation round, the docs; `before/`'s px_jobs r2, which overlapped this session's cargo build
  (04:51:15-21), replaced by a clean r4 from a tree exported at `4bfdd74` (r2 kept as `overlap_pxjobs_r2.jsonl`);
  `ab_median.py` prints "not touched by the route" for a row whose combine ran in neither arm (grow, shrink, invert);
  the gate steps that assert `sel_combine` ran (below); the colour clamp, the fractional view origin, px.js's length
  refusals (a short view over a longer buffer), the twin's degenerate case, px_jobs' wrapper inside the rounds' try.
  Decided by the A/B, not built: a route by kind (the wand's and the range's rows agree) and a `writable` without its
  copy for the Rust route's frozen tiles (wand_add's tie goes to Rust by its kernel row, 162 against 405 ms; the copy is
  a later gain, to be measured where it is built).
- **Tests:** `node tools/px_test.js` `selCases` (448 cases both builds against the twin, the twin against `combineRows`
  with a plain extent scan, also on an unaligned tile; a new tile, seven refusals, no pixel to combine, `alphaAny`, the
  route), `node tools/combine_test.js` section 12 (192 combines on both routes against a per-pixel model, the cached
  extents, a fresh extent on every written tile, the colour clamp, the views' offsets and refusals); the `selection`
  gate's `real_wand_on_tiles` and `range_select_depth_cases` and the `editor` gate's wand step require `sel_combine`
  calls on tiles with the route on Rust. Gates `--offline`, tiles: lint types selection limit maps pixels editor pxjobs
  nodecopy PASS; canvas: selection limit maps pixels editor PASS. The `depth` gate has no script (`docs/BUGS.md`):
  `node tools/depth_test.js` passes in its place, as do `selection_test.js`, `edges_test.js`, `weights_test.js`,
  `layered_test.js`. `build_px.py --check` identical on both builds; `build_node.py --check` only the expected
  "differs" lines (the node is built at the release).
- **The mutation round** (a copy tree, `mutation/`; the untouched copy PASS first, the kill set `combine_test.js`,
  `px_test.js`, then the gates selection pixels editor pxjobs on tiles on a fresh instance; Rust mutants rebuilt on both
  builds): **52 of 53 red** (sel.rs 15 of 16, the twin and `alphaAny` 10 of 10, the route 2 of 2, px.js 7 of 7, the
  views 8 of 8, the call site 10 of 10). The survivor is equivalent: the SIMD subtract without its clamp at 0
  (`mul255(d, s) <= d`, so the difference never goes below 0). The twin's bytes path survived the first round and is
  red since px_test runs the twin on an unaligned tile too. The restored copy: PASS, both builds identical.
- **The A/B and the route** (`after/`, three fresh runs, `px_jobs.py --ab selCombine=js:rust`, the kernel row the
  window's `TileMaskPixels.combine`): Rust on every row it touches: wand_band 1,320 / twin 1,657 and range_depth_snap
  2,435 / 2,503 beyond the spread; inside it and Rust by the kernel row wand_object 91 / 90 (combine 1.0 / 2.3),
  wand_add 1,623 / 1,844 (162 / 405), range_depth 829 / 846 (166 / 330), range_luma 2,072 / 2,025 (156 / 273). **No
  `selCombine` entry in `DEFAULT_ROUTES`:** Rust is the default.
- **Before -> after** (medians of three fresh runs, 15000 x 10000): native `wand_whole_picture` wall 1,088 -> 901,
  longest block 329 -> 94 (the window's combineRows 193 + read 55 gone, `sel_combine` 17 + its copies 19 in their
  place); `wand_whole_add` 1,118 -> 811, block 425 -> 104; select by depth 1,746 -> 1,205 ms (its combine 1,367 ->
  236), by luma 2,711 -> 1,734 (combine 1,149 -> 137); the perf gate's wand across the picture blocked 1,007 -> 294
  (wall 7,124 -> 5,980); px_jobs wand_band 1,984 -> 1,320, wand_add 2,057 -> 1,623, range_depth 1,230 -> 829,
  range_luma 2,565 -> 2,072. Invert, grow and shrink untouched (inside their spreads). The after-runs' card held
  2.7-4.0 GB, the baseline's 4.4-5.5 GB (its r4 2.7-3.0).
- **Stop 3's rows** (`after/summary.txt`): range depth 1,205 = combine 236 + read 0 + the rest 969 (the 40
  range_select jobs, 8.4 s summed over the workers); range luma 1,734 = combine 137 (most of its tiles full: one fill)
  + read 329 + the rest 1,268 (10 range_select jobs, 2.5 s summed, and the picture's stack_into jobs); the snapped
  depth range 2,435 with its read 1,172; the wand across the picture wall 901, window block 94, px_jobs 1,320 of
  which the worker's flood job about 860 (flood about 670, shape about 177) and the window's combine 137; the perf
  wand rows band 294 [5,980], object 153 [238], a masked layer 185 [286].
- **What Stop 3 decides:** the combine is no longer most of select by range (20 % of depth's wall, 8 % of luma's);
  what is left is the workers' range jobs (K21-K23's ground) and, for the wand, the flood job's shape and cut (K9's).
  Stop 3 re-ranks #9-#16 from these rows; K5 reorders nothing.

Next: Stop 3.

### Stop 3 (2026-11-06)

Re-ranked by a workflow of a ranker and a critic from K5's after-runs; nothing was measured in this stop and no code
changed. The files: A = `docs/measurements/k5_2026-11-06/after/summary.txt` (its before-runs in `../before/`), W =
`docs/measurements/w0b_2026-10-23/summary.txt`, K = `docs/measurements/k1b_2026-10-23/run2/summary.txt` (M9's
`m9_2026-11-06/summary.txt` and D0's `d0_2026-11-06/summary.txt` touch none of #9-#16). The critic's corrected order is
taken: one must (the ranker moved K9 down on a block argument; §1.1 decides by the wall, so its reason is rewritten and
its place kept) and four shoulds (colour's number by route, K9's expected gain, K11 against K21 by felt cost x
frequency, K36's own row). Where the two disagreed the critic's evidence decided; nowhere was the ranker's reading kept
over it.

**What the rows say (A unless named):**
- **Select by depth** 1,205 ms (978-1,222) = the window's combine 236 + read 0 + 969: the 40 range_select jobs (8.4 s
  summed over the workers), the edges and the done step 27 (A:36-37, :66).
- **Select by luma** 1,734 = combine 137 (most tiles full coverage: one fill) + read 329 (stack_into jobs) + 1,268: the
  10 range_select jobs (2.5 s summed) and the picture's stack_into jobs (kernel 0.42-0.53 s summed) (A:38-40, :67).
- **range_depth_snap** (px_jobs) 2,435 (spread 57): read 1,172 + combine 136 + the jobs (A:41, :124).
- **The wand** across the picture: native wall 901, block 94 (A:58); px_jobs wand_band 1,320 (spread 84) = the
  worker's flood job (flood about 670 + shape about 177, kernel 835-922) + the window's combine 137 + mips and the box
  job's read (A:42-43, :94). wand_add 1,623 in px_jobs (combine 162; A:44, :107), native wand_whole_add 811 / block 104
  (A:60-61). wand_object 91 (spread 23; A:100), its Rust shape 1.7 ms of a 125-131 wall (K:65-66).
- **Invert** 226 native, all of it block (tileExtent 33, writable 16, tileEmpty 9; A:56-57), perf 250 [247] (A:72);
  K5 took nothing (230 -> 226, A:21-22). **Grow / shrink** 570 / 364 (A:52-54), their job cut 74 / 65 (W:44-45).
- **Untouched by K5, so W0b's numbers stand:** colour 4,943 on the JS column; on Rust 4,841 with the picture read on the
  window in two of three runs and 3,496 through stack_into in r2 (K0b's one run 3,479; W:34, :136, :140-142). The
  current route (stack_into, as luma reads in every after-run, A:27-28) is unmeasured for colour. fill_limit_rows
  9,782, psd_fill_limit 14,287 [378], 40 bands (W:108-109). The bucket over a 15k band 2,885, block 1,466
  (getImageData 1,067 for 572 MB, flood 962; W:55-56); perf's bucket 80 [243], in a 1000 px selection 172 [288] (W:85);
  the stroke commit 66 (perf), the release 12 (native) (W:86, :43).

**What changed for each of #9-#16:**
- **K21** (#11 -> #9): the largest remaining frequent wait in the block: all 150 MP are computed and every edge row is
  read whatever the result (969 of depth's 1,205 in the jobs and the edges, the snap's read 1,172 of 2,435, luma's
  jobs, colour's whole wall). K5 cleared the ground K21 was written for, and §5's "the combine may be most of range" is
  answered: it is not. Its chain adds `range_color`, `depth_guide`, `fill_limit` and an `exportperf` with a
  depth-limited fill layer (§4.8 "Measure"; K5's chain had none of them), so K22, K23, K25 and K24 are ranked on this
  machine state, not on W0b's. The gain is proportional to the share of tiles outside the compute class (inferred) and
  must clear depth's spread 244 and the snap's 57.
- **K11** (#10, the same slot, now after K21): about 75-125 ms off a frequent operation (226 all block -> 100-150, §4.3:
  the copies stream about 1 GB), certain, 0.75 d and independent of the M chain, so it delays the chain by little at
  #10. Invert calls `writable` on every tile: the copy K5 deferred for the Rust route's frozen tiles (§7 K5) at a second
  site; the combine's own copy is still measured on the wand rows, where it is built.
- **K22** (#12 -> #11): content unchanged; Rust on the per-tile compute K21 leaves (a fresh 64 KB, `snapField`'s 16 taps
  with two `exp` each, `rangeWeight`, `Math.round`); the snap's route by measurement.
- **K23** (#14 -> #12, ahead of K25): colour (about 3.5 s on the stack_into route, up to 4.9 s on the window's read) is
  the slowest interactive selection left, luma 1,734; more felt seconds per use at a higher frequency than K25's export
  (inferred). Expected (inferred): colour -1.5 to -3 s, luma -0.2 to -0.3 s. **It swaps back behind K25** if
  `range_color` on K21's chain lands at or below range_depth_snap's 2,435.
- **K25** (#13, the same slot, now after K23): the largest wall in the block (about 10 s of a 15k layered export with
  a depth-limited fill layer, W:108-109) for the rarest case. q6.2 is asked at its start; its suggested answer changes
  the export's snap colour to the screen's, a byte change: said first, a `docs/BUGS.md` entry first.
- **K9** (#9 -> #14): its reason changes, not its worth by §1.1. K5 took the window half (combineRows 193 + read 55
  gone, the block 94), so what is left is wall, which counts as felt. It lands only where the cut is large: the shape
  177 of wand_band's 1,320 (about 13 %), grow's and shrink's cut 74 / 65; on the common wand the Rust shape is 1.7 ms,
  so at most 1-2 ms there. Expected (inferred): up to about the shape 177 plus the source copy-in 12-16, less the alpha
  cut's own cost; the block at best 94 -> about 85 (only `_in` shrinks, about 4x; `allocTileBytes` 56 is the window's
  destination tiles, which stay RGBA). It is K37's coverage source, so it goes right before K36 / K37. wand_band's
  spread 84 is clearable; wand_object's 23 is not (the tie rule by the kernel row there).
- **K36** (#15, unchanged): a small felt row of its own at every stroke on a tiles layer (the commit 66, the release
  12; §4.11 switches it in for the stroke release and `inpaint_canvas.js:11838`), its larger value K37's first half. It
  asks q6.4 at its start (the first session whose worth hangs on K37; K9 stands on its own); if K37 is refused or the
  tile route does not measure faster, K36 is built only if the stroke row's gain is worth a session alone.
- **K37** (#16, unchanged): the largest window freeze left in the block (1,466 of 2,885 on a 15k band) for a rare case;
  one level against Skia at opacity below 1 (q6.4), said first; a size threshold if small fills lose.

Nothing in #9-#16 is dropped or merged. **How often:** no frequency above is measured; all are inferred, as in Stop 1.

#### The order after Stop 3 (#9-#16 rewritten; every other row as in "The order after Stop 1")

| # | session | content | basis | needs |
|---|---|---|---|---|
| 9 | **K21** | M: tile classes, skipped rows, the cut span. Its chain adds `range_color`, `depth_guide`, `fill_limit` and an `exportperf` with a depth-limited fill layer | A:36-41, :66-67 depth 1,205 (jobs and edges 969), snap 2,435 (read 1,172), luma 1,734; W:136 colour 4,943 | K5 (in) |
| 10 | **K11** | S: `mask_invert` | A:56-57 invert 226 = blk (tileExtent 33, writable 16); A:72 perf 250 [247] | K5 (in) |
| 11 | **K22** | M: `range_tiles_depth`, the snap's route by measurement | A:36-37 the 40 range_select jobs, 8.4 s summed; A:41 snap 2,435 | K21 |
| 12 | **K23** | M: `range_tiles_rgba`. Swaps behind K25 if `range_color` on K21's chain is at or below 2,435 | W:136, :140-142 colour 4,943 (JS) / 3,479-3,496 (stack_into); A:38-40 luma 1,734 (jobs 2.5 s summed) | K22 |
| 13 | **K25** | M: `limit_alpha_rows` and the export / screen snap | W:108-109 fill_limit_rows 9,782; psd_fill_limit 14,287, blk 378 | K22, q6.2 |
| 14 | **K9** | S: `flood_shape` `out_kind` / `cells`, the alpha-tile cut | A:42-43 wand_band 1,320 (shape about 177); W:44-45 grow / shrink cut 74 / 65; K:65-66 wand_object shape 1.7 | K5 (in) |
| 15 | **K36** | F: `composite_masked_tile`; asks q6.4 | W:86 stroke commit 66, W:43 release 12; W:85 bucket 80 [243] / 172 [288] | K0b (in) |
| 16 | **K37** | F: the bucket over tiles | W:55-56 2,885, blk 1,466 (getImageData 1,067 for 572 MB) | K9, K36, q6.4 |

**Outside the block:** nothing moves. K24 (#27) needs K4, not K21-K23; K39 (#46) needs K1's release check (M8, in).
The order from here is the user's of 2026-10-24: W1 -> K12 (Stop 5) -> G6 -> the table from K4 on, with #9-#16 as
above. That answer's gloss names the E chain before the M chain and K11 after K9; the table's numbers govern (the
answer says "the critic's table above"), Stop 3 leaves the E chain (#22-24) where it is, and K11 now runs before K9
because K21's chain is the larger wait and K11 depends on neither.

**Asked of the user:** nothing. No row is dropped and no behaviour the user sees changes in this stop; the two byte
changes the block meets are asked by the sessions that need them (q6.2 at K25's start, q6.4 at K36's), as §6 says.

Next: W1.

### W1 (2026-11-06): the PNG writer's filter choice in SIMD lanes

The user's answers of 2026-10-24 (Q3: W1 at #4, after K5), on `59ff16f`; full tier (a Rust kernel inside a file
writer, §1.4). `docs/measurements/w1_2026-11-06/` (`w1_chain.sh`, `w1_lock.py`, `summarize.py`, `w1_identity.js`,
`before/` and `after/` with their `summary.txt`, `gates/`, `mutation/`, the identity logs).
- **Built (ABI 21, unchanged):** `crates/px/src/png.rs` `filter_rows` calls `row_filter`: the old `filter_row` in the
  scalar build (`px_scalar.wasm` is the same file as before, `ade55404...`), `lanes::filter_row::<UP>` in the SIMD build
  for rows of 5 px or more. A group is 16 bytes: x, a (four bytes to the left), b and c (above and above left, zeros
  without the row above) loaded once, the five filtered groups made, their costs as `i8x16_abs` read unsigned (0x80
  costs 128) added pairwise into u16 lanes for at most 255 groups (255 x 256 < 65,536) and then into u32 lanes: exact
  sums, so the choice (the smallest sum, a tie to the lower type) is the scalar loop's. Paeth in i16 lanes in the
  standard's order (a, then b, then c), Average as the rounded-up average less its rounding bit. The Paeth group goes
  straight into `out`; a row won by None is copied, one won by Sub, Up or Average written again by that filter alone
  (one or two lane ops a group): no scratch, no allocation. Each row's first pixel (nothing to its left) and its bytes
  after the last whole group go through the scalar code. No route: `png_part` always runs Rust, and the JS twin was
  already the slowest arm (px_bench's band 37 ms against the scalar build's 23).
- **The rows the task named as "px_jobs.py rows for the PNG writer" do not exist** (`png_part` has no route to A/B):
  the 15k rows are native_test's `export_png`, `export_ora`, `save_png` and `build_the_file` (W:58, :62), tiffperf
  `own` (W:115) and w0_bench `files_15k` (W:156), the png_part laps summed over the workers; px_bench's png band in
  Node and Electron's V8 explains only.
- **The review** (a workflow over the first build: 6 findings, 2 should, 4 nice; all fixed, none rejected): the busy
  lock's helper took a lock over after its 60-minute wait and then deleted it, and it checked and created in two steps;
  `w1_lock.py` (now beside the chain) takes the lock with `O_CREAT | O_EXCL` and a token of its own, deletes it only on
  that token and on a timeout takes nothing (the chain logs "NOT LOCKED" and goes on); the full tier was finished before
  the commit (below); px_test's coverage check counts only the rows of 5 px or more, the ones the lanes see;
  `tiff_test.py`'s measured rows say `focused` (the window brought to the front for each variant, its focus at the
  start and the end) and the chain retries a tiffperf run with the window behind (before/'s tiff rows have no such
  field: unchecked); the byte identity on transparent content, and the old build's source in `w1_identity.js`'s header;
  the stand-in rows above.
- **Tests:** `node tools/px_test.js` `pngFilterCases`: 1032 cases on both builds against the twin (each also at an odd
  offset), the twin against px_test's reference, the SIMD lines unfiltered back to the input: every width from 1 to
  40 px and widths around 64, 256, 1024 and 4096 px, with and without the row above, random, tiny-range, two-value,
  around-128, flat and per-filter rows, rows equal to the one above, and Up at 128 a byte over more than 255 groups. In
  the rows of 5 px or more None wins 637 rows, Sub 681, Up 543, Average 552, Paeth 353; ties of the sums are won by None
  421, Sub 255, Up 42, Average 4; Paeth ties a over c 13,337, b over c 7,408. `w1_identity.js` on real pictures (new
  SIMD, scalar, old SIMD and the twin on every line): the 15k photo Scumble wrote (its own lines equal the new ones),
  two RGB files of another encoder, and a 6000 x 4000 RGBA picture with 56 % alpha 0 and 11 % partial alpha on which
  every filter wins rows (None 156, Sub 153, Up 463, Average 2,872, Paeth 356): all identical. In the app the 15k
  photo's PNG export is one file in all six runs before and after (184,507,848 bytes, sha256 `3cb4f984...`). Gates
  `--offline`, tiles: lint types export layered pxjobs pixels document tiff PASS (`layered`'s
  `the_pool_and_the_window_read_a_psd_alike` failed once on a cache field in its "a closed tab" shape and passed on the
  rerun: `docs/TESTING.md` flakes); canvas: export layered pixels document tiff PASS. `build_px.py --check` identical on
  both builds; `build_node.py --check` only the expected "differs" lines.
- **The mutation round** (a copy tree, `mutation/mut_w1.py`; the untouched copy PASS first, px_test and the `export`
  gate; each mutant rebuilt on both builds, the kill set `px_test.js`, a mutant left green also through the `export`
  gate on a fresh instance from the copy): **36 of 40 red** (the lanes 27 of 30, the scalar code 9 of 10, which the
  scalar build runs whole and the SIMD build for rows under 5 px, first pixels and tails). The four survivors are
  equivalent: `pa <= pb` as `<` in the lanes' `choose` and in the scalar `paeth` (pa = pb with a != b puts c midway, so
  pc = 0 and c is picked; with a = b either pick is the same byte; 0 of the 2^24 triples differ, the review's
  exhaustive probe), `end` a group less (that group goes through the scalar tail, the same sums and bytes) and `MIN` 4
  bytes (a row under 20 bytes runs no group). The restored copy: PASS, both builds identical to the committed ones.
- **Before -> after** (medians of three fresh runs, 15000 x 10000; the card held 8.0-8.8 GB at 37-56 % in both, another
  process's training run): the png_part filter lap about 13x faster (export_png 4,313 -> 332 ms summed, export_ora
  13,162 -> 1,014, save_png 4,286 -> 334, the own-TIFF open's store 5,701 -> 760, the photo's PNG 4,841 -> 658). The
  whole operations: export_png 1,899 -> 1,375 (1,314-1,432), export_ora 5,075 -> 3,522 (3,514-3,660), save_png 2,565 ->
  2,075 (encoded 1,827 -> 1,300), the photo's PNG export 2,032 -> 1,422, the own-TIFF open 5,232 -> 4,309 (its store
  2,128 -> 1,329), build_the_file's encode 2,353 -> 1,776; all beyond their spreads. The window's longest blocks are
  unchanged (export_png 82 -> 79, export_ora 44 -> 45, save_png 106 -> 107): the filter is worker work. Untouched and
  inside their spreads: deflate (export_png 7,003 -> 7,019, now 70 % of png_part), the TIFF exports, save_png's disk
  write. px_bench's band (explains only): SIMD 19.8 -> 1.45 ms, scalar 22.9 -> 22.7.
- **What it leaves:** a PNG export's png_part is now deflate first (7.0 of 10.1 s summed at 15k, export_ora 15.5 of
  21.3). That deflate is already Rust (miniz_oxide at level 2 in the workers, `inpaint_png.js` `PNG_LEVEL`, chosen in E2
  at 84 MB/s a worker); a faster one means another level or codec, which changes the files' bytes, and no session of
  the order has it. W1 reorders nothing.

Next: K12.

### K12 (2026-11-06): relight's march in stripes

The order of 2026-10-24 (W1 -> K12, Stop 5), on `0ca7d5b`; normal tier by the table, with the pixel path's tests of
§4.5 (the shadow maps change how they are made, not their bytes). `docs/measurements/k12_2026-11-06/` (`k12_chain.sh`,
`k12_others.py`, `summarize.py`, `before/`, `after/` and `after_build/` (the build's own after, the same code but the
march's group name) with their `summary.txt`, `gates/`, `mutation/`; `harness_try1/` is a first baseline, not used).
- **Built (JS only, ABI 21 unchanged, `px.wasm` and `px_scalar.wasm` untouched):** `inpaint_relight.js` `stripePlan(h,
  count)` (even contiguous stripes, never under `STRIPE_MIN_ROWS` 32) and `marchOnPool(pool, args, { priority, group,
  stripes })`: a depth map on a SharedArrayBuffer marches in `STRIPES_PER_WORKER` 4 x the pool's size stripes (32 of
  about 85 rows at 4096 x 2731, 21 for the quick map) into one shared `out`, each reply `{ row0, rows }` without a
  transfer and checked against the plan; a failed stripe or other rows cancel the rest of the group and reject; a page
  that is not isolated (the node's) and the new route `relightStripes` 0 or 1 (`px/kernels.js`, kind "count") keep one
  job a light. `ensureRelightMaps`: the quick depth on a SAB; one pool group per march (`relight<n>:<layer>:<channel>:
  <size>:<ticket>`, `n` the page-wide `nextPartsSeq`, so a second tab of the same document never shares a group); a
  full march supersedes the channel's march in flight when the light moves on, goes off or comes back to the key the
  channel holds (its queued stripes cancelled, its pending key freed at once and never again at its end); a quick
  march is never superseded; `CancelledError` silent. The worker writes a stripe at `row0 * w` and answers with a
  `timing` (kernel ms, rows). `px.js` `_slot(kind, key, data, bytes)`: one resident block per kind (§3.2), copied
  again only when the key (the map's data and size, named by the window) or the size changes, so the Rust sun's
  stripes copy the 22 MB depth map once a worker.
- **The chain rows pinned (K0c's "Rows to pin"):** W0b's relight chain rows (62 / 60 / 483 ms, 16 / 16 / 2,376
  chains) did not differ because full marches held the pool (§4.5's inference): addFilterLayer leaves the relight
  layer active with the lights tool, so every draw runs `drawLightsOverlay` -> `ownLightPos` -> `belowStats`, which
  after a whole change of a layer below reads the whole picture at 256 px on the window (2,376 exact chains, about
  380 ms at 15k), and whether that read fell into the timed frame or into a draw in the 30 ms wait before it decided
  the row. `perf_test.py` now runs those rows with the paint layer and tool once the setup's marches have landed, the
  change and its frame in one task, and the overlay's read as its own row (`whole_1to1_lights`); 16 built / 2,344
  asked in every run since. A finding for later (not K12's): with the lights tool on a relight layer, a whole change
  of a layer below costs the next frame about 380 ms on the window at 15k.
- **The review** (a workflow over the build: 2 should, 5 nice; none rejected): the efficiency was computed for the
  re-march rows only (the same light marched again unchanged), while the named one-light row, the one q6.7 reads, ran
  its stripes slower: `perf_test.py` now computes it for the named rows too, and the build's runs regenerated from their
  JSON give 0.669 [0.540-0.680] (`after_build/summary.txt`), below 0.85, against the re-march's 0.874; the new rows
  (each worker's first stripe against its later ones, the other pool jobs and mip chains of a row) and the new runs
  say why (below). The canvas backend had run the gate before case nk's last checks: run again (311 checks). The march's
  group is unique for the page (`nextPartsSeq`); case nk counts the full marches posted (3) and requires exactly the
  stripes of two cancelled, not `>= 2` jobs; a row with a sun (the Rust sun and the resident slot, which no row timed)
  and a row of eight NORMAL jobs during a three-light march (what other NORMAL work waits for now) were added. Accepted
  until K13: within one sun march a stripe can come from the f64 twin while the others come from Rust's f32 kernel, when
  that worker's Rust call trapped and the job finished on the twin (kernels.js's recovery); before K12 a map came from
  one kernel. The two differ on rare pixels (question 6.6; one flipped tap is 64 levels at 4 taps), only after a trap,
  and K13 makes them byte-equal, so no check of the stripes' kernels was built.
- **Tests:** `node tools/px_test.js` PASS: `relightStripeCases`, `stripePlan` over 12 heights x 8 counts, 308 cases of
  S stripes into one buffer equal to one call (the twin for point, spot, a light on a pixel, below the surface and off
  the map; the Rust sun straight up, grazing and through `lightToMap`, on both builds and through kernels.js; 512 x 341
  and 1024 x 682 at taps / steps 1/16 to 16/64 in 2 to 21 stripes), the slot (eight keyed stripes copy the map once,
  0.33 MB against 2.66 MB unkeyed; a new key or size copies again), `marchOnPool` on a real `WorkerPool` with fake
  workers (the failure, rows and outside-cancel paths). The `relight` gate on both backends `--offline` (`k12-tiles-d`
  312 in-app checks, `k12-canvas-c` 311), its new case nk ("three nudges: only the last key lands", for a point and a
  sun; three nudges without a flush cancel nothing; there, back and there again posts two full marches and lands one;
  the route 0 is one job of all rows); `pxjobs`, `lint`, `types` PASS; `build_node.py --check` only the expected
  "differs" lines (the node build is due at the release). A mutation round on a copy tree (`mutation/`, on the build
  before the review's two code changes): 16 of 16 red, two of them by a livelocked or lost page rather than a check
  (a superseded march that frees its key again re-asks for ever; quick marches superseded), both the reason for the
  guards.
- **Before -> after** (medians of three fresh runs, 15000 x 10000, map 4096 x 2731, `perf_test.py --filter=relight`;
  `after/summary.txt`; the third after run ran beside another agent's torch job and is 1.3-2.2x slower on every march
  row): one light moved, its shadows landed 3,545 -> 649 ms (626-923), three lights 3,665 -> 1,031 (1,026-1,538), a
  drag step's quick map 44 -> 7.4, the first march after start 3,949 -> 2,286; a pan at 1:1 during a march, its worst
  frame 92 -> 10.4 ms (the march 3,865 -> 561). The A/B in one run (route `relightStripes` 0 against the stripes, the
  same lights): one light 3,492 -> 592, three 3,585 -> 1,106, a sun (the Rust sun) 1,462 -> 251. The window's longest
  blocks inside their spreads (one light 56 -> 58, three 53 -> 47) but the drag step's, 30 -> 37 ms, outside them: the
  same landing, now within 6 ms of the step (inferred: in its task instead of a block of its own). The chain rows are
  not worse (1:1 frame 32.8 -> 31.8, its mips 100 -> 105 (93-107); fit 19.9 -> 19.3; the 192 px pictures 338 -> 340 and
  16.4 -> 10.8; the lights overlay 383 -> 380), and a whole change's mips during a three-light march 163 -> 150 (the
  mips, INTERACTIVE, wait for at most one stripe). The route: stripes win every march row far beyond the spreads; no
  route entry.
- **For Stop 5:** the parallel efficiency (the one-job march's summed kernel ms / (8 workers x the stripes' wall)): one
  light 0.670 (0.528-0.689) on the named row (moved and released: what q6.7 means) and 0.728 (0.632-0.827) on the same
  march again; three lights 0.914 / 0.853; a sun 0.693 / 0.703 (stripes of 60-75 ms). So one light and the sun are
  below q6.7's 0.85 and three lights at or above it. The loss is the idle share (busy 0.89-0.98 for the twin, 0.78-0.81
  for the sun: the tail of 32 stripes on 8 workers and the dispatch) and the same work running slower on eight busy
  cores than as one job (kernel x 1.07-1.39), plus, on the named row only, the window's work after the release:
  `diag/` marched a moved light with the window left alone against moved and released, in the same runs (beside the
  other agent's GPU job, so only the pairs count): released lower in all three (0.604 / 0.648, 0.682 / 0.874, 0.595 /
  0.659), and in the least loaded run left alone equals the re-march. No other pool job and no mip chain ran in those
  rows. Shared-memory wasm threads would remove none of it (the twin is JS and reads the shared map in place; the sun
  copies it once a worker); what they could win is the dispatch, inside the idle share. New costs: other NORMAL pool
  work queues behind a march's stripes (eight small NORMAL jobs posted after a three-light move wait 1,019 ms, 5 ms with
  one job a light; a transform's or a canvas turn's resample rows, `psd_read`, any `pool.run` without a priority); not
  built: a march keeping about pool.size stripes queued at a time, or the full marches below NORMAL. And the drag step's
  block above. Not measured: `STRIPES_PER_WORKER` 8.

Next: Stop 5.

### Stop 5 (2026-11-06)

Decided by a workflow of a decider and a critic from K12's runs; nothing was measured in this stop and no code changed.
The files: A = `docs/measurements/k12_2026-11-06/after/summary.txt` (its before-runs in `../before/`), B =
`../after_build/summary.txt` (the build's own after), D = `../diag/summary.txt`, W =
`docs/measurements/w0b_2026-10-23/summary.txt`. The critic's corrections are taken: four musts (q6.7's "skip unless
below 0.85" is §6's suggested answer, not the user's; the list of the pool's NORMAL work; the wording of the user's
0.1.52 exception; two gaps in K12b's feed) and twelve smaller points. Its readings of the pool's priorities were checked
in the code at `bc3c37e` and hold; the verdicts are the decider's.

**What the rows say (A unless named):**
- **The parallel efficiency** (the one-job march's summed kernel ms / (8 workers x the stripes' wall), medians of three
  runs): one light 0.670 [0.528-0.689] on the named row (moved and released: the row q6.7 means) and 0.728
  [0.632-0.827] on the same march again (B: 0.669 / 0.874); three lights 0.914 / 0.853; a sun 0.693 / 0.703. One light
  and the sun are below q6.7's 0.85, three lights at or above it.
- **Where one light's loss goes** (inferred from the medians): the one job's kernel is 3,474 ms, so 434 on 8 workers
  would be ideal; the stripes take 649. Their kernel summed is 4,810, 601 a worker. About 48-55 ms are idle (649 - 601,
  or 649 x (1 - busy 0.916)): the tail of 32 stripes on 8 workers, the dispatch and the landing. The other 167 (601 -
  434) is the same work running slower: about 60 from eight busy cores (the re-march's kernel x 1.141) and about 105
  from the window's work after the release (x 1.385 against x 1.141; D: released below left alone in all three runs,
  inferred to be the window and the GPU process drawing the moved light's shading beside the workers).
- **The sun:** busy 0.78-0.81, so about 50-55 ms of its 251-260 are idle (stripes of 60-75 ms). Its felt wall is the
  named row, 260 [244-371]; 251 [244-378] is the re-march.
- **The felt walls left:** one light 649 [626-923], three lights 1,031 [1,026-1,538], a sun 260. The twin's stripes are
  0.89-0.98 busy, so these are mostly kernel time spread evenly over the workers. The first march after start, 2,286
  [2,239-2,335], is not: it is the setup's march, timed while the run's earlier rows ran beside it
  (`tools/perf_test.py:26-31`, `:826-834`), about 1.2 s above a three-light march. The window's longest block during a
  march is 47-64 ms (the pan row's 64 [16-83]): a wait, not a freeze.
- **The chain rows are not worse:** every pinned row lies inside its spread but one, which is a tie: at fit the mips'
  longest block 25.3 [24.4-28.9] -> 29.7 [22.4-33.4], above before's maximum by less than the spread (§1.1 rule 2). A
  whole change's mips during a three-light march 163 -> 150: INTERACTIVE work waits for at most one stripe.
- **Two new costs.** (1) Other NORMAL pool work queues behind a full march's stripes: eight small NORMAL jobs posted
  after a three-light move wait 1,019 [1,014-1,584] ms, against 5.0 with one job a light and 0 with no march (first
  come, first served within NORMAL, the march's 96 stripes ahead). The wait is bounded by the rest of the march (about
  0.65 s for one light, about 1.0 s for three) and happens only while a full march runs. NORMAL in the code: `resample`
  (a transform's commit, a canvas turn; `inpaint_jobs.js:214`), the opens `png_read`, `tiff_read`, `image_read` and
  `psd_read` (no priority given; `inpaint_canvas.js:553`, `:692`, `:784`, `:18628`), the full `relight_normals`
  (`:23487`) and the other full marches (`:23666`). Not NORMAL: `depth_guide` (`:13111`, `:13223`), `depth_fuse`
  (`host.js:5324`) and `relight_ratio` (`host.js:3857`) are INTERACTIVE; the row's `crc` is the harness's stand-in, the
  app's crc runs at EXPORT through the band writers' `partsRun` (`inpaint_canvas.js:17858`, `inpaint_encode.js:63`).
  (2) The drag step's block 29.9 [28.4-33.3] -> 36.7 [34.9-37.1] (B 37.3): outside the spreads, but across builds; no
  one-run A/B of the quick map was run.

**What Stop 5 decides:**
1. **K13 and K14 run, in their places** (#25 and #26 of the order after Stop 1). The felt walls left are kernel time
   spread evenly, so a faster kernel cuts them about in proportion, and §1.1 takes Rust wherever the whole operation
   gets faster; the chain rows are not worse. Not a given: K13 hoists the per-tap `Math.hypot` in the twin too (the
   same bytes), and the Rust f64 kernel has to beat that faster twin; today's f32 point kernel loses to the twin (W:191,
   SIMD 3,984 against the twin's 3,348; explains only). K14 takes the sun's route (§4.5); q6.6 is unanswered and is
   asked at K14's start with the behaviour said first (§1.2: f64 makes Rust and the twin give the same bytes, so rare
   pixels of a sun change once against 0.1.50). The mixed sun stripes K12 accepted after a Rust trap end at K14, and
   only if the sun goes f64 (K12's entry says "until K13"; the sun's route is K14's); with f32 they stay. **Not moved
   up:** what relight leaves is a 0.65-1.0 s wait with a window block of 47-64 ms, and the sessions ahead are more felt
   and more frequent (inferred): K26's brushes at 79-256 ms a move, K21-K23's selections at 1.2-4.9 s, K8's PNG open,
   K32-K34 on every result. They stay on `wasm-kernels` for the release at the end: the user's 0.1.52 exception
   (CLAUDE.md on `corridorkey`, `6e9c0cf`) ships the finished D0, K5, W1 and K12 and keeps the kernel work after it
   (G6 on) on the branch.
2. **The threads spike (§4.5's optional K-L4, q6.7): decided at K14, and asked now.** By §6's suggested answer ("skip,
   unless K12's parallel efficiency is below 0.85"), which stands while the user says nothing, it is not skipped: 0.67
   for one light, 0.69 for the sun. It cannot run before K14: until K13 / K14 every point and spot light marches on the
   JS twin (`kernels.js:475` sends `light[3] !== 1` there), which a wasm-threads build does not speed up; only the sun
   runs in wasm. Its ceiling is the dispatch inside the idle share (about 48-55 of 649 ms for one light, 50-55 of 260
   for the sun); the other causes K12 found (eight busy cores running slower, the window's work after the release, the
   tail) are ones threads do not remove. Its cost: 1-1.5 d, a nightly toolchain, a third build and a 4 GB shared memory
   that never shrinks, against §3.2's release policy. K12b's 8-stripes row measures that ceiling for free (below); the
   spike is decided again at K14 on K14's kernels and that row. The rule's letter and its reason disagree, so the user
   is asked whether to drop it now (recommended).
3. **A new session K12b before G6** (§1.2: a stop re-ranks by what was measured). K12 ships in 0.1.52 (merged into
   `corridorkey` after this stop, the user's yes of 2026-11-06), and its own new row measured the NORMAL wait above; the
   fix is small JS with the same bytes. Its scope:
   - (a) **The feed.** One budget for all full marches on the pool together: about `pool.size` stripes queued at a time
     across every march, the next posted as one answers, so a NORMAL job waits at most about one stripe round. A budget
     per march is not enough: with three lights about 24 stripes would stay queued and a NORMAL job would still wait
     two to three stripe rounds (about 250-350 ms, inferred). A class below NORMAL would be a new fourth one
     (`inpaint_pool.js` `PRIORITIES` is 3), not EXPORT: EXPORT carries every layer upload's PNG encode
     (`inpaint_encode.js:63`, `:89`), every export, the hash and the stack reads that default to it (`holdStack`,
     `stackMatches`, `stackSamples`, `programStart`; `inpaint_canvas.js:8542-8712`), so a release's shadows would wait
     behind an upload or an export in flight. Checks, as an A/B in one run: the eight-NORMAL-jobs row back near one
     stripe's wait; the one-light, three-light, sun and mips-during-a-march rows inside their spreads.
   - (b) **The drag step's block**, 30 -> 37 ms: a one-run A/B (the route `relightStripes` 0 against the stripes on the
     quick map). If it holds, §1.1 rule 3 (the window's wall is its longest block): bring the block back, for example by
     landing the quick channel in a task of its own; the quick map goes back to one job only if nothing else works.
   - (c) **The `STRIPES_PER_WORKER` 8 row** (the route `relightStripes` 64, no code; the quick map stays at 21 stripes
     by `STRIPE_MIN_ROWS`): the tail against the dispatch. If more stripes shrink the idle share, JS takes it; what is
     left is what threads could win.
   - Normal tier, the same bytes, about 0.5 d (inferred): the `relight` gate, `px_test.js`, `pxjobs`, `lint`, `types`.
     Its commit goes into `corridorkey` too only on the user's yes (question 3).
4. **G6 after K12b.** The user put G6 right after K12 (the answers of 2026-10-24); this stop puts K12b between them. #0
   M9 measured the 0.4 s link block paid once per profile with a cold GPU cache, and "#0 M9" above leaves whether G6
   still runs or ends as that note to the user when it comes up: it comes up now, so it is asked. Without an answer G6
   runs after K12b.
5. **Notes for 0.1.52, not asked:**
   - K12's mixed sun stripes after a Rust trap ship in 0.1.52: rare, only after a trap; on the branch they end at K14
     if the sun goes f64.
   - K12's pinning found a cost nobody has placed: with the lights tool on a relight layer, a whole change of a layer
     below costs the next frame about 380 ms on the window at 15k (`belowStats` reads 2,344-2,376 exact chains; A's
     lights overlay row 383 -> 380). There since 0.1.47, not a regression, larger than the drag step's +7 ms; now in
     `docs/BUGS.md` for the user to place. Its fix changes where the light's stats come from, so the behaviour is said
     first.
   - If K12b does not go into `corridorkey`, the 0.1.52 notes name the NORMAL wait and the drag step's +7 ms.

**How often:** no frequency above is measured; the felt-cost ranking is inferred, as in Stops 1 and 3.

#### The order after Stop 5

K12b -> G6 (or K4 at once, if the user ends G6 as #0's note) -> the order after Stop 1 / Stop 3 from K4 on: K4, K26,
K27; K21, K11, K22, K23, K25, K9, K36, K37 (Stop 3's #9-#16); K2, *Stop 2*, K6, K7, K8, *Stop 4*; K32, K33, K34; K13
(#25) and K14 (#26), both run; the threads spike (the optional K-L4) right after K14, decided there unless the user
drops it now; K24, K3, K10a-c, K15-K18, K20a-c, K28, K29, K30, *Stop 6*, K31, K19, K35, K38, K39, K40, K41.

**Asked of the user:**
1. **(q6.7) The threads spike.** The plan suggests skipping it unless K12's efficiency is below 0.85; the user has not
   answered it yet. Measured: 0.67 for one light, 0.69 for a sun, 0.91 for three lights, so by that rule it is not
   skipped. It can only run after K14: until then point and spot lights march in JS, which a wasm-threads build does not
   speed up. K12 measured where the loss comes from: the same work runs slower on eight busy cores, and (probably) the
   window draws beside it after the release; only about 48-55 of 649 ms are idle, and threads could win at most the
   dispatch part of that, under 50 ms a march. Its cost: 1-1.5 days, a nightly toolchain, a third build, 4 GB of shared
   memory that never shrinks. Recommended: drop it. Without an answer it stays the optional step after K14, decided
   there with K12b's 8-stripes row.
2. **G6, the shader link at start.** #0 measured the 0.4 s block once per profile with a cold GPU cache (probably the
   first open after an install or a driver update). The plan leaves to the user whether G6 (about half a day) still
   runs or ends as that note. The user put G6 right after K12; this stop puts K12b in between. Recommended: end it as
   the note and go on with K4 after K12b. Without an answer G6 runs after K12b.
3. **K12b in 0.1.52 too?** K12 goes into `corridorkey` after this stop on the user's yes, so into 0.1.52: clearly better
   on the whole (at 15k a released light's shadows land after 0.65 s instead of 3.5 s, three lights' after 1.0 s
   instead of 3.7 s), with one new drawback: other normal pool jobs wait during a march for its rest, about 0.65 s for
   one light and 1 s for three, instead of 5 ms (the resample after a transform, opening a PNG, TIFF or PSD file), and
   the drag step's block is 7 ms longer. K12b fixes that (JS only, the same bytes, about half a day). Should K12b go
   into `corridorkey` too, as a second merge before G6 lands, or should the merge wait for K12b so there is one merge
   (the user's word says to merge once K12 and Stop 5 are committed)? Recommended: a second merge. Without an answer
   only K12 is merged, and the 0.1.52 notes name the wait and the +7 ms.

#### The user's answers (2026-11-06)

Asked in chat after this stop, every recommendation but the first taken:
1. **The threads spike: decided after K14** (the user's pick "Nach K14 entscheiden", not the recommended drop). It stays
   the optional K-L4 right after K14, decided there on K14's kernels and K12b's 8-stripes row (K12b (c): one light a
   tie, three lights 3-4 % faster, a sun 3-7 % slower; about 2-4 ms of a worker's time a stripe, inferred).
2. **G6 ends as #0 M9's note** ("Nur Notiz"): the 0.4 s shader link block once per profile with a cold GPU cache stays
   as it is; no G6 session. After K12b the order goes on with K4.
3. **K12b goes into 0.1.52** ("Ja, in 0.1.52"): a second merge of `wasm-kernels` into `corridorkey` after K12b's
   commit, so the 0.1.52 notes need not name the NORMAL wait or the drag step's +7 ms.

The order from here: K4, K26, K27; K21, K11, K22, K23, K25, K9, K36, K37; K2, *Stop 2*, K6, K7, K8, *Stop 4*; K32, K33,
K34; K13 (#25), K14 (#26), the threads spike decided right after it; K24, K3, K10a-c, K15-K18, K20a-c, K28, K29, K30,
*Stop 6*, K31, K19, K35, K38, K39, K40, K41.

Next: K12b.

### K12b (2026-11-06): the marches' feed

Stop 5's scope 3. (a)-(c), on `2ea002b` (K12's code); normal tier, the same bytes. `docs/measurements/k12b_2026-11-06/`
(`k12b_chain.sh`, `k12b_others.py`, `summarize.py`, `quick_gaps.py`; `before/`, `after_build/` (the build's own after),
`after2/` (the order-swapped rows), `after_busy/` and `after/` (the review's rows), each with `summary_rows.txt`;
`gates/`; `summary.txt`).
- **Built (a), JS only (ABI 21 unchanged, `px.wasm` and `px_scalar.wasm` untouched):** `inpaint_relight.js`
  `marchOnPool(..., { budget })` sends a full march's stripes through the pool's feed (`feedMarch`, `feedPump`,
  `feedFail`; one feed per pool in a WeakMap, so the marches of every layer and every tab share it): at most `budget`
  stripes of all fed marches posted at once, first come first served across the marches, the next posted in the
  answer's microtask; a fed march's stripes carry `pool.defaults()` of its start, as K12's did. `cancelMarch(pool, group)`
  drops a march's stripes still in the feed and cancels its posted ones (a superseded march, `inpaint_canvas.js`
  `supersede`); `marchFeedStats(pool)` for the tests and the harness. The window's budget is the pool's size + 1: every
  worker busy and one stripe queued, so a worker that frees takes that stripe before any queued EXPORT job (an upload's
  encode, an export's bands) and the classes keep their order; with the size alone a queued EXPORT job takes the first
  worker that frees (px_test shows both). Quick marches stay at budget 0 (every stripe at once, INTERACTIVE, never
  cancelled by a full one). The route `relightFeed` (`px/kernels.js`, kind "count"; 0 posts every stripe at once, K12's
  way). No new priority class and no march moved to EXPORT. Accepted (the code comment): a running stripe the pool
  cancels on a supersede leaves the feed's count at once while its worker still runs it, so the next march's stripes may
  queue behind it for one stripe round.
- **(b) not confirmed, no code:** the drag step's window block, one job (the route `relightStripes` 0) against the
  stripes on the quick map in one run: 37.7 / 37.9, 36.0 / 33.8, 38.9 / 31.2, 38.0 / 34.9, 37.0 / 36.8 ms in five sets.
  The window's gaps show the block is the step's own frame in both routes (a gap 7-21 ms after the step, 31-40 ms long),
  the landing a gap of its own after it; K12's 30 -> 37 was across builds and harness positions (the named row moves by
  7 ms between sets with the same code).
- **(c) for K14 (`STRIPES_PER_WORKER` stays 4):** 64 stripes (the route `relightStripes` 64) against 32, the same march
  again, on the three quiet sets: one light a tie (507 / 500 / 507 against 497 / 519 / 511), three lights 3-4 % faster
  (1,036 / 1,048 / 1,030 against 1,080 / 1,083 / 1,069: a shorter tail, busy 0.97 against 0.96), a sun 3-7 % slower
  (249 / 262 / 258 against 241 / 245 / 250, +8-17 ms; busy 0.77-0.79 against 0.81-0.82); beside the outside job (below)
  0.5-3 % and +1 ms. So a stripe costs about 2-4 ms of a worker's time (inferred), the dispatch a threads build could
  win: about 8-16 ms of a sun's 245 and a light's 510 at 32 stripes (inferred). The row to try at K14, whose sun route
  changes: a stripe count per kernel (8 for the twin, 4 or fewer for a sun).
- **The review** (a workflow over the build: 2 should, 2 nice; none rejected): the eight-NORMAL-jobs row's explanation
  was wrong (the summary said the slowest of the eight waits for nine stripe answers). Its own numbers rule that out:
  the eight 1 KB jobs queue behind the one queued stripe, the second stripe answer's worker takes the first job, and the
  eight run back to back on it (`_reply` -> `_pump` gives a freed worker the queue's head), so the 73 ms is one job's wait,
  the worst case at a march's start; the corrected text and a new row of eight jobs of about a stripe's time
  (`relight_heavy_*`) say what work that takes real time waits for. No check showed that a quick march bypasses the
  feed: the gate's case nf now posts one while three full marches wait in it (nothing more fed, its stripes on the pool
  at once, landed before the full marches' last; red with the quick marches given the full budget). A terminated pool got
  new workers from the feed: `WorkerPool.terminate()` rejected the posted stripes but left the pool usable, and the
  rejection handlers posted the marches still waiting, so `resetPool` (a harness's fresh pool) left workers running the
  old marches that nothing stopped; `terminate()` now sets `terminated`, and `feedPump` on a terminated or off pool fails
  every waiting march (px_test's new case, red without the guard). The sun's 64-stripe loss was given as 3-5 %; it is
  3-7 % (+8-17 ms), the per-stripe cost 2-4 ms.
- **Tests:** `node tools/px_test.js` PASS (`feedCases`: the budget across two marches, first come first served, the
  bytes of one call; a NORMAL job after the first stripe's answer, after every stripe without a budget; one set of job
  fields a march; size + 1 against the size alone with an EXPORT job queued; `cancelMarch` on a march partly posted and
  on one waiting whole; a failed stripe; a terminated pool). The `relight` gate on both backends `--offline`
  (`k12b-fix-tiles` 315 in-app checks, `k12b-fix-canvas` 314): case nf (three lights' marches post at most the pool's
  size + 1, the rest waits, all land with the bytes of one call; the quick march; the route `relightFeed` 0 posts every
  stripe at once) and case nk counting the superseded marches' stripes in the pool and the feed together (12 = 2 x 6, 3
  in the feed). `pxjobs`, `types` PASS; `lint` 0 errors without the other agents' worktrees (`npx eslint .` is rc 1 only
  from two parse errors under `.claude/worktrees/`); `build_node.py --check` only the expected "differs" lines.
- **Before -> after** (medians of three fresh runs, 15000 x 10000, map 4096 x 2731, `perf_test.py --filter=relight`;
  `summary.txt`; the A/B in one run against the route `relightFeed` 0). The last two sets ran beside an outside CPU job
  (not this repo's, not under the lock: four Python workers at about 1.1 threads each on the 24-thread machine; waited
  30 min for it to end, it did not), so their march rows are 3-5 % slower on every route, the one-job ones too.
  - Eight 1 KB NORMAL jobs posted after a three-light move: their slowest waits 986 -> 73.5 / 76.3 / 69.2 / 73.2 ms in
    four sets, against 998-1,040 with every stripe posted in the same runs and 4.6-5.3 with one job a light (before K12).
  - Eight NORMAL jobs of about a stripe's time (a crc of a 30-31 MB blob, 60 ms alone, 113 ms side by side): the first
    waits 72.1 [69.9-74.1] ms (the release's second stripe answer), the last 142 [142-173] (one three-light stripe, 121
    ms, more), the last answer 208 [204-237]; with every stripe posted 1,030 / 1,044 / 1,151; with one job a light 0 /
    93.9 / 170. So work that takes real time gets the pool back within about one stripe round: about 40-50 ms later than
    before K12 and about 0.9 s sooner than with every stripe posted.
  - One light, three lights, a sun, three lights moved with the order swapped, the mips during a march: inside their
    spreads or a tie in every set. The sun leans to the unfed by 2-21 ms on the medians in four sets, the spreads
    touching in three; fed again after the unfed march (after) 256 [254-268] against 244 [243-263], busy 0.80 against
    0.82: a tie, no mechanism found (both routes give a freed worker the queued stripe in the reply's own task). The mips
    during a march: the first of the three rows is the slowest in every set, fed again ties the unfed.
  - The window's longest block on a three-light release, 49-91 ms across the sets with the same code, is the same fed or
    unfed in one run: the second and third lights land about 40 ms apart and their landings and redraws run back to back
    (the gaps at 1,040-1,090 ms after the release). A finding for later, not K12b's; it is there with every stripe posted
    too.
  - **The route:** the feed is the default (`relightFeed` absent = the pool's size + 1); no route entry. It was built for
    the NORMAL wait, which it cuts 14x for one job and about 7x for the last of eight stripe-sized ones; no march row is
    worse beyond its spread, and it adds no work on the window (§1.1 rule 3).

Next: K4 (G6 ended as #0 M9's note, the user's answer to Stop 5).

### K4 (2026-11-07): the generic box pass

The order after Stop 5, first row, on `4f1826d`; full tier on the kernel (§1.4), no call site changed.
`docs/measurements/k4_2026-11-07/` (`k4_chain.sh`, `summarize.py`, `summary_rows.txt`, `before/`, `after/`, `gates/`,
`mutation/`).
- **Built (ABI 21, unchanged; no new export):** `crates/px/src/maskf.rs` `box_pass::<C>(data, tmp, sums, w, h, r,
  norm)`: one box blur of radius r along the rows and down the columns of a w x h image of C interleaved f32 channels,
  in place, the scratch the caller's (nothing allocated); `Norm::Div(n)` gives `sum / n` (the masks' twin,
  `kernels_js.js` `boxRow` / `boxCol`), `Norm::Mul(k)` `sum * k` (the dab blur's twin, `inpaint_stroke.js` `boxRows` /
  `boxCols`; K26's). The order of every twin: a running f64 sum per line and channel, started over the clamped window
  and moved by `sum + (enter - leave)`. The lanes (`lanes`, SIMD build only): one channel's rows two at a time, one per
  f64 lane (an odd height's last row on the scalar loop); four channels' rows one pixel a load, channels 0-1 and 2-3 in
  two f64x2 (reachable from K26 on); the column pass four values a step over the w * C values of a line, its tail on
  the scalar loop. `box_blurs` keeps C = 1 and `Div(2r + 1)` and allocates its scratch as before. Tried and dropped:
  four rows in two f64x2 sums (slower than the pairs in the explaining run below: 55.6 / 61.0 ms at 4096 x 2731).
- **Tests:** `node tools/px_test.js` PASS; `box_blurs` 63 cases on both builds against the twin bit for bit, each also at
  an odd offset (the 36 of before plus nine small sizes, 2 x 2 to 16 x 3, that put the pairs, the odd last row and the
  column tails at every edge, with radii above the width); `height_normals`' twin (`box_blurs` inside Rust) unchanged.
- **Before -> after** (`summary_rows.txt`: medians of three fresh instances, the window in front, the busy lock held;
  `w0_bench.py --rows=stitch_masks_2048,box_blurs_k4`; the output checksums the same in every run before and after):
  stitch.js `gaussBlur` on a 2048^2 mask (sigma 8, the whole function, the row that decides) 40.6 [36.5-55.0] -> 32.5
  [32.5-33.7] ms; `box_blurs` through kernels.js 2048^2 sigma 8 28.7 -> 21.2, a 4096 x 2731 map sigma 3 78.7 -> 57.4,
  one radius 8 (the guided filter's) 33.2 -> 25.6, sigma 16 82.7 -> 56.7; relight's `height_normals` 4096 x 2731 323 ->
  279. The twin 1.9-2.5x slower than Rust in every row. Explaining (Electron as Node, nine alternating rounds): the
  scalar build 89.3 -> 87.7 at 4096 x 2731 sigma 3 (the restructure alone, a tie).
- **Gates** (`--offline`, tiles, port 9583 beside the mutation round): lint types pxjobs relight edges maps key generate
  selection PASS; `node tools/edges_test.js`, `node tools/depth_test.js` PASS; `build_px.py --check` identical on both
  builds; `build_node.py --check` only the expected "differs" lines. The canvas backend not run: no call site and no
  byte changed (the twin cases and the app's checksums).
- **The mutation round:** `mutation/mut_k4.py` (a copy tree; the untouched copy green on px_test and the `edges` gate,
  both builds identical to `F:/canvas`'s); its results follow in the next commit.
- **No route:** `box_blurs` was Rust before and is faster now in every row; the twin stays the fallback.

Next: K26 (the dab blur and sharpen on `box_pass::<4>`).
