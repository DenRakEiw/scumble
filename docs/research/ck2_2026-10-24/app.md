# app

## Summary

Read-only survey of F:\canvas (wasm-kernels branch, 2026-10-24). Nothing was run and nothing was fetched from the web. These findings decide the design:

1. The existing in-app cutout is a narrow path that suits a still keyer: editor -> host.cutoutInApp -> IPC helpers:cutout -> onnx/index.js -> matting.js. It moves a fixed 1024² RGBA in and 1024² u8 alpha out, and lands as a **layer mask** (one undo step of kind "mask"). It is not safe for large documents: applyCutoutImage builds a full W×H canvas and two full ImageData, so it throws above 268 MP. A keyer needs a banded landing (MaskPixels.combine with an AlphaSource, as selectLogits does).
2. Layers are 8-bit only. Tiles store straight RGBA8, normalised through Chromium's premultiplied round trip. The compositor blends gamma-encoded bytes with premultiplied 8-bit integer maths and never converts to linear. The only 16-bit store is the document map (inpaint_maps.js). The cleanest landing for an unmixed foreground plus alpha is probably a new layer whose pixels are the opaque foreground and whose layer mask is the alpha. That keeps full colour precision and stays editable (inferred).
3. Every helper except LaMa runs synchronously on the **main process thread**. DirectML once inflated main to 24.7 GB after one BiRefNet-lite run (BUGS.md B5). A model of about 5 GB belongs in a killable utility process, as LaMa's does.
4. The model registry assumes flat single files. The downloader has no hash check, no overall progress and no external-data handling. It also sends the Hugging Face token to any URL.
5. The project already has the patterns a live hint loop needs:
   - SAM2's cached encoder with a cheap decoder (sam2.js, segmentKey).
   - Relight's quick map at quarter size during a drag, with tickets, drawSoon and the full map on pointer-up.
   - Hint sources: the selection brush, quick mask (Q), mask painting (P/E), and selectionCanvasSettled for a downscaled hint.
6. Test tiers: registry and IPC shapes are Light (plain Node). The tool and its landing are Normal, on both backends because a pixel path changes. Full applies only for a Rust kernel, a .scumble format change, or compositor or export changes.

## Report

# Where a green / blue screen keyer lands in Scumble (read-only survey, F:\canvas at `ec1142b`, 2026-10-24)

Legend: **[read]** = seen in the source, **[inferred]** = my reasoning from what I read, **[unverified]** = a claim I could not check. Nothing was run. No web, model or ComfyUI was touched. The scratch folder was created and left empty.

---

## 1. The existing in-app cutout, end to end

**UI entry**
- Each layer's mask row has a scissors button that calls `this.cutoutLayer(layer)` (`renderer/editor/inpaint_canvas.js:19118-19127`, `buildMaskRow`). Beside it is the backend select `this.cutoutSel`. [read]
- The backend list is `availableCutoutBackends()` (`inpaint_canvas.js:1307-1310`). It joins two sources [read]:
  - the in-app list `host.cutoutBackends()`, which gives ids `app:<model>` with `inApp: true` (`renderer/editor/host.js:4833-4835`);
  - the ComfyUI helper list `CUTOUT_BACKENDS`: RMBG / BiRefNet / BEN2 prompts with `needs`, `build` and `maskOut` (`inpaint_canvas.js:1257-1290`).

**`cutoutLayer(layer)`** (`inpaint_canvas.js:16332-16366`) [read]
- Refuses while a resizing run holds the document (`resizingRun()`, `:12489`).
- Refuses while `this.cutoutPending` is set.
- Shows "Removing the background of … with …".
- For `inApp` it awaits `host.cutoutInApp(this, layer, backend)`, then `applyCutoutImage`. It answers `"done"`, `"started"` (a ComfyUI run, finished later in `applyCutoutFile`, `:16369`) or `false`.

**`host.cutoutInApp`** (`host.js:5065-5083`) [read]
- Input is `cutoutInput(editor, layer)` (`host.js:4945-4967`): the layer's **own pixels, no mask, squashed non-uniformly to 1024×1024 on black**.
  - On tiles: `px.primeRegion` at `editor.tileLevel(s)` with `s = min(1, max(1024/pw, 1024/ph))`, then `drawTilesInto` under a `setTransform`. No full-size copy.
  - On canvases: `modelInput(px.toCanvas(), 1024, "#000000")` (`:4975-4983`, smoothing "high").
