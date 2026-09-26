# Bug list

Reported and not yet fixed. One section per bug: what was seen, what is already known
about it, and what has to be measured before anyone writes code. A bug leaves this file
when it is fixed (with the release it went out in) or when it turns out not to be one.

Fixed bugs are not kept here - `CHANGELOG.md` has them per release, `docs/PERFORMANCE.md`
the ones that were performance work.

---

## Fixed, waiting for its release

### The creative upscalers seem to take no prompt - fixed for 0.1.27

**Reported** by the user on 2026-09-22 ("beim creative upscale muss man auch einen prompt mitsenden koennen").
Clarity and Magnific Creative (`usesPrompt`) did send a prompt, but only the Generate tab's, and the Upscale dialog
showed nothing of it. The dialog has a Prompt field for such a recipe now (`#up-prompt`, prefilled from the tab), the
`upscale` command a `prompt` argument, `list_recipes` a `usesPrompt` flag. Gate step
`the_dialog_sends_its_own_prompt_to_an_upscaler_that_takes_one` (`tools/upscale_test.py`), 6 of 6 mutations red.
**Not changed, and only a key could decide it:** Topaz Wonder's *Redefine* model takes a `prompt` on fal (its schema
says so), Topaz Bloom only `autoprompt`; neither recipe sends a prompt, because it is unknown whether the other Wonder
models refuse one.

### A PSD saved with layers cannot be opened with them - fixed for 0.1.25

Reported by the user on 2026-09-22 ("man kann zwar als .psd speichern aber keine .psd mit den ebenen laden").
Measured: not a broken path but a missing one. The open dialog listed no `.psd` / `.ora`, and a PSD reached the
browser's image decoder, which cannot read it. **Built:** `renderer/editor/inpaint_layered.js` (`readPsd`, `readOra`,
plain data, no DOM) and the editor's `readLayered` / `loadLayered`: `loadFile` (Open, `load_image`, a drop on an empty
tab) opens a PSD or ORA with its layers, decided by the file's first bytes, not its name; a drop on an open document
adds its layers where the file has them. The bottom layer becomes the base when it covers the picture, visible,
opaque and normal (Photoshop's Background, the editor's own export); otherwise the base is transparent. A layer mask
is multiplied into the layer's alpha, a group's visibility and opacity into its layers; adjustment and fill layers,
clipping masks and blend modes the editor lacks are named in the status line. RGB and grayscale, 8 and 16 bit, RLE,
raw and ZIP; PSB, CMYK, Lab and 32 bit are refused by name. **Found on the way and fixed:** the editor's own PSD
export wrote every layer name through an ASCII-only Pascal string, so "Gürtel" came back as "G_rtel" in Photoshop too;
both PSD writers (`inpaint_export.js`, `inpaint_bands.js`) now also write the `luni` block with the full name.
Checked on real files of the user's (Photoshop PSDs with groups, masks and a gradient fill; the editor's own PSD and
ORA exports): the layers composited again match the file's merged picture to 0.00 to 0.14 levels, except where a
left-out fill layer is the background (named in the notes). Tests: `node tools/layered_test.js` (44 checks on files
built byte by byte), the gate `layered` (`tools/layered_test.py`, 7 steps: the round trip through the editor's own
PSD and ORA export, a transparent base, a drop, a file named .png, a truncated file); mutation round 18 of 18 red.

### Layer names cannot be edited (GitHub issue #1) - fixed for 0.1.23

