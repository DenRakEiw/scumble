# K10 Plan: Compose in Wasm Memory (`K10a` / `K10b` / `K10c`)

## Overview

When `inpaint_worker.js` serves `png_part`, `psd_part`, `stack_into`, or `tiff_part`, it currently allocates row-band `Uint8Array` buffers in the JS heap (`rowsOfTiles`, `rowsOfStack`, `storeRows`, `clipCoverage`), copies each layer's tiles and masks into JS `Uint8Array`s, and then calls `Px.compositeTile`, `Px.pngPart`, or `Px.psdPackRows`, which re-copy those buffers into `WebAssembly.Memory` (`p.job`) and copy results back out.

**K10** moves the row-band gather, layer preprocessing (`match_pixels`, `clip_coverage`, `dissolve_rows`), compositing (`composite_tile`), and part encoding (`pngPart`, `psdPackRows`, and in K15 `tiffStrip`) into a single `PxArena` scope (`p.job`) in wasm linear memory:

- **K10a**: This design document (`docs/PLAN_WASM_K10.md`). Light tier, no code changes.
- **K10b**: Pointer-based tile gather (`rowsOfTiles`) and stack gather/composite (`rowsOfStack` including in-place `match_pixels`) in wasm memory; pointer-based `pngPart` (`png_filter_rows` + `adler32` + `deflate_part` + `png_chunk_frame`); store (`uploadPixels`, `encodeTilePixels`, `tileRows`) and PNG export on the pointer path; reusable `partPtrOf` entry point for K15's `tiffStrip`.
- **K10c**: Rust `clip_coverage` and `dissolve_rows` kernels; pointer-based `psdPart` (`psd_pack_rows` across channels `0..3` from the same `pr` buffer in `p.job`); pointer-based `stackInto` (serving `fillBoxFromStack` for wand / bucket / range / provider crop and filter bands `programStart` / `programFinish`).

---

## 1. Anchors Re-read at Base `3fd8bda7`

### Rust (`crates/px/src/`)
- **`crates/px/src/lib.rs`**:
  - `align_for(align: usize) -> usize`: `:43-45`
  - `px_abi_version() -> u32`: `:55` (currently `36`)
  - `px_alloc(size: usize, align: usize) -> *mut u8`: `:68-76`
  - `px_free(ptr: *mut u8, size: usize, align: usize)`: `:80-85`
  - `composite_tile(dst: *mut u8, px: usize, n: usize, srcs: *const u32, ops: *const u8, alphas: *const u8, masks: *const u32)`: `:611-624`
  - `composite_masked_tile(dst: *mut u8, orig: *const u8, src: *const u8, mask: *const u8, px: usize, op: u8, alpha: u8)`: `:633-650`
  - `match_pixels(rgba: *mut u8, px: usize, params: *const f32)`: `:678-680`
  - `png_filter_rows(rgba: *const u8, w: usize, rows: usize, prev: *const u8, out: *mut u8)`: `:687-690`
  - `deflate_part(src: *const u8, len: usize, level: u8, last: u8, out: *mut u8, cap: usize) -> usize`: `:695-697`
  - `adler32(src: *const u8, len: usize) -> u32`: `:700-702`
  - `crc32(init: u32, src: *const u8, len: usize) -> u32`: `:706-712`
  - `png_chunk_frame(buf: *mut u8, len: usize, tag: u32)`: `:718-723`
  - `psd_pack_rows_cap(w: usize, rows: usize) -> usize`: `:729-731`
  - `psd_pack_rows(rgba: *const u8, w: usize, rows: usize, ch: usize, out: *mut u8, cap: usize, lens: *mut u16) -> usize`: `:736-738`
- **`crates/px/src/composite.rs`**:
  - `begin(dst: &mut [u8])`: `:147-159` (premultiplies RGB of every pixel in `dst` where `0 < a < 255`, clears RGB where `a == 0`)
  - `apply(dst: &mut [u8], src: &[u8], op: u8, alpha: u8, mask: Option<&[u8]>)`: `:161-174`
  - `end(dst: &mut [u8])`: `:499-516` (unpremultiplies RGB of every pixel in `dst` where `0 < a < 255`)
  - `masked_tile(...)`: `:605-687` (K36 stroke kernel: restores `orig` wherever `src` has alpha 0 or `mask` is 0; **not** used by stack compositing)
  - `simd::mul255`: `:732-739`, `simd::premultiply`: `:746-762`, `simd::unpremultiply`: `:764-792`
- **`crates/px/src/cmatch.rs`**:
  - `match_pixels(rgba: &mut [u8], params: &[f32; 21])`: `:16-33`
  - `simd::match_pixels`: `:49-91`
- **`crates/px/src/png.rs`**:
  - `deflate_part`: `:23-32`, `adler32`: `:34-38`, `filter_rows`: `:105-115`, `crc32`: `:537-566`, `chunk_frame`: `:571-577`
- **`crates/px/src/psd.rs`**:
  - `pack_rows`: `:9-59`, `pack_rows_cap`: `:63-65`

### Renderer & Worker (`renderer/editor/`)
- **`renderer/editor/px/px.js`**:
  - `PX_ABI = 36`: `:14`
  - `storedCap(len)`: `:27-35`
  - `Px.job`: `:277-279`, `Px._in`: `:281-289`, `Px._out`: `:291-300`, `Px._reset`: `:309-315`, `Px._call`: `:318-329`
  - `Px.matchPixels(rgba, params)`: `:366-375`
  - `Px.compositeTile(dst, layers)`: `:1010-1030`
  - `Px.pngFilterRows(rgba, w, rows, prev)`: `:1060-1067`
  - `Px.psdPackRows(rgba, w, rows, ch)`: `:1074-1089`
  - `Px.zlib(src, level, raw, laps)`: `:1102-1123`
  - `Px.crc32(buf, init)`: `:1125-1131`, `Px.pngChunkFrame(data, tag)`: `:1133-1141`
  - `Px.pngPart(rgba, w, rows, prev, level, last, laps)`: `:1143-1171`
  - `PxArena`: `:1454-1499` (`take`: `:1464-1491`, `reset`: `:1493-1498`, `ARENA_MAX = 16 * 1024 * 1024`: `:1450`)
- **`renderer/editor/px/kernels.js`**:
  - `ROUTE_KINDS`: `:61-78`, `DEFAULT_ROUTES`: `:80`, `route(name)`: `:108-110`
  - `rustPx(name)`: `:119-135`, `recovered(name, e, fb)`: `:142-151`, `releaseIfLarge()`: `:178-193`, `touched(name)`: `:204-213`
  - `compositeTile`: `:719-727`, `matchPixels`: `:772-780`, `psdPackRows`: `:782-790`, `pngFilterRows`: `:792-800`
- **`renderer/editor/px/kernels_js.js`**:
  - `compositeTile`: `:662-674`, `compositeMaskedTile`: `:902-977`, `matchPixels`: `:987-1005`, `pngFilterRows`: `:1015-1052`, `psdPackRows`: `:1086-1100`
