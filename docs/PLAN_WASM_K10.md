# PLAN_WASM_K10 — Compose in Wasm Memory (K10a / K10b / K10c)

This document is the design for **K10** ("compose in wasm memory", item 44 of `docs/PLAN_WASM_BUILD.md` §3 / §4.1 / §5), split across:

- **K10a**: this design (`docs/PLAN_WASM_K10.md`).
- **K10b**: gather + composite + PNG filter / deflate by pointer in linear memory; the PNG writer (`png_part`) and the tile store (`uploadPixels` / `encodeTilePixels`) on it.
- **K10c**: PSD channel pack (`psd_part`) and the wand / filter band stack (`stack_into`) on the same pointer gather; `dissolve_rows` and `clip_coverage` in Rust.

All file paths, line numbers, and signatures in §1 are read directly from `wasm-kernels` at commit `3fd8bda7`. Any numeric figure not followed by a command and run date is explicitly marked *(inferred)*.

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
    Converts `srcs`, `ops`, `alphas`, `masks` of length `n` into `composite::Layer` items and runs `composite::begin(dst)` (`:617`), `for i in 0..n { composite::apply(dst, &layer); }` (`:618-622`), `composite::end(dst)` (`:623`). **Important**: `composite_tile` runs `begin(dst)` and `end(dst)` unconditionally even when `n == 0`.
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
  - `:17`: `const roundUp = (n, to) => Math.ceil(n / to) * to;` (arithmetic, not bitwise, because sizes above 2 GB do not survive a 32-bit bitwise operator).
  - `:19`: `const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());`
  - `:27`: `const storedCap = (n) => n + Math.ceil(n / 31744) * 5 + 64;`
  - `:30-33`: `function lapper(laps)`
  - `:70`: `let TIMED = false;`
  - `:73-126`: `pxCalls(reset = false)`, `pxTimed(on)`, `pxLaps()`, `pxLapAdd(key, ms, bytes = 0, shared = false)`, `lapIn(t, bytes, from)`, `lapOut(t, bytes)`.
  - `:137-151`: `export class PxOutOfMemory extends Error` and `function trapMark(owner, e)`.
  - `:230-247`: `Px.alloc(bytes)` and `Px.free(ptr, bytes)`.
  - `:250-267`: `Px.put(ptr, data)`, `Px.view(Type, ptr, length)`, `Px.get(Type, ptr, length, into)`.
  - `:269-279`: `Px.arena(chunkBytes = 1 << 20)` and `Px.job` (lazy per-instance `PxArena`).
  - `:281-302`: `Px._in(arena, data, bytes = data.byteLength)` and `Px._out(Type, ptr, length, out)`.
  - `:309-315`: `Px._reset(a)` — resets `a` in `finally`; if `a.reset()` throws `PxOutOfMemory`, sets `if (!this.trapped) this.trapped = err;` (marking the instance poisoned so the next `rustPx()` replaces it).
  - `:366-375`: `Px.matchPixels(rgba, params)` — allocates `pp = a.take(40)`, writes 10 `f32` values into `this.view(Float32Array, pp, 10)`, calls `this.exports.match_pixels(pr, rgba.byteLength >>> 2, pp)`.
  - `:1010-1030`: `Px.compositeTile(dst, srcs, ops, alphas, masks = null)` — takes 5 arguments `(dst, srcs, ops, alphas, masks)`.
  - `:1060-1067`: `Px.pngFilterRows(rgba, w, rows, prev = null, out = null)`.
  - `:1074-1089`: `Px.psdPackRows(rgba, w, rows)` — takes 3 arguments `(rgba, w, rows)`, calls `this._in(a, rgba, rows * 4 * w)` **once**, then loops `for (let ch = 0; ch < 4; ch++)` calling `psd_pack_rows(pr, w, rows, ch, po, cap, pl)`, throws if `n < 0`, records `if (TIMED) lapOut(t, rows * 2 + n)`, and returns `[{ lens: Uint8Array, data: Uint8Array }, ...]` (length 4).
  - `:1102-1123`: `Px.zlib(bytes, level)` — takes 2 arguments `(bytes, level)`, calls `adler32(pi, n, 1) >>> 0`, and loops `for (;;) { const po = a.take(cap); const written = this.exports.deflate_part(pi, n, level, 1, po, cap); if (written >= 0) { ... out[0] = 0x78; out[1] = 0x9C; ... } cap *= 2; }`.
  - `:1125-1141`: `Px.crc32(bytes, start = 0)` and `Px.pngChunkFrame(buf, dataLen = buf.byteLength - 12, kind = 0x49444154)`.
  - `:1143-1171`: `Px.pngPart(rgba, w, rows, prev, level, last, laps = null)` — uses `const lap = laps ? lapper(laps) : null;`, copies `rgba` and `prev` in via `this._in` (`if (lap) lap("copyIn")`), runs `png_filter_rows(pr, w, rows, pp, pf)` (`lap("filter")`) and `adler32(pf, n, 1) >>> 0` (`lap("adler")`), then loops `for (;;) { const po = a.take(cap + 12); const written = this.exports.deflate_part(pf, n, level, last ? 1 : 0, po + 8, cap); if (lap) lap("deflate"); if (written >= 0) { const crc = this.exports.png_chunk_frame(po, written, 0x49444154) >>> 0; if (lap) lap("chunk"); const t = TIMED ? clock() : 0; const chunk = this.u8().slice(po, po + written + 12); const bytes = chunk.subarray(8, 8 + written); if (TIMED) lapOut(t, written + 12); if (lap) lap("copyOut"); return { bytes, adler, raw: n, chunk, crc }; } cap *= 2; }`.
  - `:1454-1499`: `export class PxArena`:
    - `constructor(px, chunkBytes = 1 << 20)` (`:1455-1461`): `this.px = px; this.chunkBytes = chunkBytes; this.chunks = []; this.peak = 0; this.jobBytes = 0;`.
    - `take(bytes, align = bytes >= 16 * 1024 ? 4096 : 8)` (`:1465-1479`): first-fit over `this.chunks` (`roundUp(c.used, align)`); if none fits, allocates a new chunk of `Math.max(this.chunkBytes, roundUp(bytes, 8))` via `this.px.alloc(size)`. Default alignment is `4096` for blocks `>= 16 KB` (preventing 4K aliasing on large copies) and `8` for smaller blocks.
    - `reset()` (`:1482-1493`): sets `this.peak = Math.max(this.peak, this.jobBytes); this.jobBytes = 0;`. If `this.chunks.length > 1`, frees every chunk and allocates one single chunk of `Math.max(this.chunkBytes, roundUp(this.peak, 8))` (which can throw `PxOutOfMemory`, caught by `Px._reset` which sets `this.trapped = err`). If `this.chunks.length === 1`, sets `this.chunks[0].used = 0`.

- **`renderer/editor/px/kernels.js`**
  - `:61`: `ROUTE_KINDS` — table of route names and kinds (`"kernel"`, `"kernelSize"`, `"mb"`, `"count"`).
  - `:80`: `DEFAULT_ROUTES = Object.freeze({ releaseMB: 256, keepMB: 16, crc32: 64 })`.
  - `:97-123`: `setRoute(name, value)`, `route(name)`, `kernelRoutes()`, `routeOverrides()`, `adoptRoutes(o)`.
  - `:129-141`: `IDLE_MS = 2000`, `PX`, `HOLDS`, `TRIM`, `TOUCHED`, `RENEWS = { release: 0, idle: 0, trap: 0, oom: 0 }`.
  - `:173-182`: `export function rustPx(name = null, size = 0)` — replaces `PX` via `renew(PX.trapped instanceof PxOutOfMemory ? "oom" : "trap", PX)` if `PX && PX.trapped`, then returns `PX` or `null`.
  - `:194-227`: `function renew(why, from)` and `function drop(limit, why) { if (PX && PX.byteLength > limit) renew(why, PX); }`.
  - `:230-233`: `export function releaseIfLarge()` — calls `drop(mb("releaseMB"), "release"); if (!HOLDS) armTrim();`.
  - `:237-272`: `armTrim()`, `trimDue()` (`drop(mb("keepMB"), "idle")`), `touched()` (module-private, 0 arguments), `pxJobStart()`, `pxJobEnd()`.
  - `:281-292`: `pxSettled()` and `pxInstances()`.
  - `:299-309`: `export function recovered(p, err, name = "")` — returns `false` unless `p && (p.trapped || err instanceof PxOutOfMemory)`; otherwise calls `renew(why, p)` with `why = p.trapped && !(p.trapped instanceof PxOutOfMemory) ? "trap" : "oom"` and returns `true`.

- **`renderer/editor/px/kernels_js.js`**
  - `:498-600`: `export function compositeTile(dst, srcs, ops, alphas, masks = null)` — JS twin of `composite_tile`.
  - `:987-1005`: `export function matchPixels(rgba, params)` — 10-float JS twin of `match_pixels`.
  - `:1015-1052`: `export function pngFilterRows(rgba, w, rows, prev = null, out = ...)` — JS twin of `png_filter_rows`.
  - `:1086-1100`: `export function psdPackRows(rgba, w, rows)` — JS twin of `psd_pack_rows` (returns 4 channel objects).

### 1.3 Worker & Band Callers (`renderer/editor/`)

- **`renderer/editor/inpaint_worker.js`**
  - `:78-91`: `const ARENA = new Map();` and `function tileBytes(t)` — if `t.data`, returns `{ bytes: new Uint8Array(t.data, 0, TILE_BYTES), shared: false }`; otherwise looks up `const sab = ARENA.get(t.chunk);` and returns `{ bytes: new Uint8Array(sab, t.slot * TILE_BYTES, TILE_BYTES), shared: true }`. Callers always guard `if (!t) continue;` before calling `tileBytes(t)`.
  - `:205-222`: `function rowsOfTiles(msg, above = false)`:
    - Reads `let tiles = msg.tiles, r0 = msg.r0 | 0, rows = msg.rows;`.
    - When `above` is `true`: `if (r0 > 0) { r0--; rows = 1; } else if (msg.prevTiles) { tiles = msg.prevTiles; r0 = TILE - 1; rows = 1; } else return null;`.
    - Allocates `out = new Uint8Array(w * rows * 4)` and for each `tx` (`const t = tiles[tx]; if (!t) continue; const { bytes } = tileBytes(t);`) copies `bytes.subarray(so, so + n)` into `out`.
  - `:230-254`: `function storeRows(store, X0, W, Y0, n, out, alphaOnly = false)`:
    - Places `store` (`{ x, y, w, h, tiles }`) at `sx = store.x | 0, sy = store.y | 0`, clips `y0 = Math.max(Y0, sy), y1 = Math.min(Y0 + n, sy + store.h), x0 = Math.max(X0, sx), x1 = Math.min(X0 + W, sx + store.w)`.
    - Walks `store.tiles[lty][ltx]` (`const t = names[ltx]; if (!t) continue; const { bytes } = tileBytes(t);`) and returns `any` (`true` when at least one tile was copied into `out`, `false` otherwise).
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
  - `:439-442`: `function partRowsOf(msg)` — takes 1 argument `(msg)` and returns one `Uint8Array`.
  - `:448-460`: `async function pngPart(msg)` — checks `const p = rustPx(); if (!p) throw new Error(NO_PARTS);`, builds `rgba = partRowsOf(msg)` and `prev`, calls `p.pngPart(...)` with `releaseIfLarge()`, and returns `{ chunk: r.chunk.buffer, adler: r.adler, raw: r.raw, crc: r.crc, transfer: [r.chunk.buffer], timing: { op: "png_part", kernels: "rust", pixels: msg.w * msg.rows, kernel: now() - t0, compose: msg.stack ? tc - t0 : 0, rows: tc - t0, prev: tp - tc, ...laps } }`.
  - `:466-475`: `async function psdPart(msg)` — calls `partRowsOf(msg)` (`t1 = now()`) and `psdPackRows(rgba, msg.w, msg.rows)` (`t2 = now()`), calls `releaseIfLarge()`, and returns `{ channels, transfer, timing: { op: "psd_part", kernels: kernelsInUse(), pixels: msg.w * msg.rows, kernel: now() - t0, rows: t1 - t0, pack: t2 - t1 } }`.
  - `:481-491`: `async function tiffPartJob(msg)` — calls `partRowsOf(msg)` and `await tiffPart({ rgba, w: msg.w, rows: msg.rows, predictor: msg.predictor }, (bytes) => (p ? p.zlib(bytes, level) : deflate(bytes)), laps)` with `releaseIfLarge()`.
  - `:1081`: `export function rangeSelectJob(msg)` — exported for `tools/px_test.js`.

