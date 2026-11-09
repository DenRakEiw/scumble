# Whole-code review, 2026-11-07

The full list is in `verified.json` (73 findings, each with its claim, scenario, fix, effort and the verifier's reason).
This page is the short version and a proposed order of work. Nothing has been fixed yet.


**Status 2026-11-07 night:** `rust/px-deflate-sync-truncation` fixed and merged (`9d44bdc`; R1 as built in `docs/PLAN_WASM_BUILD.md` §7). `documents/D2+canvas-c/F1` and `canvas-c/F3` fixed and merged (`6a66182`, after a review's 12 findings were fixed in `3a34445`: fonts, the node's clean-up, the assistant's turn, the quit save, the ask() leak). The other three musts (`providers/PRV-1`, `documents/D1`, `filters/filter-layer-over-its-own-input`) and every should were left for the user's pick; the user took all three musts on 2026-11-08 (built by Antigravity agents, reviewed here). **`providers/PRV-1` fixed and merged (`d004fadd`):** `util.js` `pollJob` and `downloadImage` (up to 5 failed status reads in a row with a backoff, 408 / 425 / 429 / 5xx transient, `Retry-After` above 0 and at most 60 s, 3 tries of the result and the picture, the request id in the final error; the submit never retried, a Cancel stops at once), used by fal, Replicate, WaveSpeed, Comfy Router and the Partner API. **`documents/D1` fixed and merged (`b3fe5cf5`):** `files.js` content names `stem~<hash>.ext` for `overwrite:false` uploads (atomic writes through `renameRetry`, a reuse only if the bytes match, a longer hash on a collision), `ensureOnServer` size-checks every name and reports `renamed`, `host.rewriteStateRefs` and `segmentSource` use it; overwrite by proof, the display strips only `~<hex>`. Known limits: a colliding plain name is uploaded again on each run, and equal size counts as the same file (an old `.bmp` of equal dimensions). **`filters/filter-layer-over-its-own-input` fixed and merged (`8d82004b`, three review rounds):** `applyFilterLayer` and `flushFilterChain` clear before they draw a plain filter's result, the input of a screen pass reaching past the document is cropped to it (`cropFilterInput`, a fill after a GPU chain flushes first), `plain` in the filter cache key for limited layers, and the flush clears only when a piece lands. Known effects: an opaque picture with a soft Limit moves by a level or two inside the ramp, on a zoomed-out screen the document's outermost pixel is opaque, and a layer hanging off the document shows unfiltered on the pasteboard. All six musts of the review are done. Every should is still open.

## What was reviewed

- The code at commit `8f43b4a` on `wasm-kernels` (items 57 and 58 merged), in a detached worktree.
- The review was read-only. Nothing in the repository was changed, built or committed. One verifier ran the
  snapshot's own `px.wasm` and `px_scalar.wasm` in Node from the session scratchpad to confirm the PNG finding.
- Twelve slices, one reviewer each. A second agent then checked every finding against the code. Only confirmed
  findings are listed. The slices, by the files their findings name:
  - **canvas-a, canvas-b, canvas-c**: the three parts of `renderer/editor/inpaint_canvas.js`.
  - **host**: `renderer/editor/host.js` and `renderer/editor/stitch.js`.
  - **tiles**: the tile store and the GPU compositor (`inpaint_tiles.js`, `inpaint_compositor.js`).
  - **rust**: `crates/px` and its JS side (`renderer/editor/px.js`).
  - **documents**: the local store and the document files (`electron/main/files.js`, `docfile.js`, `documents.js`,
    `autosave.js`).
  - **main**: the main process (`main.js`, `mcp/launch.js`, `comfyview.js`, `filesaves.js`, `keys.js`, `settings.js`).
  - **providers**: `electron/main/providers/`.
  - **shell**: `renderer/shell.js`, `renderer/commands.js`, `electron/main/bridge.js` and the assistant.
  - **filters**: the filter layers' GL and CPU paths, the depth effects, LUTs.
  - **recipes**: `electron/main/recipes.js`, the local run path, the helpers' keys.
- Left out, because it is known or was being worked on:
  - the open list in `docs/BUGS.md`;
  - the external review of the same day (`docs/research/review_external_2026-11-07/verified.json`);
  - H1 and P15 (the hardening), on a branch at the time, merged since as `96f037a`;
  - items 59 (smart guides) and 69 (`--run`), on branches at the time, merged since;
  - U0 / U1 (SAM2 and the other ONNX helpers off the main process);
  - the steps already planned in `docs/PLAN_WASM_BUILD.md`.
- Line numbers are those of `8f43b4a`. H1 and items 59 and 69 changed `inpaint_canvas.js`, `commands.js` and other
  files after the snapshot. Find the function by name before you edit.
- Where a verifier changed a severity, the files keep the verifier's one, and `why` says why. One merged finding had
  two verdicts (`documents/D2` must, `canvas-c/F1` should). It is kept as must.

## Counts

| slice | found | confirmed |
|---|---:|---:|
| canvas-a | 8 | 8 |
| canvas-b | 9 | 9 |
| canvas-c | 9 | 9 |
| host | 6 | 6 |
| tiles | 4 | 4 |
| rust | 3 | 2 |
| documents | 10 | 9 |
| main | 7 | 7 |
| providers | 5 | 4 |
| shell | 11 | 11 |
| filters | 4 | 4 |
| recipes | 3 | 3 |
| **all** | **79** | **76** |

Three defects were seen from two slices and are merged, so the files hold **73 findings: 6 must, 40 should, 27 nice**.
By category: data-loss 15, security 2, money 6, bug 42, perf 7, maintainability 1.

The merges: `canvas-a/F2` = `canvas-b/geometry-ops-no-recheck-after-upload`; `documents/D2` = `canvas-c/F1`;
`documents/D3` = `main/MAIN-7`.

## The ones to fix first

### Must (all six)

1. **`rust/px-deflate-sync-truncation`** (data-loss), `crates/px/src/png.rs:22` `deflate_part`.
   A PNG part that is not the last one can come back cut short when its bytes are close to noise in all four
   channels (about 0.72 MB or more of such bytes, e.g. an imported RGBA noise texture). The same writer saves layers
   into the local store, so the `.scumble` and the autosave lose that layer without a warning. Fix: return -1 when
   `written == out.len()` (the caller retries with a larger buffer); size the first buffer for 31 KB stored blocks in
   `px.js`; add a `px_test` case with a random non-last part; rebuild both wasm builds.
2. **`documents/D2+canvas-c/F1`** (data-loss), `renderer/editor/host.js:5875` `referencedFileKeys`.
   Settings › Local files › Clean up deletes files that only the undo, redo or snapshot steps name. An undo then
   brings back a layer or base whose file is gone, nothing uploads it again, and the next start loses it (no copy at
   all for an API-only user). Fix: walk undo, redo and snapshots in `referencedFileKeys`; re-upload a restored layer
   whose file is missing; count such a layer in `setValue`'s `failed` so the note names it.
3. **`providers/PRV-1`** (money), `electron/main/providers/fal.js:254`, also `replicate.js:206`, `wavespeed.js:298`,
   `comfyrouter.js:879`, `comfypartner.js:188`. One failed status read or one failed picture download ends a job
   that is already paid. The job finishes and is billed, and its picture is never fetched. Fix: one shared polling
   helper in `util.js` on `bfl.js`'s rule (5 failed reads in a row, 3 download tries, Retry-After), with errors that
   name the request id.
4. **`documents/D1`** (bug), `electron/main/files.js:194` `ensureOnServer` (with `files.js:87`, `143`).
   An upload that keeps the picture's own name (a pasted `image.png`) gets a name that is free only in the local
   store, then goes to ComfyUI with `overwrite=true`. Before a run the server is checked by name only. With two
   clients on one ComfyUI, or an old file left there, a local run crops another picture. Fix: names from the bytes'
   hash (`stem_<hash8>.ext`); until then, compare the server's size with the local file and upload again on a
   mismatch.
5. **`canvas-c/F3`** (bug), `renderer/editor/inpaint_canvas.js:19625` (and `openFlyout` near 4668).
   The first flyout adds a `pointerdown` listener on `window` that `close()` and `destroy()` never remove. A closed
   tab's whole document stays in memory (GBs at 15k), and after a few tabs the renderer ends. Fix: remove
   `_flyDocDown` in `close()`, or register it with an AbortController that `destroy()` aborts.
6. **`filters/filter-layer-over-its-own-input`** (bug), `renderer/editor/inpaint_canvas.js:16316` `applyFilterLayer`
   (and `flushFilterChain` at 16330). On a half-transparent picture the screen and the Canvas 2D flatten draw a
   plain filter's result over its own input: alpha 128 becomes 192 and colours mix. The tiles program replaces the
   band instead. Exports with a Size row, PSD / ORA composites and JPEG / WebP get the wrong pixels. Fix: for a plain
   filter, clear the rectangle before drawing the result in both places; add a gate step on alpha-128 edges.

### Should (the most important)

- **`documents/D3+main/MAIN-7`** (data-loss), `electron/main/autosave.js:31`, `settings.js:78`, `keys.js:22`. No
  fsync before the rename, and any read or parse error counts as an empty store. A crash, or one failed read, can
  wipe the autosave, all settings or all API keys at the next write. Fix: fsync the temp; only ENOENT means empty;
  rename a damaged file aside instead of writing over it. **Fixed 2026-11-09 (fix-main pack 1, with `documents/D8`;
  `documents/D4` no longer held: `storeMirrorFile` writes through `writeAtomic` since D1).**
- **`main/MAIN-3`** (data-loss), `electron/main/main.js:370`. The close handler writes the window bounds before it
  stops the close. If that rename fails (another program holds `settings.json`), the window closes without the
  save. Fix: try/catch, or move the write after the quit guard; a short busy retry in the three store writers.
  **Fixed 2026-11-09 (fix-main pack 1).**
- **`main/MAIN-1`** (data-loss), `electron/main/mcp/launch.js:81`. When the MCP client closes stdin, the launcher
  kills the headless app 5 s later, in the middle of its save. Fix: spawn the app detached and drop or lengthen the
  kill; the same in `mcpb/server/index.js`.
- **`host/H-1`** (data-loss), `renderer/editor/host.js:2976`. Generate new on an empty tab: a file opened into that
  tab meanwhile is replaced by the answer, and Ctrl+S then writes over the `.scumble`. Fix: `openDocument` and
  `openInto` skip a tab with a run going; `runGenerate` checks base and file before it lands.
- **`canvas-b/paint-tools-on-text-layers`** (data-loss), `renderer/editor/inpaint_canvas.js:11734`. Brush, eraser,
  bucket, fill and the other pixel tools write into a text layer; the next text edit renders over that work without
  a word. Fix: refuse, or turn the layer into a paint layer under an undo step.
- **`shell/F5`** (data-loss), `renderer/editor/host.js:6163`. Reopen Closed Tab during the close's flush brings back
  the last uploaded pixels, not the latest. An agent's `close_document` then `reopen_closed_tab` always hits it. Fix:
  `reopenClosed` waits for the entry's flush.
- **`shell/F4`** (data-loss), `renderer/shell.js:2414`. Earlier states (the recovery path) opens documents without
  their plugin data (boxes, 3D objects). Fix: pass `plugins` and `extra` on.
- **`recipes/rec-import-overwrite`** (data-loss, **fixed 2026-11-09, fix-prov**), `electron/main/recipes.js:1879`. Importing a second
  `workflow.json` silently replaces the first user recipe with that name. Fix: pick a free id, as the other import
  paths do.
- **`providers/PRV-2`** (security, **fixed 2026-11-09, fix-prov**), `electron/main/providers/toapis.js:115`. `setPath` follows `__proto__.` keys from
  recipe data and writes onto `Object.prototype` in the main process. Fix: refuse such segments; check the keys in
  `recipes.normalize`.
- **`shell/F1`** (security), `electron/main/assistant/policy.js:226`. `layerBelow` reads the layer list as top
  first, but it is bottom first, so `merge_down` merges into the user's layer or the base without asking. Fix:
  `list[at - 1]`; fix `prompt.js`'s label and the test fixture.
- **`shell/F3`** (money), `renderer/assistant.js:543`. Unanswered ask cards stay clickable after Stop, and call ids
  repeat, so a click can allow a newer paid ask. Fix: disable the cards when the turn ends; a unique token per ask.
- **`shell/F9`** (money), `electron/main/assistant/index.js:847`. The render card never shows the settings the chat
  changed, though the policy lets the chat change them without asking on that condition. Fix: record and show the
  changed rows; until then ask for `set_settings` / `apply_preset` on provider recipes.
- **`main/MAIN-2`** (money), `electron/main/main.js:1181`. A paid API result whose page reloads or crashes during the
  run is thrown away. Fix: write it to a results folder with a note the new page opens; ask before Reload while
  runs are going.
- **`host/H-2`** (bug), `renderer/editor/host.js:1482`. An opened document keeps the Settings rows of the recipe it
  was saved with, and a run of the current recipe sends them (Klein's model files into Qwen's loaders, an old tier on
  a paid run). Fix: `settingsChanged()` after `setValue` in `restore()`; skip entries whose target differs.
- **`host/H-3`** (bug), `renderer/editor/host.js:5813`. The export path is one global. Overlapping exports write each
  other's files, and one order leaves the path set for later exports from the UI. Fix: pass the path with the call.
- **`tiles/T2`** (bug), `renderer/editor/inpaint_compositor.js:583`. A tile atlas budget of 2048 MB or more
  overflows to 16 MB and turns the GPU compositor off. Fix: no `| 0`; clamp to a maximum.

## The rest, by area

### Editor canvas: geometry, transforms, undo (`inpaint_canvas.js`)

| id | sev | cat | file:line | claim | effort |
|---|---|---|---|---|---|
| canvas-a/F2+canvas-b/geometry-ops-no-recheck-after-upload | should | bug | inpaint_canvas.js:5985 | Crop, resize and extend do not re-check after their upload; a stroke, a move or a Generate in that second lands in the wrong geometry | medium |
| canvas-b/snapshot-restore-skips-turnblocked | should | bug | inpaint_canvas.js:14274 | Restoring a snapshot of another size is allowed while a run is going; the result lands misplaced | small |
| canvas-a/F1 | should | bug | inpaint_canvas.js:3066 | Rotate / Distort / Warp Apply bakes into a canvas over 268 MP and gets an empty layer, reported as success | small |
| canvas-a/F3 | should | bug | inpaint_canvas.js:3645 | Arrow nudge moves locked and filter layers and pushes one undo step per key repeat; Rotate Apply bakes a locked layer | small |
| canvas-c/F2 | should | data-loss | inpaint_canvas.js:21333 | New canvas empties the layers before the Each-area refusal throws | small |
| canvas-b/undo-geometry-no-seq-bump | nice | bug | inpaint_canvas.js:13180 | An undo of an extend does not bump `geometrySeq`; a running depth map lands shifted | small |
| canvas-a/F6 | nice | bug | inpaint_canvas.js:5467 | A turn or flip does not turn the Gradient fill's angle and centre | small |
| canvas-b/edit-depth-stale-map | nice | bug | inpaint_canvas.js:13725 | Two quick depth edits both start from the same map; one is lost | small |

### Editor canvas: layers, tabs, keys (`inpaint_canvas.js`)

| id | sev | cat | file:line | claim | effort |
|---|---|---|---|---|---|
| canvas-a/F4 | should | bug | inpaint_canvas.js:3470 | A question left open in a background tab answers itself from Enter / Escape typed in another tab | small |
| canvas-c/F4 | should | bug | inpaint_canvas.js:18480 | Loading a new picture into a tab keeps the old depth map, results, saved selections and solo | small |
| canvas-c/F5 | should | bug | inpaint_canvas.js:24702 | A layer's Match source 'underneath' at strength 0 is lost on save | small |
| canvas-c/F6 | should | bug | inpaint_canvas.js:17361 | Merge down drops the lower layer's colour match without a word | medium |
| canvas-c/F7 | should | bug | inpaint_canvas.js:21102 | A thumbnail click hides reference and control layers that are results, with no way back | small |
| canvas-a/F8 | nice | bug | inpaint_canvas.js:3830 | Space-pan and the `\` peek stay on when the key is released outside the window | small |
| canvas-c/F9 | nice | bug | inpaint_canvas.js:18965 | Result numbers restart after Clear history and repeat existing layer names | small |

### Selection

| id | sev | cat | file:line | claim | effort |
|---|---|---|---|---|---|
| canvas-a/F5 | should | bug | inpaint_canvas.js:7995 | On tiles, SAM2 clipped to the active layer ignores the layer's shown size, position and mask | medium |
| recipes/sam2-stale-embedding | should | bug | host.js:6583 | Point and box segmentation reuse the embedding of the picture before the last edit | small |
| canvas-a/F7 | nice | bug | inpaint_canvas.js:8056 | The window copy of the intersect clip keeps transparent pixels (the worker has the fix) | small |

### Memory and window blocks at 15k

| id | sev | cat | file:line | claim | effort |
|---|---|---|---|---|---|
| canvas-b/undo-records-keep-cache-canvases | should | perf | inpaint_canvas.js:14152 | Undo records keep each layer's full-size cache canvases; a memory release frees nothing | small |
| canvas-b/copy-merged-whole-flatten | should | perf | inpaint_canvas.js:12370 | Copy merged flattens the whole document for any selection size; throws above 268 MP | small |
| canvas-b/save-selection-sync-dataurl | should | perf | inpaint_canvas.js:9340 | Save selection makes a whole-document canvas and a synchronous PNG encode | medium |
| canvas-c/F8 | should | perf | inpaint_canvas.js:22867 | The local run's mask is built whole on the window (about 2.4 GB transient at 15k) | medium |
| canvas-b/depth-proxy-cache-unbounded | nice | perf | inpaint_canvas.js:15927 | Depth proxies are kept for every map version | small |

### Tiles and GPU compositor

| id | sev | cat | file:line | claim | effort |
|---|---|---|---|---|---|
| tiles/T1 | should | bug | inpaint_compositor.js:1044 | Over the atlas budget, `composite()` returns before the eviction, so every later frame fails too | small |
| tiles/T3 | should | bug | inpaint_canvas.js:21677 | After a WebGL context loss the compositor never comes back for that document | small |
| tiles/T4 | should | perf | inpaint_tiles.js:2631 | A selection combine copies and rewrites tiles it cannot change | small |

### Filters

| id | sev | cat | file:line | claim | effort |
|---|---|---|---|---|---|
| filters/depth-map-texture-reuploaded-every-pass | should | perf | inpaint_maps.js:214 | The depth map's texture is uploaded again on every pass (22 MB per filter per frame at 15k) | small |
| filters/cube-domain-applied-to-outputs | nice | bug | inpaint_filters.js:396 | A .cube's DOMAIN rescales the outputs instead of the inputs | small |
| filters/haze-cpu-twin-half-pixel | nice | bug | inpaint_depthfx.js:171 | The haze CPU path samples at pixel corners, the shader at centres | small |

### Rust kernels

| id | sev | cat | file:line | claim | effort |
|---|---|---|---|---|---|
| rust/px-vogel-prefix-taps | nice | bug | relight.rs:153 | The quick shadow march's single tap sits off the light; shadows jump when the full march lands | small |

### Host, stitch, local runs

| id | sev | cat | file:line | claim | effort |
|---|---|---|---|---|---|
| host/H-4 | should | bug | host.js:6956 | A local result whose `executed` event falls into a socket gap never lands | medium |
| host/H-5 | nice | data-loss | host.js:1485 | A parked or failed-open tab can be closed without a question and stays bound to its file (part b refuted) | small |
| host/H-6 | nice | bug | stitch.js:961 | After a stitch worker failure the fallback uses the current selection, not the run's | small |
| recipes/upsampler-combo-form | nice | bug | host.js:5585 | The upsampler file check reads only the older combo form of `/object_info` | small |

### Documents and the local store

| id | sev | cat | file:line | claim | effort |
|---|---|---|---|---|---|
| documents/D5 | should | bug | shell.js:2881 | Close and Reload do not wait for an export; it is dropped without a word | small |
| documents/D4 | nice | data-loss | files.js:89 | Store files are rewritten in place; free names are picked without a reservation | small |
| documents/D6 | nice | bug | docfile.js:633 | Two opens share one import temp; one reports a file that exists as gone | small |
| documents/D8 | nice | maintainability | files.js:24 | The store's name rule has drifted from docfile's (device names like `aux.png`) | small |
| documents/D9 | nice | bug | docfile.js:505 | A read-only target is found only after the whole file is written, with the wrong reason | small |
| documents/D10 | nice | bug | docfile.js:385 | The temp list is emptied even when a delete failed | small |

### Main process

| id | sev | cat | file:line | claim | effort |
|---|---|---|---|---|---|
| main/MAIN-4 | nice | data-loss | comfyview.js:574 | Save to recipe overwrites the held recipe with whatever tab the ComfyUI page shows | medium |
| main/MAIN-5 | nice | bug | main.js:1452 | `AgentBackend.ensure()` is not single-flight; two calls start the app twice | small |
| main/MAIN-6 | nice | data-loss | filesaves.js:121 | A failed in-place copy deletes the temp, the only complete copy | small |

### Providers

| id | sev | cat | file:line | claim | effort |
|---|---|---|---|---|---|
| providers/PRV-3 | should | money | replicate.js:203 | Cancel and timeout on fal and Replicate never ask the provider to stop (**fixed 2026-11-09, fix-prov**) | small |
| providers/PRV-5 | nice | bug | util.js:31 | A JSON error body is not cut and can carry a whole base64 picture (**fixed 2026-11-09, fix-prov**) | small |

### Commands, MCP, the assistant

| id | sev | cat | file:line | claim | effort |
|---|---|---|---|---|---|
| shell/F2 | should | bug | assistant/index.js:1012 | The assistant adds `layer` to every call; `select_color`, `set_crop` and the box tools then fail | small |
| shell/F6 | nice | bug | commands.js:2026 | `set_layer` moves locked layers; `set_text` writes a locked layer, then errors | small |
| shell/F7 | nice | bug | bridge.js:90 | The Bridge cuts an MCP call at 600 s while the command waits longer | small |
| shell/F8 | nice | bug | commands.js:1466 | `set_node_params` has no upper bound, unlike the panel | small |
| shell/F10 | nice | money | commands.js:1669 | `upscale`'s own timeout does not cancel the run | small |
| shell/F11 | nice | bug | commands.js:1893 | A refused second `generate` wipes the report fields of the run in flight | small |

## Suggested order

The fixes are grouped into small sessions by file. Each lane below owns its files. Inside a lane the sessions run
one after another. Lanes can run side by side, because they share no file. A session marked **needs** touches a file
of another lane: start it only while that lane is idle.

Test tiers follow the working rules: **full** for the store, documents, autosave and quit, Rust, the compositor and
export pixels; **normal** for tools and features; **light** for providers built against docs.

**Lane R: Rust** (`crates/px`, `renderer/editor/px.js`, `tools/px_test.js`). These are the kernel work's own files:
run them between kernel sessions, not beside one.
- R1: `rust/px-deflate-sync-truncation` (must). Full.
- R2, optional: `rust/px-vogel-prefix-taps`, the one-tap part only (`relight.rs`, `kernels_js.js`). Say the effect
  to the user first. Normal.

**Lane P: providers and recipes** (`electron/main/providers/` except `index.js`, `electron/main/recipes.js`).
- P1: `providers/PRV-1` (must), `providers/PRV-5` (`util.js`, `fal.js`, `replicate.js`, `wavespeed.js`,
  `comfyrouter.js`, `comfypartner.js`, new fake-fetch tests). Light.
- P2: `providers/PRV-3` (`fal.js`, `replicate.js`, `wavespeed.js`, `bfl.js`). Light.
- P3: `providers/PRV-2`, `recipes/rec-import-overwrite` (`toapis.js`, `recipes.js`). Normal.

**Lane D: documents and the local store** (`electron/main/files.js`, `docfile.js`, `documents.js`).
- D-1: `documents/D1` (must), `documents/D4`, `documents/D8`. Full.
- D-2: `documents/D9`, `documents/D10`, `documents/D6`. D6 also changes `main.js:1134`: **needs lane M idle**. Full.

**Lane M: main process** (`main.js`, `settings.js`, `keys.js`, `autosave.js`, `filesaves.js`, `comfyview.js`,
`mcp/launch.js`, `mcpb/server/index.js`, `providers/index.js`, `cloudjobs.js`, `bridge.js`).
- M1: `documents/D3+main/MAIN-7`, `main/MAIN-3` (`autosave.js`, `settings.js`, `keys.js`, `main.js`). Full.
- M2: `main/MAIN-1` (`mcp/launch.js`, `mcpb/server/index.js`). Shares no file with M1, so it can run beside it.
  Normal, with the gate step the finding names.
- M3: `main/MAIN-2` (`providers/index.js`, `cloudjobs.js`, `main.js`). Normal.
- M4: `main/MAIN-4`, `main/MAIN-5`, `main/MAIN-6`, `shell/F7` (`comfyview.js`, `main.js`, `filesaves.js`,
  `bridge.js`). Normal.

**Lane E: editor canvas** (`renderer/editor/inpaint_canvas.js`). Strictly one session at a time. Do this lane before
item 56 splits the file, or redo the line map after the split.
- E1: `canvas-c/F3` (must), `filters/filter-layer-over-its-own-input` (must), with a new gate step on alpha-128
  edges. Full (both backends, exports).
- E2: `documents/D2+canvas-c/F1` (must): `host.js` `referencedFileKeys`, `inpaint_canvas.js` `applySnapshot` and
  `setValue`. **Needs lane H idle**. Full.
- E3: `canvas-a/F2+canvas-b/geometry-ops-no-recheck-after-upload`, `canvas-b/snapshot-restore-skips-turnblocked`,
  `canvas-b/undo-geometry-no-seq-bump`, `canvas-c/F2`. The refusal report also touches `commands.js`,
  `inpaint_modal.js` and `assistant_turns.js`: **needs lanes H and A idle**. Normal.
- E4: `canvas-b/paint-tools-on-text-layers`, `canvas-c/F4`, `canvas-c/F5`, `canvas-c/F6`, `canvas-c/F7`,
  `canvas-c/F9`. Normal, plus a document round trip for F5.
- E5: `canvas-a/F1`, `canvas-a/F3`, `canvas-a/F4`, `canvas-a/F8`, `canvas-a/F6`. F1 also changes `commands.js`
  (`transform_layer`): **needs lane H idle**. Normal.
- E6: `canvas-a/F5`, `canvas-a/F7`, `recipes/sam2-stale-embedding` (also `host.js` `segmentKey`, maybe
  `inpaint_bands.js` / `inpaint_worker.js`): **needs lane H idle**. Normal on both backends. Check U1's file list
  first: U1 moves the helpers and may touch the same host code.
- E7: `canvas-b/undo-records-keep-cache-canvases`, `canvas-b/copy-merged-whole-flatten`,
  `canvas-b/save-selection-sync-dataurl`, `canvas-b/depth-proxy-cache-unbounded`, `canvas-b/edit-depth-stale-map`,
  `canvas-c/F8`. Save selection changes what the document stores (`{ url, box }`), so that part is full; the rest
  normal, with a 15k memory check.
- E8: `tiles/T3`, after lane T's T-1. Normal.

**Lane T: tiles and compositor** (`inpaint_compositor.js`, `inpaint_tiles.js`).
- T-1: `tiles/T1`, `tiles/T2`, with a composite gate step over a small budget. Full.
- T-2: `tiles/T4`, with a pixels test on both routes. Full.

**Lane H: renderer host and shell** (`renderer/editor/host.js`, `renderer/shell.js`, `renderer/commands.js`).
- H-a: `host/H-1`, `host/H-2`, `host/H-5`, `shell/F4`, `shell/F5` (`host.js`, `shell.js`). Normal, with a document
  round trip.
- H-b: `host/H-3`, `documents/D5` (`host.js`, `commands.js`, `shell.js`, and `main.js` `flushAll`): **needs lane M
  idle**. Normal.
- H-c: `host/H-4`, `recipes/upsampler-combo-form` (`host.js`). Normal, against a fake server.
- H-d: `shell/F6`, `shell/F8`, `shell/F10`, `shell/F11` (`commands.js`, `host.js` for F8's field table, and
  `assistant/policy.js` for F6): **needs lane A idle**. Light to normal.

**Lane A: the assistant** (`electron/main/assistant/`, `renderer/assistant.js`, `tools/assistant_test.js`).
- A1: `shell/F1`, `shell/F3`. Normal.
- A2: `shell/F2`, `shell/F9`. Normal.

**Lane F: small editor files** (`inpaint_maps.js`, `inpaint_filters.js`, `inpaint_depthfx.js`, `stitch.js`,
`stitch_worker.js`, `tools/film_test.py`).
- F-1: `filters/depth-map-texture-reuploaded-every-pass`, `filters/cube-domain-applied-to-outputs`,
  `filters/haze-cpu-twin-half-pixel`. Normal (haze changes CPU pixels: both backends).
- F-2: `host/H-6`. Normal.

**A start that keeps files apart:** first round R1, P1, D-1, E1 and M1 (five of the six musts, plus the stores;
the sixth must is E2). These share no file. Second round: E2 while lane H has not started, beside M2, A1, T-1 and P3. After that each lane
goes on in its order, and the **needs** marks decide when a cross-lane session can start.
