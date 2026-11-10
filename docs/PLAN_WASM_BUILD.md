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
- **The mutation round** (`mutation/mut_k4.py`, `results.txt`; a copy tree, the untouched copy green on px_test and the
  `edges` gate, both builds identical to `F:/canvas`'s; each mutant rebuilt on both builds, px_test the kill set, the
  `edges` gate for a mutant px_test left green): **22 of 26 red** at first. Two survivors are equivalent, as expected
  (one channel's rows left to the scalar loop; the column lanes a group short: the scalar loop gives the same floats).
  Two were not: `(sum + enter) - leave` in the row lanes and `s * (1 / n)` for `s / n`. **A gap in the test data:** the
  twin cases' masks are multiples of 1/255, whose sums are exact in f64, so no rounding order shows, and a last-bit
  difference in f64 rarely survives the store as f32. px_test now also blurs floats over fifteen decades (1e-12 to
  1e3, 75 cases), which round at almost every step; the order mutant is red on them (`box blurs 64x33 1: out[1269]`).
  The reciprocal mutant's rerun on the K4 tree was not valid (that tree lacks K26's px.js, so only K26's new dab
  cases failed): it goes into K26's round, which has the whole test. The restored copy: both builds identical.
- **No route:** `box_blurs` was Rust before and is faster now in every row; the twin stays the fallback.

Next: K26 (the dab blur and sharpen on `box_pass::<4>`).

### The user's answers after K4 (2026-11-07): the external review, SAM2 first