- **Other Callers & Helpers**
  - `renderer/editor/inpaint_raster.js:266-272`: `export function clipCoverage(cov, baseMask, alpha, own)` — multiplies `cov` **in place** by `baseMask` (if non-null), by `alpha` (if `alpha < 255`), and by `own` (if non-null), returning `cov`.
  - `renderer/editor/blend_modes.js:146-157`: `lowbias32(x)` (`:146-153`) and `export function hash32(x, y, seed)` (`:155-157`):
    ```js
    export function hash32(x, y, seed) {
        return lowbias32(((Math.imul(x >>> 0, 0x9E3779B1) ^ Math.imul(y >>> 0, 0x85EBCA77) ^ (seed >>> 0))) >>> 0);
    }
    ```
  - `renderer/editor/inpaint_boxstack.js:72-124`: `export function compositeBox(stack, X0, Y0, W, H, pw = Infinity, ph = Infinity)` — main-thread box compositor over `[base, ...layers]` (each `{ px, mask, x, y, alpha, op, match, clip, dissolve }` using `px.tileAt`), with `clipCoverage` at `:93` and its dissolve loop at `:95-117`.
  - `renderer/editor/inpaint_bands.js`:
    - `:25-45`: `export function tileRows(snap, byName)` — `async part(y, n, needPrev)` sets `const ty = Math.floor(y / TILE), r0 = y - ty * TILE; const tiles = row(ty); const above = needPrev && r0 === 0 && ty > 0 ? row(ty - 1) : null;` and resolves `{ args: { tiles, prevTiles: above, r0 }, transfer: [] }`.
    - `:81-89`: `export function stackRows(width, height, stores)` — calls `const args = stackArgs(stores);` and in `async part(y, n, needPrev)` resolves `{ args: { y, stack: args(needPrev && y > 0 ? y - 1 : y, y + n) }, transfer: [] }`.
    - `:95-138`: `export function stackArgs(stores)` — uses inner `rowsOf(snap, sy, a, b)` (`:104-114`) and `clipOf(c, a, b)` (`:117-121`, returning `false` when `!tiles || !(c.alpha > 0)`) and returns `(a, b) => ({ base, layers })` (`:122-137`).
  - `renderer/editor/inpaint_png.js:21`: `export const NO_PARTS = "png parts need the Rust kernels";`, `:150-234`: `export class PngStreamWriter`.

---

## 2. Signatures, Routes, and ABI (`K10b` and `K10c`)

### 2.1 K10b — Gather + Composite + PNG Filter / Deflate by Pointer

- **ABI**: Bump `PX_ABI` in `renderer/editor/px/px.js` and `px_abi_version()` in `crates/px/src/lib.rs` by `+1` over K10b's base (`36 -> 37`, renumbered at merge).
- **Routes (`renderer/editor/px/kernels.js`)**:
  Add two `"kernel"` entries in `ROUTE_KINDS` (`kernels.js:61`) so the tile-store gather and the stack gather can be routed and A/B'd independently:
  - `composeTiles: "kernel"` — controls the pointer path for tile-row `png_part` jobs (`msg.tiles`).
  - `composeStack: "kernel"` — controls the pointer path for stack `png_part` jobs (`msg.stack`).
  - **Important**: In `pngPart(msg)`, never pass `"composeTiles"` or `"composeStack"` to `rustPx(name)`. Always acquire the instance via `let p = rustPx(); if (!p) throw new Error(NO_PARTS);` (using the imported `NO_PARTS` constant from `inpaint_png.js:21`), and check `route(msg.stack ? "composeStack" : "composeTiles") !== "js"`.

- **`Px.pngPartFromPtr(a, pr, w, rows, pp, level, last, laps = null)` (`renderer/editor/px/px.js`)**:
  Copies `Px.pngPart`'s exact filter, adler, deflate retry, chunk framing, `TIMED`, `lapOut`, and lap keys (`filter`, `adler`, `deflate`, `chunk`, `copyOut`) over caller-managed arena `a` (`p.job`):
  ```js
  pngPartFromPtr(a, pr, w, rows, pp, level, last, laps = null) {
      const n = rows * (1 + 4 * w);
      const lap = laps ? lapper(laps) : null;
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
              if (lap) lap("chunk");
              const t = TIMED ? clock() : 0;
              const chunk = this.u8().slice(po, po + written + 12);
              const bytes = chunk.subarray(8, 8 + written);
              if (TIMED) lapOut(t, written + 12);
              if (lap) lap("copyOut");
              return { bytes, adler, raw: n, chunk, crc };
          }
          cap *= 2;
      }
  }
  ```
  *Note*: `Px.pngPart(rgba, w, rows, prev, level, last, laps = null)` keeps its own existing body untouched as the independent `"js"` route / fallback arm.

- **Worker Pointer-Gather Helpers (`renderer/editor/inpaint_worker.js`, exported for `tools/px_test.js`)**:
  1. `export function tilesRowsToWasm(p, msg, above, ptr) -> boolean`:
     Mirrors `rowsOfTiles(msg, above)` (`inpaint_worker.js:205-222`), checking `const t = tiles[tx]; if (!t) continue; const { bytes, shared } = tileBytes(t);` and booking `pxLapAdd("copyIn", ...)` when `pxTimed()` is true.
  2. `export function storeRowsToWasm(p, store, X0, W, Y0, n, ptr, alphaOnly = false) -> boolean`:
     Mirrors `storeRows(store, X0, W, Y0, n, out, alphaOnly)` (`inpaint_worker.js:230-254`), checking `const t = names[ltx]; if (!t) continue; const { bytes, shared } = tileBytes(t);`, booking `pxLapAdd("copyIn", ...)` when `pxTimed()` is true, and returning `any` (`boolean`).
  3. `export function stackRowsToWasm(p, a, msg, above = false, into = null) -> number`:
     Mirrors `rowsOfStack(msg, above, into)` (`inpaint_worker.js:269-323`) for a single pass (`above = false` for the `msg.rows` band, or `above = true` for the 1-row `Y0 = msg.y - 1` pass), returning the destination wasm pointer `pd` (or `0` when `above && (msg.y | 0) <= 0`).
  4. Also export `rowsOfTiles`, `storeRows`, `rowsOfStack`, `partPtrOf`, `pngPart`, `psdPart`, `stackInto`, and `stackPoints` from `renderer/editor/inpaint_worker.js` so `node tools/px_test.js` can invoke them directly.

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

- **`Px.psdPackRowsFromPtr(a, pr, w, rows)` (`renderer/editor/px/px.js`)**:
  ```js
  psdPackRowsFromPtr(a, pr, w, rows) {
      const cap = this.exports.psd_pack_rows_cap(w, rows), po = a.take(cap), pl = a.take(rows * 2);
      const out = [];
      for (let ch = 0; ch < 4; ch++) {
          const n = this.exports.psd_pack_rows(pr, w, rows, ch, po, cap, pl);
          if (n < 0) throw new Error("px: psd_pack_rows ran out of room");
          const t = TIMED ? clock() : 0;
          out.push({ lens: this.u8().slice(pl, pl + rows * 2), data: this.u8().slice(po, po + n) });
          if (TIMED) lapOut(t, rows * 2 + n);
      }
      return out;
  }
  ```
  *Note*: No unused `clipCoverage` or `dissolveRows` wrapper is added to `kernels.js` (avoiding an import cycle between `kernels.js` and `inpaint_raster.js`, which already imports `kernels.js` at `:6`). Instead, `stackRowsToWasm` calls `p.exports.clip_coverage` / `p.exports.dissolve_rows` when the route is `"rust"` and the shared `clipCoverage` (`inpaint_raster.js:266`) / inline dissolve loop over `p.view(...)` when the route is `"js"`.

- **K10c Routes (`kernels.js:61`)**:
  Add `"kernel"` entries in `ROUTE_KINDS`:
  - `clipCoverage: "kernel"` — checked inside `stackRowsToWasm` (`route("clipCoverage") !== "js"`).
  - `dissolveRows: "kernel"` — checked inside `stackRowsToWasm` (`route("dissolveRows") !== "js"`).
  - `psdPartWasm: "kernel"` — controls `psdPart(msg)` independently of `composeStack` / `composeTiles`.
  - `stackIntoWasm: "kernel"` — controls `stackInto(msg)` independently of `composeStack`.

---

## 3. Arena Ownership, Alignment, and Memory Budget

1. **How `PxArena` (`p.job`) Works (`renderer/editor/px/px.js:277-279, 309-315, 1454-1499`)**:
   - Each `Px` instance owns one lazy `PxArena` at `p.job` (`new PxArena(this, 1 << 20)`). Workers are single-threaded and synchronous between `a = p.job` and `p._reset(a)`, so a job owns `p.job` exclusively from start to `finally`.
   - `a.take(bytes, align = bytes >= 16 * 1024 ? 4096 : 8)` scans `this.chunks` first-fit, rounding `c.used` up to `align` (`Math.ceil(c.used / align) * align`). When no existing chunk fits, `a.take` allocates a new chunk via `this.px.alloc(Math.max(this.chunkBytes, roundUp(bytes, 8)))` (`px_alloc` in Rust).
   - **Page alignment for pixel/band blocks**: `align_for` (`lib.rs:43-45`) and `PxArena.take` (`px.js:1465`) align every block `>= 16 KB` to `4096` bytes so `TypedArray.set` never hits the 4K-aliasing slowdown when copying from page-aligned `SharedArrayBuffer` or tile buffers. All pixel, mask, coverage, and filtered-row allocations in K10b/K10c call `a.take(bytes)` with the **default alignment** (never `a.take(bytes, 1)`). Small pointer/op tables (`<= 64` bytes) use `a.take(bytes, 4)`.
   - **Stale-view rule**: Every `a.take(...)` can grow `WebAssembly.Memory` and detach previous `Uint8Array` views over `memory.buffer`. Helper functions (`tilesRowsToWasm`, `storeRowsToWasm`, `stackRowsToWasm`) **never** hold a `p.u8()` local across an `a.take(...)` call; they call `p.u8()` or `p.view(...)` only after `a.take(...)` returns.
   - **Consolidation in `p._reset(a)`**: At the end of the job (`finally`), `p._reset(a)` calls `a.reset()`. `a.reset()` records `this.peak = Math.max(this.peak, this.jobBytes); this.jobBytes = 0;`. If the job needed more than one chunk (`this.chunks.length > 1`), `a.reset()` frees all chunks and allocates a single consolidated chunk of `Math.max(1 << 20, roundUp(this.peak, 8))` so subsequent jobs run in a single contiguous chunk. If that consolidated allocation throws `PxOutOfMemory`, `p._reset(a)` catches it and sets `if (!this.trapped) this.trapped = err;` (`px.js:311-314`), poisoning the instance so the next `rustPx()` replaces it.

