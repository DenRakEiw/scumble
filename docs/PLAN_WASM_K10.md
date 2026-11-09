# PLAN_WASM_K10 — Compose in Wasm Memory (K10a / K10b / K10c)

This document is the design for **K10** ("compose in wasm memory", item 44 of `docs/PLAN_WASM_BUILD.md` §3 / §4.1 / §5), split across:

- **K10a**: this design (`docs/PLAN_WASM_K10.md`).
- **K10b**: gather + composite + PNG filter / deflate by pointer in linear memory; the PNG writer (`png_part`) and the tile store (`uploadPixels` / `encodeTilePixels`) on it.
- **K10c**: PSD channel pack (`psd_part`) and the wand / filter band stack (`stack_into`) on the same pointer gather; `dissolve_rows` and `clip_coverage` in Rust.

All file paths, line numbers, and signatures in §1 are verified against `wasm-kernels` at commit `3fd8bda7`. Any numeric claim not followed by a command and run date is explicitly marked *(inferred)*.

---

## 1. Current Code & Line-Numbered Anchors (`3fd8bda7`)

### 1.1 Rust crate (`crates/px/src/`)

- **`crates/px/src/lib.rs`**
  - `:43-45`: `fn align_for(bytes: usize) -> usize { if bytes >= 16 * 1024 { 4096 } else { 8 } }`
  - `:55-57`: `pub extern "C" fn px_abi_version() -> u32` — returns `36` at `3fd8bda7`.
  - `:61-63`: `pub extern "C" fn px_simd() -> u32` — returns `1` on `+simd128`, `0` on scalar.
  - `:68-76`: `pub extern "C" fn px_alloc(bytes: usize) -> *mut u8` — allocates `bytes` with `align_for(bytes)`.
  - `:80-85`: `pub unsafe extern "C" fn px_free(ptr: *mut u8, bytes: usize)` — frees `bytes` with `align_for(bytes)`.
  - `:611-624`:
    ```rust
    pub unsafe extern "C" fn composite_tile(
        dst: *mut u8, px: usize, n: usize,
        srcs: *const u32, ops: *const u8, alphas: *const u8, masks: *const u32,
    )
    ```
    Converts `srcs`, `ops`, `alphas`, `masks` of length `n` into `composite::Layer` items and runs `composite::begin(dst)` (`:617`), `for i in 0..n { composite::apply(dst, &layer); }` (`:618-622`), `composite::end(dst)` (`:623`). **Important**: `composite_tile` runs `begin(dst)` and `end(dst)` unconditionally even when `n == 0`!
  - `:633-650`:
    ```rust
    pub unsafe extern "C" fn composite_masked_tile(
        dst: *mut u8, has_dst: u32, src: *const u8, px: usize,
        op: u8, alpha: u8, mask: *const u8,
    ) -> u32
    ```
  - `:678-680`:
    ```rust
    pub unsafe extern "C" fn match_pixels(rgba: *mut u8, px: usize, params: *const f32)
    ```
    Calls `cmatch::match_pixels(slice::from_raw_parts_mut(rgba, px * 4), slice::from_raw_parts(params, 10))` (**10 floats**, `40` bytes: `meanS[3], meanT[3], scale[3], k`).
  - `:687-690`:
    ```rust
    pub unsafe extern "C" fn png_filter_rows(
        rgba: *const u8, w: usize, rows: usize, prev: *const u8, out: *mut u8,
    ) -> usize
    ```
  - `:695-697`:
    ```rust
    pub unsafe extern "C" fn deflate_part(
        src: *const u8, len: usize, level: i32, last: u32, out: *mut u8, cap: usize,
    ) -> isize
    ```
    Returns signed `isize`: the compressed byte count, or `-1` when `cap` was too small (including when a non-last sync-flushed part fills `out` completely, `png.rs:23-32`).
  - `:701-703`:
    ```rust
    pub unsafe extern "C" fn adler32(src: *const u8, len: usize, start: u32) -> u32
    ```
    Takes 3 arguments `(src, len, start)`, where `start = 1` for a fresh buffer (`png.rs:34-38`).
  - `:707-712`:
    ```rust
    pub unsafe extern "C" fn crc32(src: *const u8, len: usize, start: u32) -> u32
    ```
  - `:718-723`:
    ```rust
    pub unsafe extern "C" fn png_chunk_frame(buf: *mut u8, data_len: usize, kind: u32) -> u32
    ```
    Writes `data_len` (big-endian u32) into `buf[0..4]`, `kind` into `buf[4..8]`, and the CRC-32 over `buf[4..8 + data_len]` into `buf[8 + data_len..12 + data_len]`, **and returns that CRC-32 (`u32`)**.
  - `:729-731`:
    ```rust
    pub extern "C" fn psd_pack_rows_cap(w: usize, rows: usize) -> usize
    ```
  - `:736-738`:
    ```rust
    pub unsafe extern "C" fn psd_pack_rows(
        rgba: *const u8, w: usize, rows: usize, channel: usize,
        out: *mut u8, cap: usize, lens: *mut u8,
    ) -> isize
    ```
    Writes big-endian `u16` row byte counts into `lens[0..rows * 2]` and packed PackBits channel bytes into `out[0..cap]`, returning signed `isize` (`-1` if `out` was too small).

- **`crates/px/src/composite.rs`**
  - `:134-137`: `#[inline(always)] fn mul255(x: u32, y: u32) -> u32 { let t = x * y + 128; (t + (t >> 8)) >> 8 }`
  - `:139-144`: `pub struct Layer<'a> { pub src: &'a [u8], pub op: u8, pub alpha: u8, pub mask: Option<&'a [u8]> }`
  - `:147-159`: `pub fn begin(dst: &mut [u8])` — premultiplies `dst` in place (`mul255(c, a)`).
  - `:161-174`: `pub fn apply(dst: &mut [u8], layer: &Layer)` — applies one blend layer in place.
  - `:499-516`: `pub fn end(dst: &mut [u8])` — unpremultiplies `dst` in place (`((c * 255 + (a >> 1)) / a).min(255)`, clearing RGB to `0` when `a == 0`).
  - `:605-687`: `pub fn masked_tile(...) -> u32`
  - `:732-739`: `simd::mul255(x: v128, y: v128) -> v128`
  - `:746-792`: `simd::premultiply(dst: &mut [u8])` and `simd::unpremultiply(dst: &mut [u8])`.

- **`crates/px/src/cmatch.rs`**
  - `:16-33`: `pub fn match_pixels(rgba: &mut [u8], params: &[f32])` — reads `params[0..10]` (`ms0..ms2, mt0..mt2, sc0..sc2, k`) and transforms RGBA in place where `rgba[i + 3] != 0`.
  - `:49-91`: `simd::match_pixels(rgba: &mut [u8], params: &[f32])`.

- **`crates/px/src/png.rs`**
  - `:23-32`: `pub fn deflate_part(src: &[u8], level: i32, last: bool, out: &mut [u8]) -> isize`
  - `:34-38`: `pub fn adler32(src: &[u8], start: u32) -> u32`
  - `:105-115`: `pub fn filter_rows(rgba: &[u8], w: usize, rows: usize, prev: Option<&[u8]>, out: &mut [u8]) -> usize`
  - `:537-566`: `pub fn crc32(src: &[u8], start: u32) -> u32`
  - `:571-577`: `pub fn chunk_frame(buf: &mut [u8], data_len: usize, kind: u32) -> u32`

- **`crates/px/src/psd.rs`**
  - `:9-59`: `pub fn pack_rows(rgba: &[u8], w: usize, rows: usize, channel: usize, out: &mut [u8], lens: &mut [u8]) -> isize`
  - `:63-65`: `pub fn pack_rows_cap(w: usize, rows: usize) -> usize`

### 1.2 JS wrapper & routing (`renderer/editor/px/`)

- **`renderer/editor/px/px.js`**
  - `:14`: `export const PX_ABI = 36;`
  - `:17`: `function roundUp(n, a) { return (n + a - 1) & ~(a - 1); }`
  - `:27`: `function storedCap(n) { return n + 5 * (Math.ceil(n / 65535) + 2) + 16; }`
  - `:73-126`: `pxCalls`, `pxTimed`, `pxLaps`, `pxLapAdd`, `lapIn`, `lapOut`.
  - `:137-151`: `export class PxOutOfMemory extends Error` and `trapMark(err, p, name)`.
  - `:230-247`: `Px.alloc(bytes)` and `Px.free(ptr, bytes)`.
  - `:250-267`: `Px.put(ptr, data)`, `Px.view(Type, ptr, length)`, `Px.get(Type, ptr, length, into)`.
  - `:269-279`: `Px.arena(chunkBytes = 1 << 20)` and `Px.job` (lazy per-instance `PxArena`).
  - `:281-302`: `Px._in(arena, data, bytes = data.byteLength)` and `Px._out(Type, ptr, length, out)`.
  - `:309-315`: `Px._reset(a)` — resets `a` in `finally`, catching and ignoring `PxOutOfMemory` if `a.reset()` cannot allocate the consolidated peak chunk.
  - `:366-375`: `Px.matchPixels(rgba, params)` — allocates `pp = a.take(40)`, writes 10 `f32` values into `this.view(Float32Array, pp, 10)`, calls `this.exports.match_pixels(pr, rgba.byteLength >>> 2, pp)`.
  - `:1010-1030`: `Px.compositeTile(dst, srcs, ops, alphas, masks = null)` — takes 5 arguments `(dst, srcs, ops, alphas, masks)`.
  - `:1060-1067`: `Px.pngFilterRows(rgba, w, rows, prev = null, out = null)`.
  - `:1074-1089`: `Px.psdPackRows(rgba, w, rows)` — takes 3 arguments `(rgba, w, rows)`, calls `this._in(a, rgba, rows * 4 * w)` **once**, then loops `for (let ch = 0; ch < 4; ch++)` calling `psd_pack_rows(pr, w, rows, ch, po, cap, pl)`, throws if `n < 0`, and returns `[{ lens: Uint8Array, data: Uint8Array }, ...]` (length 4).
  - `:1102-1123`: `Px.zlib(bytes, level)` — takes 2 arguments `(bytes, level)`, calls `adler32(pi, n, 1) >>> 0`, and loops `for (;;) { const po = a.take(cap); const written = this.exports.deflate_part(pi, n, level, 1, po, cap); if (written >= 0) { ... } cap *= 2; }`.
  - `:1125-1141`: `Px.crc32(bytes, start = 0)` and `Px.pngChunkFrame(buf, dataLen = buf.byteLength - 12, kind = 0x49444154)`.
  - `:1143-1171`: `Px.pngPart(rgba, w, rows, prev, level, last, laps = null)` — copies `rgba` and `prev` in via `this._in`, runs `png_filter_rows(pr, w, rows, pp, pf)` and `adler32(pf, n, 1) >>> 0`, then loops `for (;;) { const po = a.take(cap + 12); const written = this.exports.deflate_part(pf, n, level, last ? 1 : 0, po + 8, cap); if (lap) lap("deflate"); if (written >= 0) { const crc = this.exports.png_chunk_frame(po, written, 0x49444154) >>> 0; ... return { bytes, adler, raw: n, chunk, crc }; } cap *= 2; }`.
  - `:1454-1499`: `export class PxArena`:
    - `constructor(px, chunkBytes = 1 << 20)` (`:1455-1461`): `this.px = px; this.chunkBytes = chunkBytes; this.chunks = []; this.peak = 0; this.jobBytes = 0;`.
    - `take(bytes, align = bytes >= 16 * 1024 ? 4096 : 8)` (`:1465-1479`): first-fit over `this.chunks` (`roundUp(c.used, align)`); if none fits, allocates a new chunk of `Math.max(this.chunkBytes, roundUp(bytes, 8))` via `this.px.alloc(size)`. Default alignment is `4096` for blocks `>= 16 KB` (preventing 4K aliasing on large copies) and `8` for smaller blocks.
    - `reset()` (`:1482-1493`): sets `this.peak = Math.max(this.peak, this.jobBytes); this.jobBytes = 0;`. If `this.chunks.length > 1`, frees every chunk and allocates one single chunk of `Math.max(this.chunkBytes, roundUp(this.peak, 8))` (which can throw `PxOutOfMemory`, caught by `Px._reset`). If `this.chunks.length === 1`, sets `this.chunks[0].used = 0`.