Measured on 2026-09-21 in a fresh instance: the side panel was 291 px, a layer row 259 px, its content 274 px, and
the name of every layer with the full button set **0 px** wide (the Base row, with fewer buttons, 202 px). The name is
the only element that gives in (`flex:1` with `overflow:hidden`), so it vanished, could not be double-clicked, and the
trash button stood 23 px past the list's edge. The rename itself (`renameLayerInline`) was never broken. Fixed: the
panel is 320 px, the row's mini buttons 22 px with a 3 px gap, the name `min-width:48px`, the kind select shrinks
(44 to 84 px), the selects of the expanded rows shrink, a text layer's rows wrap, and a rename pushes a `layers` undo
step. `editor_test.py` `layer_rows_fit_the_panel_and_names_can_be_renamed` (17 layers, so the list shows its
scrollbar; the active row of each kind; nothing past the list's edge; a real `dblclick`, Enter, undo) is red on the
0.1.22 code and red without the undo step.

An entry here leaves the file when the release named in it is published.

- **The assistant's picker warned about itself** (fixed 2026-09-20, in 0.1.22; reported by the user the same
  evening 0.1.21 went out: "wieso hast du im agent ueberall geschrieben: not tried with a real key... muessen die
  user ja nicht wissen"). `marks()` in `renderer/assistant.js` appended "not tried with a real key" to every model
  of every provider, because every registry entry carried `tried: false` - ten providers, so the picker read as a
  row of warnings about the app instead of information about a model. **Decided and done:** the mark goes
  altogether, and with it the `tried` flag of `electron/main/assistant/providers.js` and the field `picker()` and
  `noticeFor()` put on their answer. A row now says only what is true of that model ("cannot look at the picture",
  a provider's own preview note). The honest sentence stays where the report said it belongs: `docs/ASSISTANT.md`,
  "What it cannot do" ("It has **not been tried against a live API** in this release"), and the release notes.
  Gate: `tools/assistant_test.py` `the_picker_carries_the_users_own_models_and_no_warning_about_itself` (no option
  of the rendered picker matches "not tried" or "not tested"), and `node tools/models_test.js`
  `no_group_warns_about_itself` for the groups the main process hands over; both red when the mark is put back.
- **FLUX.2 [flex] on fal sent the safety tolerance as its step count** (fixed 2026-09-20, in 0.1.21; it was under
  "What OpenRouter (item 12) found on the way"). `recipes/flux2_flex.json`, the `fal` variant carried
  `num_inference_steps` and `safety_tolerance` both at `"index": 1`. One slot holds one value
  (`editor.settings["1"]`, `settingsChanged`), and `providerParams` reads every row from its slot, so the panel showed
  two rows instead of three and the request went out as `num_inference_steps: "2", guidance_scale: 2.5,
  safety_tolerance: "2"`: 2 steps instead of 50, and the steps as a string (measured in the app on the old file,
  2026-09-20). The row is `"index": 3` now, the slot `guidance_scale` does not use. Gates: `node tools/recipes_test.js`
  (every settings row of every shipped recipe owns its slot and its key, comfy recipes included) and
  `tools/recipes_test.py` `flux2_flex_on_fal_has_three_slots_and_sends_three_values` (three rows with three labels,
  three values in the request).
- **A recipe with a `providers` map could not be imported** (fixed 2026-09-20, in 0.1.21; same section). `importFile`
  (`electron/main/recipes.js`) took a provider recipe only in the old one-provider shape, so the shape every shipped
  recipe has was refused with "This file is neither a ComfyUI workflow, an API-format prompt nor a Scumble recipe."
  and nobody could copy a recipe, add a variant of their own and import it. `hasVariants` now takes either shape, a
  `kind: "provider"` file that names no provider at all gets a message of its own (an empty map and an array count as
  none), and `importFile` answers the normalized recipe, as `list()` serves it - the Settings note used to read
  "(undefined, 0 nodes, 0 settings)" for a provider recipe and now names the providers that came in. A copy that keeps
  the shipped id still shadows the shipped recipe, as one placed in `%APPDATA%/Scumble/recipes/` by hand does. Gates:
  `node tools/recipes_test.js` (both shapes, what stays refused, nothing written on a refusal) and
  `tools/recipes_test.py` (the import through the dialog, the list, the chosen variant reaching `host`).
- **Opening a large JPEG, WebP or a PNG with a colour profile blocked the window** (fixed 2026-09-19, in 0.1.20; it
  was under "What phase N1 found on the way"). On tiles such a file of `InpaintEditor.imageWorkerFrom` pixels and more
  (32 MP; 0 turns it off) is decoded in a pool worker (`image_read`: `createImageBitmap` with the `<img>`'s settings,
  drawn in bands of 256 rows into a CPU OffscreenCanvas and read there) and put into tiles without the round trip
  (`putCanvasRows`); a plain PNG keeps the stream reader. It covers opening a file, an image layer (drop, paste, the
  file inputs, `add_image_layer`), the restore at start (every file on tiles by its own size, fetched once: a small one
  goes to the `<img>` from the bytes already fetched) and `load_image` by file name (`setBaseFromRef`). A failed read
  falls back to the `<img>` (but for a PNG above the canvas limit, which only the stream reader holds); an open still
  decoding never lands over a later one; a PNG with a `cICP` chunk keeps the browser's decoder too, as `iCCP`, `gAMA`
  and `cHRM` did. The same bytes as the `<img>` way. 15000 x 10000, the window
  blocked before / after (`dist/daily/open_bench.py`): JPEG 950 / 98 ms, JPEG with an Adobe RGB profile 3,692 / 34 ms,
  JPEG with EXIF orientation 6 1,872 / 62 ms, WebP with alpha 1,656 / 38 ms, PNG with an Adobe RGB profile 4,437 /
  45 ms; wall 1.04 to 0.78 s, 3.78 to 1.08 s, 5.84 to 2.68 s. Gate: `editor_test.py`
  `large_image_files_open_in_a_worker` (six Pillow files: plain, profiled and rotated JPEG, alpha WebP, profiled and
  16-bit PNG; the worker's bytes against the `<img>`'s, the EXIF size, the profile really applied, an image layer and
  a restore through the worker). Mutations caught: the profile dropped, `premultiplyAlpha: "none"`, a band a row off,
  the restore not routed, `imageOrientation: "flipY"`; `"none"` is equivalent (Chromium 152 treats it as
  `"from-image"`). Canvas backend unchanged.
- **A provider run's crop and stitch held the window** (fixed 2026-09-19, in 0.1.20). The row in the list said
  0.6 s; on the user's usual document it was far worse, because `readBox` took the whole flatten for a colour-matched
  layer: 15000 x 10000, a 1,024 px selection (`native_test.py provider_crop`, `match_provider_crop`,
  `film_provider_crop`), the longest block before / after: plain stack 665 / 24 ms, with a 5,000 x 3,500 matched
  layer 1,469 / 22 ms, with a film look over it 6,283 / 51 ms; wall about 0.6 s, in workers. `host.runProvider` now
  calls `prepareCropAsync` / `finishResultAsync` (stitch.js): the selection's window is read here and planned, the
  crop box is composited by the tile workers (`readBoxBytes`: the stack or the filter program of B items 1 and 7, the
  matched layer's statistics from point samples as decision (b) of 7c allows for runs; `readBox` and the canvas
  backend's flatten are the fallback), and the crop, the masks, the resizes, the answer's decode, the colour match and
  every PNG are made in a stitch worker of its own (`stitch_worker.js`, app only), the same steps as the synchronous
  pair (`planCrop`, `cropPixels`, `finishPixels`). The run is one moment as before: the selection's window, the stack
  the box is composited from (`holdRunStack`, copy-on-write clones), the reference layers, the recipe's parameters, the
  prompt and the seed are all taken at the click, before the first await. The synchronous `prepareCrop` / `finishResult` stay (the fallback
  and what the size tests read); `setStitchInWorker(false)` and `InpaintEditor.boxOverTiles = false` are the A/B
  switches. Gate: `export_test.py` `a_run_off_the_window_sends_what_the_window_sent`: info, masks and the plain
  stack's crop and patch files byte for byte against the synchronous pair; over a soft layer and a levels layer within
  B item 1's two levels on 0.1 % of the bytes, with a matched layer within decision (b)'s levels (colour premultiplied
  by alpha: a level where alpha is 8 is 31 levels of straight colour nobody sees). Mutations caught: the box a row
  off, the stitch without its region, the mask not resized, a program band shifted; the limits dropped in the shared
  settings is equivalent there (`size_test` holds it). `smoke` ran the new path against the loopback provider
  (2026-09-19, PASS on both backends). An adversarial review (four lenses, two refuters a finding: 15 findings, 7
  upheld, all fixed with the other 8) gave the one-moment snapshot, the parameters at the click, the `<img>` fallback of
  the stream reader, `cICP`, the restore by file size and the transfers instead of copies.
- **Releasing a stroke held the window** (fixed on tiles 2026-09-19, in 0.1.20; the bullet "Releasing an erase stroke
  is its own stutter" below). The commit wrote band after band through canvases (the stroke's part materialised, the
  layer's tiles put into a scratch, drawn, read back): on tiles a stroke is now composited a tile at a time through
  the compositing kernel (`commitStrokeTiles`, `compositeStroke`: the stroke's box and, with a clip, the selection
  under each tile as the kernel's coverage; only the pixels the stroke reaches are written). A scaled or fractional
  layer with a clip and the canvas backend keep the bands; `InpaintEditor.strokeTiles = false` is the A/B switch.
  `tools/release_test.py` (real mouse events, 15000 x 10000 with a matched result layer and a film look, until the
  picture settled), the longest block after the release before / after: an erase on the matched layer at fit 70 /
  34 ms (the commit 51 / 17), a stroke of paint there 88 / 36 ms (67 / 19), a long diagonal erase across a full-size
  layer 288 / 66 ms (271 / 48); at 1:1 31 / 38 ms (the commit 4 ms either way, the frame's film look the rest). Gate:
  `editor_test.py` `a_stroke_commits_through_the_kernel_on_tiles` (paint at an opacity, erase, erase at an opacity,
  the alpha locked, paint and erase clipped on a layer off the origin: pixels the stroke does not reach the same bytes,
  the rest within two levels premultiplied of the bands', undo byte for byte; an erase at full opacity is the same
  bytes). Mutations caught: the clip ignored, the opacity ignored, the alpha lock as source-over, untouched pixels
  not restored, the clip a few pixels off, the clip without the layer's offset.

---

## Open

### Found by reading on 2026-09-26 (not yet measured)

**Written** 2026-09-26 by a gap review of the whole app (read, not run). Each has to be measured before it is fixed.
The first three are part of `docs/PLAN_0_1_29.md` §3 (documents and safety) and are fixed there.

- **A quit or an update install skips the pixel flush.** Layer pixels upload 15 s after the last change
  (`inpaint_canvas.js` ~7477-7485); `saveBeforeRestart` (`renderer/shell.js` ~1861), which flushes them, is only
  called from the tiles restart button (~1845). `before-quit` in `electron/main/main.js` (~677) stops the assistant
  and the help chat only, and `updater.js` calls `quitAndInstall` directly. So the last strokes can come back without
  their pixels after a restart.
- **TIFF is offered and cannot be read.** The Open dialog lists `tif` / `tiff` (`electron/main/main.js` ~424); no
  decoder exists and Chromium has none. The file is uploaded to the mirror (and a connected ComfyUI) first and then
  fails to load.
- **Every PNG export carries the prompt, the seed and the recipe graph**, with no switch (`inpaint_canvas.js` ~8672,
  `host.workflowForPng`). For a local recipe that is its whole API graph with model and LoRA names.
- **Rotate, distort and warp bake the layer mask into the pixels** without a word (`inpaint_canvas.js` ~1909).
- **Saved selections load misaligned after Resize or Extend canvas** (`inpaint_canvas.js` ~4845).
- **A rotated text layer probably loses its rotation on the next text edit** (`inpaint_canvas.js` ~8321-8337).
- **The film look "None (adjustments only)" still adds grain**: `plugins/film/filters.js` ~387 falls back to
  `{ amount: 25, ... }` when there is no stock.
- **At the typed-array cap (15.5 GB) the editor throws a `RangeError`** instead of refusing the operation.
- **Two wrong lines in the manual:** `docs/MANUAL.md` ~242 says the AI label writes metadata (it stamps a layer);
  ~163 says erasing a result layer writes its mask (it writes pixels).

### Linux: built, never run (B2, 2026-09-22)

**Written** 2026-09-22 with the Linux job of `.github/workflows/build.yml` (AppImage and .deb, `latest-linux.yml`).
This machine has no WSL and no Docker, so the Linux build has been **built by CI and run nowhere**: no gate, no
start, no helper, no update. What is known to need a look on a real Linux desktop:

- **Gates:** they are Python + CDP and `tools/run_gates.sh` is bash, so they should run; `--exe` takes the AppImage
  (`mcp_test.py` and `assistant_test.py` take `--exe` too). Not one has run.
- **The MCP registration** of an AppImage is `"$APPIMAGE" --mcp`, **without** the Node-mode launcher (a path inside
  the AppImage changes with every start). That assumes Electron writes nothing to stdout on Linux before our code
  runs (the stray CR LF the launcher exists for is Windows' console code). Unmeasured; `mcp_test.py --exe
  <AppImage> --direct` is the check. A .deb install keeps the launcher (its paths are stable).
- **The sandbox:** on Ubuntu 23.10+ AppArmor's user-namespace limit can keep an AppImage's Electron from starting
  (the README says so). No `--no-sandbox` is added by the app.
- **Keys:** `safeStorage` on a desktop without a keyring falls back to `basic_text`; *Settings › API providers*
  warns then (`keysNote` in `renderer/shell.js`, gate `platform`). Whether `isEncryptionAvailable()` answers true
  or false in that case decides which of the two warnings the user sees; both are covered, neither observed.
- **Helpers:** CPU only (no CUDA provider in the build, `docs/HELPERS.md`); the first session logs a failed `cuda`
  attempt before it falls back.
- **The single-instance lock and the named pipe** become a unix socket (`local.js`); never exercised.


**Written** 2026-09-19 while planning the in-app assistant (`docs/PLAN_ASSISTANT.md`). Found by reading
the code and checked line by line, not reported and not run; none is fixed. The user decided on 2026-09-19
that the assistant changes nothing external agents see ("nein, soll primär für externe agenten sein, in app
agent ist nur add on"), so the assistant's plan does not fix them; each is its own item when the user says so.

- **`flip_layer` axis x flips vertically.** The command passes `"x"` / `"y"` (`renderer/commands.js:652`),
  `flipLayer` mirrors horizontally only for `"h"` and vertically for anything else
  (`renderer/editor/inpaint_canvas.js:3496`, `:3502`), so both axes flip vertically, against the command's
  own description ("horizontally (axis x)"). The toolbar buttons pass `"h"` / `"v"` (`:2193-2194`) and work.
  The fix is one line in `commands.js` (outside the node build); external agents that compensated would get
  the other flip.
- **`remove_layer` reports success on a locked layer.** `removeLayer` only sets the status line for a locked
  layer and returns (`inpaint_canvas.js:9479`); the command returns `{removed: id}` regardless
  (`commands.js:636`). The built-in plugins call the same command (ailabel's Add / Remove label,
  `plugins/ailabel/main.js:101`, `:111`; glb's Edit dropping a depth layer, `plugins/glb/main.js:117`).
  `flip_layer` and `center_layer` are silent no-ops on locked or filter layers in the same way.
- **The compat key goes to any URL `llm:models` is given.** `compatModels(url)` sends `keys.get("compat")`
  as a Bearer token to whatever base it is called with (`electron/main/llm.js:73-78`, IPC `llm:models` at
  `electron/main/main.js:459`); the renderer, a plugin included, can call it with any URL. The key is meant
  for the saved `settings.llm.compat.url` only.
- **The MCP annotations are incomplete.** `READ_ONLY` (`electron/main/mcp/server.js:31`) is tested against
  dotted command names and misses `read_log`, `film.looks`, `glb.info`, `ailabel.info` and
  `sample.mean_color`; its `describe` alternative matches no command. `destructiveHint` (`:63`) misses
  `generate_new`, `flatten`, `merge_down`, `extend_canvas`, `export*` (silent overwrite), `undo`, `redo`,
  `select_recipe`, `set_node_params` and `ailabel.add`, and marks `new_document`, which destroys nothing.
  External MCP clients that gate on these hints get the wrong picture.
- **Ctrl+Enter starts a second provider run while one is running.** `generate()` disables the button for the
  length of `host.queueGenerate` (`inpaint_canvas.js:12043`, `:12054`), but the shortcut calls `generate()`
  directly (`:2788`) and nothing checks `providerPending`; `runProvider` then replaces the token
  (`renderer/editor/host.js:858`). **Not known:** whether the first run's result still lands, and whether a
  second run is ever wanted (local runs queue on ComfyUI on purpose). An editor change, so it ships to the
  node.

### What phase N1 found on the way

**Written** 2026-09-17 with the measurement of phase N (`docs/PERFORMANCE.md` §14, `tools/native_test.py`,
`tools/native_limits.py`). Seen while measuring, not reports; none is fixed.

- **The whole-picture wand on a document above the canvas limit works for 4.6 s and then refuses** ("larger than any
  canvas", 30000 × 20000, `native_test.py 30000x20000 wand_whole_picture`). Why it gets
  that far before it refuses is not read yet. Either it says so at once, or it floods over tiles.
- **At the renderer's 15.5 GB of typed arrays the editor throws instead of saying no**: the 19th full 15k layer ends in an
  uncaught `RangeError: Array buffer allocation failed` out of `allocTileBytes` / `TileLayerPixels.writable`
  (`native_limits.py layers 15000x10000 22`). The arena counts a refused chunk and then falls back to a plain array, which
  fails the same way. Not measured: what a stroke or a paste does to the document when it hits that in the middle.
- (The provider crop's block and the opening of a large JPEG, WebP or profiled PNG are fixed: "Fixed, waiting for its
  release" above.)

### What phase E left open on large documents

**Written** 2026-09-17 with phase E (`docs/PLAN_BCE.md` §3, the "as built" blocks). Not reports: gates of the plan that were
measured and not met, and what still needs a canvas of the picture. Each has a number to beat.

- **(Since B item 7, 2026-09-18, only for a document with a colour-matched layer above a filter layer, a scaled or
  fractional layer, or a filter mask that is not tiles: a plain stack, blend modes, filter layers and colour-matched
  layers (part 3, the statistics from point samples of the tiles) are composited by the workers, the
  filters run over their bytes, and the case below saves in 1.4 s with a block of 0.17 s, with the film look 5.0 s
  against 9.1 s; `docs/PLAN_BCE.md` §3b "B item 7, part 2 as built". The block is still above the plan's 50 ms.)**
  An export in bands is slower in wall
  time than the whole flatten was, while the window stays usable. 15000 × 10000,
  three full paint layers and a levels layer: 6.2 s in bands (longest block 0.7 s, the first band) against 3.4 s through
  one canvas (2.4 s blocked in one piece). With the film look on top 9.5 s against 8.2 s. The time is the region pass at
  full resolution: about 130 ms a band, most of it `putImageData` of every layer's tiles into a region canvas
  (`tools/export_test.py --perf 15000x10000`). The plan's gate was 3 s and 50 ms. The way down is the one the plan had:
  composite plain stacks in the pool's workers from the arena (`composite_tile`), and keep the region pass for bands
  with a filter, a colour match or a blend mode.
- **The film look's halation on a document above the canvas limit is very slow to export**: 67 s for 20000 × 14000 with
  blocks of 7.6 s a band, 146 s with blocks of 16 s at 30000 × 20000. Its blur is 1.2 % of the long side (240 px there), so a band carries 725 rows of margin on
  either side and the pass is 60 MP, above what the WebGL filters render in one piece.
- **Inverting the selection of a very large document blocks the window**: 0.5 s, and 1.2 s back, at 30000 × 20000, and
  the inverted mask is 2.4 GB of tiles (masks are RGBA tiles; one-channel masks were C5's plan and are not built).
- **The mip refresh after a whole change still blocks 45 to 90 ms** at 15k (the gate was 5 ms): the frame the landings
  cause builds the atlas slots on the main thread (`docs/PLAN_BCE.md` §3 "E1 as built").
- **Above 268 MP only the full-size PNG, PSD and ORA are written.** JPEG, WebP, the Size row and the frame need one canvas
  and are refused with a message; so are the canvas-sized edits (resize, extend, crop to selection, merge into the base
  through a canvas) wherever they still build a canvas of the picture. A PSD stops at 30,000 px a side and 4 GB a section
  (a 30000 × 20000 document with one paint layer was 3.7 GB), an ORA at 4 GB (no zip64).
- **A colour-matched layer above a filter layer keeps the whole flatten for exports up to 268 MP**, and so does a
  provider run's crop (`readBox`) and the flatten into the base of a plain matched stack. Since B item 7 part 3
  (2026-09-18, decision (b) of C6 (c) 7c made) every other matched document takes the worker path, its statistics
  point samples of the tiles. Above 268 MP the bands use the statistics the screen uses, the only ones there are.
  So do the JPEG and WebP exports (`host.exportCanvas`). The screen keeps 7c's box means: on a textured matched
  layer a PNG differs from a JPEG of the same document, and the wand's edge from what the screen shows, by the few
  levels the two statistics are apart (`docs/PLAN_BCE.md` §3b "B item 7, part 3 as built", the photo table).
- **Seen once, not reproduced**: `editor_test.py` `a_settled_read_builds_its_levels_in_the_worker_not_here` failed with
  `requested: 0` in one of some twenty runs since the mip chains go through the pool.

### A local run on a large document spends minutes in the node's stitch

**Found** 2026-09-19 by the first `smoke` against a real server since phase E: a local Flux.2 Klein run on a 6000 x
4000 document (a soft paint layer, a matched result layer, a levels layer; a 1000 x 800 selection) took 19 min 27 s,
of which 15 min were the node's stitch after the VAE decode, one CPU core busy, the GPU idle. The app's side was
right: the base went up in bands through the filter program (`n2_base_4682dc8486bc.png`, the hash of the composite
recomputed afterwards, the same 27,198,764 bytes) and the result landed at the crop box.

**Why:** ComfyUI-InpaintCanvas `nodes.py` builds the stitch's masks over the **whole picture** (`_composite_mask` on
the full-size selection) and dilates with a square `max_pool2d` of k = 2 x grow + 1 (137 for a 1000 x 800 selection),
k squared comparisons a pixel on the CPU: 35 s a megapixel at k = 137 (the ComfyUI's torch, one thread), so about 14
min at 24 MP and 90 min at 15000 x 10000. The run's own crop (`_denoise_mask` on the crop) costs about a minute the same
way (the 55 s between "got prompt" and the model load).

**The fix is committed and pushed in the node repo, not live yet** (`fba1fd8` on master of ComfyUI-InpaintCanvas, on
the user's word of 2026-09-19; the node folder is the user's live ComfyUI and its Python only loads after a restart): `_dilate_mask` as two separable `max_pool2d` passes (the same values: a square max is the max of the row
maxima), and the stitch's masks on a window around the region with the margin the app's `finishResult` uses. The
patch and its tests are in the session's scratchpad (`node_fix_patch.py`, `node_mask_test.py`,
`node_stitch_e2e.py`): the node's own `InpaintCanvasStitch.stitch`, today's `nodes.py` against the patched copy with
ComfyUI stubbed out, gives the same returned image and the same patch PNG, byte for byte, with auto feather, colour
match and alignment (71.5 s to 1.96 s at 2500 x 1800), with `paste` "crop" (43.1 to 0.61 s) and a plain feather; the
masks alone at 6000 x 4000 889.5 s to 4.4 s, equal on eight cases; run again against the committed file, the same.
**Next:** a ComfyUI restart when it suits the user, then one local run on a large document; the entry leaves this file
when that run is fast (a node release with a `pyproject.toml` version takes it to the registry).

### A headless MCP instance keeps Scumble from starting

**Reported** 2026-09-16 ("wieso kann ich die app nicht starten?"), during a Claude Code session in `F:\canvas`.

**Seen:** starting Scumble showed no window at all. Two processes were running, both started by that session's MCP
registration (`.mcp.json`: `electron.exe electron/main/mcp/launch.js --mcp`, i.e. the dev app from `F:\canvas`):
the launcher and `electron.exe F:\canvas --mcp`. No Scumble was running when the session began, so the MCP server had
started the app **headless** (`AgentBackend` in `electron/main/main.js`), on the default profile `%APPDATA%\Scumble`.
It held that profile's single-instance lock since the start of the session. After both were stopped, the packaged app
started normally.

**Known:** both instances use the same `userData`, so a second start is meant to hand over to the running one:
`app.on("second-instance", () => showWindow())` (`main.js` 573 for the headless agent path, 626 for the normal start),
and `showWindow()` creates the window or restores a hidden one. `docs/MCP.md` and CLAUDE.md say "a second start of
Scumble shows it". Here nothing appeared.

**Not known, to measure first:**
- Which binary the user started (the installed 0.1.14 in `%LOCALAPPDATA%\Programs`, or `dist\win-unpacked\Scumble.exe`),
  and whether a second start of the **same** build as the headless one shows the window (dev headless + dev start,
  exe headless + exe start). A dev and a packaged Electron may not share the lock or the hand-over.
- Whether `second-instance` fires in the headless instance at all (log it), and whether `showWindow()` then creates a
  window that stays hidden or off screen.
- Whether the headless instance's renderer was ready (`bridge` ready) when the second start arrived.

**Workaround:** start Scumble before Claude Code, so the MCP server drives the visible window; or stop the leftover
`electron.exe ... --mcp` processes. A fix belongs in the hand-over (the running headless instance shows its window on a
second start of any build), with a gate step in `tools/mcp_test.py`: start headless through the launcher, start the
app a second time, assert a visible window within a few seconds.

### Selection undo and bounds lose isolated pixels above 1 MP (canvas backend)

**Found** 2026-09-14 by C2's final review (`docs/PLAN_BCE.md` §C2), present since phase A (0.1.10):
on the canvas backend, which is what the packaged app ran until 0.1.13 and still runs with Settings ›
Rendering › Tile engine switched off, a selection above 1 MP takes its extent
from the selection's 1/16 display level (`selectionExtent()` in `inpaint_canvas.js`). Four smoothed
halvings round an isolated pixel away (below about alpha 128 always, and at sizes that do not halve
evenly even alpha 255), so the selection's undo step does not copy it and its bounds scan does not
look for it. Measured: 2401 × 1601, a 400 × 300 rectangle plus 24 isolated pixels of alpha 120 or
255: the extent [270, 270, 2307, 1523] misses the opaque one at (1447, 1525), `getBounds()` comes back
as [300, 300, 2280, 1491] against the exact [300, 300, 2280, 1526] (a run's crop and the ants box leave
selected pixels out), and a `select_rect` elsewhere followed by an undo restores the selection without
that pixel. 3000 × 2000 loses two alpha-120
pixels the same way; 2048 × 1536 nothing. A wand's or a matte's speckle is where it shows.

**Not fixed, on purpose**: an extent that cannot drop a pixel needs a full-resolution readback of the
selection on this backend (seconds at 15k, the cost phase A took out), or a max-pooling level the 2D
canvas cannot build. The selection drag, which lost the same pixels, takes the whole image instead
since C2 (b)'s review. On tiles the extent is the tile set's exact bounds and nothing is lost; C5 makes
the selection mask tiles and C7 retires the canvas backend, which closes this.

### A very large PNG stays jerky to work on

**Reported** 2026-09-11 by DenRakEiw, on a PNG about 15,000 px on its long side. Panning
and painting stutter badly.

**The file format is ruled out.** The user saved the same picture as JPEG and it is not
smoother (2026-09-11), which is what the pipeline predicts: after decoding, base and layers
are RGBA canvases and the format cannot matter. So the heading is misleading and the bug is
about the *size*. It is the untiled full-resolution layers that are the suspect.

**Update 2026-09-15, for 0.1.13: the tile engine is on by default.** Most of what follows describes
the state before it (untiled layers, "layer tiles were deliberately not built"); it stays as the
record. Layers, masks and the selection are tiles now (`docs/PLAN_BCE.md` C2 to C6), and 0.1.13 runs
them in the installed app unless *Settings › Rendering › Tile engine* is unticked (or `--no-tiles`).
Measured on a 15000 × 10000 document with three full-size paint layers, a colour-matched result, a
film look and a levels layer (`mem_test.py`, one document open; `PLAN_BCE.md` §C7 "The default, as
built"): about 4.5 GB in the renderer and 1.6-2.3 GB in the GPU process on tiles, against 0.7 GB and
7.2-7.8 GB with the tile engine off. The entry stays open until the user reports on their own 15k
file. What to ask for: the file's size and layer count, whether panning and painting still stutter
with the tile engine on, the same with it off (after *Restart now*), and the card's and the GPU
process's numbers from Settings › Rendering while it stutters. What is known to be still slow on
tiles is the "Still slow" list under 0.1.13 in `CHANGELOG.md` (smudge, the whole-picture wand,
invert, the whole flatten behind renders and exports); with two 15k documents open at once a levels
tick took 49-58 ms on tiles and with three the pan took 65 ms, not broken down yet.

**Update 2026-09-16, after C4, C6 (c) 7b to 7d and C6 (d) (0.1.16, unreleased).** The numbers on the synthetic 15k
document are in `docs/PERFORMANCE.md` §11: pan 2.6 ms (0.2 ms on the GPU stack), a brush dab and its frame 1.2 ms, undo of a
stroke 26 ms, the first frame at 1:1 1.2 ms; a colour-matched full-size layer no longer makes 1.1 GB of copies, and a crop,
flatten or undo of them no longer decodes the picture again. Still whole-picture and slow: invert (0.9 s), the band wand
(1.8 s), a film point under a film look (2.2 s), renders and exports. The entry stays open until the user reports on
their own 15k file (what to ask for: the 2026-09-15 update above).

**What is already known**

- The GPU compositor still applies at that size: it refuses only above `MAX_TEXTURE_SIZE`,
  which is 16,384 on this machine (`inpaint_compositor.js`, the `w > this.maxTexture` guard),
  and 15,000 is under it. So this is not the documented fall-back to Canvas 2D.
- **Layer tiles were deliberately not built** (`docs/PERFORMANCE.md` §"what is left"). Every
  source canvas is one texture and one full-resolution pyramid level, so a 15,000 × 10,000
  document holds about 600 MB per layer in the GPU process before anything is drawn. The
  memory watch (`settings.memory.gpuLimitMB`, default 3072) then releases caches on a timer,
  which is itself visible as a stutter.
- Phase 6 measured that four 96 MP documents open at once really are 19 GB of live pixels
  and about 40 ms a frame. 150 MP in one document is the same territory.
- **Every discrete step snapshots the whole document.** `clearSelection()`, and every
  selection change, calls `pushUndo({ kind: "selection" })`, which copies the selection
  canvas: 150 million pixels per step. Phase 1 made *brush* undo a copy of the touched
  rectangle only, but the selection steps were not part of that. On a document this size
  that alone can be the stutter.
- **Releasing an erase stroke is its own stutter** (fixed on tiles 2026-09-19: "Fixed, waiting for its release"
  above; the text below is the record) (reported separately in the same session:
  the stroke itself follows, the hitch comes on mouse up). The `layerpaint` pointer-up runs
  `strokeRect`, `commitStroke` and `markLayerChanged(layer, box)`, which refreshes the display
  pyramid over the touched rectangle and re-uploads the layer's texture. With a big eraser
  over a big area that rectangle is most of the document, so the "only the touched rectangle"
  saving from phase 1 buys nothing here.

**Measured 2026-09-12** (dev instance on its own profile, the app freshly started, synthetic
15,000 × 10,000 document: base, three full-size paint layers, one 2048² result layer, a film
look; `tools/perf_test.py 15000x10000` plus a script that drove the real pointer handlers on
the screen canvas). The drawing itself is **not** slower than the screen: pan, an eraser
stroke with a 400 px tip and its release each take one 120 Hz frame (8.3 ms median, both at
fit zoom and at 1:1), slider ticks 8 ms, the release of an erase over 12,400 × 6,400 px
13 ms commit plus 1.5 ms pyramid refresh, the autosave upload of three changed layers holds
the main thread 19 ms at most (2 s wall, in the worker). What does stutter:

| Step, 150 MP | main thread held |
|---|---|
| first frame after a zoom to 1:1 (full-resolution textures) | 58 ms, once 320 ms in a real pan |
| selection change (`pushUndo` copies the selection canvas) | 62 ms |
| undo step | 99 ms |
| selection bounds scan | 83 ms, worst 754 ms |
| grow +16 / shrink / invert / feather | 321 / 180 / 70 / 135 ms |
| magic wand / bucket | 2076 / 1646 ms |
| PNG of the composite (undo of a whole layer, autosave, export) | 274 ms even with the worker |
| full composite (before a run or export) | 9 ms warm, 990 ms cold |

And the memory, which is the finding that matters: **one 15k document with three full layers
holds 4.3 GB in the GPU process** (`ed.memoryReport()`: layers 1.8 GB, display pyramids
1.0 GB, base canvas 0.6 GB, selection canvas 0.6 GB, compositor textures 0.2 GB at fit zoom
and 1.26 GB after a zoom to 1:1). The GPU process went from 8.1 GB (after the benchmark's own
15k document had been closed) to 14.9 GB with the document built and 17.4 GB after the
gestures. Every one of those canvases is a GPU texture in Chromium's GPU process, and it
competes for the card's 32 GB with ComfyUI (20 to 29 GB right after a local render, measured
on 2026-09-08), Photoshop (9.5 GB dedicated while it had a document open, WDDM counters
`\GPU Process Memory(*)\Dedicated Usage`) and Krita. When the card is over-committed Windows
pages GPU memory to system RAM and every frame that touches an evicted texture stalls: that
is a stutter no benchmark on an otherwise idle card shows, and it is the first thing to
verify on the user's machine (Task Manager › GPU › dedicated memory while it stutters, and
whether it is smooth right after a restart of ComfyUI). The user's real 15k file could not
be measured: it was not open (their autosave held a 2 MP document, their GPU process 774 MB).

**What to measure first** (before touching anything)

1. ~~The exact dimensions of both files, `ed.memoryReport()` and `app:metrics`~~ done above on
   a synthetic document of the reported size; the user's own file is still to be read the
   same way (Help › Console, `window.editor.memoryReport()`, `window.scumble.metrics()`).
2. ~~`perf_test.py 15000x10000` against 12000x8000~~ done: within a frame of the 96 MP numbers
   for every interactive row; the discrete rows are in the table above.
3. **Dedicated GPU memory of the whole card while it stutters** (Task Manager › Performance ›
   GPU, or the WDDM counters), and the same document right after ComfyUI has been restarted.
   If the stutter goes with the free VRAM, the fix is memory, not drawing.
4. A CDP heap snapshot if the memory climbs across gestures rather than sitting flat. The
   canvas census says *what* survived, only the retaining path says *why*.
5. Whether the stutter is periodic. `watchMemory` runs every 30 s but only touches background
   tabs; the autosave runs 15 s after the last change and was measured at 19 ms blocked.

**Phase A of `docs/PLAN_TILES.md` is built (2026-09-13)** and takes the discrete hitches out
of the table above: selection change 6 ms, bounds 6 ms warm, stroke undo 42 ms (the film
look's re-render; about 10 without a filter layer), grow / shrink / invert 112 / 131 / 54 ms,
the bucket and the wand on a bounded region a fraction of before, a stroke's buffers 19 MB
instead of 1.8 GB and the live preview refreshed inside the dab, the compositor's textures a
window of each source. `docs/PERFORMANCE.md` §9 has the table. What it does **not** change
is the memory per document (2.3 GB of layers, 0.95 GB of pyramids, 0.57 GB base, 0.57 GB
selection canvas in the GPU process for this document), and the ops that read the whole
selection keep their phase 4 cost. Whether the stutter the user sees is that memory is still
the open question 3 above; the memory watch now reads the card as a whole (Settings ›
Rendering shows it), which is the number to look at while it stutters.

**Likely fix, if the measurement confirms the memory reading**: layer tiles above a
threshold, which is the one piece of the performance plan that was left out on purpose, and
with them the pixels of layers that are not on screen kept out of the GPU process (in the
renderer as typed arrays, or in the mirror) instead of as one accelerated canvas each. That is
what Krita and Photoshop do (`docs/PERFORMANCE.md` §3: tiles in system RAM, a mipmapped
projection of the *merged* picture, the GPU holds only the visible tiles) and it is why they
do not fight ComfyUI for VRAM. A tiled layer also makes the whole-document steps in the table
(selection undo, bounds scan, wand, bucket) per-tile work. It is a large piece of work and
belongs to the user's decision, not to a quick patch. The plan for it is
`docs/PLAN_TILES.md` (written 2026-09-12): quick wins first, a Rust spike, then the tile engine.
