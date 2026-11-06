# Testing: the tools and the known flakes

Moved out of `CLAUDE.md` on 2026-09-27, verbatim, so the file every session reads stays short. The rules (which tier a
change gets, `--offline`, both backends, the exe gates once per release) stay in `CLAUDE.md` "Working rules" and "Gate
runner"; this file is the reference behind them.

## What each test tool covers

Test with real runs: start `./node_modules/.bin/electron . --remote-debugging-port=9555`
  (9333 is usually taken by the node's headless tab), then `python tools/cdp.py eval|shot|log`
  and `python tools/smoke_test.py` (load, select, generate through the recipe, save,
  then the helpers and exports; `--no-helpers` for the short version) and
  `python tools/commands_test.py` (command core + sample plugin, no ComfyUI needed).
  `python tools/mcp_test.py` talks to the MCP server over stdio through
  `electron/main/mcp/launch.js` (proxy mode while the dev instance runs, headless when
  nothing runs; `--exe dist/win-unpacked/Scumble.exe` for the package, `--direct` for the
  old registration, which the Python client rejects by design).
  `python tools/mcp_attach_test.py` (run by the `mcp` gate after it) checks `--attach-only`, the switch of the repo's
  `.mcp.json`, on a profile of its own: `ping` alone and nothing started while no Scumble runs, the attach to an
  instance it starts (port 9573) with `tools/list_changed`, nothing started after that instance closes.
  `node tools/filesaves_test.js` (plain Node, run first by the `export` gate) pins `electron/main/filesaves.js`, an
  export saved in pieces (0.1.51): the bytes of uneven pieces, an older target kept until the finish, a cancel, a
  piece out of order, twice or past the size, a short finish, another page's piece, abortAll per page, the refusals
  before a write (a folder, a missing folder, a read-only file, a full drive, no size), EBUSY on the rename (then the
  write in place, and its refusal), pieces sent without waiting, the next start's sweep of a killed save, a page
  dropped while its save waits for the dialog or for the open, a hard link and a symbolic link, a 250-character name,
  a temporary file still held at a cancel (it stays listed), and every dropped save's handle closed (`fh.stat()` EBADF:
  on Windows the name of an open file goes at its unlink). The `export` gate then saves 600 MB through
  `host.saveExport` (the size that ended the renderer in one message), counts the pieces read off the blob and reads
  the file back whole, cancels a save, drops a file on the shell bar with a save open (the save stays), and reloads the
  window with a save open (its temporary file goes), on both backends. Not covered in the app: the drop on a renderer
  end (`render-process-gone`) and at `will-quit` (one line each in `main.js`; the module's `abortAll` is tested), and
  the URL test that keeps a refused navigation from dropping the saves: neither a script's `location` change nor a CDP
  file drop reaches `did-start-navigation` before `will-navigate` refuses it (the mutation that drops the test survived
  both, 2026-10-24), so the drop check above holds either way.
  `python tools/llm_test.py` checks the OpenAI-compatible upsample endpoint against
  `tools/llm_mock.py` (a mock server it starts itself; no ComfyUI, no key, no local model).
  `python tools/boxes_test.py` covers the Boxes plugin (item 28 S3a-S3d): the commands and their refusals, one undo
  step per change, the selection as a box, the document's boxes through the core's `collectBoxes`, the panel's rows,
  a crop moving the boxes, a `.scumble` round trip, the tool (S3b: draw, move, resize, keys), the crop frame and the
  panel's warnings (S3c), and the Boxes switch (S3d, step `the_boxes_switch`, a document of its own with a loopback
  recipe that takes boxes: the row hidden and shown, the first box turning it on and the count, a run with it on and
  off counting the sources asked, the note, the panel's note and the overlay's dashed half-strength outline through a
  recording context, a box the crop leaves out keeping the selection from going, the selection as one box with none,
  the switch through a `.scumble` save and open); no ComfyUI and no key needed. `node tools/boxes_test.js` is the
  plain-Node side (main's rows, the renderer's mapping, the plugin's clipboard formatter).
  `python tools/generate_test.py` covers "Generate new" (a base image from the prompt
  alone) against the loopback provider, no ComfyUI and no key needed; its step `cancel_a_waiting_run` presses the
  title row's Cancel on a loopback run of 20 s, once while the crop is made (nothing sent) and once while the
  request waits in main (stopped at once), and `tools/comfyrouter_test.js` section 8 checks `providers.cancel`.
  `python tools/shape_test.py` covers the shape tool: every kind, fill and outline, the
  corner radius, the clip to the selection and one undo step per shape.
  `python tools/size_test.py` covers the size a crop is emitted at for an API run: the
  provider variant's `limits`, the five API size modes, the pixel budget, and that a local
  recipe keeps its `target_size`. Loopback only, no ComfyUI and no key needed.
  `python tools/transparent_test.py` covers the OpenAI `background` parameter: the adapter's
  size rules and parameter set in plain Node, then the loopback provider's transparent
  answer surviving the stitch, "Generate new" with a transparent base, and the pixel floor.
  `python tools/editor_test.py` covers the editor behaviour reported broken in 0.1.5: the
  New dialog's two size boxes and its focus, the click that deselects, the outline that has
  to stay visible on white, and copy / paste of a layer between tabs; since 0.1.31 also the Undo history (rows, jumps, snapshots, depth, the history commands).
  Its retouch steps check the kernel's bytes: `heal_blends_the_source_into_the_picture_at_the_release`,
  `remove_fills_the_hole_from_the_model_at_the_release` (a stand-in for LaMa) and
  `patch_blends_the_donor_into_the_selection_at_the_release` (the Patch tool: the landed RGB against `poissonBlend` of
  the selection's mask, Source, Destination, Blend, the worker, the clamp at the picture's edge, a feather, the
  refusals, no flatten while it drags) and `content_aware_move_fills_the_hole_and_blends_the_seam` (the LaMa stand-in:
  the model's input, the fill, the seam band against `distTransform` and `poissonBlend`, the core exact, an overlapping
  move reading the fill, Blend all, Extend, the worker, the held gesture, a failure, the refusals).
  Liquify has `liquify_bakes_each_stroke_from_the_session_source` (both backends: every landing equals the bake of the
  session's source through the whole field, pool and here, a forced small gather, Restore all exact, undo / redo with
  the field, the base's copy, the held bake and the tile guard, no flatten while it drags) and
  `liquify_brushes_move_the_picture_and_refuse` (the modes, Alt, the selection, the refusals, the keys) and
  `liquify_freeze_holds_what_it_covers` (a frozen band holds its bytes under a push, thaw, Restore all under a freeze,
  Invert, Clear, the veil, a flip and a new picture drop the freeze). `python tools/brush_perf.py '{}' liquify_perf.js`
  measures Liquify at 15000 x 10000 (docs/PERFORMANCE.md §15.1; a measurement, not a gate).
  `SCUMBLE_EDITOR_ONLY=name,name` runs just those steps. On the canvas backend `readRect` of a sub-rectangle of a
  canvas with pixels that are not opaque can differ by a level from a read of the whole canvas (measured 2026-09-28,
  286 of 108k bytes, only where alpha < 255; 0 on tiles): an expectation for such a picture is built from the reader
  the tool uses (`brushSource("all").bytes`), as the move step's case 15 does.
  `node tools/helpers_test.js` runs the ONNX modules without Electron (LaMa in its own process too); it needs the
  model files, a missing one is skipped. `node tools/remove_test.js` checks the Remove tool's crop and resampling
  (`renderer/editor/inpaint_remove.js`) without models. `node tools/liquify_test.js` holds Liquify's kernel
  (`renderer/editor/inpaint_liquify.js`) to 23b's resampler on constant fields, to a direct integer reference on random
  ones, the bounded gather's split to the unsplit bytes, and the brushes to their rules (advected, restore exact, no fold).
  `python tools/composite_test.py` compares the GPU compositor against Canvas 2D and two
  stored references in `tools/refs/` (`--update` rewrites them, `--tolerance n` allows n
  levels); run it after anything that touches drawing.
  `python tools/perf_test.py [2048x1152 6000x4000 12000x8000]` is the drawing benchmark
  (synthetic documents in their own tab, no ComfyUI; `docs/PERFORMANCE.md` §7); with `--filter=relight` it adds
  relight's march rows (one light, three lights, a drag step's quick map, a pan during a march, the first march).
  The kernel update's harness (`docs/PLAN_WASM_BUILD.md` K0a, K0b; measurements, not gates): `native_test.py` (the main
  thread's px time by function, the px call counts per row, `wand_whole_add`, `bucket_fill`, the stitch laps),
  `px_jobs.py` (the selection and map rows of §4.3 / §4.8 beside the old ones), `selection_test.py`'s two range cases
  in ms, `export_test.py --perf ... --fill-limit`, `w0_bench.py` (`freqsep_4000`, `stitch_align_2048` / `_4096`,
  `edgefit_2048`, `match_fallback_16k`, `grow_fallback_15k`, `--size=WxH`), `brush_perf.js` (TOOLS `blur`, `sharpen`,
  `tone`, `sponge`; `KERNELS`), `liquify_perf.js` (`KERNELS`), and `PX_BENCH=1 node tools/px_test.js` (medians, a cold
  first call). Each reads the window's step marks (`InpaintEditor.stepMarks`) and the px.js call counters
  (`InpaintEditor.pxCalls`, a worker job's `timing.pxCalls`; the single editor worker's overlapping jobs count each
  other's calls, so a gate step that asserts a Rust path ran uses a pool job, the stitch worker or the window).
  K1 adds the route A/B: `px_jobs.py --ab NAME=A:B` (`kernels`, `stacks` or a route of `px/kernels.js`), `--set`,
  `--split`, `--fresh-pool` (a timing run with the window behind prints NOT COUNTED and exits 2),
  `python tools/ab_median.py` over three runs' `PX_JOBS_JSON` (medians, the spread, the tie rule), and
  `tools/px_probe.py` (`--cold`, `--regrow`, `--retention`; gate `pxprobe:<args>` with commas). `node tools/px_test.js`
  takes about 8 s longer since K1 (its lifecycle cases wait out the 2 s idle trim). `native_test.py ... open_again`
  (#0 of the plan's §7) opens the same file a second time into a new tab and prints both opens side by side with the
  programs' link waits (`gl getProgramParameter`, counted in every row's boundaries since). `native_test.py` brings
  the window to the front first (`Page.bringToFront`, as `px_jobs.py` does); every row still says `focused`, and a
  chain counts a row only with the window in front (the user may be at the machine).
  D0 (the PSD open in the pool job `psd_read`): `node tools/layered_test.js` twins `readPsdStream` against the
  window's `readPsd` on every PSD it reads (bands of 3 and of 256 rows, the masks against a frozen copy of the window's
  mask loop); `node tools/layered_test.js --twin-file PATH` does one file of any size by SHA-256 (the 15k PSD, the
  Photoshop-written `tools/fixtures/blendmodes/blendmodes.psd`). The `layered` gate's step
  `the_pool_and_the_window_read_a_psd_alike` reads the gate's PSDs and the Photoshop fixture through the pool and the
  window and compares this backend's pixels, and checks the refusals, the fallback, the stop of an open that is over
  and a worker lost mid-read (`pool.stats()` `lost` against `stopped`). The switch `InpaintEditor.psdOnPool` (false: the
  window's reader; "fail": a job no worker knows, so the fallback runs) is a class switch for harnesses, like
  `mipsOnPool` and `pngParts`, not a route of `px/kernels.js`: it chooses where the reader runs, not which kernel
  (K20b's JS / Rust choice inside `psd_read` becomes a route).
  K5 (the selection's combine, Rust `sel_combine`, ABI 21): `node tools/px_test.js`'s `selCases` twin `sel_combine` on
  both builds against `kernels_js.js` `selCombine`, and that twin against the editor's `combineRows` with a plain extent
  scan (every mode x the source kinds 0 / 1 / 2 / 4 x seven parts of a tile x four tile states, with a tile's stride and
  a band's long row, which px.js packs: 448 cases; the twin also on a tile one byte off its alignment, its bytes path),
  a new tile against a transparent one, seven refusals (short views
  over longer buffers among them), no pixel to combine without a source, `alphaAny`, and the `selCombine` route of
  `px/kernels.js` (the same bytes on js and rust, `write` at most once, Rust's calls counted, the twins' route making no
  missing tile from a source that covers nothing); `PX_BENCH=1` adds one tile's medians. `node tools/combine_test.js`
  section 12 runs `TileMaskPixels.combine` on both routes against a per-pixel model over every view and read kind (192
  combines: the cached extents and `bounds()` exact), a fresh extent on every tile it writes, a fractional or
  out-of-range colour clamped as a tile's bytes stored it, and the views' offsets and refusals. The `selection` gate's
  `real_wand_on_tiles` and `range_select_depth_cases` and the `editor` gate's
  `wand_and_bucket_flood_a_region_not_the_image` require `sel_combine` calls on tiles while the route is on Rust
  (`InpaintEditor.pxCalls`). `px_jobs.py` times the window's combine per row (`combine`, `combineN` in the JSON) and
  checks the route ran; `ab_median.py` takes `combine` as the `selCombine` route's kernel row and prints "not touched by
  the route" for a row whose combine ran in neither arm. The `depth` gate has no script of its own (`docs/BUGS.md`):
  run `node tools/depth_test.js` in its place.
  W1 (the PNG writer's filter choice in SIMD lanes, `crates/px/src/png.rs` `row_filter` / `lanes`, no ABI change):
  `node tools/px_test.js`'s `pngFilterCases` twin `png_filter_rows` on both builds against `kernels_js.js`
  `pngFilterRows` (each case also at an odd offset), that twin against px_test's own `reference.pngFilterRows`, and the
  SIMD build's lines unfiltered back to the input: 1032 cases, every row width from 1 to 40 px (every count of bytes
  after the last 16-byte group, and the rows under 5 px that keep the scalar loop) and widths around 64, 256, 1024 and
  4096 px, with and without the row above; random, tiny-range, two-value, around-128, flat and per-filter "forced" rows,
  rows equal to the one above, and rows whose Up sum is 128 a byte over more than 255 groups (a u16 lane sum that
  overflowed would pick Up). A coverage check over the rows of 5 px or more (the ones that reach the lanes) requires
  every filter to win rows, ties of the sums won by None, Sub, Up and Average, and Paeth ties of a over c and b over c.
  The writer takes 8-bit RGBA only, so no other pixel size or depth is asked.
  K12 (relight's march in stripes, `inpaint_relight.js` `stripePlan` / `marchOnPool`, JS only, no ABI change):
  `node tools/px_test.js`'s `relightStripeCases`: `stripePlan` over 12 heights x 8 counts (contiguous, even, never under
  32 rows), 308 cases of S stripes into one buffer against one call (the twin for point, spot, a light on a pixel, below
  the surface and off the map; the Rust sun straight up, grazing and through `lightToMap`, on both builds and through
  kernels.js as a worker routes it; 512 x 341 and 1024 x 682 at taps / steps 1/16 to 16/64 in 2 to 21 stripes); the
  resident depth slot (`px.js` `_slot`: eight keyed stripes copy the map once, a new key or size copies again and never
  answers from the old copy); `marchOnPool` on a real `WorkerPool` with fake workers (one shared out, no transfer, the
  bytes; the non-SAB and route-0 paths one job; a failed stripe or other rows reject and cancel the rest; a group
  cancelled from outside rejects with `CancelledError` and sends none of its queued stripes); K12b's feed (`feedCases`:
  at most the budget of stripes of two marches posted at once, first come first served, the bytes; a NORMAL job behind
  two fed marches sent as soon as the first stripe answers, after every stripe without a budget; one set of job fields a
  march; with the pool's size + 1 an EXPORT job waits for the march, with the size alone it would not; `cancelMarch` on a
  march partly posted and on one waiting whole; a failed stripe; a pool terminated with a march waiting in the feed
  rejects both marches and starts no worker after it). The `relight` gate's case
  nk ("three nudges: only the last key lands"): for a point and a sun three nudges flushed at once post three full
  marches, the pool cancels exactly the stripes of the two superseded ones, one landing (current) holds the last key and
  the bytes of one call, the sun's stripes on Rust and the point's on the twin, each nudge's quick march lands; three
  nudges without a flush cancel nothing; there, back and there again posts two full marches and lands one; the route
  `relightStripes` 0 is one job of all rows; case nf (K12b): three lights released at once post at most the pool's size
  + 1 stripes, the rest waits in the feed, all land with the bytes of one call; a quick march posted meanwhile bypasses
  the feed (nothing more fed, its stripes on the pool at once) and lands before the full marches' last stripe; the route
  `relightFeed` 0 posts every stripe at once (the superseded marches of case nk are counted in the pool and the feed
  together).
  `perf_test.py --filter=relight` adds the stripes' rows (the stripes and
  their workers, kernel ms, each worker's first stripe against its later ones, the other pool jobs and mip chains of a
  row, the efficiency of the named row and of the same march again against the one-job route), a whole change during a
  three-light march, eight NORMAL jobs during one, and a light made a sun; `docs/measurements/k12_2026-11-06/`
  (`k12_chain.sh`, `summarize.py`) runs them three times on fresh instances under the machine's busy lock. K12b added
  the same marches on 64 stripes (`_s64`) and, where the build has the route, with every stripe posted at once
  (`_nofeed`, the route `relightFeed` 0), the drag step again on one job and on stripes (`relight_quick_job`, `_rep`)
  with the window's longest gaps and the landings' times (`_gaps`, `_landings`), the sun fed again after the unfed march
  (`relight_sun_feed2`, the order swapped), and eight NORMAL jobs of about a stripe's time each during a three-light
  march (`relight_heavy_*`: a crc of one blob sized on a calm pool to about 60 ms a job, [the first job's queue wait,
  the last one's] and the answers; the 1 KB rows above drain back to back on one worker, so they show one job's wait);
  `docs/measurements/k12b_2026-11-06/`.
  `docs/measurements/w1_2026-11-06/w1_identity.js --old <the px.wasm before W1> file.png ...` re-filters real PNGs in
  the app's parts of 128 rows on the new SIMD build, the scalar build, the old SIMD build and the JS twin and compares
  every line (and, for a file Scumble wrote, the file's own lines); the old build is
  `git show 59ff16f:renderer/editor/px/px.wasm`. The mutation round's script is `mutation/mut_w1.py` there.
  `python tools/mem_test.py [12000x8000] [--rounds 4] [--keep]` is the memory walk: a
  document per round, benchmarked, closed and collected, with the private bytes of the
  renderer and of the GPU process, a census of every live canvas and the line that made it.
  Restart the app before every benchmark or memory run. Scripted
  waits must use `setTimeout`, never `requestAnimationFrame`: rAF does not fire while the
  window is hidden, and `drawSoon()` is rAF-based, so a hidden window draws nothing.
  Start the dev instance with the Bash tool's `run_in_background`; a plain `&` job dies
  with the shell.
  `window.editor` and `import("./editor/host.js")` are reachable from the console.
  Only one instance runs at a time (single-instance lock); stop the dev instance before
  starting `dist/win-unpacked/Scumble.exe`. `Stop-Process -Name electron` in PowerShell.

Since then: `tools/document_test.py` / `document_ux_test.py` / `document_perf.py` (gates `document`, `docux`,
`docperf:WxH`, `.scumble` documents), `tools/quit_test.py` (gate `quit`), `tools/metadata_test.py` (gate `metadata`,
what an exported picture says about itself; `node tools/secret_names_test.js` the names it leaves out of an embedded
recipe), `node tools/font_ref_test.js` (which file a text's font is loaded from), `node tools/pixel_memory_test.js`
(the tile store at the renderer's typed-array limit, the refusal stood in for), `tools/tiff_test.js` with `tools/tiff_fixtures.py` and
`tools/tiff_test.py` (gates `tiff`, `tiffperf:WxH`; `tiffperf:WxH,--variant,all` also opens Scumble's own TIFF of the
15k photo and Pillow / tifffile files with LZW, PackBits, zlib in one strip and none, `docs/PLAN_WASM_BUILD.md` K0a),
`tools/comfyview_test.py` (gate `comfyview`, the ComfyUI window of
item 35 V1 against a stub server it starts, offline only: the start page with no target and no load, one window on a
second open, its bounds kept; the stub page without `window.scumble`, `window.comfybar` or `require`, kept on its
origin; Ctrl+S reaching the page and no Scumble menu command, also after the menu is built again, with a control key
that must reach the menu in the editor's window first (keys go in over CDP with focus emulated: an occluded window
drops them otherwise); basic, bearer and custom-header auth on the page and on `/ws`; a wrong password ending on the
401 start page without a login loop; a dead server; V2: a fake `window.app` on the stub records the recipe's graph
(the result and the Settings rows wired, the recipe's name), a second recipe replaces it, a provider recipe is
refused, a load that throws and a page without `window.app` say so in the bar, the start page names the recipe;
V3: the bar's Save to recipe overwrites the held recipe with the fake page's `graphToPrompt` answer (a shipped one as
a user copy, its rows and labels kept, the UI graph stored) and the editor selects it, Save as new recipe takes the
name in the bar, a graph without the node and an answer that is no prompt are refused; the recipes it saves are
removed at the end, and it refuses a profile holding a user recipe it would overwrite; `tools/recipes_test.js`
section 6 checks `recipes.fromGraph`; V4: `tools/comfyhosts_test.js` (the sign-in hosts, popups and navigation in plain
Node), then with the stub standing in for the cloud the window titled Comfy Cloud refuses a recipe with the node and
offers no save, the bar's select switches back and the recipe loads, the target is kept, the start page names Comfy
Cloud and its Use Comfy Cloud switches; the target the profile had is put back; V5b: `tools/cloudgraph_test.js` runs
the Flux.2 Klein recipe's cloud form through `comfycloud.js` against a fake cloud.comfy.org (pictures into the titled
LoadImage nodes in batch order, the last one repeated, the values and rows in their inputs, the own SaveImage first,
the node list once per key, a missing node refused before any upload, a fill recipe's mask, a marked graph's own
result); V5c: Settings › Recipes' Cloud copy saves and selects `<id>_cloud`, which opens on Comfy Cloud as its graph,
a graph without the node saved from the window is a Comfy Cloud recipe that Save to recipe overwrites, and a graph with
the node is refused for it; `tools/recipes_test.js` section 8 checks `fromCloudGraph` and the import of an API and a UI
export; section 9 reads all 26 image-edit templates of Comfy's template package without titles
(`tools/refs/comfy_templates/`, MIT; `python tools/template_fixtures.py <templates folder>` refreshes them and the
node definitions they use, read from a ComfyUI in its own input order); V6: the gate's two steps check the comfy cloud
mode (the select, the list, each mode's last recipe, the Generate new dialog's Comfy Cloud choice), section 10 the
thirteen shipped Comfy Cloud recipes against the exports they come from (`node tools/cloud_recipes.js --check`,
`tools/refs/comfy_cloud/`) and against the required inputs of the fixtures' node list, `tools/cloudgraph_test.js` runs
an edit and a text-to-image one on its fake cloud and `tools/refs_layout_test.js` sweeps their layouts;
`tools/recipes_test.js` section 5 checks `fromPrompt(toPrompt(r))` on every shipped ComfyUI recipe), `tools/canvasonly_test.py` (gate `canvasonly`, the canvas-only
view of item 24: real Tab and Escape presses over CDP; the chrome hidden, the view the window's size, full screen and a
fitted picture while on, the view / rulers / chrome / window put back after; Tab ignored in a text field, a dialog, the
editor's ask and with Shift; Escape cancels a pending transform or an open polygon first and never reaches the editor
when it leaves; a full-screen exit from outside, a tab switch and closing the tab end the view; a window that was full
screen before stays so; it takes the test window full screen and back), `tools/clip_test.py` (gate `clip`, layers
clipped to the layer below, PLAN_0_1_31 §6 step 3: analytic on the flatten and the workers' export (coverage 0 = the
clipped layers hidden, 255 = their clip off), every path against the flatten, the GPU view against Canvas 2D at 1:1,
at a base of 60 %, over an emptied base and with the base off the view, a hidden base, a filter base, undo, getValue,
PSD both ways, the merges; run it on both backends), `tools/groups_test.py` (gate `groups`, groups as folders,
PLAN_0_1_31 §6 step 5: a hidden group against its layers hidden one by one on every path, byte for byte, the GPU view
against Canvas 2D, lock, solo, the clip's group edge, the steps and drops through the tree, undo, the panel's tree,
getValue / setValue with a damaged state repaired, PSD both writers, opened and dropped, ORA, the commands; both
backends: the PNG export and the stack box are the tiles' only).

Release 1 gates (`docs/PLAN_NIK9_BUILD.md`): `tools/selection_test.py` (gate `selection`, Select by depth, luminosity, colour, SAM2 object tool box drag with logits bilinear sampling, Intersect mode, soft selection combine), `tools/limit_test.py` (gate `limit`, WebGL2 and CPU twin filter limits on filter layers and fill layers, depth, luma, colour ranges, falloffs), `tools/maps_test.py` / `node tools/maps_test.js` (gate `maps`, document auxiliary maps store, geometry following, persistence, and staleness fingerprinting), `tools/depth_test.py` (gate `depth`, Depth Anything V2 Small ONNX model in main, IPC, guided filter worker job, and `depth_map` command), `tools/maskview_test.py` (gate `maskview`, Layer-mask overlay, black-and-white alone view, filter effect view with limit rendering on black, memory bounds). Every gate name `X` without a rule of its own
in `tools/run_gates.sh` runs `tools/X_test.py`.

Release 2 gates: `tools/edges_test.py` / `node tools/edges_test.js` (gate `edges`, depth edge snap mathematics, bilateral colour guidance, robust tile fitting and raised-cosine overlap fusion, rangeMax and edgeTiles detection, and edge-snapped Select by depth on both backends with bounded scratch allocations and 15k memory limits); `tools/depthfx_test.py` / `node tools/haze_test.js` (gate `depthfx`, built-in `haze` and `dehaze` filters, bilateral edge snap, dark-channel prior, airlight estimation, van Herk / Gil-Werman minFilter, and guided transmission refinement).

With no app reachable on `SCUMBLE_CDP_PORT` (default 9555), `tools/selection_test.py`, `limit_test.py`, `maps_test.py` and
`edges_test.py` run their node suite, then print `[FAIL] CDP session not reachable` (`maps_test.py`: `[FAIL] CDP test
failed`) and `FAIL` and exit 1 (since 0bebaec, 2026-10-11; before, they printed "node test passed" and exited 0;
measured 2026-10-12 with `SCUMBLE_CDP_PORT=9599`). `--node-only` runs the node suite alone and exits 0; `maps_test.py
--launch` starts its own instance on port 9555. `tools/relight_test.py` also exits 1 with no app (`[FAIL] CDP session
error`); it has no `--node-only`, and `RELIGHT_GATE_SKIP_NODE=1` skips its node suites (Release 5 below).

Release 3 gates: `tools/grading_test.py` / `node tools/grade_test.js` (gate `grading`, colour grading 3-way split toning with Shadows/Midtones/Highlights/Global wheels, smooth partition of unity, 8-channel HSL filter layer with swatched hue/saturation/luminance controls, GLSL and CPU parity, neutral greys preservation, and preset hover previews in filter rows); `tools/masks_test.py` / `node tools/points_shapes_test.js` (gate `masks`, paste mask from layer across transformations, control point softness falloffs, ellipse shapes, polygon points 3..16 vertices with interior anchor, line points with directional feather, and points clipboard copy/paste); `tools/effects_test.py` / `node tools/effects_math_test.js` (gate `effects`, Effects pack plugin with `effects.chromatic_shift` lateral/plates/linear chromatic aberration and `effects.glass` ribbed/reeded/wavy/blocks/frosted/pebbled glass displacement, fractal value noise fbm, frost pre-blur with mirrored edge padding, specular sheen, and WebGL2 / CPU twin parity).

Release 4 gates: `tools/blendmodes_test.py` / `node tools/blend_table_test.js` (gate `blendmodes`, blend modes gate across all 26 modes on both backends: 65,536 exhaustive pair and triplet checks, export against kernel parity with 0 diff bytes on tile engine, flatten against kernel with emulated modes 0 bytes and native modes gated <= 3, GPU view vs kernel <= 1 level, canvas view vs kernel, translucent layer at opacity 0.75 and masked/clipped layer on half-transparent base with worker against flatten <= 3 and over2 <= 10^-4, fill filter layers across all modes, PSD and ORA round-trip preservation, reader version requirements, command validation for `set_layer`, TIFF/PNG export and merge agreement, showcase references on 1024x640 with 25 non-normal columns against blendmodes_full.png and blendmodes_view.png, and live PSD fixture verification against Photoshop-merged output).

Release 5 gates: `tools/relight_test.py` / `node tools/relight_test.js` (gate `relight`, relight filter layer with point, spot, and sun virtual lights, ray-marched soft shadows from depth height fields, Rust wasm kernels height_normals and shadow_march with JS fallbacks, alternating least-squares fit of original scene lighting, Kelvin colour temperature conversion, bilateral edge-guided depth normals and shadow visibility, and GPU / CPU twin parity; note: `tools/relight_test.py` requires an active app instance or gate runner and exits 1 if no app is reachable; it runs the node suites first, and `RELIGHT_GATE_SKIP_NODE=1` skips them for a mutation round of `inpaint_relight.js`, whose node suites would fail before the in-app checks run) and `node tools/relight_request_test.js` (generative relighting requests: Magnific image-relight with light map mode 1, fal IC-Light v2, fal Bria with 13 lighting styles, Comfy Cloud detached graph, local ComfyUI recipe relight_qwen_local with LoRA loaders and trigger word, and guided-filter detail ratio texture transfer).

`node tools/px_test.js` checks the relight kernels as the app routes them (kernels.js loads `px.wasm` as a pool worker
does: point and spot march in the JS twin, a sun in Rust, byte for byte); `PX_BENCH=1` also times them at 1024 x 1024
and on the drag's quick map, `PX_BENCH=large` at 2048 x 1365 and 4096 x 2731 too (`docs/PERFORMANCE.md` 15.2; run it
under Electron's V8 with `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/px_test.js`).

Item 32 (the update question, `docs/PLAN_0_1_38.md` A1): `node tools/updater_test.js` runs `electron/main/updater.js`
with Electron and electron-updater stubbed: the release notes and one line per bullet from the 0.1.37 feed
(`tools/refs/updates/release_0_1_37.html`) and small cases (sub-bullets, several versions, the 30,000 cap), a skipped
version kept from installing on quit and the quit handler added when the skip is taken back, a skipped download checked
again, `manual` kept, `announce`, and source checks of main's wiring and of electron-updater's quit handler. The
platform gate's `the_update_question_asks_once` asks once in the window (the focus on Later, not again for an asked,
announced, manual or skipped version, Skip stored and in main's status, the wait for another question, the question
before a restart while an API run or a local render is in flight); `tools/restart_test.js` keeps a skipped version out of
a restart.

Item 36 (the portable copy, `docs/PLAN_0_1_42.md` P1): `node tools/platform_test.js` pins `electron/main/portable.js`
(the data folder only for a packaged Windows copy with `portable.txt` beside the exe; `--user-data-dir`, then the Store,
then the marker; one spelling through a subst drive; the folder made and proven by a probe write, the refusal's text;
`updateMode`: only the uninstaller beside the exe installs, every other Windows copy is `notify`), reads main.js's use of
it (the folder set before `log.install`, one `setPath`, the refusal before it, the updater's mode, no jump list entry,
`app:info`), and runs `keys.js` over a stubbed safeStorage (a key another account stored reads `stale`, `secrets.json`
byte-equal after describe / list / get). `tools/updater_test.js` runs notify mode: `autoDownload` and
`autoInstallOnAppQuit` off before the check and after every event, state `available` with the tag's URL, no download,
no install, no quit handler. The platform gate's `a_copy_that_does_not_update_itself_offers_the_release_page` drives the
window: Download in the Updates section and the title row, the question once with Download / Later / Skip this version,
Download opening the tag's page (`shell.updateLinks.open` stubbed). The packaged start on a marker is P3's `portable`
gate (below). The zip (P2, `tools/portable_zip.js`): `platform_test.js` builds one from a fake `win-unpacked` in a temp folder
with Windows' `tar.exe` and reads it back by its own central directory (one top folder `Scumble/`, the marker's bytes,
no `data` even from a stale stage that has one, an old file of the zip's name replaced, the source untouched), checks
the refusals before anything is staged (no exe, no `app-update.yml`, another feed, another version in the asar, no
asar, a `data` folder), and reads `dist:portable` in `package.json` and the windows job's order in `build.yml`
(installer, its artifact, the zip, the zip's artifact, the upload to the draft on a tag only). The real zip is checked
by hand once per build (`docs/RELEASING.md`).

The `mcpb` gate (`tools/mcpb_test.js`, plain Node; `docs/PLAN_MCPB.md`) covers the `.mcpb` bundle of the MCP server:
the staged manifest validates with `@anthropic-ai/mcpb` and carries `package.json`'s version and one tool per `###`
heading of `docs/COMMANDS.md`; the starter's `STORE_LAUNCH` equals `registration.js`'s and its uninstall GUID is the
uuid v5 the test computes from the appId; the search order with injected registry, `exists` and `lstat` answers (an
explicit path wins and reads no registry, one that does not exist is reported and nothing else searched, the empty
field and the client's literal `${user_config.scumble_exe}` count as not set, `InstallLocation`, then the
`UninstallString`'s folder, HKLM, the default folders, an exe without `resources\app.asar` is no install, the Store
alias by `lstat` after the installer, an explicit alias or version folder takes the Store route); the two start forms
against `registration.server()`; the fallback as a process over stdio (`initialize` echoing the client's protocol
version, one read-only tool, its text naming the missing path and the downloads, `ping`, an unknown method, exit 0 on
stdin's end, nothing but JSON on stdout); `--where`. With `--exe` it starts the exe headless through the starter on a
profile of its own with `--no-comfy` (`tools/list` ≥ 100 tools, `ping` in mode `headless`, the exit when stdin
closes), and runs the starter **inside an Electron UtilityProcess the way Claude Desktop does**
(`tools/mcpb_utility.js` with the dev tree's electron, forking `tools/mcpb_utility_host.js`: the shape of Claude
Desktop's `nodeHost.js`, which replaces `process.stdout.write` and `process.stdin` by messages over a MessagePort and
loads the entry with `import()`; found 2026-10-09 when the first bundle timed out in Claude Desktop after 120 s: its
starter handed the launcher stdio "inherit", and no bytes reach a host that reads no handles; `require.main ===
module` is never true under `import()` either). `--store` (by hand) does the same through the Store alias of this
machine. PASS on 2026-10-09 (plain, the 0.1.44 exe, the Store copy 0.1.42). The install in Claude Desktop itself is
a hand test (`docs/PLAN_MCPB.md` §7).

The `portable` gate (P3, `tools/portable_test.py`, `--exe` only) starts portable copies of the exe's folder the way a
user does, **without `--user-data-dir`**, so it is the one gate that could reach the user's own `%APPDATA%\Scumble`.
It refuses, starting nothing and reading nothing there, without `--exe` and while any `Scumble.exe` runs (the user's
window, a headless or MCP-started one, a runner app of another gate: run it alone, or only beside `lint`, `types`,
`quit`, `document`). It runs `tools/platform_test.js` first, then: (1) snapshots `%APPDATA%\Scumble` (names, sizes,
times) and the top level of `%APPDATA%` and `%LOCALAPPDATA%`, and copies the user's `settings.json` and `autosave*.json`
to `dist/gates/portable-backup/<time>` (kept across runs); (2) stages copies A and B (`<out>\A\Scumble` with the marker);
(3) proves the detection with two starts that cannot rotate an autosave (the built `portable.js` in the exe's Node mode,
then `--cmd ping --attach-only`, which must make A's `data` and leave `%APPDATA%\Scumble` as it was), then starts A's
window (`--no-comfy`, port +19): `app:info.userData` is `A\Scumble\data`, read first on every start (else the instance
is killed at once and the gate stops), `Local State` and `settings.json` there; (4) a setting changed through the
Settings field's own listener survives a WM_CLOSE and a start; (5) a stroke's autosave in A's data, "Last session
restored." with the same pixels after the next start; (6) a `.scumble` saved to `A\docs\`, the tab closed, opened
again with the same pixels; (7) B beside A (port +20), `--cmd ping --attach-only` from each exe answering from its own
instance (told apart by a canvas size only that instance holds: ping names no pid); (8) both Help > Copy MCP
registration entries clicked in A's main process through its Node inspector (`--inspect` on A's last start, port
+21) with `clipboard.writeText` swapped for a recorder (the user's clipboard is never written): A's exe and launcher;
(8b) A's update status is `notify`, never a download; (9) a copy C whose folder denies this account writing (icacls
`(OI)(CI)(WD,AD,WEA,WA)`: the plan's plain `W` also denies running the exe, measured 2026-10-05) shows the error box,
which the gate presses OK on (a task dialog's TDM_CLICK_BUTTON first), exits with 1, makes no `data`, and its stderr
line names its data folder; (10) the snapshot again: `%APPDATA%\Scumble` unchanged, no new Scumble names in `%APPDATA%`
or `%LOCALAPPDATA%`, the Scumble-named ones there unchanged. The cleanup takes the deny entry off C (`/remove:d`, then
`/reset /T`) before it deletes the staged copies (`--keep` keeps them) and closes every instance it started by WM_CLOSE.

Item 26 (`docs/PLAN_REFS.md`, @img tokens for reference layers): `node tools/refs_layout_test.js` pins every adapter's
`layout(req)` against the request its real builder sends (every shipped provider variant, every ToAPIs channel, 0 / 1 /
3 references, the Original on and off; a fake fetch captures the picture-carrying request), the caps, and
`providers/index.js`'s marker resolution, refusals and `layout(shape)` with Electron stubbed. `node
tools/reftokens_test.js` covers `renderer/editor/reftokens.js` (the grammar, remap, markers, names, the upsample check,
the caret mapping). Both read `tools/refs_cases.json`, the grammar main and the renderer share. `tools/recipes_test.js`
section 3 checks `refs.name`. Gate steps: `generate`'s `provider_markers_over_ipc` (a marker resolved and a raw token
refused over IPC, `provider:layout`); `commands`' `refs_labels` (img labels, a new reference and a copy take the next
number), `refs_remap` (hide / show, up / down, delete / undo, role changes, a merge: the prompt's tokens follow their
layers) and `refs_restore` (a `.scumble` round trip byte for byte, a reference whose file is missing parks its tokens
as `@img?<id>`, a named snapshot with Revert). 26b2 adds `refs_send` (a loopback edit run: `prompt_sent` names the
pictures by their place, with the Original too; a hidden reference's token and a literal `{@ref:` each refuse at once
with nothing sent; its step 5, a stubbed ComfyUI recipe, is 26e's since then, below), `refs_names` (an upscale writes
the cleaned layer name, the Upscale dialog's prefill too; since 26f the Generate new dialog's prefill keeps the
tokens) and `refs_agents` (labels in `list_layers` / `status`,
`status.references[].sent_as` with and without the Original, `set_prompt refs`); `tools/assistant_test.js` checks the state note's `ref @img1`. 26a2
adds `refs_layout_test.js` sections 8 (`refs.instruction`, `labelParts` and `checkPictures` against literals: 0 to 4
references, a mask picture or field, the Original, `Image {n}` and `<image{n}>`, style layouts, the exact drop notes
and cap messages, a cap that is no number above 0) and 9 (`index.js` with the loopback's `options.drops` and
`options.max_images`: the stripped request, `notes` in the answer and the log record, refusals before the adapter,
`layout(shape)`'s `names` and `over`), and its caps section moves to 26a2's caps (every reference or a refusal, no
partial drop); the adapter tests (`ark`, `openrouter`, `oxen`, `comfyrouter`, `magnific`, `toapis`, plain Node and
gates) take the new sentences. The `commands` steps `refs_declared_drop` (a loopback recipe with `options.drops` and
two visible references: the loopback gets none, the status says "not sent", `generate` returns one note) and
`refs_over_cap` (`options.max_images: 2`: refused with "at most 2 pictures; this run has 3", no loopback call) run
the path through the app. 26d1 adds `generate`'s `upsample_references` (a stub language model in `host.askLLM`
answering from a queue, two paint references: no token gives the instruction of before, the edit and fill cases name
only the reference the prompt names and carry the token rule, a hidden reference's token refuses with no call, an
answer that drops, adds and numbers gives the status note and `check`, and a swap of the references while the model
answers carries the answer and Revert's text to the new labels), `prompt_templates`' `{references}` checks, and
`reftokens_test.js` section 11 (`referenceName`, `referencesText`, `referencesRule`, `checkNote`). 26d2 adds
`node tools/llm_images_test.js` (plain Node, `llm.js` with `./keys` and `./settings` stubbed and a scripted fetch: each
builder's part sequence with the reference pictures, the bodies without them byte for byte, the cap of six, the
switch, `vision: false`, the compatible client's steps all -> crop -> text with their notes, which failures step down
and which do not, labels on one line), run by `llm_test.py`'s `node_test()` too; `llm_test.py` step 5c (two paint
references against `tools/llm_mock.py`: `mock-vision` gets 3 pictures in label order, the Settings switch off gives
1 and the instruction still names both, the new `mock-one` gets 3 then 1 with "crop only"); and in `generate`'s
`upsample_references` the stub's two pictures (labels, 512 px) and none with `host.llmRefPictures` off. Every
gate that touches references ends with `ed._refDrift` 0: a change of the shown references that no site remapped is
counted in `renderReferences`.

26c1, the prompt field (`renderer/editor/prompt_field.js`): `node tools/prompt_field_test.js` covers its pure helpers
in plain Node (`sanitize`, `atWordStart`, `unitBefore` / `unitAfter` over chips, emoji and surrogates, with and without
`Intl.Segmenter`, `EditHistory`'s merging, word steps, `map` and cap, `chipState`, `renderPlan` with an open token);
the import itself proves nothing touches the DOM at load. The editor gate's five `prompt_field_*` steps
(`tools/prompt_field_steps.py`, each on a document of its own with two references) drive the field with real CDP input:
`is_the_textarea_for_every_reader` (value, selection kept while blurred and put back by `focus()`, placeholder,
disabled, the hidden "@" of zero width with `innerText` reading the token, live / inactive / broken chips),
`types_deletes_and_moves_over_chips` (Backspace and Delete take a chip whole, the arrows step over it, Enter, a typed
token turns into a chip at the space, the automatic space against a chip and the typed space stepping over it, a caret
on both sides of a chip between two others, `ed.undo` untouched), `undo_redo_paste_and_copy` (word steps with the
caret, Ctrl+Y and Ctrl+Shift+Z, a paste with CR LF and U+200B, a copy over a chip, an undo after a remap gives the
remapped older text, `"reset"`), `leaves_a_composition_alone` (`Input.imeSetComposition`: the chip nodes are not drawn
anew, an Enter while composing adds no line, a remap during a composition lands on the composed text) and
`keeps_the_editor_keys` (Ctrl+Enter and Ctrl+U reach `generate` / `upsamplePrompt`, Escape hands the focus to the
editor, Backspace / Delete / Ctrl+Z / the AltGr probe run no editor shortcut, a click on a chip's chevron keeps the
focus). While iterating: `SCUMBLE_EDITOR_ONLY=prompt_field_is_the_textarea_for_every_reader,... bash tools/run_gates.sh
26c-it --offline --tiles on editor`.

26c2, the @ picker, the reference bar, the hover card, the swap menu and the chip drag: `node tools/prompt_field_test.js`
section 8 covers `pickerRows`, `barCount`, `cardLine`, the `over` and `none` chip states and `imageFiles`. The editor
gate's steps in `tools/ref_picker_steps.py` (the same document and helpers as the 26c1 steps): `ref_picker_opens_on_at_and_inserts`
(an @ at a word start opens one picker and after "mail" none, the query filters, the first Escape closes it and keeps
text and focus, the second leaves the field, the arrows wrap, Enter and Tab insert as one field-undo step, the AltGr
probe opens it once, a hidden reference is left out with a note, `ed.undo` untouched), `ref_picker_adds_a_reference_in_place`
(`addReferences` in a session puts the token where the @ was, without one at the kept caret; a pasted and a dropped
picture become references named where they came in; pasted text stays text; `_refDrift` 0),
`ref_bar_hover_and_swap` (with the host's `refLayout` stubbed and put back: cap 1 gives an over chip and "2 of 1 for
this recipe", none strikes every chip; a bar click inserts at the kept caret; the hover card is absent at 250 ms and
there within 1.5 s with "sent as image 2", gone after the pointer leaves; the chevron's menu swaps a token as one undo
step, "Show jacket" brings a hidden reference and its token back, "Remove from prompt" takes the token and a space),
`ref_picker_keeps_what_stood_there` (the review's findings: an @ typed before a word or a chip is replaced alone, Enter
with nothing listed is a new line, a chip or word moved in front of a chip keeps a space, a swap menu under a remap
removes its own chip, an edit of an unfocused field reports one change) and
`prompt_field_drags_a_chip` (a press without a move only places the caret, a press moved to the end of the text moves
the chip there with a drop caret on the way, one undo puts it back). `prompt_field_keeps_the_editor_keys` now expects
the chevron click to open the swap menu and the first Escape to close it. While iterating:
`SCUMBLE_EDITOR_ONLY=ref_picker_opens_on_at_and_inserts,ref_picker_adds_a_reference_in_place,ref_bar_hover_and_swap,prompt_field_drags_a_chip
bash tools/run_gates.sh 26c-it --offline --tiles on editor`. The hover and drag steps call `Page.bringToFront` first:
synthetic pointer events are unreliable while a real mouse is over the window (see the flakes below).

FLUX 3 Image (`electron/main/providers/flux3.js`, `recipes/flux3.json`, `docs/PLAN_FLUX3.md`): `node tools/flux3_test.js`
(plain Node, a scripted api.bfl.ai, 101 checks) pins the recipe as `recipes.js` serves it (two Settings rows on each
shape, no `selection_box` since S3d), the body against the released
schema (only prompt, images, aspect_ratio, resolution, safety_tolerance, grounding; every body sent is checked at the
end), the aspect preset within 3 % or auto, the tiers by area, the 256 px / 16 MP / 20 MB rules (the crop refused, a
reference scaled through `ctx.resizePng`, the JPEG fallback), the parameter coercion (safety 0 to 4, grounding from an
agent's words), the poll (Reasoning, 503 / 422 status bodies, dropped connections and gateway pages retried, the
download tried three times, the regional polling_url allowlist), the answer's info (cost, megapixels, expanded prompt,
no seed), the selection box (a request with one box ends in the JSON rows, a stray app-side key in the params never
reaches the body, a request without boxes sends the same body as before) and that FLUX.2 through the same adapter is
unchanged.
Light tier: written from the docs; a live call is the user's (`docs/PLAN_FLUX3.md`).

P-H3-Image (`recipes/p_h3_image.json`, `recipes/p_h3_image_local.json`, `docs/PLAN_PH3.md`): `node tools/ph3_test.js`
(plain Node, a scripted api.wavespeed.ai, 23 checks) pins the WaveSpeed variant as `recipes.js` serves it and its
bodies against the schema's fields (an edit: the crop and the references as `images`, the Resolution row, the seed,
png, no `aspect_ratio` and no negative; a new image: the nearest of fifteen aspects, the tier; with references the
edit route), ten pictures refused before any upload; its §3 checks the local graph against the node specs of
`tools/refs/comfy_templates/object_info.json` (every input name one its class declares, the required ones there,
combos other than model files in their options, numbers in range, links to nodes of the graph; also the queued shapes
of Generate new and of the upsampler off), pins Pruna AI's values (shift 1 / 1, the eight sigmas, the LoRA at 1, type
`minimax`, `euler`, the latent from the conditioning) and proves the check catches a renamed input. The local recipe
also: `comfyrefs_test.js` (its `<Picture {n}>` slots), `comfyprompt_test.js` (its upsampler request with `verbatim`,
`dropForNewImage`), `recipes_test.js`, `loras_test.js` and the
`generate` gate's step `p_h3_generate_new_is_text_to_image` (the queued graphs of an edit and of Generate new against
stubs). Light / Normal tier: written from the docs and the node specs; a live run is the user's.

MOSS-Image Edit (`recipes/moss_image_edit_local.json`, `docs/PLAN_LORAS.md` LR6): `node tools/recipes_test.js` §15
checks its graph against the node specs of `tools/refs/comfy_templates/object_info.json` (`TextEncodeMOSSImageEdit`
and `SkipLayerGuidanceDiTSimple` there since LR6, written from ComfyUI 0.44.0's V3 schemas, and CLIPLoader's types of
0.44.0) through `tools/node_specs.js` (the spec check `ph3_test.js` §3 shares; a growing input read by its names or by
its prefix and max, at least its min given), as `normalize()` serves it and in the shapes a run queues (the crop alone,
two pictures, four, two LoRA rows), pins Comfy's template values (the edit LoRA at 1, SLG layer 22 over 0-1, 30 steps,
CFG 4, euler / normal, Moss-Image-Edit on both encoders) and proves the check on a broken copy. Also
`comfyrefs_test.js` (`image {n}` over 4 slots, the two encoders' trim), `loras_test.js` (the declared source: the rows
after the edit LoRA) and the `loras` gate's step `moss_edit_needs_a_043_server_and_takes_rows_after_its_edit_lora`
(against a v0.42 node list `list_recipes` says not ready with the sentence and the run is refused before any upload;
with the node the queued graph holds the row after the edit LoRA; the missing edit LoRA refused with its link). Light
/ Normal tier; run live at LR9 (`docs/measurements/lr9_2026-11-06/`).

LoRAs (item 50, `docs/PLAN_LORAS.md`): the gate `loras` (`tools/loras_test.py`) runs `node tools/loras_test.js` (89
checks: `renderer/editor/loras.js` over every graph of every shipped recipe, raw and normalised, with the fixtures'
node list and with the class table: the model source, the chain and every reader re-pointed, the declarations through
`normalize`, the rows, `missingLoras`, `comboOf`, the family table and the hints, the picker's helpers) and `node
tools/loraheader_test.js` (56 checks: `electron/main/loraheader.js` on synthetic safetensors files it writes in its own
temp folder: each family's keys and shapes, the header and metadata caps, a file that is no safetensors, the server
and path checks, the twins in `loras.js` held equal) first, then the app (`--offline`) with the server stood in for:
the page's `fetch` answers POST /prompt (so `api.queuePrompt` builds the real body), `/object_info/LoraLoaderModelOnly`
and `/view_metadata`, and `host.loraHeader` stands in for the IPC. Its steps: the chain in the queued copy with the
strengths and the separators in the server's spelling, the recipe's graph untouched; a missing file refused after one
re-read and before `ensureOnServer`, six rows refused, an unread list refusing nothing, `loras: false`; the via line in
the landed result's history entry; the LoRAs section (after Settings, hidden with its reason under an API recipe, an
upscaler, the pass, `loras: false`, two loaders and `cloud_ideogram_4`; **+** to five, **×**, the picker's search,
groups, keys and pointer, the strength's clamp, the tick, the rows per recipe across documents, `copySavedLoras`); the
hint lines (grey, amber with the run still queued, the chips, one read per server and name, the family split and *Show
all*); MOSS-Image Edit's readiness against a v0.42 node list and the rows after its edit LoRA; and Comfy Cloud (LR5,
`cloud_generate_new_sends_the_chain_to_comfy_cloud`) against `tools/fake_comfy_v2.js` served on a loopback port by
`tools/fake_comfy_v2_http.js` (`tools/fake_cloud_http.py`: the gate's profile gets the mock as
`settings.comfycloud.base` and a test key, put back afterwards; **a profile that holds a Comfy Cloud key skips the
step**, so a gate run against an instance with the user's key never replaces it): Comfy Cloud's lists through main (the
account's own imports, the catalog, the node list's combo), the picker's *Your imports* group and a typed name,
`set_generation` keeping a name the lists lack, `status` / `list_loras` source `comfycloud`, Generate new on
`cloud_flux2_klein_9b` with the chain in the text graph the mock got and the note in the answer, then a Generate (an edit,
`runProvider`) with the chain in the edit graph, its `loras_sent` and the result's history entry naming the rows ("...
via Comfy Cloud + 2 LoRAs: ..."), the crop uploaded only after Generate new's submit, the test key on every call (bearer
on v2, X-API-Key on v1). Also: `settings_migration_test.js` (the `recipeLoras` store), `metadata` (the PNG
chunk's `loras`), `commands` (`loras_commands`: `set_generation` `loras`, `status.loras`, `list_recipes` `loras`,
`list_loras`, `loras_sent`; `loras_on_comfy_cloud`: `list_recipes` `loras` for every Comfy Cloud recipe and
`generate_new`'s `loras_sent` on `cloud_z_image_turbo` against the same mock, with its own test key), `skins` step 15
(the section and the picker in every skin), `mcp` and `assistant` (`list_loras` read-only). The splice in main in plain
Node: `comfycloud_v2_test.js` §16-17 (v2: the switch and patch graphs, the list's spelling, a name the list lacks sent
and named by a failure, `loras: false`, a declared model per route, an unread node list, six rows, `loraList`) and §15
(through `providers/index.js`), `cloudgraph_test.js` §11 (the legacy API). Normal tier on tiles (no pixel path
changed); the live runs are LR9's (`docs/measurements/lr9_2026-11-06/`); a paid Comfy Cloud run with a LoRA is LR5's,
on the user's word.

The Key screen (item 49, `docs/PLAN_CORRIDORKEY.md`; the in-app engine is not built, so everything runs on a stub):
the gate `key` (`tools/key_test.py`, both backends, `--offline`) replaces `host.keyEngine` with a fixture engine
and checks the landing's bytes and mask (MASK_RGB), the trim, the grey layer, the hidden source, one undo, the
restore, Re-key (held features read nothing; otherwise the source layer or the picture under the key, never the
key's own pixels), Auto on a layer's own pixels, a Cancel that frees the document at once, PSD / ORA, **the refine of
a scaled matte** (step `refine`: the whole picture keyed at a third of its size over a sharp disc, the mask refined in
the key worker with no fallback and `guideDiff` at most a level, nearer the edge than the bilinear matte and
`keymatte.refineMatte`'s bytes exactly; a fill layer over the box changes nothing; a layer source refines too), the
Key dialog's loop (a selection change, real selection-brush strokes, the dab coalescing, a stale ticket, the final run
never replaced, features gone prepared again, a turn of the picture, an edit under the panel, another tab, the
dormant, missing and CPU states) and `key_screen` (preview, rekey, hint mask, `status.key`). **Route B** (the key on
the user's ComfyUI, `host.keyComfy`; steps `comfy *`): a connected server and pack A's node list stood in for,
`host.uploadInput` and `host.comfyPictureRun` stubbed with B0's fixture (`tools/fixtures/corridorkey_routeb/`, real
answers of pack A at `c7662de`): the picture and the hint that went byte for byte, the queued graph equal to B0's,
the landed bytes and mask equal to the pack's `rgba` answer, Re-key (the picture under the key, the mask as a clean
matte), the scaled path (the half fixture: the mask `refineMatte`'s bytes exactly, the colour within a level of the
bilinear rows), the refusals (not connected, no pack, a run going, the models missing, an answer of another size) and
a Cancel or a closed tab mid-job; `key_screen` on that route (step `comfy command`: its deadline, preview, `route: "app"`
refused, `status.key.comfy` ready and not connected); the Key dialog on that route (step `dialog comfy`: no session and nothing run before
Key, the box line following the selection, the rows and the wait in the graph, Key and Re-key once, the first-run
block, the readiness line following the server). Plain Node: `node
tools/keying_test.js` (the box plan at 1k / 4k / 15k, `comfyPlan` (Route B's box and the cap), the buckets, reflect-101, the screen from the ring, the matte's
box, the bilinear rows, the queue, the texts, and the refine's steps through `RowsClient` against `refineMatte`'s
bytes) and `node tools/keymatte_test.js` (the refine module, `renderer/editor/keymatte.js`: an equal-luminance edge
snapped to within 1 px, a flat picture left alone, banded equal to unbanded (both methods' halos read and trimmed),
sensor noise and subjects near the screen's colour (nothing added where the engine was sure), a read that is not the
bucket's picture falling back, the noise estimate, the geometry, the refusals; `--measure` the edge measurement,
`--time` the module at 4k, 8k, 15k). The helper downloader: `node tools/download_test.js` (72 checks without network
or models: two local HTTP servers as two hosts, a fetch stub for huggingface.co and its CDN: the token rule, the
sha256, the resume cases, sets in their own folder, the overall progress, the free-disk and terms refusals, the
CorridorKey placeholder, `tools/ck2_catalogue.js`) and `node tools/scan_test.js` (the set's names at small sizes).

Ideogram 4.5 (`recipes/ideogram_4_5.json`, `electron/main/providers/replicate.js`, `util.js` `ideogramMask`,
`docs/PLAN_IDEOGRAM45.md`): `node tools/ideogram45_test.js` (plain Node, a scripted api.replicate.com and
api.wavespeed.ai, 149 checks; 67 of them Replicate's, I1) pins
the Replicate variant as `recipes.js` serves it, the Precise Edit body (exactly prompt, seed, image, mask, quality,
num_images; no negative, size or aspect), the mask inverted pixel for pixel with the 128 threshold, no mask for a
whole-crop selection and a refusal for an empty one or one of another size, a crop steeper than 6:1 refused and a
picture over 25 MB sent as JPEG or refused (all before any request), the seed under 2^31, `reference_images`
only with references and the cap of 4 before any upload, the unnumbered layout, the text route's `size` from the seven
presets with Very low sent as Low, and that FLUX.1 Fill and Nano Banana 2 on Replicate send what they sent before.
The WaveSpeed sections (I2) play the media upload (ticket, presigned PUT, the binary fallback), the submit and the
download, and read every picture back from its upload: the edit body exactly prompt, image, mask_url, quality,
edit_precision (and reference_images with references; no seed, output_format, negative, aspect or size, the
`accepts` allowlist), the inverted mask, the whole-crop and empty selections, the 6:1 and 25 MB checks with a JPEG
upload's mime, the text body exactly prompt, quality, aspect_ratio, resolution, enable_prompt_expansion (the tier by
the long side, no Edit precision, Very low as Low), no seed reported, the key never on a presigned PUT or a download,
and FLUX.1 Fill and Nano Banana 2 on WaveSpeed unchanged. A mutation round of 8 changes to `wavespeed.js` on a copy
(2026-10-02) was caught by all. Light tier: written from the docs, no live call (the user's word).

Boxes in the prompt (item 28 S1, `electron/main/providers/boxes.js`, `renderer/editor/boxes.js`, `docs/PLAN_BOXES.md`):
`node tools/boxes_test.js` (plain Node, 63 checks) pins the 0 to 1000 grid (BFL's own example), the shape check and
its refusals, one FLUX 3 row per kind against the FLUX 3 layout (the Original shifting the reference slots as the
markers do, a from box past the pictures or after a strip refused), a text run's layout rows, the instruction
sentences, `applyBoxes`' prompt, and the renderer's module (the frame, pixels to fractions with a crop that cuts the
selection, the selection as a New or From box, the small-box note, the same id pattern on both sides). The wiring in
the app was looked at once over CDP for S1 (2026-10-02, a loopback variant that declares `options.boxes`); since S3d
the `boxes` gate's step `the_boxes_switch` runs it (the Boxes switch that replaced S1's row, the selection as one
box, the status line).

26e, @img tokens on local ComfyUI recipes (`renderer/editor/comfyrefs.js`, `docs/RECIPES.md` "Reference images named
in the prompt (local)"): `node tools/comfyrefs_test.js` (plain Node, run by `recipes_test.py`'s node step after
`recipes_test.js`) covers the shipped specs (Qwen 2.1 `<image{n}>` with 10 slots, Klein `image {n}` with 4, both
identity traces), the layout matrix (selection × fill × Original × refine × 0 / 1 / 3 / 12 references: each picture's
number, `kept`, the drops), the trim (only the inputs past the batch, never the crop's, Klein's conditioning chain
intact), the marker vectors of `tools/refs_cases.json` against both resolvers (`comfyrefs.js` and
`providers/refs.js`), and imported graphs through `recipes.fromPrompt` (Edit Plus, Qwen 2.1, a `ReferenceLatent`
chain, the whole batch into one node, an input on another batch index: the wording, the slots, a guess and no trim
where the trace is no identity; `normalize` dropping a bad `refs`). The `recipes` gate's step
`local_recipes_name_the_batch_pictures_and_trim_the_unused_slots` stubs `host.connected`, `objectInfo`,
`ensureOnServer` and `api.queuePrompt` (nothing is queued on a server; all four are put back) and runs both shipped
recipes through `host.queueGenerate`: no reference (the prompt unchanged, no `named_refs`, only the crop's input
left), a reference with the Original, the same on a refine pass, three references with a negative, Klein past its
slots (a named reference refused with nothing queued, an unnamed one left out with "not sent"), a hidden reference,
the Info panel's References row and the prompt field's context. `commands`' `refs_send` step 5 now checks a ComfyUI
recipe whose graph cannot be traced (the tokens named by batch position, "wording guessed from the graph" in the
status, `named_refs` and `hasSelection` in the state, the document's prompt unchanged) and a refusal past declared
`slots`; `prompt_field_test.js` section 8 adds the bar's count and the card's name for a traced local recipe. The
run: `node tools/comfyrefs_test.js`, then `bash tools/run_gates.sh <label> --offline --tiles on recipes upscale
nodecopy lint types` (`upscale` for the ComfyUI upscale path through `queueGenerate`, `nodecopy` for the shared
`serializeForPrompt` and Info panel edits). No `smoke`: it runs `flux2_klein_local` on the user's ComfyUI.

26f, Generate new with reference layers (`docs/RECIPES.md` "Generating without an image"): nothing of it has run
against a live API. Plain Node: `node tools/refs_layout_test.js` sections 6 to 9 are rewritten for text runs that send
references (every adapter exports `textLayout` beside `generate`, a text run with two references sends them and no
crop, the text markers resolve from 1, `checkPictures` refuses past the cap in the words for a new image), and its new
section 12 sends every shipped variant with `text.refs` through a fake fetch (the route, the picture order against
`textLayout`, no "Edit" sentence, the asked size or aspect, the reference sentence where the adapter writes one, 0
references byte for byte, one past the cap refused with no fetch); `node tools/recipes_test.js` gets a section
"text.refs" (every shipped variant against the expected route and cap, the list of those that take none, `true`,
`false` and a bad value); `node tools/reftokens_test.js` covers the text-run markers (`@img2` with 3 shown references
becomes `{@ref:1}`, a hidden or parked token refused). The adapter tests take new text-run cases, each with 0
references pinned to the old body: `toapis_test.js` section 2c (`textLayout`, the uploads and `image_urls` in order,
the size and tier, the per-channel caps, the ratio and 10 MB rules on references) and section 7 (a text run with two
references on every variant and channel, the text cap equal to the edit cap); `openrouter_test.js` section 3 (two
references in `input_references` with their sentence, one reference, `refName`, the cap, ratio and size refusals) and
section 10's sweep; `ark_test.js` sections 1, 4 and 6 (the same for `image`, eleven references on 5.0 pro refused and
ten sent, and `index.edit` with markers and `refsMax`); `comfyrouter_test.js` section 12 (every dialect, the drops of
xai / ideogram / krea and FLUX.1 Fill, Gemini's closest ratio for a free size, `text.refs` on exactly the variants
that take references) and text-run cases in sections 8 (`index.js`) and 10 (HY Image through the Partner API);
`magnific_test.js` section 4b (the FLUX.2 routes and the `-edit` routes, never `auto` for GPT Image, Seedream's 256 px
floor) and checks in sections 11 and 12; `oxen_test.js` section 8b (`/images/edit`, the fields, the Grok edit id
without an aspect, the name pattern, the count and size refusals) and section 9 (`index.layout` for the dialog), with
the schema sweep sending reference runs where `text.refs` is set.
Run: `bash tools/run_gates.sh <label> --offline --tiles on toapis openrouter ark comfyrouter oxen magnific recipes`.

The app: `tools/generate_test.py` gets eight steps, all against the loopback. `refs_in_an_empty_tab`
(`add_image_layer role:"reference"` in a new tab gives a white 1024 × 1024 base with one reference, `refContext`'s
`canAdd`, `role:"none"` still refused with "no image loaded"); `text_with_references` (two references and a paint
layer, `generate_new` at 16:9: `info.references` 2, `prompt_sent` "the jacket of image 2 on the person of image 1",
`references` with `sentAs`, `kept` 2 and `dropped` 1, the paint layer gone, the references' ids, order, pixel objects
and a sample unchanged and inside 1024 × 576, the tab's prompt unchanged, the status line's "@img2 → image 2" and
"The reference layers stay, 1 other layer was replaced", `_refDrift` 0); `hidden_reference_not_sent`
(`info.references` 1, the hidden reference kept hidden); `refuses` (`text.refs.max: 1` with two references gives
"takes at most 1 reference picture for a new image; this run has 2: hide reference layers", a token on a text shape
without `refs` gives "makes new images from the prompt alone", neither changes the tab; without a token that shape
runs, sends none and keeps both); `local_keeps_refs` (`newCanvas("512x512", {keepRefs: true})` keeps and places the
references; the live ComfyUI run is left out, 8188 is a production machine); `dialog_field_and_bar` (a fake recipe in
the dialog's list: `#gen-prompt` is the prompt field and keeps the tokens, two chips, `sentAs` "image 1" / "image 2",
two bar chips, a text shape without `refs` shows "sends no reference images"); `dialog_escape_closes_the_picker_first`,
a Python step with real keys (`run_all` now takes callable steps beside JS strings): a typed @ opens the picker, the
first Escape closes only the picker, the second the dialog; and `dialog_upsample_refs` (`host.upsampleBackends` and
`host.askLLM` stubbed, the pictures switched off: the instruction names both references and carries the token rule,
an answer that drops `@img2` gives "dropped @img2" in the note, Revert puts the old text back). `commands`'
`refs_names` now expects the Generate new prefill to keep the tokens. The run: `bash tools/run_gates.sh <label>
--offline --tiles on generate commands lint types nodecopy`, then `generate` again with `--tiles off` (the reference
layers now live across a base swap).

0.1.42 U2, the whole picture on a ComfyUI upscaler (`docs/PLAN_0_1_42.md` U2): `node tools/comfyprompt_test.js` (plain
Node, run by the `upscale` gate's node step; stdout alone is judged, stderr carries Node's ES module note) tests
`renderer/editor/comfyprompt.js` on both shipped local upscalers, raw and normalized. The `upscale` gate's
`a_comfy_upscaler_upscales_the_whole_picture` stubs the queue, the ensure, `/queue`, `/history` and the job cancel in
the page and answers with a mirror file (nothing reaches a server); the `document` gate's
`a_comfy_whole_picture_upscale_round_trips` saves and opens the upscaled document. `upscaleperf:<W>x<H>`
(`tools/upscale_perf.py`) is the 15k measurement of the landing against the runner's app: it writes the answer into
the run's profile, so it runs alone on a fresh instance per backend. The run: `bash tools/run_gates.sh <label>
--offline --tiles on upscale document`, the same with `--tiles off`.

0.1.49, Comfy Cloud and Comfy Router on Comfy's SDK (`docs/PLAN_COMFY_SDK.md`, `docs/RECIPES.md` "How a Comfy Cloud run
goes" and "Comfy Router"). None of these tests reaches Comfy: the keys are made up, and a fake answers every request.
Plain Node, from the repository's root:
- **The network guard.** `tools/nonet.js` is a preload: `node -r ./tools/nonet.js tools/<name>_test.js`. It replaces
  the global `fetch` with one that refuses every request and prints `NONET-FIRED <url>` on stderr, and refuses a socket
  to anything but loopback with `NONET-SOCKET <host>` (a loopback socket, a test's own mock, passes with
  `NONET-LOOPBACK <host>:<port>`). A test that passes with no `NONET-FIRED` or `NONET-SOCKET` line made no connection
  outside this machine; a test that swaps `globalThis.fetch` for its own fake replaces the guard's for that run, so the
  socket check is what still catches a stray connection there. Run every provider test under it after a change to
  `comfysdk.js`, `comfycloud.js` or `comfyrouter.js`. `comfysdk_test.js`, `comfycloud_v2_test.js`,
  `cloudjobs_test.js`, `progress_test.js` and `comfyrouter_test.js` passed under it on 2026-10-18 with no such line.
- `node tools/comfysdk_test.js` (20 checks) pins `electron/main/providers/comfysdk.js`, the one import point of
  `@comfyorg/sdk`, on a scripted fetch: `version()` reads 0.5.0 without loading the SDK; `clearEnv()` drops
  `COMFY_BASE_URL`, `COMFY_API_KEY`, `COMFY_ROUTER_BASE_URL`; a Cloud request goes to
  `https://cloud.comfy.org/api/v2/...` with the key as a bearer and `scumble/` in the User-Agent; a test base takes
  only a `test-` key and gets every request, a real key never; a `COMFY_BASE_URL` left in the environment cannot send
  the key elsewhere; the Router goes to `https://api.comfy.org` (or the mock) whatever `COMFY_ROUTER_BASE_URL` says; a
  cancel still leaves after the run's own signal fired.
- `node tools/comfycloud_v2_test.js` (62 checks) runs `comfycloud.js` `runV2` against `tools/fake_comfy_v2.js`, a fake
  Comfy API v2 as a fetch function (assets by hash, `from-hash` and multipart; jobs with scripted statuses and submit
  answers, a reused idempotency key refused 422; outputs, contents behind a 302 it follows itself, dropping
  `Authorization` across origins as fetch does; cancel answers; the v1 node list; every call recorded with its auth).
  It checks the pictures as `core/ASSET` references (partner nodes and a recipe graph's titled LoadImage nodes), no
  second upload for bytes Comfy holds, one submit with `Idempotency-Key` and the key in `extra_data`, no metadata, the
  lost-answer rule (a submit with no answer once more under the same key, a 422 reuse then stops, never a third), the
  own SaveImage before a preview, the failure words, the status re-reads and the 429 back-off, the stop on a timeout or
  an unread status, the download retries, the advisory node list, the test base, and that a context without `cloudApi`
  stays legacy. Since S2: live frames to `ctx.progress` and `info.events`; Cancel during the wait asks Comfy to stop the
  job (a refused stop and a stop answered `succeeded` worded right); a dropped event stream joined again; through
  `index.edit` the v2 default, frames with the run id and the three Cancel wordings. A mutation round of six (S1: no
  429 back-off, no download retry, the upload retry on the same handle, the cancel's answer ignored, no cancel on an
  unread status, the miss count never reset) turned it red each time.
- `node tools/cloudjobs_test.js` (21 checks), also on the fake v2: the notes file (`cloudjobs.js`: add, replace, remove,
  empty, written whole), a run's note while it waits and after each end, the recovery's verdicts (succeeded brings its
  picture, its own SaveImage first; running and unanswered stay; failed, expired and 404 go; older than a day goes
  unread; no key asks nothing; nothing is submitted again), a run that starts during a recovery, `only`, and the path
  through `providers/index.js` with the ack.
- `node tools/progress_test.js` (41 checks, run by the `log` gate) gained the `fraction` cases of Comfy Cloud's measured
  frames (`value`, `nodes_done`, `nodes_total` only): "node 1/1" busy, 11 of 12 whole filled to the running node's part
  and not 92 %, all whole busy, `idle(keep)` keeping a provider's run while a local queue goes empty, and a local
  Generate beside a provider's run in one tab in both orders.
- The Router tests no longer drive `comfyrouter.js` through `ctx.fetch` (the SDK's Router code calls the global fetch):
  `tools/comfyrouter_test.js` (151 checks), `ideogram45_test.js`, `nanobanana21_test.js` and `refs_layout_test.js` swap
  `globalThis.fetch` for each run's fake and put it back in `finally`. `comfyrouter_test.js` installs a global fetch at
  load that refuses and records anything no fake answers and checks at the end that it recorded nothing; it asserts the
  bearer, resends under one key, the re-reads, the timeout's cancel, the five Cancel wordings, a slow submit and QW6's
  notes. `tools/comfyrouter_mock.py` (the `comfyrouter` gate's mock) takes the bearer on the Router's routes and
  `X-API-Key` on the Partner API's, and `tools/comfyrouter_test.py` checks each header where it belongs.
- The legacy Comfy Cloud path keeps its tests: `cloudgraph_test.js`, `upscale_test.js` and `nanobanana21_test.js` call
  the adapter without `cloudApi`, which is the legacy path.

In the app: the gate `cloudjobs` (`tools/cloudjobs_test.py`; its own instances on port 9576 with profiles of their own
and `--no-comfy`, against a loopback mock of the v2 job routes, nothing but loopback reached): a test key and the mock as
`settings.comfycloud.base`, notes written into `cloudjobs.json` as a crash leaves them; at the start the finished job's
picture opens as a document of its own in the background and the document in front names it and the job still
running, the old note goes unread, the ack, a later ask reads every note again (the jobs in flight and the pictures
handed to the page and not acked yet left out) and brings a job that finished later, a reload gets the pictures its
page never acked, a second start that shows a headless window asks then, the counts' lines (running, not answered,
not downloaded yet) word for word as `renderer/shell.js` writes them, and a profile without a key asks nothing. The `generate` gate's step
`a_cloud_runs_bar_follows_its_live_frames` runs a loopback provider run through IPC whose frames have Comfy Cloud's
shape: the label, node 1/12 busy, node 12/12 at 25 %, the bar kept through a local queue going empty, a status with jobs
left and a lost socket, gone with the run; its step `generate_is_never_passed` checks QW5's line ("<model> via
<route>, N s") in the status and the history and never in the document's state. The `editor` gate's step
`reference_rows_reorder_by_drag` (QW7): three references, the bottom row dropped on the top row's upper half, the
labels renumbered and "@img3 in front of @img1" become "@img1 in front of @img2", one undo, a self-drop refused, and
a reference row and a layer row dropped on the prompt field writing nothing. The relight gate's case p and
`tools/assistant_test.js` cover QW4's `preset`. Run: `bash tools/run_gates.sh <label> --offline --tiles on cloudjobs
generate editor log lint types`.

## Known flakes

Known flakes; **re-run before believing any of these**:

- 2026-11-06 (`corridorkey`, LR2, tiles, the third gate of one instance after `loras` and `skins`): `editor_test.py`
  `a_new_mask_and_a_neighbours_write_reach_the_screen` failed at zoom 0.2 ("a fill whose box ends on a tile border",
  shifts 0-2: 10 and 235 levels on about 2,500-2,900 bytes, "a slot kept a neighbour's old edge line"; zoom 0.75 and
  the undo cases exact). The editor gate alone on a fresh instance (`lr2-b`) and the same three gates in the same order
  again (`lr2-c`) passed, so the order is ruled out. Another session's 15k measurement ran on the machine around the
  first run (its `native_test.py` before it, its busy lock after it). Not looked into further.
- 2026-11-06 (K12's last lint run): the `lint` gate runs `npx eslint .`, which also reads the other agents' worktrees
  under `.claude/worktrees/` (their untracked files too): a new script there with a top-level `return`
  (`corridorkey/docs/measurements/ck_i0a_2026-11-06/scripts/s0_setup.js`) made it red with nothing changed in this
  tree. `npx eslint . --ignore-pattern ".claude/**"` gives this tree's own result (0 errors, K12's
  `gates/gates/k12-lint-final/lint_own_tree.log`).
- 2026-11-06 (W1's gates, tiles): the `layered` gate's `the_pool_and_the_window_read_a_psd_alike` failed once in its
  "a closed tab" case: its shape check stringifies `ed.base`, whose pixels carry cache fields, and `_regions` was `null`
  before and `{}` after (a cache made between the two reads), so the shape differed with nothing landed
  (`stopped` 1, `lost` 0). The rerun on a fresh instance passed, as did the same step on the same build earlier the
  same day and on the canvas backend. Ruled out: W1's PNG writer (the step reads a PSD and lands nothing).
- 2026-10-19 (0.1.49's exe gates, tiles): the `brush` gate ran out of its 420 s after its reader part had printed
  `RESULT PASS` (the in-app part never answered); the rerun on a fresh instance passed in 16 s, and the canvas list's
  `brush` passed in the same build. The machine was loaded (a video render of another session ran beside the gates).
- 2026-10-13 (0.1.48 S5): with the machine loaded (the `commands` gate took 44 s instead of 15, `upscale` 20 instead
  of 12) the editor gate timed out after 421 s at its 55th step and the `log` gate's `status_kinds` found the blink
  still running after 3.4 s; the rerun minutes later passed both (169 s). `status_kinds` now waits up to 8 s for the
  blink to end.
- `generate_test.py` `cancel_and_a_closed_tab_add_nothing` on the canvas backend against the exe ("the deadline's
  take-off": the stub's delete and interrupt both arrived, the step's deadline came first; 2026-10-09, 0.1.44's exe
  gates, the step passed on the re-run at once). A timing of the cancel against the stub's queue, not the cancel:
  nothing else in the gate or the log failed.
- (Fixed 2026-09-27: `editor_test.py` `pixel_backend_is_the_one_the_flag_chose` on the canvas backend, "the display
  took toCanvas() copies". Not the display: the tab the live stroke step closes flushes its 10000 x 5000 layers, and
  `rememberClosed`'s `saveAll` then encodes every open tab, this step's selection with `toCanvas()` among them, while
  the step counted every copy of the prototypes; with the heal and smudge rows of 0.1.32 it landed there every run.
  The step counts the copies its draws take now, and names their callers.)
- `comfyview_test.py` "Ctrl+S reaches the page, not Scumble's menu" fails with "the control failed" (2026-10-03, twice):
  its control key into the editor's page reaches no menu while another window has the focus, as when the user works in
  a test instance of their own beside the gate (run it on another port, `SCUMBLE_CDP_PORT=9556`). Ruled out: the
  ComfyUI window's guards (the step passed in the same session with the user away). Again on 2026-10-04 (R1 of
  0.1.42): four of six runs, the user's own Scumble open with this session's MCP server attached; port 9556 did not
  help, and the unchanged HEAD (3d89bd3, a worktree on port 9571) failed the same way, so R1 is ruled out.
  Again on 2026-10-12 (F4 of `docs/PLAN_RELIGHT_FIXES.md`): three runs of three, alone on fresh instances (ports 9581 and
  9583), the user's Scumble open with this session's MCP server attached (`--mcp --attach-only`); 2f9aa60 in a worktree
  (port 9584) failed the same control, so F4 is ruled out. The other 24 steps passed each time.
- `commands_test.py` hangs after every step has printed `[ok]` (the runner's 420 s timeout, sometimes in
  `Page.captureScreenshot`).
- `editor_test.py` `closed_tabs_are_collected` fails with the last tabs still alive, or against an instance with 50+ tabs
  from repeated runs.
- The live stroke steps (`live_stroke_reaches_the_screen_before_the_release`, `live_stroke_preview_shows_what_the_commit_writes`)
  fail when a real mouse is over the test window (they drive synthetic pointer events), or right after a diagnostic
  instance was closed. 2026-09-28: `live_stroke_reaches_the_screen_before_the_release` failed once in a full editor run
  on the canvas backend (28 frames against 200: the window not in front) and passed alone at once.
- The marching ants (120 ms) break a screen comparison now and then; steps that compare the screen draw the selection as a
  tint.
- `composite_test.py` once got a 1200 × 794 canvas against its 1200 × 800 reference and then crashed with `KeyError 'bytes'`
  in its own failure message (a test bug, not fixed).
- `node tools/brush_test.js` hung once at exit under load after printing every PASS.
- `editor_test.py` `closed_tabs_are_collected` failed twice in five runs of the editor gate alone on the canvas backend
  (`--tiles off`, 2026-09-17, B item 2) and passed on the rerun each time; the code under it had not changed.
- The `relight` gate on the 0.1.50 exe (tiles, 2026-10-22) passed all its checks (39 node, 293 in-app) and then waited
  out its 900 s in the closing screenshots: a hidden or occluded window gives CDP no frame to capture. The shots now get
  30 s each and are only a warning (`relight_test.py`); the rerun took 30 s. The canvas run of the same exe passed.
- `editor_test.py` `selection_keeps_its_bounds_through_a_restore_above_1mp` failed once with no message on the canvas
  backend (2026-09-23, after `help` and `assistant` in the same instance) and passed on the rerun in the same order.
- `editor_test.py` `a_settled_read_builds_its_levels_in_the_worker_not_here` failed once with `requested: 0` in some twenty
  runs since the mip chains go through the pool; not reproduced.
- The first exe instance of the 0.1.18 gates failed `a_settled_read_builds_its_levels_in_the_worker_not_here`
  (`requested: 0`, 11 s into the editor gate) and `composite_test.py`'s view (a 1200 × 794 canvas) in the same run; both
  passed on a fresh instance. Two known flakes at once, in the first seconds of an instance: not looked into.
- `perf_test.py`'s magic wand row (whole-image band) read 2.1, 4.0 and 7.0 s in three runs of the same code while ComfyUI
  ran a job; an A/B against the commit before in the same minute read 3.5 s. It is the card, not the code.
- The `commands` primed-cells checks wait up to 3 s for the film panel's own settled flatten; a failure "primed cells were
  left behind" seen once without a mutation was that race.
- The editor gate run alone on tiles takes about 370 s (120 s inside a full run). On 2026-09-18 (the split, stage 1)
  four runs alone failed at four different timing-bound steps (the live stroke with the pointer message,
  `closed_tabs_are_collected` twice with the last two tabs alive, `helper_inputs_read_levels_and_upload_nothing` with
  one upload counted), while the unchanged tree passed once and `closed_tabs_are_collected` alone passed 3 of 3 on
  both trees; not looked into further.
- 2026-10-07 (0.1.43): the editor gate on tiles failed `a_settled_read_builds_its_levels_in_the_worker_not_here`
  (`requested: 0`) in every run of the evening, dev tree and exe alike, and with it excluded
  `a_whole_change_builds_its_mips_in_the_worker_and_the_screen_ends_exact` (the settled screen 13 levels off on 859
  bytes); **both fail the same way at c660749, the morning's commit**, in a worktree, and both passed in 0.1.42's exe
  gates two days before. DaVinci Resolve was rendering a video on the machine the whole evening (the user), which takes
  the worker's and the card's time: the likely cause. Not looked into further; the release ran the
  editor gate with `SCUMBLE_EDITOR_ONLY` set to every other step (113 PASS). `the_navigator_watches_the_chains_it_asks_for`
  failed once in that sequence and passed in the next two runs and alone.
  The same evening the exe's `comfyview` gate failed "Ctrl+S reaches the page" twice on its control ("Ctrl+Shift+L in
  the editor's window reached no menu"), the occluded-window key trap of CLAUDE.md; it passed at once on a fresh instance
  both times.
  On 2026-10-14 (`rel48-exe`, the 0.1.48 exe on tiles, the 35th gate of one instance) the instance went away in
  `comfyview`'s "V2: a load that throws, a page without window.app, no target" (the DevTools socket closed, then 9555
  refused), and every gate after it failed in seconds on the refused port; nothing in `app.log`. `comfyview` and the 14
  gates after it on a fresh instance (`rel48-exe-b`): all PASS but the control step above (24 of 25). The release had
  touched `comfy.js` only in the websocket's close handler (a replaced socket's late close says nothing); not looked
  into further.
- The 0.1.34 exe gates on tiles (2026-09-29, one full run of 31 gates) failed two steps once, and both passed at once
  when `export film` ran again on a fresh instance: `export_test.py` `a_run_reads_its_box_and_a_window_of_the_selection`
  ("the run's patch differs between the window and the whole selection", one byte, one level; `stitch.js`'s
  `finishResult` was not touched since 0.1.33, only the reference reads) and `film_test` `panel_thumbnails` ("0 of 5
  rendered" 4 s into the gate; `plugins/` unchanged since 0.1.33). Neither had failed in an earlier recorded run; not
  looked into further. The 0.1.39 exe gates on tiles (2026-10-03, `rel39-exe`, 34 gates) failed
  `a_run_reads_its_box_and_a_window_of_the_selection` once more the same way (one byte, one level, at [1003, 341, 2])
  and it passed at once on a fresh instance (`rel39-exe-rerun`); the release touched only provider adapters and
  recipes, nothing under that step. Twice in the exe gates on tiles, never on canvas or a dev instance so far.