- Then `helperCall("cutout", { model, image })` (`host.js:4814`). This is the single member gates stub out.
  - → preload `helpers.cutout` (`electron/preload.js:194`)
  - → `ipcMain.handle("helpers:cutout")` (`electron/main/main.js:1223`).
- `editor.helperUsed = true`, so the sessions are freed before a local ComfyUI run.
- The u8 alpha answer is written into a 1024² grey canvas (R=G=B=a, A=255).
- Status line: `"<layer>: background removed with <model> in N s (<provider>)."`, plus `slowHelperHint` (`host.js:5344`; a GPU run over 15 s suggests Free VRAM).

**Main process** (`electron/main/onnx/index.js`) [read]
- `cutout(req)` (`:245-256`):
  - `checkImage` insists on exactly 1024²×4 bytes.
  - `mattingFor` picks the model via `presentOf("matting", id)` (falls back to the first present model).
  - `busy.add("cutout")`.
  - Returns `{ alpha: Uint8Array(1024²), size, seconds, provider, model, label }`.
- `Matting.run` (`electron/main/onnx/matting.js:22-46`):
  - `runtime.session(file, { auto: ["cpu"] })`: on the "auto" device matting runs on the CPU (BUGS.md B5).
  - `normalise` to CHW float32 with the registry's mean/std.
  - Takes the first output tensor with 1024² values; applies a sigmoid if the range leaves [-0.01, 1.01].
  - Rounds to u8.
  - Releases a GPU session after each run.

**Landing: `applyCutoutImage(img, pending)`** (`inpaint_canvas.js:16386-16423`) [read]
- Draws the grey answer to the layer's pixel size on `makeCanvas(W, H)`, with default smoothing.
- `getImageData` of the whole layer, then a second full `ImageData` with RGB=255 and A=R.
- `this.pixels.Mask.fromImageData(out)`, then `pushUndo({ kind: "mask", id, label: "Remove background" })`.
- Sets `layer.maskPx = m; maskOff = false; maskEdit = false`, then `markMaskChanged(layer)` (`:16292`) and the status "N% kept. Enable mask editing to touch it up with P / E."
- So the cutout is **non-destructive**: pixels are untouched and the matte becomes the layer mask. One undo step.

**Large-document gap** [inferred]
- The landing makes one W×H canvas plus two W×H ImageData. At 15000×10000 that is about 600 MB each.
- `makeCanvas` throws above 268 MP or 65,535 px a side (`renderer/editor/inpaint_pixels.js:71-75`).
- So this landing is not band-safe and fails on "huge" documents.

**SAM2 click path** (a model of "encode once, cheap head per prompt") [read]
- `host.selectPoint` (`host.js:5163`) → `segmentLogits` (`:5112`).
- `segmentKey` (`:5090`) caches the key per `compositeVersion` and an input SHA-1.
- `helpers:segment` with `raw: true` answers 256² float logits. If main lost the embedding, it retries with the image.
- → `editor.selectLogits` (`inpaint_canvas.js:7885`): `pushUndo({kind:"selection"})`, then worker jobs `range_select` with `source: "logit"`. These upsample the logits bilinearly per 256-row band (`RANGE_BAND_ROWS`) and combine into `this.sel` with `MaskPixels.combine(tilesSource(...), mode)` (`:7940-7975`).
- Staleness guards: `editor._pointPending`, and `objectsPending.hash` in `findObjects` (`host.js:5018-5058`).

**MCP command** [read]
- `cutout_layer` (`renderer/commands.js:1999-2016`): params `layer` and `timeout` (default 300). Throws "a background removal is still running". Waits on `cutoutPending` for ComfyUI runs. Returns `layerSummary`.
- Assistant policy: `cutout_layer` is in the `RUNS` set (`electron/main/assistant/policy.js:21`), asks with a reason (`:159`), default timeout 300 (`:400`).
- The tool count (116) is written in `README.md:83,303` and `docs/MCP.md:306`. `tools/mcpb_build.js:39` reads the tools from `docs/COMMANDS.md`, which `tools/commands_doc.py:24` groups.