- **`renderer/editor/inpaint_worker.js`**:
  - `tileBytes(t)`: `:86-91`
  - `rowsOfTiles(from, out, baseOff)`: `:205-222`
  - `storeRows(tiles, w, rows, r0, tileSize, ch, out, baseOff)`: `:230-254`
  - `rowsOfStack(stack, above, into)`: `:269-323`
  - `stackInto(msg)`: `:330-337`
  - `gatherStore(store, pts, xs, ys)`: `:344-369`, `stackPoints(msg)`: `:380-436`
  - `partRowsOf(msg, needPrev)`: `:439-442`
  - `pngPart(msg)`: `:448-460`
  - `psdPart(msg)`: `:466-475`
  - `tiffPartJob(msg)`: `:481-491`
- **`renderer/editor/inpaint_raster.js`**:
  - `clipCoverage(baseMask, alpha, own)`: `:266-272`, `mul255`: `:277`
- **`renderer/editor/blend_modes.js`**:
  - `lowbias32(x)`: `:139-146`, `hash32(x, y, s)`: `:155-157`, `seedOfLayer(id)`: `:164-172`, `mul255(a, b)`: `:180-183`
- **`renderer/editor/inpaint_boxstack.js`**:
  - `storeBox`: `:45-65`, `compositeBox`: `:72-124`
- **`renderer/editor/inpaint_bands.js`**:
  - `tileRows`: `:25-45`, `bandRows`: `:51-72`, `stackRows`: `:81-89`, `stackArgs`: `:95-138`, `writePng`: `:168-178`, `writeTiff`: `:184-197`, `packChannels`: `:216-230`, `PsdBandWriter`: `:285-400`, `OraBandWriter`: `:410-463`
- **`renderer/editor/inpaint_encode.js`**:
  - `partsUsable`: `:58-60`, `partsFailed`: `:69-73`, `encodeTilePixels`: `:84-98`, `encodeRows`: `:110-121`
- **`renderer/editor/inpaint_upload.js`**:
  - `uploadPixels`: `:48-57`
- **`renderer/editor/inpaint_tiff.js`**:
  - `tiffPart`: `:663-684`, `TiffStreamWriter`: `:691-784`
- **`renderer/editor/inpaint_canvas.js`**:
  - `programStart`: `:8898-8924`, `programFinish`: `:8926-8987`, `fillBoxFromStack`: `:9197-9230`, `readBoxBytes`: `:9249-9275`, `exportLayerSources`: `:18199-18236`, `exportLayeredBands`: `:18243-18270`

---

## 2. Signatures and the ABI

### K10a (Design Only)
- No code changes; `px_abi_version()` and `PX_ABI` remain `36`.

### K10b (Gather + Composite + PNG Part by Pointer)
All Rust kernels required by K10b (`composite_tile`, `match_pixels`, `png_filter_rows`, `adler32`, `deflate_part`, `png_chunk_frame`) already take raw wasm pointers in `crates/px/src/lib.rs`.
- **Rust ABI**: Bump `px_abi_version()` in `crates/px/src/lib.rs:55` and `PX_ABI` in `renderer/editor/px/px.js:14` by `+1` over K10b's base (`wasm-kernels` at start of K10b; main loop renumbers at merge). Rebuild both SIMD and scalar wasm builds with `python tools/build_px.py` and verify with `python tools/build_px.py --check`.
- **Routing (`renderer/editor/px/kernels.js`)**:
  - Add `composeWasm: "kernel"` to `ROUTE_KINDS` (`kernels.js:61-78`).
  - Export `composeWasmOn()` (or read `route("composeWasm") !== "js"`) from `kernels.js`.
  - **Critical invariant**: `pngPart` in `inpaint_worker.js:449` calls `const p = rustPx(); if (!p) throw new Error("NO_PARTS");`. Do **not** pass `"composeWasm"` to `rustPx()` in `pngPart`! If `rustPx("composeWasm")` returned `null` when `"composeWasm"` was routed to `"js"`, `pngPart` would throw `NO_PARTS` and `partsFailed` (`inpaint_encode.js:69-73`) would set `PARTS_OFF = true` for the rest of the session. Instead, `pngPart` continues to call `const p = rustPx()` (unconditional wasm instance check) and branches on `route("composeWasm") !== "js"` to choose between the pointer path (`partPtrOf` + `p.pngPartFromPtr`) and today's fallback arm (`partRowsOf` + `p.pngPart`).
- **`Px` methods (`renderer/editor/px/px.js`)**:
  - `pngPartFromPtr(a, pr, w, rows, pp, level = 6, last = false, laps = null) -> ArrayBuffer`:
    - Runs inside the caller's `a = this.job` arena scope (does **not** call `this._reset(a)`).
    - Allocates `pf = a.take(rawLen, 1)` where `rawLen = rows * (1 + w * 4)` and `pz = a.take(8 + cap + 4, 1)` where `cap = storedCap(rawLen)`.
    - Calls `this.exports.png_filter_rows(pr, w, rows, pp, pf)`.
    - Computes `adler = this.exports.adler32(pf, rawLen) >>> 0`.
    - Calls `written = this.exports.deflate_part(pf, rawLen, level, last ? 1 : 0, pz + 8, cap) >>> 0`.
    - Calls `this.exports.png_chunk_frame(pz, written, 0x49444154)`.
    - Copies out once via `const idat = this._out(Uint8Array, pz, written + 12).buffer` and returns `{ idat, adler, rawLen }`.
  - `Px.pngPart(rgba, w, rows, prev, level = 6, last = false, laps = null)` (`px.js:1143-1171`) can delegate its body after `_in(rgba)` and `_in(prev)` to `pngPartFromPtr(a, pr, w, rows, pp, level, last, laps)` inside its own `this._call(...)`.
- **Worker gather/composite helpers (`renderer/editor/inpaint_worker.js`)**:
  - `storeRowsToWasm(p, ptr, tiles, w, rows, r0, tileSize, ch, baseOff = 0)`: writes tile rows directly into `p.u8()` at `ptr + baseOff`.
  - `gatherTilesToWasm(p, a, from, needPrev) -> { pr, pp }`: allocates `total = (rows + (hasPrev ? 1 : 0)) * stride` in `a`, zeros it (`p.u8().fill(0, pbuf, pbuf + total)`), and calls `storeRowsToWasm`. If `hasPrev`, returns `{ pr: pbuf + stride, pp: pbuf }`; otherwise `{ pr: pbuf, pp: 0 }`.
  - `gatherStackToWasm(p, a, stack, above, intoBackdrop = null) -> { pr, pp }`: allocates destination `pd` in `a` (`(rows + (useAbove ? 1 : 0)) * stride`), initializes backdrop (`storeRowsToWasm` for `stack.base`, or `p.u8().set(intoBackdrop, pd)` when `intoBackdrop` is provided, else zeroed), prepares each active layer in `a` (running `p.exports.match_pixels(psrc, px, pparams)` in place when `l.match`), populates `psrcs`, `pops`, `palphas`, `pmasks` in `a`, and invokes `p.exports.composite_tile(pd, totalPx, count, psrcs, pops, palphas, pmasks)`. Returns `{ pr: useAbove ? pd + stride : pd, pp: useAbove ? pd : 0 }`.
  - `partPtrOf(p, a, msg, needPrev) -> { pr, pp }`: handles all three sources of `partRowsOf`:
    1. `msg.rgba`: copies `new Uint8Array(msg.rgba)` into `pr = a.take(len, 1)` and `msg.prev ? new Uint8Array(msg.prev) : null` into `pp`.
    2. `msg.stack`: calls `gatherStackToWasm(p, a, msg.stack, needPrev && msg.stack.r0 > 0, null)`.
    3. `msg.fromTiles`: calls `gatherTilesToWasm(p, a, msg.fromTiles, needPrev)`.

