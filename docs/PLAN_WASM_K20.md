# K20 Design: The PSD and ORA Readers (`K20a`–`K20c`)

Design for `docs/PLAN_WASM_BUILD.md` §4.7 ("D: the PSD and ORA readers (`K20a-c`)") and §5 session rows `K20a`, `K20b`, and `K20c`, written at base commit `c36840d8` (`wasm-kernels` after `K17` and `P5` merged). Every file path, line number, signature, constant, route name, step mark, worker timing key, gate name, and benchmark row below is quoted from `c36840d8`; figures not yet measured are marked *(inferred)*.

Per Stop 2 (`docs/PLAN_WASM_BUILD.md:1886`), native `DecompressionStream` stays the app's inflater (`inflate_z` is not in `px.wasm`). Both `K20b` (ZIP-compressed PSD channels `compression === 2 || 3` via `inflateAtMost(b, "deflate", cap)`) and `K20c` (deflated ORA entries `method === 8` via `inflateAtMost(b, "deflate-raw", cap)`, parted ORA layers via `DecompressionStream("deflate-raw")` in `png_part_read`, and single-stream ORA layers via `DecompressionStream("deflate")` in `png_read`) use native browser inflate.

---

## 1. Current Code and Measured Baseline at `c36840d8`

### 1.1 Rust Crate & JS Kernel Layer (`crates/px/`, `renderer/editor/px/`)

- **`crates/px/src/lib.rs`**:
  - `:32, 39`: `mod psd;` and `mod tiff;`.
  - `:45-47`: `fn align_for(bytes: usize) -> usize { if bytes >= 16 * 1024 { 4096 } else { 8 } }`.
  - `:57-59`: `pub extern "C" fn px_abi_version() -> u32 { 45 }`.
  - `:834-836`: `pub extern "C" fn psd_pack_rows_cap(w: usize, rows: usize) -> usize`.
  - `:841-843`: `pub unsafe extern "C" fn psd_pack_rows(rgba: *const u8, w: usize, rows: usize, channel: usize, out: *mut u8, cap: usize, lens: *mut u8) -> isize`.
  - `:1332-1347`: `pub unsafe extern "C" fn tiff_unpack(compression: u32, src: *const u8, len: usize, out: *mut u8, need: usize) -> isize`.
  - `:1353-1364`: `pub unsafe extern "C" fn tiff_unpredict(buf: *mut u8, len: usize, rows: usize, row_bytes: usize, pixels: usize, per: usize, bits: u32, le: u32) -> i32`.
  - `:1378-1412`: `pub unsafe extern "C" fn tiff_to_rgba(src: *const u8, src_len: usize, planes: usize, row_bytes: usize, w: usize, rows: usize, spp: usize, bits: u32, le: u32, photometric: u32, alpha_mode: u32, pal: *const u8, pal_len: usize, out: *mut u8, out_len: usize) -> i32`.
- **`crates/px/src/psd.rs`** (`:1-65`):
  - Holds only the writer's PackBits encoder `pub fn pack_rows(rgba: &[u8], w: usize, rows: usize, channel: usize, out: &mut [u8], lens: &mut [u8]) -> isize` (`:9`) and `pub fn pack_rows_cap(w: usize, rows: usize) -> usize` (`:63`). No PSD reader functions exist yet.
- **`crates/px/src/tiff.rs`**:
  - `:25-83`: `pub fn unpredict(buf: *mut u8, len: usize, rows: usize, row_bytes: usize, pixels: usize, per: usize, bits: u32, le: bool) -> i32` — undoes horizontal differencing in place on `8`-bit (with `simd128` `unpredict_row_8` at `:87` for `per == 4` and `per == 1`) and `16`-bit (`le` and `!le` scalar loops at `:60-81`).
  - `:230-427`: `pub fn to_rgba(...) -> i32`:
    - Fast paths `:307-356` cover **chunky (`planes == 1`)** `bits == 8` `photometric == 2` only (`RGBA8` straight, `RGB8` opaque, `RGBA8` premultiplied).
    - **Planar (`planes > 1`)** and all `16`-bit inputs fall through to the generic per-pixel scalar closure `sample8(r, x, c)` at `:362-425`, where `bits == 16` computes `((v * 2 + 257) / 514) as u8` (`:374`).
  - `:447-475`: `unpack_packbits(src: &[u8], out: &mut [u8]) -> isize` — TIFF 6.0 §9 strip/tile PackBits without per-row byte lengths, returning `ERR_TRUNCATED` (`-2`) when `o < out.len()`.
- **`renderer/editor/px/px.js`**:
  - `:18`: `export const PX_ABI = 45;`.
  - `:1140-1163`: `psdPackRows` and `psdPackRowsFromPtr`.
  - `:1288-1321` (`pngPartDecode`) and `:1327-1354` (`pngPartFinish`).
  - `:1638-1657` (`tiffUnpack`), `:1663-1685` (`tiffUnpredict`), and `:1711-1774` (`tiffToRgba`), using `const a = this.job;` .. `finally { this._reset(a); }`.
  - `:2024-2069`: `export class PxArena` — `take(bytes, align = bytes >= 16 * 1024 ? 4096 : 8)` (`:2035`), `reset()` (`:2052`).
- **`renderer/editor/px/kernels_js.js`**:
  - `:18-20`: imports and re-exports `{ unpackStrip, unpackStrip as tiffUnpack, unpredict, unpredict as tiffUnpredict, predictRgba, predictRgba as tiffPredictRgba, toRgba, toRgba as tiffToRgba, paletteLut, tiffPlan, readTiffBand, TIFF_BAND_BYTES, tiffPart, TIFF_JS }` from `../inpaint_tiff.js`.
  - `:1092`: `export function psdPackRows(rgba, w, rows)`.
  - `:1581`: `export function pngPartDecode(lines, w, prev = null, rt = null, out = null)`.
- **`renderer/editor/px/kernels.js`**:
  - `:68`: `export const ROUTE_KINDS = Object.freeze({ flood: "kernelSize", mips: "kernel", selCombine: "kernel", maskInvert: "kernel", crc32: "kernelSize", compositeMaskedTile: "kernel", matchPixels: "kernel", growMask: "kernel", releaseMB: "mb", keepMB: "mb", relightStripes: "count", relightFeed: "count", dabBlur: "kernel", dabTone: "kernel", dabSponge: "kernel", freqSplit: "kernel", liquifyBlock: "kernel", liquifyPreview: "kernel", liquifyDab: "kernel", stitchMask: "kernel", colorMatch: "kernel", blendAlpha: "kernel", mapTileStats: "kernel", rangeDepth: "kernel", rangeDepthSnap: "kernel", rangeLuma: "kernel", rangeColor: "kernel", limitAlphaRows: "kernel", guidedFar: "kernel", edgefit: "kernel", edgefitShrink: "kernel", warpRgba: "kernel", warpCoverage: "kernel", composeTiles: "kernel", composeStack: "kernel", shadowMarch: "kernelSize", tiffUnpack: "kernel", tiffUnpredict: "kernel", tiffPredict: "kernel", tiffToRgba: "kernel", tiffStripWasm: "kernel", clipCoverage: "kernel", dissolveRows: "kernel", psdPartWasm: "kernel", stackIntoWasm: "kernel" });`.
  - `:119`: `const DEFAULT_ROUTES = Object.freeze({ releaseMB: 256, keepMB: 16, crc32: 64 });`.
  - `:269`: `export function releaseIfLarge()`, `:338`: `export function recovered(p, err, name = "")`.
  - `:1221-1236`: `TIFF_RUST` and `export function tiffKernels()` (looking up `rustPx(...)` per call).