2. **Instance Release & Idle Trim (`renderer/editor/px/kernels.js:80, 224-272`)**:
   - **Post-job ceiling (`releaseIfLarge`)**: `pngPart`, `psdPart`, and `tiffPartJob` call `releaseIfLarge()` after `p._reset(a)`. `releaseIfLarge()` calls `drop(mb("releaseMB"), "release")`, which tests `if (PX && PX.byteLength > limit)` (`DEFAULT_ROUTES.releaseMB = 256` MiB = `268,435,456` bytes) and calls `renew("release", PX)` when exceeded.
   - **`stackInto` does NOT call `releaseIfLarge()`**: Today's `stackInto` (`inpaint_worker.js:330-337`) does not call `releaseIfLarge()`; its arena chunk is reused across all tile-row bands of a wand or filter pass and released by the idle trim. K10c preserves this exact behavior.
   - **Idle trim (`keepMB` / `IDLE_MS`)**: Whenever a job finishes (`pxJobEnd()`), `HOLDS` decrements to `0` and `armTrim()` sets a `2000 ms` (`IDLE_MS`) timer (`trimDue`). When `HOLDS === 0` after 2 s and `PX.byteLength > mb("keepMB")` (`DEFAULT_ROUTES.keepMB = 16` MiB), `drop(mb("keepMB"), "idle")` replaces the instance via `renew("idle", PX)`.

3. **Byte Budget at 15,000 × 10,000 *(inferred from `PART_BYTES = 8 MiB` and `TILE = 256`)*:**
   - **Export part (`png_part` / `psd_part`)**: At `W = 15,000`, one row is `60,000` bytes. `PART_BYTES = 8,388,608` gives `rows = 139` (`8,340,000` bytes = `7.95 MiB` per RGBA band; `2,085,000` bytes = `1.99 MiB` per 1-channel mask/coverage buffer).
   - **Peak arena per worker during `png_part` on an `L`-layer stack**:
     - `pd` (band destination): `7.95 MiB`
     - `psrc` per layer with tiles in the band: `7.95 MiB * L` (plus `1.99 MiB` per masked layer's `pm`, `1.99 MiB` per clipped layer's `pcov`, and `1.99 MiB` per clipped layer with a base mask `pbm`)
     - `pp` (`above` row, `1` row = `60 KB`, plus `60 KB * L` during its 1-row pass)
     - `pf` (`png_filter_rows` output, `139 * 60,001` bytes): `7.95 MiB`
     - `po` (`deflate_part` + 12-byte chunk frame, `storedCap(8,340,139) + 12`): `7.95 MiB`
     - Total per worker: approximately `(L + 3) * 7.95 MiB` (`31.8 MiB` for `L = 1`, `39.8 MiB` for `L = 2`), compared to today's `max(1 + L, 3) * 7.95 MiB` (`23.9 MiB` for `L = 2`).
     - Crossing `PX.byteLength > 256 MiB` (`268,435,456` bytes) requires `L >= 30` unmasked layers (`33 * 7.95 MiB = 262.4 MiB` plus instance base), `L >= 24` masked layers (`24 * 9.94 + 23.9 = 262.5 MiB`), or `L >= 17` clipped layers with both a base mask and an own mask (`17 * 13.92 + 23.9 = 260.5 MiB`) *(inferred)*. Below that, each of the 8 pool workers retains its consolidated `peak` chunk across parts of the export and trims below `keepMB = 16` MiB 2 s after the export finishes.
   - **Tile-row band (`stack_into` at `W = 15,000, rows = 256`)**: One RGBA band is `15,360,000` bytes (`14.65 MiB`), so `L = 2` layers takes `(1 + 2) * 14.65 MiB = 43.95 MiB` per worker, reused across bands and trimmed 2 s after the wand/filter completes *(inferred)*.

---

## 4. Which Copies Go Away

| Operation & Buffer | Before K10 (`3fd8bda7`) | After K10b / K10c | Saved per Part / Band *(inferred)* |
| :--- | :--- | :--- | :--- |
| **Tile-store `png_part` (`msg.tiles`)** | `rowsOfTiles` allocates JS `Uint8Array(W*rows*4)` + `prev` `Uint8Array(W*4)`, copies tile slices into JS, then `Px.pngPart` copies both into wasm via `_in`. | `tilesRowsToWasm` copies tile row slices directly into `pr` and `pp` in `p.job`. | Eliminates 1 full-band JS allocation + 1 full-band copy-in (`7.95 MiB` per part at 15k). |
| **Stack `png_part` (`msg.stack`)** | `rowsOfStack` allocates JS `dst` + `L` JS `src` bands + masks, `matchPixels` copies `src` in & out of wasm, `compositeTile` copies `dst` + `L` `src`s + masks into wasm and copies `dst` out to JS, then `Px.pngPart` copies `dst` and `prev` back into wasm. | `stackRowsToWasm` gathers tiles directly into `p.job`, runs `match_pixels` and `composite_tile` in place on `pd`, and passes `pd` and `pp` directly to `pngPartFromPtr`. | Eliminates `(L + 1)` JS band allocations, `2` wasm copies per matched layer, `1` copy-in of `dst + L*src + masks` into `composite_tile`, `1` copy-out of `dst`, and `1` copy-in of `dst` into `png_filter_rows`. |
| **Stack/Tile `psd_part` (K10c)** | `partRowsOf` builds JS `rgba` (via `rowsOfStack` or `rowsOfTiles`), then `Px.psdPackRows(rgba, w, rows)` copies `rgba` into wasm **once** (`_in`) and loops `ch = 0..3`. | `partPtrOf` leaves `pr` in `p.job` and `psdPackRowsFromPtr(a, pr, w, rows)` packs all 4 channels directly from `pr`. | Eliminates 1 wasm copy-in (`w * rows * 4` bytes = `7.95 MiB` per part at 15k) plus the JS `rgba` band allocation and all intermediate stack copies. |
| **Wand / Filter `stack_into` (K10c)** | For `layers.length > 0`, `rowsOfStack` gathers into JS `src` buffers, copies into wasm for `compositeTile`, and copies out into `into` (`SharedArrayBuffer`). (For `layers.length === 0`, `storeRows` writes directly into `into` without touching wasm.) | Keeps the direct JS gather when `layers.length === 0`; for `layers.length > 0`, `stackRowsToWasm` gathers and composites in `p.job`, then copies `pd` once into `into` (`p.get`). | Eliminates `L` JS `src` allocations, `1` wasm copy-in of `dst + L*src`, and `2` copies per matched layer when `L > 0`, with zero extra copies when `L === 0`. |
| **Clipped layer (`l.clip`, K10c)** | Allocates JS `cov = new Uint8Array(W*n)` and `bm = new Uint8Array(W*n)` per clipped layer, runs JS `clipCoverage`, then copies `mask` into wasm. | Allocates `pcov = a.take(px)` per clipped layer in `p.job`, gathers `l.clip` alpha and `c.mask` into wasm, and runs `clip_coverage` in place on `pcov`. | Eliminates 1–2 JS mask allocations and 1 wasm copy-in per clipped layer. |
| **Dissolve layer (`l.dissolve`, K10c)** | Copies `src` in JS (`if (l.sab)`), runs scalar JS `hash32` loop over `W*n` pixels, then copies `rowSrc` into wasm for `compositeTile`. | Gathers `psrc` directly into `p.job` and runs Rust `dissolve_rows` in place on `psrc`. | Eliminates JS scalar pixel loop and `l.sab` temporary JS clone. |

---

## 5. K10b Detailed Design: Gather, Composite, and `pngPart`

### 5.1 Tile Gather (`tilesRowsToWasm`)

In `renderer/editor/inpaint_worker.js`, `tilesRowsToWasm(p, msg, above, ptr)` mirrors `rowsOfTiles(msg, above)` (`:205-222`) line for line, guarding `if (!t) continue;` before `tileBytes(t)` and booking `copyIn` via `pxLapAdd` while `pxTimed()` is on (matching `mipsRust` at `:143-151`):

```js
export function tilesRowsToWasm(p, msg, above, ptr) {
    let tiles = msg.tiles, r0 = msg.r0 | 0, rows = msg.rows;
    if (above) {
        if (r0 > 0) { r0--; rows = 1; }
        else if (msg.prevTiles) { tiles = msg.prevTiles; r0 = TILE - 1; rows = 1; }
        else return false;
    }
    const w = msg.w, timed = pxTimed();
    const mem = p.u8();
    mem.fill(0, ptr, ptr + w * rows * 4);
    for (let tx = 0; tx * TILE < w; tx++) {
        const t = tiles[tx];
        if (!t) continue;
        const { bytes, shared } = tileBytes(t);
        const n = Math.min(TILE, w - tx * TILE) * 4;
        const c0 = timed ? now() : 0;
        for (let y = 0; y < rows; y++) {
            const so = (r0 + y) * TILE * 4;
            mem.set(bytes.subarray(so, so + n), ptr + (y * w + tx * TILE) * 4);
        }
        if (timed) pxLapAdd("copyIn", now() - c0, n * rows, shared);
    }
    return true;
}
```

### 5.2 Store Gather (`storeRowsToWasm`) and Stack Gather (`stackRowsToWasm`)

1. **`storeRowsToWasm(p, store, X0, W, Y0, n, ptr, alphaOnly = false)`**:
   Mirrors `storeRows(store, X0, W, Y0, n, out, alphaOnly)` (`inpaint_worker.js:230-254`; `:289-319` after K10b), returning `false` when no tile of `store` lies in the band (in which case `stackRowsToWasm` saves `scratchSrc = psrc` and reuses it on the next layer without a second `a.take(byteLen)`):
   ```js
   export function storeRowsToWasm(p, store, X0, W, Y0, n, ptr, alphaOnly = false) {
       const sx = store.x | 0, sy = store.y | 0;
       const y0 = Math.max(Y0, sy), y1 = Math.min(Y0 + n, sy + store.h);
       const x0 = Math.max(X0, sx), x1 = Math.min(X0 + W, sx + store.w);
       if (y1 <= y0 || x1 <= x0) return false;
       const mem = p.u8(), timed = pxTimed();
       let any = false;
       for (let lty = (y0 - sy) >> 8; lty * TILE < y1 - sy; lty++) {
           const names = store.tiles[lty];
           if (!names) continue;
           const ry0 = Math.max(y0, sy + lty * TILE), ry1 = Math.min(y1, sy + (lty + 1) * TILE);
           for (let ltx = (x0 - sx) >> 8; ltx * TILE < x1 - sx; ltx++) {
               const t = names[ltx];
               if (!t) continue;
               const { bytes, shared } = tileBytes(t);
               const cx0 = Math.max(x0, sx + ltx * TILE), cx1 = Math.min(x1, sx + (ltx + 1) * TILE), k = cx1 - cx0;
               any = true;
               const c0 = timed ? now() : 0;
               for (let Y = ry0; Y < ry1; Y++) {
                   const so = ((Y - sy - lty * TILE) * TILE + (cx0 - sx - ltx * TILE)) * 4, o = (Y - Y0) * W + cx0 - X0;
                   if (alphaOnly) {
                       for (let i = 0; i < k; i++) mem[ptr + o + i] = bytes[so + i * 4 + 3];
                   } else {
                       mem.set(bytes.subarray(so, so + k * 4), ptr + o * 4);
                   }
               }
               if (timed) pxLapAdd("copyIn", now() - c0, (ry1 - ry0) * k * (alphaOnly ? 1 : 4), shared);
           }
       }
       return any;
   }
   ```