### K10c (PSD Pack, `stackInto`, `clip_coverage`, and `dissolve_rows`)
- **Rust ABI (`crates/px/src/lib.rs` & `crates/px/src/composite.rs`)**:
  - Bump `px_abi_version()` in `crates/px/src/lib.rs:55` and `PX_ABI` in `renderer/editor/px/px.js:14` by `+1` over K10c's base.
  - Add two `#[no_mangle] pub unsafe extern "C"` exports in `crates/px/src/lib.rs`:
    ```rust
    #[no_mangle]
    pub unsafe extern "C" fn clip_coverage(
        cov: *mut u8,
        px: usize,
        base_mask: *const u8,
        alpha: u8,
        own: *const u8,
    )

    #[no_mangle]
    pub unsafe extern "C" fn dissolve_rows(
        src: *mut u8,
        w: usize,
        rows: usize,
        x0: i32,
        y0: i32,
        alpha: u8,
        mask: *const u8,
        seed: u32,
    ) -> u8
    ```
  - `clip_coverage` implementation in `crates/px/src/composite.rs`:
    - Given `cov` (`px` bytes, initially filled with `255` or initialized by `clip_coverage`), applies the exact 3-step `mul255` chain of `inpaint_raster.js:266-272`:
      1. Initialize `cov[0..px]` to `255` (or if `base_mask != null`, `cov[i] = mul255(255, base_mask[i]) = base_mask[i]`).
      2. If `alpha < 255`, for each `i in 0..px`: `cov[i] = mul255(cov[i], alpha)`.
      3. If `own != null`, for each `i in 0..px`: `cov[i] = mul255(cov[i], own[i])`.
      - Uses `simd::mul255` on `wasm32` + `simd128` for 16-byte chunks and scalar `mul255` for the tail.
  - `dissolve_rows` implementation in `crates/px/src/composite.rs`:
    - Matches `inpaint_worker.js:294-315` and `blend_modes.js:139-157`:
    - For `r in 0..rows`, `y = (y0 + r as i32) as u32`, row offset `ro = r * w`:
      - For `c in 0..w`, `i = ro + c`, `p = i * 4`:
        - `sa = src[p + 3]`; if `sa == 0` continue.
        - `m = if mask.is_null() { 255 } else { *mask.add(i) }`;
        - `a = mul255(mul255(sa, alpha), m)`;
        - If `a == 0` { `src[p] = 0; src[p + 1] = 0; src[p + 2] = 0; src[p + 3] = 0; continue;` }
        - `h = hash32((x0 + c as i32) as u32, y, seed)`;
        - If `(h & 255) >= a as u32` { `src[p] = 0; src[p + 1] = 0; src[p + 2] = 0; src[p + 3] = 0;` } else { `src[p + 3] = 255;` }
    - Returns `255u8` (the new effective `alpha` for the layer after dissolve, matching `alpha = 255; pm = null;` at `inpaint_worker.js:314`).
- **`Px` and `kernels.js` (`renderer/editor/px/px.js`, `renderer/editor/px/kernels.js`, `renderer/editor/px/kernels_js.js`)**:
  - `Px.clipCoverage(baseMask, alpha, own, px)` and `Px.dissolveRows(src, w, rows, x0, y0, alpha, mask, seed)` on `Px`, with `ROUTE_KINDS` entries `clipCoverage: "kernel"` and `dissolveRows: "kernel"` and JS twins in `kernels_js.js` (delegating to `clipCoverage` in `inpaint_raster.js` and `hash32`/`mul255` in `blend_modes.js`) so `px_test.js` can test SIMD vs scalar vs JS directly.
  - `Px.psdPackRowsFromPtr(a, pr, w, rows, ch) -> { data: Uint8Array, lens: Uint16Array }`:
    - Allocates `pout = a.take(cap, 1)` (`cap = this.exports.psd_pack_rows_cap(w, rows) >>> 0`) and `plens = a.take(rows * 2, 2)` once (reusable across `ch = 0..3`), calls `written = this.exports.psd_pack_rows(pr, w, rows, ch, pout, cap, plens) >>> 0`, and copies out `{ data: this._out(Uint8Array, pout, written), lens: this._out(Uint16Array, plens, rows) }`.
- **Worker `psdPart` and `stackInto` (`renderer/editor/inpaint_worker.js`)**:
  - `psdPart(msg)`: when `route("composeWasm") !== "js"` and `route("psdPackRows") !== "js"` and `rustPx()` is available, runs `partPtrOf(p, a, msg, false)` once in `a = p.job` to produce `pr`, packs all 4 channels (`ch = 0..3`) from `pr` via `p.psdPackRowsFromPtr(a, pr, msg.w, msg.rows, ch)`, and resets `a` in `finally`. Falls back to `partRowsOf` + `psdPackRows` on `"js"` route or trap/OOM (`recovered("composeWasm", e, ...)`).
  - `stackInto(msg)`: when `route("composeWasm") !== "js"` and `route("compositeTile") !== "js"` and `rustPx()` is available, runs `gatherStackToWasm(p, a, msg.stack, false, (!msg.stack.base && !msg.clear) ? into : null)` in `a = p.job`, copies `p.u8().subarray(pr, pr + into.byteLength)` into `into` (`new Uint8Array(msg.sab, msg.byteOffset, msg.w * msg.rows * 4)`), and resets `a` in `finally`. Falls back to `rowsOfStack(msg.stack, false, into)` on `"js"` route or trap/OOM.

---

## 3. Who Owns the Arena and When It Is Freed

1. **Single Owner per Worker Message (`p.job`)**:
   - Each worker thread has its own `Px` instance `p` and `PxArena` `a = p.job` (`px.js:277-279`, `ARENA_MAX = 16 MiB`).
   - Worker jobs (`pngPart`, `psdPart`, `stackInto`, `tiffPartJob`) are synchronous on that worker thread: no two jobs interleave on the same `Px` instance.
   - The **outer job handler** (`pngPart`, `psdPart`, `stackInto`, `tiffPartJob`) owns the `try { ... } finally { p._reset(a); releaseIfLarge(); }` lifecycle.