- **`renderer/editor/px/kernels.js`**
  - `:61`: `ROUTE_KINDS` — table of route names and kinds (`"kernel"`, `"cutoff"`, `"mem"`).
  - `:80`: `DEFAULT_ROUTES = Object.freeze({ releaseMB: 256, keepMB: 16, crc32: 64 })`.
  - `:97-123`: `setRoute(name, value)`, `route(name)`, `routes()`, `adoptRoutes(o)`.
  - `:173-182`: `export function rustPx(name = null, size = 0)` — returns the active `Px` instance, or `null` if wasm is unavailable or routed to `"js"`.
  - `:230-233`: `export function releaseIfLarge()` — if `px.bytes >= route("releaseMB") * (1 << 20)` (`256 MiB` by default), calls `renew("release", px)`.
  - `:235-272`: `IDLE_MS = 2000`, `armTrim()`, `touched()` (module-private, 0 arguments, not exported), `pxJobStart()`, `pxJobEnd()` — trims the instance via `renew("trim", px)` when `px.bytes > route("keepMB") * (1 << 20)` (`16 MiB` by default) after `2000 ms` of idle time with `activeJobs === 0`.
  - `:281-292`: `pxSettled()` and `pxInstances()`.
  - `:299-309`: `export function recovered(p, err, name = "")` — takes `(p, err, name = "")` and **returns a boolean**: if `p && p.trapped`, calls `renew("trap:" + (name || p.lastOp || "px"), p)` and returns `true`; if `err instanceof PxOutOfMemory`, calls `renew("oom:" + (name || (p && p.lastOp) || "px"), p)` and returns `true`; otherwise returns `false`.

- **`renderer/editor/px/kernels_js.js`**
  - `:668-678`: `export function matchPixels(rgba, params)` — 10-float JS twin of `match_pixels`.
  - `:946-1010`: `export function compositeTile(dst, srcs, ops, alphas, masks = null)` — JS twin of `composite_tile`.
  - `:1081-1102`: `export function psdPackRows(rgba, w, rows)` — JS twin of `psd_pack_rows` (returns 4 channel objects).
  - `:1464-1482`: `export function pngFilterRows(rgba, w, rows, prev = null, out = null)` — JS twin of `png_filter_rows`.

### 1.3 Worker & Band Callers (`renderer/editor/`)

- **`renderer/editor/inpaint_worker.js`**
  - `:86-91`: `tileBytes(t)` — resolves a tile name or `Uint8Array` to its `TILE * TILE * 4` (`262,144`-byte) `Uint8Array` from `tileStore`.
  - `:205-222`: `function rowsOfTiles(msg, above = false)`:
    - Reads `let tiles = msg.tiles, r0 = msg.r0 | 0, rows = msg.rows; const w = msg.w;`.
    - When `above` is `true`: `if (r0 > 0) { r0--; rows = 1; } else if (msg.prevTiles) { tiles = msg.prevTiles; r0 = TILE - 1; rows = 1; } else return null;`.
    - Allocates `out = new Uint8Array(w * rows * 4)` and copies each tile `tiles[tx]` row slice `tb.subarray(srcRowOff, srcRowOff + take * 4)` into `out`.
  - `:230-254`: `function storeRows(store, X0, W, Y0, n, out, alphaOnly = false)`:
    - Places `store` (`{ x, y, w, h, tiles }`) at `sx = store.x | 0, sy = store.y | 0`, clips `y0 = Math.max(Y0, sy), y1 = Math.min(Y0 + n, sy + store.h), x0 = Math.max(X0, sx), x1 = Math.min(X0 + W, sx + store.w)`.
    - Returns `false` if `y1 <= y0 || x1 <= x0` or if no tile in `store.tiles[lty][ltx]` is hit; returns `true` (`any`) when at least one tile was copied into `out`.
  - `:269-323`: `function rowsOfStack(msg, above = false, into = null)`:
    - Reads `let Y0 = msg.y | 0, n = msg.rows; if (above) { if (Y0 <= 0) return null; Y0--; n = 1; } const W = msg.w, X0 = msg.x0 | 0, st = msg.stack;`.
    - Allocates `dst = into || new Uint8Array(W * n * 4)`. If `st.base`, calls `storeRows(st.base, X0, W, Y0, n, dst)`.
    - Loops `for (const l of st.layers)`:
      - If `l.sab`: `src = new Uint8Array(l.sab, (Y0 - (msg.y0 | 0)) * W * 4, W * n * 4)` (`:278`). (Never matched.)
      - Else: allocates `src = new Uint8Array(W * n * 4)`, calls `if (!storeRows(l, X0, W, Y0, n, src)) continue;` (`:281`), and if `l.match`, calls `matchPixels(src, l.match)` (`:282`).
      - If `l.mask`: allocates `mask = new Uint8Array(W * n)` and calls `storeRows({ x: l.x, y: l.y, w: l.w, h: l.h, tiles: l.mask }, X0, W, Y0, n, mask, true)` (`:285`).
      - If `l.clip`: `const c = l.clip, cov = new Uint8Array(W * n); storeRows(c, X0, W, Y0, n, cov, true);` if `c.mask`, gathers `bm = new Uint8Array(W * n)` from `{ x: c.x, y: c.y, w: c.w, h: c.h, tiles: c.mask }`; sets `mask = clipCoverage(cov, bm, c.alpha, mask)` (`:286-292`).
      - If `l.dissolve != null` (`:294-316`): copies `rowSrc = l.sab ? new Uint8Array(src) : src`, loops over `(r, c)` with `imgY = Y0 + r, imgX = X0 + c`, computes `cVal = mul255(mul255(srcA, l.alpha), m)` and `keep = (cVal === 255) || ((hash32(imgX, imgY, l.dissolve) >>> 24) < cVal)`, sets `rowSrc[idx + 3] = 255` on keep or zeroes all 4 channels on drop, and pushes `srcs.push(rowSrc); alphas.push(255); masks.push(null); ops.push(0);`.
      - Else (`:317-319`): `srcs.push(src); alphas.push(l.alpha); masks.push(mask); ops.push(l.op | 0);`.
    - After the loop (`:321`): `if (srcs.length) compositeTile(dst, srcs, ops, alphas, masks);`.
  - `:330-337`: `async function stackInto(msg)`:
    - Computes `const at = ((msg.y | 0) - (msg.y0 | 0)) * msg.w * 4; const into = new Uint8Array(msg.sab, at, msg.w * msg.rows * 4); if (msg.clear) into.fill(0); rowsOfStack(msg, false, into);`. (Does not call `releaseIfLarge()`.)
  - `:380-436`: `async function stackPoints(msg)` — samples point grids `xs, ys` across `msg.stack`, including `clipCoverage` (`:394-400`) and the dissolve loop (`:401-423`).
  - `:439-442`: `function partRowsOf(msg)` — takes 1 argument `(msg)` and returns one `Uint8Array` (`new Uint8Array(msg.rgba, 0, msg.w * msg.rows * 4)`, `rowsOfStack(msg)`, or `rowsOfTiles(msg)`).
  - `:448-460`: `async function pngPart(msg)` — checks `let p = rustPx(); if (!p) throw new Error(NO_PARTS);` (`NO_PARTS = "png parts need the Rust kernels"` imported from `inpaint_png.js`), builds `rgba = partRowsOf(msg)` and `prev`, calls `p.pngPart(...)` with `releaseIfLarge()` in `finally`, and returns `{ chunk: r.chunk.buffer, adler: r.adler, raw: r.raw, crc: r.crc, transfer: [r.chunk.buffer], timing: { op: "png_part", kernels: "rust", pixels: msg.w * msg.rows, kernel: now() - t0, compose: msg.stack ? tc - t0 : 0, rows: tc - t0, prev: tp - tc, ...laps } }`.
  - `:466-475`: `async function psdPart(msg)` — calls `partRowsOf(msg)` and `psdPackRows(rgba, msg.w, msg.rows)` with `releaseIfLarge()` in `finally`.
  - `:481-491`: `async function tiffPartJob(msg)` — calls `partRowsOf(msg)` and `tiffPart(...)` with `releaseIfLarge()` in `finally`.

- **Other Callers & Helpers**
  - `renderer/editor/inpaint_raster.js:266-272`: `export function clipCoverage(cov, baseMask, alpha, own)` — multiplies `cov` **in place** by `baseMask` (if non-null), by `alpha` (if `alpha < 255`), and by `own` (if non-null), returning `cov`.
  - `renderer/editor/blend_modes.js:146-157`: `lowbias32(x)` (`:146-153`) and `export function hash32(x, y, seed)` (`:155-157`):
    ```js
    export function hash32(x, y, seed) {
        return lowbias32(((Math.imul(x >>> 0, 0x9E3779B1) ^ Math.imul(y >>> 0, 0x85EBCA77) ^ (seed >>> 0))) >>> 0);
    }
    ```
  - `renderer/editor/inpaint_boxstack.js:55-123`: `export function compositeBox(box, base, layers)` — main-thread box compositor with its own `clipCoverage` (`:85-92`) and dissolve loop (`:93-115`).
  - `renderer/editor/inpaint_bands.js`:
    - `:25-44`: `export function tileRows(w, h, row, partBytes = PART_BYTES)` — `part(y, n, needPrev = false)` sets `const r0 = y - ty * TILE;` and `const above = needPrev && r0 === 0 && ty > 0 ? row(ty - 1) : null;`, returning `{ tiles: row(ty), prevTiles: above, r0, rows: n }`.
    - `:81-89`: `export function stackRows(w, h, args, partBytes = PART_BYTES)` — `part(y, n, needPrev = false)` calls `args(needPrev && y > 0 ? y - 1 : y, y + n)` and returns `{ y, stack }`.
    - `:117-121`: `clipOf(b)` — returns `{ x: b.x, y: b.y, w: b.w, h: b.h, alpha: b.alpha, tiles: b.tiles, mask: b.mask || null }`.
    - `:123-137`: `export function stackArgs(base, layers, y0, y1)` — returns `{ base: ..., layers: out }`.
  - `renderer/editor/inpaint_png.js:21`: `export const NO_PARTS = "png parts need the Rust kernels";`, `:176-234`: `PngStreamWriter`.