An external review (another agent's, pasted by the user) was verified by a workflow of eight read-only agents:
`docs/research/review_external_2026-11-07/` (`README.md`, `verified.json`). The user's answers the same day:
1. **Hardening in this release** ("ok ändere es in diesem release"): one session **H1** with S1 (the main window's
   `setWindowOpenHandler` only for http(s), one helper shared with `app:openExternal` and `comfyview.js`), S5 (a crafted
   PSD / ORA: the inflate capped at the bytes kept, layer and mask rectangles bounded, the ORA entry's size read, the
   window route's size check before `readPsd`; `layered` gate on both backends, the node build gets it at the release),
   S6 (the local pipe's line buffer linear and capped above the largest legitimate line, umask on Linux), S9a (recipe
   ids sanitised where recipes are read and refused at `save`), S8 (CI `contents: read` at the top, write only for the
   tag jobs; `provision.sh` pinned, its token by curl), `main.js` `staysInApp` limited to the app's own pages (no
   navigation of the window to `scumble://app/comfy/*`; added 2026-11-07), and **the permission handler of the ComfyUI window's session**
   (`persist:comfyui`; found by the verification, not in the review; the user asked whether it makes sense: yes): deny
   camera, microphone, location, MIDI, HID, serial and USB, allow the rest, so ComfyUI's page keeps its clipboard,
   fullscreen and notifications. S3 (the sign-in popups' guard and the narrowed Firebase host) waits for a live sign-in
   by the user (Comfy Cloud, GitHub, Google).
2. **Top priority: SAM2** ("höchste prio sam (das ist echt lahm)"): the ONNX helpers (SAM2, the matting models,
   depth) run on Electron's main process and freeze its IPC for seconds per run (P14; `docs/HELPERS.md` "Every model
   but LaMa runs on the main process's thread"). New sessions **U0** (measure first: SAM2's load, encoder, decoder
   batches, the pre- and post-processing, DirectML against the CPU, the main process's longest block, on the user's
   card; where "slow" comes from decides U1's scope) and **U1** (the helpers in a utility process on LaMa's pattern,
   `electron/main/onnx/lama.js` / `lama_process.js`: one process owning its runtime and SAM2's embedding cache, the
   main-thread engine as the fallback, VRAM release and the device switch reaching it; DirectML in a child process has
   never run here; an idle unload too, the user's pick of 2026-11-07: the process ends after some minutes without a
   helper call, so a cold SAM2 session's 6.1 GB on DirectML (`docs/BUGS.md`) goes back to the system), **U2** if U0's
   numbers show a speed fix beyond the move.
3. **P10 into the plan:** the tile gutter's copy in u32 words (`inpaint_tiles.js` `tileWithGutter`, as `coarseSlot`
   does; the same bytes; full tier, the atlas path), with P13 (the CorridorKey refine's hoisted mean and reused
   scratch, `keymatte.js`; also `blur121` carried on from k - 1 instead of from 0 for each k, 4 passes instead of 10, if
   the floats stay bit for bit), P15 (`ComfyClient.probe`'s requests together), P18 (the Settings dialog opens at once:
   `gpuMemoryMB()` / `cardMemory()`, which spawn `nvidia-smi` or a PowerShell counter, filled in afterwards as
   `refreshFileStats()` is) and P8 (the curves layer's histogram read back on every view pass: take
   `belowHistogram(layer).luma` instead) riding along (P8, P18 added 2026-11-07).

### K26 (2026-11-07): the blur and sharpen brushes in Rust

On `2c912d8` (K4) with the GPT Image 2.6 Comfy Cloud route merged under it; full tier (a kernel and the dabs' and
frequency separation's call sites, §1.4). `docs/measurements/k26_2026-11-07/` (`k26_chain.sh`, `summarize.py`,
`summary_rows.txt`, `ab/` with `before/` and `after/`, `ab_failed_relative_path/` (a first chain whose before arm never
started: the app log's relative path after the `cd` into the tree), `gates/`, `mutation/`).
- **Built (ABI 22):** `crates/px/src/stroke.rs` `blur_rgba` and `sharpen_rgba` (`inpaint_stroke.js` `blurRGBA` /
  `sharpenRGBA`, which stay as the twins): straight RGBA8 premultiplied in f64 and stored as f32, three
  `maskf::box_pass::<4>` with `Norm::Mul(1 / (2r + 1))` (the twin's `sum * k`), back to straight bytes through `clamp8`
  (a `Uint8ClampedArray` store: NaN 0, clamped, ties to even); every output byte written (the arena is never zeroed).
  `lib.rs` exports `dab_scratch_bytes(w, h)` (two f32 planes and the column sums, 0 on an overflow), `blur_rgba(src,
  out, scratch, w, h, r) -> u32`, `sharpen_rgba(..., amount)`. `px.js` `Px.blurRGBA` / `sharpenRGBA`: the radius
  rounded as the twin rounds it, null for what the kernel refuses (a short source, an empty or fractional size, a
  radius past 2^30), so the caller runs the twin. `kernels.js` `blurRGBA` / `sharpenRGBA` on the new route `dabBlur`
  ("js" for the twins), trap recovery and `releaseIfLarge`, the twins imported from `../inpaint_stroke.js` (which
  imports nothing). `inpaint_canvas.js` takes both from `./px/kernels.js`: the blur and sharpen brushes' dabs and
  frequency separation's blur (16 MP at most: the window's instance grows to about 640 MB for it and is released
  after, K1's release check). No route entry: Rust is the default.
- **Tests:** `node tools/px_test.js` PASS: `dabCases` 274 blur and 338 sharpen cases on both builds against the twins,
  byte for byte, each also at an odd offset (every size from 1 x 1 past the lanes' edges, radii 0 to 200, the alpha
  values at the premultiply's and unpremultiply's edges, faint alphas of 1 to 12 among zeros (added after the mutation
  round), transparent holes, opaque boxes, a 400 px brush's 448 x 448
  box, r 2.5, NaN, -3, amounts 0.5, 1 and 2.25), the refusals; `box_blurs` 75 cases (K4's plus the wide-range floats).
  `node tools/stroke_test.js` PASS. The `editor` gate's blur and sharpen step and its frequency separation step now
  assert `blur_rgba` / `sharpen_rgba` ran and run the same stroke (or separation) again on the route "js" after an undo:
  31 blur and 11 sharpen calls, 0 bytes differ, frequency separation 1 call, 0 bytes differ. Gates `--offline` (port
  9583, `gates/`): before the review tiles lint types editor brush pxjobs and canvas editor brush PASS; after its fixes
  `k26-fix-tiles` types editor brush pxjobs PASS (the sharpen replay too: 0 bytes differ), `k26-fix-canvas` brush PASS
  and editor red once in `live_stroke_preview_shows_what_the_commit_writes` (a TESTING.md flake: the mutation round
  started and closed its instances beside it), `k26-fix-canvas-rerun` lint editor PASS. `node tools/stroke_test.js`,
  `node --expose-gc tools/kernels_release_test.js` PASS; `build_px.py --check` identical on both builds;
  `build_node.py --check` only "differs" lines (the node is built at the release).
- **Before -> after** (`summary_rows.txt`: three rounds, the arms alternating within each, a fresh instance per tool,
  15000 x 10000, the window in front, the busy lock held; before = a tree exported at `2c912d8`), ms per pointer move,
  median [min-max]: blur 400 px at fit 74.0 [73.9-94.6] -> 32.7 [32.0-33.5], 1000 px at fit 230.9 -> 99.3, 400 px at
  1:1 20.2 -> 9.7, 1000 px at 1:1 126.0 -> 58.1; sharpen 400 px at fit 78.7 -> 41.1, 1000 px at fit 246.1 -> 115.5,
  400 px at 1:1 20.6 -> 11.5, 1000 px at 1:1 133.5 -> 66.2; the stroke's longest window block about halved in every
  row (blur 1000 px at fit 398.6 -> 210.5). Frequency separation of a 4000 x 4000 box of the 15k photo (radius 40):
  wall 2,053 -> 1,012 ms, the window block 2,036 -> 1,004, its blur 1,756 -> 698; its split (K27's) 190 -> 210 and the
  read and write unchanged. All beyond their spreads.
- **The review** (a workflow of three lenses, each verified by a second agent: 10 findings, 6 confirmed, 2 should and 4
  nice; all fixed or settled):
  - **A memory leak since K1, in the released 0.1.52 too** (should): `kernels.js` `LOADING`, the first load's promise,
    resolved to the first instance and was kept for good, so every thread's first instance (the window's and each
    worker's) stayed reachable, with all the memory it had grown, after a release or the idle trim replaced it.
    K1b's "the window's synchronous release works" read the new instance's size (`pxInstances().bytes`), not the old
    one's fate. With K26 the window's instance grows to about 640 MB for a 16 MP frequency separation. Fixed:
    `LOADING` keeps a flag, `kernelsReady()` answers the instance in use. `node --expose-gc tools/kernels_release_test.js`
    (new): the released first instance is collected; red against the old loader (it also answered the first
    instance). In practice it held what the threads held before K1's releases; no hotfix asked (the user's call).
  - The four-channel lanes' rounding order (should): on the dab blur's premultiplied byte values the window sums are
    exact in f64, so neither `(sum + enter) - leave` nor `Div` for `Mul` changes a byte (the review's scratch run over
    dabCases' inputs: 0 bytes and 0 plane floats differ). Settled as equivalent on this kernel's inputs (no float user
    of four channels is planned; K24 is one channel); `maskf.rs`' comment and `mut_k26.py`'s expectations say so.
  - `Px.sharpenRGBA(..., null)` ran the blur (`_dab` read `amount === null` as the blur): an explicit mode flag now,
    the amount goes to the export as it is. A scratch past one `px_alloc` block is refused (`stroke.rs` `MAX_BLOCK`),
    so the twin runs instead of an out-of-memory recovery. The editor gate's sharpen step now replays its stroke on the
    route "js" too (0 bytes differ).
  - Refuted: the frequency separation arm hiding blur differences behind the split, a plain Array or a typed array of
    another element type as the source (no caller passes one), the node build's import of `../inpaint_stroke.js` (it is
    shipped).
- **The mutation round** (`mutation/mut_k26.py`, `results.txt`; a copy tree, the untouched copy green on px_test and
  the `editor` gate, both builds identical to `F:/canvas`'s; Rust mutants rebuilt on both builds, px_test the kill set,
  the `editor` gate for every mutant px_test left green and for the call-site ones): **21 of 27 red** at first. Four
  survivors are equivalent on this kernel's inputs: the passes' factor as a divisor and `(sum + enter) - leave` in the
  four-channel lanes (premultiplied bytes keep the sums exact), the four-channel rows left to the scalar loop (the same
  floats), and K4's `s * (1 / n)` for `s / n` (a last-bit f64 difference reaches an f32 only next to a rounding boundary,
  not once in 75 cases of wide-range floats). Two were a gap: the unpremultiply's threshold at 1 instead of 0.5 and
  sharpen without its transparent-blur case passed, since no case blurred alphas down to 0.5-1; px_test's new "faint"
  kind (alphas of 1 to 12 among zeros) kills both (the rerun on the review-fixed sources, `results.txt`'s last block).
  One kill is not counted: `kernels.js` sharpen's amount dropped went red on an editor gate that wrote no summary; the
  brush always passes 1 and px_test checks px.js' amounts, so it is equivalent at the call site. The restored copy:
  both builds identical.
- **What it leaves for K27:** a move is still almost all dab (30.6 of 32.7 ms for blur 400 px at fit: the box's read,
  the filter, `smudge_dab` and the write, not split here); frequency separation's blur 698 of 1,012 ms and its split
  210; the tone and sponge dabs untouched.

### U0 (2026-11-07): where the helpers' time goes

On `8689d49` by a background agent (`84a8d4d`, merged `6eded3d`); a measurement, no app code (`tools/helpers_perf.py`,
`tools/helpers_process_probe.js`; `docs/measurements/u0_2026-11-07/`, `docs/PLAN_HELPERS_PROCESS.md` §0-§2). Three
fresh runs per batch under the busy lock, the scene's 1024² input, the user's ComfyUI models folder read only. SAM2
base+ on DirectML: the first call 1,575 ms with main blocked 1,077 in one piece (the encoder's session), a warm point
8, the object map 1,928 (16 decoder batches 1,287, JavaScript 627) with main blocked about 0.2 s sixteen times, after
Free VRAM 2,786; tiny and small the same map (one decoder file); the export runs batch 1 and 64 only; the CPU 38 s per
map. BiRefNet lite on the CPU 4.8 s, all of it a main block; depth 0.24 s on DirectML. SAM2's DirectML allocations
are main's 3.5-6.2 GB of private bytes (the 6.1 GB of BUGS.md), back at Free VRAM. In a utility process forked from
main the same engine ran every DirectML job with main's longest block 0, and `kill()` returned everything in 9 ms. At
15k the object tool's shapes are document-sized canvases (0.3 s a hover, 1.3-2 s a click, 5-6 GB in the GPU process
for 13; BUGS.md). The plan: U1a / U1b (one helpers utility process, kill on Free VRAM / the device / the folder / quit,
the idle unload, the main-thread fallback); U2 ranked: warm on the tool pick, the shapes at the map's size, the
automask's JavaScript, the decoder's shape order, then the user's calls; seven questions in its §6. **U1 started the
same evening** by a background agent with §6's suggested answers (5 minutes idle, LaMa separate, a double death falls
back to the main thread, no window port) and without `warmObjects` (host.js was being edited).

### P10, P13, P18, P8 (2026-11-07): the atlas slot in words, and three riders

Built by a background agent on `e9ab0d3` (`ee938e6`, `4bc9fea`, `5d92ccd`, `8fd0d52`; the review's one test gap fixed
in `2c7f15d`), merged `2030f1c`; `docs/measurements/p10_2026-11-07/`, `p13_2026-11-07/`, `p18_2026-11-07/`.
- **P10** (full tier, the same bytes): `inpaint_tiles.js` `tileWithGutter` copies opaque runs with `Uint32Array.set`
  (runs under 16 word by word), zeroes transparent runs with `fill`, premultiplies soft words in place
  (SkMulDiv255Round for R and B in the two 16-bit halves of one word with `Math.imul`, G alone, A kept: the table's own
  values); word views once per source per slot; misaligned views, a source `off` not a multiple of 4 and big-endian keep
  the byte path; the coarse branch on `coarseSlot`'s word tests. `tools/gutter_words_test.js` against a verbatim twin
  (asserts which path ran); mutation round 21 of 21 red. At 15k, three rounds: native pan_and_zoom 322 -> 201 ms, the
  far pan at 1:1 12.1 -> 6.9 ms a frame (worst 18.1 -> 9.8), `put` 234 -> 111 ms, the frame after a whole change at 1:1
  29.2 -> 21.7; uploads unchanged (540 calls, 137 MB). JS only, no Rust.
- **P13** (bit for bit): `keymatte.js` `mP` once, one scratch for the products, `blur121` carried on from the last
  whole softness (10 pass sets -> 4); `keymatte_test.js` case 12 and an A/B over 192 cases (22.4 M alpha bytes, 681 k
  floats) equal; the fit at 2.8 MP 1,180 -> 970 ms. Mutation round 7 of 7 red.
- **P18:** `shell.js` `refreshGpuMemory` (not awaited, the newest read wins; `memoryReads` exported for the test):
  `openSettings` about 110 -> 40 ms here. The other serial awaits (`keys.list` twice) are left.
- **P8:** the curves passes (GPU and CPU) no longer build a histogram; the panel draws `belowHistogram(layer).luma`
  (alpha-weighted, so the old spike at black on transparent areas is gone: a visible change, in the CHANGELOG).
- Gates: the agent's `lint types composite pixels editor key recipes skins comfyview help` on both backends PASS; the
  merged state's in `mergep10`.

### H1 and P15 (2026-11-07): the hardening, the probe's requests together

Built by a background agent on `8689d49` (`e5c7aff`, `57a5f55`), a review workflow's 9 confirmed findings fixed in
`eb1224f`, merged into `wasm-kernels` (`96f037a`).
- **S1:** `electron/main/links.js` `openHttp` (http / https only, the parsed href) is the one way out to the system
  browser: the main window's `setWindowOpenHandler`, `app:openExternal`, `app:share`, the ComfyUI window's bar, page,
  will-navigate and sign-in children.
- **staysInApp:** `appPage(url, ORIGIN)` lets the main window go only to `/index.html` or `/` (a query or hash
  allowed); the bridge's `navigates` and `did-start-navigation`'s reload rule read the same predicate.
- **The ComfyUI window's permissions:** `guardPermissions(session)` once per session before the first load (request,
  check and device handlers); `comfyhosts.js` `DENIED_PERMISSIONS` media, geolocation, midi, midiSysex, hid, serial,
  usb and openExternal (added by the review: a frame could hand any scheme to the OS); the rest granted. ComfyUI's core
  Webcam Capture and Record Audio nodes need a browser now (the manual says so; **asked of the user**).
- **S5:** `inpaint_layered.js` `inflateAtMost(bytes, format, cap)` in 64 KB slices for the window and the pool (the
  same bytes within the cap); rectangles at most 65,535 px a side and 2^30 px; a channel's data must be able to fill
  its rectangle (raw every byte, RLE at least 2 bytes per 128 and its rows inside its own length, ZIP at least 1 per
  1,032); a refused merged picture of a file without layers refuses the open; ORA entries capped at their directory
  size, `stack.xml` at 16 MB, all deflated entries at 256 MB + 64x the file, one layer PNG below 2^29 px and all layers'
  IHDR totals at max(268 MP, 64 x W x H); `onHeader` puts the window route's size check before the parse. The node
  gets it with its next build.
- **S6:** `local.js`' line splitter keeps chunks and searches only the new one (64 MB in one line: 7,607 -> 44 ms),
  `MAX_LINE` 500 MB (a longer line ends that connection only), umask 077 for the Unix socket bind.
- **S9a:** recipe ids made safe when read (a warning), refused at `save`, which writes over the file the recipe was
  read from; `remove` deletes `r.file`.
- **S8:** `build.yml` `contents: read` at the top, write on draft, windows, linux and sizes, `persist-credentials:
  false`; `provision.sh` packs pinned (Inpaint Canvas `4bef98a`, overridable with `SCUMBLE_NODE_REF`, a full id),
  the Hugging Face token by curl; RELEASING.md's node step moves the pin. Proven only by the next tag build (the eight
  assets on the draft; a 403 names a job without write).
- **P15:** `ComfyClient.probe` sends `/queue`, the node check and the nine loader lists together after
  `/system_stats` (a stub with 120 ms per answer: 1,830 -> 417 ms), the answer key for key as before.
- **Tests:** `tools/links_test.js`, `comfyprobe_test.js`, `local_test.js` (new; `mcp_test.py` runs it first),
  `comfyhosts_test.js`, `recipes_test.js` §17, `layered_test.js` (inflateAtMost, 64 PSDs twinned between the readers,
  crafted fixtures with 512 MB bombs), `layered_test.py` `crafted_files_are_refused_on_both_routes`, `comfyview_test.py`
  (a permission probe, `main_stays`). Gates: the agent's `layered` on both backends and `lint types recipes comfyview`
  on tiles PASS; the merged state's in `mergeh1*`.
- **Asked of the user:** the media denial and the two core nodes; ids made safe vs settings stored under an old id; the
  ORA budget's 64:1.

### K27 (2026-11-08): the tone brush, the sponge and frequency separation's split in Rust

On `8729426` by a background agent (`97f9221`, `01acdb4`, merged `7de75d7`; a review workflow of two lenses found
nothing); full tier. `docs/measurements/k27_2026-11-08/` (`k27_chain.sh`, `summarize.py`, `summary.txt`,
`summary_rows.txt`, `ab/`, `gates/`, `mutation/`).
- **Built (ABI 23):** `crates/px/src/stroke.rs` `tone_rgba` (the stroke's 256-byte table copied in per call, never
  resident; protect's factor `(lut[v] - o) / v` divided once per brightest value into a table: the twin's f64s),
  `sponge_rgba` (SIMD four pixels a step: i32x4 channels / mx / mn / luma, the gain and outputs in two f64x2 halves, the
  twin's `Infinity` sides divided per lane and masked; `lim`, `max(1, lim)` and the cap as pmin / pmax, exact since
  lim >= 1; kept pixels from the source; the store nearest, then pmax 0 / pmin 255), `freq_split` (SIMD sixteen bytes a
  step in u8 lanes: t = I + !L, the floor average as avgr less the odd bit, alpha from I); the scalar build and the tails
  keep the twins' loops; `clamp8` through i32 (same bytes, cheaper; K26's blur and sharpen share it). `px.js`
  `toneRGBA`, `spongeRGBA`, `freqSplit`, `freqSeparate` (blur and split in one arena, the detail in the blur's
  scratch: no more memory than K26's blur, about 640 MB at 16 MP); `kernels.js` routes `dabTone`, `dabSponge`,
  `freqSplit` (trap recovery, `releaseIfLarge`), `freqSeparate` one call with both on Rust; `inpaint_stroke.js`
  `freqSplit` (the loop moved verbatim: the twin). No route entry.
- **Tests:** `px_test.js` groups `tone` (7,848 tone and 1,882 sponge cases on both builds, odd offsets, every edge
  combination at four alphas, the tables' extremes, the sponge's amounts and switches), `freq` (every (I, L) byte pair,
  the separation in one arena against blur then split, radii 0 to 200, NaN, -3), `retouchRoute`; the `editor` gate's
  tone / sponge and frequency separation steps replay on the route "js" after an undo (0 bytes differ). Gates lint types
  editor on both backends, pxjobs on tiles PASS; brush's node reader hung at exit side by side (a new TESTING.md flake),
  PASS alone. Mutation round 48 of 53 killed, the 5 survivors equivalent (`lim` >= 1, grey pixels' luma, a 32-byte lane
  step, a part pixel the export refuses).
- **Before -> after** (three rounds alternating, fresh instances, 15000 x 10000, the busy lock; ms per move): sponge
  400 px at fit 31.0 -> 22.1, 1000 px at fit 87.4 -> 66.6, 400 px at 1:1 8.9 -> 7.0, 1000 px at 1:1 52.0 -> 42.2;
  tone 400 px at fit 22.9 -> 19.9, 1000 px at fit 69.0 -> 63.6 and 400 px at 1:1 6.9 -> 6.4 inside their spreads (Rust
  by the tie rule: the kernel rows 5.4 / 6.7 ms smooth, 5.8 / 10.8 noise at 1002²), 1000 px at 1:1 43.1 -> 39.5;
  frequency separation of a 4000 x 4000 box: wall 1,033 -> 716 ms, the window block 1,021 -> 702, the split's kernel
  11.6 ms against the JS loop's 211; the window's instance back to 2.1 MB after a 16 MP separation.
- **What it leaves:** a tone or sponge move is mostly the rest of the dab (the box's read, `smudge_dab` twice, the
  write: 61 of 64 ms for tone 1000 px at fit); frequency separation's blur 580 of 716 ms.

### K28 (2026-11-08): liquify's bake in Rust (the Antigravity B chain)

By a Gemini agent in Antigravity (`.claude/coord/chain-b/`) on `7de75d7` (`c6bbbb7`, the review's 4 findings fixed in
`9979f58`), merged `0ae12df` (ABI 24); `docs/measurements/k28_2026-11-08/`. `crates/px/src/resample.rs`: the tap sum
`sample<const T: usize>` shared by `resample::run` (its bytes unchanged) and the new `resample::liquify` (s in
{1, 2, 4, 8}, the (dx, dy) bilinear from the node grid's corners, the whole-pixel path copying all four bytes);
`liquify_block` export; `px.js` `liquifyBlock`, `kernels.js` route `liquifyBlock` (the twin `inpaint_liquify.js`
`liquifyBlock`), passed as `liquifyStore`'s ninth argument in `inpaint_worker.js`, `inpaint_tiles.js`,
`inpaint_pixels.js`. Tests: px_test `liquify` (96 twin cases on both builds, colour under alpha 0 since the review),
`retouchRoute`, the editor's liquify step (call counts, the js route replayed after an undo). Before -> after at 15k
(three rounds, only the `liquifyBlock` route switched): the pool's liquify jobs about 1.7-1.9x faster on every row (a
1000 px push at fit 350 -> 199 ms summed), a 200 px push at 1:1 lands 24.9 [19.2-26.2] -> 20.0 [19.7-23.1] ms, inside the spread (the tie rule). Mutation round in its folder.

### K32 (2026-11-08): stitch's mask kernels in Rust (the Antigravity E chain)

By a Gemini agent in Antigravity (`.claude/coord/chain-e/`) on `29f6749` (`15e2009`, the review's 4 findings fixed in
`9bc125a`), merged `21b53a3` with the ABI renumbered 23 -> 25 and both builds rebuilt; `docs/measurements/k32_2026-11-08/`.
`crates/px/src/maskf.rs` `alpha_to_mask`, `mask_max_clamp` (V8's Math.max / Math.min NaN and signed zero),
`mask_one_minus`, `erode_mask` (one minus, `dilate`, one minus in one call), `mask_to_rgba` (white, luminance,
alphaMask), `mask_bounds_f32`; twins in `kernels_js.js`, route `stitchMask`; `stitch.js` wired (`maskFromAlpha`,
`maskMaxClamped`, `erode`, `maskToCanvas`, `selectionBbox`, `alphaMask`, `fillMasked`, `finishPixels`). The review
checked every kernel expression by expression against the old `stitch.js`; `tools/stitch_test.js` now holds
`fillMasked` and `finishPixels`' colour match against verbatim copies of the old loops (mutants killed on pixels).
At 15k a provider crop (warmed) 719 -> 617 ms, its prep 184 -> 126 ms; stitch at 2048 the clamp and max 109 -> 16 ms
in the worker.

### The user's answers of 2026-11-09 (option A, Stop 2, questions 6.2 and 6.4)

Every recommendation taken (the user: "alles so wie deine empfehlung").
- **K22 / K23: option A** (below).
- **Stop 2: the native inflate.** `DecompressionStream` won or tied every row (a whole 15k PNG 1.46 s against 2.70 s, 8 workers 527 against 623 ms, 10,000 one-row strips a tie). K2 (`ag-chain-p`) is not merged and `inflate_z` is not in the app. **K7** loses its inflate: the kernel takes the lines the native inflate delivered (the whole-line check, unfilter, RGBA, the round trip; codes -2 and -3 for the inflate drop out). **K8** takes route N. **K16** and **K20** inflate natively.
- **Question 6.2 (K25): the export follows the screen.** A fill layer's depth limit with edge snap takes its reference colour from the picture (`map.guide`, the layer's own pixels only without a guide) instead of the fill's own colour; the strength stays the screen's `snapParams(map.meta?.snap?.strength)`. A byte change of layered exports holding such a layer, toward the screen. It matches the screen up to 4096 px on the long side, above that within one map texel (about 3.66 px at 15k, K25's review), as long as the picture below is still the one the depth map was made from. `docs/BUGS.md` has the entry. Only the depth limit is concerned: a fill layer takes no other limit (`commands.js` refuses it, the panel does not offer it).
- **Question 6.4:** **K37 yes**, kept only where the tile route measures faster on the felt 15k operation, with a size threshold if small fills lose; at most one level against Skia at opacity below 1. **K38 yes** (the `matchCanvas` fallback toward the GPU's formula, at most one level). **The TIFF quirk is fixed** in both twin and Rust at K15 (sub-byte palette files with alpha, whose alpha is left at 0..15 today).

### K38 (2026-11-09): `matchCanvas` CPU fallback in 4 MP chunks (§4.11, question 6.4)

- **Byte effect:** Only when `applyMatchGL` returns `null` (no WebGL2 context or a canvas side above `glContext().max`), `matchCanvas` (`renderer/editor/inpaint_filters.js:274-298`) computes the colour match in `f32` (`floor(clamp(v + (m - v) * k, 0, 255) + 0.5)` via `matchPixels`, matching the WebGL2 shader and the worker's `matchPixels`) instead of `f64` with `Uint8ClampedArray` ties-to-even rounding, changing non-transparent pixels by at most 1 byte level (`<= 1`). With WebGL2 active, bytes are unchanged.
- **Call site & route (`renderer/editor/inpaint_filters.js`, `renderer/editor/px/kernels.js`, `renderer/editor/px/px.js`):**
  - `inpaint_filters.js` exports `MATCH_CHUNK_BYTES = 4 * 1024 * 1024 * 4` (`16,777,216` B = `4,194,304` px) and in `matchCanvas` walks `img.data` in `MATCH_CHUNK_BYTES` subarrays (`matchPixels(d.subarray(off, off + MATCH_CHUNK_BYTES), params)`), in place on `ImageData.data`'s buffer.
  - `kernels.js` adds `matchPixels: "kernel"` to `ROUTE_KINDS` and routes `matchPixels` through `rustPx("matchPixels")`.
  - `Px.prototype.matchPixels` (`px.js:369-380`) guards `!(px > 0)` and passes a `Uint8Array(rgba.buffer, rgba.byteOffset, px * 4)` view to `this._out` when `rgba` is a `Uint8ClampedArray` subarray.
  - No `.rs` changes; ABI remains 42 (`px.wasm` 279,003 B, `px_scalar.wasm` 225,584 B).
- **Measurements (`docs/measurements/k38_2026-11-09/`):**
  - 3 alternating before/after rounds under `w1_lock.py` (`w0_bench.py --rows=match_fallback_16k`):
    - `4096 x 4096` (16.8 MP, 4 chunks): **263.00 ms** (244.5–275.1, worst 298.2, blk 263.00) -> **157.83 ms** (152.4–161.2, worst 195.5, blk 157.82, `match_pixels: 4`), **1.67×** faster (-105.2 ms).
    - `15000 x 10000` (150 MP, 36 chunks): **2677.79 ms** (2422.7–2841.8, worst 3054.8, blk 2677.79) -> **1591.06 ms** (1578.8–1658.6, worst 1809.7, blk 1591.07, `match_pixels: 36`), **1.68×** faster (-1086.7 ms).
  - Route A/B (`measure_k38.py`, `matchPixels=rust` vs `matchPixels=js`): at `4096 x 4096`, **130.7 ms** (123.0–146.7, chunks 82.2 ms) vs **408.8 ms** (396.4–430.9, chunks 262.7 ms), **3.13×** (**3.20×** on chunks); at `15000 x 10000`, **1352.8 ms** (1333.1–1462.3, chunks 722.3 ms) vs **2943.1 ms** (2781.1–2944.8, chunks 2367.4 ms), **2.18×** (**3.28×** on chunks). Across all 36 chunks at `15000 x 10000`, the window's wasm instance stays at **18.19 MiB** (`release === 0`). Rust kept as default.
- **Tests & mutation round:**
  - `tools/px_test.js` (`matchTwin`, `match`): `Uint8ClampedArray` non-zero `byteOffset` subarrays, empty buffers, 3-chunk 8.4 MP `matchCanvas` parity on `"rust"` and `"js"`, memory bound (`<= 19 MiB`), trap recovery on chunk 0, `<= 1` level vs doubles, strength `[0, 1]` clamping.
  - `tools/editor_test.py` (`match_canvas_fallback_chunks_through_match_pixels`): `layerMatchedPixels` and 3-chunk `matchCanvas` with `glContext().max` lowered on both backends.
  - Mutation round (`mutants_k38.py`): **9/9 killed, 0 survived**.
  - Gates (`k38-fix-tiles`, `k38-fix-canvas`): `lint types pixels composite editor` **ALL PASS** on both backends.
```

### P5 (2026-11-09): PNG parts that start independent and parallel upload while decoding (the Antigravity P chain)

By the same chain as K2, K6, K7 and K8 on `9a5f1681` (`a92ea102`, review fixes `207beec0`, merged with `wasm-kernels` `0740aeab` at `3dba61a9`), no new ABI exports (ABI 42 on `9a5f1681` with `px.wasm` 279,003 -> 278,242 B and `px_scalar.wasm` 225,584 -> 225,743 B; ABI 43 after merging `wasm-kernels` with `px.wasm` 288,837 B and `px_scalar.wasm` 231,989 B); `docs/measurements/p5_2026-11-09/`.
- **Built:**
  - **P5 (Question 6.1, independent PNG part starts):** `crates/px/src/png.rs` `filter_row` (`:88`, scalar `for t in 1..if up.is_some() { 5u8 } else { 2u8 }`) and `lanes::filter_row` (`:319`, SIMD `for t in 1..if UP { 5u8 } else { 2u8 }`), and `renderer/editor/px/kernels_js.js` `pngFilterRows` (`:1042-1046`, `if (y > 0 || prev)`) restrict row 0 of a part without `prev` (`prev_ptr == 0` / `prev == null`) to filters `0` (`None`) and `1` (`Sub`), while preserving `Up` / `Average` / `Paeth` when an explicit `prev` row is passed. `renderer/editor/inpaint_bands.js` `bandRows` (`:58`) only slices `above` when `needPrev` is true and `writePng` (`:172`) passes `source.part(y, n, false)`. `renderer/editor/inpaint_worker.js` `pngPart` passes `partPtrOf(p, a, msg, false)` on the wasm-gather path (`:691`) and `const prev = msg.rgba && msg.prev ? new Uint8Array(msg.prev, 0, msg.w * 4) : null;` on the JS-gather fallback (`:721`), eliminating the 78 boundary `composite_tile` calls per layer during 15,000 × 10,000 PNG/ORA exports and making every Scumble-written PNG part decode in a single pass (`needsPrev === false`, `0` `png_part_finish` jobs on reopen).
  - **Parallel upload while decoding (Question 6.5):** `renderer/editor/inpaint_canvas.js` `addImageLayers` (`:17337-17354`) and `loadFile` (`:18923-18951`) check `big = this.tileMode ? (await hugePngSize(file)) || (await imageFileSize(file)) : null; if (big) this.checkBaseSize(big.width, big.height);` (and `if (later()) return;` in `loadFile`) before starting `const up = uploadBlob(file, stem + ext, { overwrite: false }); up.catch(() => {});`, run `pixelsOffThread(file, this.pixels.Layer)` in parallel with `up`, check `if (later()) { if (px) px.release(); return; }` and restore `if (px) this.setStatus("Uploading " + (file.name || "image") + " ...");` right after `pixelsOffThread` in `loadFile` before `await up`, release `px` if `await up` rejects, and suppress unhandled rejections when `pixelsOffThread` throws before `up` rejects.
- **Tests:** `node tools/px_test.js` and `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron.cmd tools/px_test.js` PASS: `pngFilterCases` (1,032 cases plus odd offsets on `rust simd`, `rust scalar`, and `js`, asserting `got[0] <= 1` whenever `!prev`), `partDecodeCases` (`P5 writePng + bandRows writes independent parts`: 64 × 520 image with identical rows 255 and 256 across the part boundary, asserting `prev === null`, `firstFilter in {0, 1}`, `needsPrev === false`, `0` `png_part_finish` calls, and byte-exact pixels), and `composeWasmPartCases` (`tileMsg` with `r0: 16, prevTiles` and `stackMsg` with `y: 16`, asserting `firstFilter <= 1` and byte-identical IDAT chunks across `composeWasm=1` and `composeWasm=0`). `tools/editor_test.py` `a_scumble_png_opens_through_the_parted_reader`: Sections 1 & 3 assert `partFinishes === 0` on Scumble PNGs from `encodeTilePixels` and `encodeBands`, plus a dedicated legacy pre-P5 3-part PNG check (written via `PngStreamWriter` with explicit `prev`) asserting `partFinishes >= 2` at `INTERACTIVE` priority `0`, `legacyFinishCalls === partFinishes` on Rust, and `jsLegacyFinishCalls === 0` on the JS twin route; Section 8 tests Question 6.5 in both `loadFile` and `addImageLayers` (`checkBaseSize` before `uploadBlob`, parallel `png_part_read` completion while `uploadEntered && uploadHeld` plus status reset to `"Uploading ..."` after decode, `px.release()` on `uploadBlob` rejection and on stale `loadFile` before `uploadBlob` resolves, and `0` `unhandledrejection` events when `pixelsOffThread` throws before `uploadBlob` rejects).
- **Mutation round** (`docs/measurements/p5_2026-11-09/mutation/mutants.py`, `results.txt`): **19 of 19 killed** (`0` survived, `0` only on re-check, 627 s).
- **Before -> after** (`docs/measurements/p5_2026-11-09/summary.txt`: three alternating rounds under `w1_lock.py`, 15,000 × 10,000, offline, tiles on, all runs focused; before = `9a5f1681`, after = P5 + parallel upload combined; Stop 4's separate probes on `n1_15k` put P5 alone at `-170.9 ms` and the upload overlap at `-340.7 ms`):
  - `native_test.py 15000x10000`: `open_the_file` wall `1,766.0` [`1,749..2,010`] -> `1,196.0 ms` [`1,195..1,231`] (`1.48×`, `loadFileMs` `1,684.0` -> `1,132.0 ms`, `blocked` `501.0` -> `475.0 ms`), `open_again` wall `1,426.0` [`1,413..1,506`] -> `854.0 ms` [`822..1,117`] (`1.67×`, `loadFileMs` `1,312.0` -> `739.0 ms`, `blocked` `58.0` -> `46.0 ms`), `export_png` wall `1,007.0` [`966..1,032`] -> `952.0 ms` [`948..1,024`] (`1.06×`, overlapping spread; `235.1` -> `235.2 MB`), `export_ora` wall `2,040.0` [`2,032..2,073`] -> `1,997.0 ms` [`1,977..2,038`] (`1.02×`, overlapping spread; `511.6` -> `511.7 MB`), `build_the_file.encodeMs` `1,525.0` [`1,391..1,580`] -> `1,578.0 ms` [`1,381..1,800`] (`0.97×`, overlapping spread; `275.8` -> `275.9 MB`, IDAT bytes `289,214,595` -> `289,299,973` B = `+85,378 B` / `+0.03%`). `png_part_finish` dropped from `78` jobs (`527.5–547.3 ms` kernel) to `0`; `export_png` / `export_ora` `composite_tile` calls dropped from `156` to `78`.
  - `w0_bench.py --rows=freqsep_15k` (`adobe_15000x10000.jpg`): `load_jpg` `1,658.0` [`1614..1663`] -> `1,528.0 ms` [`1517..1581`] (`1.09×`), `png_export` `1,472.0` [`1339..1496`] -> `1,287.0 ms` [`1273..1342`] (`1.14×`), `png_open` `1,934.0` [`1764..1947`] -> `1,081.0 ms` [`1017..1192`] (`1.79×`), `freqsep_16mp` `827.0` [`819..833`] -> `806.0 ms` [`799..821`] (`1.03×`, overlapping spread).

---
- **The merged state's gates (`3dba61a9` on `0740aeab`, serial):** `lint types editor document export pixels tiff` PASS on both backends, `layered` PASS on canvas; on tiles `layered` failed once on the known flake of `crafted_files_are_refused_on_both_routes` (the renderer grew by 200 MB, `docs/TESTING.md`) and passed twice alone (`merge-p5-layered1-tiles`, `merge-p5-layered2-tiles`); `px_test` PASS under Node and Electron.

### The user's answers of 2026-11-10

- **Question 6.3 (K19, the TIFF writer's deflate):** Rust at level 2 stays. The browser's `CompressionStream` replaces it only if K19 shows it faster at the same level. `CompressionStream` has no level setting (it runs 6), so K19 measures and reports, and changes nothing unless a same-level comparison exists. The pool above 8 workers stays an A/B in K40, nothing changed without the user's word.
- **K20a (`docs/PLAN_WASM_K20.md` §5):** one `psdRead` route for the whole reader; `readOraBlob` in K20c (ORA layers sliced from the file, `mergedimage.png` not read); the promoted bottom ORA layer's PNG uploaded directly with the fallback to `uploadPixels`; ORA colour chunks ignored as today (raw samples, every value the same).
- **Before K40 (the interim run's loss rows, `docs/measurements/k40pre_2026-11-09/bisect_findings.txt`):** the pan cost since the filter fix is repaired, the remaining loss rows are looked into; then the user's hand test (open TIFF, PSD and ORA, relight), then the user decides on the release.

### K18 (2026-11-10)

§4.6's parallel worker band reader (`ag-chain-t` `66e5c1cd`..`01c0f881` off `c36840d8`, merged with `wasm-kernels` `897b3d16`). Full tier (`docs/measurements/k18_2026-11-10/`: `k18_chain.sh`, `summarize.py`, `summary.txt`, `summary_rows.txt`, `before/`, `after/`, `notcounted/`, `node/`, `mutation/`).
- **Behaviour change:** (1) opening another file while a TIFF is still being read cancels the superseded TIFF's remaining worker jobs immediately instead of finishing the decode in the background; (2) while a multi-band TIFF opens, the `"Reading W × H px ... N %"` status percentage advances by total rows decoded so far as worker bands finish rather than strictly top-to-bottom; (3) opening a TIFF no longer depends on `partsUsable()`, so when PNG part workers are disabled (`pngParts = false` or after a `NO_PARTS` fallback) or the kernel mode is set to `"js"`, TIFFs still decode in the worker pool instead of on the window (`tiffPoolUsable`). Decoded pixels on valid files and refusal messages on damaged or unsupported files are unchanged.
- **Built (JS only, `crates/px/` untouched; ABI 45 unchanged, `px.wasm` 289,975 B `f326653b273e3c87` and `px_scalar.wasm` 232,343 B `0c067d6ca569c44e` identical):** `renderer/editor/inpaint_tiff.js` (still free of imports) drops `colormap` from `plan.spec` (`:785-798`; `spec.pal` already holds the precomputed `Uint8Array` LUT from `paletteLut`, while `plan.colormap` stays on `plan` at `:872`) so `tiff_band` messages carry neither the full strip/tile tables nor a raw `ColorMap` array, and exports `readTiffBands(blob, { pool, plan, rowsPerBand = 256, priority = 1, later = null, onHeader = null, onRows = null, spent = null })` (`:1188-1306`), re-exported by `kernels_js.js` (`:18, 20`) and `kernels.js` (`:33`). `readTiffBands` returns `null` when `plan.streamed` is true (`:1203`), posts `tiff_band` jobs carrying `{ blob, spec, band }` at `priority` (preserving `tiff_read`'s `NORMAL` = `1` priority ahead of `EXPORT` = `2`) in a `Symbol("tiff_bands")` pool group bounded to `maxInFlight = Math.max(1, (pool.size | 0) || 8) * 2` (`:1209-1210, 1239-1244`), delivers each decoded band to `onRows(view, y0, rows)` as soon as its worker answers (`:1277`), checks `later()` before planning, after `onHeader`, on band reply arrival (detaching `r.rgba` via `ab.transfer(0)` before `pool.cancel(group)`), and in `finishBand` after `onRows` (`:1200-1206, 1250-1255, 1272, 1297-1300`) throwing `CancelledError` (`err.cancelled = true`), and calls `pool.cancel(group)` and rejects on any band error (`:1227-1233, 1301-1304`). `renderer/editor/inpaint_worker.js` exports `tiffBandJob(msg)` (`:904-926`, calling `readTiffBand(msg.blob, spec, band, { spent, kernels: tiffKernels() })` and transferring `[buf]`) and dispatches `msg.op === "tiff_band"` (`:1964`). `renderer/editor/inpaint_canvas.js` adds `tiffPoolUsable(blob)` (`:570-572`), updates `pixelsFromTiff(blob, Cls, progress = null, later = null)` (`:581-664`) to honour `InpaintEditor.tiffBandRows` (`0` -> `TILE_SIZE` = `256`, `> 0` -> `bandSetting | 0`, `false` -> skip `readTiffBands`), post `readTiffBands` at `NORMAL` priority (`1`), `px.writeRect` + detach each landing band buffer + report `rowsDone / H` progress, rethrow `CancelledError` without fallback on `later()`, and call `resetTarget()` (`px.release()`, `rowsDone = 0`) + warn + fall back to `tiff_read` at `NORMAL` priority on any band error (and to `readTiff` on the window when `editorPool().off`); forwards `later` from `loadTiff` (`:19035-19051`) and `() => !!this._destroyed` in `addImageLayers` (`:17402`); and exposes `tiffBandRows` (`:18128`) and `pixelsFromTiff, tiffPlan, readTiffBand, readTiffBands` on `InpaintEditor.parts` (`:18124`).
- **Tests & mutation (`docs/measurements/k18_2026-11-10/mutation/`):** `node tools/tiff_test.js` 210/210 checks PASS (`kernels: null` with 0 Rust calls, `kernels: K.tiffKernels()` with 276 `tiff_unpack`, 673 `tiff_unpredict`, 927 `tiff_to_rgba`, 11 `tiff_predict_rgba`; 7-band out-of-order mock-pool landing, `maxInFlight = 4`, `spec` payload without `offsets`/`counts`/`bands`/`colormap`, palette `Uint8Array` `pal`, `later()` cancel + detach, band error group cancel, `streamed: true` returning `null`). `px_test.js` PASS under Node and Electron (`4f` at `:12338-12591`: `tiffBandJob` Rust vs `"js"`, `releaseMB = 1` renewal, `[buf]` transfer, `WorkerPool` pinning `NORMAL` ahead of 4 queued `EXPORT` jobs, group cancel on band 1 error, `later()` both before band 0 reply and inside band 0 `onRows` on a 2-band file, `streamed: true`). `tiff_test.py` sets `E.tiffBandRows = 8` in `opens_every_accepted_fixture` (`:1269-1298`, 33 of 40 accepted fixtures across parallel `tiff_band` jobs, including `rgb8_lzw_pred >= 6`, `tiled16 >= 3`, `planar_strips >= 6`, `many_strips >= 100`), updates `OPEN_ONE`, `LAYER`, and `EXPORT_REOPEN` (`"js"` route replay), adds gate step `parallel_bands_priority_cancel_and_fallback` (`:463-785`, checking monotonic `rowsDone / H` progress on out-of-order and fallback opens, pinning `NORMAL` ahead of `EXPORT`, holding bands inside `editorPool()` via `_send` to verify `pool.stats().cancelled` grows by `[5, 5, 4]` with `0` bands sent after cancel on direct `later()`, superseded `loadFile`, and band-1 failure, plus `E.kernels = "js"` with `!E.parts.usable()`, `pool.off = true` window branch, and `needWindowFallback`), and checks one row per 256-row band (`40` bands at 15,000 × 10,000) plus a 2-level SHA-256 of the whole picture (`checkBandsAndPicture`, `:739-757`) in the 15k compare.
- **Measurements (`docs/measurements/k18_2026-11-10/summary.txt`, 3 alternating rounds at 15,000 × 10,000 under `w1_lock.py`, 7 variants, 1 variant per fresh instance, 42/42 runs focused on try 1, 40/40 band rows + 2-level `picSha256` matched; `raw r2` re-run cleanly after a `04:27:47–04:31:23` `sl-full-canvas-serial` lock-race overlap, and `noise r2` reported both with and without the overlapped round):** before (`c36840d8`, 1 `tiff_read` job on 1 worker) -> after (`K18`, 40 `tiff_band` jobs across 8 workers on multi-band variants): `own` (§4.6's deciding row) `openMs` `3,485.0 [3,170.0-3,499.0] -> 2,572.0 [2,368.0-2,857.0]` ms (`1.35x` non-overlapping, `-913` ms; `openSteps pixels` `1,370.0 [1,317.0-1,431.0] -> 482.0 [475.0-590.0]` ms, `2.84x` non-overlapping, `-888` ms, beating §4.6's inferred `0.6–0.8` s; `openSteps total` `2,838.0 -> 1,990.0` ms, `1.43x`); `lzw` `openMs` `5,864.0 [5,597.0-5,926.0] -> 3,667.0 [3,663.0-3,958.0]` ms (`1.60x` non-overlapping, `-2,197` ms, `3.22x` vs pre-K17 `11,826` ms; `openSteps pixels` `3,131.0 [3,101.0-3,165.0] -> 821.0 [670.0-877.0]` ms, `3.81x` non-overlapping, while untouched `openSteps stored` moved `1,148.0 -> 1,447.0` ms); `packbits` `openMs` `4,039.0 [3,769.0-4,546.0] -> 3,476.0 [3,376.0-3,627.0]` ms (`1.16x` non-overlapping, `-563` ms; `openSteps pixels` `876.0 [751.0-889.0] -> 518.0 [486.0-627.0]` ms, `1.69x` non-overlapping); `noise` `openMs` `7,384.0 [6,858.0-7,725.0] -> 5,781.0 [5,706.0-6,113.0]` ms (`1.28x` non-overlapping, `-1,603` ms; clean `r1`/`r3` excluding overlapped `r2`: `6,858.0 / 7,725.0 -> 6,113.0 / 5,781.0` ms, `1.23x`; `openSteps pixels` `1,929.0 [1,863.0-2,060.0] -> 638.0 [558.0-680.0]` ms, `3.02x`); `raw_strips` (`625` uncompressed RGB8 strips, zero codec/unpredict work) ties on `openMs` (`3,708.0 [3,423.0-3,956.0] -> 3,731.0 [3,391.0-3,854.0]` ms, `0.99x` overlapping; `openSteps pixels` `662.0 [633.0-731.0] -> 624.0 [564.0-660.0]` ms, `1.06x`, faster in 3/3 pairs, where `388.2` ms = 62% is main-thread `writeRect` of 572 MiB). Single-strip 600 MB RGBA `zlib1` (`4,519.0 -> 4,116.0` ms, `1.10x` tie) and `raw` (`3,855.0 [3,589.0-3,965.0] -> 3,552.0 [3,369.0-3,732.0]` ms, `1.09x` tie after clean `r2` re-run) stay on `tiff_read` (`plan.streamed = true`, `reader jobs = 1`). Untouched `exportMs` ties with overlapping spreads (`own` `1,428.0 -> 1,498.0` ms, `noise` `4,223.0 -> 5,101.0` ms).

The review's correction (K18R-1, tests and report only, no app code): the whole 24-mutant round 24 killed, 0 survived; gates `k18r1` on both backends and `k18r1b-tiff-*` PASS. `noise r2` lies in the lock overlap and is reported with and without that round, as the review allowed (`summary.txt`). The last commit of the round's results was made by the main loop after the Antigravity limit ran out.

### K20b (2026-11-10): the PSD reader in Rust inside `psd_read`, paced by an acknowledgement window

The design is `docs/PLAN_WASM_K20.md`; its §7 "K20b review (2026-11-10)" has the full text and tables. ABI 46. The band kernels `packbitsRows`, `psdMaskRgba`, `psdBandRgba`, `psdBandMask` run in `psd_read` (route `psdRead`), one pass, band by band. The review found the window's longest block grown 64 -> 485 ms: every band posted at once queues ahead of the window's timers and input. The correction: `psd_read` is paced (`msg.window`, `psdAck`, `WorkerPool.ack`, `streamChannelDescs` async, the route `psdWindow`, `PSD_WINDOW = 8`, 0 = unpaced), each band acknowledged after its `writeRect`. A handler that throws ends the worker through the pool's `_lost`, so a wait for an acknowledgement cannot hang.

15,000 x 10,000, three alternating rounds, median ms (`docs/measurements/k20b_review_2026-11-10/summary.txt`): `open_psd` wall 6,760 before, 3,705 unpaced, 3,466 paced; blocked 65, 507, 154. Three soft layers, warm: wall 6,923, 3,575, 3,408; blocked 276, 1,052, 297. **Losses against before:** `open_psd` blocked +89 ms, the soft warm open +21 ms; the price of an open about 3.3 s shorter. The verdict covers 8-bit RLE without masks; ZIP, predicted, 16-bit and mask paths are byte-checked only. Window sizes other than 8 not run at 15k; `blocked` is the timer beat, input and paint not measured. Mutation round 40 of 40 (two survivors of the first run were a real test gap, closed by two crafted files). Gates `k20bfix`, `k20bfix2` on both backends on the tree that was merged. The correction was finished by a Claude agent from the Antigravity agent's WIP (the Antigravity limit ran out).

**K19 and K20c are moved after this release** (the user's "ja" of 2026-11-10 to the plan for finishing the update that day): K19 is a measurement with no change for users, K20c leaves ORA files opening as in 0.1.53.

### K17 (2026-11-09)

§4.6's band planner, contiguous band reader, per-tile unpredict and one-worker `tiffUnpack` A/B (`ag-chain-t` `f5b629f6`..`937b50b5` off `0740aeab`, merged with `wasm-kernels` `9eb7de60`). Full tier (`docs/measurements/k17_2026-11-09/`: `k17_chain.sh`, `summarize.py`, `summary.txt`, `before/`, `after/`, `unpack_js/`, `unpack_rust/`, `node/`, `mutation/`).
- **Built (JS only, `crates/px/` untouched; ABI 45 unchanged after merging `9eb7de60`, `px.wasm` 289,975 B `f326653b273e3c87` and `px_scalar.wasm` 232,343 B `0c067d6ca569c44e` identical):** `renderer/editor/inpaint_tiff.js` (still free of imports) exports `TIFF_BAND_BYTES = 64 * 1048576`, `tiffPlan(blob, opts)` and `readTiffBand(blob, plan, band, opts)`, re-exported by `kernels_js.js` and wired into `readTiff` whenever `!plan.streamed` (`StripRows` / `TileRows` remain the `plan.streamed` fallback). `tiffPlan` bounds both the band's RGBA bytes (`TIFF_BAND_BYTES = 64 MiB`, so a 1-strip 1-bit `4096 x 4096` file is `streamed: false` while `4096 x 4097` is `streamed: true`) and its unpacked plane allocation (`2 * TIFF_BAND_BYTES = 128 MiB`, keeping `RGBA16` on bands while streaming high-`SamplesPerPixel` files), falls back to `streamed = true` when an in-file band's raw span exceeds `4 * bandUnpacked + 1 MiB`, precomputes `pal` (`paletteLut`) and slices `offsets` and `counts` per band (`plan.bands[i]`) alongside `plan.spec` for K18's worker jobs. `readTiffBand` validates all band segment ranges upfront against `blob.size`, clamps codec `1` counts to `need`, reads each contiguous band in a single `blob.slice(minOff, maxEnd).arrayBuffer()` when `maxEnd - minOff <= sumCounts + 65536` (or one slice per contiguous run within 64 KB) and detaches temporary `ArrayBuffer`s via `ab.transfer(0)` in `finally`. Three refusal details on already-invalid non-streamed files are stated: a short uncompressed/LZW/PackBits tile reports `tile N holds fewer bytes than its rows`; an out-of-bounds later segment in a band is reported ahead of an earlier short or damaged in-file segment; and on planar files (`PlanarConfiguration = 2`) with several damaged segments in a band, planes decode one after the other so which segment is named can differ. Deflate (`8` / `32946`) keeps one `DecompressionStream("deflate")` per strip or tile (`inflateInto`, fed in-process via `ds.writable.getWriter()` in 1 MiB slices with a one-macrotask drain wait before `writer.close()` so `>= 1 MiB` segments with a cut Adler-32 still cancel cleanly at `need` in Chromium, per Stop 2). Tiled files with `Predictor = 2` run `K.unpredict(tileBuf, tl, tileRow, tw, perPixel, info.bits, P.le)` per tile before scattering into `planeBuf` rows. `renderer/editor/px/kernels.js` adds `tiffUnpack: "kernel"` to `ROUTE_KINDS` and exports `tiffUnpack`, routing LZW (`5`) and PackBits (`32773`) through `rustPx("tiffUnpack")` (with `recovered` fallback to `J.tiffUnpack`) while keeping uncompressed (`1`) on `J.tiffUnpack` (`dst.set`).
- **Tests & mutation (`docs/measurements/k17_2026-11-09/mutation/`):** `node tools/tiff_test.js` 208/208 checks PASS (`kernels: null` with 0 Rust calls, `kernels: tiffKernels()` with 248 `tiff_unpack`, 673 `tiff_unpredict` and 918 `tiff_to_rgba` calls; all refusals run on both bands and `{ streamed: true }`; 7 tiled Predictor-2 configs plus `(16, 0)` whole-row corruption proof; 64 MiB 1-bit RGBA and 128 MiB `spp = 128` raw-plane boundaries; `256 KiB` damaged-tail Deflate early cancel across `8`/`32946` strip & tile; oversized `StripByteCounts` clamping/fallback). `px_test.js` PASS under Node and Electron (`tiffUnpack` route/codec-1 guard/trap recovery, `4e` band + streamed refusal suite). `tiff_test.py` adds `raw_strips`, asserts `pxCalls.tiff_unpack` on `5`/`32773` and `!tiff_unpack` on `1`, replays `rgb8_lzw_pred` under `"js"` routes, and tests `>= 1 MiB` cut-Adler Deflate strips/tiles in real Chromium. Gates `--offline`: `k17r1-tiles` and `k17r1-canvas` `lint types tiff export pixels` PASS on both backends (`build_px.py --check` identical, `build_node.py --check` expected `differs` only). Mutation round (`mut_k17.py`): **27 killed, 0 survived** of 27.
- **Measurements & route (`docs/measurements/k17_2026-11-09/summary.txt`, 3 alternating rounds at 15,000 x 10,000 under `w1_lock.py`, 7 striped variants, 1 variant per fresh instance, GPU 0-7 %):** before (`0740aeab`) -> after (`K17`): `lzw openMs` `11,826.0 [11,576.0-12,701.0] -> 5,696.0 [5,422.0-6,048.0]` ms (`2.08x` non-overlapping; `openSteps pixels` `9,041.0 -> 3,077.0` ms, `2.94x`; `pieces` `10,000 -> 40`); `packbits openMs` `5,967.0 [5,901.0-6,891.0] -> 3,622.0 [3,411.0-3,776.0]` ms (`1.65x` non-overlapping; `openSteps pixels` `3,253.0 -> 691.0` ms, `4.71x`); `raw_strips` (`625` strips, `rps=16`) `openMs` `3,622.0 [3,596.0-3,644.0] -> 3,523.0 [3,360.0-3,537.0]` ms (`1.03x` non-overlapping; `openSteps pixels` `858.0 [841.0-899.0] -> 613.0 [602.0-669.0]` ms, `1.40x` non-overlapping, `-245` ms despite `+127` ms in untouched `stored`); `own` `openSteps pixels` `1,348.0 [1,335.0-1,386.0] -> 1,317.0 [1,301.0-1,326.0]` ms (`1.02x` non-overlapping, `-31` ms K17 reader effect; `openMs` `3,148.0 -> 3,003.0` ms includes `-102` ms in untouched `stored`); `noise openMs` `6,726.0 -> 6,701.0` ms (`1.00x` tie; `pixels` `1,919.0 -> 1,880.0` ms and `kernel` `1,916.0 -> 1,877.2` ms overlap, `wait` `1,361.7 -> 1,474.2` ms spreads apart); `w0_bench tiff_rows_256` `1,288.0 -> 1,245.8` ms (`1.03x` tie). Single-strip 600 MB RGBA variants stay on `StripRows` (`plan.streamed = true`, while untouched `openSteps stored` moved both ways: `zlib1` `-128` ms, `own` `-102` ms, `raw` `+123` ms, `raw_strips` `+127` ms): `zlib1 openMs` `4,157.0 -> 3,991.0` ms (`1.04x` tie, `pixels` `1,568.0 -> 1,593.0` ms); `raw openMs` `3,289.0 -> 3,460.0` ms (`+171` ms: `+123` ms `stored`, `+24` ms `base`, and `+14` ms `pixels` `515 [488-524] -> 529 [529-544]` ms with `kernel` overlapping and no separate A/A run). Isolated `tiffUnpack=js:rust` A/B on `readTiffBand`: Rust wins non-overlapping on `lzw` (`10,541.0 -> 5,684.0` ms, `1.85x`) and `packbits` (`3,684.0 [3,638.0-3,686.0] -> 3,416.0 [3,327.0-3,635.0]` ms, `1.08x`), while JS `dst.set` beats 3-copy wasm non-overlapping on `raw_strips` `decode` (`66.6 [66.4-72.3]` vs `91.9 [89.2-98.5]` ms, `1.38x`; `PX_BENCH` `0.02` vs `0.05` ms). **No `tiffUnpack` entry in `DEFAULT_ROUTES`; `compression === 1` stays on `J.tiffUnpack`.**
- **The merged state's gates (on `9eb7de60` + `937b50b5`, serial):** `lint types tiff export pixels nodecopy editor` PASS on both backends (`merge-k17-tiles`, `merge-k17-canvas`), `px_test` PASS under Node and Electron.

### K15 (2026-11-09): `tiff_unpredict`, `tiff_predict_rgba`, `tiff_to_rgba`, `tiffStrip`, `TIFF_JS`

The order after Stop 1, #32, on `3359cb0f` (merged with `wasm-kernels` `b51eedf0` at `04e1a32b`); full tier. `docs/measurements/k15_2026-11-09/` (`k15_chain.sh`, `summarize.py`, `summary.txt`, `summary_rows.txt`, `before/`, `after/`, `node/`, `mutation/`). Also includes `K16R-1` (`b60852d2`, recording the exact `baseLzwSweep` length `3475` bytes / `3476` prefixes `0..3475` in `tools/px_test.js:10334, 10389` and `docs/measurements/k16_2026-11-09/summary.txt:32`).
- **Behaviour change (question 6.4):** sub-byte (`1`, `2`, and `4`-bit) palette TIFF files (`PhotometricInterpretation = 3`) with an extra alpha sample (`ExtraSamples = 1` or `2`) now scale only the alpha sample by `255 / (2^bits - 1)` while keeping the palette index sample (`0`) raw, for both chunky and planar layouts and both straight and premultiplied alpha (`renderer/editor/inpaint_tiff.js:715-716`, `crates/px/src/tiff.rs:379-383`). Previously the sub-byte alpha sample stayed unscaled (`0..1`, `0..3`, `0..15`), so such files opened nearly transparent.
- **Built (ABI 43):** `crates/px/src/tiff.rs` `unpredict` (`tiff_unpredict(buf, len, rows, row_bytes, pixels, per, bits, le) -> i32`, in-place horizontal differencing undo for 8-bit with `u8x16` SIMD prefix sums on RGBA8 and 1-byte strides and 16-bit LE/BE without touching row padding), `predict_rgba` (`tiff_predict_rgba(rgba, w, rows) -> i32`, in-place horizontal differencing for RGBA8 with `u8x16` SIMD reverse differences), and `to_rgba` (`tiff_to_rgba(src, src_len, planes, row_bytes, w, rows, spp, bits, le, photometric, alpha_mode, pal, pal_len, out, out_len) -> i32`, every branch of `toRgba` with fast paths for chunky RGBA8 straight `copy_from_slice`, chunky RGB8 opaque, and chunky RGBA8 premultiplied, keeping `A = 0 -> RGB 0`, `A = 255 -> pass`, no division by zero). `renderer/editor/inpaint_tiff.js` (still free of imports) exports `unpredict`, `predictRgba`, `toRgba`, `paletteLut` (using `!(cm[i] < 256)` and refusing string colormaps) and `TIFF_JS`, and `readTiff` takes `kernels = null`. `renderer/editor/px/px.js` adds `tiffUnpredict`, `tiffPredictRgba`, `tiffToRgba`, `tiffStripFromPtr` (on `partPtrOf` from K10b) and `tiffStrip` (byte-identical to `tiffPart(args, p.zlib)`). `renderer/editor/px/kernels.js` adds routes `tiffUnpredict`, `tiffPredict`, `tiffToRgba` and `tiffStripWasm` and `tiffKernels()` (looking up `rustPx(...)` per call); `inpaint_worker.js` wires `tiffPartJob` (`composeWasm: 1` on tiles/stack via `partPtrOf` + `tiffStripFromPtr`) and `tiffRead`; `inpaint_canvas.js` passes `tiffKernels()` in `pixelsFromTiff`'s unpooled fallback. `px.wasm`: 289,598 B (`35174f9eb470bffd`, 288,126 B `7a9906e77da23a68` on `3359cb0f` vs 277,531 B `d3d4567365549b49` before); `px_scalar.wasm`: 231,830 B (`c6e7dc74f7b2b9cb`, 230,358 B `ea1fbd34b8b9b3c3` on `3359cb0f` vs 224,112 B `e23e1ca9bd65303d` before).
- **Tests:** `node tools/tiff_test.js` (182 checks: `tools/tiff_fixtures.py` regenerated in Pass 1 via `fixturesGenerated`, Pass 1 with `kernels: null` and 0 Rust calls, Pass 2 with `kernels: tiffKernels()` and `tiffStrip`, 12 hand-built question 6.4 sub-byte palette+alpha fixtures across 1/2/4-bit, chunky/planar, straight/premultiplied at `:963-1075`, and ASCII ColorMap refusal at `:1076-1083`); `tools/px_test.js` `tiffCases` under Node and Electron (306 `tiff_unpredict` with `rows = 0..3`, 37 `tiff_predict_rgba` and 244 `tiff_to_rgba` twin cases on both wasm builds at aligned and odd offsets with `pal` and every plane buffer shifted, direct `simd.exports` and `scalar.exports` guard refusal checks leaving sentinel output untouched, all 65,536 `(alpha, colour)` premultiplied pairs, all 65,536 16-bit LE/BE values, `tiffStrip` & `tiffStripFromPtr` parity, `tiffPartJob` OOM/trap recovery with byte-equality on all three branches and arena reset, `tiffKernels()` per-call `rustPx()` lookup verified by instance spies across `dropPx` and in-place trap safety); `tools/tiff_test.py` (`OPEN_ONE` `:137-165` assertion `:157`, `LAYER` `:220-248` assertion `:235`, `EXPORT_BUILD` `:270-303`, `EXPORT_REOPEN` `:317-340`, `run_all` `:808-810`) asserts `tiff_unpredict`, `tiff_to_rgba` and `tiff_predict_rgba` ran and replays export and open on the `"js"` routes for byte identity. Gates `--offline`: `lint types export pixels` on both backends (`k15r-tiles`, `k15r-canvas`) and `tiff` sequentially on both (`k15r-tiff-tiles`, `k15r-tiff-canvas`) all PASS. Mutation round (`docs/measurements/k15_2026-11-09/mutation/`): **34 of 34 killed**.
- **Measurements & routes** (3 alternating before/after rounds at 15,000 x 10,000 under `w1_lock.py`, 1 variant per fresh instance): on §4.6's deciding row `own`, `openMs` drops `4,471.0 [4,414.0-6,251.0] -> 3,734.0 [3,292.0-3,786.0] ms` (`1.20x` non-overlapping; `openSteps pixels` `2,494.0 -> 1,462.0 ms`, `1.71x`; `tiff_read kernel` `2,488.9 -> 1,457.3 ms`, `1.71x`; `unpredict` `817.6 -> 118.1 ms`, `6.92x`; `convert` `492.2 -> 138.5 ms`, `3.55x`), and `w0_bench` `tiff_rows_256` drops `2,256.4 [2,158.5-2,297.8] -> 1,349.4 [1,339.7-1,357.1] ms` (`1.67x` non-overlapping; `unpredict` `524.8 -> 112.6 ms`, `4.66x`; `convert` `567.7 -> 129.0 ms`, `4.40x`). `noise openMs` is `8,034.0 -> 7,521.0 ms` (`1.07x`, `openSteps pixels` `3,011.0 -> 2,131.0 ms`, `1.41x` non-overlapping). On the RGB8 variants (`zlib1` `4,468 -> 4,323 ms`, `raw` `3,824 -> 3,797 ms`, `packbits` `6,824 -> 7,077 ms`, `lzw` `13,319 -> 13,780 ms`), `convert` wins beyond the spread on all four (`1.38x-1.79x` non-overlapping) and `tiff_read kernel` is faster on `zlib1` (`1.12x` non-overlapping), `raw` (`1.13x`) and `packbits` (`1.02x`), while `lzw` is 83% untouched streaming JS LZW (K17). Across the 18 paired runs, `openSteps stored` is slower in 10/18 pairs and `open png_part deflate` in 13/18 pairs (`3/3` on `lzw`, `packbits`, `raw`, medians `+2.7%` to `+12.9%` on five variants and `-7.4%` on `own`; no route-map A/B on the same wasm build was run, so the cause is unknown). On export, `noise exportMs` ties (`5,908 -> 5,670 ms`, `1.04x`) and passes `tiff_part kernel` (`33,488.8 -> 29,987.2 ms`, `1.12x`; `rows` `407.2 -> 235.4 ms`, `1.73x`; `predict` `855.0 -> 116.1 ms`, `7.36x`); `own exportMs` ties (`2,049 -> 2,063 ms`, `0.99x`, 90% untouched miniz level-2 `deflate`) while both K15 part rows win beyond the spread (`rows` `509.4 -> 211.6 ms`, `2.41x`; `predict` `909.2 -> 82.6 ms`, `11.01x`). All four routes stay on `"rust"` (no `DEFAULT_ROUTES` entries).
- **The merged state's gates (`cce43112` + `04e1a32b`):** `lint types tiff export pixels nodecopy` on both backends PASS, `px_test` under Node and Electron PASS; `editor` red side by side on both backends at `selection_keeps_its_bounds_through_a_restore_above_1mp` (the 180 s step timeout, no assertion; the step waits on `img.decode()`), then PASS in sequence (`merge-k15-rerun-tiles`, `merge-k15-rerun-canvas`, the step 0.5 / 0.3 s).

### K39 (2026-11-09): the grow fallback routed (§4.3, the Antigravity F chain)

`79ca38d2` on `8555262c`, ABI 42 unchanged (`grow_mask` is K9's export); `docs/measurements/k39_2026-11-09/`. When `selectionInWorker("grow", ...)` returns `null`, `growSelectionNow` (`renderer/editor/inpaint_canvas.js`) calls `growMaskBounds` instead of `growMask` and hands the bounds to `markSelectionChanged`, so `renderInfo` skips its full-canvas rescan (rescans 1 -> 0). `growMaskBounds` (`inpaint_raster.js`) asks `rustPx("growMask")`, new in `ROUTE_KINDS` (kernel, default Rust), and releases a large window instance in `finally`. Bytes identical. Window fallback `ed.growSelection(20)`, three alternating rounds: 76.7 -> 42.5 ms at 2,000 x 2,000 (JS route 66.5), 413.1 -> 319.8 ms at 7,500 x 5,000 (JS route 422.1), the window's wasm memory after it 101.69 -> 2.13 MiB there; at 2,000 x 2,000 no release applies and the memory rises 12.13 -> 27.44 MiB. `w0_bench.py --rows=grow_fallback_15k`: `growMask` / `growMaskBounds` 336 / 169 ms at 37.5 MP, 444 / 346 at 75 MP, 878 / 715 at 150 MP (the before run; the after run agrees within its spread). Mutation 6 of 6 killed. The merged state's gates: `lint types pixels selection` on both backends, `px_test` under Node and Electron; `editor` red once side by side on two known flakes (`helper_inputs_read_levels_and_upload_nothing` on tiles, `closed_tabs_are_collected` on canvas), then green in sequence on canvas (`merge-k39-rerun-canvas`), on tiles after one more timeout of the 420 s limit (`live_stroke_reaches_the_screen_before_the_release` took 344 s, `docs/TESTING.md`; `merge-k39-rerun2-tiles` PASS).

### K8 (2026-11-09)

The parted PNG reader in the app on route N (`DecompressionStream("deflate-raw")` per part + `px` `png_part_decode` /
`png_part_finish` in the workers; `docs/measurements/k8_2026-11-09/`), plus the four NICE items from K7's re-check
(`9fd93524`, `cb570a52`, `d663a3ba`, `8288274b`, `84800b0f`, no new wasm exports).
- **Layout check and reader** (`inpaint_png.js`): `pngPartsOf(blob)` checks a PNG with 8-byte header slices (8-bit RGBA,
  not interlaced, no `iCCP` / `gAMA` / `cHRM` / `cICP` before the first `IDAT`, the 2-byte zlib header `IDAT` with
  `CM=8`, `CINFO<=7`, `FDICT=0` and `FCHECK`, at least one non-empty part `IDAT`, the 4-byte tail `IDAT` holding the
  big-endian Adler-32, `IEND`; any other file returns `null` after 33–49 bytes, 41 bytes on a browser-encoded 1-`IDAT`
  PNG). `readPngParts(blob, { pool, rt, onHeader, onRows, layout })` launches `png_part_read` jobs in order, at most
  `pool.size + 2` ahead of the unfilter chain's head (`deliverHead`), passes `prev` at launch when the previous part has
  already finished, runs `png_part_finish` at `INTERACTIVE` (`priority: 0`, `inpaint_pool.js:19`) so the serial chain
  never waits behind queued decodes, delivers rows to `onRows` in scanline order (`px.putCanvasRows` in
  `pixelsFromPngStream`, `inpaint_canvas.js:735`, detaching the buffer after landing), folds the part Adlers with
  `adlerCombine` against the 4-byte tail `IDAT`, and on any error cancels the pool group, releases the partial
  `TileLayerPixels` and falls back to `png_read` (and if `png_read` also rejects the damaged parted PNG, `pixelsOffThread`
  rethrows the refusal rather than handing the corrupt file to `<img>`).
- **Worker jobs and bounds** (`inpaint_worker.js`): `png_part_read` and `png_part_finish` bound every part's inflate by
  both `pngPartLinesCap(w)` (`partRows(w, 2048) * (1 + 4 * w)`) and the IHDR bound `h * (1 + 4 * w)` (`inflatePartAtMost`
  captures `inBytes` before `transfer(0)` and cancels the stream as soon as inflated bytes exceed `Math.min(cap, ihdrCap)`),
  append `0x03, 0x00` to non-last parts only, and keep the 65,536-byte `rt` table resident in the worker (`residentRt`).
  `kernels.js` records `laps.decode` and `laps.finish` on the JS twin fallbacks too, and `pngReaderUsable()` in
  `inpaint_canvas.js` keeps the parted reader active when `InpaintEditor.kernels = "js"`.
- **Measured at 15,000 x 10,000 and 30,000 x 20,000** (3 alternating rounds at 15k under the busy lock, fresh offline
  instances, tiles on, focused; `docs/measurements/k8_2026-11-09/summary.txt`):
  - `native_test.py`: `open_the_file` wall `2517 [2437..2581]` -> `1745 [1676..1747] ms` (`1.44x`, `-772 ms`;
    `loadFileMs` `2454` -> `1657 ms`, `1.48x`; `blocked` `471` -> `477 ms`, `438 ms` of it the first-open WebGL shader
    link); `open_again` wall `2043 [1974..2124]` -> `1377 [1228..1382] ms` (`1.48x`, `-666 ms`; `loadFileMs` `1971` ->
    `1268 ms`, `1.55x`; `blocked` `40` -> `61 ms`); `export_png` (`1053` vs `1058 ms`) and `export_ora` (`2161` vs
    `2246 ms`) unchanged; arena after `close` identical (`slots: 4661, chunks: 20, allocated: 9381, freed: 4720,
    droppedChunks: 17, bytes: 1,342,177,280`).
  - `w0_bench.py --rows=freqsep_15k` (`adobe_15000x10000.jpg`): `png_open` `2474 [2383..2513]` -> `1589 [1588..1612] ms`
    (`1.56x`, `-885 ms`).
  - `document_perf.py 15000x10000` (4-layer `.scumble` document; its `15,000 x 10,000` base is a Pillow single-stream RGB
    PNG, `colorType = 2`, 453 MB of the 457 MB archive, which `pngPartsOf` refuses after 33 bytes so the base takes
    `png_read` in both arms and only the 3 sparse Scumble-written paint layers take `readPngParts` — the row is a tie):
    `loadMs` `4214 [3872..4248]` -> `3902 [3809..4411] ms` (`1.08x`), `restoreMs` `4591 [4312..4788]` ->
    `4307 [4216..4486] ms` (`1.07x`), `openMs` `4685 [4622..4826]` -> `4649 [4263..4747] ms` (`1.01x`).
  - Browser-encoded 15k 1-`IDAT` PNG (`88.66 MB`): `pngPartsOf` returns `null` after 41 bytes; `pixelsOffThread`
    `1199.3 ms`, `loadFile + mips` `1472.7 ms`.
  - `huge` (`20000x15000`, 300 MP, 550.4 MB): `open_through_the_stream_reader` `2571 ms` (`blocked: 43 ms`),
    `a_restore_from_the_state` `3381 ms` (`blocked: 118 ms`). At `30000x20000` (600 MP, 1,100.7 MB, direct A/B on
    `9fd93524` `before/huge_30k.json` vs K8 `after/huge_30k.json`): `open_through_the_stream_reader` `8726 ms`
    (`blocked: 496 ms`) -> `5337 ms` (`blocked: 543 ms`, `1.63x`, `-3389 ms`), `a_restore_from_the_state` `9770 ms`
    (`blocked: 75 ms`) -> `5814 ms` (`blocked: 166 ms`, `1.68x`, `-3956 ms`); in the 6-step `after/huge_open_restore.log`
    run, `open_through_the_stream_reader` was `5606 ms` (`blocked: 542 ms`) and `a_restore_from_the_state` `6740 ms`
    (`blocked: 149 ms`, against W0b of 2026-10-23, not an A/B: `10913 ms` open / `11859 ms` restore).
- **For Stop 4** (`stop4_probe.py`, `.claude/coord/chain-p/questions.md`):
  - **Question 6.1 (P5, independent part starts):** in standard K8, `78/78` non-first parts on `n1_15k` and `76/78` on
    `photo_15k` start with `Average` or `Paeth`, running `76–78` serial `png_part_finish` jobs (`524–709 ms` summed
    worker time). Filtering row 0 of each part with `None` or `Sub` only (`needsPrev = 0/78`, `0` finish jobs) changes
    file size by `+0.030 %` (`+85 KB` on `275.82 MB`) on `n1_15k` and `-0.020 %` (`-37.6 KB` on `175.96 MB`) on
    `photo_15k`, speeds up `readPngParts + putCanvasRows` from `701.1` to `574.3 ms` (`1.22x`, `-126.8 ms`) on `n1_15k`
    and from `822.9` to `573.5 ms` (`1.43x`, `-249.4 ms`) on `photo_15k`, and speeds up `loadFile + mips` from `1467.4`
    to `1296.5 ms` (`1.13x`, `-170.9 ms`) on `n1_15k` and from `1288.0` to `986.5 ms` (`1.31x`, `-301.5 ms`) on
    `photo_15k`. Answered: YES (next session).
  - **Question 6.5 (upload while decoding):** running `uploadBlob` in parallel with `pixelsOffThread` after
    `checkBaseSize` saves `340.7 ms` (`1238.3` -> `897.6 ms`, `1.38x`) on `n1_15k` and `185.5 ms` (`1067.0` ->
    `881.5 ms`, `1.21x`) on `photo_15k`. Answered: YES (next session).
- **Tests and mutation:** `px_test.js` (`pngPartsOf` byte-read counts and 20 refused layouts with valid-FCHECK `CM != 8`
  and `CINFO > 7`, `readPngParts` mock-pool schedule, priority `0`, window cap, under/over-height, Adler and part-error
  cancellation, green under both Node and Electron); `editor_test.py` `a_scumble_png_opens_through_the_parted_reader`
  (tile-encoded `1503 x 1109` PNG on both Rust and `E.kernels = "js"` routes with `pxCalls` and `timing.bytes > 0`
  checked, band-source `3003 x 1109` PNG with `698`- and `411`-row parts above 256 rows, `rt` round-trip seam on
  non-fixed-point straight RGBA bytes against `png_read` and image routes, browser 1-`IDAT` PNG, later-part failure
  fallback after earlier parts' rows landed verifying `px.release()`, real damaged parted PNGs with corrupt middle
  deflate and corrupt tail Adler-32 verifying refusal and arena slot return `[6, 6]` after GC, and Electron worker
  rejections); 20/20 mutants killed (`docs/measurements/k8_2026-11-09/mutation/results.txt`); gates `lint types editor
  document tiff pixels` on both backends, `export docux`, `huge:20000x15000`, `nodecopy`.
```

### K37 (2026-11-09): the bucket over tiles

On `3fd8bda7` (ABI 36, merged with `wasm-kernels` `e39b8d03` at ABI 39); full tier (the bucket's pixel path on tile
layers, §4.11 & §7). `docs/measurements/k37_2026-11-09/` (`measure_k37.py`, `round_0.json`..`round_2.json`, `summary.txt`,
`mutants_k37.py`, `mutation/`).
- **Built (wasm unchanged):** `inpaint_tiles.js` `fillTile(color)` (a cached 256 x 256 solid RGBA8 tile) and
  `TileLayerPixels.prototype.compositeFill(tiles, color, op, alpha, at = [0, 0])`: composites a flood's 256 x 256 alpha
  tiles (`[{ tx, ty, alpha }]` from K9's `floodOverTiles`) in place through `compositeMaskedTile` (K36), directly at
  `(ft.tx + (ox >> 8), ft.ty + (oy >> 8))` when `at` is 256-aligned and through `tilesSource(tiles, [ox, oy])` when `at`
  is off-grid, clamping partial right/bottom edge tiles on a copy of the mask, skipping missing tiles when `op !== 0`
  (`source-atop`), and dropping emptied tiles (`r === 2`). `inpaint_canvas.js` `bucketFill` captures `color` and
  `brushOpacity` before `await floodRegion`, passes `tiles: true` when `this.tileMode && InpaintEditor.bucketTiles !== false`
  and `!(alphaLocked && opacity >= 1)` and the target layer is (or will be) tile pixels at scale 1 with a whole-pixel
  offset, re-verifies 1:1 scale and whole-pixel offset after the `await` (aborting with a status message if the layer
  changed during the flood), takes `r.bounds` for the undo snapshot rect and dirty box, and composites `r.tiles` through
  `target.compositeFill` (catching `PixelMemoryError` so `markLayerChanged` and `draw` still run for any tiles written).
  At full opacity the bytes equal the canvas path (the alpha-locked fill at full opacity stays on the canvas path); at
  opacity below 1, partially blended pixels differ from Skia by at most one premultiplied level.
- **Tests:** `node tools/px_test.js` and `ELECTRON_RUN_AS_NODE=1 electron tools/px_test.js` PASS
  (`TileLayerPixels.compositeFill` in `compositeSha`: grid-aligned, off-grid, and bottom-edge fills, literal colour bytes,
  right and bottom edge clamping, frozen clone sharing, `"js"` vs `"rust"` byte-exact). `editor` gate
  `the_flood_over_tiles_is_the_flood_over_canvases` (every wand and bucket flood over tiles returns `"tiles"` with 64 KB
  alpha buffers) and `the_bucket_fills_through_the_kernel_on_tiles` (12 comparative cases covering full/partial opacity,
  alpha lock, off-grid selection clipping, 4-edge layer crossing, no-active-layer creation, and scaled/fractional-offset
  fallbacks against `InpaintEditor.bucketTiles = false`, `"js"` vs `"rust"` 0 bytes differ, undo 0 bytes differ, plus 3
  mid-flood colour/geometry race checks). Gates `--offline` (`run_gates_both.sh k37`, `k37-fix`, and `k37-merge`
  `--shards 2 --ports 9619,9620`): `lint`, `types`, `nodecopy`, `pixels`, `composite`, `selection`, `brush`, `editor`
  (2 shards per backend, 128 steps) BOTH PASS.
- **Before -> after** (`summary.txt`: three Latin-square rounds on fresh instances, 15000 x 10000, `--tiles --no-comfy`,
  busy lock held; `before` = in-tree `InpaintEditor.bucketTiles = false` switch running `drawInto` -> `_scratchDraw`
  readback of the flood box), median [min-max]: `bucket_fill` (58.3M px across 1,045 tiles) wall 2,682.3 [2,581.3-2,756.3]
  -> 1,337.0 [1,288.8-1,392.9] ms (2.01x faster), longest window block 1,441.7 [1,439.5-1,555.0] -> 209.9 [205.7-210.6] ms
  (6.87x shorter), `2d getImageData` 1,062.8 ms (572.2 MB, 12 calls) -> 0 ms (0 MB), `2d putImageData` 647.0 MB -> 75.7 MB;
  `bucket_one_disc` (441.5k px, 15 tiles) wall 39.0 [36.6-103.3] -> 28.1 [25.7-98.0] ms, block 16.2 [15.7-60.4] ->
  9.8 [9.3-62.0] ms; `bucket_sel_1000` wall 36.7 -> 29.4 ms, block 15.4 -> 11.0 ms; `bucket_sel_256` wall 33.1 ->
  24.8 ms, block 14.8 -> 5.7 ms; `bucket_sel_64` (4,096 px, 1 tile) wall 34.9 -> 24.9 ms, block 12.2 -> 5.5 ms. Every
  row's FNV-1a hash (including full-picture `2564466665` on `bucket_fill`) matches across `before`, `rust`, and `js`.
  Isolated `compositeFill` on 1,045 tiles: Rust SIMD 192.70 [188.44-201.03] ms vs JS twin 620.31 [619.64-621.45] ms
  (3.22x faster). No size threshold needed because `before` reads back the entire flood box in `_scratchDraw` even on a
  64 x 64 selection.
- **The mutation round** (`mutants_k37.py`, `mutation/results.txt`): **15 of 15 killed** on their focused kill sets
  (`compositeSha` and `the_bucket_fills_through_the_kernel_on_tiles`), 0 survived.
```

### K13 (2026-11-09): relight's scalar f64 shadow march and hoisted tap constants (the Antigravity L chain)

By a Gemini agent in Antigravity (`.claude/coord/chain-l/`) on `3fd8bda7` (`7dbc030f`, merged with `wasm-kernels` `92d29245` at `96d4a33f`), ABI 40 -> 41 (36 -> 37 on `3fd8bda7`);
`docs/measurements/k13_2026-11-09/` (`k13_chain.sh`, `summarize.py`, `summary_rows.txt`, `summary.txt`, `px_bench.txt`,
`electron_px_relight.txt`, `electron_px_mask.txt`, `electron_px_full.txt`, `chain.log`, `before/`, `after/`, `gates/`, `mutation/`).
- **Wasm builds (`python tools/build_px.py`, verified with `--check`):**
  - `before px.wasm` (`git cat-file blob 3fd8bda7:renderer/editor/px/px.wasm`): 259,180 bytes, sha256 `7e99b55f37ff69ff` (`7e99b55f37ff69ffdfb0b8e5f78e01b234fc3a96759eda4b1870832e934f65a5`) -> `after px.wasm` (`96d4a33f`, merged with `92d29245`, ABI 41): 279,003 bytes, sha256 `1641bd5c67921db4` (`1641bd5c67921db41de58597217f7a135a897673bc7142ee22012b4e276f3d7a`); pre-merge `7dbc030f` on `3fd8bda7` (ABI 37): 260,652 bytes, sha256 `3d9bec873cda8745` (`3d9bec873cda8745c955338217d4682099e7605054e68d96598042d5a90a40bd`); 15k measurement runs (`chain.log:1-2`, commit `f915c5ee`) measured `px.wasm` 260,770 bytes, sha256 `c633b80fbee79614` (`c633b80fbee79614a06d6c3d0c95fd62865882274b542a08c5439977f0fb28e3`).
  - `before px_scalar.wasm` (`git cat-file blob 3fd8bda7:renderer/editor/px/px_scalar.wasm`): 210,462 bytes, sha256 `03ddfff981982e19` (`03ddfff981982e1953df1099a2c3a9a600a0aba581ac58192e38c28fdf0f781d`) -> `after px_scalar.wasm` (`96d4a33f`, merged with `92d29245`, ABI 41): 225,584 bytes, sha256 `4ab3e3e738c13b6e` (`4ab3e3e738c13b6eb7799fa8cd7c6c16bf154fe79c6ad9abf66f0ce064c8d671`); pre-merge `7dbc030f` on `3fd8bda7` (ABI 37): 211,934 bytes, sha256 `4c2310eab695466c` (`4c2310eab695466cbb75bae4e3568e87f9408f8256be4db146b30d8ea51bf23e`); 15k measurement runs (`f915c5ee`) measured `px_scalar.wasm` 212,018 bytes, sha256 `7b7f92f13ade53fe` (`7b7f92f13ade53fe141f2771eb7bbbc8bc17f01a11c3a5009168bf4335982db0`).
- **Built (ABI 37):**
  - `renderer/editor/px/kernels_js.js`: added `export` to `relightVogel(n)` (was module-private `function relightVogel(n)`). In `shadowMarch`, hoisted `invSteps = 1.0 / nSteps` and per-tap `Float64Array` constants `tapX`, `tapY`, `tapZ` outside the `0..bandRows` pixel loop (`(dirX / dLen) * sunDist` for `kind === 1`; `lx + disc[t][0] * r`, `ly + disc[t][1] * r`, `lz` for `kind !== 1`). Kept `tx = px + tapX[t]`, `rdx = tx - px`, `stepX = rdx * invSteps` per pixel inside the loop so the hoisted twin is byte-for-byte identical to the pre-hoist reference (folding `rdx` to `tapX[t]` on a sun changes bits on rounding ties).
  - `crates/px/src/relight.rs` and `crates/px/src/lib.rs`: bumped `px_abi_version()` 36 -> 37; added `relight::march_lens(w, h, row0, rows) -> Option<(usize, usize, usize)>`, `relight::shadow_march_f64`, and `shadow_march_f64(depth: *const u16, w: usize, h: usize, scale: f64, is_sun: u32, taps_xyz: *const f64, taps: u32, steps: u32, z_bias: f64, row0: usize, rows: usize, out: *mut u8)`. Refuses `w == 0`, `h == 0`, `w >= 0x4000_0000`, `h >= 0x4000_0000`, `row0 >= h`, `rows == 0`, `w.checked_mul(h)` / `w.checked_mul(band_rows)` overflow (`relight::march_lens`), `taps == 0`, `taps > 16`, `steps == 0`, `steps > 64`, non-finite `scale` / `z_bias` / `taps_xyz`, or `z_bias < 0.0` without touching `out`. Marches in `f64` in the twin's operation order (`inv65535 = scale / 65535.0`, `inv_steps = 1.0 / (steps as f64)`, per-pixel `tx = px + cx_t`, `rdx = tx - px`, `step_x = rdx * inv_steps`, `sx = px + step_x`, float bounds check `cx < 0.0 || cy < 0.0 || cx >= wf || cy >= hf` before `cx.to_int_unchecked::<usize>()` and `get_unchecked`).
  - `renderer/editor/px/px.js`: bumped `PX_ABI = 37`, imported `relightVogel`, added `Px.prototype.shadowMarchF64(depth, w, h, scale, light, radius, taps, steps, bias, row0 = 0, rows = h - row0, out = null, key = null)` validating arguments (including `b < 0` and `< 0x40000000`), computing the `nTaps * 3` `f64` tap constants in V8 with the twin's exact formulas, and using `this._slot("relight_depth", String(key), depth, n * 2)` when `key` is given.
  - `renderer/editor/px/kernels.js`: added `shadowMarch: "kernelSize"` to `ROUTE_KINDS`; added `MARCH_MAX = 0x40000000` and `marchGuardOk(w, h, scale, light, radius, bias)` sending invalid `w` / `h`, non-finite values, `bias < 0`, or coordinates/scale/radius/bias `>= 2^30` to the twin; routed `Number(light[3]) === 1` to `p.shadowMarch` (`f32`) and `Number(light[3]) !== 1` to `p.shadowMarchF64` (`f64`).
  - `renderer/editor/inpaint_worker.js`: updated `relightShadowJob` so `timing.kernels` compares `c0 = pxCalls()` and `c1 = pxCalls()` for `shadow_march` or `shadow_march_f64` and reports `"rust"` or `"js"` accurately.
- **Tests:** `node tools/px_test.js` PASS (`mutation/logs/orig.txt`), and `PX_ONLY=relightBench,relightStripe,relight` under `ELECTRON_RUN_AS_NODE=1` PASS (`electron_px_relight.txt`): 131 byte-exact `twinCheck` cases on both wasm builds (covering `96 x 64` and `512 x 341` at `[1, 1], [1, 16], [3, 16], [4, 32], [16, 64]` and `1024 x 682` at `[1, 16], [3, 1], [4, 32], [16, 64]` across all 8 lights; non-integer `ensureRelightMaps`-style coordinates and parameters; non-trivial `hasZero && hasLit` check on `512 x 341` and `1024 x 682`; boundary cases for `map_z == sz + z_bias`, `rdz < 0 && sz > scale`, `cx == 0.0`, `cy == 0.0`, `cx == wf`, `cy == hf`, `s == steps`, and sun `tx - px` rounding tie), pre-hoist reference vs hoisted `js.shadowMarch` (131 cases, 0 bytes differ), 770 stripe cases (including both `f32` and `f64` Rust builds at `512 x 341` and `1024 x 682`), resident `_slot` check across 4 stripes (`slotCopied === 1` and byte equality against a full-height call), refusal checks on both `px.shadowMarchF64` and raw `px.exports.shadow_march_f64` (including `w = h = 65536` `checked_mul` overflow), `marchGuardOk` check on both point and sun lights, and `shadowMarch` route check. Gates `k13-gates-tiles`, `k13-gates-canvas`, `k13-gates-tiles-serial`, `k13-gates-canvas-serial` (`lint types relight pixels nodecopy`) ALL PASS; `relight_test.py` case `nk` asserts `t.kernels === "rust"` and `shadow_march_f64` ran for `point` and `shadow_march` for `sun`. Mutation round (`mutation/mut_k13.py`, `results.txt`): 12 of 12 killed on focused `px` kill sets, 0 survived.
- **Before -> after at 15,000 x 10,000** (`summary_rows.txt`, map `4096 x 2731`, three alternating rounds under the busy lock): scalar `shadow_march_f64` ties on `relight_one` (`980 [942-1,025] -> 1,004 [852-1,100]` ms) and `relight_first` (`3,719 [3,196-3,981] -> 4,201 [3,148-4,236]` ms), and loses on `relight_one_job` (`4,757 -> 5,980` ms, +25.7 %), `relight_one_s64` (`730 -> 1,084` ms, +48.5 %), `relight_three` (`1,656 [1,368-1,803] -> 2,234 [1,998-2,334]` ms, +34.9 %), `relight_three_job` (`4,914 -> 7,227` ms, +47.1 %), `relight_three_rep` (`1,346 -> 2,012` ms, +49.5 %), `relight_quick` (`9.5 [7.7-38.2] -> 51.6 [49.0-74.7]` ms landed; `relight_quick_first` is only `2.1 [1.6-2.5] -> 3.3 [3.3-3.5]` ms and slowest stripe `4.2 -> 4.3` ms, so the +42.1 ms landed step is **inferred** to be main-thread ~40 ms frame/redraw quantization when the stripes take ~1.2 ms longer), `relight_pan` shadows landed (`705 -> 1,144` ms; pan frame `5.2 -> 5.6` ms, worst `7.4 -> 8.1` ms; primarily scalar `shadow_march_f64`, with ~1–2 ms **inferred** from re-copying the 22.4 MB full depth map into `"relight_depth"` after `relight_quick` replaced it), `relight_nodraw` (`676 -> 934` ms), and the first sun march row `relight_sun` (`348 [312-372] -> 599 [545-669]` ms landed; `first stripe a worker ms` `54 [49-117] -> 337 [302-387]` ms across all 8 workers right after the 64 MB `relight_heavy_*` `crc` rows while `later` is `69.9 -> 79` ms, **inferred** from worker V8/OS working-set or tiering state after `shadow_march_f64` + 64 MB `crc`, while `relight_sun_job` `1,890 -> 1,681` ms, `relight_sun_rep` `323 -> 394` ms with `first stripe` back to `43.8` ms, `relight_sun_s64` `363 -> 356` ms, `relight_sun_nofeed` `315 -> 355` ms, and `relight_sun_feed2` `320 -> 388` ms all tie or win). Explaining (`px_bench.txt` at `4096 x 2731`): `routed` (`rust_f64`) is `3,808` / `4,157` ms (Node) and `3,734` / `5,355` ms (Electron) vs the hoisted twin's `2,963` / `3,207` ms (Node) and `3,146` / `4,743` ms (Electron) (`1.13x–1.30x` `routed / twin`, `1.18x–1.51x` `simd_f64 / twin` before K14's `f64x2` SIMD lanes). Point and spot stay routed to `shadow_march_f64` at K13 per `brief.md` line 41; K14 adds `f64x2` lanes and decides the final route.

---

### K14 (2026-11-09): relight's y-precomputed f64 shadow march, sun route, and removal of f32 shadow_march (the Antigravity L chain)

By a Gemini agent in Antigravity (`.claude/coord/chain-l/`) on `9a5f1681` (`391f03a3`, merged with `wasm-kernels` `f42396e3` at `bd2185d8` / `2ab474a5`), ABI 44 -> 45 (42 -> 43 on `9a5f1681`);
`docs/measurements/k14_2026-11-09/` (`k14_chain.sh`, `summarize.py`, `summary_rows.txt`, `summary.txt`, `px_bench.txt`,
`electron_px_relight.txt`, `electron_px_full.txt`, `px_test_node.txt`, `before/`, `after/`, `after_scalar/`, `after_lanes/`, `after_js/`, `gates/`, `mutation/`).
- **Wasm builds (`python tools/build_px.py`, verified with `--check`):**
  - `before px.wasm` (`git cat-file blob f42396e3:renderer/editor/px/px.wasm`, ABI 44): 291,274 bytes, sha256 `e35da0b473c7fdf9` (`e35da0b473c7fdf9985b6012d8cb3f35ca4d215edb034ea0b7abb4f256f1d0e7`) -> `after px.wasm` (`2ab474a5`, ABI 45): 289,975 bytes (-1,299 bytes), sha256 `f326653b273e3c87` (`f326653b273e3c871b64943c8bc17a66f32b518073ef3d2bd50b16cc592cb270`); 15k `before` arm at `9a5f1681` (ABI 42): 279,003 bytes, sha256 `aeb476777e971bbd` (`aeb476777e971bbd267ebe6b16be41a0e64110374a248d2bbb9b8feded7f2876`); removed `f64x2` candidate `after_lanes` (`391f03a3`, ABI 43): 278,237 bytes, sha256 `43bb945b8cdfe635` (`43bb945b8cdfe635cae5ee84a454da3d626a7b7b3f47bf7bf6a86b4056821fa0`).
  - `before px_scalar.wasm` (`git cat-file blob f42396e3:renderer/editor/px/px_scalar.wasm`, ABI 44): 233,384 bytes, sha256 `bbd719d5ec34c80d` (`bbd719d5ec34c80da3949fd3078e8e3ff3aa8f883f515d6f68425dbab96117c3`) -> `after px_scalar.wasm` (`2ab474a5`, ABI 45): 232,343 bytes (-1,041 bytes), sha256 `0c067d6ca569c44e` (`0c067d6ca569c44e6322547e18e5dcf23b9b2b39e10fac0eac12599a6bb74fa5`); 15k `before` arm at `9a5f1681` (ABI 42): 225,584 bytes, sha256 `920cb56151a5a0fc` (`920cb56151a5a0fc949f85adaeb027e19400d4466a579e56114ab26a6a9cb550`).
- **Built (ABI 45):**
  - `crates/px/src/relight.rs` and `crates/px/src/lib.rs`: bumped `px_abi_version()` to `45`; removed `pub const VOGEL_16`, `relight::shadow_march` (`f32`), and `pub unsafe extern "C" fn shadow_march(...)`. In `relight::shadow_march_f64`, precomputed the row-and-tap invariant `y` march (`iy_rows: [[usize; 64]; 16]` and `max_steps: [usize; 16]`) once per row `y` (`ty = if is_sun { py + cy_t } else { cy_t }`, `rdy = ty - py`, `step_y = rdy * inv_steps`, `cy = sy + 0.5`, breaking at the first step where `cy < 0.0 || cy >= hf` and storing `iy * w`) and marched each pixel `x in 0..w` via `march_pixel_scalar` across `0..valid_steps` in the twin's exact exit order (`rdz >= 0.0 && sz > scale` -> `0.0 <= cy < hf` via `valid_steps` and `0.0 <= cx < wf` -> `map_z > sz + z_bias` -> step advance), preserving per-pixel `tx = px + cx_t`, `rdx = tx - px`, `step_x = rdx * inv_steps` (and per-row `ty = py + cy_t`, `rdy = ty - py`, `step_y = rdy * inv_steps`). A 2-lane `f64x2` SIMD candidate (`after_lanes`, `391f03a3`) was measured in a 4-arm 15k comparison against lane-free `after_scalar` and removed after `after_scalar` beat `after_lanes` across the whole-operation rows (per-pixel early exit without stepping alongside a still-active neighbour lane or extracting lane indices to GPRs for scalar `u16` gathers).
  - `renderer/editor/px/px.js`, `renderer/editor/px/kernels.js`, and `renderer/editor/inpaint_worker.js`: bumped `PX_ABI = 45`; delegated `Px.prototype.shadowMarch` to `this.shadowMarchF64`; routed all light kinds (`point`, `spot`, and `sun`) in `kernels.js` `shadowMarch` to `p.shadowMarchF64` (no `DEFAULT_ROUTES` entry needed, with the 4-arm 15k medians and spreads documented above `DEFAULT_ROUTES`); simplified `ranRust` in `relightShadowJob` to check `shadow_march_f64`.
- **Tests:** `node tools/px_test.js` PASS (`px_test_node.txt`), full `ELECTRON_RUN_AS_NODE=1` `tools/px_test.js` PASS (`electron_px_full.txt`), and `ELECTRON_RUN_AS_NODE=1 PX_ONLY=relightBench,relightStripe,relight` PASS (`electron_px_relight.txt`): 142 byte-exact `twinCheck` cases on both wasm builds (including surgical `16x4` boundary, sky-exit, neighbour-pixel, `16x4 sun tx - px rounding tie`, and `4x16 sun ty - py rounding tie` cases first, plus odd widths `w = 1, 3, 5, 17`), 704 stripe cases across `twin`, `simd`, `scalar`, and `kernels.js` for `point`, `spot`, and `sun` (0 bytes differ), `relightBench` default-route pin (`r === undefined` and `want = "rust_f64"`), byte-parity across `routed`, `twin`, `simd_f64`, and `scalar_f64`, `marchGuardOk` (`f64Entered === 0`), route switching, and trap recovery checks for both `point` and `sun`. Gates `k14-gates-tiles`, `k14-gates-canvas`, `k14-gates-tiles-serial`, `k14-gates-canvas-serial` (`lint types relight pixels nodecopy`) ALL PASS; `relight_test.py` case `nk` asserts `shadow_march_f64` ran for both `sun` and `point`. Mutation round (`mutation/mut_k14.py`, `results.txt`): 15 of 15 killed on focused `px` kill sets (`relight`, `relightBench`), 0 survived.
- **Four-way 15,000 x 10,000 comparison (`summary_rows.txt`, map `4096 x 2731`, three rounds per arm under the busy lock: `before` vs `after_scalar` vs `after_lanes` vs `after_js`):**
  - `after_scalar` (shipped lane-free `shadow_march_f64` + `y` precompute) beats `after_lanes` (`f64x2` + `y` precompute, removed) outside spreads on `relight_one` (`493 [490-501]` vs `599 [570-608]` ms; one-job `3,245 [3,197-3,257]` vs `3,530 [3,511-3,733]` ms; `relight_one_rep` `516 [507-531]` vs `576 [540-617]` ms; `relight_one_nofeed` `468 [460-487]` vs `548 [547-571]` ms), `relight_sun` kernel (`865 [844-874]` vs `912 [904-1,027]` ms; landed `170 [166-172]` vs `182 [172-192]` ms), `relight_nodraw_job` (`3,146 [3,039-3,364]` vs `3,435 [3,404-3,537]` ms), and `relight_draw_job` (`3,194 [3,024-3,354]` vs `3,546 [3,424-3,549]` ms).
  - Against `after_js` (`shadowMarch: "js"`, hoisted V8 `f64` twin) and `before`, `after_scalar` **wins outside spreads** on `relight_one` (`493 [490-501]` vs `681 [650-709]` vs `748 [748-753]` ms; blocked `42.5 [40.9-46.4]` vs `63 [54-67]` vs `61 [54-68]` ms; kernel `3,648 [3,626-3,670]` vs `5,037 [4,641-5,293]` vs `5,616 [5,606-5,661]` ms; one-job `3,245 [3,197-3,257]` vs `3,595 [3,456-3,684]` vs `4,894 [4,785-4,982]` ms; `relight_one_nofeed` `468 [460-487]` vs `545 [510-579]` vs `701 [698-788]` ms) and on the sun rows (`relight_sun` landed `170 [166-172]` vs `286 [250-309]` vs `527 [506-575]` ms, `1.68x` vs `after_js` and `3.10x` vs `before`; one-job `762 [748-850]` vs `1,075 [1,008-1,097]` vs `1,586 [1,581-1,647]` ms; `relight_sun_nofeed` `175 [174-176]` vs `209 [187-213]` vs `263 [253-296]` ms; `relight_sun_feed2` `171 [169-186]` vs `207 [206-272]` vs `269 [253-307]` ms), and **ties `after_js` within spread (decided by the kernel row, while winning outside spreads over `before` and leading `after_js` on every landed median)** on `relight_one_rep` (`516 [507-531]` vs `539 [490-547]` ms, kernel `3,860 [3,753-3,944]` vs `4,054 [3,653-4,069]` ms; `after_js` had lower `blocked` `47 [40-52]` vs `59.8 [58.1-63.5]` ms), `relight_sun_rep` (`180 [164-185]` vs `193 [182-209]` ms, kernel `903 [872-943]` vs `1,106 [1,056-1,108]` ms outside spreads), `relight_three` (`1,009 [965-1,070]` vs `1,144 [1,015-1,212]` ms, kernel `7,883 [7,564-8,242]` vs `8,990 [7,760-9,434]` ms, one-job `3,284 [3,282-3,572]` vs `3,863 [3,570-5,187]` ms; `after_js` had lower `blocked` `58 [53-59]` vs `84.4 [75.3-89.3]` ms), `relight_nodraw` (`465 [463-564]` vs `561 [500-602]` ms, kernel `3,456 [3,443-4,175]` vs `4,243 [3,781-4,439]` ms), and `relight_draw` (`518 [485-565]` vs `546 [504-552]` ms, kernel `3,658 [3,578-4,248]` vs `3,996 [3,729-4,053]` ms, with `relight_draw_job` `3,194 [3,024-3,354]` vs `3,608 [3,392-3,667]` ms outside spreads). (On the removed `after_lanes` arm vs `after_js`, `after_js` had the lower landed median on `relight_one_rep` `539` vs `576` ms and `relight_one_nofeed` `545` vs `548` ms; removing the lanes flipped both to `after_scalar` at `516` and `468` ms.)
  - Explaining (`px_bench.txt` at `4096 x 2731` on the shipped lane-free ABI 45 build, quoting all four columns `routed / twin / simd_f64 / scalar_f64` for `point`, `spot`, `sun`): Node V8 `2,411.2 / 2,775.2 / 2,420.9 / 2,419.0` ms (`point`, `1.15x`), `2,734.4 / 3,150.4 / 2,736.9 / 2,681.9` ms (`spot`, `1.15x`), `764.4 / 987.8 / 751.0 / 775.1` ms (`sun`, `1.32x`); Electron V8 `3,802.7 / 4,201.8 / 3,754.9 / 3,692.6` ms (`point`, `1.12x`), `4,102.0 / 4,807.0 / 4,055.6 / 4,107.1` ms (`spot`, `1.19x`), `717.4 / 940.3 / 727.3 / 717.6` ms (`sun`, `1.29x`), beating `twin` across all 24 bench rows (vs `391f03a3` where `f64x2` `simd_f64` `3,502.4 / 2,943.0 / 822.8` ms lost to `scalar_f64` `3,342.1 / 2,790.9 / 746.7` ms in 23 of 24 rows).
  - For the user's threads spike decision (question 6.7), parallel efficiency `[busy share]` on `after_scalar` is `0.811 [0.808-0.819]` (`[0.926]`, repeat `0.784 [0.928]`) on `relight_one`, `0.839 [0.790-0.939]` (`[0.976]`, repeat `0.816 [0.973]`) on `relight_three`, and `0.560 [0.530-0.609]` (`[0.635]`, repeat `0.569 [0.657]`) on `relight_sun`; 64 stripes (`STRIPES_PER_WORKER = 8`) ties 32 stripes within spread on `relight_one_s64` (`510 [492-521]` vs `516 [507-531]` ms), `relight_three_s64` (`1,015 [982-1,088]` vs `1,037 [1,006-1,167]` ms), and `relight_sun_s64` (`173 [162-207]` vs `180 [164-185]` ms), so `STRIPES_PER_WORKER = 4` stays unchanged.

---
- **The review's main finding changed the build (`K14-T1`):** the first hand-in's f64x2 lanes lost to the same march without them; the fourth 15k arm showed it and the lanes were removed before the merge. **The merged state's gates:** `lint types relight pixels nodecopy editor` PASS on both backends (`merge-k14-tiles`, `merge-k14-canvas`), `px_test` PASS under Node and Electron.

### K10c (2026-11-09): PSD pack and the wand's box in wasm memory; dissolve and clip coverage in Rust (the Antigravity C chain)

By a Gemini agent in Antigravity (`.claude/coord/chain-c/`) on `3359cb0f` (`645be38c` K10c, pre-review fixes `90c4c5ae`, review fixes `d1febf69`, merged `wasm-kernels` `ad291b4b` at `ff581ecd`), ABI 41 -> 42 on `3359cb0f` (`px.wasm` 279,969 B `+2,438 B` `193dd3adf6a169e5` against `3359cb0f`'s 277,531 B `d3d4567365549b49`; `px_scalar.wasm` 225,508 B `+1,396 B` `71e5311ccaec73ec` against `3359cb0f`'s 224,112 B `e23e1ca9bd65303d`; ABI 43 -> 44 after merging `0d14b9eb` / `ad291b4b`: `px.wasm` 291,274 B `+2,437 B` `e35da0b473c7fdf9` against `0d14b9eb`'s 288,837 B `98a2ff8e1059320e`, `px_scalar.wasm` 233,384 B `+1,395 B` `bbd719d5ec34c80d` against `0d14b9eb`'s 231,989 B `e38994087277d49e`); `docs/PLAN_WASM_K10.md`, `docs/measurements/k10c_2026-11-09/`.
- **Built (`crates/px/src/composite.rs`, `crates/px/src/lib.rs`, `renderer/editor/px/px.js`, `renderer/editor/px/kernels.js`, `renderer/editor/inpaint_worker.js`):**
  - `crates/px/src/composite.rs`: added `pub fn clip_coverage(cov: &mut [u8], base_mask: Option<&[u8]>, alpha: u8, own: Option<&[u8]>)` (`:691-715`) with `wasm32` + `simd128` `simd::clip_coverage` (`:1207-1229`, 16 bytes at a time via `v128_load`, `simd::mul255`, `v128_store` and scalar tail), `lowbias32` / `hash32` (`:718-730`), and `pub fn dissolve_rows(src: &mut [u8], w: usize, rows: usize, x0: i32, y0: i32, alpha: u8, mask: Option<&[u8]>, seed: u32)` (`:736-775`) with `simd::dissolve_row` (`:1237-1293`, 4 pixels at a time in `u32x4` lanes with exact 32-bit `mul255_u32` and `lowbias32` / `hash32`, branchless `v128_bitselect` preserving `src_a == 0` RGB untouched and `c_val == 255` short-circuit). Exported `clip_coverage` (`:657-671`) and `dissolve_rows` (`:677-695`) in `crates/px/src/lib.rs` with `px_abi_version()` bumped from `41` to `42` (`44` after merging `wasm-kernels`, `:57-59`).
  - `renderer/editor/px/px.js`: bumped `export const PX_ABI` (`:16` pre-merge, `:18` post-merge); added `Px.prototype.psdPackRowsFromPtr(a, pr, w, rows)` (`:1088-1099` pre-merge, `:1164-1175` post-merge) and refactored `psdPackRows` (`:1081-1086` pre-merge, `:1152-1158` post-merge) to delegate to `psdPackRowsFromPtr`.
  - `renderer/editor/px/kernels.js`: added `clipCoverage: "kernel", dissolveRows: "kernel", psdPartWasm: "kernel", stackIntoWasm: "kernel"` to `ROUTE_KINDS` (`:65` pre-merge, `:68` post-merge).
  - `renderer/editor/inpaint_worker.js`: K10b's `stackRowsToWasm` wiring (`:459-466` calling `p.exports.clip_coverage(pcov, px, pbm, c.alpha, pm)` when `p.exports.clip_coverage && route("clipCoverage") !== "js"` with `"js"` fallback `clipCoverage(covView, bmView, c.alpha, ownView)` over `p.view(Uint8Array, ...)`, and `:470-495` calling `p.exports.dissolve_rows(psrc, W, n, X0, Y0, l.alpha, pm, l.dissolve >>> 0)` when `p.exports.dissolve_rows && route("dissolveRows") !== "js"` with `"js"` fallback inline loop over `srcView = p.view(Uint8Array, psrc, byteLen)` using `mul255` and `hash32`, with `wrapCalls` on `p.exports` recording both exports in `pxCalls` when `pxTimed()` is on) goes live once `clip_coverage` and `dissolve_rows` are exported by `crates/px/src/lib.rs`; updated `stackInto(msg)` (`:528-563`) to take the pointer path (`stackRowsToWasm(p, a, msg, false, into)` + `p.get(Uint8Array, pd, byteLen, into)`) when `p && msg.stack.layers.length > 0 && route("stackIntoWasm") !== "js"`, with `p._reset(a)` in `finally`, `composeWasm: 1` on the pointer path, and `composeWasm: 0` on `"js"` / base-only (`layers: []`) / after `recovered(p, err, "stack_into")`; updated `psdPart(msg)` (`:769-815`) to take the pointer path (`partPtrOf(p, a, msg, false)` + `p.psdPackRowsFromPtr(a, ptrs.pr, msg.w, msg.rows)`) when `p && !msg.rgba && route("psdPartWasm") !== "js"`, with `p._reset(a)` and `releaseIfLarge()` in `finally`, `composeWasm: 1` on the pointer path, and `composeWasm: 0` on `"js"` / `msg.rgba` / after `recovered(p, err, "psd_part")`.
- **Tests and mutation (`tools/px_test.js`, `tools/boxstack_test.js`, `tools/export_test.py`, `docs/measurements/k10c_2026-11-09/mutation/`):**
  - `tools/px_test.js`: extended `composeWasmPartCases` (`:5622-6652` pre-merge, `:6549-7582` post-merge) with `2g` under `dissolveRows=js` (`:5912-5931` pre-merge, `:6821-6859` post-merge), `4a` (`:6086-6165` pre-merge, `:7016-7095` post-merge, run on both `rust simd` and `rust scalar`) direct `clip_coverage` sweep across lengths `0, 1, 7, 15, 16, 17, 31, 32, 33, 256, 1024`, alphas `0, 1, 127, 128, 129, 254, 255`, odd byte offsets, guard bytes (`0xA5`), all four `(base_mask, own)` combinations, and an exhaustive `65,536`-pair sweep; `4b` (`:6167-6289` pre-merge, `:7097-7219` post-merge) direct `dissolve_rows` sweep across dimensions `[1,1]..[65,3]`, positive/zero/negative `(x0, y0)`, `src_a = 0` with non-zero RGB (asserting RGB stays untouched), and `cVal = 255` where `(hash32(x, y, seed) >>> 24) === 255` in both SIMD lane 0 (`c = 0`) and scalar tail (`c = 4` of `w = 5`); `4c` (`:6291-6385` pre-merge, `:7221-7315` post-merge) `clipCoverage` / `dissolveRows` route switching inside `stackRowsToWasm` including a layer with both `clip` (offset base, `c.mask`, own `mask`) and `dissolve` (`:6314-6320` pre-merge, `:7244-7250` post-merge) across all four `(clipCoverage, dissolveRows)` route pairs (`rust+rust`, `js+js`, `rust+js`, `js+rust`, asserting `calls.clip_coverage === 2` and `calls.dissolve_rows === 2` on `"rust"` and `0` on `"js"`) plus `psdPackRowsFromPtr` parity against `px.psdPackRows` and `kernels_js.psdPackRows` across tile and stack parts; `4d` (`:6387-6496` pre-merge, `:7317-7426` post-merge) `stackRowsToWasm` with `into` across multi-band `y !== y0` (`boxY0 + b * 36`) and `x0 = 48`, `l.sab` filter bands with both `l.clip` and `l.dissolve != null` (`:6414-6420` pre-merge, `:7344-7348` post-merge) on default and `"js"` routes (asserting `filterU8` is not mutated in place), and `st.base = null` with `clear: false` vs `clear: true`; and on `rust simd`: `5a` (`:6517-6567` pre-merge, `:7447-7497` post-merge) `W.psdPart` under `psdPartWasm=rust` vs `"js"`, `p.job.jobBytes === 0`, `releaseMB = 0`, and simulated `PxOutOfMemory` / wasm trap recovery inside `partPtrOf` and `psdPackRowsFromPtr`, `5b` (`:6569-6626` pre-merge, `:7499-7556` post-merge) `W.stackInto` under `stackIntoWasm=rust` vs `"js"`, whole-box band offset check against `W.rowsOfStack({ ...stackMsg, y: 16, y0: 16, rows: 64 })` (`:6594-6603` pre-merge, `:7524-7533` post-merge), `layers: []` base-only early exit (`composeWasm === 0`), `p.job.jobBytes === 0`, and simulated `PxOutOfMemory` / wasm trap recovery, and `5c` (`:6628-6646` pre-merge, `:7558-7576` post-merge) `W.stackPoints` with a dissolve layer matching `rowsOfStack` at sampled grid coordinates.
  - `tools/boxstack_test.js` (`:137-269`): added `compositeBox` clipped-layer and dissolve-layer tests against both `rowsOfStack` and frozen hand-computed 4×2 byte arrays (`[40,80,120,255, ...]` and `[30,60,90,255, ...]`, plus explicit `tieTop = 221` and `xHash255 = 237` probes).
  - `tools/export_test.py`: extended `stack_points_gathers_the_samples_it_names` (`:469-559`) with a dissolve layer under the upper matched layer (`dissolveDiffers: 14661`), extended `compose_in_wasm_memory_matches_js_gather` (`:1120-1359`, including a clipped + dissolved layer `ClippedDissolve` at `:1172-1184`) to verify `psd_part` and `stack_into` (`ed.readBoxBytes`) on default (`composeWasm === 1`, `pxCalls.clip_coverage > 0`, `pxCalls.dissolve_rows > 0`), sub-route (`clipCoverage=js`, `dissolveRows=js`), and full `"js"` routes (`composeWasm === 0`, byte-for-byte identical PSD and box buffers), and added `--clipped` to `--perf` (`:1439-1480`).
  - Mutation script `mut_k10c.py`: **31 of 31 killed** (6 Rust mutants `R01`–`R06` in `crates/px/src/composite.rs` tested on both `px.wasm` and `px_scalar.wasm`, and 25 JS mutants `J01`–`J25` across `inpaint_raster.js`, `blend_modes.js`, `inpaint_boxstack.js`, `inpaint_worker.js`, and `px.js`, `0` survived, `0` unexpected).
- **15,000 × 10,000 before / after (three alternating rounds against `3359cb0f` under the busy lock, `docs/measurements/k10c_2026-11-09/summary.txt`):**
  - `psdPartWasm`: `native_test.py export_psd` wall `1,296.0 [1,244.0-1,298.0]` -> `1,012.0 [854.0-1,057.0] ms` (`1.28x`, non-overlapping), `psd_part kernel` `8,287.7 [8,064.4-8,467.1]` -> `6,545.2 [5,410.3-6,637.4] ms` (`1.27x`, non-overlapping), `psd_part rows` `3,421.4 [3,407.3-3,569.6]` -> `1,844.7 [1,609.1-1,897.9] ms` (`1.85x`, non-overlapping); `exportperf psd` wall `1,981.0 [1,782.0-2,012.0]` -> `1,506.0 [1,495.0-1,532.0] ms` (`1.32x`, non-overlapping), `psd_part kernel` `6,283.1 [5,667.5-6,304.0]` -> `3,807.7 [3,791.3-3,926.6] ms` (`1.65x`, non-overlapping), `psd_part rows` `2,941.4` -> `1,320.2 ms` (`2.23x`, non-overlapping); `exportperf psd_masked` wall `2,283.0 [2,053.0-2,318.0]` -> `1,681.0 [1,656.0-1,709.0] ms` (`1.36x`, non-overlapping), `psd_part kernel` `7,438.8 [6,685.4-7,626.8]` -> `4,099.3 [3,940.0-4,420.1] ms` (`1.81x`, non-overlapping), `psd_part rows` `3,820.4` -> `1,551.0 ms` (`2.46x`, non-overlapping). **No `psdPartWasm` entry in `DEFAULT_ROUTES`.**
  - `stackIntoWasm`: `native_test.py wand_whole_picture` wall `1,417.0 [1,330.0-1,457.0]` -> `1,243.0 [1,095.0-1,278.0] ms` (`1.14x`, non-overlapping), `stack_into kernel` `2,440.5 [2,426.3-2,442.6]` -> `1,841.4 [1,532.4-1,918.9] ms` (`1.33x`, non-overlapping); `exportperf composite_bands` wall `1,189.0 [1,023.0-1,217.0]` -> `1,014.0 [994.0-1,015.0] ms` (`1.17x`, non-overlapping), `stack_into kernel` `4,595.8 [4,004.9-4,759.8]` -> `3,120.1 [2,913.0-3,318.8] ms` (`1.47x`, non-overlapping). On `match_wand` (wall `1,134.0 [1,130.0-1,303.0]` -> `1,090.0 [1,079.0-1,172.0] ms`, `1.04x`; `stack_into kernel` `2,610.4 [2,550.8-3,366.2]` -> `2,004.5 [1,825.9-2,008.5] ms`, `1.30x`, non-overlapping), `filter_export_png` (wall `1,267.0 [1,214.0-1,347.0]` -> `1,164.0 [1,083.0-1,301.0] ms`, `1.09x`; `stack_into kernel` `1,910.5 [1,652.5-2,023.7]` -> `1,134.2 [1,037.0-1,265.7] ms`, `1.68x`, non-overlapping), and `filter_wand` (wall `1,506.0 [1,469.0-1,523.0]` vs `1,519.0 [1,492.0-1,618.0] ms`, `0.99x`; `stack_into kernel` `1,994.6 [1,974.1-1,997.6]` -> `1,497.3 [1,400.3-1,622.0] ms`, `1.33x`, non-overlapping), whole-operation spreads overlap while `stack_into kernel` wins non-overlapping on every row (§1.1 rule 2). **No `stackIntoWasm` entry in `DEFAULT_ROUTES`.**
  - `dissolveRows`: `exportperf --blend=dissolve` (`dissolveRows=js` vs `dissolveRows=rust`) wins beyond the 3-run spread on all three rows: `composite_bands` wall `1,874.0 [1,851.0-2,009.0]` -> `1,403.0 [1,353.0-1,532.0] ms` (`1.34x`, non-overlapping; `stack_into kernel` `7,272.7` -> `3,200.5 ms`, `2.27x`), `psd` wall `2,257.0 [1,977.0-2,344.0]` -> `1,829.0 [1,599.0-1,854.0] ms` (`1.23x`, non-overlapping; `stack_into kernel` `7,348.7` -> `3,859.8 ms`, `1.90x`), and `psd_masked` wall `2,711.0 [2,423.0-2,792.0]` -> `2,286.0 [1,949.0-2,392.0] ms` (`1.19x`, non-overlapping; `stack_into kernel` `7,774.3` -> `3,839.7 ms`, `2.02x`). **No `dissolveRows` entry in `DEFAULT_ROUTES`.**
  - `clipCoverage`: `exportperf --clipped` (`clipCoverage=js` vs `clipCoverage=rust`) whole-operation wall times overlap (`composite_bands` `1,224.0 [1,182.0-1,401.0]` -> `1,096.0 [1,083.0-1,245.0] ms`, `1.12x`; `psd` `2,403.0 [1,977.0-3,092.0]` -> `2,147.0 [2,118.0-2,832.0] ms`, `1.12x`; `psd_masked` `2,353.0 [2,141.0-3,285.0]` vs `2,584.0 [2,356.0-2,811.0] ms`), while `stack_into kernel` is faster on every row (`composite_bands` `4,711.3 [4,666.8-5,273.5]` -> `4,159.7 [4,127.1-4,874.9] ms`, `1.13x`; `psd` `4,709.4 [4,627.4-5,049.7]` -> `4,275.3 [4,076.4-5,026.2] ms`, `1.10x`; `psd_masked` `5,082.8 [4,971.6-5,096.7]` -> `4,557.1 [4,404.8-4,559.3] ms`, `1.12x`, non-overlapping), passing §1.1 rule 2 (in Electron V8 `stack_into` `clipCoverage` is `117.88` -> `79.76 ms`, `1.48x`, and direct `clip_coverage` is `18.321` -> `0.999 ms`, `18.35x`). **No `clipCoverage` entry in `DEFAULT_ROUTES`.**
  - Retention (`px_probe.py --retention 15000x10000` & `retention_psd_wand.py 15000x10000`): `export_png` `workersMaxAfterMB = 42.25 MiB`, `workersMaxLaterMB = 1.06 MiB` (`releases = 0`, `idles = 8`); `export_psd` (`psdPartWasm=js` `882.0 ms` vs `rust` `673.9 ms`, `1.31x`) `workersMaxAfterMB = 23.00 MiB`, `workersMaxLaterMB = 1.06 MiB` (`releases = 0`, `idles = 8`); `wand_whole_picture` (`stackIntoWasm=js` `1,876.9 ms` vs `rust` `1,409.7 ms`, `1.33x`) `workersMaxAfterMB = 31.50 MiB`, `workersMaxLaterMB = 1.06 MiB` (`releases = 1`, `idles = 9`).

---
- **The merged state's gates (on `ad291b4b` + `ff581ecd`, serial):** `lint types export layered pixels editor tiff` PASS on both backends (`merge-k10c-tiles`, `merge-k10c-canvas`), `pxjobs nodecopy` PASS on tiles (`merge-k10c-serial`), `px_test` PASS under Node and Electron.

### K10a and K10b (2026-11-09): the C-chain design and PNG parts gathered and composited in wasm memory (the Antigravity C chain)

By a Gemini agent in Antigravity (`.claude/coord/chain-c/`) on `3fd8bda7` (`9bfd0c71` K10a design after two review rounds, `7ea19214` K10b, pre-review fixes `a1021829`, review fixes `893d57f8`, merged with `wasm-kernels` `e39b8d03` at `e99e596b`), ABI 39 -> 40 (`px.wasm` 272,079 B `7c566ffc0415ce54` against `e39b8d03`'s 272,079 B; `px_scalar.wasm` 221,113 B `023cf6920c562557` against `e39b8d03`'s 221,113 B; pre-merge on `3fd8bda7` ABI 36 -> 37: `px.wasm` 259,180 B `3f240c7a80d2f983` against `3fd8bda7`'s 259,180 B `7e99b55f37ff69ff`, `px_scalar.wasm` 210,462 B `0f3fe6c4448b871e` against `3fd8bda7`'s 210,462 B `03ddfff981982e19`, unchanged in byte size as only `px_abi_version()` bumped); `docs/PLAN_WASM_K10.md`, `docs/measurements/k10b_2026-11-09/`.
- **Built (`renderer/editor/px/px.js`, `renderer/editor/px/kernels.js`, `renderer/editor/inpaint_worker.js`):** `Px.prototype.pngPartFromPtr(a, pr, w, rows, pp, level, last, laps = null)` (`px.js:1173-1198`) filters (`png_filter_rows`), computes Adler-32 (`adler32`), deflates (`deflate_part`), and frames the IDAT chunk (`png_chunk_frame`) from pointers `(pr, pp)` already in caller-owned arena `a` without copying `rgba` or `prev` in from JS. `inpaint_worker.js` adds `tilesRowsToWasm(p, msg, above, ptr)` (`:228-252`), `storeRowsToWasm(p, store, X0, W, Y0, n, ptr, alphaOnly = false)` (`:289-319`), `stackRowsToWasm(p, a, msg, above = false, into = null)` (`:394-521`), and `partPtrOf(p, a, msg, needPrev = false)` (`:646-674`), with routes `composeTiles` and `composeStack` (`kernels.js:63`). Fresh `p.u8()` / `p.view(...)` views are taken after every `a.take(...)` so `memory.grow` never detaches a live view; every tile copy into wasm books `pxLapAdd("copyIn", ...)` while `pxTimed()` is on. `pngPart(msg)` (`:680-734`) takes the pointer path when `!msg.rgba && route(routeName) !== "js"` (`composeWasm: 1`), resetting `p._reset(a)` and calling `releaseIfLarge()` in `finally` before recording `kernel: now() - t0`, and falls back to JS gather + `p.pngPart` (`composeWasm: 0`) on `"js"` or after `recovered(p, err, "png_part")`.
- **Tests and mutation (`tools/px_test.js`, `tools/export_test.py`, `docs/measurements/k10b_2026-11-09/mutation/`):** `composeWasmPartCases` in `px_test.js` (`:5605-6043`, called from `pngPartCases` at `:4624`) checks byte-for-byte IDAT/CRC/Adler parity across single-layer tiles (`msg.tiles`, `msg.prevTiles` row `TILE - 1`, mid-tile-row `r0 > 0`, and sparse `null` tiles) and multi-layer stacks over a dirtied arena (`0xDD`) and dirtied linear-memory byte 0 (`px.u8()[0] = 7`): `2a` empty `layers: []` over soft-alpha and `A = 0` RGB base, `2b` non-overlapping layers where `storeRowsToWasm` returns `false`, `2c` separate `above` pass at part boundary `y = 256` via `stackRows(Wd, Hd, stores2c).part(256, 32, true)`, `2d` positive/negative layer offsets, an unmasked partial layer narrower than the band, and `l.mask` holes (`null` tile and missing tile row under existing layer pixels) at `x0 = 128`, `2e` 10-float `match_pixels` layer between blend layers, `2f` two clipped layers over a masked clip base (with `A = 0` holes and a `null`-tile hole in `c.mask` under existing clip-base pixels) plus a clipped layer over an unmasked clip base (`pbm = 0`), `2g` dissolve layer at `y = 16 > 0` (comparing both the main band and `above` row 15, with partial coverage and `cVal = 255` where `(hash32(x, y, dissolveSeed) >>> 24) === 255`), `2h` fresh-instance `freshPx.memory.buffer !== buf0` at `y = 12 > 0` across a 3-layer `512 × 244` stack (comparing both `freshOut` and `freshAbove`), and `3` route overrides, arena reset (`jobBytes === 0`, 1 kept chunk, constant `memory.buffer.byteLength` across 4 repeated parts) and `releaseMB = 0` (`releaseIfLarge()` increments `pxInstances().release`), plus simulated `PxOutOfMemory` and wasm trap recovery inside both `partPtrOf` (`p0.job.take`) and `pngPartFromPtr` on both `simd` and `scalar` builds; `export_test.py` step `compose_in_wasm_memory_matches_js_gather` (`:1103-1255`) verifies tile and stack PNG exports (including masked and unmasked clip bases, byte-length floor, and decoded center-pixel checks) across `js` and `rust` routes in the app (tile-only step; on `--tiles off`, `export_test.py` exits early before reaching it). Mutation script `mut_k10b.py`: **23 of 23 killed** (20 in `inpaint_worker.js`, 3 in `px.js`, `57.9 s`).
- **15,000 × 10,000 before / after (three alternating rounds against `3fd8bda7` under the busy lock, `docs/measurements/k10b_2026-11-09/summary.txt`):**
  - `composeStack`: `export_png` wall `1,010.0 [990.0-1,015.0]` -> `869.0 [868.0-899.0] ms` (`1.16x`, non-overlapping), `png_part kernel` `7,475.4 [7,359.9-7,511.8]` -> `6,514.7 [6,401.0-6,692.5] ms` (`1.15x`, non-overlapping), `png_part compose` `1,213.0 [1,183.6-1,217.4]` -> `609.6 [607.0-613.7] ms` (`1.99x`, non-overlapping); `match_export_png` wall `1,058.0 [1,035.0-1,121.0]` -> `894.0 [869.0-1,178.0] ms` (`1.18x`, spreads overlap; `png_part compose` `1,535.6 [1,396.6-1,582.5]` -> `797.7 [742.9-851.8] ms`, `1.93x`, non-overlapping). **No `composeStack` entry in `DEFAULT_ROUTES`.**
  - `composeTiles`: `exportperf layer_from_tiles` wall `265.0 [255.0-273.0]` -> `200.0 [192.0-232.0] ms` (`1.32x`, non-overlapping), `png_part kernel` `1,949.5 [1,871.2-2,013.4]` -> `1,488.0 [1,435.8-1,743.7] ms` (`1.31x`, non-overlapping), `png_part rows` `538.8` -> `258.5 ms` (`2.08x`); `export_ora` wall `2,255.0 [2,204.0-2,329.0]` -> `1,997.0 [1,977.0-2,090.0] ms` (`1.13x`, non-overlapping), `png_part kernel` `16,653.5` -> `14,715.5 ms` (`1.13x`), `png_part rows` `2,295.5` -> `1,057.2 ms` (`2.17x`); `open_psd` wall `6,466.0 [6,417.0-6,527.0]` -> `6,231.0 [6,167.0-6,333.0] ms` (`1.04x`, non-overlapping), `png_part rows` `385.1` -> `195.8 ms` (`1.97x`). On `open_ora` (wall `4,845.0 [4,827.0-5,262.0]` -> `4,986.0 [4,910.0-5,167.0] ms`, `timing.kernel` `6,550.5` -> `6,300.7 ms`, `1.04x`) and `tiffperf own` (`stored` `1,211.0 [1,137.0-1,304.0]` -> `1,196.0 [1,188.0-1,201.0] ms`, `timing.kernel` `5,816.9` -> `5,288.5 ms`, `1.10x`), whole-operation spreads overlap while `timing.kernel` is lower and `png_part rows` is `2.10x`–`2.18x` faster with non-overlapping spreads. On `tiffperf noise` (`stored` `3,343.0 [3,336.0-3,463.0]` -> `3,435.0 [3,381.0-3,709.0] ms`, `timing.kernel` `16,733.2 [16,593.0-16,928.8]` -> `17,033.5 [16,668.4-17,326.8] ms`, `0.98x`, dominated by `15.3–15.7 s` of incompressible deflate), `timing.kernel` does not pass the kernel tie-breaker, so `composeTiles` rests on its clear whole-operation wins on `layer_from_tiles`, `export_ora`, and `open_psd`. **No `composeTiles` entry in `DEFAULT_ROUTES`.**
  - Retention (`px_probe.py --retention 15000x10000`): `workersMaxAfterMB` `37.12` -> `42.25 MiB` (below `releaseMB = 256`), `workersMaxLaterMB` `1.06 MiB` on both arms (`releases = 0`, `idles = 8`).

---

### K24 (2026-11-09): the depth map's guided filter in Rust, grey and `disparityRange` in the worker job (the Antigravity G chain)

By a Gemini agent in Antigravity (`.claude/coord/chain-g/`) on `3fd8bda7` (`ca994c05`, pre-review fixes in `03664a0f`, review fixes in `e965bcf2`, merged with `wasm-kernels` `e39b8d03` in `c09903f6`), ABI 40; `docs/measurements/k24_2026-11-09/` (`k24_chain.sh`, `summarize.py`, `summary.txt`, `chain.log`, `before/`, `after/`, `mutation/`).
- **Built (ABI 40):** `crates/px/src/guided.rs` `guided_far` and `guided_far_scratch_bytes` on the generic box pass `maskf::box_pass::<1>` with `Norm::Div((2 * r_work + 1) as f64)`: normalises and inverts `raw` (`rw * rh` `f32`) by `[lo, hi]` with the flat-range guard `hi - lo > 1e-12`; when `(rw, rh) != (gw, gh)`, bilinearly resizes `far_f32` to `gw * gh` with pixel-centre coordinates `(x + 0.5) * ratio - 0.5`, clamped edges, `wx` stored as `f32` and promoted back to `f64` while `fy` stays `f64` (`inpaint_depth.js` `bilinearResize`); forms `I = ((grey[i] as f64) * (1.0 / 255.0)) as f32` and `Ip`, `II` from the raw `I` and `p` before any in-place box pass; runs the 6 single-channel box passes (`mean_i`, `mean_p`, `mean_ip`, `mean_ii`, `mean_a`, `mean_b`), computes `av = cov_ip / (var_i + eps)` in `f64`, stores `a[i] = av as f32`, computes `b[i] = (mean_p - av * mean_i) as f32` from the unrounded `f64` `av`, clamps `mean_a * I + mean_b` to `0.0..=1.0` as `f32`, and quantises `Math.round(q[i] * 65535.0)` into `out` (`gw * gh` `u16`). Wrapped in `px.js` `Px.prototype.guidedFar` (with `disparityRange(raw)` on the whole array when `lo`/`hi` are omitted, matching the twin), twin in `kernels_js.js` (`guidedFar` delegating to `inpaint_depth.js` `guidedFar` with `boxBlurs`), route `guidedFar` in `kernels.js` (`ROUTE_KINDS`, trap/OOM recovery, `releaseIfLarge`). In `inpaint_worker.js` `depthGuide` and `inpaint_canvas.js` `computeDepthMap` / `depthFromLayer`: the grey conversion (`Math.round(bytes[i] * 0.299 + bytes[i + 1] * 0.587 + bytes[i + 2] * 0.114)`) and `disparityRange(raw, 0.005, 0.995)` moved into `depthGuide` in the worker, with `guide.image.buffer` (`gd`) transferred in and back (`poolRes.gd`) so `makeMap` keeps the same `map.guide` `Uint8ClampedArray` without cloning. `inpaint_depth.js`, relight's `detailRatio` and haze's guided filter stay untouched.
- **Tests:** `px_test.js` group `guided` (63 deterministic twin cases on both builds and at odd byte offsets, including omitted `lo`/`hi` with `raw` longer than `rw * rh`, options-object & positional callers with optional `out`, dirty wasm arena filled with `0xDE`, 17 wrapper refusals, raw export refusals, `K.guidedFar` route check, 4096 x 2731 `PX_BENCH` rows) and `retouchRoute` (`guidedFar` trap & OOM recovery); `edges_test.py` replays both `computeDepthMap` (`ed7`) and `depth_from_layer` (`ed11`) on route `guidedFar = "js"` against `"rust"`, compares `map.guide` on both against an independent `host.depthInput` / `host.pictureInput` read, and in `ed7` also compares `map.data` and `lo`/`hi` against the `inpaint_depth.js` `guidedFar` + `disparityRange` reference (`0` bytes differ); `px_jobs.py` row `depth_guide_model` (`computeDepthMap` with stand-in `host.helperCall("depth")`) alongside `depth_guide`, `--check` digesting both `map.data` and `map.guide` in `"same bytes"`. Gates `lint types maps edges limit selection pixels` on both backends and `pxjobs nodecopy` on tiles PASS; `depth_test.js` and `edges_test.js` PASS. Mutation round (`mutation/mut_k24.py`, `mutation/results.txt`): 28 of 28 killed (0 on re-check, 0 survived).
- **Before -> after** (medians of three alternating fresh runs at 15000 x 10000, port 9635, `w1_lock.py` held per batch): `depth_guide` (`depthFromLayer`) on Rust 1,241 -> 995 ms wall (`1.25x`), worker job 554 -> 334 ms (`1.66x`, `guided_far` split 255 ms); `depth_guide_model` (`computeDepthMap`, `784 x 520 -> 15000 x 10000`) on Rust 1,093 -> 942 ms wall (`1.16x`), worker job 393 -> 265 ms (`1.48x`, `guided_far` split 218 ms). On the fresh-instance `kernels=js:rust` runs (`after/pxjobs_r1..3.jsonl`), `depth_guide` is 1,109 -> 995 ms wall (worker job 496 -> 334 ms, `verdict: rust` beyond the spread 104 ms) and `depth_guide_model` is 1,275 -> 942 ms wall (worker job 626 -> 265 ms, `verdict: rust` beyond the spread 59 ms); on `--ab guidedFar=js:rust` (`--rounds 3`, run after the plain 15k row on the same Electron instance per round), `depth_guide` is 1,405 -> 891 ms wall (worker job 763 -> 273 ms, with an unexplained slower JS arm of 726-820 ms in 8 of 9 A/B rounds vs 492-510 ms on the fresh `kernels=js` instances) and `depth_guide_model` is 1,282 -> 960 ms wall (worker job 573 -> 277 ms), both `verdict: rust`. At 2048 x 1152 `--check`, `map.data` (`015bad08388b30d1`, `177c8b5d93ce9193`) and `map.guide` (`0f0abb14e298ba62`) match bit for bit across `js`, `rust`, `before` (`3fd8bda7`) and `after` (`K24`). No route entry.
```

### K25 (2026-11-09): the fill layer's depth limit in Rust, and the export's snap follows the screen (the Antigravity M chain)

By a Gemini agent in Antigravity (`.claude/coord/chain-m/`) on `3fd8bda7` (`ebdb4808`, review fixes `526cbb7a`, with K23's re-check fixes `a7444925`), ABI renumbered 37 -> 39 at the merge; `docs/measurements/k25_2026-11-09/`. `limit_alpha_rows` (`crates/px/src/range.rs`): the plain bilinear path two pixels per iteration in SIMD128, the snapped path per pixel; `px.js` `limitAlphaRows` chunks a band into at most 256 rows with only the map's and guide's row window copied, and tags a failure with `doneRows`, so `kernels.js` resumes on the rows not done and never multiplies a finished row's alpha twice. No route entry: Rust won `limitAlphaRows=js:rust` on `fill_limit` (6,213 vs 10,880 ms, beyond the spread). **15k, three alternating rounds:** `fill_limit` wall 11,829 -> 6,036 ms, `export_test` `fill_limit_rows` 11,178 -> 6,209 ms, a PSD with such a layer 16,665 -> 9,919 ms. All three walls are the snapped path; the plain path is measured at the kernel row only (15,000 x 256: twin 100.2, SIMD 86.0, scalar 88.1 ms).
**Behaviour (question 6.2):** with edge snap, the reference colour comes from `map.guide` instead of the fill's own colour. **The limit found by the review:** exact against the screen only up to 4096 px on the long side; above it a hard colour edge can differ within one map texel (`docs/BUGS.md`). A finite but absurd transform that overflows goes to the JS loop, so a stored limit never throws on an export.
Review: three lenses, each finding verified; no must, three should (a recovery test that mocked the tag it claimed to test; two edge fixtures that could only give 0; a PSD check silently skipped on canvas), nice ones, all fixed in `526cbb7a` and read by the main loop. Open for the user (`.claude/coord/chain-m/status.md`): whether the export should ever interpolate the guide above 4096 px.

### K16 (2026-11-09): tiff_unpack for none, LZW and PackBits, and the live decoders stop at need (the Antigravity T chain)

- **Kernel & JS twin (`crates/px/src/tiff.rs`, `crates/px/src/lib.rs`, `renderer/editor/inpaint_tiff.js`, `renderer/editor/px/px.js`, `renderer/editor/px/kernels_js.js`, `renderer/editor/px/kernels.js`):** Added `tiff_unpack(compression, src, len, out, need) -> isize` (ABI 38 at the merge) and its JS twin `unpackStrip(compression, src, need, out, name)` (exported on `TIFF_JS` and re-exported by `kernels_js.js` and `kernels.js`, with `Px.prototype.tiffUnpack` and trap recovery in `kernels.js`) for uncompressed (`1`), LZW (`5`, 9..12-bit MSB-first codes with 24 KB tables on the wasm stack: `prefix: [u16; 4096]`, `suffix: [u8; 4096]`, `first: [u8; 4096]`, `len: [u16; 4096]`), and PackBits (`32773`). Per the Stop 2 decision, deflate (`8`, `32946`) stays on native `DecompressionStream`. Both `Px.tiffUnpack` and `unpackStrip` require `ArrayBuffer.isView(src)` (and `ArrayBuffer.isView(out)` when given) and return negative error codes (`-1` bad args/compression, `-2` truncated before `need`, `-3` old-style LZW, `-4` LZW code before first literal after clear, `-5` LZW code beyond table).
- **Live decoders (`renderer/editor/inpaint_tiff.js`):** Passed `this.need` from `StripRows.open` and `want` from `TileRows.tile` into `unpacked(..., need)` and into `lzwDecoder(need)` and `packBitsDecoder(need)` so decoding stops as soon as the strip's or tile's needed bytes have been produced. Fixed `lzwDecoder`'s 1-byte first-piece check (`head < 0` vs `head >= 0`) so a stream whose first piece is `[b]` followed by `[b, ...]` keeps the first byte and tests the second byte for old-style LZW instead of dropping the first byte and testing the third.
- **Behaviour change:** An LZW strip or tile with a damaged code past `need`, inside the blob piece that completes `need`, was refused and now opens (later pieces were already ignored because `StripRows` and `TileRows` closed at `need`; PackBits had no refusal path). An LZW strip or tile split after byte 1 with `byte[0] === byte[1]` no longer drops `byte[0]` or misfires the old-style LZW check on `byte[2]`.
- **Builds & kernel timings (`docs/measurements/k16_2026-11-09/`):** `px.wasm` 262,027 B (`93cc852f2a93c288`), `px_scalar.wasm` 213,278 B (`ee5912ffc000892e`). On a 1 MB strip in `px_test.js` (`PX_BENCH=1`, median of 15): LZW twin 4.95 ms, SIMD 1.60 ms (3.09x), scalar 1.74 ms (2.84x); PackBits twin 1.40 ms, SIMD 0.32 ms (4.38x), scalar 0.27 ms (5.19x). K16 is kernel tier (no app call site until K17's `readTiffBand`).
- **Verification:** 21 byte-exact `twinCheck` cases at even and odd offsets (including frozen hand-derived mid-code and mid-run stops), caller `out` view and 3-arg `Uint8Array` overload checks on `twin`/`simd`/`scalar`, 240-trial random + 9..12-bit and full-4096-table bit-flipped fuzz + an every-prefix sweep with 0 traps, 328 LZW and 47 PackBits piece-break schedules in `tiff_test.js` (80/80 checks), 28/28 mutants killed in `docs/measurements/k16_2026-11-09/mutation/results.txt` (23 by `px_test (only: tiff)`, 5 by `the tiff gate`), and gates `k16-tiles`, `k16-canvas` (`lint types`), `k16-tiff-tiles`, `k16-tiff-canvas` (`tiff`), and `k16-nodecopy` (`nodecopy`) all PASS.
- **Merge:** `ca509144`, ABI renumbered 37 -> 38 (K7 took 37), both builds rebuilt; gates `mergek16` (`lint types pixels export nodecopy`) and `mergek16-tiff-on` / `-off` PASS, `px_test` green under Node and Electron. Review: three lenses, each verified; no must, two should (a frozen reference for a stop inside a code or a run, the piece boundaries of the live decoders) and the rest fixed in `3b907c17`, re-checked.

### K7 (2026-11-09): the PNG part kernels, over the lines the native inflate delivered (the Antigravity P chain)

By a Gemini agent in Antigravity (`.claude/coord/chain-p/`) on `3fd8bda7` (`25db1d5d`, review fixes `a32f3d90`), merged as `8a176c76`, ABI 37; `docs/measurements/k7_2026-11-09/`. Stop 2's answer took the inflate out: `png_part_lines_cap(w)`, `png_part_decode(lines, len, w, prev, rt, out, info)` and `png_part_finish(lines, rows, w, prev, rt, out, info)` keep the whole-line check (-4), the filter check (-5), the Adler, K6's unfilter, RGBA and the round trip in wasm memory; a part whose first filter needs the row above answers `needs_prev` and is finished later. No app routing: K8 calls them. A part of a 15k layer costs 10.7 to 13.4 ms against 36 to 103 ms for the twin; the copy into wasm is about 0.45 ms of that per part, twice for a `needs_prev` part, the likely case for Scumble's own files (K6's census: 99 % Paeth or Average).
**§4.2 corrected by the review:** "parts never cross a tile row" holds only for align 256. On band sources (`programRows`, `bandPlan`) `partRows(width, align)` makes parts of up to 2,048 rows, so the cap is `(PART_BYTES / row_bytes).clamp(1, 2048)`. K8 bounds a part by the IHDR as well, and its gate file needs a band-source PNG with parts above 256 rows, and shared-window, corrupt and truncated parts in an Electron worker (Node's `DecompressionStream` is zlib, not the one K8 ships on).
Review: four lenses, each finding verified; no must, three should (the cap; two tests that could not fail) fixed in `a32f3d90`, re-checked; four nice left for K8's first commit. Gates `mergek7` PASS on both backends, `editor` on tiles once after a load timeout and the known flake `helper_inputs_read_levels_and_upload_nothing` (`mergek7-ed1`). Under Electron `px_test`'s `mask_max_clamp` compared a NaN's bits, which V8's tiers do not keep: `NAN_BITS` in `tools/px_test.js` (K32's test, not K7).

### K22 and K23 (2026-11-08, merged 2026-11-09): select by depth, brightness and colour on the tiles in Rust (the Antigravity M chain)

By a Gemini agent in Antigravity (`.claude/coord/chain-m/`) on `548c7f4e` (`13d32fa8` K22, `2a99ac6a` K23), merged as `5e418358` with the ABI renumbered 31, 32 -> 35, 36 and both builds rebuilt; `docs/measurements/k22_2026-11-08/`, `k23_2026-11-08/`. K22: `range.rs` `range_tiles_depth` (f64x2 and scalar), routes `rangeDepth` / `rangeDepthSnap`, `rangeSelectJob` hands the "compute" tiles to it. K23: `range_tiles_rgba`, routes `rangeLuma` / `rangeColor`, early exits in `sstep_f64x2`. At 15k on Rust, three alternating rounds: depth 223 -> 172 ms wall, with snap 1,449 -> 1,143 (worker job 3,130 -> 1,708), luma 1,637 -> 1,224, colour 3,138 -> 1,786. Rust won every route A/B, so no route entry. Those rounds ran with the GPU busy (the user's training).
**The exponential, option A.** The twin in `kernels_js.js` uses `libmExp`, a port of libm's `exp`, so the twin and both wasm builds agree bit for bit under Node's and Electron's V8; Electron's `Math.exp` differs from libm by one ulp on about 6.6 % of arguments. Against the last release: on a feathered limit a pixel at a rounding near-tie can move by one level of 255; on a hard edge (feather 0) a pixel within one ulp of `lo - 1e-12` can flip fully, which needs a `lo` constructed to about 16 digits (a slider cannot reach it). The canvas backend and the fallback after the worker pool has turned itself off keep `Math.exp` (`snapField` is shared with relight, lens blur and the depth effects); a whole selection goes one way or the other.
**The review at the merge** (a workflow of four lenses, each finding verified by a second agent; the merged tree included): 8 findings, no must. The one should: K23's strict `normalizeLimit` also ran on the draw path, so a colour an agent had stored without the # up to 0.1.52 would have switched the filter off without a word. Fixed at the merge (`c17c6367`): `normalizeStoredLimit` on the draw, export and panel paths keeps 0.1.52's reading; the refusal stays on new input (`select_range`, `add_filter`, `set_filter`, `selectRange`). `limit` gate case 13, killed by the mutant that makes the draw path strict again. Gates `mergek2223` and `mergelim` PASS on both backends. Left for the M chain: the `bX0` side of the job's bounds union (a mutant survives) and the record of K23's refusal runs. Found on the way: `docs/BUGS.md` "The Limit row's range bar keeps an old colour".

### K6 and K3 (2026-11-08): SIMD unfilter, slice-by-16 CRC, the ORA entry CRC from the parts (the Antigravity P chain)

By a Gemini agent in Antigravity (`.claude/coord/chain-p/`) on `5419c95a` (`ad148e2e` K6, `44495d21` K3), merged `dceec4d2` with the ABI renumbered 32 -> 34 and both builds rebuilt;
`docs/measurements/k6_2026-11-08/`, `k3_2026-11-08/`. K6: simd128 Up, Average and Paeth in `png.rs` `png_unfilter_rows`. K3: `png.rs` `crc32` (slice-by-16, no dependency), `chunk_frame`, routes `crc32` (64 B and up), `pngPart` framing its IDAT in place, `crc32Combine` (zlib's GF(2) method) in `inpaint_png.js`, `PngStreamWriter.finish` folding the parts' CRCs so the ORA entry CRC needs no worker re-read. Review (two lenses, verified): no byte or CRC difference. K2 (`inflate_z`) is NOT in this merge: **Stop 2** measured native `DecompressionStream` faster or tied everywhere (a whole 15k PNG 1.46 s against 2.70 s, 8 workers 527 against 623 ms, 10,000 one-row strips a tie); the agent's K2 stays on `ag-chain-p`, pending the user's word.
At 15k: the unfilter 1,102 -> 502 ms; the open's whole wall ties (spreads overlap, one round in three lost), so K6 stays by §1.1 rule 2 on the kernel row. A 15k ORA export 1.43x beyond the spread; a PNG export's wall is inside its spread (the chunk step saves about 100 ms of wall, inferred), so K3 stays by the same rule. Those rounds ran with the GPU at 100 % (the user's training).

### K36 (2026-11-08): a stroke's commit on the tiles in Rust (the Antigravity F chain)

By the same chain as K9 on `5419c95a` (`bef18ff5`, the review's points in `df3b750c`, K9's two points in `21accab7`), merged `49e48575` with the ABI renumbered 32 -> 33 and both
builds rebuilt; `docs/measurements/k36_2026-11-08/`. `crates/px/src/composite.rs` `masked_tile` (`composite_masked_tile`: per 256-pixel chunk the active span where src alpha and mask are
above 0, premultiply, composite and unpremultiply there, inactive pixels restored byte for byte; outcome unchanged / written / empty / refused), twin in `kernels_js.js`,
route `compositeMaskedTile`, `compositeStroke` in `inpaint_tiles.js` on it. The review's byte lens found no difference. At 15k: `compositeStroke` over 24 frozen tiles, paint 9.60 -> 5.03 ms, clipped 10.50 -> 6.01, erase
9.46 -> 6.10; the whole-operation row `stroke_and_release` (3 tiles) **ties** (wall 372 -> 419, spreads overlap), so Rust stays by §1.1 rule 2 on the strictly faster kernel row. All-byte hashes
of the 24 tiles are equal across the base, rust and js (an earlier hash sampled only pixels the stroke never paints).

### K31 (2026-11-08): liquify's dab in Rust, the swirl on the JS twin (the Antigravity B chain)

By the same chain as K28-K30 on `2068af87` (`60e85e4b`, the review's findings fixed in `d243e947`), merged `d711f8f2` with the ABI renumbered 31 -> 32 and
both builds rebuilt; `docs/measurements/k31_2026-11-08/`. `crates/px/src/resample.rs` `liquify_dab` (simd128 and scalar), `Px.liquifyDab` gathering the
nodes directly into wasm memory (all arena blocks taken before the view) and scattering from a wasm view, route `liquifyDab`. Push, grow, shrink and restore matched the
twin on every test, near ties included. **The swirl modes stay on the twin:** the wasm's libm `cos` / `sin` differ from V8's by 1 ulp on the swirl's domain (sin on 9,424 of 5 M angles and cos on 783
under Electron's V8 15.2, cos on 1,658 under Node's V8 13.6), and on a constructed input it reaches a node (dy 2424 against 2423), so §4.9's rule applies. The agent's first "10 M nodes, 0 differences" could not see it (Int32
rounding hides a last bit unless it crosses a boundary). At 15k against the K30 twin: `push fit size 1000` dab 8.1 -> 5.2 ms a move (kernel lap 7.35 -> 4.57), `push 1:1 size 1000` 2.1 -> 1.5, `shrink held` tick 1.9 -> 1.3, restore on a pushed area 1.3 -> 0.9. `push 1:1 size 1000` blockedMax 67.8 -> 94.4 ms beyond the spread, land a tie, the cause inferred.

### K9 (2026-11-08): the wand's alpha tiles and the grow / shrink cut by cell (the Antigravity F chain)

By a Gemini agent in Antigravity (`.claude/coord/chain-f/`) on `0117ba14` (`07963ae8`), merged `5c95eb98`, ABI 31 (the next free
number); `docs/measurements/k9_2026-11-08/`. `crates/px/src/jobs.rs` `flood_shape` with `out_kind` (1 alpha byte or 4 RGBA) and `cells`,
`grow_mask` recording per 256^2 cell empty / changed / unchanged and clearing only the margins; `inpaint_worker.js` `floodOverTiles` cuts only occupied
cells into 64 KB alpha tiles for `selCombine` (kind 1), `selectionOverTiles` skips unchanged cells. The review's byte lens found no
difference. Two small points went with K36: the JS route fills `cells` it then discards (about +45 ms on its write lap, the fallback only), and px_test no
longer reaches the no-cells branch. At 15k: the wand over the whole picture 999 -> 828 ms, grow 612 -> 511 (its cut 98 -> 9.5), shrink 16 px 479 -> 347.

### K30 (2026-11-08): liquify's dab on dense arrays (the Antigravity B chain), Stop 6's numbers

By the same chain on `1979e8d` (`647f758`, the review's findings fixed in `59636b1`), merged `e2aa0ec`, no Rust and no ABI
change; `docs/measurements/k30_2026-11-08/`. `inpaint_liquify.js` `liquifyDabNodes` (dense node arrays), `thawPlane`,
`LiquifyField.dab(..., kernel)` with `_writeDense` and a reused `_dabSrc` (`nodes(..., out)`), the default through
`InpaintEditor.liquifyDabKernel`; a restore that meets no cell returns null before the gather (as the Map path's
`!count`). The review's parity lens found nothing against the Map-based dab. Its findings were about the numbers and two
tests: the report left out the rows where the dense arm lost (`push 1:1 size 1000` land 34 -> 81 ms, blockedMax 16 -> 67):
a landing split and the rows in swapped order show one deferred V8 major GC after the 15k document's setup that the Map
path's allocations (about 160 MB in a stroke) used to trigger one row earlier; in swapped order both arms hit it equally
(75.8 against 72.8 ms), so it moved and did not grow. At 15k: `push fit size 1000` dab 13.7 -> 6.7 ms, its land 77 -> 45, `push 1:1
size 1000` dab 3.4 -> 1.8, `shrink held` tick 2.8 -> 1.7. Mutation 29 of 29 killed.
**Stop 6:** `dabLaps` in Electron: the kernel is 93-95 % of an advected 1000 px dab (1.64 of 1.8 ms; 6.23 of 6.7 ms across the
four sub-dabs of a move at fit), the gather and the write 0.08-0.15 ms per sub-dab, and `nodes()` can fill wasm memory
directly (as K29's window), so K31 needs no 1 MB of extra copies; a 2-3x kernel would save about 0.8-1.1 ms per sub-dab (inferred
from K28 / K29's 1.5-1.9x and SIMD). **The user's word (2026-11-08): build K31**, the route decided by its A/B.

### K34 (2026-11-08): the edge fit's shrink and warps in Rust (the Antigravity E chain)

By the same chain as K32 and K33 on `da4ba5e` (`e9aa179`, the review's findings fixed in `c16aa38`), merged `8928d7d` with the
ABI renumbered 27 -> 30 and both builds rebuilt; `docs/measurements/k34_2026-11-08/`. `crates/px/src/maskf.rs`
`edgefit_shrink` (the gray's unrounded double alpha, `a` stored as f32, the band sums in f64), `warp_rgba` (bilinear,
`Uint8ClampedArray`'s ties to even), `warp_coverage`; twins in `kernels_js.js`, routes `edgefit` (the group),
`edgefitShrink`, `warpRgba`, `warpCoverage`; `edgefit.js` delegates. Two review rounds. The first fuzzed against the base:
every realistic matrix bit for bit, but a FINITE matrix overflowing to +inf + -inf = NaN made the simd128 lanes differ from
the scalar build (unreachable: `fitEdges` refuses such a matrix; both lanes now take the scalar path unless the sum of
the absolutes is finite). The route: `warpRgba` first lost three rows, so the agent vectorized the lane's coordinates;
alone against the twin through the route map it now wins every row (`stitch_align_2048` worker warp 86.5 -> 63.4 ms,
4096 304 -> 240 ms, `edgefit_2048` 82 -> 63). The second round read the rewritten lane and fuzzed it: nothing. Mutation
killed; trap rows added. Whole operation: `stitch_align_2048` worker 752 -> 610 ms, 4096 2,471 -> 2,104 ms, a warmed 15k
provider crop 514 -> 420 ms.
**K35** (`edgefit_levels`, conditional): the split shows `fitEdges` at 6-41 ms, 1.1-6.8 % of a stitch's wall and below its
run-to-run spread, but 58 % of a standalone `fitLayerRGBA` (about 31 of 54 ms, *Match edges*). **The user's word (2026-11-08): it stays JS, measured**, on the
list for a someday update (CLAUDE.md item 70). The E chain ends with K34.

### K11 (2026-11-08): selection invert in Rust, the frozen tile's copy deferred (the Antigravity M chain)

By the same chain on `dfe2f35` (`38284f4`), merged `29695d4`, ABI 29 (the next free number);
`docs/measurements/k11_2026-11-08/`. `crates/px/src/sel.rs` `mask_invert` (the `bw x bh` corner of a tile, the extent over
the whole tile, 0 when the tile inverts to empty), twin in `kernels_js.js`, route `maskInvert`; the big-endian branch
stays JS. `inpaint_tiles.js` `writable(tx, ty, create, whole)`: a write that replaces the whole tile skips the copy of a
frozen tile and the zeroing of a reused slot (`allocTileBytes(owner, zero)`), `invert` and `combine` pass it (only for a
full 256 x 256 corner); a tile that inverts to empty is dropped with no `writable` on the Rust route. The review (two
lenses, verified) ran 6,750 tiles through simd, scalar and the twin against literal copies of the base loops, and a store
differential against the extracted `dfe2f35` tree (444 inverts, 396 combines, with and without the arena and reused
dirty slots, frozen clones hashed): no difference. Its one finding, a test gap: nothing pins the `whole` guard on edge
tiles (a mutant passes, because Node runs without the arena); added by the chain with K22. At 15k invert 228 -> 128 ms,
px_jobs' invert 201 -> 100 ms.

### K21 (2026-11-08): the limit's map tile stats in Rust, a tile class per tile (the Antigravity M chain)

By a Gemini agent in Antigravity (`.claude/coord/chain-m/`) on `29f6749` (`308ca8a`, two review rounds' findings fixed in
`8d131f9` and `392bada`), merged `376f254` with the ABI renumbered 23 -> 28 and both builds rebuilt;
`docs/measurements/k21_2026-11-08/`. `crates/px/src/range.rs` `map_tile_stats` (min, max and the edge flag per document
tile, SIMD and scalar; the wrapper copies only the map rows of one tile row), twin in `kernels_js.js`, route
`mapTileStats`; `inpaint_weights.js` `rangeTileClass` (0 empty, 1 full, 2 compute) and `rangeRowBookkeeping`;
`edgeTiles` delegates to it; `selectRange` books full tiles without a job, skips rows with no compute tile and cuts the
picture read to the compute tiles inside the old span; `rangeSelectJob` works only the compute tiles.
The first review found two changes of selected pixels (both reproduced on the branch's modules): the edge flag's window
clamped on both sides, so a tile beyond the map after an Extend or a Straighten read the border and was flagged (now
the flag needs the unclamped window to meet the map, so the old flags come back exactly), and a span bounded by flagged
compute tiles, which put a compute tile of the old span on the bilinear path where snapField's k need not be 0 (range
exactly 1311 against thresh 1310.7; now the span's ends come from the old flags over all tiles). `edges_test.js` holds a frozen copy of
the base's one-sided `edgeTiles`. The second review confirmed both fixes and found the picture read's leftovers: the
scratch canvas is reused without a clear (the base too), so under alpha < 255 the row above shows through and the cut
box changes when it gets cleared. **The user's word (2026-11-08): clear it**, `clearRect` before the draw on both paths:
bytes change against the base on see-through composites only (edge snap, feathered limit), opaque ones stay byte for
byte (tested). A measurement showed the smaller box does not change `sampleRegionSettled`'s bytes under a half-transparent layer
(`sample_region_box_size.json`, 256 x 256 against 1024 wide, both backends: 0 differing). The js replay in the test ran on the
cached Rust stats (fixed: fresh map data, 0 `map_tile_stats` calls asserted). Mutation 20 of 21 killed, 1 equivalent.
At 15k (three alternating rounds; measured before the review's span fix, so the snap row's span may be a little
larger now): select by depth 602 -> 268 ms, its pool work 4,309 -> 1,719 ms; with edge snap 2,333 -> 1,302 ms.

### K29 (2026-11-08): liquify's preview in Rust, its window in wasm memory (the Antigravity B chain)

By the same chain as K28 on `21b53a3` (`f38f26e`, the review's findings fixed in `32c4f12`), merged with the ABI
renumbered 26 -> 27 and both builds rebuilt; `docs/measurements/k29_2026-11-08/`. `crates/px/src/resample.rs`
`liquify_preview`, route `liquifyPreview`; `kernels.js` `allocLiquifyWindow` / `freeLiquifyWindow` / `liquifyPreview`
(the stroke's source window lives in `px.alloc` memory of one instance, `win.px`, no per-frame copy; the preview runs
on `win.px`, never `rustPx()`), `previewBlock` refreshing `win.data` after a `memory.grow`, `inpaint_canvas.js` the
window freed on every way a stroke ends (pointer up, Escape, tool switch, tab close, an error). Two review rounds (the
second a pre-check of the uncommitted fixes). The kernel matched `previewBlock` byte for byte; the findings were about
its window: the fill held a wasm view across `_levelBytes`, whose `mipChain` / `clampExtend` can grow the same instance
(a fresh one after the idle trim, a window over unchained or edge tiles): a detached view threw in the draw, a blank
frame and the stroke shown unliquified until redrawn; now a fresh `view()` after each call that can allocate. The
"freed" checks read only JS fields (a dropped `p.free` passed): now the next alloc must return the same pointer. The
new Escape cancel left a freeze stroke's painted cells: `freezeBefore` restores them. The detach test's L = 0 case
compared transparent pixels only (taken at the merge: it samples the edge tile's band and asserts non-zero alpha).
Mutation 28 + the new ones killed. At 15k a 1000 px push at 1:1: the window 52.0 -> 34.9 ms, a preview p50 15.9 -> 10.1 ms,
worst 69.5 -> 44.7; 200 px p50 2.9 -> 1.5 ms; mid-stroke after the idle trim 17.5 -> 9.1 ms.

### K33 (2026-11-08): stitch's colour match and alpha writes in Rust (the Antigravity E chain)

By the same chain on `cb9479d` (`dafad55`, the review's one finding fixed in `7883021`), merged `c10d6d3`, ABI 26 (no
renumbering: it was the next free number); `docs/measurements/k33_2026-11-08/`. `crates/px/src/maskf.rs`
`color_match_rgba` (the clamped total in f64 with the `< 64` guard, the weighted means and variances in f64, paired in
`f64x2` lanes with each sum kept sequential, the variance floor `1e-6 * 255^2`, the scale clamp 0.5..2, ties to even as
the old Uint8ClampedArray write) and `blend_alpha` (RGB copied, alpha `round(clamp01(m) * 255)` or `* src alpha` with
`keep_alpha`); twins in `kernels_js.js`, routes `colorMatch` / `blendAlpha` (both rust); `stitch.js` `colorMatch`,
`alignCopy`, `finalAlpha` wired. The review (two lenses, verified) read the scalar and simd128 paths against the old
loops and fuzzed them (13,680 runs, NaN, +-Inf, signed zeros, subnormals, .5 ties, tails, in place): 0 bytes differed.
Its one finding: the `< 64` guard had moved behind the two full-crop readbacks and the wasm copies (Select all + an
edit model: about 1.2 GB read and 1.8 GB of wasm at 15k for a no-op); put back ahead of them, with a stitch_test case
that counts no `color_match_rgba` call. Mutation 19 / 19 killed. At 2048 the worker's colour match 126 -> 50 ms, the
worker's stitch 768 -> 666 ms; at 4096 2,679 -> 2,302 ms; a warmed 15k provider crop's finish 417 -> 367 ms.

The order from here (2026-11-08): the M chain (K21, K11, K22, K23, K25) and the E chain (K32, K33, K34, K35 on its
split) by Antigravity agents, the liquify part of the B chain (K28, K29, K30, *Stop 6*, K31) likewise once K27 is
merged (`.claude/coord/`, each branch reviewed and merged by the Claude main loop, the ABI renumbered at merge); then
as after Stop 5: K9, K36, K37; K2, *Stop 2*, K6, K7, K8, *Stop 4*; K13, K14, the threads spike; K24, K3, K10a-c,
K15-K18, K20a-c, K19, K38, K39, K40, K41. U2 (`docs/PLAN_HELPERS_PROCESS.md` §4: warm on the tool pick, the 15k shapes)
after the weekly reset.