2. **Inner Steps Never Reset `p.job`**:
   - Inside `gatherStackToWasm` / `gatherTilesToWasm` / `partPtrOf`, all temporary buffers (`pd`, `psrc`, `pmask`, `pparams`, `pcov`, `psrcs`, `pops`, `palphas`, `pmasks`, `pf`, `pz`, `pout`, `plens`) are allocated with `a.take(bytes, align)`.
   - Inner kernel calls (`p.exports.match_pixels`, `p.exports.clip_coverage`, `p.exports.dissolve_rows`, `p.exports.composite_tile`, `p.pngPartFromPtr`, `p.psdPackRowsFromPtr`, `p.tiffStripFromPtr`) use pointers into `a` directly and **never** call `p._reset(a)` or `p._call(...)`.
   - When `a.take(...)` needs more than the current slab (`ARENA_MAX = 16 MiB`), `PxArena.take` (`px.js:1483-1490`) allocates overflow blocks (`this.extra.push([ptr, size, a])`), and `a.reset()` (`px.js:1493-1498`) frees every `extra` block in LIFO order and resets `this.off = 0`.
   - After `p._reset(a)`, the outer `finally` calls `releaseIfLarge()` (`kernels.js:178-193`) so if `WebAssembly.Memory` grew past `MEM_CEIL` (`128 MiB`), the instance is dropped and re-instantiated cleanly before the next job.
3. **Stale-View Discipline**:
   - Any call to `a.take(size, align)` can invoke `px_alloc`, which can grow `WebAssembly.Memory` and detach existing `Uint8Array` / `Uint32Array` / `Float32Array` views of `memory.buffer`.
   - Rule: **Never hold a typed-array view (`p.u8()`, `p.u32()`, `p.f32()`) across `a.take(...)` or across any Rust export call that allocates.** Always call `p.u8()` immediately after `a.take(...)` to populate or read wasm memory.

---

## 4. Which Copies Go Away

| Path / Step | Before K10 (JS Buffers + Copy-In/Out per Kernel) | After K10 (Compose in Wasm Memory `p.job`) | Copies Eliminated |
| :--- | :--- | :--- | :--- |
| **`rowsOfTiles` (`fromTiles` + `prevTiles`)** | Allocates `new Uint8Array((rows + 1) * stride)` in JS; copies tiles into JS; `Px.pngPart` or `Px.psdPackRows` copies `rgba` and `prev` into `p.job`. | `gatherTilesToWasm` allocates `pbuf = a.take((rows + 1) * stride, 1)` in `p.job`, zeros it, and writes tile row slices directly into `p.u8()` (`pp = pbuf`, `pr = pbuf + stride`). | Eliminates JS band allocation (`(rows + 1) * stride`) and `Px._in(rgba)` + `Px._in(prev)` copy-ins. |
| **`rowsOfStack` base (`stack.base`)** | Allocates `dst = new Uint8Array(totalRows * stride)` in JS; copies base tiles into `dst`; `Px.compositeTile` copies `dst` into `pd = a.take(...)` and copies `pd` back to `dst` after compositing. | `gatherStackToWasm` allocates `pd = a.take(totalRows * stride, 1)` in `p.job`, zeros it, and writes base tiles directly into `p.u8()` at `pd`. | Eliminates JS `dst` allocation, `Px._in(dst)` copy-in before `composite_tile`, and `u8.subarray(pd, ...)` copy-out after `composite_tile`. |
| **Each layer `l` in `rowsOfStack`** | Allocates `src = new Uint8Array(...)` in JS (unless `l.sab`), copies `l.tiles` into `src`; if `l.mask`, allocates `pm = new Uint8Array(...)` in JS and copies `l.mask` tiles; `Px.compositeTile` copies every `l.src` and `l.mask` into `p.job`. | Allocates `psrc` and `pmask` directly in `a = p.job` and gathers `l.tiles` / `l.mask` (or copies `l.sab`) straight into `p.u8()`. | Eliminates per-layer JS `Uint8Array` allocations (`src`, `pm`) and `Px.compositeTile`'s per-layer `_in(l.src)` and `_in(l.mask)` copies. |
| **Matched layer (`l.match`)** | `matchPixels(src, l.match)` calls `Px.matchPixels`, which copies `src` into `p.job`, runs `match_pixels`, copies `src` back out to JS, and then `Px.compositeTile` copies `src` back into `p.job`. | `p.exports.match_pixels(psrc, totalPx, pparams)` runs in place on `psrc` already in `p.job`. | Eliminates 2 full layer-band copies (`_in` + `_out` in `Px.matchPixels`) per matched layer. |
| **Clipped layer (`l.clip`) (K10c)** | `clipCoverage` allocates `out = new Uint8Array(n)` in JS, runs 3 scalar JS passes, and `Px.compositeTile` copies `out` into `p.job`. | `pcov` is allocated once in `p.job` on first clip and updated in place by `p.exports.clip_coverage(pcov, totalPx, pbase, baseAlpha, pown)`. | Eliminates JS `clipCoverage` allocation, scalar JS loops, and `_in(mask)` copy into `p.job`. |
| **Dissolve layer (`l.dissolve != null`) (K10c)** | Scalar JS nested loop over `totalRows * w` pixels in `inpaint_worker.js:298-313` mutating `src` in JS before `Px.compositeTile` copies `src` into `p.job`. | `p.exports.dissolve_rows(psrc, w, totalRows, x0, y0, alpha, pmask, seed)` mutates `psrc` in place in `p.job`. | Eliminates JS dissolve pass and prevents any mutation of `l.sab` (since `l.sab` is copied into `psrc` first). |
| **`pngPart` (`inpaint_worker.js:448-460`)** | `partRowsOf` builds JS `rgba` + `prev`; `Px.pngPart` copies both into `p.job`. | `partPtrOf` leaves `{ pr, pp }` in `p.job`; `p.pngPartFromPtr` filters `pr`/`pp` into `pf`, deflates into `pz + 8`, frames IDAT, and copies out **only** the compressed IDAT chunk (`written + 12` bytes). | All uncompressed row-band copies between JS and wasm are eliminated; only tile bytes go in and compressed IDAT bytes come out. |
| **`psdPart` (`inpaint_worker.js:466-475`) (K10c)** | `partRowsOf` builds JS `rgba`; for each channel `ch = 0..3`, `Px.psdPackRows` copies the entire `rgba` band (`w * rows * 4` bytes) into `p.job` **4 separate times**. | `partPtrOf` leaves `pr` in `p.job` once; `p.psdPackRowsFromPtr` runs `psd_pack_rows` for `ch = 0, 1, 2, 3` reading the same `pr`. | Eliminates JS band allocation plus **4× full `rgba` copy-ins** (`4 * w * rows * 4` bytes per band) into wasm memory. |
| **`stackInto` (`inpaint_worker.js:330-337`) (K10c)** | Allocates JS layer buffers, copies `into` (`msg.sab`) and layers into `Px.compositeTile`, copies back to `into`. | `gatherStackToWasm` composites in `p.job` (initializing `pd` from `into` only when `!stack.base && !msg.clear`) and copies `pd` into `into` once. | Eliminates intermediate JS layer buffers and `Px.compositeTile` round-trip copies. |
| **K15 `tiffPartJob` (`inpaint_worker.js:481-491`)** | `partRowsOf` builds JS `rgba`; `tiffPart` predicts in JS and copies into `Px.zlib`. | `partPtrOf(p, a, msg, false)` leaves `pr` in `p.job`; K15's `p.tiffStripFromPtr` predicts, Adler-32s, deflates, and frames in `p.job`, copying out only the compressed strip. | Eliminates JS `rgba` band, JS predictor copy, and `Px.zlib` copy-in. |