**Threading** [read]
- `docs/HELPERS.md:241-252`: "Every model but LaMa runs on the main process's thread". `InferenceSession.create` and `run` are synchronous native calls, so IPC, ComfyUI events, MCP and autosave wait.
- LaMa runs in an Electron utility process (`electron/main/onnx/lama.js:1-24`, `lama_process.js`), killable on folder change, scan and quit. HELPERS.md lists "SAM2 and the matting models in a process like LaMa's" as open.
- B5 (`docs/BUGS.md:110-120`): DirectML took main to **24.7 GB private bytes after one 1024² BiRefNet-lite run**. The CPU without its arena stayed at 0.37 GB. `runtime.js:105-107` turns the CPU arena off for that reason.

## 2. Real alpha and colour in a layer

**Tile storage** [read]
- 256×256 tiles of **straight-alpha RGBA8** (`renderer/editor/inpaint_tiles.js:3-5`). Sparse: a tile whose alpha is all zero is dropped (`:8-9`).
- Bytes that enter without a canvas (`writeRect` "copy", `fromImageData`) go through "the round trip a canvas applies to straight alpha (premultiply, un-premultiply)" (`:27-30`). That is a measured lookup table (`canvasRoundTrip`, `inpaint_resample.js:165-184`), applied by `normalizeBlock` (`inpaint_tiles.js:537-553`).
- The GPU atlas holds **premultiplied** RGBA8 (`:1103-1115`, `premulTable` `:639-650`).
- [inferred] A straight colour at alpha *a* survives with roughly *a+1* distinct levels per channel. Colour at near-zero alpha is coarse.

**Canvas backend** [read]
- Straight in and out (`inpaint_pixels.js:39`). Canvas 2D itself stores premultiplied 8-bit.

**Compositor** [read]
- `crates/px/src/composite.rs:1-21`: straight RGBA8 in and out, premultiplied 8-bit integer maths in between. Blend modes follow the W3C formulas on byte values.
- No sRGB/gamma/linear conversion found in `composite.rs` or `inpaint_compositor.js`.
- [inferred] Layers composite in gamma-encoded space. A matte made for linear-light "over" will look different on soft edges (hair, motion blur) than in a linear compositor.
- [unverified] Whether CorridorKey's foreground output is sRGB-encoded or linear.

**No 16-bit layer path** [read]
- 16-bit TIFF and PSD are rounded to 8 on read (`inpaint_tiff.js:11,241`; `inpaint_layered.js:128,393`).
- The only 16-bit store is the **document map** (`renderer/editor/inpaint_maps.js:13-60`): Uint16 `data`, an affine `xf` to document pixels, versioned, persisted as RG16 PNG via `mapToJSON` / `mapFromJSON` (`:244-320`). It is used for depth, the guide and a "sky mask".
- [inferred] A 16-bit matte at model resolution could live there and be resampled at use time. That adds to `.scumble` (Full tier).

**Masks** [read]
- `MaskPixels` (`inpaint_pixels.js:584`) is RGBA. A layer mask is white (`MASK_RGB`, `inpaint_canvas.js:345`) with alpha = shows; the selection is red.
- `markMaskChanged` (`:16292`) is the change hook. `applyMask` bakes it with undo kind `layerfull` (`:16767-16770`).
- `set_mask` ops: invert / reveal / hide / from_selection / from_layer / disable / enable / apply / remove (`commands.js` near 2017).
- Mask views: overlay / alone (black and white) / effect (`inpaint_canvas.js:16644-16654`).
- Mask editing: `maskEdit` plus P/E paints the mask (`:6330-6336`).

**Writing a full-resolution result without a whole canvas** [read]
- `pixels.Layer.empty(W, H)`, then `writeRect(ImageData, x, y)` per band. The tile version is `inpaint_tiles.js:1406-1420`: copy plus normalisation, no canvas.
- Masks: `MaskPixels.combine(alphaSource, "replace" | "add" | ...)` in 256-row bands (`inpaint_pixels.js:599-640`; tile override `inpaint_tiles.js:2556`).
- AlphaSources: `rectSource`, `bytesSource`, `tilesSource` (`inpaint_raster.js:367-440`).
- `selectLogits` is a working example of worker bands feeding `combine` (`inpaint_canvas.js:7940-7975`).

**Landing options** [inferred]
- **A. New layer, opaque foreground pixels plus the alpha as layer mask.**
  - Keeps full 8-bit colour, because the round-trip loss only happens at alpha < 255.
  - Non-destructive and editable with P/E; inspectable with "Show alone".
  - Matches the cutout's "matte becomes mask" habit.
  - Cost: the pixel layer is dense (600 MB at 15k), plus mask tiles where alpha > 0.