---

## 2. Signatures, Routes, and ABI (`K10b` and `K10c`)

### 2.1 K10b — Gather + Composite + PNG Filter / Deflate by Pointer

- **ABI**: No new wasm exports are required in K10b (`composite_tile`, `match_pixels`, `png_filter_rows`, `adler32`, `deflate_part`, and `png_chunk_frame` already take raw pointers in `crates/px/src/lib.rs`). Per `docs/PLAN_WASM_BUILD.md` §3, `PX_ABI` in `renderer/editor/px/px.js` and `px_abi_version()` in `crates/px/src/lib.rs` are bumped by `+1` over K10b's base (`36 -> 37`, renumbered at merge if needed).
- **Routes (`renderer/editor/px/kernels.js`)**:
  Add two `"kernel"` entries in `ROUTE_KINDS` (`kernels.js:61`) so the tile-store gather and the stack gather can be routed and A/B'd independently (per Finding #44, preventing a tie/loss on one from disabling the other):
  - `composeTiles: "kernel"` — controls the pointer gather for tile-row parts (`msg.tiles` in `pngPart` and K10c `psdPart`).
  - `composeStack: "kernel"` — controls the pointer gather + in-wasm composite for stack parts (`msg.stack` in `pngPart` and K10c `psdPart` / `stackInto`).
  - **Important**: In `pngPart(msg)`, never pass `"composeTiles"` or `"composeStack"` to `rustPx(name)`. Always acquire the instance via `let p = rustPx(); if (!p) throw new Error(NO_PARTS);` (using the imported `NO_PARTS` constant from `inpaint_png.js:21`), and check `route(msg.stack ? "composeStack" : "composeTiles") !== "js"` to choose between the pointer path and today's JS-gather + `p.pngPart(...)` path.

- **`Px.pngPartFromPtr(a, pr, w, rows, pp, level, last, laps = null)` (`renderer/editor/px/px.js`)**:
  Operates on row bytes already placed at `pr` (`rows * w * 4` bytes) and optional previous row at `pp` (`w * 4` bytes, or `0` when absent) inside caller-managed arena `a` (`p.job`):
  ```js
  pngPartFromPtr(a, pr, w, rows, pp, level, last, laps = null) {
      const lap = lapper(laps);
      const n = rows * (4 * w + 1);
      const pf = a.take(n);
      this.exports.png_filter_rows(pr, w, rows, pp, pf);
      if (lap) lap("filter");
      const adler = this.exports.adler32(pf, n, 1) >>> 0;
      if (lap) lap("adler");
      let cap = storedCap(n);
      for (;;) {
          const po = a.take(cap + 12);
          const written = this.exports.deflate_part(pf, n, level, last ? 1 : 0, po + 8, cap);
          if (lap) lap("deflate");
          if (written >= 0) {
              const crc = this.exports.png_chunk_frame(po, written, 0x49444154) >>> 0;
              if (lap) lap("crc");
              const t0 = timing ? clock() : 0;
              const chunk = this.u8().slice(po, po + written + 12);
              const bytes = chunk.subarray(8, 8 + written);
              if (timing) lapOut("png_part", clock() - t0, chunk.byteLength);
              if (lap) lap("out");
              return { bytes, adler, raw: n, chunk, crc };
          }
          cap *= 2;
      }
  }
  ```
  *Note*: `Px.pngPart(rgba, w, rows, prev, level, last, laps = null)` keeps its own existing body untouched so the fallback / `"js"` route arm remains an independent reference.

- **Worker Pointer-Gather Helpers (`renderer/editor/inpaint_worker.js`)**:
  1. `tilesRowsToWasm(p, msg, above, ptr) -> boolean`:
     Mirrors `rowsOfTiles(msg, above)` (`inpaint_worker.js:205-222`) over `msg.tiles`, `msg.prevTiles`, `msg.r0`, `msg.rows`, `msg.w`:
     - `let tiles = msg.tiles, r0 = msg.r0 | 0, rows = msg.rows; const w = msg.w;`
     - `if (above) { if (r0 > 0) { r0--; rows = 1; } else if (msg.prevTiles) { tiles = msg.prevTiles; r0 = TILE - 1; rows = 1; } else return false; }`
     - Re-fetches `const mem = p.u8(); mem.fill(0, ptr, ptr + w * rows * 4);` and copies each present tile's row slices into `mem` at `ptr + (y * w + tx * TILE) * 4`. Returns `true`.
  2. `storeRowsToWasm(p, store, X0, W, Y0, n, ptr, alphaOnly = false) -> boolean`:
     Mirrors `storeRows(store, X0, W, Y0, n, out, alphaOnly)` (`inpaint_worker.js:230-254`) with identical geometry and return value:
     - `const sx = store.x | 0, sy = store.y | 0;`
     - `const y0 = Math.max(Y0, sy), y1 = Math.min(Y0 + n, sy + store.h);`
     - `const x0 = Math.max(X0, sx), x1 = Math.min(X0 + W, sx + store.w);`
     - `if (y1 <= y0 || x1 <= x0) return false;`
     - Walks `lty = (y0 - sy) >> 8` to `(y1 - 1 - sy) >> 8` and `ltx = (x0 - sx) >> 8` to `(x1 - 1 - sx) >> 8` over `store.tiles[lty]`, writing RGBA slices (`mem.set(tb.subarray(s, s + (cx1 - cx0) * 4), ptr + o * 4)`) or alpha bytes (`mem[ptr + o] = tb[s]`) into `mem = p.u8()`.
     - Returns `any` (`true` if at least one tile existed in the clipped range, `false` otherwise).
  3. `stackRowsToWasm(p, a, msg, above = false, into = null) -> number`:
     Mirrors `rowsOfStack(msg, above, into)` (`inpaint_worker.js:269-323`) for a single pass (`above = false` for the `msg.rows` band, or `above = true` for the 1-row `Y0 = msg.y - 1` pass), returning the destination wasm pointer `pd` (or `0` when `above && (msg.y | 0) <= 0`).

### 2.2 K10c — Rust `clip_coverage` & `dissolve_rows`, PSD Pack, and `stack_into`

- **ABI**: Bump `PX_ABI` and `px_abi_version()` by `+1` over K10c's base (`37 -> 38`, renumbered at merge).
- **New Rust Exports (`crates/px/src/lib.rs` and `crates/px/src/composite.rs`)**:
  1. **`clip_coverage`**:
     ```rust
     #[no_mangle]
     pub unsafe extern "C" fn clip_coverage(
         cov: *mut u8,
         px: usize,
         base_mask: *const u8,
         alpha: u8,
         own: *const u8,
     )
     ```
     Modifies `cov[0..px]` **in place**, matching `clipCoverage(cov, baseMask, alpha, own)` in `renderer/editor/inpaint_raster.js:266-272`:
     - `cov` has **already** been zero-filled and populated with the alpha bytes of `l.clip` via `storeRowsToWasm(p, c, X0, W, Y0, n, pcov, true)`.
     - Step 1: if `!base_mask.is_null()`, for each `i in 0..px`, `cov[i] = mul255(cov[i] as u32, bm[i] as u32) as u8`.
     - Step 2: if `alpha < 255`, for each `i in 0..px`, `cov[i] = mul255(cov[i] as u32, alpha as u32) as u8`.
     - Step 3: if `!own.is_null()`, for each `i in 0..px`, `cov[i] = mul255(cov[i] as u32, own_slice[i] as u32) as u8`.
     - Includes scalar loop in `composite.rs` and `simd128` 16-lane `u8x16` widen-and-`simd::mul255` path in `composite::simd`.
  2. **`dissolve_rows`**:
     ```rust
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
     )
     ```
     Modifies `src[0..w * rows * 4]` **in place**, matching `inpaint_worker.js:294-315` and `blend_modes.js:146-157`:
     - For `r in 0..rows`, `img_y = (y0 + r as i32) as u32`:
       For `c in 0..w`, `img_x = (x0 + c as i32) as u32`:
       - `o = r * w + c`, `idx = o * 4`, `src_a = src[idx + 3]`.
       - If `src_a == 0`, `continue`.
       - `m = if mask.is_null() { 255 } else { *mask.add(o) as u32 }`.
       - `c_val = mul255(mul255(src_a as u32, alpha as u32), m)`.
       - `keep = (c_val == 255) || ((hash32(img_x, img_y, seed) >> 24) < c_val)`, where:
         ```rust
         #[inline(always)]
         fn lowbias32(mut x: u32) -> u32 {
             x ^= x >> 16;
             x = x.wrapping_mul(0x7feb352d);
             x ^= x >> 15;
             x = x.wrapping_mul(0x846ca68b);
             x ^= x >> 16;
             x
         }
         #[inline(always)]
         fn hash32(x: u32, y: u32, seed: u32) -> u32 {
             lowbias32(x.wrapping_mul(0x9E3779B1) ^ y.wrapping_mul(0x85EBCA77) ^ seed)
         }
         ```
       - If `keep`, `src[idx + 3] = 255`; else `src[idx..idx + 4].fill(0)`.
     - After `dissolve_rows`, the layer is pushed into `composite_tile`'s table with `op = 0` (source-over), `alpha = 255`, and `mask = 0` (null).