---

## 5. How K3's `pngPart` Framing and the Stack's `composite_tile` Take a Pointer

### 5.1 Why `composite_tile` Is Used (and Never K36's `composite_masked_tile`)
- `crates/px/src/composite.rs:147-159` (`begin`) premultiplies the backdrop `dst` before blending layers, and `composite.rs:499-516` (`end`) unpremultiplies every destination pixel with `0 < a < 255` after all layers are applied.
- By contrast, K36's `composite_masked_tile` (`composite.rs:605-687`) is the brush stroke kernel: it takes a single layer against `orig` and restores `orig` verbatim wherever `srcA == 0` or `mask == 0`. Routing stack composition through `composite_masked_tile` would change half-transparent export bytes whenever a layer has transparent pixels over a half-transparent backdrop.
- `composite_tile(dst, px, n, srcs, ops, alphas, masks)` (`crates/px/src/lib.rs:611-624`) already accepts raw pointers in wasm linear memory:
  - `dst: *mut u8` (`px * 4` bytes)
  - `px: usize` (`w * totalRows`)
  - `n: usize` (number of active layers)
  - `srcs: *const u32` (`n` byte offsets into wasm memory, each `px * 4` bytes)
  - `ops: *const u8` (`n` blend mode indices)
  - `alphas: *const u8` (`n` layer opacities `0..255`)
  - `masks: *const u32` (`n` byte offsets into wasm memory, `0` when unmasked, otherwise `px` bytes)

### 5.2 Contiguous `prev` + `rgba` Layout in `p.job`
Both `rowsOfTiles` (`inpaint_worker.js:205-222`) and `rowsOfStack` (`inpaint_worker.js:269-323`) support producing the preceding row `prev` (needed by PNG Paeth/Sub/Up/Avg filtering when `r0 > 0`):
- **`gatherTilesToWasm(p, a, from, needPrev)`**:
  - `stride = w * 4`.
  - `hasPrev = Boolean(needPrev && from.r0 > 0 && (from.prevTiles || from.tiles))`.
  - Allocates `totalBytes = (rows + (hasPrev ? 1 : 0)) * stride` at `pbuf = a.take(totalBytes, 1)` and zeroes `p.u8().fill(0, pbuf, pbuf + totalBytes)`.
  - If `hasPrev && from.prevTiles`:
    - `storeRowsToWasm(p, pbuf, from.prevTiles, w, 1, from.r0 - 1, tileSize, 4, 0)`
    - `storeRowsToWasm(p, pbuf, from.tiles, w, rows, from.r0, tileSize, 4, stride)`
  - Else if `hasPrev`:
    - `storeRowsToWasm(p, pbuf, from.tiles, w, rows + 1, from.r0 - 1, tileSize, 4, 0)`
  - Else:
    - `storeRowsToWasm(p, pbuf, from.tiles, w, rows, from.r0, tileSize, 4, 0)`
  - Returns `hasPrev ? { pr: pbuf + stride, pp: pbuf } : { pr: pbuf, pp: 0 }`.
- **`gatherStackToWasm(p, a, stack, above, intoBackdrop)`**:
  - `useAbove = Boolean(above && stack.r0 > 0)`.
  - `totalRows = useAbove ? stack.rows + 1 : stack.rows`.
  - `startRow = useAbove ? stack.r0 - 1 : stack.r0`.
  - `totalPx = stack.w * totalRows`, `byteLen = totalPx * 4`, `stride = stack.w * 4`.
  - Allocates `pd = a.take(byteLen, 1)`.
  - Initializes backdrop at `pd`:
    - If `stack.base`: `p.u8().fill(0, pd, pd + byteLen)` then `storeRowsToWasm(p, pd, stack.base, stack.w, totalRows, startRow, stack.tileSize, 4, 0)`.
    - Else if `intoBackdrop`: `p.u8().set(intoBackdrop, pd)`.
    - Else: `p.u8().fill(0, pd, pd + byteLen)`.
  - Pre-allocates pointer/metadata tables for up to `L = stack.layers.length` layers:
    - `psrcs = a.take(L * 4, 4)`, `pops = a.take(L, 1)`, `palphas = a.take(L, 1)`, `pmasks = a.take(L * 4, 4)`.
    - If `stack.layers.some(l => l.match)`, allocates `pparams = a.take(21 * 4, 4)` once.
  - Iterates over `l of stack.layers`:
    - Allocates `psrc = a.take(byteLen, 1)`.
    - If `l.sab`: copies `new Uint8Array(l.sab, useAbove ? 0 : (l.sabRow0 ? stride : 0), byteLen)` into `p.u8()` at `psrc`. (Because `l.sab` is copied into `psrc` in wasm memory, subsequent in-place `match_pixels` or `dissolve_rows` never mutates `l.sab`!)
    - Else: zeroes `p.u8().fill(0, psrc, psrc + byteLen)` and calls `storeRowsToWasm(p, psrc, l.tiles, stack.w, totalRows, startRow, stack.tileSize, 4, 0)`.
    - If `l.match`: copies the 21 floats of `l.match` into `p.f32()` at `pparams >> 2` and calls `p.exports.match_pixels(psrc, totalPx, pparams)` in place without resetting `a`.
    - If `l.mask`: allocates `pm = a.take(totalPx, 1)`, zeroes it, and calls `storeRowsToWasm(p, pm, l.mask, stack.w, totalRows, startRow, stack.tileSize, 1, 0)`; else `pm = 0`.
    - Clipping (`l.clip`):
      - In K10b (before K10c adds Rust `clip_coverage`): if `!l.clip`, `pcov = 0`, `baseMaskPtr = pm`, `baseAlpha = l.alpha`. If `l.clip && baseAlpha !== null`, computes `clipCoverage` in JS (or into `pcov = a.take(totalPx, 1)`) and sets `pm = pcov`.
      - In K10c: allocates `pcov = a.take(totalPx, 1)` on the first clipped layer and calls `p.exports.clip_coverage(pcov, totalPx, baseMaskPtr, baseAlpha, pm)`, then sets `pm = pcov`.
    - Dissolve (`l.dissolve !== null && l.dissolve !== undefined`):
      - In K10b (before K10c adds Rust `dissolve_rows`): runs the dissolve loop directly on `p.u8()` at `psrc` (and `pm`), setting `alpha = 255; pm = 0`.
      - In K10c: calls `alpha = p.exports.dissolve_rows(psrc, stack.w, totalRows, stack.x0 || 0, startRow, alpha, pm, l.dissolve >>> 0); pm = 0`.
    - If `alpha > 0`: writes `psrc`, `l.op`, `alpha`, `pm` at index `count++` in `psrcs`, `pops`, `palphas`, `pmasks`.
  - If `count > 0` (or `stack.base` / `!useAbove`, matching `rowsOfStack` which always runs `compositeTile(dst, active)`):
    - Calls `p.exports.composite_tile(pd, totalPx, count, psrcs, pops, palphas, pmasks)`.
  - Returns `useAbove ? { pr: pd + stride, pp: pd } : { pr: pd, pp: 0 }`.