2. **`stackRowsToWasm(p, a, msg, above = false, into = null)`**:
   Mirrors `rowsOfStack(msg, above, into)` (`inpaint_worker.js:269-323`). When `pngPart` needs the `above` row (`msg.y > 0`), it calls `stackRowsToWasm(p, a, msg, true, null)` as a **separate** 1-row call from `stackRowsToWasm(p, a, msg, false, null)` so that the `above` row and the `msg.rows` band each have their own independent `storeRowsToWasm` skip and their own `count > 0` guard:
   ```js
   export function stackRowsToWasm(p, a, msg, above = false, into = null) {
       let Y0 = msg.y | 0, n = msg.rows;
       if (above) {
           if (Y0 <= 0) return 0;
           Y0--;
           n = 1;
       }
       const W = msg.w, X0 = msg.x0 | 0, st = msg.stack;
       const px = W * n, byteLen = px * 4, timed = pxTimed();
       const pd = a.take(byteLen);
       if (st.base) {
           p.u8().fill(0, pd, pd + byteLen);
           storeRowsToWasm(p, st.base, X0, W, Y0, n, pd, false);
       } else if (into && !msg.clear) {
           const c0 = timed ? now() : 0;
           p.u8().set(into, pd);
           if (timed) pxLapAdd("copyIn", now() - c0, byteLen, true);
       } else {
           p.u8().fill(0, pd, pd + byteLen);
       }
       const maxL = st.layers.length;
       const srcPtrs = new Uint32Array(maxL);
       const maskPtrs = new Uint32Array(maxL);
       const opsArr = new Uint8Array(maxL);
       const alphasArr = new Uint8Array(maxL);
       let count = 0, scratchSrc = 0;
       for (const l of st.layers) {
           const psrc = scratchSrc || a.take(byteLen);
           if (l.sab) {
               scratchSrc = 0;
               const sabView = new Uint8Array(l.sab, (Y0 - (msg.y0 | 0)) * W * 4, byteLen);
               const c0 = timed ? now() : 0;
               p.u8().set(sabView, psrc);
               if (timed) pxLapAdd("copyIn", now() - c0, byteLen, true);
           } else {
               p.u8().fill(0, psrc, psrc + byteLen);
               if (!storeRowsToWasm(p, l, X0, W, Y0, n, psrc, false)) {
                   scratchSrc = psrc;
                   continue;
               }
               scratchSrc = 0;
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
   export function partPtrOf(p, a, msg, needPrev = false) {
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

Note that `p._reset(a)` and `releaseIfLarge()` run **before** `kernel: now() - t0` is computed on both arms so `timing.kernel` includes arena reset and instance renewal identically on both arms, and `composeWasm` is numeric (`1` or `0`) so `native_test.py`'s numeric aggregator sums it across jobs:

```js
export async function pngPart(msg) {
    let p = rustPx();
    if (!p) throw new Error(NO_PARTS);
    const t0 = now();
    const level = msg.level === undefined ? PNG_LEVEL : msg.level;
    const laps = {};
    const routeName = msg.stack ? "composeStack" : "composeTiles";
    if (!msg.rgba && route(routeName) !== "js") {
        const a = p.job;
        let r = null, tc = 0, tp = 0;
        try {
            ({ pr: r, tc, tp } = (() => {
                const ptrs = partPtrOf(p, a, msg, true);
                const res = p.pngPartFromPtr(a, ptrs.pr, msg.w, msg.rows, ptrs.pp, level, !!msg.last, laps);
                return { pr: res, tc: ptrs.tc, tp: ptrs.tp };
            })());
        } catch (err) {
            if (!recovered(p, err, "png_part")) throw err;
        } finally {
            p._reset(a);
            releaseIfLarge();
        }
        if (r) {
            return {
                chunk: r.chunk.buffer, adler: r.adler, raw: r.raw, crc: r.crc,
                transfer: [r.chunk.buffer],
                timing: {
                    op: "png_part", kernels: "rust", composeWasm: 1,
                    pixels: msg.w * msg.rows, kernel: now() - t0,
                    compose: msg.stack ? tc - t0 : 0, rows: tc - t0, prev: tp - tc, ...laps,
                },
            };
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
    const prev = msg.rgba ? (msg.prev ? new Uint8Array(msg.prev, 0, msg.w * 4) : null) : msg.stack ? rowsOfStack(msg, true) : rowsOfTiles(msg, true);
    const tp = now();
    const r = p.pngPart(rgba, msg.w, msg.rows, prev, level, !!msg.last, laps);
    releaseIfLarge();
    return {
        chunk: r.chunk.buffer, adler: r.adler, raw: r.raw, crc: r.crc,
        transfer: [r.chunk.buffer],
        timing: {
            op: "png_part", kernels: "rust", composeWasm: 0,
            pixels: msg.w * msg.rows, kernel: now() - t0,
            compose: msg.stack ? tc - t0 : 0, rows: tc - t0, prev: tp - tc, ...laps,
        },
    };
}
```

---

## 6. K15's Future `tiffStrip` Contract (`tiffPartJob`)

K15 (`docs/PLAN_WASM_BUILD.md` §4.6) will add `tiff_predict_rgba(rgba: *mut u8, w: usize, rows: usize)` in Rust and move `tiffPartJob` (`inpaint_worker.js:481-491`) onto K10b's `partPtrOf(p, a, msg, false)` helper:

1. **Signature of `Px.tiffStripFromPtr(a, pr, w, rows, level, predictor = 2, laps = null)`**:
   - `rawLen = w * rows * 4`, `const lap = laps ? lapper(laps) : null;`.
   - Calls `this.exports.tiff_predict_rgba(pr, w, rows)` in place on `pr` **only when `(predictor === undefined ? 2 : predictor) === 2`** (`if (lap) lap("predict")`).
   - Computes `const adler = this.exports.adler32(pr, rawLen, 1) >>> 0;` (**3 arguments with `start = 1`**).
   - Loops with signed `written`, capacity doubling, and the fixed `0x78, 0x9C` zlib header (matching `Px.zlib` at `px.js:1109-1121`, which always writes `78 9C` regardless of `level`):
     ```js
     let cap = storedCap(rawLen);
     for (;;) {
         const po = a.take(cap + 6);
         const written = this.exports.deflate_part(pr, rawLen, level, 1, po + 2, cap);
         if (lap) lap("deflate");
         if (written >= 0) {
             const t = TIMED ? clock() : 0;
             const out = this.u8();
             out[po] = 0x78;
             out[po + 1] = 0x9C;
             const end = po + 2 + written;
             out[end] = adler >>> 24; out[end + 1] = (adler >>> 16) & 255;
             out[end + 2] = (adler >>> 8) & 255; out[end + 3] = adler & 255;
             const strip = out.slice(po, end + 4);
             if (TIMED) lapOut(t, written + 6);
             return { chunk: strip.buffer, raw: rawLen };
         }
         cap *= 2;
     }
     ```
2. **Worker `tiffPartJob(msg)` contract (`inpaint_worker.js:481-491`)**:
   - Level defaults to `const level = msg.level === undefined ? PNG_LEVEL : msg.level;` (`PNG_LEVEL = 2`).
   - **Explicit `!p` or `"js"` route arm (today's exact lines from `inpaint_worker.js:483-490`)**:
     ```js
     const rgba = partRowsOf(msg);
     const t1 = now();
     const r = await tiffPart({ rgba, w: msg.w, rows: msg.rows, predictor: msg.predictor }, (bytes) => (p ? p.zlib(bytes, level) : deflate(bytes)), laps);
     releaseIfLarge();
     return { chunk: r.chunk, raw: r.raw, transfer: [r.chunk], timing: { op: "tiff_part", kernels: kernelsInUse(), composeWasm: 0, pixels: msg.w * msg.rows, kernel: now() - t0, rows: t1 - t0, ...laps } };
     ```
   - On the pointer path (`p && !msg.rgba && route("tiffStripWasm") !== "js"`), runs `const { pr, tc } = partPtrOf(p, a, msg, false); const r = p.tiffStripFromPtr(a, pr, msg.w, msg.rows, level, msg.predictor, laps);` inside `try / catch (err) { if (!recovered(p, err, "tiff_part")) throw err; } finally { p._reset(a); releaseIfLarge(); }`, falling back on recovery to a fresh `rustPx()` and the exact `tiffPart(...)` arm above.

---

## 7. K10c Detailed Design: `psdPart` and `stackInto`

### 7.1 `psdPart(msg)` (`renderer/editor/inpaint_worker.js:466-475`)

Both arms keep `rows` and `pack` in `timing` (so `PLAN_WASM_BUILD.md` §5's K10c row `pack 5,220, rows 3,106` is measured on both arms) and run `p._reset(a)` / `releaseIfLarge()` before `kernel: now() - t0`:

```js
export async function psdPart(msg) {
    const t0 = now();
    let p = rustPx();
    if (p && !msg.rgba && route("psdPartWasm") !== "js") {
        const a = p.job;
        let packed = null, t1 = 0, t2 = 0;
        try {
            const ptrs = partPtrOf(p, a, msg, false);
            t1 = ptrs.tc;
            packed = p.psdPackRowsFromPtr(a, ptrs.pr, msg.w, msg.rows);
            t2 = now();
        } catch (err) {
            if (!recovered(p, err, "psd_part")) throw err;
        } finally {
            p._reset(a);
            releaseIfLarge();
        }
        if (packed) {
            const channels = packed.map((c) => ({ lens: c.lens.buffer, data: c.data.buffer }));
            return {
                channels,
                transfer: channels.flatMap((c) => [c.lens, c.data]),
                timing: {
                    op: "psd_part", kernels: "rust", composeWasm: 1,
                    pixels: msg.w * msg.rows, kernel: now() - t0,
                    compose: msg.stack ? t1 - t0 : 0, rows: t1 - t0, pack: t2 - t1,
                },
            };
        }
        await pxSettled();
    }
    const rgba = partRowsOf(msg);
    const t1 = now();
    const packed = psdPackRows(rgba, msg.w, msg.rows);
    const t2 = now();
    releaseIfLarge();
    const channels = packed.map((c) => ({ lens: c.lens.buffer, data: c.data.buffer }));
    return {
        channels,
        transfer: channels.flatMap((c) => [c.lens, c.data]),
        timing: {
            op: "psd_part", kernels: kernelsInUse(), composeWasm: 0,
            pixels: msg.w * msg.rows, kernel: now() - t0,
            compose: msg.stack ? t1 - t0 : 0, rows: t1 - t0, pack: t2 - t1,
        },
    };
}
```

### 7.2 `stackInto(msg)` (`renderer/editor/inpaint_worker.js:330-337`)

When `msg.stack.layers.length === 0` (e.g. a 1-layer document or a band no layer touches), `rowsOfStack` writes base tiles straight into `into` without touching wasm. Keeping that early exit ahead of the pointer path avoids copying a base-only band into wasm and back out:

```js
export async function stackInto(msg) {
    const t0 = now();
    const byteLen = msg.w * msg.rows * 4;
    const at = ((msg.y | 0) - (msg.y0 | 0)) * msg.w * 4;
    const into = new Uint8Array(msg.sab, at, byteLen);
    let p = rustPx();
    if (p && msg.stack.layers.length > 0 && route("stackIntoWasm") !== "js") {
        const a = p.job;
        let ok = false;
        try {
            const pd = stackRowsToWasm(p, a, msg, false, into);
            p.get(Uint8Array, pd, byteLen, into);
            ok = true;
        } catch (err) {
            if (!recovered(p, err, "stack_into")) throw err;
        } finally {
            p._reset(a);
        }
        if (ok) {
            return {
                timing: {
                    op: "stack_into", kernels: "rust", composeWasm: 1,
                    pixels: msg.w * msg.rows, kernel: now() - t0,
                },
            };
        }
        await pxSettled();
    }
    if (msg.clear) into.fill(0);
    rowsOfStack(msg, false, into);
    return {
        timing: {
            op: "stack_into", kernels: kernelsInUse(), composeWasm: 0,
            pixels: msg.w * msg.rows, kernel: now() - t0,
        },
    };
}
```

---

## 8. The Argument That the Bytes Stay Equal

1. **Tile Gather (`tilesRowsToWasm` vs `rowsOfTiles`) and Store Gather (`storeRowsToWasm` vs `storeRows`)**:
   - `tilesRowsToWasm(p, msg, above, ptr)` uses the exact same `above` branch (`if (r0 > 0) { r0--; rows = 1; } else if (msg.prevTiles) { tiles = msg.prevTiles; r0 = TILE - 1; rows = 1; } else return false;`), zero-initialization (`fill(0)`), null-tile guard (`const t = tiles[tx]; if (!t) continue; const { bytes } = tileBytes(t);`), and row-slice bounds (`n = Math.min(TILE, w - tx * TILE) * 4`, `so = (r0 + y) * TILE * 4`, destination `ptr + (y * w + tx * TILE) * 4`) as `rowsOfTiles` (`inpaint_worker.js:205-222`).
   - `storeRowsToWasm(p, store, X0, W, Y0, n, ptr, alphaOnly)` uses the exact same clipping (`[y0, y1)` and `[x0, x1)` against `sx = store.x | 0, sy = store.y | 0, store.w, store.h`), tile index loops (`lty`, `ltx`), null-tile guard (`const t = names[ltx]; if (!t) continue; const { bytes } = tileBytes(t);`), per-row source offset `so = ((Y - sy - lty * TILE) * TILE + (cx0 - sx - ltx * TILE)) * 4`, destination offset `o = (Y - Y0) * W + cx0 - X0`, and boolean `any` return as `storeRows` (`inpaint_worker.js:230-254`).

2. **`match_pixels` (`crates/px/src/cmatch.rs:16-91`)**:
   - `stackRowsToWasm` runs `match_pixels` only on non-`sab` layers after `storeRowsToWasm` returns `true` (`if (!storeRowsToWasm(...)) continue;`), passing the same 10 `f32` parameters (`l.match[0..10]`) to the same `p.exports.match_pixels(psrc, px, pp)` export that `Px.matchPixels` calls today (`px.js:366-375`).

3. **`clip_coverage` (`crates/px/src/composite.rs` vs `inpaint_raster.js:266-272`)**:
   - For each clipped layer (`if (l.clip)`), `stackRowsToWasm` allocates a fresh `pcov = a.take(px)`, zero-fills it, and gathers `l.clip`'s alpha bytes into `pcov` via `storeRowsToWasm(p, c, X0, W, Y0, n, pcov, true)`. If `c.mask` is present, it allocates `pbm = a.take(px)`, zero-fills it, and gathers `{ x: c.x, y: c.y, w: c.w, h: c.h, tiles: c.mask }` into `pbm`.
   - Both JS `clipCoverage(cov, bm, c.alpha, mask)` and Rust `clip_coverage(pcov, px, pbm, c.alpha, pm)` apply the exact same integer formula `mul255(x, y) = ((x * y + 128) + ((x * y + 128) >> 8)) >> 8` in place on `cov[i]` in the exact same order: first `bm[i]` (if non-null), then `c.alpha` (if `< 255`), then `own[i]` (if non-null). Both scalar and `simd::mul255` (`composite.rs:732-739`) compute `((x * y + 128) + ((x * y + 128) >> 8)) >> 8` identically for all `x, y in 0..=255`.

4. **`dissolve_rows` (`crates/px/src/composite.rs` vs `inpaint_worker.js:294-315` & `blend_modes.js:146-157`)**:
   - Both JS and Rust skip pixels with `srcA == 0`, read `m = mask ? mask[o] : 255`, and compute `cVal = mul255(mul255(srcA, l.alpha), m)` in 32-bit unsigned integer arithmetic.
   - Both compute `imgX = (X0 + c) >>> 0`, `imgY = (Y0 + r) >>> 0`, and `hash32(imgX, imgY, seed)` using `wrapping_mul(0x9E3779B1)` (`Math.imul(x, 0x9E3779B1)`), `wrapping_mul(0x85EBCA77)` (`Math.imul(y, 0x85EBCA77)`), XOR with `seed >>> 0`, and `lowbias32` (`0x7feb352d`, `0x846ca68b`).
   - Both evaluate `keep = (cVal == 255) || ((hash32(imgX, imgY, seed) >>> 24) < cVal)` (testing the **top byte** `>> 24` with the explicit `cVal == 255` short-circuit so fully opaque pixels whose top hash byte is `255` are always kept).
   - Both set `src[idx + 3] = 255` on keep, or zero `src[idx..idx + 4]` on drop, and push the layer into `composite_tile` with `op = 0` (source-over), `alpha = 255`, and `mask = 0` (`null`).

5. **Active-Layer Skip, `count > 0` Guard, and Separate `above` Pass (`stackRowsToWasm` vs `rowsOfStack`)**:
   - A non-`sab` layer with no tiles intersecting the row range returns `false` from `storeRowsToWasm` and is skipped (`continue`) before `match_pixels`, mask gather, clip gather, and dissolve.
   - `composite_tile` is called **only when `count > 0`**. When `count === 0`, `pd` is untouched by `composite::begin` / `composite::end`, preserving soft-alpha base pixels (`0 < A < 255`) and RGB values under `A = 0` byte-for-byte.
   - When `pngPart` needs the `above` row (`msg.y > 0`), `stackRowsToWasm(p, a, msg, true, null)` runs as its own separate 1-row pass (`Y0 = msg.y - 1, n = 1`), with its own `storeRowsToWasm` skip and its own `if (count > 0)` guard.

6. **Filter, Adler-32, Deflate, CRC-32, and PSD Pack (`pngPartFromPtr` & `psdPackRowsFromPtr`)**:
   - `pngPartFromPtr` calls the exact same `png_filter_rows`, `adler32(pf, n, 1)` (with `start = 1`), `deflate_part` (with signed `written >= 0` check and `cap *= 2` retry loop), and `png_chunk_frame` exports in the exact same order as `Px.pngPart`.
   - `psdPackRowsFromPtr` calls `psd_pack_rows_cap(w, rows)` and `psd_pack_rows(pr, w, rows, ch, po, cap, pl)` for `ch = 0..3` on the same `pr` buffer, checking `if (n < 0)`, identically to `Px.psdPackRows`.

---

## 9. Tests, Mutants, Gates, and Deciding Rows

### 9.1 `tools/px_test.js` & `tools/boxstack_test.js` Unit and Parity Tests

`node tools/px_test.js` loads both `renderer/editor/px/px.wasm` (SIMD) and `renderer/editor/px/px_scalar.wasm` (scalar) directly via `PX_DIR` (`tools/px_test.js:34`) and imports the exported worker functions (`tilesRowsToWasm`, `storeRowsToWasm`, `stackRowsToWasm`, `partPtrOf`, `pngPart`, `psdPart`, `stackInto`, `rowsOfTiles`, `storeRows`, `rowsOfStack`, `stackPoints`) from `renderer/editor/inpaint_worker.js`. Tile entries in Node tests use `{ data: Uint8Array.buffer }` (handled directly by `tileBytes(t)` at `inpaint_worker.js:87` without needing `ARENA`).

#### K10b (`tools/px_test.js`):
1. **Tile-gather (`tilesRowsToWasm` + `pngPartFromPtr` vs `rowsOfTiles` + `Px.pngPart`)**:
   Build real tile-row messages via `await tileRows(snap, true).part(y, n, true)` (using a stub `snap = { width: w, height: h, tileRowNames: (ty) => ... }`, plus `w` and `rows: n` on the job message) and assert byte-identical `{ chunk, bytes, adler, raw, crc }` across all three `prev` states:
   - Top of image (`ty === 0, r0 === 0, prevTiles: null` -> `pp === 0`).
   - **Tile-row boundary (`ty > 0, r0 === 0, prevTiles: snap.tileRowNames(ty - 1)` -> `pp` gathers row `TILE - 1` (`255`) of `prevTiles`)**.
   - Mid-tile-row (`r0 > 0, prevTiles: null` -> `pp` gathers row `r0 - 1` of `msg.tiles`), plus sparse `null` tile entries (`tiles[tx] === null`) and widths not divisible by `TILE` (e.g. `w = 300`).
2. **Stack-gather (`stackRowsToWasm` + `pngPartFromPtr` vs `rowsOfStack` + `Px.pngPart`)**:
   Build stack messages both via `await stackRows(w, h, stores).part(y, n, true)` (where `stores = [base, ...layers]`, each with `snap = { width, height, tileRowNames }`) and direct `msg = { w, rows: n, y, x0, y0, stack }` on a base that includes **soft-alpha pixels (`R = 200, G = 100, B = 50, A = 10` and `A = 128`) and non-zero RGB under `A = 0`**, and assert byte-identical output for:
   - **(a) Empty layer set (`layers: []`)** — verifies `composite_tile` is not called when `count === 0` and soft-alpha / `A = 0` base bytes stay verbatim.
   - **(b) Layer in `msg.stack.layers` whose tiles do not overlap `[Y0, Y0 + n)` or `[X0, X0 + W)` (e.g. tiles only at `ltx = 1` when `W = 256, X0 = 0`, or `tiles: { 0: [null] }`)** — directly reaches `storeRowsToWasm` returning `false` and verifies `continue` skips the layer so `count === 0`.
   - **(c) Layer starting right on a part boundary (`y = 256`, tiles only in `ty = 1`) and layer ending right on a part boundary (`y = 256`, tiles only in `ty = 0`, included by `stackRows` because `part(256, n, true)` calls `args(255, 256 + n)`)** — verifies that compositing `above` (`row 255`) in its own separate pass matches `rowsOfStack(msg, true)` and `rowsOfStack(msg, false)` byte-for-byte.
   - **(d) Offset and negative-offset layers (`x: 300, y: 140` and `x: -50, y: -30`) and non-zero `x0` (`x0: 128`)** — verifies `storeRowsToWasm` clipping and coordinate offsets on layers, masks (`l.mask`), and clip bases (`l.clip`).
   - **(e) Color-matched layer (`l.match` with 10 floats: `meanS[3], meanT[3], scale[3], k`)** between other blend layers.
   - **(f) Two layers clipped to the same base (`l.clip`), where the clip base has transparent holes (`A = 0`), a soft-alpha ramp, and `c.mask`, and the two clipped layers have different own `l.mask`s** — verifies `l.clip` alpha is gathered and each clipped layer gets its own `pcov` buffer without aliasing.
   - **(g) Dissolve layer (`l.dissolve` seed)** on tiles containing both partial coverage (`0 < cVal < 255`) and **fully opaque pixels (`cVal === 255`) across coordinates where `hash32(imgX, imgY, seed) >>> 24 === 255`**.
   - **(h) Stale-view / `memory.grow` test on a fresh instance**: instantiate a fresh `const freshPx = new Px(new WebAssembly.Instance(simdPx.module, {}), simdPx.module);`, record `const buf0 = freshPx.memory.buffer;`, run `stackRowsToWasm` on a multi-layer band (`> 2 MiB`) that forces `freshPx.memory.buffer` to grow, **assert `freshPx.memory.buffer !== buf0`**, and assert byte equality against `rowsOfStack`.
3. **Route & Fallback Parity**:
   - Assert that `composeTiles = "js"` and `composeStack = "js"` return `timing.composeWasm === 0` and produce identical bytes to the default `"rust"` route (`timing.composeWasm === 1`).
   - Simulate an OOM / trap on the pointer path and verify `recovered(p, err, "png_part")` renews the instance and the fallback produces identical bytes without throwing `NO_PARTS`.

#### K10c (`tools/px_test.js` & `tools/boxstack_test.js`):
1. **`clip_coverage` Parity (SIMD + Scalar vs JS `clipCoverage`)**:
   - Exhaustive / dense sweep in `px_test.js` varying **all four inputs**: initial `cov` (`0..255`, representing gathered `l.clip` alpha including `0` holes, mid-values, and `255`), `base_mask` (null vs `0..255`), `alpha` (`0, 1, 127, 128, 129, 254, 255`), and `own` (null vs `0..255`), across lengths `0, 1, 7, 15, 16, 17, 31, 32, 33, 256, 1024`. Assert 0 ULP (exact byte equality) against `inpaint_raster.js`'s `clipCoverage`.
2. **`dissolve_rows` Parity (SIMD + Scalar vs JS dissolve loop)**:
   - Test across positive, zero, and negative `(x0, y0)`, varying `alpha` (`0..255`), `mask` (null and non-null), and `seed`, specifically including pixels where `srcA = 0`, where `0 < cVal < 255`, and where **`cVal === 255` at coordinates where `(hash32(imgX, imgY, seed) >>> 24) === 255`** (which would be dropped without the `c_val == 255` short-circuit). Assert exact byte equality against `rowsOfStack` on a tile-backed dissolve layer.
3. **`psdPart` and `stackInto` Pointer-Path Parity**:
   - Compare `psdPackRowsFromPtr` against `Px.psdPackRows` across tile and stack messages (including offset layers, matched layers with 10 floats, two clipped layers with transparent holes in `l.clip`, and dissolve layers).
   - Compare `stackInto` on the pointer path (`stackRowsToWasm` + `p.get`) against `rowsOfStack(msg, false, into)` across:
     - Multi-band `stack_into` jobs where **`msg.y !== msg.y0`** (e.g. `y0 = 0`, bands at `y = 0, 256, 512`) and `msg.x0 !== 0`, verifying each band writes to `at = (msg.y - msg.y0) * msg.w * 4` without overwriting earlier bands.
     - A filter band with **`l.sab` at `y > y0` and `l.dissolve != null`** (without `l.match`, since `l.sab` is never matched), verifying `(Y0 - msg.y0) * W * 4` offset calculation and that `l.sab` is never mutated in place.
     - Both `msg.clear = true` and `msg.clear = false` over a pre-populated half-transparent `into` buffer, plus the `layers: []` base-only early exit.
   - Verify `route("clipCoverage") = "js"` and `route("dissolveRows") = "js"` inside `stackRowsToWasm` run the JS loops on wasm memory and produce identical bytes.
4. **`tools/boxstack_test.js` Additions**:
   - Add test cases to `tools/boxstack_test.js` calling `compositeBox([base, ...layers], X0, Y0, W, H, pw, ph)` (where each layer has a `px` object with `tileAt(ltx, lty)` and `rowsOfStack` receives the matching `{ x, y, w, h, tiles }` store with non-empty clip base tiles) for (a) a clipped layer (`l.clip` with transparent holes, `c.mask`, `c.alpha`, and `l.mask`) and (b) a dissolve layer (`l.dissolve` with partial alpha and `cVal === 255` pixels), **and assert against a frozen, hand-computed expected byte array / checksum** (in addition to `rowsOfStack`) so mutating the shared `hash32` or `clipCoverage` fails `boxstack_test.js` directly.

### 9.2 Mutation Plan

Every mutant is applied one at a time, tested, and reverted before commit:

- **K10b Mutants**:
  1. `storeRowsToWasm` in `inpaint_worker.js`: drop `if (!storeRowsToWasm(...)) continue;` so an empty layer is counted — killed by `node tools/px_test.js` (case 2b: layer with no tiles in the band over soft-alpha base).
  2. `stackRowsToWasm` in `inpaint_worker.js`: remove `if (count > 0)` guard before `composite_tile` — killed by `node tools/px_test.js` (case 2a: `layers: []` over soft-alpha / `A = 0` base).
  3. `tilesRowsToWasm` in `inpaint_worker.js`: change `r0 = TILE - 1` on the `msg.prevTiles` branch to `r0 = 0` — killed by `node tools/px_test.js` (case 1: `r0 === 0` with `prevTiles`).
  4. `storeRowsToWasm` in `inpaint_worker.js`: ignore `store.x` / `X0` (`const sx = 0`) — killed by `node tools/px_test.js` (case 2d: offset layer).
  5. `stackRowsToWasm` in `inpaint_worker.js`: reuse a single `pcov` buffer across clipped layers instead of allocating per clipped layer — killed by `node tools/px_test.js` (case 2f: two clipped layers with different own masks).
  6. `stackRowsToWasm` in `inpaint_worker.js`: mutate the inline JS dissolve loop (`>>> 24` to `>>> 16`) or skip the inline `clipCoverage(covView, ...)` call — killed by `node tools/px_test.js` (cases 2f and 2g).
  7. `stackRowsToWasm` in `inpaint_worker.js`: hold `const mem = p.u8()` before the layer loop and use `mem` after `a.take` — killed by `node tools/px_test.js` (case 2h: fresh-instance `memory.grow` test).

- **K10c Mutants (one per copy of `clip_coverage` and `dissolve_rows`)**:
  1. **Rust `clip_coverage` & `dissolve_rows` (`crates/px/src/composite.rs`)**: remove the `c_val == 255` short-circuit (or change `>> 24` to `& 255`) in `dissolve_rows`, and drop `if !own.is_null()` in `clip_coverage` — killed by `node tools/px_test.js` on both `px.wasm` and `px_scalar.wasm`.
  2. **Shared JS `clipCoverage` (`renderer/editor/inpaint_raster.js:266`) and `hash32` (`renderer/editor/blend_modes.js:155`)**: mutate `mul255` in `clipCoverage` or `0x9E3779B1` in `hash32` — killed by `node tools/px_test.js` (Rust vs JS parity) and `node tools/boxstack_test.js` (frozen expected output).
  3. **Main-thread `compositeBox` (`renderer/editor/inpaint_boxstack.js:93, 106`)**: mutate `< cVal` to `<= cVal` in `compositeBox`'s dissolve loop — killed by `node tools/boxstack_test.js` and `blendmodes` gate step `o`.
  4. **Worker `stackRowsToWasm` inline JS fallback (`renderer/editor/inpaint_worker.js`)**: mutate `>>> 24` to `>>> 16` in `stackRowsToWasm`'s `"js"` route dissolve branch — killed by `node tools/px_test.js` (`route("dissolveRows") = "js"` parity test) and the `export` gate's `dissolveRows=js` step.
  5. **Worker `rowsOfStack` (`renderer/editor/inpaint_worker.js:292, 305`)**: mutate `>>> 24` to `>>> 16` in `rowsOfStack`'s dissolve loop — killed by `node tools/px_test.js` (`composeStack=js` parity test) and the `export` gate's `composeStack=js` step.
  6. **Worker `stackPoints` (`renderer/editor/inpaint_worker.js:399, 412`)**: mutate `>>> 24` to `>>> 16` in `stackPoints`'s dissolve loop — killed by `tools/export_test.py` (`stack_points` step, extended in K10c to include a dissolve layer under a matched layer).

### 9.3 Gates, A/B Protocol, and Deciding Rows

#### Gate Steps Added in K10b and K10c (`tools/export_test.py`):
- **K10b**: Extend `tools/export_test.py` with a step on tiles (using a multi-tile document with offset, clipped, dissolve, and matched layers) that:
  1. Runs `writePng` / `encodeTilePixels` on default routes and asserts from the worker job timings that `timing.composeWasm >= 1` ran on both `composeTiles` and `composeStack` parts.
  2. Sets `setRoute("composeTiles", "js")` and `setRoute("composeStack", "js")`, re-runs the exports, asserts `timing.composeWasm === 0`, and asserts the resulting PNG / store bytes are byte-for-byte identical to the `"rust"` route.
- **K10c**: Extend `tools/export_test.py` with:
  1. Assertions on default routes that `psd_part` and `stack_into` report `timing.composeWasm >= 1` **and** `timing.pxCalls.dissolve_rows > 0` and `timing.pxCalls.clip_coverage > 0` (verifying the Rust exports actually ran), and produce byte-identical PSD files and wand/band buffers when `psdPartWasm`, `stackIntoWasm`, `clipCoverage`, and `dissolveRows` are set to `"js"` (with `timing.pxCalls.dissolve_rows` / `clip_coverage` absent on `"js"`).
  2. A dissolve layer in the `stack_points` gate step so `stackPoints`'s dissolve copy is exercised and kills Mutant #6.

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

#### 15,000 × 10,000 A/B Protocol, Historical Reference, and Deciding Rows:
- **Historical W0b Reference (`docs/measurements/w0b_2026-10-23/summary.txt`, measured 2026-10-23 at `249d882`, predating D0, W1, K3, and K6)**:
  - `native_test.py`: `export_png` `1,960 ms` (`1,862–1,964`; `png_part` `14,486 ms`: `deflate 7,075`, `filter 4,571`, `compose 1,328`, `chunk 911`), `export_psd` `1,314 ms` (`1,203–1,379`; `psd_part` `8,803 ms`: `pack 5,220`, `rows 3,106`), `export_ora` `5,028 ms` (`4,858–6,565`), `open_psd` `12,987 ms` (`12,849–16,193`, `stored` `2,413 ms`), `open_ora` `7,491 ms` (`7,376–8,381`, `stored` `2,480 ms`), `wand_whole_picture` `1,733 ms` (`1,686–1,861`; `stack_into` 40 jobs `2,517 ms`), `filter_wand` `2,054 ms` (`1,960–2,140`).
  - `exportperf:15000x10000` (limit / fill): `composite_bands` `1,586 / 1,658 ms`, `layer_from_tiles` `830 / 799 ms`, `psd / psd_masked` `2,161 / 2,422 ms` (limit) and `2,086 / 2,460 ms` (fill).
  - `tiffperf:15000x10000`: `open noise` `8,713 ms` (`8,513–9,566`, `stored` `4,612 ms`), `open own` `4,907 ms` (`stored` `2,025 ms`).
- **A/B Measurement Protocol (`docs/PLAN_WASM_BUILD.md` §1.1 & `brief.md`)**:
  - Acquire the busy lock (`python docs/measurements/w1_2026-11-06/w1_lock.py acquire "<who>"` / `release <token>`) per batch before any timing run.
  - Export a clean `before` tree at the session's base commit (`git archive` to a sibling temp directory with `node_modules` junctioned) and run **three alternating before / after rounds (`r1`, `r2`, `r3`)** with a fresh Electron instance per round on port `9629` (`--offline`), recording all raw logs and `summary.txt` under `docs/measurements/<session>_<date>/`.
  - In addition, add `--set NAME=V` (calling `InpaintEditor.setRoute(name, value)` in the window, as `px_probe.py` does) to `tools/native_test.py` and `tools/export_test.py` so individual routes (`composeTiles`, `composeStack`, `psdPartWasm`, `stackIntoWasm`, `clipCoverage`, `dissolveRows`) can be toggled in-session if a before/after row needs per-route isolation.
- **K10b Deciding Commands (`15000x10000`, 3 alternating before/after rounds)**:
  1. `python tools/native_test.py 15000x10000 build_the_file open_the_file add_the_paint_layer wand_whole_picture export_png export_psd export_ora open_psd open_ora match_export_png close` (decides `composeStack` on `export_png` and `match_export_png`, and `composeTiles` on `export_ora`, `open_psd` `stored`, and `open_ora` `stored`).
  2. `exportperf:15000x10000` (`python tools/export_test.py --perf 15000x10000` — decides `composeTiles` on `layer_from_tiles`).
  3. `tiffperf:15000x10000` (`python tools/tiff_test.py --size 15000x10000` — decides `composeTiles` on the `stored` step of `open noise` / `open own`).
  4. Memory retention check: `python tools/px_probe.py --retention 15000x10000` on `composeStack=js` vs `composeStack=rust` (verifying `after` per worker stays within the `(L + 3)` band budget, `later` trims at or below `keepMB = 16` MiB, and `release === 0` at `L = 1..2`).
- **K10c Deciding Commands (`15000x10000`, 3 alternating before/after rounds)**:
  1. **Stack + Match run (no filter layer, so `Matched` stays on the stack path)**:
     `python tools/native_test.py 15000x10000 build_the_file open_the_file add_the_paint_layer wand_whole_picture export_png export_psd export_ora match_export_png match_wand close` (asserting `composeWasm >= 1` on `match_export_png` and `match_wand`; decides `psdPartWasm` on `export_psd` and `stackIntoWasm` on `wand_whole_picture` and `match_wand`).
  2. **Filter band run (separate invocation)**:
     `python tools/native_test.py 15000x10000 open_the_file add_the_paint_layer filter_export_png filter_wand close` (decides `stackIntoWasm` on `programStart`'s filter bands).
  3. **Exportperf + Dissolve + Clipped runs**:
     - `python tools/export_test.py --perf 15000x10000` (decides `psd` and `psd_masked`).
     - `python tools/export_test.py --perf 15000x10000 --blend=dissolve` (and `--set dissolveRows=js` vs `rust`, deciding `dissolveRows`).
     - Add `--clipped` support to `tools/export_test.py --perf` (attaching `clip` to the top paint layer in the perf fixture when `--clipped` is passed) and run `python tools/export_test.py --perf 15000x10000 --clipped` with `--set clipCoverage=js` vs `rust` to decide `clipCoverage` at 15,000 × 10,000.
  4. **Memory retention check**: `python tools/px_probe.py --retention 15000x10000`, plus checking `InpaintEditor.pxInstances()` / worker `px_stats` after 15k `export_psd` and `wand_whole_picture` (asserting `after` per worker `<= 55 MiB` for 2 layers and `later <= 16 MiB` after the idle trim).
- **Tie & Loss Decision Rule (`docs/PLAN_WASM_BUILD.md` §1.1 rule 2)**:
  - When a whole-operation wall-time row ties (difference within the run spread), **the tie is decided by the summed `timing.kernel` row** for that job (`png_part` `timing.kernel` for `export_png` / `export_ora` / `stored`, `psd_part` `timing.kernel` for `export_psd`, `stack_into` `timing.kernel` for `wand_whole_picture` / `match_wand` / `filter_wand`), where both arms include arena reset and `releaseIfLarge()` inside `timing.kernel`.
  - If any of `composeTiles`, `composeStack`, `psdPartWasm`, `stackIntoWasm`, `clipCoverage`, or `dissolveRows` loses (or ties on both wall time and `timing.kernel`), its route entry in `DEFAULT_ROUTES` (`renderer/editor/px/kernels.js:80`) is set to `"js"` with a comment citing the deciding row and run date.

---

## 10. As Built — K10b (2026-11-09)

See `docs/measurements/k10b_2026-11-09/` (`k10b_chain.sh`, `summarize.py`, `summary.txt`, `summary_rows.txt`, `node_bench.mjs`, `before/`, `after/`, `retention/`, `node/`, `mutation/`).

- **Built (ABI 37 on branch `ag-chain-c` off `3fd8bda7`)**:
  - `crates/px/src/lib.rs`: bumped `px_abi_version()` (`:55-57`) from `36` to `37`. `px.wasm` (`259,180 B`, sha256 `3f240c7a80d2f983`; before at `3fd8bda7`: `259,180 B`, sha256 `7e99b55f37ff69ff`) and `px_scalar.wasm` (`210,462 B`, sha256 `0f3fe6c4448b871e`; before at `3fd8bda7`: `210,462 B`, sha256 `03ddfff981982e19`) rebuilt and verified with `python tools/build_px.py --check`.
  - `renderer/editor/px/px.js`: bumped `PX_ABI = 37` (`:14`); added `Px.prototype.pngPartFromPtr(a, pr, w, rows, pp, level, last, laps = null)` (`:1173-1198`).
  - `renderer/editor/px/kernels.js`: added `composeTiles: "kernel"` and `composeStack: "kernel"` to `ROUTE_KINDS` (`:62`).
  - `renderer/editor/inpaint_worker.js`: added and exported `tilesRowsToWasm`, `storeRowsToWasm`, `stackRowsToWasm`, and `partPtrOf`; exported `rowsOfTiles`, `storeRows`, `rowsOfStack`, `stackInto`, `stackPoints`, `pngPart`, `psdPart`; routed `pngPart(msg)` (`:680-734`) through `partPtrOf` + `p.pngPartFromPtr` when `!msg.rgba && route(routeName) !== "js"`, with `composeWasm: 1` on the pointer path and `composeWasm: 0` on `"js"` / trap recovery (`recovered(p, err, "png_part")`).
- **Tests & Mutation**:
  - `node tools/px_test.js` (`composeWasmPartCases` on both `simdPx` and `scalarPx`, cases 1, 2a–2h, 3) and `node tools/boxstack_test.js`: PASS.
  - `tools/export_test.py` (`compose_in_wasm_memory_matches_js_gather`, tile-only step, skipped on the canvas backend which has no tile parts): PASS on tiles (`k10b-both-tiles`, `k10b-export-tiles`).
  - Mutation (`docs/measurements/k10b_2026-11-09/mutation/mut_k10b.py`): 23/23 mutants killed, 0 survived.
- **15,000 × 10,000 A/B Summary (3 alternating rounds, fresh offline instances, focused, busy lock held per batch)**:
  - `native_test.py`:
    - `wand_whole_picture`: wall `1,253.0 [1,245.0-1,320.0]` vs `1,273.0 [1,270.0-1,294.0] ms` (`0.98x`, spreads overlap, untouched in K10b); `stack_into kernel` `2,155.5 [2,129.3-2,281.6]` -> `2,315.2 [2,297.6-2,342.4] ms` (`0.93x`, loss beyond spread, non-overlapping; `stackInto` and `rowsOfStack` did not change in K10b apart from `export`, cause unknown; K10c takes its baseline for `stackIntoWasm` from a fresh same-session A/B).
    - `export_png`: wall `1,010.0 [990.0-1,015.0]` -> `869.0 [868.0-899.0] ms` (`1.16x`, non-overlapping); `png_part kernel` `7,475.4 [7,359.9-7,511.8]` -> `6,514.7 [6,401.0-6,692.5] ms` (`1.15x`, non-overlapping); `png_part compose` `1,213.0 [1,183.6-1,217.4]` -> `609.6 [607.0-613.7] ms` (`1.99x`, non-overlapping).
    - `export_ora`: wall `2,255.0 [2,204.0-2,329.0]` -> `1,997.0 [1,977.0-2,090.0] ms` (`1.13x`, non-overlapping); `png_part kernel` `16,653.5 [16,210.9-17,225.2]` -> `14,715.5 [14,611.2-15,399.4] ms` (`1.13x`, non-overlapping); `png_part rows` `2,295.5 [2,139.5-2,330.0]` -> `1,057.2 [1,020.7-1,131.3] ms` (`2.17x`, non-overlapping).
    - `open_psd`: wall `6,466.0 [6,417.0-6,527.0]` -> `6,231.0 [6,167.0-6,333.0] ms` (`1.04x`, non-overlapping); `png_part kernel` `6,500.9 [6,463.2-6,615.6]` -> `6,352.4 [6,147.1-6,383.6] ms` (`1.02x`, non-overlapping); `png_part rows` `385.1 [378.4-385.2]` -> `195.8 [182.5-196.9] ms` (`1.97x`, non-overlapping).
    - `open_ora`: wall `4,845.0 [4,827.0-5,262.0]` vs `4,986.0 [4,910.0-5,167.0] ms` (`0.97x`, spreads overlap); `png_part kernel` `6,550.5 [6,306.2-6,635.7]` -> `6,300.7 [6,039.6-6,406.0] ms` (`1.04x`, passes §1.1 rule 2); `png_part rows` `402.6 [381.5-453.2]` -> `192.0 [163.7-207.7] ms` (`2.10x`, non-overlapping).
    - `match_export_png`: wall `1,058.0 [1,035.0-1,121.0]` -> `894.0 [869.0-1,178.0] ms` (`1.18x`, spreads overlap); `png_part kernel` `7,824.4 [7,751.4-8,339.5]` -> `6,637.6 [6,494.5-8,911.7] ms` (`1.18x`); `png_part compose` `1,535.6 [1,396.6-1,582.5]` -> `797.7 [742.9-851.8] ms` (`1.93x`, non-overlapping); `png_part rows` `1,739.1 [1,557.0-1,760.6]` -> `829.7 [776.0-899.4] ms` (`2.10x`, non-overlapping).
  - `export_test.py --perf`:
    - `layer_from_tiles`: wall `265.0 [255.0-273.0]` -> `200.0 [192.0-232.0] ms` (`1.32x`, non-overlapping); `png_part kernel` `1,949.5 [1,871.2-2,013.4]` -> `1,488.0 [1,435.8-1,743.7] ms` (`1.31x`, non-overlapping); `png_part rows` `538.8 [490.7-554.6]` -> `258.5 [191.4-318.1] ms` (`2.08x`, non-overlapping).
  - `tiff_test.py --size 15000x10000 --variant noise,own`:
    - `own`: `openMs` `4,100.0 [3,974.0-4,207.0]` -> `4,004.0 [3,990.0-4,093.0] ms` (`1.02x`); `openSteps stored` `1,211.0 [1,137.0-1,304.0]` -> `1,196.0 [1,188.0-1,201.0] ms` (`1.01x`); `open png_part kernel` `5,816.9 [5,371.3-6,009.9]` -> `5,288.5 [5,263.2-5,418.3] ms` (`1.10x`); `open png_part rows` `432.9 [390.5-458.5]` -> `199.0 [192.2-211.3] ms` (`2.18x`, non-overlapping).
    - `noise`: `openMs` `7,710.0 [7,478.0-7,838.0]` -> `7,616.0 [7,557.0-8,275.0] ms` (`1.01x`); `openSteps stored` `3,343.0 [3,336.0-3,463.0]` -> `3,435.0 [3,381.0-3,709.0] ms` (`0.97x`, spreads overlap); `open png_part kernel` `16,733.2 [16,581.2-17,028.0]` -> `17,033.5 [16,473.9-17,207.7] ms` (`0.98x`, does not pass the `timing.kernel` tie-breaker as deflate is `15.3-15.7 s` of it; `open png_part rows` `367.9 [336.9-371.2]` -> `187.6 [186.3-191.4] ms`, `1.96x`, non-overlapping).
  - `px_probe.py --retention 15000x10000`:
    - `composeStack=js` (`695.4 ms`, `after` max `37.12 MiB`, `later` max `1.06 MiB`, `releases = 0`) vs `composeStack=rust` (`440.6 ms`, `1.58x`, `after` max `42.25 MiB`, `later` max `1.06 MiB`, `releases = 0`).
  - Both `composeTiles` and `composeStack` win their deciding rows (`layer_from_tiles`, `export_ora`, `open_psd`, and `open_ora` for `composeTiles`; `export_png` for `composeStack`); neither is added to `DEFAULT_ROUTES`.

---

## 11. As Built — K10c (2026-11-09)

See `docs/measurements/k10c_2026-11-09/` (`k10c_chain.sh`, `summarize.py`, `summary.txt`, `summary_rows.txt`, `node_bench.mjs`, `retention_psd_wand.py`, `before/`, `after/`, `retention/`, `node/`, `mutation/`).

- **Built (ABI 42 on branch `ag-chain-c` off `3359cb0f`)**:
  - `crates/px/src/composite.rs`: added `clip_coverage(cov, base_mask, alpha, own)` (`:287-332`) with SIMD128 `simd::clip_coverage` (`:786-828`, 16 bytes at a time via `v128_load`, `simd::mul255`, `v128_store`), and `dissolve_rows(src, w, rows, x0, y0, alpha, mask, seed)` (`:345-391`) with SIMD128 `simd::dissolve_row` (`:833-926`, 4 pixels at a time in `u32x4` lanes with exact 32-bit `mul255_u32` and `lowbias32` / `hash32`, branchless `v128_bitselect` preserving `src_a == 0` RGB untouched and `c_val == 255` short-circuit).
  - `crates/px/src/lib.rs`: bumped `px_abi_version()` (`:57-59`) from `41` to `42`; exported `clip_coverage` (`:575-597`) and `dissolve_rows` (`:607-626`).
  - `renderer/editor/px/px.wasm` (`279,969 B`, `+2,438 B` over `277,531 B` at `3359cb0f`, sha256 `193dd3adf6a169e5`; before at `3359cb0f`: sha256 `d3d4567365549b49`) and `renderer/editor/px/px_scalar.wasm` (`225,508 B`, `+1,396 B` over `224,112 B` at `3359cb0f`, sha256 `71e5311ccaec73ec`; before at `3359cb0f`: sha256 `76f434e70b79d47d`) rebuilt and verified with `python tools/build_px.py --check`.
  - `renderer/editor/px/px.js`: bumped `PX_ABI = 42` (`:16`); added `Px.prototype.psdPackRowsFromPtr(a, pr, w, rows)` (`:1088-1099`) and refactored `psdPackRows` (`:1081-1086`) to delegate to `psdPackRowsFromPtr`.
  - `renderer/editor/px/kernels.js`: added `clipCoverage: "kernel", dissolveRows: "kernel", psdPartWasm: "kernel", stackIntoWasm: "kernel"` to `ROUTE_KINDS` (`:65`).
  - `renderer/editor/inpaint_worker.js`: routed `stackRowsToWasm` (`:394-521`) through `p._call("clip_coverage", ...)` (`route("clipCoverage") !== "js"`) and `p._call("dissolve_rows", ...)` (`route("dissolveRows") !== "js"`); routed `stackInto(msg)` (`:528-563`) through `stackRowsToWasm(p, a, msg, false, into)` + `p.get(Uint8Array, pd, byteLen, into)` when `p && msg.stack.layers.length > 0 && route("stackIntoWasm") !== "js"`, with `composeWasm: 1` on the pointer path and `composeWasm: 0` on `"js"` / base-only (`layers: []`) / trap recovery; routed `psdPart(msg)` (`:769-815`) through `partPtrOf(p, a, msg, false)` + `p.psdPackRowsFromPtr(a, ptrs.pr, msg.w, msg.rows)` when `p && !msg.rgba && route("psdPartWasm") !== "js"`, with `composeWasm: 1` on the pointer path and `composeWasm: 0` on `"js"` / trap recovery.
- **Tests & Mutation**:
  - `node tools/px_test.js` (`composeWasmPartCases` sections `1–3` and `4a–4d` on both `simdPx` and `scalarPx`, plus SIMD vs scalar twin checks `5a–5c`) and `node tools/boxstack_test.js` (clipped and dissolve layer cases against both `rowsOfStack` and frozen hand-computed 4×2 byte arrays): PASS.
  - `tools/export_test.py` (`stack_points_gathers_the_samples_it_names` with a dissolve layer, and `compose_in_wasm_memory_matches_js_gather` covering `psd_part`, `stack_into`, `clipCoverage`, and `dissolveRows` on default and `"js"` routes): PASS on tiles (`k10c-both-tiles`).
  - Mutation (`docs/measurements/k10c_2026-11-09/mutation/mut_k10c.py`): 24/24 mutants killed across Rust `composite.rs` (`R01`–`R05`), `inpaint_raster.js` (`J01`), `blend_modes.js` (`J02`), `inpaint_boxstack.js` (`J03`–`J05`), `inpaint_worker.js` (`J06`–`J18`), and `px.js` (`J19`), 0 survived.
- **15,000 × 10,000 A/B Summary (3 alternating rounds, fresh offline instances, focused, busy lock held per batch)**:
  - `native_test.py` Stack + Match (`--skip=open_psd,open_ora,filter_export_png,filter_wand`):
    - `wand_whole_picture`: wall `1,417.0 [1,330.0-1,457.0]` -> `1,243.0 [1,095.0-1,278.0] ms` (`1.14x`, non-overlapping); `stack_into kernel` `2,440.5 [2,426.3-2,442.6]` -> `1,841.4 [1,532.4-1,918.9] ms` (`1.33x`, non-overlapping).
    - `export_psd`: wall `1,296.0 [1,244.0-1,298.0]` -> `1,012.0 [854.0-1,057.0] ms` (`1.28x`, non-overlapping); `psd_part kernel` `8,287.7 [8,064.4-8,467.1]` -> `6,545.2 [5,410.3-6,637.4] ms` (`1.27x`, non-overlapping); `psd_part rows` `3,421.4 [3,407.3-3,569.6]` -> `1,844.7 [1,609.1-1,897.9] ms` (`1.85x`, non-overlapping).
    - `match_wand`: wall `1,134.0 [1,130.0-1,303.0]` -> `1,090.0 [1,079.0-1,172.0] ms` (`1.04x`, spreads overlap); `stack_into kernel` `2,610.4 [2,550.8-3,366.2]` -> `2,004.5 [1,825.9-2,008.5] ms` (`1.30x`, non-overlapping, passes §1.1 rule 2).
  - `native_test.py` Filter band:
    - `filter_export_png`: wall `1,267.0 [1,214.0-1,347.0]` -> `1,164.0 [1,083.0-1,301.0] ms` (`1.09x`, spreads overlap); `stack_into kernel` `1,910.5 [1,652.5-2,023.7]` -> `1,134.2 [1,037.0-1,265.7] ms` (`1.68x`, non-overlapping, passes §1.1 rule 2).
    - `filter_wand`: wall `1,506.0 [1,469.0-1,523.0]` vs `1,519.0 [1,492.0-1,618.0] ms` (`0.99x`, spreads overlap); `stack_into kernel` `1,994.6 [1,974.1-1,997.6]` -> `1,497.3 [1,400.3-1,622.0] ms` (`1.33x`, non-overlapping, passes §1.1 rule 2).
  - `export_test.py --perf 15000x10000` default:
    - `composite_bands`: wall `1,189.0 [1,023.0-1,217.0]` -> `1,014.0 [994.0-1,015.0] ms` (`1.17x`, non-overlapping); `stack_into kernel` `4,595.8 [4,004.9-4,759.8]` -> `3,120.1 [2,913.0-3,318.8] ms` (`1.47x`, non-overlapping).
    - `psd`: wall `1,981.0 [1,782.0-2,012.0]` -> `1,506.0 [1,495.0-1,532.0] ms` (`1.32x`, non-overlapping); `psd_part kernel` `6,283.1 [5,667.5-6,304.0]` -> `3,807.7 [3,791.3-3,926.6] ms` (`1.65x`, non-overlapping); `psd_part rows` `2,941.4 [2,738.7-3,130.4]` -> `1,320.2 [1,309.0-1,388.0] ms` (`2.23x`, non-overlapping); `stack_into kernel` `4,526.0` -> `2,973.6 ms` (`1.52x`, non-overlapping).
    - `psd_masked`: wall `2,283.0 [2,053.0-2,318.0]` -> `1,681.0 [1,656.0-1,709.0] ms` (`1.36x`, non-overlapping); `psd_part kernel` `7,438.8 [6,685.4-7,626.8]` -> `4,099.3 [3,940.0-4,420.1] ms` (`1.81x`, non-overlapping); `psd_part rows` `3,820.4 [3,403.8-3,895.0]` -> `1,551.0 [1,528.6-1,672.3] ms` (`2.46x`, non-overlapping); `stack_into kernel` `4,918.5` -> `3,279.7 ms` (`1.50x`, non-overlapping).
  - `export_test.py --perf 15000x10000 --blend=dissolve` (`dissolveRows=js` vs `dissolveRows=rust`):
    - `composite_bands`: wall `1,874.0 [1,851.0-2,009.0]` -> `1,403.0 [1,353.0-1,532.0] ms` (`1.34x`, non-overlapping); `stack_into kernel` `7,272.7 [7,150.9-7,355.7]` -> `3,200.5 [3,105.3-3,795.2] ms` (`2.27x`, non-overlapping).
    - `psd`: wall `2,257.0 [1,977.0-2,344.0]` -> `1,829.0 [1,599.0-1,854.0] ms` (`1.23x`, non-overlapping); `stack_into kernel` `7,348.7 [7,043.5-8,004.2]` -> `3,859.8 [3,633.8-4,058.2] ms` (`1.90x`, non-overlapping).
    - `psd_masked`: wall `2,711.0 [2,423.0-2,792.0]` -> `2,286.0 [1,949.0-2,392.0] ms` (`1.19x`, non-overlapping); `stack_into kernel` `7,774.3 [7,357.9-8,396.2]` -> `3,839.7 [3,508.5-3,968.0] ms` (`2.02x`, non-overlapping).
  - `export_test.py --perf 15000x10000 --clipped` (`clipCoverage=js` vs `clipCoverage=rust`):
    - `composite_bands`: wall `1,224.0 [1,182.0-1,401.0]` -> `1,096.0 [1,083.0-1,245.0] ms` (`1.12x`, spreads overlap); `stack_into kernel` `4,711.3 [4,666.8-5,273.5]` -> `4,159.7 [4,127.1-4,874.9] ms` (`1.13x`, passes §1.1 rule 2).
    - `psd`: wall `2,403.0 [1,977.0-3,092.0]` -> `2,147.0 [2,118.0-2,832.0] ms` (`1.12x`, spreads overlap); `stack_into kernel` `4,709.4 [4,627.4-5,049.7]` -> `4,275.3 [4,076.4-5,026.2] ms` (`1.10x`, passes §1.1 rule 2).
    - `psd_masked`: wall `2,353.0 [2,141.0-3,285.0]` vs `2,584.0 [2,356.0-2,811.0] ms` (`0.91x`, spreads overlap); `stack_into kernel` `5,082.8 [4,971.6-5,096.7]` -> `4,557.1 [4,404.8-4,559.3] ms` (`1.12x`, non-overlapping, passes §1.1 rule 2).
  - Retention (`px_probe.py --retention 15000x10000` & `retention_psd_wand.py 15000x10000`):
    - `export_png`: `395.7 ms`, `after` max `42.25 MiB`, `later` max `1.06 MiB`, `releases = 0`, `idles = 8`.
    - `export_psd`: `psdPartWasm=js` (`882.0 ms`, `after` max `23.00 MiB`, `later` max `1.06 MiB`, `releases = 0`) vs `psdPartWasm=rust` (`673.9 ms`, `1.31x`, `after` max `23.00 MiB`, `later` max `1.06 MiB`, `releases = 0`, `idles = 8`).
    - `wand_whole_picture`: `stackIntoWasm=js` (`1,876.9 ms`, `after` max `31.50 MiB`, `later` max `2.12 MiB`, `releases = 1`) vs `stackIntoWasm=rust` (`1,409.7 ms`, `1.33x`, `after` max `31.50 MiB`, `later` max `1.06 MiB`, `releases = 1`, `idles = 9`).
  - All four routes (`psdPartWasm`, `stackIntoWasm`, `dissolveRows`, `clipCoverage`) win their deciding rows; none is added to `DEFAULT_ROUTES`.