- **B. New layer, straight RGBA = (fg, a).**
  - Sparse in the background.
  - Colour quantised at low alpha; no editable matte.
- **C. Mask on the source layer, as cutout does.**
  - Loses the unmixed foreground colour, so the green spill stays.
- Undo for A or B: `pushUndo({ kind: "layers", label })`, then `addLayer({ kind: "image", px, maskPx, x:0, y:0, w, h, ... })`. This is exactly realismWhole's landing (`host.js:3551-3554`; `addLayer` `inpaint_canvas.js:18657-18689`), including moving the layer under a top run of filter layers.

## 3. A hint the user paints, and a live preview

**Painting tools that already exist** [read]
- **Selection brush.** Tools `select` / `deselect` → pointer kind `selpaint` (`inpaint_canvas.js:6169`) → `selectionDab` (`:6961-6986`): a round stroke into `this.sel` through `drawInto`, then `touchSourceRect`. Pointer-up runs `markSelectionChanged(bounds, rect)` (`:6832-6836`, `:14942-14960`), which bumps `selectionSeq`.
- **Quick mask** `Q` (`toggleQuickMask`, `:9338-9344`): paint selects, erase deselects, bucket = magic wand (`:6216`, `:6324-6327`).
- **Layer-mask painting.** `maskEdit` plus P/E → pointer kind `maskpaint` with a `StrokeBuffer` (`:6330-6336`). Pointer-up → `markMaskChanged`.
- The selection is a W×H `MaskPixels` (red, alpha = selected; `:2144`).
- `select_mask` (`commands.js:1023-1040`) lets an agent hand a hint as an array or a base64 PNG.

**Reading a hint at model size** [read]
- `selectionCanvasSettled(box, scale, w, h)` (`inpaint_canvas.js:9209-9225`): tiles only, from the mask's mip levels, no 600 MB mirror. It returns null on canvases.
- Canvas fallback: `sel.drawTo`, as depth-edit does (`:13666-13680`).
- A layer's mask can be read through `primeRegion` the way `objectInput` reads a layer with its mask (`host.js:4899-4940`).

**Picture input at model size** [read]
- `host.pictureInput(editor, w, h, { skipFilters, background })` (`host.js:4992-5011`): one `sampleRegionSettled("image", whole, s ≤ 1, { forRun: true })` pass from tile levels.
- `pictureInputBox` (`:5235-5260`) does the same for a crop.
- `sampleRegionSettled` waits for relight's full maps first (`inpaint_canvas.js:9189-9200`).

**Live-preview precedent: relight**
- Pointer-move on a light [read]:
  - `this.filterPreview = layer.id`;
  - `ensureRelightMaps(layer, { quick: true })`: quarter-size maps, posted to the pool at priority `INTERACTIVE`, with tickets and `seq` so a stale answer cannot overwrite (`inpaint_canvas.js:23327-23460`);
  - `markFilterChanged(layer, { soon: true })` → `drawSoon()`, one draw per animation frame (`:15388-15400`, `:22800-22804`; call site `:6717-6721`).
- Pointer-up: `filterPreview = null`, the full maps, a normal `markFilterChanged` (`:6918-6923`).
- Keyboard nudges are debounced at 300 ms, then the full pass and one undo step (`:3664-3681`).
- `pickVis` decides quick vs full, and a run never reads the quick map (`renderer/editor/inpaint_relight.js:1298-1324`).
- Trap: `requestAnimationFrame` stops in a hidden window. Gate waits use `setTimeout` (CLAUDE.md traps). [read]

**"Light head per stroke" hook** [inferred]
- The closest precedent is SAM2: `Sam2.encode` caches up to three embeddings by key in main (`electron/main/onnx/sam2.js:54-73`), and `predict` / `decode` runs only the light decoder. The renderer sends the key (`host.segmentKey`) and the image only when main lost the embedding.
- A keyer would:
  - encode (heavy backbone) once per picture version, keyed like `segmentKey` (`compositeVersion` + input hash);
  - on each hint change (pointer-up in `markSelectionChanged` / `markMaskChanged`, or throttled inside pointer-move like relight), send only the downscaled hint plus the key;
  - show the answer as a preview (quick, model-resolution matte, dropped when its ticket is stale);
  - land banded only on Apply.
- Every head run blocks main's thread unless the model lives in a utility process.
- [unverified] Whether CK2's backbone and hint head can be split into separate ONNX graphs (Neex: the alpha hint "also works in real time").