### 5.3 `pngPart` Framing from `{ pr, pp }`
Inside `pngPart(msg)` (`inpaint_worker.js:448-460`):
```js
function pngPart(msg) {
    const p = rustPx();
    if (!p) throw new Error("NO_PARTS");
    const laps = msg.laps ? { filter: 0, adler: 0, deflate: 0 } : null;
    if (route("composeWasm") !== "js") {
        const a = p.job;
        try {
            const { pr, pp } = partPtrOf(p, a, msg, true);
            const r = p.pngPartFromPtr(a, pr, msg.w, msg.rows, pp, msg.level, Boolean(msg.last), laps);
            touched("composeWasm");
            if (laps) r.laps = laps;
            return { result: r, transfer: [r.idat] };
        } catch (e) {
            p._reset(a);
            releaseIfLarge();
            const fb = () => {
                const { rgba, prev } = partRowsOf(msg, true);
                const r = p.pngPart(rgba, msg.w, msg.rows, prev, msg.level, Boolean(msg.last), laps);
                if (laps) r.laps = laps;
                return { result: r, transfer: [r.idat] };
            };
            return recovered("composeWasm", e, fb);
        } finally {
            p._reset(a);
            releaseIfLarge();
        }
    }
    const { rgba, prev } = partRowsOf(msg, true);
    const r = p.pngPart(rgba, msg.w, msg.rows, prev, msg.level, Boolean(msg.last), laps);
    if (laps) r.laps = laps;
    return { result: r, transfer: [r.idat] };
}
```
Notice how:
1. `const p = rustPx()` is called **without** `"composeWasm"`, so setting the `"composeWasm"` route to `"js"` for comparison or differential testing never triggers `NO_PARTS` / `PARTS_OFF`.
2. When ` pr` and `pp` are produced by `gatherStackToWasm` or `gatherTilesToWasm` with `r0 > 0`, `pp` points to row `0` (`pbuf` or `pd`) and `pr` points to row `1` (`pbuf + stride` or `pd + stride`). `png_filter_rows(pr, w, rows, pp, pf)` (`crates/px/src/png.rs:105-115`) uses `prev` (`pp`, `stride` bytes) for row `0` of `pr`, and then uses row `r - 1` of `pr` for rows `1..rows-1`.
3. `png_chunk_frame(pz, written, 0x49444154)` frames `[u32 BE len][b"IDAT"][deflated bytes][u32 BE crc32]` in place at `pz`, and `this._out(Uint8Array, pz, written + 12).buffer` copies only the finished IDAT chunk out of wasm memory.

---

## 6. How K15's Future `tiffStrip` Will Take a Pointer

`chain-t`'s K15 waits for K10b so that `tiffPartJob` (`inpaint_worker.js:481-491`) can consume the exact `partPtrOf(p, a, msg, false)` helper introduced in K10b:

1. **In `inpaint_worker.js` (`partPtrOf` exported/available to `tiffPartJob`)**:
   - `partPtrOf(p, a, msg, false)` handles `msg.rgba`, `msg.stack`, and `msg.fromTiles` with `needPrev = false`, returning `{ pr, pp: 0 }` where `pr` is a pointer in `a = p.job` to `msg.w * msg.rows * 4` RGBA8 bytes.
   - Because `pr` is freshly gathered in `p.job` (even if `msg.rgba` was passed, `partPtrOf` copies it into `a.take(len, 1)`), K15's `tiff_filter_rows` / horizontal differencing predictor (`predictor === 2`) can safely mutate `pr` in place in wasm memory (or write into an arena buffer) without mutating any caller buffer.
2. **Contract for K15 in `px.js` and `inpaint_worker.js`**:
   - K15 will add `Px.prototype.tiffStripFromPtr = function(a, pr, w, rows, predictor, level = 3, laps = null)` in `renderer/editor/px/px.js`:
     - If `predictor === 2`, calls `this.exports.tiff_predict_rows(pr, w, rows)` (in place on `pr`).
     - Computes `adler = this.exports.adler32(pr, rawLen) >>> 0`.
     - Allocates `pz = a.take(2 + cap + 4, 1)` where `cap = storedCap(rawLen)`.
     - Writes the 2-byte zlib header (`0x78, 0x9C`) at `pz`, calls `written = this.exports.deflate_part(pr, rawLen, level, 1, pz + 2, cap) >>> 0`, and writes big-endian `adler` at `pz + 2 + written`.
     - Copies out once via `this._out(Uint8Array, pz, written + 6)`.
   - In `inpaint_worker.js`, `tiffPartJob(msg)` will call `partPtrOf(p, a, msg, false)` and `p.tiffStripFromPtr(a, pr, msg.w, msg.rows, predictor, level, laps)` inside `try { ... } finally { p._reset(a); releaseIfLarge(); }`, with fallback to `partRowsOf(msg, false)` + `tiffPart(...)` when routed to `"js"` or on recovery.

---

## 7. How K10c's `psdPart` and `stackInto` Take a Pointer

### 7.1 `psdPart` (`inpaint_worker.js:466-475`)
- In `psdPart(msg)`:
  - Calls `const { pr } = partPtrOf(p, a, msg, false)` inside `a = p.job`.
  - Allocates `cap = p.exports.psd_pack_rows_cap(msg.w, msg.rows) >>> 0`, `pout = a.take(cap, 1)`, and `plens = a.take(msg.rows * 2, 2)` once in `a`.
  - Loops `for (let ch = 0; ch < 4; ch++)`:
    - Calls `written = p.exports.psd_pack_rows(pr, msg.w, msg.rows, ch, pout, cap, plens) >>> 0`.
    - Copies out `data = p._out(Uint8Array, pout, written)` and `lens = p._out(Uint16Array, plens, msg.rows)`.
    - Pushes `{ data: data.buffer, lens: lens.buffer }` and transfers both ArrayBuffers.
  - If `route("composeWasm") === "js"` or `route("psdPackRows") === "js"` or `!rustPx()`, falls back to `partRowsOf(msg, false)` + `psdPackRows(rgba, msg.w, msg.rows, ch)`.