- **JS Wrappers & Twins (`px.js`, `kernels.js`, `kernels_js.js`)**:
  - `Px.clipCoverage(cov, baseMask, alpha, own)` in `px.js` and `clipCoverage(cov, baseMask, alpha, own)` in `kernels.js` (routing on `"clipCoverage"` to `Px.clipCoverage` or `inpaint_raster.js`'s `clipCoverage`).
  - `Px.dissolveRows(src, w, rows, x0, y0, alpha, mask, seed)` in `px.js`, `dissolveRows` JS twin in `kernels_js.js`, and `dissolveRows` in `kernels.js` (routing on `"dissolveRows"`).
  - `Px.psdPackRowsFromPtr(a, pr, w, rows)` in `px.js`:
    ```js
    psdPackRowsFromPtr(a, pr, w, rows) {
        const cap = this.exports.psd_pack_rows_cap(w, rows) >>> 0;
        const po = a.take(cap);
        const pl = a.take(rows * 2);
        const out = new Array(4);
        for (let ch = 0; ch < 4; ch++) {
            const n = this.exports.psd_pack_rows(pr, w, rows, ch, po, cap, pl);
            if (n < 0) throw new Error("px: psd_pack_rows ran out of room");
            const t0 = timing ? clock() : 0;
            const lens = this.u8().slice(pl, pl + rows * 2);
            const data = this.u8().slice(po, po + n);
            if (timing) lapOut("psd_pack_rows", clock() - t0, lens.byteLength + data.byteLength);
            out[ch] = { lens, data };
        }
        return out;
    }
    ```
  - **K10c Routes (`kernels.js:61`)**:
    Add `"kernel"` entries in `ROUTE_KINDS`:
    - `clipCoverage: "kernel"` — checked both in `kernels.js` `clipCoverage` and **inside `stackRowsToWasm`** (`route("clipCoverage") !== "js"`), falling back to the JS `clipCoverage` loop over `p.view(Uint8Array, pcov, px)` when set to `"js"`.
    - `dissolveRows: "kernel"` — checked both in `kernels.js` `dissolveRows` and **inside `stackRowsToWasm`** (`route("dissolveRows") !== "js"`), falling back to the JS dissolve loop over `p.view(Uint8Array, psrc, byteLen)` when set to `"js"`.
    - `psdPartWasm: "kernel"` — controls whether `psdPart(msg)` uses `partPtrOf` + `p.psdPackRowsFromPtr` or today's `partRowsOf(msg)` + `psdPackRows(rgba, msg.w, msg.rows)`.
    - `stackIntoWasm: "kernel"` — controls whether `stackInto(msg)` uses `stackRowsToWasm` + `p.get` into `into` or today's `rowsOfStack(msg, false, into)`.

---

## 3. Arena Ownership, Alignment, and Memory Budget

1. **How `PxArena` (`p.job`) Works (`renderer/editor/px/px.js:277-279, 309-315, 1454-1499`)**:
   - Each `Px` instance owns one lazy `PxArena` at `p.job` (`new PxArena(this, 1 << 20)`). Workers are single-threaded and synchronous between `a = p.job` and `p._reset(a)`, so a job owns `p.job` exclusively from start to `finally`.
   - `a.take(bytes, align = bytes >= 16 * 1024 ? 4096 : 8)` scans `this.chunks` first-fit, rounding `c.used` up to `align`. When no existing chunk fits, `a.take` allocates a new chunk via `this.px.alloc(Math.max(this.chunkBytes, roundUp(bytes, 8)))` (`px_alloc` in Rust).
   - **Page alignment for pixel/band blocks**: `align_for` (`lib.rs:43-45`) and `PxArena.take` (`px.js:1465`) align every block `>= 16 KB` to `4096` bytes so `TypedArray.set` never hits the 4K-aliasing slowdown when copying from page-aligned `SharedArrayBuffer` or tile buffers. All pixel, mask, coverage, and filtered-row allocations in K10b/K10c call `a.take(bytes)` with the **default alignment** (never `a.take(bytes, 1)`). Small pointer/op tables (`<= 64` bytes) use `a.take(bytes, 4)` or default `8`.
   - **Stale-view rule**: Every `a.take(...)` can grow `WebAssembly.Memory` and detach previous `Uint8Array` views over `memory.buffer`. Helper functions (`tilesRowsToWasm`, `storeRowsToWasm`, `stackRowsToWasm`) **never** hold a `p.u8()` local across an `a.take(...)` call; they call `p.u8()` or `p.view(...)` only after `a.take(...)` returns.
   - **Consolidation in `p._reset(a)`**: At the end of the job (`finally`), `p._reset(a)` calls `a.reset()`. `a.reset()` records `this.peak = Math.max(this.peak, this.jobBytes); this.jobBytes = 0;`. If the job needed more than one chunk (`this.chunks.length > 1`), `a.reset()` frees all chunks and allocates a single consolidated chunk of `Math.max(1 << 20, roundUp(this.peak, 8))` so subsequent jobs run in a single contiguous chunk without fragmentation. If that consolidated allocation throws `PxOutOfMemory`, `p._reset(a)` catches and ignores it (`px.js:311-314`), leaving `this.chunks` empty for the next job or renewal.

2. **Instance Release & Idle Trim (`renderer/editor/px/kernels.js:80, 230-272`)**:
   - **Post-job ceiling (`releaseIfLarge`)**: `pngPart`, `psdPart`, and `tiffPartJob` call `releaseIfLarge()` in their `finally` block after `p._reset(a)`. If `p.bytes >= route("releaseMB") * (1 << 20)` (`DEFAULT_ROUTES.releaseMB = 256` MiB), `releaseIfLarge()` calls `renew("release", p)` to replace the instance immediately.
   - **`stackInto` does NOT call `releaseIfLarge()`**: Today's `stackInto` (`inpaint_worker.js:330-337`) does not call `releaseIfLarge()`; its arena chunk is reused across all tile-row bands of a wand or filter pass and released by the idle trim. K10c preserves this exact behavior.
   - **Idle trim (`keepMB` / `IDLE_MS`)**: Whenever a job finishes (`pxJobEnd()`), `armTrim()` sets a `2000 ms` (`IDLE_MS`) timer. When `activeJobs === 0` after 2 s and `px.bytes > route("keepMB") * (1 << 20)` (`DEFAULT_ROUTES.keepMB = 16` MiB), the worker calls `renew("trim", px)`, shrinking retained wasm memory back to a fresh instance.

3. **Byte Budget at 15,000 × 10,000 *(inferred from `PART_BYTES = 8 MiB` and `TILE = 256`)*:**
   - **Export part (`png_part` / `psd_part`)**: At `W = 15,000`, one row is `60,000` bytes. `PART_BYTES = 8,388,608` gives `rows = 139` (`8,340,000` bytes = `7.95 MiB` per RGBA band; `2,085,000` bytes = `1.99 MiB` per 1-channel mask/coverage buffer).
   - **Peak arena per worker during `png_part` on an `L`-layer stack**:
     - `pd` (band destination): `8.34 MB`
     - `psrc` per active layer: `8.34 MB * L` (plus `2.09 MB` per masked layer and `2.09 MB` per clipped layer's `pcov`)
     - `pp` (`above` row, composited in its own 1-row pass before or after): `60 KB` (plus `60 KB * L` during the 1-row pass)
     - `pf` (`png_filter_rows` output, `139 * 60,001` bytes): `8.34 MB`
     - `po` (`deflate_part` + 12-byte chunk frame, `storedCap(8,340,139) + 12`): `8.34 MB`
     - Total per worker: approximately `(L + 3) * 8.34 MB` (`33.4 MB` for `L = 1`, `41.8 MB` for `L = 2`), compared to today's `max(1 + L, 3) * 8.34 MB` (`25.0 MB` for `L = 2`) where `rgba` is freed before `pngPart` or where `compositeTile` resets its arena before `pngPart`.
     - The `releaseMB = 256` MiB threshold is only crossed when a single band has `L >= 29` active covering layers *(inferred: `32 * 8.34 MB = 266.9 MB > 256 MiB`)*. Below that, each of the 8 pool workers retains its `peak` chunk (`~42 MB` for 2 layers at 15k) across parts of the export and trims back below `keepMB = 16` MiB 2 seconds after the export finishes.
   - **Tile-row band (`stack_into` at `W = 15,000, rows = 256`)**: One RGBA band is `15.36 MB`, so `L = 2` layers takes `(1 + 2) * 15.36 MB = 46.1 MB` per worker, reused across bands and trimmed 2 s after the wand/filter completes *(inferred)*.

---

## 4. Which Copies Go Away

| Operation & Buffer | Before K10 (`3fd8bda7`) | After K10b / K10c | Saved per Part / Band *(inferred)* |
| :--- | :--- | :--- | :--- |
| **Tile-store `png_part` (`msg.tiles`)** | `rowsOfTiles` allocates JS `Uint8Array(W*rows*4)` + `prev` `Uint8Array(W*4)`, copies tile slices into JS, then `Px.pngPart` copies both into wasm via `_in`. | `tilesRowsToWasm` copies tile row slices directly into `pr` and `pp` in `p.job`. | Eliminates 1 full-band JS allocation + 1 full-band copy-in (`8.34 MB` per part at 15k). |
| **Stack `png_part` (`msg.stack`)** | `rowsOfStack` allocates JS `dst` + `L` JS `src` bands + masks, `matchPixels` copies `src` in & out of wasm, `compositeTile` copies `dst` + `L` `src`s + masks into wasm and copies `dst` out to JS, then `Px.pngPart` copies `dst` and `prev` back into wasm. | `stackRowsToWasm` gathers tiles directly into `p.job`, runs `match_pixels` and `composite_tile` in place on `pd`, and passes `pd` and `pp` directly to `pngPartFromPtr`. | Eliminates `(L + 1)` JS band allocations, `2` wasm copies per matched layer, `1` copy-in of `dst + L*src + masks` into `composite_tile`, `1` copy-out of `dst`, and `1` copy-in of `dst` into `png_filter_rows`. |
| **Stack/Tile `psd_part` (K10c)** | `partRowsOf` builds JS `rgba` (via `rowsOfStack` or `rowsOfTiles`), then `Px.psdPackRows(rgba, w, rows)` copies `rgba` into wasm **once** (`_in`) and loops `ch = 0..3`. | `partPtrOf` leaves `pr` in `p.job` and `psdPackRowsFromPtr(a, pr, w, rows)` packs all 4 channels directly from `pr`. | Eliminates 1 wasm copy-in (`w * rows * 4` bytes = `8.34 MB` per part at 15k) plus the JS `rgba` band allocation and all intermediate stack copies. |
| **Wand / Filter `stack_into` (K10c)** | `rowsOfStack` gathers into JS `src` buffers, copies into wasm for `compositeTile`, and copies out into `into` (`SharedArrayBuffer`). | `stackRowsToWasm` gathers and composites in `p.job`, then copies the final `pd` once into `into` (`p.get(Uint8Array, pd, byteLen, into)`). | Eliminates `L` JS `src` allocations, `1` wasm copy-in of `dst + L*src`, and `2` copies per matched layer. |
| **Clipped layer (`l.clip`, K10c)** | Allocates JS `cov = new Uint8Array(W*n)` and `bm = new Uint8Array(W*n)` per clipped layer, runs JS `clipCoverage`, then copies `mask` into wasm. | Allocates `pcov = a.take(px)` per clipped layer in `p.job`, gathers `l.clip` alpha and `c.mask` into wasm, and runs `clip_coverage` in place on `pcov`. | Eliminates 1–2 JS mask allocations and 1 wasm copy-in per clipped layer. |
| **Dissolve layer (`l.dissolve`, K10c)** | Copies `src` in JS (`if (l.sab)`), runs scalar JS `hash32` loop over `W*n` pixels, then copies `rowSrc` into wasm for `compositeTile`. | Gathers `psrc` directly into `p.job` and runs Rust `dissolve_rows` in place on `psrc`. | Eliminates JS scalar pixel loop and `l.sab` temporary JS clone. |

---

## 5. K10b Detailed Design: Gather, Composite, and `pngPart`

### 5.1 Tile Gather (`tilesRowsToWasm`)

In `renderer/editor/inpaint_worker.js`, `tilesRowsToWasm(p, msg, above, ptr)` mirrors `rowsOfTiles(msg, above)` (`:205-222`) line for line:

```js
function tilesRowsToWasm(p, msg, above, ptr) {
    let tiles = msg.tiles, r0 = msg.r0 | 0, rows = msg.rows;
    const w = msg.w;
    if (above) {
        if (r0 > 0) { r0--; rows = 1; }
        else if (msg.prevTiles) { tiles = msg.prevTiles; r0 = TILE - 1; rows = 1; }
        else return false;
    }
    const mem = p.u8();
    mem.fill(0, ptr, ptr + w * rows * 4);
    for (let tx = 0; tx < tiles.length; tx++) {
        const tb = tileBytes(tiles[tx]);
        if (!tb) continue;
        const x0 = tx * TILE;
        const take = Math.min(TILE, w - x0);
        if (take <= 0) continue;
        for (let y = 0; y < rows; y++) {
            const srcOff = ((r0 + y) * TILE) * 4;
            const dstOff = ptr + (y * w + x0) * 4;
            mem.set(tb.subarray(srcOff, srcOff + take * 4), dstOff);
        }
    }
    return true;
}
```

- **Why `prevTiles` handling is exact**: `tileRows.part(y, n, needPrev)` (`inpaint_bands.js:38`) sets `prevTiles` (`above`) **only** when `needPrev && r0 === 0 && ty > 0`.
  - When `r0 > 0`, `above = true` reads row `r0 - 1` of `msg.tiles`.
  - When `r0 === 0 && msg.prevTiles`, `above = true` reads row `TILE - 1` (`255`) of `msg.prevTiles`.
  - When `r0 === 0 && !msg.prevTiles` (the top row of the image, `ty === 0`), `above = true` returns `false` and `pp = 0`.

### 5.2 Store Gather (`storeRowsToWasm`) and Stack Gather (`stackRowsToWasm`)

1. **`storeRowsToWasm(p, store, X0, W, Y0, n, ptr, alphaOnly = false)`**:
   Mirrors `storeRows(store, X0, W, Y0, n, out, alphaOnly)` (`inpaint_worker.js:230-254`):
   ```js
   function storeRowsToWasm(p, store, X0, W, Y0, n, ptr, alphaOnly = false) {
       const sx = store.x | 0, sy = store.y | 0;
       const y0 = Math.max(Y0, sy), y1 = Math.min(Y0 + n, sy + store.h);
       const x0 = Math.max(X0, sx), x1 = Math.min(X0 + W, sx + store.w);
       if (y1 <= y0 || x1 <= x0) return false;
       const mem = p.u8();
       const ty0 = (y0 - sy) >> 8, ty1 = (y1 - 1 - sy) >> 8;
       const tx0 = (x0 - sx) >> 8, tx1 = (x1 - 1 - sx) >> 8;
       let any = false;
       for (let lty = ty0; lty <= ty1; lty++) {
           const row = store.tiles[lty];
           if (!row) continue;
           const cy0 = Math.max(y0, sy + (lty << 8)), cy1 = Math.min(y1, sy + ((lty + 1) << 8));
           for (let ltx = tx0; ltx <= tx1; ltx++) {
               const tb = tileBytes(row[ltx]);
               if (!tb) continue;
               any = true;
               const cx0 = Math.max(x0, sx + (ltx << 8)), cx1 = Math.min(x1, sx + ((ltx + 1) << 8));
               const span = (cx1 - cx0) * 4;
               for (let y = cy0; y < cy1; y++) {
                   const s = (((y - sy) & 255) << 8 | ((cx0 - sx) & 255)) * 4;
                   const o = (y - Y0) * W + (cx0 - X0);
                   if (alphaOnly) {
                       for (let x = 0, k = s + 3, d = ptr + o; x < cx1 - cx0; x++, k += 4, d++) mem[d] = tb[k];
                   } else {
                       mem.set(tb.subarray(s, s + span), ptr + o * 4);
                   }
               }
           }
       }
       return any;
   }
   ```

2. **`stackRowsToWasm(p, a, msg, above = false, into = null)`**:
   Mirrors `rowsOfStack(msg, above, into)` (`inpaint_worker.js:269-323`). **Crucially**, when `pngPart` needs the `above` row (`msg.y > 0`), it calls `stackRowsToWasm(p, a, msg, true, null)` as a **separate** 1-row call from `stackRowsToWasm(p, a, msg, false, null)` so that the `above` row and the `msg.rows` band each have their own independent `storeRowsToWasm` skip and their own `count > 0` guard:
   ```js
   function stackRowsToWasm(p, a, msg, above = false, into = null) {
       let Y0 = msg.y | 0, n = msg.rows;
       if (above) {
           if (Y0 <= 0) return 0;
           Y0--;
           n = 1;
       }
       const W = msg.w, X0 = msg.x0 | 0, st = msg.stack;
       const px = W * n, byteLen = px * 4;
       const pd = a.take(byteLen);
       if (st.base) {
           p.u8().fill(0, pd, pd + byteLen);
           storeRowsToWasm(p, st.base, X0, W, Y0, n, pd, false);
       } else if (into && !msg.clear) {
           p.u8().set(into, pd);
       } else {
           p.u8().fill(0, pd, pd + byteLen);
       }
       const maxL = st.layers.length;
       const srcPtrs = new Uint32Array(maxL);
       const maskPtrs = new Uint32Array(maxL);
       const opsArr = new Uint8Array(maxL);
       const alphasArr = new Uint8Array(maxL);
       let count = 0;
       for (const l of st.layers) {
           const psrc = a.take(byteLen);
           if (l.sab) {
               const sabView = new Uint8Array(l.sab, (Y0 - (msg.y0 | 0)) * W * 4, byteLen);
               p.u8().set(sabView, psrc);
           } else {
               p.u8().fill(0, psrc, psrc + byteLen);
               if (!storeRowsToWasm(p, l, X0, W, Y0, n, psrc, false)) continue;
               if (l.match) {
                   const pp = a.take(40, 4);
                   const f = p.view(Float32Array, pp, 10);
                   for (let i = 0; i < 10; i++) f[i] = l.match[i];
                   p.exports.match_pixels(psrc, px, pp);
               }
           }
           let pm = 0;
           if (l.mask) {
               pm = a.take(px);
               p.u8().fill(0, pm, pm + px);
               storeRowsToWasm(p, { x: l.x, y: l.y, w: l.w, h: l.h, tiles: l.mask }, X0, W, Y0, n, pm, true);
           }
           if (l.clip) {
               const c = l.clip;
               const pcov = a.take(px);
               p.u8().fill(0, pcov, pcov + px);
               storeRowsToWasm(p, c, X0, W, Y0, n, pcov, true);
               let pbm = 0;
               if (c.mask) {
                   pbm = a.take(px);
                   p.u8().fill(0, pbm, pbm + px);
                   storeRowsToWasm(p, { x: c.x, y: c.y, w: c.w, h: c.h, tiles: c.mask }, X0, W, Y0, n, pbm, true);
               }
               if (p.exports.clip_coverage && route("clipCoverage") !== "js") {
                   p.exports.clip_coverage(pcov, px, pbm, c.alpha, pm);
               } else {
                   const covView = p.view(Uint8Array, pcov, px);
                   const bmView = pbm ? p.view(Uint8Array, pbm, px) : null;
                   const ownView = pm ? p.view(Uint8Array, pm, px) : null;
                   clipCoverage(covView, bmView, c.alpha, ownView);
               }
               pm = pcov;
           }
           if (l.dissolve != null) {
               if (p.exports.dissolve_rows && route("dissolveRows") !== "js") {
                   p.exports.dissolve_rows(psrc, W, n, X0, Y0, l.alpha, pm, l.dissolve >>> 0);
               } else {
                   const srcView = p.view(Uint8Array, psrc, byteLen);
                   const mView = pm ? p.view(Uint8Array, pm, px) : null;
                   for (let r = 0; r < n; r++) {
                       const imgY = Y0 + r;
                       for (let c = 0; c < W; c++) {
                           const imgX = X0 + c;
                           const o = r * W + c, idx = o * 4;
                           const srcA = srcView[idx + 3];
                           if (srcA === 0) continue;
                           const m = mView ? mView[o] : 255;
                           const cVal = mul255(mul255(srcA, l.alpha), m);
                           const keep = (cVal === 255) || ((hash32(imgX, imgY, l.dissolve) >>> 24) < cVal);
                           if (keep) {
                               srcView[idx + 3] = 255;
                           } else {
                               srcView[idx] = 0; srcView[idx + 1] = 0; srcView[idx + 2] = 0; srcView[idx + 3] = 0;
                           }
                       }
                   }
               }
               srcPtrs[count] = psrc;
               alphasArr[count] = 255;
               maskPtrs[count] = 0;
               opsArr[count] = 0;
               count++;
           } else {
               srcPtrs[count] = psrc;
               alphasArr[count] = l.alpha;
               maskPtrs[count] = pm;
               opsArr[count] = l.op | 0;
               count++;
           }
       }
       if (count > 0) {
           const psrcs = a.take(count * 4, 4);
           const pmasks = a.take(count * 4, 4);
           const pops = a.take(count, 4);
           const palphas = a.take(count, 4);
           p.view(Uint32Array, psrcs, count).set(srcPtrs.subarray(0, count));
           p.view(Uint32Array, pmasks, count).set(maskPtrs.subarray(0, count));
           p.view(Uint8Array, pops, count).set(opsArr.subarray(0, count));
           p.view(Uint8Array, palphas, count).set(alphasArr.subarray(0, count));
           p.exports.composite_tile(pd, px, count, psrcs, pops, palphas, pmasks);
       }
       return pd;
   }
   ```

3. **`partPtrOf(p, a, msg, needPrev = false)`**:
   Dispatches on `msg.rgba`, `msg.stack`, or `msg.tiles` (matching `partRowsOf(msg)` at `inpaint_worker.js:439-442`):
   ```js
   function partPtrOf(p, a, msg, needPrev = false) {
       const t0 = now();
       const byteLen = msg.w * msg.rows * 4;
       let pr = 0, pp = 0;
       if (msg.rgba) {
           pr = p._in(a, new Uint8Array(msg.rgba, 0, byteLen), byteLen);
           const tc = now();
           if (needPrev && msg.prev) {
               const prevBytes = new Uint8Array(msg.prev, 0, msg.w * 4);
               pp = p._in(a, prevBytes, prevBytes.byteLength);
           }
           return { pr, pp, tc, tp: now() };
       }
       if (msg.stack) {
           pr = stackRowsToWasm(p, a, msg, false, null);
           const tc = now();
           if (needPrev && (msg.y | 0) > 0) {
               pp = stackRowsToWasm(p, a, msg, true, null);
           }
           return { pr, pp, tc, tp: now() };
       }
       pr = a.take(byteLen);
       tilesRowsToWasm(p, msg, false, pr);
       const tc = now();
       if (needPrev && ((msg.r0 | 0) > 0 || msg.prevTiles)) {
           const cand = a.take(msg.w * 4);
           if (tilesRowsToWasm(p, msg, true, cand)) pp = cand;
       }
       return { pr, pp, tc, tp: now() };
   }
   ```

### 5.3 `pngPart(msg)` in `renderer/editor/inpaint_worker.js`

```js
async function pngPart(msg) {
    let p = rustPx();
    if (!p) throw new Error(NO_PARTS);
    const t0 = now();
    const level = msg.level === undefined ? PNG_LEVEL : msg.level;
    const laps = {};
    const routeName = msg.stack ? "composeStack" : "composeTiles";
    if (!msg.rgba && route(routeName) !== "js") {
        const a = p.job;
        try {
            const { pr, pp, tc, tp } = partPtrOf(p, a, msg, true);
            const r = p.pngPartFromPtr(a, pr, msg.w, msg.rows, pp, level, !!msg.last, laps);
            return {
                chunk: r.chunk.buffer, adler: r.adler, raw: r.raw, crc: r.crc,
                transfer: [r.chunk.buffer],
                timing: {
                    op: "png_part", kernels: "rust", composeWasm: true,
                    pixels: msg.w * msg.rows, kernel: now() - t0,
                    compose: msg.stack ? tc - t0 : 0, rows: tc - t0, prev: tp - tc, ...laps,
                },
            };
        } catch (err) {
            if (!recovered(p, err, "png_part")) throw err;
        } finally {
            p._reset(a);
            releaseIfLarge();
        }
        p = rustPx();
        if (!p) {
            await pxSettled();
            p = rustPx();
        }
        if (!p) throw new Error(NO_PARTS);
    }
    const rgba = partRowsOf(msg);
    const tc = now();
    const prev = msg.prev ? new Uint8Array(msg.prev, 0, msg.w * 4)
        : (msg.stack ? rowsOfStack(msg, true) : (msg.tiles ? rowsOfTiles(msg, true) : null));
    const tp = now();
    let r;
    try { r = p.pngPart(rgba, msg.w, msg.rows, prev, level, !!msg.last, laps); }
    finally { releaseIfLarge(); }
    return {
        chunk: r.chunk.buffer, adler: r.adler, raw: r.raw, crc: r.crc,
        transfer: [r.chunk.buffer],
        timing: {
            op: "png_part", kernels: "rust", composeWasm: false,
            pixels: msg.w * msg.rows, kernel: now() - t0,
            compose: msg.stack ? tc - t0 : 0, rows: tc - t0, prev: tp - tc, ...laps,
        },
    };
}
```

- **Why fallback and `NO_PARTS` are exact**:
  - When `rustPx()` is initially null, `throw new Error(NO_PARTS)` throws the imported constant `"png parts need the Rust kernels"`, which `partsFailed` (`inpaint_encode.js:71`) matches via `msg.includes(NO_PARTS)` so `encodeTilePixels` falls back cleanly to the canvas path.
  - On trap or `PxOutOfMemory` inside the `try` block, `recovered(p, err, "png_part")` (`kernels.js:299`) triggers `renew(...)` and returns `true`; any non-wasm error returns `false` and is rethrown immediately.
  - After `finally` resets the arena and runs `releaseIfLarge()`, the fallback re-acquires a fresh `p = rustPx()` (awaiting `pxSettled()` if `renew` is still instantiating) and executes today's exact `pngPart` lines (`partRowsOf(msg)`, `rowsOfStack(msg, true)` / `rowsOfTiles(msg, true)`, and `p.pngPart(...)`).
  - `timing.composeWasm` (`true` on the pointer path, `false` on the JS-gather / fallback arm) makes the two arms directly distinguishable in gate steps and unit tests even though both arms invoke the same counted wasm exports.

---

## 6. K15's Future `tiffStrip` Contract (`tiffPartJob`)

K15 (`docs/PLAN_WASM_BUILD.md` §4.6) will add `tiff_predict_rgba(rgba: *mut u8, w: usize, rows: usize)` in Rust and move `tiffPartJob` (`inpaint_worker.js:481-491`) onto K10b's `partPtrOf(p, a, msg, false)` helper:

1. **Signature of `Px.tiffStripFromPtr(a, pr, w, rows, level, laps = null)`**:
   - `rawLen = w * rows * 4`.
   - Calls `this.exports.tiff_predict_rgba(pr, w, rows)` in place on `pr` (`if (lap) lap("predict")`).
   - Computes `const adler = this.exports.adler32(pr, rawLen, 1) >>> 0;` (**3 arguments with `start = 1`**).
   - Loops with signed `written` and capacity doubling (matching `Px.zlib` at `px.js:1109-1121`):
     ```js
     let cap = storedCap(rawLen);
     for (;;) {
         const po = a.take(cap + 6);
         const written = this.exports.deflate_part(pr, rawLen, level, 1, po + 2, cap);
         if (lap) lap("deflate");
         if (written >= 0) {
             const out = this.u8();
             out[po] = 0x78;
             out[po + 1] = level <= 1 ? 0x01 : (level < 6 ? 0x5e : (level === 6 ? 0x9c : 0xda));
             const end = po + 2 + written;
             out[end] = adler >>> 24; out[end + 1] = (adler >>> 16) & 255;
             out[end + 2] = (adler >>> 8) & 255; out[end + 3] = adler & 255;
             const strip = out.slice(po, end + 4);
             return { chunk: strip.buffer, raw: rawLen };
         }
         cap *= 2;
     }
     ```
2. **Worker `tiffPartJob(msg)` contract**:
   - Level defaults to `const level = msg.level === undefined ? PNG_LEVEL : msg.level;` (`PNG_LEVEL = 2`, matching `inpaint_worker.js:484` and `TiffStreamWriter`).
   - **Explicit `!p` arm**: Unlike `pngPart`, `tiffPartJob` works today when `rustPx()` is `null` (via JS `deflate`). Therefore, if `!p` or `route("tiffStripWasm") === "js"` or `route(msg.stack ? "composeStack" : "composeTiles") === "js"`, `tiffPartJob` runs today's exact path (`const rgba = partRowsOf(msg); ... tiffPart({ rgba, w: msg.w, rows: msg.rows, level }, p ? (b, lv) => p.zlib(b, lv) : deflate, laps)`).
   - On the pointer path, `tiffPartJob` runs `const { pr, tc } = partPtrOf(p, a, msg, false); const r = p.tiffStripFromPtr(a, pr, msg.w, msg.rows, level, laps);` inside `try / catch (err) { if (!recovered(p, err, "tiff_part")) throw err; } finally { p._reset(a); releaseIfLarge(); }`, falling back on recovery to a fresh `rustPx()` (or `deflate` if null) with `partRowsOf(msg)` + `tiffPart(...)`, and returning `{ chunk: r.chunk, raw: r.raw, transfer: [r.chunk], timing: { op: "tiff_part", kernels: p ? "rust" : "js", composeWasm: true/false, pixels: msg.w * msg.rows, kernel: now() - t0, compose: msg.stack ? tc - t0 : 0, rows: tc - t0, ...laps } }`.

---

## 7. K10c Detailed Design: `psdPart` and `stackInto`

### 7.1 `psdPart(msg)` (`renderer/editor/inpaint_worker.js:466-475`)

```js
async function psdPart(msg) {
    const t0 = now();
    let p = rustPx();
    const routeName = msg.stack ? "composeStack" : "composeTiles";
    if (p && !msg.rgba && route("psdPartWasm") !== "js" && route(routeName) !== "js") {
        const a = p.job;
        try {
            const { pr, tc } = partPtrOf(p, a, msg, false);
            const ch = p.psdPackRowsFromPtr(a, pr, msg.w, msg.rows);
            const transfer = [];
            for (const c of ch) transfer.push(c.lens.buffer, c.data.buffer);
            return {
                channels: ch.map(c => ({ lens: c.lens.buffer, data: c.data.buffer })),
                transfer,
                timing: {
                    op: "psd_part", kernels: "rust", composeWasm: true,
                    pixels: msg.w * msg.rows, kernel: now() - t0,
                    compose: msg.stack ? tc - t0 : 0,
                },
            };
        } catch (err) {
            if (!recovered(p, err, "psd_part")) throw err;
        } finally {
            p._reset(a);
            releaseIfLarge();
        }
        await pxSettled();
    }
    const rgba = partRowsOf(msg);
    const tc = now();
    let ch;
    try { ch = psdPackRows(rgba, msg.w, msg.rows); }
    finally { releaseIfLarge(); }
    const transfer = [];
    for (const c of ch) transfer.push(c.lens.buffer, c.data.buffer);
    return {
        channels: ch.map(c => ({ lens: c.lens.buffer, data: c.data.buffer })),
        transfer,
        timing: {
            op: "psd_part", kernels: kernelsInUse(), composeWasm: false,
            pixels: msg.w * msg.rows, kernel: now() - t0,
            compose: msg.stack ? tc - t0 : 0,
        },
    };
}
```
- Note that the fallback / `"js"` arm calls `psdPackRows(rgba, msg.w, msg.rows)` **once** (returning all 4 channels), matching `inpaint_worker.js:471` verbatim.

### 7.2 `stackInto(msg)` (`renderer/editor/inpaint_worker.js:330-337`)

```js
async function stackInto(msg) {
    const t0 = now();
    const byteLen = msg.w * msg.rows * 4;
    const at = ((msg.y | 0) - (msg.y0 | 0)) * msg.w * 4;
    const into = new Uint8Array(msg.sab, at, byteLen);
    let p = rustPx();
    if (p && route("stackIntoWasm") !== "js" && route("composeStack") !== "js") {
        const a = p.job;
        try {
            const pd = stackRowsToWasm(p, a, msg, false, into);
            p.get(Uint8Array, pd, byteLen, into);
            return {
                timing: {
                    op: "stack_into", kernels: "rust", composeWasm: true,
                    pixels: msg.w * msg.rows, kernel: now() - t0,
                },
            };
        } catch (err) {
            if (!recovered(p, err, "stack_into")) throw err;
        } finally {
            p._reset(a);
        }
        await pxSettled();
    }
    if (msg.clear) into.fill(0);
    rowsOfStack(msg, false, into);
    return {
        timing: {
            op: "stack_into", kernels: kernelsInUse(), composeWasm: false,
            pixels: msg.w * msg.rows, kernel: now() - t0,
        },
    };
}
```
- **Exact offsets and backdrop semantics**:
  - `into` sits at byte offset `at = ((msg.y | 0) - (msg.y0 | 0)) * msg.w * 4` of `msg.sab` (`inpaint_worker.js:332`), and any `l.sab` layer in `stackRowsToWasm` is read at `(Y0 - (msg.y0 | 0)) * W * 4` (`inpaint_worker.js:278`).
  - Neither `rowsOfStack` nor `stackRowsToWasm` mutates `l.sab` in place (`l.sab` is never matched, and `stackRowsToWasm` copies `l.sab` into a fresh `psrc = a.take(byteLen)` before dissolve or composite).
  - When `!st.base && !msg.clear`, `stackRowsToWasm` seeds `pd` from `into` (`p.u8().set(into, pd)`); when `msg.clear` is true and `!st.base`, `stackRowsToWasm` zeroes `pd` and `p.get(Uint8Array, pd, byteLen, into)` overwrites `into`. If a trap/OOM occurs and the fallback runs, `if (msg.clear) into.fill(0); rowsOfStack(msg, false, into);` restores the exact starting state of `into`.
  - `stackInto` does **not** call `releaseIfLarge()` in `finally`, preserving reuse across tile-row bands of a wand or filter pass.

---

## 8. The Argument That the Bytes Stay Equal

1. **Tile Gather (`tilesRowsToWasm` vs `rowsOfTiles`) and Store Gather (`storeRowsToWasm` vs `storeRows`)**:
   - `tilesRowsToWasm(p, msg, above, ptr)` uses the exact same `above` branch (`if (r0 > 0) { r0--; rows = 1; } else if (msg.prevTiles) { tiles = msg.prevTiles; r0 = TILE - 1; rows = 1; } else return false;`), zero-initialization (`fill(0)`), and row-slice bounds (`take = Math.min(TILE, w - tx * TILE)`, `srcOff = ((r0 + y) * TILE) * 4`, `dstOff = ptr + (y * w + x0) * 4`) as `rowsOfTiles` (`inpaint_worker.js:205-222`).
   - `storeRowsToWasm(p, store, X0, W, Y0, n, ptr, alphaOnly)` uses the exact same clipping (`[y0, y1)` and `[x0, x1)` against `sx = store.x | 0, sy = store.y | 0, store.w, store.h`), tile index ranges (`ty0..ty1`, `tx0..tx1`), per-row source offset `s = (((y - sy) & 255) << 8 | ((cx0 - sx) & 255)) * 4`, destination offset `o = (y - Y0) * W + (cx0 - X0)`, and boolean `any` return as `storeRows` (`inpaint_worker.js:230-254`).

2. **`match_pixels` (`crates/px/src/cmatch.rs:16-91`)**:
   - `stackRowsToWasm` runs `match_pixels` only on non-`sab` layers after `storeRowsToWasm` returns `true` (`if (!storeRowsToWasm(...)) continue;`), passing the same 10 `f32` parameters (`l.match[0..10]`) to the same `p.exports.match_pixels(psrc, px, pp)` export that `Px.matchPixels` calls today (`px.js:366-375`).

3. **`clip_coverage` (`crates/px/src/composite.rs` vs `inpaint_raster.js:266-272`)**:
   - For each clipped layer (`if (l.clip)`), `stackRowsToWasm` allocates a fresh `pcov = a.take(px)`, zero-fills it, and gathers `l.clip`'s alpha bytes into `pcov` via `storeRowsToWasm(p, c, X0, W, Y0, n, pcov, true)`. If `c.mask` is present, it allocates `pbm = a.take(px)`, zero-fills it, and gathers `{ x: c.x, y: c.y, w: c.w, h: c.h, tiles: c.mask }` into `pbm`.
   - Both JS `clipCoverage(cov, bm, c.alpha, mask)` and Rust `clip_coverage(pcov, px, pbm, c.alpha, pm)` apply the exact same integer formula `mul255(x, y) = ((x * y + 128) + ((x * y + 128) >> 8)) >> 8` in place on `cov[i]` in the exact same order: first `bm[i]` (if non-null), then `c.alpha` (if `< 255`), then `own[i]` (if non-null). Both scalar and `simd::mul255` (`composite.rs:732-739`) compute `((x * y + 128) + ((x * y + 128) >> 8)) >> 8` identically for all `x, y in 0..=255`.

4. **`dissolve_rows` (`crates/px/src/composite.rs` vs `inpaint_worker.js:294-315` & `blend_modes.js:146-157`)**:
   - Both JS and Rust skip pixels with `srcA == 0`, read `m = mask ? mask[o] : 255`, and compute `cVal = mul255(mul255(srcA, l.alpha), m)` in 32-bit unsigned integer arithmetic.
   - Both compute `imgX = (X0 + c) >>> 0`, `imgY = (Y0 + r) >>> 0`, and `hash32(imgX, imgY, seed)` using `wrapping_mul(0x9E3779B1)` (`Math.imul(x, 0x9E3779B1)`), `wrapping_mul(0x85EBCA77)` (`Math.imul(y, 0x85EBCA77)`), XOR with `seed >>> 0`, and `lowbias32` (`0x7feb352d`, `0x846ca68b`).
   - Both evaluate `keep = (cVal == 255) || ((hash32(imgX, imgY, seed) >>> 24) < cVal)` (testing the **top byte** `>> 24` with the explicit `cVal == 255` short-circuit so fully opaque pixels are always kept).
   - Both set `src[idx + 3] = 255` on keep, or zero `src[idx..idx + 4]` on drop, and push the layer into `composite_tile` with `op = 0` (source-over), `alpha = 255`, and `mask = 0` (`null`).

5. **Active-Layer Skip, `count > 0` Guard, and Separate `above` Pass (`stackRowsToWasm` vs `rowsOfStack`)**:
   - A non-`sab` layer with no tiles intersecting the row range returns `false` from `storeRowsToWasm` and is skipped (`continue`) before `match_pixels`, mask gather, clip gather, and dissolve.
   - `composite_tile` is called **only when `count > 0`**. When `count === 0` (e.g. a 1-layer document with `layers: []` or a band no layer touches), `pd` is untouched by `composite::begin` / `composite::end`, preserving soft-alpha base pixels (`0 < A < 255`) and RGB values under `A = 0` byte-for-byte.
   - When `pngPart` needs the `above` row (`msg.y > 0`), `stackRowsToWasm(p, a, msg, true, null)` runs as its own separate 1-row pass (`Y0 = msg.y - 1, n = 1`), with its own `storeRowsToWasm` skip and its own `if (count > 0)` guard. Thus row `msg.y - 1` undergoes `begin`/`end` if and only if it did in `rowsOfStack(msg, true)` (and in the previous part's last row).

6. **Filter, Adler-32, Deflate, CRC-32, and PSD Pack (`pngPartFromPtr` & `psdPackRowsFromPtr`)**:
   - `pngPartFromPtr` calls the exact same `png_filter_rows`, `adler32(pf, n, 1)` (with `start = 1`), `deflate_part` (with signed `written >= 0` check and `cap *= 2` retry loop), and `png_chunk_frame` exports in the exact same order as `Px.pngPart`.
   - `psdPackRowsFromPtr` calls `psd_pack_rows_cap(w, rows)` and `psd_pack_rows(pr, w, rows, ch, po, cap, pl)` for `ch = 0..3` on the same `pr` buffer, checking `if (n < 0)`, identically to `Px.psdPackRows`.

---

## 9. Tests, Mutants, Gates, and Deciding Rows

### 9.1 `tools/px_test.js` & `tools/boxstack_test.js` Unit and Parity Tests

`node tools/px_test.js` loads both `dist/wasm/px.wasm` (SIMD) and `dist/wasm/px_scalar.wasm` (scalar) directly and runs every check on both builds.

#### K10b (`tools/px_test.js`):
1. **Tile-gather (`tilesRowsToWasm` + `pngPartFromPtr` vs `rowsOfTiles` + `Px.pngPart`)**:
   Build real tile-row messages via `tileRows(w, h, row).part(y, n, true)` and assert byte-identical `{ chunk, bytes, adler, raw, crc }` across all three `prev` states:
   - Top of image (`ty === 0, r0 === 0, prevTiles: null` -> `pp === 0`).
   - **Tile-row boundary (`ty > 0, r0 === 0, prevTiles: row(ty - 1)` -> `pp` gathers row `TILE - 1` (`255`) of `prevTiles`)**.
   - Mid-tile-row (`r0 > 0, prevTiles: null` -> `pp` gathers row `r0 - 1` of `msg.tiles`), plus sparse `null` tile entries and widths not divisible by `TILE` (e.g. `w = 300`).
2. **Stack-gather (`stackRowsToWasm` + `pngPartFromPtr` vs `rowsOfStack` + `Px.pngPart`)**:
   Build real stack messages via `stackRows(w, h, (y0, y1) => stackArgs(base, layers, y0, y1)).part(y, n, true)` on a base that includes **soft-alpha pixels (`R = 200, G = 100, B = 50, A = 10` and `A = 128`) and non-zero RGB under `A = 0`**, and assert byte-identical output for:
   - **(a) Empty layer set (`layers: []`)** — verifies `composite_tile` is not called when `count === 0` and soft-alpha / `A = 0` base bytes stay verbatim.
   - **(b) Layer with no tiles in the band** — verifies `storeRowsToWasm` returns `false` and skips (`continue`) the layer so `count === 0`.
   - **(c) Layer starting right on a part boundary (`y = 256`, tiles only in `ty = 1`) and layer ending right on a part boundary (`y = 256`, tiles only in `ty = 0`)** — verifies that compositing `above` (`row 255`) in its own separate pass matches `rowsOfStack(msg, true)` and `rowsOfStack(msg, false)` byte-for-byte.
   - **(d) Offset and negative-offset layers (`x: 300, y: 140` and `x: -50, y: -30`) and non-zero `x0` (`x0: 128`)** — verifies `storeRowsToWasm` clipping and coordinate offsets on layers, masks (`l.mask`), and clip bases (`l.clip`).
   - **(e) Color-matched layer (`l.match` with 10 floats: `meanS[3], meanT[3], scale[3], k`)** between other blend layers.
   - **(f) Two layers clipped to the same base (`l.clip`), where the clip base has transparent holes (`A = 0`), a soft-alpha ramp, and `c.mask`, and the two clipped layers have different own `l.mask`s** — verifies `l.clip` alpha is gathered and each clipped layer gets its own `pcov` buffer without aliasing.
   - **(g) Dissolve layer (`l.dissolve` seed)** on tiles containing both partial coverage (`0 < cVal < 255`) and **fully opaque pixels (`cVal === 255`)**.
   - **(h) Stale-view / `memory.grow` test**: run `stackRowsToWasm` on a band size / layer count that forces `p.job` to allocate a new multi-megabyte chunk (`WebAssembly.Memory.grow`) mid-gather and verify byte equality without detached-buffer errors.
3. **Route & Fallback Parity**:
   - Assert that `composeTiles = "js"` and `composeStack = "js"` return `timing.composeWasm === false` and produce identical bytes to the default `"rust"` route (`timing.composeWasm === true`).
   - Simulate an OOM / trap on the pointer path and verify `recovered(p, err, "png_part")` renews the instance and the fallback produces identical bytes without throwing `NO_PARTS`.

#### K10c (`tools/px_test.js` & `tools/boxstack_test.js`):
1. **`clip_coverage` Parity (SIMD + Scalar vs JS `clipCoverage`)**:
   - Exhaustive / dense sweep in `px_test.js` varying **all four inputs**: initial `cov` (`0..255`, representing gathered `l.clip` alpha including `0` holes, mid-values, and `255`), `base_mask` (null vs `0..255`), `alpha` (`0, 1, 127, 128, 254, 255`), and `own` (null vs `0..255`), across lengths `0, 1, 7, 15, 16, 17, 31, 32, 33, 256, 1024`. Assert 0 ULP (exact byte equality) against `inpaint_raster.js`'s `clipCoverage`.
2. **`dissolve_rows` Parity (SIMD + Scalar vs JS dissolve loop)**:
   - Test across positive, zero, and negative `(x0, y0)`, varying `alpha` (`0..255`), `mask` (null and non-null), and `seed`, specifically including pixels where `srcA = 0`, where `0 < cVal < 255`, and where **`cVal === 255` across >1,024 coordinates** (so hashes whose low byte is `255` or top byte is `254` are hit). Assert exact byte equality against `rowsOfStack` on a tile-backed dissolve layer.
3. **`psdPart` and `stackInto` Pointer-Path Parity**:
   - Compare `psdPackRowsFromPtr` against `Px.psdPackRows` across tile and stack messages (including offset layers, matched layers with 10 floats, two clipped layers with transparent holes in `l.clip`, and dissolve layers).
   - Compare `stackInto` on the pointer path (`stackRowsToWasm` + `p.get`) against `rowsOfStack(msg, false, into)` across:
     - Multi-band `stack_into` jobs where **`msg.y !== msg.y0`** (e.g. `y0 = 0`, bands at `y = 0, 256, 512`) and `msg.x0 !== 0`, verifying each band writes to `at = (msg.y - msg.y0) * msg.w * 4` without overwriting earlier bands.
     - A filter band with **`l.sab` at `y > y0` and `l.dissolve != null`** (without `l.match`, since `l.sab` is never matched), verifying `(Y0 - msg.y0) * W * 4` offset calculation and that `l.sab` is never mutated in place.
     - Both `msg.clear = true` and `msg.clear = false` over a pre-populated half-transparent `into` buffer (including `count === 0` empty-band preservation).
   - Verify `route("clipCoverage") = "js"` and `route("dissolveRows") = "js"` inside `stackRowsToWasm` run the JS twin loops on wasm memory and produce identical bytes.
4. **`tools/boxstack_test.js` Additions**:
   - Add test cases to `tools/boxstack_test.js` covering (a) a clipped layer (`l.clip` with transparent holes, `c.mask`, `c.alpha`, and `l.mask`) and (b) a dissolve layer (`l.dissolve` with partial alpha and `cVal === 255` pixels) so `compositeBox` in `inpaint_boxstack.js` is directly tested against `rowsOfStack`.

### 9.2 Mutation Plan

Every mutant is applied one at a time, tested, and reverted before commit:

- **K10b Mutants**:
  1. `storeRowsToWasm` in `inpaint_worker.js`: drop `if (!storeRowsToWasm(...)) continue;` so an empty layer is counted — must be killed by `node tools/px_test.js` (empty-layer over soft-alpha base test).
  2. `stackRowsToWasm` in `inpaint_worker.js`: remove `if (count > 0)` guard before `composite_tile` — must be killed by `node tools/px_test.js` (`layers: []` over soft-alpha / `A = 0` base test).
  3. `partPtrOf` in `inpaint_worker.js`: in `tilesRowsToWasm`, change `r0 = TILE - 1` on the `msg.prevTiles` branch to `r0 = 0` — must be killed by `node tools/px_test.js` (`r0 === 0` with `prevTiles` test).
  4. `storeRowsToWasm` in `inpaint_worker.js`: ignore `store.x` / `X0` (`const sx = 0`) — must be killed by `node tools/px_test.js` (offset layer test).
  5. `stackRowsToWasm` in `inpaint_worker.js`: flip `l.match` sign or skip `match_pixels` — must be killed by `node tools/px_test.js` (10-float matched-layer test).

- **K10c Mutants (one per copy of `clip_coverage` and `dissolve_rows`, as required by the brief)**:
  1. **Rust `clip_coverage` / `dissolve_rows` (`crates/px/src/composite.rs`)**: change `>> 24` to `& 255` in `dissolve_rows` (or drop `if !own.is_null()` in `clip_coverage`) — must be killed by `node tools/px_test.js` on both `px.wasm` and `px_scalar.wasm`.
  2. **Shared JS `clipCoverage` (`renderer/editor/inpaint_raster.js:266`) and `hash32` (`renderer/editor/blend_modes.js:155`)**: mutate `mul255` in `clipCoverage` or the `0x9E3779B1` constant in `hash32` — must be killed by `node tools/px_test.js` and `node tools/boxstack_test.js`.
  3. **Main-thread `compositeBox` (`renderer/editor/inpaint_boxstack.js:90, 106`)**: mutate the dissolve threshold (`< cVal` to `<= cVal`) in `compositeBox` — must be killed by `node tools/boxstack_test.js` (via the new dissolve and clip cases added in §9.1.4) and by `blendmodes` gate step `o`.
  4. **Worker `rowsOfStack` (`renderer/editor/inpaint_worker.js:292, 305`)**: mutate `>>> 24` to `>>> 16` in `rowsOfStack`'s dissolve loop — must be killed by the `export` gate (`composeStack=js` parity step) and `blendmodes` gate step `n`.
  5. **Worker `stackPoints` (`renderer/editor/inpaint_worker.js:399, 412`)**: mutate `>>> 24` to `>>> 16` in `stackPoints`'s dissolve loop — must be killed by `tools/export_test.py` (`stack_points` step, extended in K10c to include a dissolve layer under a matched layer).

### 9.3 Gates and Deciding Rows

#### Gate Steps Added in K10b and K10c (`tools/export_test.py`):
- **K10b**: Extend the `export` / `layered` gate in `tools/export_test.py` with a step on a multi-tile document (with offset, clipped, dissolve, and matched layers) that:
  1. Runs `writePng` / `encodeTilePixels` on default routes and asserts from the worker job timings that `timing.composeWasm === true` ran on both `composeTiles` and `composeStack` parts.
  2. Sets `setRoute("composeTiles", "js")` and `setRoute("composeStack", "js")`, re-runs the exports, asserts `timing.composeWasm === false`, and asserts the resulting PNG / store bytes are byte-for-byte identical to the `"rust"` route.
- **K10c**: Extend the `export` gate in `tools/export_test.py` with:
  1. Assertions that `psd_part` and `stack_into` report `timing.composeWasm === true` on default routes and produce byte-identical PSD files and wand/band buffers when `psdPartWasm`, `stackIntoWasm`, `clipCoverage`, and `dissolveRows` are set to `"js"`.
  2. A dissolve layer in the `stack_points` gate step so `stackPoints`'s dissolve copy is exercised by the `export` gate and kills Mutant #5.

#### Required Gate Runs (`--ports 9629,9630`, `--offline`):
Per `brief.md` and `docs/PLAN_WASM_BUILD.md` §4.4, both K10b and K10c run:
1. Both-backend gates via `run_gates_both.sh`:
   ```bash
   SCUMBLE_GATES=F:/canvas/.claude/worktrees/ag-chain-c/dist/gates \
     bash tools/run_gates_both.sh <session>-both --ports 9629,9630 --offline \
     lint types export layered composite pixels clip blendmodes document
   ```
2. Sequential `tiff` gate (one backend after the other so `tiff_fixtures` is not shared concurrently):
   ```bash
   SCUMBLE_CDP_PORT=9629 SCUMBLE_GATES=F:/canvas/.claude/worktrees/ag-chain-c/dist/gates \
     bash tools/run_gates.sh <session>-tiff-tiles --tiles on --offline tiff
   SCUMBLE_CDP_PORT=9630 SCUMBLE_GATES=F:/canvas/.claude/worktrees/ag-chain-c/dist/gates \
     bash tools/run_gates.sh <session>-tiff-canvas --tiles off --offline tiff
   ```
3. Tiles-only `pxjobs` and `nodecopy` gate (`pxjobs` refuses canvas):
   ```bash
   SCUMBLE_CDP_PORT=9629 SCUMBLE_GATES=F:/canvas/.claude/worktrees/ag-chain-c/dist/gates \
     bash tools/run_gates.sh <session>-serial --tiles on --offline pxjobs nodecopy
   ```
4. Node unit and parity suites: `node tools/px_test.js` and `node tools/boxstack_test.js`.

#### Deciding Rows (`15000x10000`) and Tie/Loss Rule (`docs/PLAN_WASM_BUILD.md` §1.1):
- **W0b Baseline Reference (`wasm-kernels` at `15000x10000`, from `docs/PLAN_WASM_BUILD.md` §2.3, measured 2026-10-22)**:
  - `native_test.py`: `export_png` `3,962 ms` (`3,953–4,038`), `export_psd` `7,947 ms` (`7,722–8,108`), `export_ora` `3,646 ms` (`3,589–3,712`), `open_psd` `12,987 ms` (`12,849–16,193`, `stored` `2,413 ms`), `open_ora` `7,491 ms` (`7,376–8,381`, `stored` `2,480 ms`), `match_export_png` `5,021 ms`, `match_wand` `3,735 ms`, `wand_whole_picture` `4,050 ms`, `filter_export_png` `9,237 ms`, `filter_wand` `9,426 ms`.
  - `exportperf:15000x10000`: prints `composite_bands`, `layer_from_tiles` (`830 / 799 ms`), `composite_canvas`, `layer_canvas`, `psd` (`7,774 ms`), `psd_masked` (`9,275 ms`). Note that `exportperf`'s document always includes a filter layer, so `composite_bands` runs through `stack_into` + `{ rgba, prev }` parts: **K10b moves `layer_from_tiles` in `exportperf` (while stack `png_part` is decided by `native_test.py`'s `export_png`), and K10c moves `composite_bands`, `psd`, and `psd_masked`**.
  - `tiffperf:15000x10000`: `noise` `8,713 ms` (`8,513–9,566`, `stored` `4,612 ms`), `flat` `3,892 ms` (`stored` `706 ms`).
- **K10b Deciding Commands**:
  1. `python tools/native_test.py 15000x10000 build_the_file open_the_file add_the_paint_layer wand_whole_picture export_png export_psd export_ora open_psd open_ora match_export_png close`
  2. `exportperf:15000x10000` (`python tools/export_test.py --perf 15000x10000`)
  3. `tiffperf:15000x10000` (`python tools/tiff_test.py --perf 15000x10000`, `stored` step)
  4. `python tools/px_probe.py --retention 15000x10000` (measures per-worker `px_stats` wasm memory retention right after 15k `export_png` and after the 3 s idle wait).
- **K10c Deciding Commands**:
  1. `python tools/native_test.py 15000x10000 build_the_file open_the_file add_the_paint_layer wand_whole_picture filter_export_png filter_wand match_export_png match_wand export_png export_psd export_ora open_psd open_ora close` (running `match_export_png` immediately before `match_wand` so the `Matched` layer at `(5000, 3000)` is present during `match_wand`, plus `filter_export_png` and `filter_wand` to measure `programStart`'s `stack_into` bands).
  2. `exportperf:15000x10000` and `exportperf:15000x10000,--blend=dissolve` (measuring `dissolve_rows` at 15k), plus a 15k clipped-layer export benchmark row in `export_test.py` (`--perf --clipped` or a clipped layer in the 15k perf run) so both `dissolve_rows` and `clip_coverage` are measured at 15,000 × 10,000.
  3. `python tools/px_probe.py --retention 15000x10000`.
- **Tie & Loss Decision Rule (`docs/PLAN_WASM_BUILD.md` §1.1 rule 2)**:
  - Whole-operation wall times (`open_psd`, `open_ora`, `tiffperf`) have spreads wider than the `stored` step and may tie. Under §1.1 rule 2, **a wall-time tie is decided by the summed kernel / step row** (`timing.kernel` / `pxSplit` for `png_part`, `psd_part`, `stack_into`, and the `stored` sub-step of `open_psd` / `open_ora` / `tiffperf`).
  - Because `composeTiles`, `composeStack`, `psdPartWasm`, `stackIntoWasm`, `clipCoverage`, and `dissolveRows` have independent `ROUTE_KINDS` entries, if any individual path or kernel loses (or ties on both wall time and its summed `timing.kernel` row) at `15000x10000`, its route entry in `DEFAULT_ROUTES` (`renderer/editor/px/kernels.js:80`) is set to `"js"` with a comment citing the deciding row and run date, without disabling the winning paths.