## 4. Settings › Helpers, the registry and a 5 GB multi-file set

**Registry entry shape** (`electron/main/onnx/models.js:16-73`) [read]
- `{ id, kind, label, note, source, sourceUrl, license, gated?, input, mean, std, multiple?, files: [{ name, role, size, url }] }`.
- LaMa and DA2 are pinned to commit URLs; the sha256 values are comments only.
- Non-commercial models are already offered as user downloads: `rmbg14` (BRIA non-commercial) and `rmbg2` (CC BY-NC 4.0, gated) (`:45-56`).

**Lookup** [read]
- `findFile` searches the folder plus flat `SUBDIRS` (`:78-95`).
- `locate` / `describeAll` / `paths` give paths keyed by role (`:102-135`).

**Scan** [read]
- `scanFolder` + `matchScan` (`:176-236`) match by exact name, by a byte size unique in the registry, or by an HF snapshot alias. The alias works for single-file models only (`:225`).
- PyTorch weights are reported in `elsewhere` via `OTHER_WEIGHTS` regexes and never loaded.
- `configure({dir})` rescans (`index.js:72-95`).
- A ComfyUI models folder (detected by `checkpoints/` or `diffusion_models/`) receives downloads in `onnx/` (`models.js:80-87`).

**Downloader** (`models.js:240-331`) [read]
- Files go sequentially, present files are skipped, `.part` files resume with `Range`.
- **An exact size check, no hash check** (`:326-327`).
- 401/403 on a `gated` model gives the "accept its licence … save your Hugging Face token" message.
- **The HF token is sent as `Authorization: Bearer` to every file URL, whatever the host** (`:298-299`). [read; risk inferred]
- Progress events are `{ id, file, received, total }` per file. The UI shows the current file only (`renderer/shell.js:2088-2090`, bar `:2136-2143`), so there is no overall percentage for a multi-file set. [read / inferred]
- No free-disk check. [inferred from code]

**Token, device and UI** [read]
- HF token: `keys.js` `"hf-token"` (`index.js:20,49`); UI at `shell.js:2147-2174`.
- Device: auto / gpu / cpu (`runtime.js:68-73`). Per-model auto lists exist (matting is CPU on auto). Windows ships DirectML only (onnxruntime-node 1.29.0 with `DirectML.dll`; `package.json:38`). There is no CUDA on Windows.
- `renderHelpers` (`shell.js:2046-2156`): one row per model with Download / Cancel / Remove / Unlink, the license, the note, and a kind label map (`:2077`).