### 7.2 `stackInto` (`inpaint_worker.js:330-337`) and `l.sab` Safety
- `stackInto(msg)` writes its composited result into `const into = new Uint8Array(msg.sab, msg.byteOffset, msg.w * msg.rows * 4)`.
- **Backdrop handling when `!msg.stack.base && !msg.clear`**:
  - In `rowsOfStack` (`inpaint_worker.js:274-275`), if `into` is passed and `stack.base` is null, `dst = into` already contains the caller's existing backdrop pixels unless `msg.clear` zeroed `into` first (`inpaint_worker.js:334`).
  - Therefore, on the wasm pointer path, if `msg.clear` is true we still zero `into` (or skip copying `into` in and overwrite `into` on copy-out), and when `!msg.stack.base && !msg.clear`, we pass `intoBackdrop = into` to `gatherStackToWasm(p, a, msg.stack, false, into)` so `into` is copied into `pd` before `composite_tile` runs.
- **Shared-memory layers (`l.sab`)**:
  - Filter bands (`programStart` / `programFinish`) and stack readers can pass layers backed by `l.sab` (`inpaint_worker.js:278`).
  - On the wasm path, `gatherStackToWasm` always allocates `psrc = a.take(byteLen, 1)` and copies the slice of `l.sab` into `psrc` before running `match_pixels` or `dissolve_rows`. Thus `l.sab` is never mutated.
  - On the JS fallback path (`rowsOfStack` in `inpaint_worker.js:278`), if `l.sab` is used and `l.match || (l.dissolve !== null && l.dissolve !== undefined)`, we must copy the `Uint8Array(l.sab, ...)` view into a fresh `new Uint8Array(byteLen)` (`.slice()`) before `matchPixels` or the JS dissolve loop mutates `src` in place!
- **`stackPoints` and `compositeBox` remain untouched on their own loops**:
  - `stackPoints` (`inpaint_worker.js:380-436`) and `compositeBox` (`inpaint_boxstack.js:72-124`) keep their existing JS dissolve and `clipCoverage` loops; `hash32` (`blend_modes.js:155-157`) and `clipCoverage` (`inpaint_raster.js:266-272`) remain the JS reference twins for `dissolve_rows` and `clip_coverage`, and each copy gets its own dedicated mutant during K10c mutation testing.

---

## 8. The Argument That the Bytes Stay Equal

1. **Tile Gather (`storeRowsToWasm` vs `storeRows` / `rowsOfTiles`)**:
   - `storeRows` (`inpaint_worker.js:230-254`) iterates over tile coordinates `(ty, tx)` covering rows `[r0 .. r0 + rows)` and columns `[0 .. w)`. For `ch === 4`, it copies `src.subarray(so, so + k * 4)` into `out` at ` baseOff + ((y0 + r - r0) * w + x0) * 4`. For `ch === 1`, it copies `src[so + i * 4 + 3]` into `out` at `baseOff + (y0 + r - r0) * w + x0 + i`.
   - `storeRowsToWasm` performs the exact same arithmetic and `.subarray(...)` / alpha-byte writes into `p.u8()` starting at `ptr + baseOff`, over a region zero-initialized with `p.u8().fill(0, ptr, ptr + totalBytes)`. Every byte at `ptr .. ptr + totalBytes` is bit-for-bit identical to the JS `Uint8Array` produced by `rowsOfTiles` or `storeRows`.
2. **Color Match (`exports.match_pixels` vs `matchPixels`)**:
   - `matchPixels` (`kernels.js:772-780` -> `Px.matchPixels` `px.js:366-375`) copies `rgba` and the 21 `f32` `params` into `p.job` and calls `exports.match_pixels(p, rgba.length >> 2, pp)`.
   - Calling `p.exports.match_pixels(psrc, totalPx, pparams)` in place on `psrc` executes the exact same Rust function (`crates/px/src/cmatch.rs:16-33`) on the exact same input bytes and `f32` parameters.
3. **Clip Coverage (`exports.clip_coverage` vs `clipCoverage`)**:
   - `clipCoverage(baseMask, alpha, own)` (`inpaint_raster.js:266-272`) starts with `out` initialized to `255` (`px` bytes), multiplies by `baseMask[i]` via `mul255` if `baseMask` is present, multiplies by `alpha` via `mul255` if `alpha < 255`, and multiplies by `own[i]` via `mul255` if `own` is present, where `mul255(a, b) = (a * b + 128 + ((a * b + 128) >> 8)) >> 8`.
   - Rust's `clip_coverage` uses the exact same formula (`composite::mul255` and `composite::simd::mul255`, which computes `(t + ((t + 128) >> 8) + 128) >> 8` in `u16x8` SIMD / `u32` scalar) in the exact same 3 steps (`base_mask`, `alpha`, `own`).
4. **Dissolve (`exports.dissolve_rows` vs `rowsOfStack` dissolve loop)**:
   - `inpaint_worker.js:298-313` computes `a = mul255(mul255(src[p + 3], alpha), pm ? pm[i] : 255)`. If `a === 0` or `(hash32(x0 + c, startRow + r, seed) & 255) >= a`, it zeroes `src[p..p+4]`; otherwise it sets `src[p + 3] = 255`.
   - `hash32(x, y, s)` in `blend_modes.js:139-157` uses 32-bit wrapping integer ops (`lowbias32(x ^ lowbias32(y ^ lowbias32(s)))`), where `lowbias32` does `x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16; return x >>> 0`.
   - Rust's `dissolve_rows` implements `lowbias32` and `hash32` with `u32::wrapping_mul` and logical right shifts `>>`, which are bit-identical for all `(x0 + c) as u32`, `(y0 + r) as u32`, `seed: u32`.
5. **Stack Composite (`exports.composite_tile` vs `Px.compositeTile`)**:
   - `Px.compositeTile` (`px.js:1010-1030`) copies `dst` and each layer's `src`, `op`, `alpha`, `mask` into `p.job` and calls `exports.composite_tile(pd, px, n, psrcs, pops, palphas, pmasks)`.
   - Calling `exports.composite_tile` directly on `pd`, `psrcs`, `pops`, `palphas`, `pmasks` already populated in `p.job` runs the exact same instructions on the exact same inputs.
6. **PNG Part & PSD Pack (`pngPartFromPtr` & `psdPackRowsFromPtr`)**:
   - `pngPartFromPtr` calls the exact same sequence (`png_filter_rows`, `adler32`, `deflate_part`, `png_chunk_frame`) on `pr` and `pp` as `Px.pngPart` (`px.js:1143-1171`).
   - `psdPackRowsFromPtr` calls `psd_pack_rows(pr, w, rows, ch, pout, cap, plens)` on `pr`, identical to `Px.psdPackRows` (`px.js:1074-1089`).

---

## 9. The Tests and the Rows That Decide