### 1.2 Layered & PNG Readers (`inpaint_layered.js`, `inpaint_png.js`, `inpaint_worker.js`, `inpaint_canvas.js`)

- **`renderer/editor/inpaint_layered.js`** (`:1-754`, imports only `PSD_BLENDS, ORA_BLENDS` from `./blend_modes.js` at `:35`):
  - `:43-57`: H1 S5 constants: `LAYER_MAX_SIDE = 65535`, `LAYER_MAX_PIXELS = 1024 * 1024 * 1024`, `DEFLATE_MAX_RATIO = 1032`, `ORA_XML_MAX = 16 * 1024 * 1024`, `ORA_INFLATE_BASE = 256 * 1024 * 1024`, `ORA_INFLATE_RATIO = 64`, `INFLATE_SLICE = 64 * 1024`, `ORA_LAYER_MAX_PIXELS = 2 ** 29 - 1`, `ORA_PIXELS_BASE = 268435456`, `ORA_PIXELS_PER_PICTURE = 64`.
  - `:69-105`: `export async function inflateAtMost(bytes, format = "deflate", cap = Infinity)` — feeds `DecompressionStream(format)` in `64 KB` slices and cancels with `err.tooLarge = true` if output exceeds `cap`.
  - `:108-112`: `function checkRect(what, w, h, maxPixels = LAYER_MAX_PIXELS)`.
  - `:152-173`: `function unpackRows(src, at, lens, rowBytes, out)` — PSD per-row PackBits decoder (`p = end` at each row's end; `n === 128` no-op; clamps literal and repeat writes to `stop - o`, leaving unfilled row tails at `0`).
  - `:176-186`: `function unpredict(buf, w, h, depth)` — row-by-row byte (`depth === 8`) or big-endian `u16` (`depth === 16`) prefix sum for `compression === 3`.
  - `:189-243`: `packedAtLeast`, `tooShort`, and `async function readChannel(r, compression, w, h, depth, dataLen, inflate, what = "a PSD layer")` — allocates whole-channel `new Uint8Array(size)` (`w * h * bpc`), unpacks raw (`0`), RLE (`1`), ZIP (`2`), or ZIP-with-prediction (`3`), and if `bpc === 2` allocates `o8 = new Uint8Array(w * h)` with `Math.round(((out[2 * i] << 8) | out[2 * i + 1]) / 257)` (`:240-241`).
  - `:290-297`: `function interleave(ch, w, h, gray)` — whole-layer straight RGBA (`R ? R[i] : 0`, `G ? G[i] : 0`, `B ? B[i] : 0`, `A ? A[i] : 255`, `G = B = ch[0]` when `gray`).
  - `:329-347`: `function layerMask(L, w, h)` — places `L.ch[-2]` (else `L.ch[-3]`, `maskFor(L, id)`) into `new Uint8Array(w * h).fill(m.def)` over `[Math.max(0, m.left - L.left), Math.min(w, m.right - L.left)) × [Math.max(0, m.top - L.top), Math.min(h, m.bottom - L.top))`.
  - `:359-361`: `export async function readPsd(input, { inflate = null, onHeader = null } = {})`.
  - `:374-378`: `export async function readPsdStream(input, { inflate = null, rowsPerBand = 256, onHeader = null, onRows = null, spent = null } = {})` — initialises `sp = Object.assign(spent || {}, { channels: 0, interleave: 0, mask: 0, deliver: 0, bands: 0 })`.
  - `:393-421`: `function streamPixels(stream, ch, w, h, gray, maskData)` — emits `"rgba"` bands (`Uint8ClampedArray(n * w * 4)`) then `"mask"` bands (`[255, 255, 255, maskData[i]]`).
  - `:427-460`: `function mergedPlanes(r, bytes, width, height, channels, depth, gray)` — reads `comp === 1` or `comp === 0` merged image (`n = Math.min(channels, gray ? 2 : 4)`), throwing `err.refused = true` when `total < packedAtLeast(height, rowBytes)`.
  - `:463-627`: `async function decodePsd(input, inflate, stream, onHeader = null)`.
  - `:636-656`: `function unzip(bytes)` — parses EOCD (`0x06054b50`) and Central Directory (`0x02014b50`) from a full-file `Uint8Array`.
  - `:659-664`: `function pngSize(png)` — reads `{ w, h }` from the first 24 bytes (`IHDR`).
  - `:678-754`: `export async function readOra(input, { inflateRaw = null, onHeader = null } = {})` — validates `ORA_XML_MAX`, `budget = ORA_INFLATE_BASE + ORA_INFLATE_RATIO * bytes.length`, `onHeader({ width, height })`, `ORA_LAYER_MAX_PIXELS`, and `pixelBudget = Math.max(ORA_PIXELS_BASE, ORA_PIXELS_PER_PICTURE * width * height)`, returning `{ width, height, layers, notes, lossy }` with `L.png` (`Uint8Array`).
- **`renderer/editor/inpaint_worker.js`**:
  - `:60, 66`: imports `{ readPsdStream, inflateAtMost }` from `./inpaint_layered.js` and kernel helpers from `./px/kernels.js`.
  - `:901-913`: `async function tiffRead(msg)` — passes `kernels: tiffKernels()`, calls `releaseIfLarge()`, reports `kernels: kernelsInUse()`.
  - `:923-946`: `async function psdRead(msg)` — reads `const bytes = new Uint8Array(await msg.blob.arrayBuffer())`, hardcodes `kernels: "js"` in `timing()` (`:929`), calls `readPsdStream(bytes, { inflate, rowsPerBand: msg.rowsPerBand || TILE, onHeader, onRows, spent })`, posts transferred `{ id: msg.id, progress: true, index, mask: kind === "mask", rgba: rgba.buffer, w, h, y0, rows }`, returns `{ doc, timing: timing() }` or `{ failed: ..., timing: timing() }`, and detaches `bytes.buffer.transfer(0)` in `finally` (`:944`).
  - `:1933`: `if (msg.op === "psd_read") return psdRead(msg);`.
- **`renderer/editor/inpaint_png.js`**:
  - `:236-241`: `export function pngHeader(bytes)` (needs 33 bytes).
  - `:254-438`: `export async function readPng(blob, { onHeader = null, onRows, rowsPerBand = 256 } = {})` — stream-decodes non-interlaced PNGs via `DecompressionStream("deflate")` and `pngUnfilterRows` (`:398`), ignoring colour profiles (`:251-252`).
  - `:446-512`: `export async function pngPartsOf(blob)` — inspects 8-byte chunk headers (`33–49` bytes on non-matching files) for 8-bit non-interlaced RGBA without `iCCP` / `gAMA` / `cHRM` / `cICP` / `PLTE` / `tRNS`, 2-byte zlib `IDAT`, part `IDAT`s, 4-byte Adler-32 `IDAT`, and `IEND`.
  - `:521-653`: `export async function readPngParts(blob, { pool, rt = null, onHeader = null, onRows, layout = null })` — decodes parted PNGs across `pool` (`png_part_read` + `png_part_finish` at `INTERACTIVE` priority `0`, `0` finish jobs on P5-written PNGs).
- **`renderer/editor/inpaint_canvas.js`**:
  - `:606-608`: `function psdOnPool(file)` — `InpaintEditor.psdOnPool !== false && typeof Worker === "function" && typeof Blob === "function" && file instanceof Blob && !editorPool().off`.
  - `:685-687`: `function pngReaderUsable()` — `InpaintEditor.pngParts !== false && typeof Worker === "function" && !editorPool().off`.
  - `:704-714`: `async function pngIsPlainSrgb(blob)` — verifies no `iCCP`, `gAMA`, `cHRM`, `cICP`, or `IEND` chunk precedes the first `IDAT`.
  - `:723-764`: `async function pixelsFromPngStream(blob, Cls, progress = null)` — tries `pngPartsOf(blob)` + `readPngParts(blob, { layout, pool: editorPool(), rt: canvasRoundTrip(), onHeader, onRows: px.putCanvasRows })`, falling back to `editorPool().run("png_read", { blob }, ..., { onProgress: px.writeRect })`, setting `err.partedRefused = true` (`:759`) when both reject a parted PNG.
  - `:18994-19050`: `async readLayered(file, kind, later = () => false)`:
    - `:18997-19005`: PSD pool fast path via `this.readPsdOnPool(file, later)`.
    - `:19006`: `const bytes = new Uint8Array(await file.arrayBuffer());` — materialises the entire `.ora` (or fallback `.psd`) on the window.
    - `:19038-19046`: decodes each ORA layer sequentially on the window via `createImageBitmap(new Blob([L.png], { type: "image/png" }), { premultiplyAlpha: "none", colorSpaceConversion: "none" })` + `this.pixels.Layer.fromImage(bmp, bmp.width, bmp.height)` (`TileLayerPixels.fromImage` at `renderer/editor/inpaint_tiles.js:814-821` draws onto a 2D canvas and reads back with `getImageData`).
  - `:19069-19145`: `async readPsdOnPool(file, later = () => false)` — checks the 26-byte PSD header on the window (`checkLayeredSize`), runs `psd_read`, writes bands with `e[key].writeRect` (`:19097`), handles `CancelledError` (`stopped`, not `lost`), and falls back to the window only when `bands === 0` (`:19110-19112`).
  - `:19152-19194`: `async loadLayered(file, kind, later = () => false)` — promotes covering `layers[0]` (`x === 0 && y === 0 && w === W && h === H && visible && opacity >= 0.999 && blend === "normal" && !maskPx`, `:19165`) to `basePx`, calls `uploadPixels(basePx, stem)` (`:19174`; `renderer/editor/inpaint_upload.js:48-57`), `setBasePixels` (`inpaint_canvas.js:19177`), and `addLayer` (`inpaint_canvas.js:19186`).
- **`tools/build_node.py:39-48`**: `FILES` already includes `"inpaint_canvas.js"`, `"inpaint_worker.js"`, `"inpaint_layered.js"`, `"px/kernels_js.js"`, `"px/kernels.js"`, and `"px/px.js"`, and `BINARIES` includes `"px/px.wasm"`. No new files are added outside `FILES`.

### 1.3 Measured 15,000 × 10,000 Baseline (`open_psd` and `open_ora`)

From `docs/measurements/k10b_2026-11-09/summary_rows.txt:57-90` and `docs/measurements/k10b_2026-11-09/after/native/r1.json`–`r3.json` (15,000 × 10,000 2-layer document: `Background` + `Paint`, 925 MB PSD and 511.6 MB ORA, tiles on, offline):

- **`open_psd`** (`tools/native_test.py:666-668`, `openFile("psd")` at `tools/native_test.py:344-367`):
  - `wall`: **`6,231 ms`** (`[6,167..6,333]`), `blocked`: **`61 ms`** (`[60..74]`).
  - `jobs.psd_read` (`1` job, `80` bands, `pxCalls: {}`): `kernel` **`4,594.7 ms`** (`[4,486.6..4,624.9]`):
    - `read` (`msg.blob.arrayBuffer()`): `194.9 ms` (`[157.3..211.6]`)
    - `channels` (JS `unpackRows` across 8 × 150 MP planes = 1.2 GB): **`2,728.0 ms`** (`[2,677.4..2,732.6]`)
    - `interleave` (JS `streamPixels` across 2 × 600 MB RGBA): **`1,649.5 ms`** (`[1,646.3..1,691.0]`)
    - `deliver`: `4.2 ms` (`[4.1..4.9]`)
  - `marks.layered_open`: `parsed` `4,609.8 ms` (window `rgbaMs` `802.7 ms`, overlapped with `psd_read`), `stored` (`uploadPixels` -> `79` `png_part` jobs) `1,476.4 ms`, `base` `25.0 ms`, `added` `26.0 ms`.
- **`open_ora`** (`tools/native_test.py:669-671`, `openFile("ora")` at `tools/native_test.py:344-367`):
  - `wall`: **`4,986 ms`** (`[4,910..5,167]`), `blocked`: **`709 ms`** (`[685..712]`).
  - Window probes (`r1.json`): `blob arrayBuffer` `511.6 MB` (`83.2 ms` — including `235.2 MB` of unused `mergedimage.png`), `createImageBitmap` × 2 `276.4 MB` (`2,000 ms` until settled), `2d drawImage >= 1 MP` × 51, `2d getImageData` × 26 **`824.8 ms`** (`1,144.4 MB` GPU/canvas readback).
  - `marks.layered_open`: `read` `88.7 ms`, `parsed` `1.0 ms`, `layers` **`3,237.0 ms`** (`bitmapMs` **`2,042.0 ms`** + `fromImageMs` **`1,142.8 ms`**), `stored` `1,467.8 ms`, `base` `21.5 ms`, `added` `22.5 ms`.

---

## 2. K20b Design — Rust PSD Reader Kernels inside `psd_read`

### 2.1 Architecture: Upfront Record Validation + 1-Pass Band-in-Wasm Streaming

In `decodePsd` (`inpaint_layered.js:514-543`), reading an entire 15,000 × 10,000 RGBA layer into `L.ch` before `streamPixels` allocates 4 × 150 MB = **600 MB** of JS `Uint8Array` planes per layer (`1.2 GB` raw for 16-bit) and, if naively routed kernel-by-kernel, would copy 600 MB of unpacked planes out of wasm into `L.ch` and copy the same 600 MB back into wasm in `streamPixels` (`> 2.2 GB` of copies per layer, growing wasm memory above `releaseMB = 256`).

Instead, `readPsdStream` (`stream != null` in `decodePsd`) separates **channel validation** from **band materialisation**:

1. **Upfront channel validation (`prepareChannel`, exact parity with `readChannel` at `renderer/editor/inpaint_layered.js:202-243`)**:
   For every channel entry `c` of every record `L` (`inpaint_layered.js:518-533`), in the exact order and with the exact error strings of `c36840d8`:
   - `isMask = c.id === -2 || c.id === -3`, `m = isMask ? maskFor(L, c.id) : null`; if `isMask && !m`, `r.p = end; continue;`.
   - `cw = m ? m.right - m.left : w`, `chh = m ? m.bottom - m.top : h`; if `m && !(cw > 0 && chh > 0)`, record `{ kind: "empty" }` and `r.p = end; continue;`.
   - If `c.len < 2`, `r.p = end; continue;`; read `comp = r.u16()`; if `!(cw > 0 && chh > 0)`, `r.p = end; continue;`.
   - Call `checkRect(what, cw, chh)` (`inpaint_layered.js:529`), `bpc = depth / 8`, `rowBytes = cw * bpc`, `size = cw * chh * bpc`, `dataLen = c.len - 2`:
     - `comp === 0` (raw): if `dataLen < size` throw `tooShort(what, cw, chh)`; `r.need(size)`. Record `{ comp: 0, bytes: r.b, at: r.p, cw, chh, rowBytes }` (zero allocation, zero copy).
     - `comp === 1` (PackBits RLE): if `2 * chh > dataLen` throw `tooShort(what, cw, chh)`; `r.need(2 * chh)`. Build `rowOff = new Uint32Array(chh + 1)` (`40 KB` at `chh = 10,000`) from the `chh` big-endian `u16` row lengths at `lensAt = r.p`, `total = rowOff[chh]`, `r.p = lensAt + 2 * chh`; call `r.need(total)`; if `total < packedAtLeast(chh, rowBytes) || 2 * chh + total > dataLen` throw `tooShort(what, cw, chh)`. Record `{ comp: 1, lensBytes: r.b.subarray(lensAt, lensAt + 2 * chh), bytes: r.b, dataAt: lensAt + 2 * chh, rowOff, cw, chh, rowBytes }` (zero plane allocation).
     - `comp === 2 || comp === 3` (ZIP / ZIP with prediction): check `!inflate`, `r.need(dataLen)`, and `size > dataLen * DEFLATE_MAX_RATIO` (`tooShort`), then await `raw = await inflate(r.bytes(dataLen), size)` (converting `err.tooLarge` and `raw.length > size` to `bomb()`, `inpaint_layered.js:227-230`). Note that `inflate` still runs on every `comp === 2 || 3` channel record (including adjustment records or extra channels), so corrupt or over-cap ZIP streams anywhere in the layer section are still refused identically. When `L` is a `pixelRecord` and `c.id` is used (`0, 1, 2, -1`, or the active mask `-2` / `-3`), keep `buf = raw.length === size ? raw : zeroPad(raw, size)` as `{ comp, bytes: buf, at: 0, cw, chh, rowBytes }` (dropped as soon as the layer's bands finish).
     - Otherwise: `throw new Error(\`unknown PSD compression \${comp}\`)` (`inpaint_layered.js:235`).
   - Advance `r.p = end` (`inpaint_layered.js:532`).
   - Likewise for flat PSDs (`!layers.length && width > 0 && height > 0`, `inpaint_layered.js:603-608`), `mergedChannelDescs` validates `comp === 1` (`r.need(2 * height * channels)` and `total < packedAtLeast(height, rowBytes)` throwing `err.refused = true` on all `n = Math.min(channels, gray ? 2 : 4)` channels before any band is sent) and `comp === 0` (`r.need(n * width * height * bpc)` upfront) so no partial band is ever sent before a refusal or truncation error.

2. **1-pass band materialisation + RGBA conversion (`rows = Math.min(per, h - y0)`)**:
   - Because PSD's `compression === 0` (raw), `compression === 1` (PackBits with per-row `u16` lengths `rowOff[y0 .. y0 + rows]`), and `compression === 3` (`unpredict` horizontal differencing per row) are all **row-independent**, each `rowsPerBand`-row band (`256` rows by default) is unpacked, unpredicted (if `comp === 3`), 16→8 rounded (if `depth === 16`), and interleaved to RGBA8 **in a single `PxArena` scope inside wasm memory**:
     - Plane bytes per band at `15,000 × 256`: `3.84 MB` (`8`-bit) or `7.68 MB` (`16`-bit). Across `4` planes + `15.36 MB` RGBA output + packed RLE input (`~4 MB`), peak `PxArena` usage is **`~35 MB` (`8`-bit)** or **`~62 MB` (`16`-bit)** — below `releaseMB = 256` (`release === 0`) and keeping the active band in L3 cache between unpack and interleave.
     - Unpacked planes never cross the JS↔wasm boundary; only compressed/raw band slices go in once and the finished `Uint8ClampedArray(rows * w * 4)` band comes out once for transfer in `postMessage`.

### 2.2 Rust Signatures and Reused Kernels (`crates/px/`)

- **ABI**: Bump `px_abi_version()` in `crates/px/src/lib.rs:58` and `PX_ABI` in `renderer/editor/px/px.js:18` by `+1` over `K20b`'s base (`45 -> 46` at `c36840d8`, renumbered if an earlier merge bumps it).

1. **New export `packbits_rows` (`crates/px/src/psd.rs` & `crates/px/src/lib.rs`)** — named in `docs/PLAN_WASM_BUILD.md:417`:
   ```rust
   #[no_mangle]
   pub unsafe extern "C" fn packbits_rows(
       lens: *const u8,
       src: *const u8,
       src_len: usize,
       rows: usize,
       row_bytes: usize,
       out: *mut u8,
       out_len: usize,
   ) -> isize
   ```
   - `rows == 0 || row_bytes == 0`: returns `0`.
   - Returns `-1` when `lens.is_null()`, `out.is_null()`, `rows.checked_mul(row_bytes)` overflows or exceeds `out_len`, or `src_len > 0 && src.is_null()`.
   - Reads `rows` big-endian `u16` byte counts from `lens[0 .. 2 * rows]`.
   - For row `y in 0..rows` (`row_len = u16::from_be_bytes([lens[2 * y], lens[2 * y + 1]]) as usize`, `end = p0.saturating_add(row_len)`, `lim = end.min(src_len)`):
     - Decodes `src[p0 .. lim]` into `dst = &mut out[y * row_bytes .. (y + 1) * row_bytes]`:
       - `n < 128`: `run = (n as usize) + 1`, `c = run.min(row_bytes - o).min(lim - p)`, copies `c` bytes, `p += run`, `o += c`.
       - `n > 128`: `run = 257 - (n as usize)`, `v = if p < lim { let b = src[p]; p += 1; b } else { 0 }`, `c = run.min(row_bytes - o)`, `dst[o .. o + c].fill(v)`, `o += c`.
       - `n == 128`: no-op.
     - Zeroes any unfilled tail `dst[o .. row_bytes].fill(0)` (matching zero-initialised `new Uint8Array(size)` in `inpaint_layered.js:219, 450`) and sets `p0 = end`.
   - Returns `(rows * row_bytes) as isize`.
   - **Row-locality fix shared with JS `unpackRows` (`inpaint_layered.js:155-170`)**: In `c36840d8`, if a damaged row ends on a dangling repeat header `n > 128` at `p === end - 1`, `src[p++]` at `:166` reads `src[end]` (the first byte of row `y + 1`, or `undefined -> 0` on the final byte of `src`). Clamping each row to `lim = Math.min(end, src.length)` and `const v = p < lim ? src[p++] : 0` in both `unpackRows` and `packbits_rows` makes every valid row identical to `c36840d8` while making damaged rows strictly row-local, so `per = 3`, `per = 256`, and whole-plane `readPsd` agree byte-for-byte on every input.

2. **Reused `tiff_to_rgba` (`crates/px/src/tiff.rs:230-427`) + new SIMD128 planar fast paths**:
   - No export signature change.
   - **Exact 16→8 rounding identity (`docs/PLAN_WASM_BUILD.md:416`)**: For every integer $v \in [0, 65535]$, since $2v + 257$ is odd and $514 = 2 \times 257$ is even, $v / 257$ never lands on a `.5` half-way tie, and all three integer forms equal `Math.round(v / 257)` (`inpaint_layered.js:241, 458`) across all `65,536` `u16` values (`0` mismatches):
     $$\operatorname{round}(v / 257) = \lfloor (2v + 257) / 514 \rfloor = \lfloor (v + 128) / 257 \rfloor = (255 v + 32895) \gg 16$$
   - Add planar fast paths in `crates/px/src/tiff.rs::to_rgba` when `planes == spp && (bits == 8 || bits == 16) && (photometric == 1 || photometric == 2) && (alpha_mode == 0 || alpha_mode == 2)`:
     - **`bits == 8`**: `#[cfg(target_feature = "simd128")]` loads `u8x16` from the `1..=4` planes (`G` replicated from plane `0` when `photometric == 1`, `A = u8x16_splat(255)` when `alpha_mode == 0`) and interleaves 16 pixels (64 RGBA bytes) per iteration with four `u8x16_shuffle` instructions (`rg_lo`, `rg_hi`, `ba_lo`, `ba_hi` -> `rgba_0..3`), plus scalar tail.
     - **`bits == 16`**: `#[cfg(target_feature = "simd128")]` loads 8 `u16` samples per plane (byte-swapping big-endian `!le` with `u8x16_swizzle`), computes `((v * 255 + 32895) >> 16)` in `u32x4` via `u32x4_extmul_low_u16x8` / `u32x4_extmul_high_u16x8`, narrows to `u8`, and interleaves to RGBA8, plus scalar tail.
   - In PSD band conversion, `spp = gray ? (hasA ? 2 : 1) : (hasA ? 4 : 3)`, `photometric = gray ? 1 : 2`, `alpha_mode = hasA ? 2 : 0`, `le = 0`. When an RGB PSD omits channel `1` (`G`) or `2` (`B`) while keeping `0` (`R`), its `planeBytes` slot in wasm is zero-filled (`mem.fill(0, ptr, ptr + planeBytes)`) before `tiff_to_rgba`, matching `G ? G[i] : 0` and `B ? B[i] : 0` (`inpaint_layered.js:294, 406`).

3. **Reused `tiff_unpredict` (`crates/px/src/tiff.rs:25-83`) + SIMD128 `16`-bit `per == 1` prefix sum**:
   - No export signature change.
   - For `compression === 3` (ZIP with horizontal prediction), each band calls `tiff_unpredict(plane_ptr, plane_bytes, rows, row_bytes, w, 1, depth, 0)` in place inside wasm before `tiff_to_rgba` / `psd_mask_rgba`.
   - Add a `#[cfg(target_feature = "simd128")]` `u16x8` prefix-sum fast path in `tiff::unpredict` for `bits == 16 && per == 1` (`le` and `!le` via `u8x16_swizzle` byte-swap, three `u16x8` shift-adds `+1`, `+2`, `+4` lanes, and `u16x8_splat` carry), accelerating both 16-bit predicted PSD channels and planar 16-bit TIFF strips.

4. **New export `psd_mask_rgba` (`crates/px/src/psd.rs` & `crates/px/src/lib.rs`)**:
   ```rust
   #[no_mangle]
   pub unsafe extern "C" fn psd_mask_rgba(
       src: *const u8,
       src_len: usize,
       mw: usize,
       sx0: usize,
       w: usize,
       rows: usize,
       x0: usize,
       x1: usize,
       ry0: usize,
       ry1: usize,
       bits: u32,
       def: u8,
       out: *mut u8,
       out_len: usize,
   ) -> i32
   ```
   - Places the band's mask overlap (`m_rows = ry1 - ry0` rows of width `mw` starting at mask column `sx0`, `8`-bit or big-endian `16`-bit rounded via `(2v + 257) / 514`) into `out` (`rows * w * 4` bytes) as `[255, 255, 255, alpha]` over `[ry0, ry1) × [x0, x1)` and `[255, 255, 255, def]` everywhere else (`u32x4_splat(((def as u32) << 24) | 0x00FF_FFFF)` and `u8x16_shuffle` in `simd128`).
   - Band coordinates for layer `L` (`w × h` at `(L.left, L.top)`) and mask record `m` (`mw = m.right - m.left, mh = m.bottom - m.top`):
     `x0 = Math.max(0, m.left - L.left)`, `x1 = Math.min(w, m.right - L.left)`, `gy0 = Math.max(0, m.top - L.top)`, `gy1 = Math.min(h, m.bottom - L.top)`, `ry0 = Math.max(0, gy0 - y0)`, `ry1 = Math.max(ry0, Math.min(rows, gy1 - y0))`, `my0 = L.top + y0 + ry0 - m.top`, `sx0 = L.left + x0 - m.left`.
   - Returns `0` on success or `-1` on invalid bounds / null pointers.

### 2.3 JS Wrappers, Twins, Route, and Worker Integration

- **`renderer/editor/inpaint_layered.js`**:
  - Exports `packbitsRows(lensBytes, src, rows, rowBytes, out = null)`, `psdMaskRgba(src, mw, sx0, w, rows, x0, x1, ry0, ry1, bits, def, out = null)`, `psdBandRgba(descs, w, y0, rows, depth, gray, spent = null)`, `psdBandMask(desc, L, m, w, h, y0, rows, depth, spent = null)`, and `export const PSD_JS = Object.freeze({ packbitsRows, maskRgba: psdMaskRgba, bandRgba: psdBandRgba, bandMask: psdBandMask });`.
  - `readPsdStream(input, { inflate = null, rowsPerBand = 256, onHeader = null, onRows = null, spent = null, kernels = null } = {})` uses `const K = kernels || PSD_JS;` and keeps `spent = { channels, interleave, mask, deliver, bands }` (`channels` accumulating plane unpack/unpredict, `interleave` accumulating RGBA conversion, `mask` accumulating mask band unpack/placement).
  - `readPsd` (`:359-361`) stays on the existing whole-plane JS path (`readChannel`, `interleave`, `layerMask`, `mergedPlanes`) as the window fallback and independent reference twin.
- **`renderer/editor/px/kernels_js.js`**:
  - Imports and re-exports `{ packbitsRows, psdMaskRgba, psdBandRgba, psdBandMask, PSD_JS }` from `../inpaint_layered.js` (matching `inpaint_tiff.js` at `:18-20`).
- **`renderer/editor/px/px.js`**:
  - Adds `Px.prototype.packbitsRows`, `Px.prototype.psdMaskRgba`, `Px.prototype.psdBandRgba`, and `Px.prototype.psdBandMask` using `const a = this.job;` .. `finally { this._reset(a); }`, page-aligned `a.take(...)` without holding `this.u8()` views across `a.take(...)`, and `TIMED` `lapIn` / `lapOut` accounting.
- **`renderer/editor/px/kernels.js`**:
  - Adds `psdRead: "kernel"` to `ROUTE_KINDS` (`:68`) (see Question 5.1).
  - Exports `packbitsRows`, `psdMaskRgba`, and `psdKernels()`:
    - Each `psdKernels()` call (`bandRgba`, `bandMask`) looks up `const p = rustPx("psdRead");` per band; on a `WebAssembly.RuntimeError` or `PxOutOfMemory`, calls `if (!recovered(p, err, "packbits_rows")) throw err;` and falls back to `PSD_JS` for that band without dropping or duplicating prior bands, with `releaseIfLarge()` in `finally`.
- **`renderer/editor/inpaint_worker.js`**:
  - Adds `psdKernels` to the `./px/kernels.js` import at `:66` (`rustPx`, `kernelsInUse`, `route`, and `releaseIfLarge` are already imported there), passes `kernels: psdKernels()` to `readPsdStream` in `psdRead(msg)` (`:923-946`), sets `kernels: rustPx("psdRead") ? "rust" : "js"` in `timing()` (`:929`), and calls `releaseIfLarge()` in `finally` (`:942-945`).

---

## 3. K20c Design — ORA Reader on the Parted PNG Route (No GPU Readback)

### 3.1 Eliminating the Whole-Archive Copy (`readOraBlob` in `inpaint_layered.js`)

Today `readLayered` (`renderer/editor/inpaint_canvas.js:19006`) executes `const bytes = new Uint8Array(await file.arrayBuffer());`, reading all `511.6 MB` of a 15k `.ora` (including `235.2 MB` of `mergedimage.png` written by `OraBandWriter.finish` at `renderer/editor/inpaint_bands.js:443-444`, which `readOra` never uses) into a contiguous V8 `Uint8Array` on the window, and then copies each layer again in `new Blob([L.png])` (`inpaint_canvas.js:19039`).

In `K20c`, `renderer/editor/inpaint_layered.js` adds `export async function readOraBlob(blob, { inflateRaw = null, onHeader = null } = {})` (sharing one XML/layer parser and every H1 S5 constant and refusal string with `readOra` at `inpaint_layered.js:678-754`, while keeping `readOra(input, ...)` unchanged for `Uint8Array` / `ArrayBuffer` callers and `tools/layered_test.js`):

1. **ZIP Central Directory from `Blob` slices (`unzipBlob(blob)`)**:
   - Slices only the tail `tailStart = Math.max(0, blob.size - 65557)`, `tail = new Uint8Array(await blob.slice(tailStart, blob.size).arrayBuffer())`, scanning backwards for `0x06054b50` (`"the ORA file is not a complete zip"` if absent, `inpaint_layered.js:640`).
   - Slices only the Central Directory `[cdOffset, cdOffset + cdBytes)` (`<=` a few KB; validates `0x02014b50` `"the ORA file's zip directory is damaged"` at `inpaint_layered.js:645` and bounds against `blob.size`).
   - Never reads `mergedimage.png` or `Thumbnails/thumbnail.png`.
2. **Entry resolution with identical H1 S5 budgets (`inpaint_layered.js:681-700, 741-747`)**:
   - `budget = ORA_INFLATE_BASE + ORA_INFLATE_RATIO * blob.size`.
   - Reads only the 30-byte local header `blob.slice(e.local, e.local + 30)` to compute `at = e.local + 30 + lNameLen + lExtra` and `entryBlob = blob.slice(at, at + e.csize)` (validating `e.local + 30 <= blob.size` and `at + e.csize <= blob.size`, else `"the ORA file's zip directory is damaged"`).
   - For `"stack.xml"`: reads `entryBlob` (`method === 0` directly, `method === 8` after checking `ORA_XML_MAX` and `budget` and inflating via `inflateRaw(bytes, e.size)`). Parses `<image w h>`, fires `onHeader({ width, height })` (`inpaint_layered.js:708`) before reading any layer entry.
   - For each `<layer src="...">`:
     - `method === 0` (stored — written by `OraBandWriter`, `OraWriter`, Krita, GIMP, and MyPaint): reads only the 24-byte slice `new Uint8Array(await entryBlob.slice(0, 24).arrayBuffer())` for `pngSize` (`checkRect(label, size.w, size.h, ORA_LAYER_MAX_PIXELS)` and `pixels += size.w * size.h <= pixelBudget`, `inpaint_layered.js:741-747`), and returns `pngBlob: entryBlob` (**zero-copy `Blob` slice**).
     - `method === 8` (deflated): enforces `budget` and `inflateRaw(..., e.size)` (`bomb()` on `.tooLarge` or `raw.length > e.size`, `inpaint_layered.js:691-697`), checks `pngSize(raw)` against `ORA_LAYER_MAX_PIXELS` and `pixelBudget`, and returns `pngBlob: new Blob([raw], { type: "image/png" })`.
     - Other methods: throws `unknown zip method ${e.method} for ${name}` (`inpaint_layered.js:699`).

### 3.2 Off-Thread Parted / Stream Layer Decode (`readLayered` in `inpaint_canvas.js`)

In `renderer/editor/inpaint_canvas.js`:

1. **Toggle for tests and A/B**:
   - `InpaintEditor.oraParted` (default `undefined`, active when `!== false`, mirroring `InpaintEditor.psdOnPool` at `inpaint_canvas.js:607` and `InpaintEditor.pngParts` at `inpaint_canvas.js:686`).
2. **Per-layer decode on tiles (`decodeOraLayer(pngBlob)`)**:
   - When `this.tileMode && InpaintEditor.oraParted !== false && pngReaderUsable()`:
     - Inspects the 33-byte header `h = pngHeader(new Uint8Array(await pngBlob.slice(0, 33).arrayBuffer()))` (`renderer/editor/inpaint_png.js:236`).
     - When `h && h.bitDepth === 8 && !h.interlace` (see Question 5.4 regarding colour chunks):
       - Calls `const px = await pixelsFromPngStream(pngBlob, this.pixels.Layer)` (`inpaint_canvas.js:723-764`):
         1. **Scumble parted ORA layers (`OraBandWriter`)**: `pngPartsOf(pngBlob)` (`inpaint_canvas.js:726`) matches in 49 bytes and `readPngParts` (`inpaint_canvas.js:729-739`) decodes all parts in parallel across `editorPool()` (`png_part_read`: `DecompressionStream("deflate-raw")` + Rust `png_part_decode` with `rt: canvasRoundTrip()`, `0` `png_part_finish` jobs on P5 files), writing directly into tiles via `px.putCanvasRows(rgba, W, 0, y0, rows)` and detaching `rgba.buffer.transfer(0)` — **zero `createImageBitmap`, zero 2D canvas, zero `getImageData` GPU readback**.
         2. **Single-stream 8-bit ORA layers (`OraWriter`, Krita, GIMP, MyPaint, Pillow)**: `pngPartsOf(pngBlob)` returns `null` after 33–49 bytes and `pixelsFromPngStream` runs `png_read` (`inpaint_canvas.js:749-756`) in a pool worker (`DecompressionStream("deflate")` + Rust `png_unfilter_rows`), writing bands via `px.writeRect` (`normalizeBlock` -> `canvasRoundTrip()`) — also off the window with **zero GPU readback**.
         3. **Error handling**: If `err && err.partedRefused` (corrupt parted PNG rejected by both `readPngParts` and `png_read`, `inpaint_canvas.js:759`) or `h.width * h.height > CANVAS_MAX_PIXELS`, rethrows `err`. On any other stream error, falls through to the `createImageBitmap` fallback so Blink gives the final verdict (decoding exotic valid chunks or throwing on a genuinely damaged PNG).
   - **Fallback (`!this.tileMode`, `!pngReaderUsable()`, `InpaintEditor.oraParted === false`, `16`-bit, or Adam7 interlaced PNGs)**:
     - Runs the existing `createImageBitmap(pngBlob, { premultiplyAlpha: "none", colorSpaceConversion: "none" })` + `this.pixels.Layer.fromImage(bmp, bmp.width, bmp.height)` + `bmp.close()` (`inpaint_canvas.js:19039-19045`).
3. **Byte-for-byte straight-alpha parity**:
   - On `this.tileMode`, the current `createImageBitmap(..., { premultiplyAlpha: "none", colorSpaceConversion: "none" })` + `TileLayerPixels.fromImage` (`renderer/editor/inpaint_tiles.js:814-821`) draws onto a 2D canvas and reads back with `getImageData`, which applies the 2D canvas premultiply/unpremultiply round trip (`canvasRoundTrip()`, `renderer/editor/inpaint_resample.js:165-184`, clearing `R = G = B = 0` at `A === 0`).
   - Both `readPngParts` (`rt: canvasRoundTrip()` in `png_part_decode` + `px.putCanvasRows`) and `png_read` (`px.writeRect` -> `_putBlock(..., true)` -> `normalizeBlock` at `renderer/editor/inpaint_tiles.js:540-550, 1422`) apply the exact same `canvasRoundTrip()` table (already held to byte equality in `tools/editor_test.py:7140` `a_scumble_png_opens_through_the_parted_reader`, `docs/PLAN_WASM_BUILD.md:2009-2010`).
4. **Cancellation (`later()`) and arena leak prevention (`inpaint_canvas.js:19021-19049`)**:
   - Wraps the `for (const L of doc.layers)` loop in `try / catch`: checks `if (later()) throw new CancelledError("layered_open");` before and after each async decode, updates status per layer (`Reading the layers of ${name} ... layer ${i + 1} of ${doc.layers.length}`), and on any error or `CancelledError` releases every already-allocated `x.px` and `x.maskPx` across `doc.layers` before rethrowing so zero tile arena slots leak.
   - Records `streamMs` in `markStep("layered_open", "layers", { maskMs, rgbaMs, streamMs, bitmapMs, fromImageMs })`.

---

## 4. Verification, Mutation Rounds, Gates, and 15k Benchmarks

### 4.1 Unit, Twin, and Gate Tests

- **K20b**:
  1. **`tools/px_test.js`** (run under both `node tools/px_test.js` and `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron.cmd tools/px_test.js` on both `px.wasm` and `px_scalar.wasm`):
     - `packbitsRows` twin suite: empty (`0` rows / `0` width), literal runs, repeat runs, `0x80` no-ops, runs past `128`, short rows zero-padded (`o < rowBytes`), long rows truncated at `rowBytes` with `p` still advancing by `lens[y]`, dangling repeat byte `> 128` at `end - 1` and at `src.length - 1`, odd/unaligned slices, and guard checks (`null` pointers / short `out` returning `-1` without touching sentinel bytes).
     - `tiffToRgba` planar SIMD suite: `planes == spp` (`1, 2, 3, 4`), `photometric` `1` and `2`, `alpha` `"none"` and `"straight"`, `bits` `8` and `16` (`le = true` and `le = false`, plus exhaustive `65,536`-value `u16` sweep verifying `((v * 255 + 32895) >> 16) === ((2 * v + 257) / 514 | 0) === Math.round(v / 257)`), widths `1, 7, 15, 16, 17, 31, 32, 63, 257`, aligned and odd byte offsets.
     - `tiffUnpredict` `16`-bit `per == 1` (`le` and `!le`) SIMD vs scalar vs JS twin across widths `1..65` and odd offsets.
     - `psdMaskRgba` twin suite: `8`-bit and `16`-bit BE, full cover, partial overlap, negative layer/mask coordinates, disjoint mask, `0 × 0` mask, `def` `0` / `128` / `255`, widths `1..65`, and guard checks.
     - `psdKernels()` / `psdRead` trap & `PxOutOfMemory` mid-layer recovery check: inject a trap on band 2 of a 4-band masked layer, verify instance replacement, `0` leaked arena chunks, and byte-exact output via `PSD_JS` fallback.
  2. **`tools/layered_test.js`**:
     - Runs the entire 45+ PSD suite (raw, RLE, ZIP, 16-bit ZIP-with-prediction, grayscale, missing channels, `-2` / `-3` / 36-byte vector+real masks, groups, clipping, flat merged pictures, and all H1 S5 crafted refusals) through `twinned(mod)` (`per = 3` and `per = 256`) three ways: `kernels: null` (`PSD_JS`), `px.wasm` (SIMD), and `px_scalar.wasm` (scalar), plus `--twin-file` on the 15k PSD.
  3. **`tools/layered_test.py`**:
     - Extends `the_pool_and_the_window_read_a_psd_alike` (`:275-415`) on both backends to assert `jobs.psd_read` ran with `kernels === "rust"` and non-zero `pxCalls` (`packbits_rows`, `tiff_to_rgba`, `psd_mask_rgba`, and `tiff_unpredict` on `deep.psd`), then replays all 7 gate PSD fixtures with `InpaintEditor.setRoute("psdRead", "js")` asserting `kernels === "js"`, `pxCalls === {}`, and byte-identical layers, masks, and flat merged base.

- **K20c**:
  1. **`tools/layered_test.js`**:
     - Runs every ORA test and H1 S5 crafted ORA refusal (`crafted_bomb.ora`, oversized `stack.xml`, oversized PNG header, total pixel budget) through both `readOra(bytes, ...)` and `readOraBlob(new Blob([bytes]), ...)`, asserting identical `{ width, height, notes, lossy }`, identical layer metadata and PNG bytes, and identical refusal messages.
  2. **`tools/layered_test.py`**:
     - Adds an ORA route-parity and no-readback step on tiles (`an_ora_opens_through_the_parted_reader`):
       - Exports multi-layer ORA files with opaque, soft-alpha (`0 < a < 255` non-fixed-point straight RGBA), zero-alpha, offset, and nested-group layers via both `OraBandWriter` (parted PNGs) and single-IDAT PNGs (including a deflation-stored `method === 8` entry).
       - Opens each with default `oraParted` and with `InpaintEditor.oraParted = false` (and on canvas backend), asserting **0 byte difference** (`far === 0`) across `basePx` and every layer's `px`.
       - Asserts from `jobTimings` and `window.__n1` / canvas spy on tiles that opening Scumble's ORA runs `png_part_read` (`partFinishes === 0` on P5 ORA) with **`0` `createImageBitmap`** and **`0` `getImageData`** calls during `readLayered`.
       - Tests `later()` cancellation mid-ORA and a corrupt second-layer parted PNG (`partedRefused`), asserting clean refusal and full tile-arena slot return via CDP `HeapProfiler.collectGarbage` + `arenaStats().slots <= slots_before` (`renderer/editor/inpaint_arena.js:34, 76-91`, matching `parted_png_step` at `tools/editor_test.py:1691-1720`).

### 4.2 Gates (`--ports 9621,9622`, `--offline`) and Mutation Rounds

For both `K20b` and `K20c` (checking `machine_busy.lock` before any Electron launch and closing any started app):
- `python tools/build_px.py --check` (`K20b` rebuilds `px.wasm` and `px_scalar.wasm` first; `K20c` touches no Rust) and `python tools/build_node.py --check` (only expected `differs`, `0` missing/unexpected).
- Both-backend gates:
  ```bash
  SCUMBLE_GATES=F:/canvas/.claude/worktrees/ag-chain-p/dist/gates \
    bash tools/run_gates_both.sh <session>-both --ports 9621,9622 --offline \
    lint types layered export blendmodes groups pixels editor document
  ```
- Serial tiles-only gate:
  ```bash
  SCUMBLE_CDP_PORT=9621 SCUMBLE_GATES=F:/canvas/.claude/worktrees/ag-chain-p/dist/gates \
    bash tools/run_gates.sh <session>-serial --tiles on --offline pxjobs nodecopy
  ```
  (plus `tiff` on both backends in `K20b` because `crates/px/src/tiff.rs` gains planar and 16-bit `unpredict` SIMD fast paths).
- **Mutation rounds (`python tools/mutation_round.py`)**:
  - **K20b mutants (~20–24)**: `packbits_rows` literal/repeat boundary, `0x80` no-op, short-row zero-fill, `p0 = end` row advance, dangling repeat at `lim - 1`; `tiff::to_rgba` planar 8-bit shuffle lanes, missing-channel zeroing, 16-bit `(255 * v + 32895) >> 16` constant, grayscale replication; `tiff::unpredict` 16-bit BE carry; `psd_mask_rgba` `[ry0..ry1) × [x0..x1)` bounds and `def` fill; `readPsdStream` upfront `packedAtLeast` / `2 * h + total > dataLen` / `DEFLATE_MAX_RATIO` guards and `psdRead` `route("psdRead")` / `releaseIfLarge()`.
  - **K20c mutants (~14–18)**: `readOraBlob` EOCD scan bound, Central Directory / local header offset arithmetic, `ORA_XML_MAX` / `budget` / `ORA_LAYER_MAX_PIXELS` / `pixelBudget` guards, `onHeader` before layer reads; `readLayered` `this.tileMode` / `oraParted` / `h.bitDepth === 8 && !h.interlace` guards, `err.partedRefused` rethrow, and `later()` / `catch` `L.px.release()` arena cleanup.

### 4.3 15,000 × 10,000 A/B Benchmark Protocol and Expected Impact

Under `python docs/measurements/w1_2026-11-06/w1_lock.py`, **three alternating `before` / `after` rounds** (`git archive` of base commit vs session tree, fresh offline Electron instance per round on port `9621`, tiles on, focused):

- **K20b**:
  1. `python tools/native_test.py 15000x10000 build_the_file open_the_file add_the_paint_layer export_psd open_psd close` — `before` vs `after`, plus a same-build 3-round `psdRead=js` vs `psdRead=rust` A/B (`--set psdRead=js` vs `--set psdRead=rust`, `tools/native_test.py:102-122`).
  2. `node tools/layered_test.js --twin-file <15k.psd>` (SHA-256 parity + standalone `readPsdStream` JS vs Rust kernel timing) and `python tools/tiff_test.py --size 15000x10000 --variant noise,own` (`tools/tiff_test.py:27`).
  3. **Expected *(inferred)***: `psd_read` worker job `4,595 ms` (`channels 2,728 ms + interleave 1,650 ms`) → **`~650–950 ms`** *(inferred)* (`~5×` faster worker decode); `open_psd` wall `6,231 ms` → **`~2,500–3,000 ms`** *(inferred)* (with `1,476 ms` of the remainder in `stored` `uploadPixels`). Tie/loss decided by `open_psd` wall, with `jobs.psd_read.kernel` as §1.1 rule 2 tie-breaker.
- **K20c**:
  1. `python tools/native_test.py 15000x10000 build_the_file open_the_file add_the_paint_layer export_ora open_ora close` — `before` vs `after` (and `oraParted=false` vs default).
  2. **Expected *(inferred)***: `marks.layered_open.read` `89 ms` (`511.6 MB`) → **`< 5 ms`** *(inferred)*; `marks.layered_open.layers` `3,237 ms` (`bitmapMs 2,042 ms + fromImageMs 1,143 ms`) → **`~650–850 ms`** *(inferred)*; main-thread `blocked` `709 ms` → **`~50–75 ms`** *(inferred)* (`0` `getImageData` GPU readbacks); `open_ora` wall `4,986 ms` → **`~2,200–2,500 ms`** *(inferred)* with `uploadPixels` unchanged, or **`~950–1,300 ms`** *(inferred)* if Question 5.3's direct base-blob upload is enabled.

---

## 5. Open Questions for the User

1. **Single `psdRead` route vs split sub-kernel routes in `ROUTE_KINDS` (`K20b`)**
   - *Context*: Inside `psd_read`, each band unpacks (`packbits_rows`), optionally unpredicts (`tiff_unpredict`), and converts planar/mask bytes to RGBA (`tiff_to_rgba` / `psd_mask_rgba`) inside one `PxArena` scope so unpacked planes are never copied out to JS and back into wasm. Splitting `packbitsRows` and `tiffToRgba` into separate JS↔wasm round trips would add `1.2 GB` of extra copies per 15k layer, whereas keeping one fused band call can either check a single `psdRead: "kernel"` route or check `packbitsRows` / `psdMaskRgba` inside wasm (with JS fallbacks over `p.view(...)`, as `K10c` did for `clipCoverage` / `dissolveRows`).
   - *Suggested answer*: Add **one `psdRead: "kernel"` route** in `ROUTE_KINDS` controlling `psdKernels()` as a unit (plus honoring `tiffUnpredict` / `tiffToRgba` when explicitly set to `"js"` in `px_test.js`). All four inner steps run only together inside `psd_read`, and `native_test.py --set psdRead=js` gives a clean whole-reader JS-twin vs Rust A/B.

2. **Blob-sliced ZIP reading (`readOraBlob`) vs `file.arrayBuffer()` in `K20c`**
   - *Context*: Today `readLayered` (`inpaint_canvas.js:19006`) reads the entire `.ora` into one `Uint8Array` (`511.6 MB` at 15k, of which `235.2 MB` is `mergedimage.png` that `readOra` ignores) and copies each layer again into `new Blob([L.png])`. Adding `readOraBlob(blob, ...)` (`~40` lines in `inpaint_layered.js`, sharing the XML parser and all H1 S5 checks with `readOra`) slices stored layer PNGs directly from `file` with zero copies and never reads `mergedimage.png`.
   - *Suggested answer*: **Yes, include `readOraBlob` in `K20c`** while keeping `readOra(bytes, ...)` unchanged for byte-array callers and `layered_test.js` parity checks.

3. **Uploading a covering ORA bottom layer's PNG `Blob` directly vs re-encoding `basePx` (`K20c`)**
   - *Context*: In `loadLayered` (`inpaint_canvas.js:19165, 19174`), when `layers[0]` covers `0, 0, W, H` (`visible && opacity >= 0.999 && blend === "normal" && !maskPx`), it becomes `basePx` and `uploadPixels(basePx, stem)` re-encodes `basePx` into a new PNG (`79` `png_part` jobs, `1,468 ms` at 15k). For an ORA whose promoted `layers[0]` came from a plain sRGB 8-bit non-interlaced PNG (`pngIsPlainSrgb(b.pngBlob)` — always true for Scumble's own `OraBandWriter` / `OraWriter` exports), `b.pngBlob` is already that PNG, and uploading `b.pngBlob` via `uploadBlob` in parallel with `pixelsFromPngStream` (just as `P5` Question 6.5 now does in `loadFile`, `inpaint_canvas.js:18932-18951`) would save another `~1.1–1.4 s` *(inferred)* on `open_ora` without touching `open_psd`. The only nuance is that if an external editor wrote non-round-tripped straight-alpha RGB under `0 < A < 255` in `layers[0]`, `b.pngBlob` holds the original straight-alpha PNG bytes rather than `canvasRoundTrip()`-normalised bytes (restoring into Scumble still normalises them identically; ComfyUI's server `LoadImage` sees the original PNG bytes, just as `loadFile` on a PNG already does).
   - *Suggested answer*: **Yes, upload `b.pngBlob` directly (overlapped with layer decode, like Question 6.5) when `b` is promoted to `basePx` and `b.pngBlob` passes `pngHeader` (`8`-bit, non-interlaced) + `pngIsPlainSrgb`**, falling back to `uploadPixels(basePx, stem)` otherwise. (If you prefer `K20c` to change only `readLayered` and leave `loadLayered`'s `uploadPixels` untouched, say **No** and `K20c` will touch `readLayered` only.)

4. **External ORA layer PNGs with colour chunks (`iCCP`, `gAMA`, `cHRM`, `cICP`) (`K20c`)**
   - *Context*: Today `readLayered` (`inpaint_canvas.js:19039`) passes `colorSpaceConversion: "none"` to `createImageBitmap`, so colour profiles and gamma chunks in ORA layer PNGs are ignored and raw PNG sample values are kept. `readPng` (`inpaint_png.js:251-252`, used by `png_read`) also ignores colour profiles and keeps raw sample values, whereas `pngPartsOf` returns `null` when `iCCP` / `gAMA` / `cHRM` / `cICP` is present (falling through in `pixelsFromPngStream` to `png_read`). Thus routing all 8-bit non-interlaced ORA layers through `pixelsFromPngStream` preserves **100% byte-for-byte parity** with today's `colorSpaceConversion: "none"` behaviour.
   - *Suggested answer*: **Keep today's raw-sample (`colorSpaceConversion: "none"`) behaviour** by routing all 8-bit non-interlaced ORA layers through `pixelsFromPngStream` (`readPngParts` for parted PNGs, `png_read` for single-stream PNGs) without gating on `pngIsPlainSrgb`.