**What a new `kind` touches** [read + inferred]
- `models.js`: `MODELS`, `SUBDIRS`, `ONNX_ALIASES`, `OTHER_WEIGHTS` (the ComfyUI packs' `.pth` / `.safetensors` would show in `elsewhere`).
- `index.js`: `DEFAULTS`, `MISSING`, an instance map, `clearInstances`, `remove`, `free`, `status`.
- `settings.js:23` (it already lacks `depth`).
- `shell.js:2077`, `host.presentHelpers`, plus a new `helpers:key*` IPC in `main.js:1211-1226` and `preload.js:182-198`.

**5 GB specifics** [inferred]
- ONNX protobuf caps a single file at 2 GB, so a 5 GB graph needs external-data files.
- ONNX Runtime resolves external data by the name stored inside the graph, relative to the `.onnx` file's folder. The registry's rename-on-download (`name`) and the flat download folder are therefore traps: data files must keep their original names and must not collide (e.g. two `model.onnx_data`).
- Several sub-models (item 49 names C-RADIOv4, MoGe-2, RVM [unverified]) mean several sessions.
- Given B5, running them on main's thread under DirectML is a large memory risk. A LaMa-style utility process is the safe home. It is untested whether DirectML works inside a utility process; LaMa is CPU-only.

## 5. Gates and tests, by CLAUDE.md tier

| Gate or test | What it covers | Source |
|---|---|---|
| `node tools/helpers_test.js` | ONNX modules without Electron; skips missing models | `docs/TESTING.md:80`, `docs/HELPERS.md:360-366` |
| `node tools/scan_test.js` | Registry sizes via `ftruncate`, so a 5 GB entry costs no disk | `tools/scan_test.js:11,39-43` |
| `commands` | Stubs `host.cutoutBackends` / `cutoutInApp` for `cutout_layer` | `tools/commands_test.py:2230-2273` |
| `editor` | Stubs `host.helperCall` | `tools/editor_test.py:3516-3689,7247` |
| `selection`, `maskview`, `depth` (model + IPC + command precedent) | | `docs/TESTING.md:169` |
| `mcp`, `mcpb`, `assistant` | Tool count and docs, `policy.js` | |
| `node` / `nodecopy` (`build_node.py --check`) | Every `host.*` the editor calls must exist in the node's host too | CLAUDE.md "How the app is put together"; capability flags like `removeSupported` / `depthSupported`, `host.js:4838-4842` |
| `lint`, `types` | | |

Tiers (CLAUDE.md:1047-1055) [read; mapping inferred]:
- **Light:** registry entry, downloader changes, IPC request shapes (plain-Node tests).
- **Normal:** the keyer tool, hint painting, preview and landing as layer + mask. One gate step on tiles, plus the canvas backend because a pixel path changes. No mutation round.
- **Full** only if the work adds:
  - a Rust kernel (e.g. matte upsampling or a guided filter in `crates/px`);
  - a `.scumble` change (a stored 16-bit matte map, new layer fields);
  - compositor or export-writer changes.

## 6. Whole-picture work on large documents (15k)

**Reading** [read]
- Model inputs come from tile mip levels at s ≤ 1 (`pictureInput`, `objectInput`, `cutoutInput`). There is no full flatten.
- `bandPlan` / `readBand` / `encodeComposite` composite in bands with a reach margin (`inpaint_canvas.js:22550-22640`). `readBox` reads a crop (`:9227-9237`).
- `flattenToCanvas` throws on `huge` documents over 268 MP (`:22529-22533`).

**Limits** [read]
- Canvas: 65,535 px a side and 268 MP (`inpaint_pixels.js:71-75`).
- WebGL drawing buffer: about 33 MP (CLAUDE.md traps).
- **An IPC message of 600–800 MB ends the renderer; 500 MB went through** (G2, CLAUDE.md:218).
- So full-resolution buffers must never cross IPC. A 2048² RGBA input is 16 MB and a 2048² float RGBA answer 64 MB. [inferred arithmetic]

**A model at its own resolution** [inferred]
- At 15000×10000, a 2048 long side means a 7.3× upsample of the matte.
- In-repo precedents:
  - SAM2's 256² logits upsampled bilinearly in worker bands (`range_select`);
  - the depth map at a working size ≤4096 refined by a guided filter against the picture in workers (`depth_guide`; HELPERS.md);
  - the depth "Detail" grid: 2×2 or 3×3 overlapping tiles plus a global pass, fused in a worker (`host.js:5268-5330`; `inpaint_edges.js:178` `tileBoxes`, `:393` `fuseTiles`);
  - Remove's crop box at model size (`renderer/editor/inpaint_remove.js:14-23`).
- For a matte, tile seams and colour precision at edges are the risks. Keying a crop (the subject's box) at higher effective resolution is the cheap win.

**Memory** [inferred]
- A 15k RGBA8 layer is 600 MB. A mask is RGBA too (`MaskPixels extends LayerPixels`) but sparse where alpha is 0.
- `applyCutoutImage`'s full-size canvas plus two ImageData must be replaced by a banded writer.

## Facts

- [read] In-app cutout chain: buildMaskRow scissors button -> cutoutLayer -> host.cutoutInApp -> helperCall('cutout') -> preload helpers.cutout -> ipcMain 'helpers:cutout' -> onnx/index.js cutout -> Matting.run (renderer/editor/inpaint_canvas.js:19118-19127,16332-16366; renderer/editor/host.js:4814,5065-5083; electron/preload.js:194; electron/main/main.js:1223; electron/main/onnx/index.js:245-256; electron/main/onnx/matting.js:22-46)
- [read] The cutout input is the layer's own pixels without its mask, squashed non-uniformly to 1024x1024 on black; on tiles it is read from mip levels via primeRegion, with no full-size copy (renderer/editor/host.js:4945-4967,4975-4983)
- [read] Main's cutout requires exactly 1024*1024*4 bytes and answers a Uint8Array 1024^2 alpha; matting applies a sigmoid when outputs leave [-0.01,1.01] and runs on the CPU on the 'auto' device (electron/main/onnx/index.js:200-204,245-256; electron/main/onnx/matting.js:22-46)
- [read] applyCutoutImage scales the grey answer onto a full W x H canvas, reads two full ImageData, sets layer.maskPx (white RGB, A = answer) with one undo step of kind 'mask', and leaves the layer pixels untouched (renderer/editor/inpaint_canvas.js:16386-16423)
- [inferred] makeCanvas throws above 268 MP or 65,535 px a side, so the cutout landing cannot run on huge documents and costs about 600 MB per buffer at 15000x10000 (renderer/editor/inpaint_pixels.js:71-75; arithmetic)
- [read] The cutout_layer MCP command takes layer and timeout (default 300), throws while cutoutPending is set, and returns layerSummary; the assistant policy treats it as a run with an ASK and a 300 s timeout (renderer/commands.js:1999-2016; electron/main/assistant/policy.js:21,159,400)
- [read] Every in-app model except LaMa runs synchronously on the main process thread, blocking IPC, MCP and autosave; LaMa runs in a killable Electron utility process (docs/HELPERS.md:241-252; electron/main/onnx/lama.js:1-24)
- [read] DirectML took main to 24.7 GB private bytes after one 1024^2 BiRefNet-lite run; the CPU without its arena stayed at 0.37 GB (docs/BUGS.md:110-120; electron/main/onnx/runtime.js:105-107)
- [read] Tiles store straight-alpha RGBA8; bytes entering without a canvas are normalised through the measured canvas premultiply/un-premultiply round-trip table (renderer/editor/inpaint_tiles.js:3-5,27-30,537-553; renderer/editor/inpaint_resample.js:165-184)
- [inferred] The compositor kernel is straight RGBA8 in and out with premultiplied 8-bit integer maths and no sRGB/linear conversion, so layers blend in gamma-encoded space (crates/px/src/composite.rs:1-21; no srgb/gamma hits in renderer/editor/inpaint_compositor.js)
- [read] There is no 16-bit layer path: 16-bit TIFF and PSD samples are rounded to 8 bits on read (renderer/editor/inpaint_tiff.js:11,241; renderer/editor/inpaint_layered.js:128,393)
- [read] Document maps hold Uint16 data with an affine xf and are persisted as RG16 PNG; they are used for depth, guide and sky mask (renderer/editor/inpaint_maps.js:1-60,244-320)
- [read] MaskPixels.combine writes an AlphaSource into a mask in 256-row bands; rectSource, bytesSource and tilesSource exist; selectLogits uses worker range_select bands with combine (renderer/editor/inpaint_pixels.js:599-640; renderer/editor/inpaint_tiles.js:2556; renderer/editor/inpaint_raster.js:367-440; renderer/editor/inpaint_canvas.js:7885-7975)
- [read] The realismWhole landing pattern is pushUndo({kind:'layers'}) then addLayer({kind:'image', px, x:0, y:0, w, h}), moved under the top run of filter layers (renderer/editor/host.js:3551-3560; renderer/editor/inpaint_canvas.js:18657-18689)
- [read] The selection is a W x H MaskPixels (red, alpha = selected) painted by the select/deselect brush via selectionDab; pointer-up calls markSelectionChanged, which bumps selectionSeq (renderer/editor/inpaint_canvas.js:2144,6169,6961-6986,6832-6836,14942-14960)
- [read] Quick mask (Q) makes paint/erase/bucket edit the selection; layer-mask painting uses maskEdit with P/E through a StrokeBuffer (renderer/editor/inpaint_canvas.js:9338-9344,6216,6324-6336)
- [read] selectionCanvasSettled reads the selection downscaled from mask mip levels on tiles and returns null on canvases, where callers fall back to sel.drawTo (renderer/editor/inpaint_canvas.js:9209-9225,13666-13680)
- [read] Relight's live preview: during a drag it computes quarter-size quick maps in pool jobs (INTERACTIVE priority, tickets/seq), redraws via drawSoon (rAF-coalesced), and computes full maps on pointer-up; pickVis never gives a run the quick map (renderer/editor/inpaint_canvas.js:6717-6721,6918-6923,15388-15400,22800-22804,23327-23460; renderer/editor/inpaint_relight.js:1298-1324)
- [read] SAM2 caches up to three encoder embeddings by key in main and runs only the decoder per prompt; the renderer keys by compositeVersion plus an input hash (electron/main/onnx/sam2.js:54-73; renderer/editor/host.js:5090-5130)
- [read] Registry entries are {id, kind, label, note, source, sourceUrl, license, gated?, input, mean, std, files:[{name, role, size, url}]}; non-commercial RMBG models are already offered as optional downloads (electron/main/onnx/models.js:16-73)
- [read] The downloader checks exact size only (no hash), resumes .part files with Range, and sends the Hugging Face token as Bearer to every file URL regardless of host (electron/main/onnx/models.js:292-330)
- [read] Download progress is per file and the Settings UI shows the current file only, with no overall progress for a multi-file model (electron/main/onnx/models.js:253-256,317-323; renderer/shell.js:2088-2090,2136-2143)
- [read] A ComfyUI models folder (checkpoints/ or diffusion_models/ present) gets downloads in its onnx/ subfolder; the scan reports PyTorch weights as 'elsewhere' and never loads them (electron/main/onnx/models.js:80-87,147-236)
- [read] onnxruntime-node is 1.29.0 and ships DirectML.dll on Windows (no CUDA provider on Windows) (package.json:38; node_modules/onnxruntime-node/bin/napi-v*/win32/x64 listing)
- [inferred] A 5 GB ONNX model needs external-data files, whose names inside the graph must be kept beside the .onnx; the registry's rename-on-download and the flat download folder would break or collide them (electron/main/onnx/models.js:89-95,269-273 plus general ONNX knowledge)
- [read] An IPC message of 600 or 800 MB ended the renderer while 500 MB went through, so full-resolution buffers must not cross IPC (CLAUDE.md:218 (G2, docs/measurements/g2_2026-10-24/))
- [read] bandPlan, readBand, encodeComposite and readBox exist for whole-picture work in bands; flattenToCanvas throws on huge documents (renderer/editor/inpaint_canvas.js:22529-22640,9227-9237)
- [read] The depth Detail pass tiles the picture in a 2x2 or 3x3 grid plus a global pass and fuses the tiles in a worker (depth_fuse) (renderer/editor/host.js:5268-5330; renderer/editor/inpaint_edges.js:178,393; renderer/editor/inpaint_worker.js:1395)
- [read] Gates stub the model through host.helperCall or host.cutoutInApp, so no model file is needed (tools/commands_test.py:2230-2273; tools/editor_test.py:3516-3689)
- [read] Test tiers: Full for the .scumble format, Rust kernels, compositor and export writers; Normal for tools and features (canvas backend only when a pixel path changes); Light for plain-Node request shapes, providers built from docs and docs (CLAUDE.md:1047-1055)
- [read] No despill, unmix or chroma-key code exists in the app today (grep over renderer/, electron/main/ and plugins/ for decontam/despill/unmix/chroma key/green screen)
- [read] The tool count of 116 is recorded in README.md, docs/MCP.md and the mcpb build reads tools from docs/COMMANDS.md, so a new command touches these (README.md:83,303; docs/MCP.md:306; tools/mcpb_build.js:39)
- [unverified] Whether CK2 can be exported to ONNX with its backbone separate from a hint head, its foreground colour space and its output resolution (not checked (web out of scope for this angle))

## Open questions

- Can CK2 (and v1) be exported to ONNX, and can the heavy backbone be split from the alpha-hint head so the head alone runs per stroke, as SAM2's encoder and decoder are split?
- Is CorridorKey's foreground output sRGB-encoded or linear, and at what resolution are the foreground and alpha returned for a 2048 input? Scumble blends 8-bit encoded bytes.
- Does a ~5 GB model with sub-models (C-RADIOv4, MoGe-2, RVM, as item 49 claims) run under DirectML (onnxruntime-node 1.29) at all, and in a utility process? LaMa's process is CPU-only, and DirectML on main showed a 24.7 GB blowup (B5).
- Landing: a new layer with opaque foreground pixels plus the alpha as a layer mask, a straight-RGBA layer, or a mask on the source layer? This decides memory at 15k and whether the unmixed colour survives.
- Should a model-resolution 16-bit matte be stored as a document map (a .scumble format change, Full tier) or quantised straight into an 8-bit mask?
- Where are the weights hosted (HF, GitHub, Corridor)? The downloader must stop sending the HF token to non-HF hosts, gain an overall progress line, ideally a sha256 check, and handle external-data names.
- Licence display: CC BY-NC-SA plus Corridor's terms and the Discord permission for free software. Is an About or Helpers row note enough, and should the model stay a user download as RMBG-2.0 is?
- Large documents: key the whole picture at the model's resolution and upsample with a guided refine, tile it like the depth Detail grid, or key only the subject's crop box?