### 9.1 Unit & Differential Tests (`tools/px_test.js` and `tools/kernels_release_test.js`)
Run under both **SIMD** (`build:wasm`) and **scalar** (`build:wasm:scalar` + `PX_TEST_NO_SIMD=1`) in `tools/px_test.js`:
- **K10b tests**:
  1. **Tile gather + `pngPartFromPtr` equivalence**: compare pointer-path `gatherTilesToWasm` + `pngPartFromPtr` against `rowsOfTiles` + `Px.pngPart` across:
     - `r0 === 0` (`needPrev = true`, `pp === 0`),
     - `r0 > 0` with `prevTiles` (`pp` populated from `prevTiles`),
     - `r0 > 0` without `prevTiles` (`rows + 1` gathered from `tiles`),
     - sparse/missing tiles (`null` entries in `tiles` array, partial right/bottom edge tiles).
  2. **Stack gather + composite + `pngPartFromPtr` equivalence**: compare pointer-path `gatherStackToWasm` + `pngPartFromPtr` against `rowsOfStack` + `Px.pngPart` across:
     - multi-layer stacks with `stack.base` and without `stack.base`,
     - `r0 > 0` (`above = true`, verifying row `0` filters against `r0 - 1` composited above row),
     - **matched layer between other layers** (`layer 0` normal -> `layer 1` with `l.match` 21-float params and mask -> `layer 2` blend mode over it), verifying `match_pixels` in place does not reset or corrupt `p.job` allocations for adjacent layers,
     - masked layers (`l.mask`), clipped layers (`l.clip`), and dissolve layers (`l.dissolve`).
  3. **Routing & `NO_PARTS` safety**:
     - Verify `setKernelRoute("composeWasm", "js")` routes `pngPart` to the fallback arm (`partRowsOf` + `p.pngPart`) and returns byte-identical IDAT + Adler-32 **without** throwing `NO_PARTS` or disabling `partsUsable()`.
     - Verify trap/OOM injection inside `composeWasm` recovers cleanly via `recovered("composeWasm", e, fb)` and produces identical output.
- **K10c tests**:
  1. **`clip_coverage` twin equivalence**: exhaustive byte sweep (`0..255`) + random + non-multiple-of-16 lengths (`1, 7, 15, 16, 17, 31, 32, 33, 257`) comparing Rust SIMD, Rust scalar, and JS `clipCoverage` across all combinations of `(baseMask: null | ptr, alpha: 0 | 1..254 | 255, own: null | ptr)`.
  2. **`dissolve_rows` twin equivalence**: compare Rust SIMD/scalar `dissolve_rows` against JS `hash32` + `mul255` dissolve across negative/positive `(x0, y0)`, varying `seed`, `alpha`, masked and unmasked, `srcA === 0`, `a === 0`, and full-alpha pixels.
  3. **`psdPart` pointer-path equivalence**: compare `partPtrOf` + `psdPackRowsFromPtr` (`ch = 0..3`) against `partRowsOf` + `psdPackRows` for both `fromTiles` and multi-layer `stack` inputs.
  4. **`stackInto` pointer-path equivalence & `l.sab` immutability**:
     - Compare pointer-path `stackInto` against `rowsOfStack` for:
       - `stack.base` present,
       - `!stack.base && msg.clear === true`,
       - **`!stack.base && msg.clear === false` with non-zero backdrop bytes pre-populated in `into`** (verifying backdrop bytes are preserved and premultiplied/composited identically),
       - **`l.sab` shared buffer layer with `l.dissolve != null` and `l.match != null`** (verifying `l.sab` bytes are completely unchanged after `stackInto` on both the Rust pointer path and the JS fallback path).

### 9.2 Mutation Rounds (`tools/mutation_round.py`)
- **K10b**: Mutate `gatherTilesToWasm` (`hasPrev` offset `pbuf + stride`), `gatherStackToWasm` (`useAbove` offset `pd + stride` and `match_pixels` pixel count), and `pngPartFromPtr` (`png_filter_rows` `pp` pointer); verify `px_test.js` kills every mutant.
- **K10c**: Give **each path with its own copy of dissolve / `clipCoverage` its own mutant**:
  1. Rust `clip_coverage` / `dissolve_rows` in `crates/px/src/composite.rs` (killed by `px_test.js`).
  2. JS `inpaint_raster.js` `clipCoverage` and `blend_modes.js` `hash32` (killed by `px_test.js` twin tests).
  3. JS `inpaint_boxstack.js` `compositeBox` dissolve / `clipCoverage` (killed by `boxstack_test.js`).
  4. JS `inpaint_worker.js` `rowsOfStack` / `stackPoints` dissolve (killed by `px_test.js`).

### 9.3 Gate Steps & Deciding Rows (`15000x10000`)
- **Gates (`tools/run_gates_both.sh` and `tools/run_gates.sh`)**:
  1. Both backends (`--ports 9629,9630 --offline`): `lint types export layered composite pixels clip blendmodes document`
  2. Tiles-only serial (`SCUMBLE_CDP_PORT=9629 bash tools/run_gates.sh <label>-serial --tiles on --offline pxjobs nodecopy`): `pxjobs` refuses canvas (`run_gates_both.sh` would fail on canvas).
  3. TIFF serial per backend (to avoid sharing `tiff_fixtures`):
     - `SCUMBLE_CDP_PORT=9629 bash tools/run_gates.sh <label>-tiff-tiles --tiles on --offline tiff`
     - `SCUMBLE_CDP_PORT=9630 bash tools/run_gates.sh <label>-tiff-canvas --tiles off --offline tiff`
- **Deciding Rows at 15,000 × 10,000** (3 alternating before/after rounds under `F:\canvas\.claude\coord\busy.md` lock with a before tree exported at base):
  - **K10b**:
    - `python tools/native_test.py 15000x10000 build_the_file open_the_file add_the_paint_layer wand_whole_picture export_png export_psd export_ora open_psd open_ora close` (naming `add_the_paint_layer` so the document has two layers and composites)
    - `python tools/native_test.py 15000x10000 build_the_file open_the_file add_the_paint_layer match_export_png close` (matched layer export row)
    - `exportperf:15000x10000` (PNG / PSD / ORA / TIFF band export wall time and worker heap RSS)
    - `tiffperf:15000x10000` (specifically the **`stored` step** of the opens, which exercises `uploadPixels` -> `encodeTilePixels` -> `pngPart` with `fromTiles` + `prevTiles`, plus `open_psd` / `open_ora` in `native_test.py`)
  - **K10c**:
    - `python tools/native_test.py 15000x10000 build_the_file open_the_file add_the_paint_layer wand_whole_picture match_wand export_png export_psd export_ora open_psd open_ora close`
    - `exportperf:15000x10000` (layered & flattened PSD / ORA / PNG export wall time and RSS)
    - `tiffperf:15000x10000`
  - Per §1.1, if any kernel loses its whole-operation A/B at 15,000 × 10,000, it gets a route entry to the JS twin with the deciding row cited in the report.
