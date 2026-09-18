# CLAUDE.md — Scumble (desktop app)

Read this first, then `docs/BRIEF.md` (vision, decisions, architecture, phases).
`docs/BUGS.md` is the bug list: what is reported and not fixed, and what has to be
measured before anyone writes code. Put a new report there, not in this file.
`docs/NAMES.md` holds the name research, `docs/RUNPOD.md` the Docker template notes.

**Name: Scumble** (decided 2026-09-07). A scumble is a thin, semi-opaque layer of paint
brushed over a dry layer so the one below shows through; that is what an inpaint result
over the image is. Pronounced "skum-bl". Domains `scumble.app` and `scumble.de` were free
on 2026-09-07 (`scumble.com` is taken); the user registers them and checks trademarks
(DPMA, EUIPO, USPTO, classes 9 and 42) before the first public mention. Use the name in
the app, the installer (`Scumble Setup.exe`), the MCP server name (`scumble`) and the
repo; the ComfyUI node keeps its name Inpaint Canvas.

## Who and what

Built for and with DenRakEiw (GitHub DenRakEiw, German-speaking, answers in German).
A standalone desktop editor for AI inpainting: layers, selection by text,
retouch, filter layers, colour match per layer, text, PSD/ORA export. Local rendering
through the user's own ComfyUI, API rendering through fal.ai and direct providers,
SAM/RMBG in-app via ONNX. MCP-capable from the start. Windows first, Linux second.

The editor code came from the ComfyUI custom node **Inpaint Canvas**
(`F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI\custom_nodes\ComfyUI-InpaintCanvas`,
GitHub `DenRakEiw/ComfyUI-InpaintCanvas`, GPL-3.0). **Since C0 (2026-09-13) `renderer/editor/`
in this repo is the source of the editor** and the node's `js/` is a build of it
(`python tools/build_node.py`, `docs/BUILD_NODE.md`); the node keeps its own `js/host.js`,
`js/inpaint_node.js` and `js/inpaint_bridge.js`. That repo stays the backend node and keeps
living. Read its `CLAUDE.md`, `DEVELOPMENT.md` (§1–23) and `GUIDE.md` before touching editor
code.

## Decisions already made (do not reopen without the user)

- Shell: **Electron** (identical Chromium on Windows and Linux; `ctx.filter` and canvas
  performance; Node process for `sharp` exports and the in-app MCP server).
- Local rendering: **the user's ComfyUI**, local or remote (RunPod). The app never
  bundles Python/Torch. The node pack must be installed there; the app checks
  `/object_info` and offers to install it via the Manager.
- API rendering: **fal.ai** as the aggregator, plus direct adapters (Black Forest Labs
  Flux.2, OpenAI gpt-image, Google Gemini image) and the ComfyUI API nodes as fallback.
  Keys in the OS credential store via Electron `safeStorage`, never in config files.
  Prompt upsampling runs on the same keys, or on a local OpenAI-compatible server
  (Ollama / LM Studio / vLLM, `settings.llm.compat`, no key needed).
- Helper models: **SAM2 and RMBG-2.0 in-app via ONNX Runtime** (DirectML on Windows,
  CUDA/CPU on Linux); model files downloaded into the app data folder **or** read from a
  linked ComfyUI `models/` folder. SAM3 stays a ComfyUI helper (no ONNX export).
- Recipes instead of graphs: the user picks "Flux.2 Klein local", "SDXL inpaint",
  "Flux.2 via fal" etc.; a recipe is a workflow template with a fixed Inpaint Canvas
  node id that the app fills and queues. Users can import their own workflow as a
  recipe if it holds an Inpaint Canvas node.
- MCP: the bridge commands from the node (`js/inpaint_bridge.js`, 46 tools) become the
  app's command core; `app.exe --mcp` runs the stdio MCP server in-process (TypeScript
  SDK); headless = the app without a window.
- Filters move to **WebGL2** (grain, curves, colour balance, LUT as shaders), CPU path as
  fallback; the same code goes back into the node.
- Film names: **keep the real names in the grain presets and the film pack**, own
  parametric values only (no manufacturer LUTs), disclaimer in the preset tooltip and
  the About dialog, never in product name or marketing; lawyer check before a sale.
- Plugins: **JavaScript plugins on the command core** (plugin folders with
  `plugin.json`, filter / panel / action / tool extension points), the film pack is the
  first built-in plugin; Python plugins later, not now. Plan in `docs/BRIEF.md` §5.
- Licence: **GPL-3.0** (decided 2026-09-09; `LICENSE`, `package.json`, About, README).
  The same licence as the node, no CLA, no dual licensing (that is also what the free
  SignPath Foundation signing requires). Only MIT/Apache/BSD/OFL dependencies in the app.
- Release channel: **GitHub Releases** of `DenRakEiw/scumble` (public since 2026-09-09).
  `electron-updater` reads `latest.yml` there; `.github/workflows/build.yml` builds the
  installer on `windows-latest` and publishes a **draft** release on a `v<version>` tag
  (the tag must match `package.json`); publishing the draft makes it visible to the app.
  **Every release needs its section in `CHANGELOG.md` first**: the workflow builds the
  release body from it through `tools/release_notes.py` and fails the tag build when the
  section is missing, and the app shows the same text in Settings › Updates before you
  restart into the new version.
  First releases are **unsigned**; code signing goes through the SignPath Foundation
  (free for OSS) once the project has a public release and some use, fallback Certum
  Open Source. Azure Trusted Signing is paid and not for individuals in the EU.

The session hand-over blocks that used to live here ("Where things stand / stood", 2026-09-09 to
2026-09-16) are in `docs/HISTORY.md`, newest first, verbatim. They are a record, not instructions.

## Where things stand (2026-09-18)

**Releases.** **0.1.19 is tagged** (`v0.1.19`, 2026-09-18, on the user's go, no `smoke`: CI builds the installer and
publishes a **draft**; the user publishes it to make it visible to the app; exe gates, all `--offline` against `dist/win-unpacked/Scumble.exe`: `rel19-exe` (tiles, the full list with pxjobs) ALL
PASS, `rel19-exe-huge` (`huge:30000x20000`) PASS, `rel19-exe-canvas` (tiles off: pixels editor composite film export)
ALL PASS on the rerun `rel19-exe-canvas-b` of editor and film, whose first run failed on the live stroke's pointer
message and the film panel's thumbnails (0 of 5 rendered) while the user was at the machine; no `smoke`, on the user's
word). **0.1.18 is published** (Latest since 2026-09-18, published by the user's word at the end of the part 3
session; `latest.yml` on the feed says 0.1.18, the release body is the CHANGELOG section). **`package.json` is 0.1.19
and `CHANGELOG.md` has the 0.1.19 section**, with B item 7 part 3 (item 10 below; committed, pushed, CI green on
2026-09-18) and the `set_layer match_source` fix. 0.1.18 carries B items 1 to 5 and item 7 parts 1 and 2. Exe gates for 0.1.18, all `--offline`: `rel18-exe` (log pixels editor
composite brush film export toapis mcp pxjobs), `rel18-exe-canvas` (tiles off: pixels editor composite film export) and
`rel18-exe-huge` (`huge:30000x20000`) ALL PASS, three of them on a rerun, each a known flake (the settled-read step and
the 1200 x 794 composite canvas together in the first seconds of one exe instance; the live stroke step on the canvas
backend). **`smoke` was not run** (the user's ComfyUI). **0.1.17** (published 2026-09-17) carries phase E
(E1 to E5). Exe gates for 0.1.17, all `--offline`:
`rel17-exe` (log pixels editor composite brush film export toapis mcp pxjobs), `rel17-exe-huge` (`huge:30000x20000`) and
`rel17-exe-canvas` (tiles off: pixels editor composite film export) ALL PASS; CI's `build_px.py --check` passed with the
crate's new dependency (miniz_oxide). **`smoke` was not run** (the user's ComfyUI was busy); instead Pillow 12.2 from the
ComfyUI's own Python read a PNG joined from parts (pixels exact, tEXt intact, `verify()` ok). Check `gh release list`
before believing any release state written down anywhere.

**Phase E is built** (2026-09-17, `docs/PLAN_BCE.md` §3 "E1 as built" and "E2 to E5 as built", CHANGELOG 0.1.17).
What it is, because it is **not the plan's design**: there is no second compositor in the workers. A band of an export is a
**region pass at full resolution** (`sampleRegion` at scale 1 with `boxReach`'s margin, `readBand`), and the worker pool
(`renderer/editor/inpaint_pool.js`, up to 8 workers started on demand, priorities, `cancel(group)`, `progress` replies) does
everything that is not compositing: PNG parts (a Rust deflate with a sync flush per part, joined into one zlib stream:
`inpaint_png.js`), PackBits for PSD, CRCs for ORA, hashes, PNG decoding as a stream, the mip chains. Tiles live in a
SharedArrayBuffer arena (`inpaint_arena.js`) and workers read them by (chunk, slot). `inpaint_bands.js` holds the row sources
and the PNG / PSD / ORA writers. Filters of the whole picture take `info.full` / `info.origin` / `info.stats`. A document
may be larger than any canvas (268 MP): up to 65,535 px a side and a gigapixel, PNG only, opened through the stream reader;
`tools/huge_test.py` is its gate (30000 × 20000: open 9.6 s, PNG 10.5 s, PSD 13.7 s). **Not met and written down in
`docs/BUGS.md`**: an export in bands is slower in wall time than the whole flatten was (6.2 s against 3.4 s at 15k, the
window stays usable), the halation on huge documents, invert at 30k, the 5 ms of the mip refresh. **`smoke` has not run on
any of it** (the user's ComfyUI was busy): the node's base upload in bands and a real run on the new crop path have not met
a real server.

**Built.** C6 (c) slices 3 to 7a, each with its gates, mutations and measurements in `docs/PLAN_BCE.md` §C6 ("C6 (c3) and
slice 4 as built", "slice 5 / 6 / 7a as built"). The tile engine is on by default in the installed app since 0.1.13, with a
switch in Settings › Rendering; the canvas backend is the escape hatch.

**Constraints right now.**
- **The user needs their ComfyUI instance** (2026-09-16): no `smoke`, and no gate that forwards to it (`commands`'
  `large_upload_route` uploads through the mirror to a connected ComfyUI), until the user says it is free.
- **A headless MCP instance can block the app from starting** (`docs/BUGS.md`): this repo's `.mcp.json` starts the dev app
  with `--mcp`, which holds the default profile's single-instance lock, and Scumble then shows no window. Stopping the
  `electron.exe ... --mcp` processes fixes it; the missing hand-over is not measured.
- **§C7's memory gate is not met** (at most 300 MB of GPU process per document); the default went on anyway, on the user's
  decision.
- **The node repo is behind** (master 647db5d, before C3, plus one local, unpushed commit 1f37ad0: `exportIsPlain` in the
  node's own `js/host.js`, which the editor asks for since E2 and `build_node.py --check` insists on). `nodecopy` builds and tests it in a scratch copy; build it into
  the real repo only when a node version is meant to ship.

**What comes next, in order** (`dist/c6map/c/` holds the maps; they are older than the code):
1. **7b is built** (2026-09-16, `docs/PLAN_BCE.md` §C6 "C6 (c) slice 7b as built", CHANGELOG 0.1.16): a matched layer on
   tiles is matched in the part a pass shows from its tiles; 1144 MB of mirrors and 837 ms of first frame at 1:1 gone at 15k.
2. **7c is built** (2026-09-16, `docs/PLAN_BCE.md` §C6 "C6 (c) slice 7c as built"): one statistics entry per layer for every
   pass, provisional while chains are in the worker. **The (b) numbers are measured and not yet shown to the user**
   (same section): box means 0.81 levels mean over 32 cases, 5.45 / p99 12 on one textured photo; point samples 0.56, max 8.
3. **7d is built** (2026-09-16, `docs/PLAN_BCE.md` §C6 "C6 (c) slice 7d as built"): the match in the atlas shader.
4. **C6 (d) is built** (2026-09-16, `docs/PLAN_BCE.md` §C6 "C6 (d) as built"): the base is `{ ref, px }`, no <img>.
5. **The object tool's bigger change A** (`dist/c6map/c/objects.md` §7 to §9: the image-size label map, the per-object
   shape canvases): ask the user where it goes.
6. **C4 is built** (2026-09-16, `docs/PLAN_BCE.md` §C4 "C4 as built"): steps on whole tiles, `release()`, exact redo boxes.
7. **The rest of §C7 went as far as it could** (2026-09-16, `docs/PLAN_BCE.md` §C7 "The rest of §C7, as far as it went"):
   docs, `--disable-gpu`, the memory walk (not met: +0.6 to +1.4 GB of GPU process per open 15k document on tiles), the exe
   gates (PASS). **Open, needing the user's ComfyUI:** the node in a real ComfyUI tab and in Firefox, `smoke`, `commands`.
   **Open, needing E5:** the 30k gate. **Next, when the user says so:** a release (0.1.16 has its CHANGELOG section).
8. **Phase R is built** (2026-09-17, `docs/PLAN_BCE.md` §2b "Phase R as built", `docs/PERFORMANCE.md` §12 and §12.1):
   **the user's rule is Rust wherever it is faster, however little** (the 3× rule is gone). Every pixel kernel runs from
   `renderer/editor/px/px.wasm` through `px/kernels.js` in the window and both workers, grow / shrink and the flood as one
   whole-job call each; the JS twins are the fallback (`InpaintEditor.kernels = "js"`). `python tools/build_px.py` rebuilds
   the binaries (commit them; `build.yml` checks them), `node tools/px_test.js` and `python tools/px_jobs.py --check` are the
   gates.
9. **Phase E is built** (2026-09-17, see above). Its open ends are in `docs/BUGS.md` ("What phase E left open").
10. **Phase N is measured and decided** (2026-09-17, `docs/PLAN_BCE.md` §3b "N1 as measured, N2 costed, N3's
   recommendation", `docs/PERFORMANCE.md` §14; `tools/native_test.py` and `tools/native_limits.py` are the tools, run on a
   fresh `--no-comfy` instance). At 15k the browser's share of the wall is a half to 85 % on five rows (open, grow /
   shrink, the wand, PNG and PSD export) and nothing on pan, zoom and stroke frames; all of it is the editor moving tiles
   through canvases, which workers over the arena can do without (option B, about 3 weeks, six items in order). Typed
   arrays end at **15.5 GB** in the renderer (18 full 15k layers), not 8. **The user's decision (2026-09-17): stay on
   Electron and build B; no native tile store, no native editor. The user works up to about 15k**, so B's item 6
   (one-channel masks) goes last and 30k is not the size to tune for. **B item 4 is built** (2026-09-17, same
   section, "B item 4 as built"): `dilateMask` / `boxBlurs` as kernels (ABI 7, `crates/px/src/maskf.rs`), a provider run's
   crop 2.5 s to 0.57 s with the same floats; `node tools/stitch_test.js` is its gate beside `px_test.js`. **B item 1 is built** (2026-09-17, "B item 1 as
   built"): a plain stack (no filter layer, blend mode or colour match) is composited by the pool's workers from the
   arena while they pack it (`stackPlan` / `stackSource` next to `boxReach`, `stackRows` in `inpaint_bands.js`,
   `rowsOfStack` in the worker); 15k PNG 3.5 s to 1.7 s, PSD 3.9 s to 1.3 s, within two levels of the flatten
   (`export_test.py`). `InpaintEditor.stacks = false` forces the bands. **B item 2 is built** ("B item 2 as built"): the
   wand and the bucket on a plain stack flood a `SharedArrayBuffer` the pool composited from the tiles (`floodStack`,
   `floodOverTiles`, worker `stack_into` and `flood` with `sab`), and the wand's answer comes back as selection tiles
   (`applyTilesToSelection`); 15k wand 4.2 s to 1.4 s, the block 1.6 s to 0.18 s, the same selection bytes
   (`editor_test.py` `the_flood_over_tiles_is_the_flood_over_canvases`). **B item 3 is built** ("B item 3 as built"): grow,
   shrink and feather read the selection's box from its tiles in a pool worker and send back the tiles that changed
   (`selectionOverTiles`); 15k grow 0.72 s to 0.51 s, shrink 0.60 s to 0.32 s, the blocks 0.2 s to 0.09 / 0.02 s; grow
   and shrink the same bytes, feather within 5 levels of alpha (the GPU blur). Invert stays on the main thread (0.2 s).
   **B item 5 is built** ("B item 5 as built"): `png_unfilter_rows` (ABI 8) undoes a band of PNG row filters in one
   call, and every plain 8-bit PNG of 32 MP and more (no `iCCP` / `gAMA` / `cHRM`) opens through the stream reader
   (`InpaintEditor.pngStreamFrom`); 15k open 3.2 s to 2.7 s, the block 2.1 s to 0.12 s. The reader is bound by the
   browser's inflater, not by JS as N1 said. **Item 6 (one-channel masks) is set aside by the user
   (2026-09-17): it is the 30k item, the user works up to 15k. Next instead, agreed the same day: B item 7, the worker
   path for the stacks it turns away today, in this order: blend modes in `composite_tile`, filter layers over
   worker-composited bands, a colour-matched layer** (`docs/PLAN_BCE.md` §3b "B item 7"). **Parts 1 and 2 are built**
   (2026-09-18, the night before the release, on the user's standing instruction to build up to 0.1.18 without asking
   again; same section, "B item 7, part 1 / part 2 as built"). Part 1: the eight blend modes in `composite_tile` (ABI 9),
   **rounded once per channel** (exact 16-bit products; within half a level of the exact value, where three rounded
   products were 1.45 off and moved the wand's edge): 15k with a multiply layer PNG 3.4 s to 1.6 s, PSD 3.8 s to 1.1 s,
   the wand 3.9 s to 1.1 s with the same pixels selected. Part 2: **a stack with filter layers anywhere in it is a
   program** (`stackPlan({ filters: true })`, `holdStack`, `programStart` / `programFinish`, `bandSource`): the pool
   composites a band with the filters' reach into a `SharedArrayBuffer`, the bytes go to the GPU as a texture
   (`surfaceFromBytes`), the filters run as in a pass at full resolution, the rows come back once (`readSurfaceBytes`),
   layers above a filter and a filter at an opacity, in a blend mode or through a mask are composited over the result by
   the pool again (a stack layer may be bytes, `sab`); the next band is composited while this one is filtered. Three
   paint layers and a levels layer at 15k: 6.2 s to 1.4 s; with the film look 9.1 s to 5.0 s (block 1.2 s to 0.13 s); the
   wand on a filtered document 3.3 s to 1.5 s. The region pass is the fallback (`NO_PROGRAM`) and keeps its own gate
   (`InpaintEditor.stackFilters = false`, `stackBlends = false` are the A/B switches). Against the flatten: one level on
   1.1 % of the bytes below a filter, a filter never more than one level above what the pass shows. **Part 3 is built**
   (2026-09-18, after the 0.1.18 tag, for 0.1.19; same section, "B item 7, part 3 as built"): a colour-matched layer
   is an entry of `stackPlan` (`match: layer`); `holdStack` is async and takes its statistics from **point samples of
   the tiles** (`stackMatches` / `stackMatchOf`, worker job `stack_points`, the grid of `matchGeometry`, the unchanged
   `statsOfMatch`; kept in `_mstatsStack[Run]`), and the worker matches the rows before `composite_tile`
   (`match_pixels`, ABI 10, `crates/px/src/cmatch.rs`, bit for bit with its twin). 15k with a 5,000 × 3,500 matched
   layer: PNG 6.4 s to 1.8 s (block 1.45 s to 84 ms), PSD 1.8 to 1.0 s, wand 2.5 to 0.9 s. Against the whole
   flatten's statistics on four of the user's photos: mean 0.1 to 2.0 levels, max 7 (the textured landscape); with
   the same statistics the two paths are within 2 levels. Turned away still (the whole flatten as before): a matched
   layer above a filter layer, `readBox` (a provider run's crop), JPEG and WebP, the flatten into the base of a plain
   matched stack; `InpaintEditor.stackMatch = false` is the A/B switch. A design review (three lenses, 12 confirmed
   objections) made the grid integers, stamped the statistics with the clones' version, took the layer's own samples
   over the picture's edge, and gave the job a byte-exact gate (`stack_points_gathers_the_samples_it_names`); the
   same section, "After the design review". A scaled or a fractional layer still saves the old way. Not done
   in part 2: the longest block (0.15 s against the plan's 0.05), an asynchronous read, a mask folded into the alpha
   (a filter at an opacity through a mask is a level off on 18 % of the bytes). Each item is measured
   against its row in `tools/native_test.py` before and after, bytes equal to the path it replaces. What N found on
   the way (the 2.5 s `dilate` of a provider crop, the wand at 30k, the `RangeError` at the cap) is in `docs/BUGS.md`.

11. **Split of `renderer/editor/inpaint_canvas.js`, agreed with the user on 2026-09-17** (over 12,000 lines, one class;
   only that file; **moves only: no behaviour change, no renaming, no tidying on the way**; stage 1 the loose functions at
   the top of the file into modules of their own, then decide with the user whether stage 2 pays: the class's methods
   by subject into files that are hung into the class). **Stage 1 is built** (2026-09-18, after the 0.1.19 state was
   pushed; the design came from a panel the user's second account had started and its usage limit cut short; that
   account's workflow journal and scratchpad were read, nothing re-run that had finished): the
   three groups the agreement names went into three modules, moved byte for byte by line ranges (an independent proof,
   `verify_moves.js` in that session's scratchpad: 40 top-level statements moved, 84 stayed, every one of the 1,176
   comments once). `inpaint_jobs.js` (the worker and pool plumbing: the shared worker and `workerCall`, the mips worker,
   the pool, the tile store's chain transport with its three import-time statements, `buildLayered`, `JOB_TIMINGS`;
   21 names, old lines 64, 160 to 310, 336 to 359), `inpaint_encode.js` (the PNG encoders and the two hash functions:
   `encodeCanvas`, `canvasToBlob`, `encodeTilePixels`, `encodeBands`, `encodeRows`, `partsUsable` and the parts state;
   14 names, old lines 312 to 334, 361 to 369, 407 to 413, 417 to 480) and `inpaint_upload.js` (`SUBFOLDER`,
   `LARGE_UPLOAD`, `uploadBlob`, `uploadCanvas`, `uploadPixels`; old lines 54, 371 to 405, 555 to 565). **The one
   glue:** `nextPartsSeq()` in `inpaint_encode.js`, because the class incremented `partsSeq` at two sites and an
   imported binding is read-only (those two class lines are the only statement whose text changed). `inpaint_jobs.js`
   and `inpaint_encode.js` import `InpaintEditor` back from `inpaint_canvas.js` for the switches on the class
   (`mipsOnPool`, `mipsOnSharedWorker`, `pngParts`), read inside functions only: no module of the cycle touches another
   one's binding while it is evaluated (a scope walk, `toplevel.js`), all four entry orders give the same answers in
   Node (a Chromium page that imports each new module first was not run; ComfyUI imports every file of the node in its
   own order), and `setChainTransport(mipsTransport)` now runs when `inpaint_jobs.js` evaluates (before the class when the
   app enters through `inpaint_canvas.js`, after it when a new module is the entry; nothing reads the scheduler while
   the class file evaluates, its only static initialiser is a number). `inpaint_canvas.js` exports its 22 names as
   before (`uploadBlob` and `uploadCanvas` re-exported as imported bindings; the node's `host.js` and `inpaint_node.js`
   keep working). `tools/build_node.py` FILES and the file table of `docs/BUILD_NODE.md` carry the three names (the
   table also got the six older modules it lacked); ESLint with no-undef / no-import-assign / no-const-assign /
   no-unused-vars over the four files: 0 errors and the original's 3 warnings (a later `++partsSeq` in the class would
   pass `node --check` and throw at run time; only that lint sees it, the config is in the session's scratchpad, not
   in the repo). The three switches no gate sets were checked by hand on a fresh tiles instance (`switch_check.py` in the
   session's scratchpad): the transport is `mipsTransport` with `flights` = `poolSize()` (8) and `arena` true;
   `mipsOnPool = false` and `mipsOnSharedWorker = true` each settle a whole change with `chainScheduler().failure`
   null and `arena` false / back to true; `pngParts = false` makes `parts.usable()` false and an upload of a layer
   still lands in the mirror (the canvas way), true again afterwards. **Gates:** tiles, `--offline`, `split1-tiles` (pixels editor composite commands shape brush film glb ailabel size transparent generate log
   mcp nodecopy toapis llm export pxjobs): all PASS but `editor`, whose four full runs on the split tree failed at four
   different timing-bound steps (the live stroke with its pointer message while the browser pane was in use;
   `closed_tabs_are_collected` twice with the last two tabs alive, a step that passed 3 of 3 alone on both trees and in
   the unchanged tree's full run; `helper_inputs_read_levels_and_upload_nothing` with one upload counted), every step
   of the gate green on the split tree at least once (steps 60 to 65 in a run of their own); **the fifth run,
   `split1-tiles-editor5`, PASS in full** (65 steps, 120 s). Canvas backend, `--offline --tiles off`, `split1-canvas`
   (the same list without pxjobs, which needs tiles): ALL PASS (19 gates, the editor gate in full at the first try). The checkpoint commit before this one
   (`1d5ce8e`) was made on the user's word while the gates ran; its message says a Chromium page check was run, which
   it was not (only the Node runs; this paragraph is right). **Open for the user, the scope:** the design panel (three
   partitions, three judges, four hazard hunts with two refuters per finding; all three partitions mechanically
   equal: same glue, same cycle, all checks green) read the agreement's parenthesis as the whole list (this build,
   "narrow"). The judges' 2:1 favourite is "whole-head": every loose function of the head, into six more leaf modules
   with no new cycle, each rejectable on its own: `inpaint_dom.js` (makeCanvas, el, numberInput, selectInput, icon,
   iconButton, miniButton, STYLE, injectStyle), `inpaint_images.js` (viewUrl, loadImageEl, snapImage, needImage, the
   SVG helpers), `inpaint_stroke.js` (StrokeBuffer, STROKE_BAND), `inpaint_geometry.js` (clampRect, tileDiffBox,
   homography, drawMesh, autoSelectionParams, ensureMinSpan), `inpaint_backends.js` (the segment / upsample / cutout /
   object backend tables and their functions), `inpaint_hosts.js` (editorTileMode, hostText, isSettingOutput,
   settingIndex, linkOf); with it `inpaint_encode.js` would also take canvasRows, hugePngSize, pngIsPlainSrgb,
   pixelsFromPngStream, CRC_TABLE, crc32, asciiJson and pngWithText, and `inpaint_upload.js` UploadCache. The third
   reading ("stage2-ready": the constants out too, into an `inpaint_common.js`) pre-empts the stage 2 decision and was
   scored lowest. Whether the six leaf modules follow, and whether stage 2 comes at all, is the user's call. Kept as
   it was, no tidying: the section title in `inpaint_jobs.js` still reads "PNG encoding, upload hashes and the layered
   export writers" and names `js/inpaint_worker.js`; the class file's header comment (lines 1 to 13) is untouched.

**Decision (b) of 7c is made (the user, 2026-09-18): exports and runs of a colour-matched layer may move.** They may
take their statistics from tiles instead of from the whole flatten, with **point samples** (measured mean 0.56, max 8
to 9 levels against the full-resolution statistics; not box means, which were 5.45 / p99 12 on a textured photo;
`docs/PLAN_BCE.md` §C6 "C6 (c) slice 7c as built"). **B item 7 part 3 is built on it** (2026-09-18, item 10 above;
CHANGELOG 0.1.19 says a matched layer's export can move by a few levels). **Stage 1 of the split of
`inpaint_canvas.js` is built** (item 11, 2026-09-18). **Next: the user's two decisions on the split** (the six leaf
modules of the judges' favourite, and stage 2), and a release of 0.1.19 when the user says so (its CHANGELOG section
is written). Nothing else stands before it, unless the user names something else first.

**Housekeeping done on 2026-09-16.** The merged branches `c0-editor-source`, `c2-tiles`, `fix-mask-undo` and `px-spike`
are deleted locally and on origin; the v0.1.11 draft release and its tag are deleted; `dist/` is cleaned (old installers,
gate profiles, `dist/ab`, `composite`, `smoke`). `tools/run_gates.sh` recreates the profiles it needs.

**Still unverified or open:** the ToAPIs adapter has never run against the live API (`docs/RECIPES.md` "Only a real key can verify"); a real SAM2 / RMBG
model has not run on the slice 6 code; the user has not reported back on their own 15k file.

## Gate runner and flakes

`bash tools/run_gates.sh <label> [--strict] [--copy] [--tiles on|off] [--offline] [--exe PATH] <gates...>` starts a fresh instance on
port 9555 with its own profile (with `test_base.png`), runs each gate with a timeout, and writes logs and `summary.txt` under
`dist/gates/gates/<label>/` (or `$SCUMBLE_GATES`). `tools/close_app.py` closes an instance by its DevTools port
(`SCUMBLE_CDP_PORT`). Gates: `pixels editor composite commands shape brush film glb ailabel size transparent generate log
mcp nodecopy toapis llm export pxjobs`, plus `smoke` (a real Flux run; check `/queue` first, and not while the user needs
ComfyUI), `perf:<W>x<H>`, `exportperf:<W>x<H>[,--filter=film.look]` and `huge:<W>x<H>` (the 30k gate; it refuses to run
against a connected instance). **`--offline` starts the instance with `--no-comfy`**: it does not connect, so no upload is
forwarded to the user's server. A fresh gate profile otherwise connects to `127.0.0.1:8188`, the user's ComfyUI, and
forwards every upload of every gate to its input folder; use `--offline` for everything but `smoke`. Run a change on both backends (`--tiles on` and `--tiles off`); a release also runs against
`dist/win-unpacked/Scumble.exe` with `--exe`, each run on its own profile.

Known flakes; **re-run before believing any of these**:
- `commands_test.py` hangs after every step has printed `[ok]` (the runner's 420 s timeout, sometimes in
  `Page.captureScreenshot`).
- `editor_test.py` `closed_tabs_are_collected` fails with the last tabs still alive, or against an instance with 50+ tabs
  from repeated runs.
- The live stroke steps (`live_stroke_reaches_the_screen_before_the_release`, `live_stroke_preview_shows_what_the_commit_writes`)
  fail when a real mouse is over the test window (they drive synthetic pointer events), or right after a diagnostic
  instance was closed.
- The marching ants (120 ms) break a screen comparison now and then; steps that compare the screen draw the selection as a
  tint.
- `composite_test.py` once got a 1200 × 794 canvas against its 1200 × 800 reference and then crashed with `KeyError 'bytes'`
  in its own failure message (a test bug, not fixed).
- `node tools/brush_test.js` hung once at exit under load after printing every PASS.
- `editor_test.py` `closed_tabs_are_collected` failed twice in five runs of the editor gate alone on the canvas backend
  (`--tiles off`, 2026-09-17, B item 2) and passed on the rerun each time; the code under it had not changed.
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

## Traps worth keeping

**Chromium, canvas, WebGL**
- Chromium applies `UNPACK_PREMULTIPLY_ALPHA_WEBGL` to `ArrayBufferView` uploads too; set both unpack switches explicitly
  before every typed-array upload, or premultiplied tile bytes get premultiplied twice.
- Once at least 100 `getImageData` calls have disabled acceleration and they reach 95 % of all canvases created, Chromium
  makes every new canvas software; a test with a readback after every step can trip it.
- `globalCompositeOperation` `copy` and `destination-in` apply to the whole canvas; a regional use needs `clip()` first (the
  vanishing-layer bug of 0.1.8).
- An OffscreenCanvas clips without anti-aliasing; `drawInto` callbacks allow clips on whole pixels only.
- A canvas 65,536 px on a side draws and reads nothing; 65,535 works. The WebGL drawing buffer caps at about 33 MP whatever
  the canvas size says (filters render in tiles for that).
- A sub-rectangle draw from a very large canvas is not cheap (150 band draws from a 15k canvas cost 30× one whole draw);
  bands only pay when each band's source is small too.
- A `CanvasGradient` belongs to the context that made it; a cached one has to be keyed by the context.
- Skia's CPU raster is not exactly translation-invariant; a GPU readback costs whatever is queued before it; Chromium keeps
  small canvases in software, so a buffer that grew onto the GPU differs from an all-GPU canvas by a few levels.
- `requestAnimationFrame` does not fire in a hidden window (`drawSoon()` is rAF-based), and `img.decode()` never resolves
  there; scripted waits use `setTimeout`, image loads wait for `onload`.
- On a `<dialog>` closed by a real Escape Chromium fires `cancel`, not always `close`.
- `texSubImage2D` and `readPixels` take a view on a `SharedArrayBuffer` here (Electron's Chromium): no copy between the
  workers' buffer and the GPU (B item 7 part 2). 572 MB go up in 0.1 s and come back in 0.2 s, on the main thread.

**Electron and Windows**
- In the main process `process.stdin` never emits `data` from a pipe (read fd 0 with `fs.createReadStream`); Electron prints
  a CR LF to stdout before any JS runs (hence the MCP launcher); a window created hidden stays hidden after `show()`,
  `restore()` brings it up.
- Electron has no `window.prompt`; the editor has its own `ask()` modal.
- Only one instance runs at a time (single-instance lock and named pipe), including headless `--mcp` instances.
- `mcp_test.py --user-data-dir` must come before `--cmd`, which otherwise takes it for its JSON.

**Tooling, shell, git**
- The Bash tool's heredoc breaks on an apostrophe in its text even with a quoted delimiter (`unexpected EOF while looking
  for matching`), and turns `\u0080` in Python source into the character. Write scripts and JS with the Write tool; a
  patch script imports a small `patch(path, [(old, new)])` helper and asserts each `old` occurs once.
- The Write tool itself turns `\u0080` in a JS regex into the literal character. Check a written file for non-ASCII
  (`grep -nP "[^\x00-\x7F]"`) when it holds escapes.
- A backtick in a comment inside a GLSL template literal ends the JS string; `node --check` on an ES module file here
  reports nothing, the app reports `Unexpected identifier` at import.
- A Bash-tool heredoc with an unquoted delimiter (`<<EOF`) runs every backtick span in its text as a command; quote it
  (`<<'EOF'`) or use the Write tool. Heredocs also turn `\\n` in Python source into real newlines, and long Python heredocs
  fail to parse: write scripts with the Write tool.
- PowerShell `Set-Content` writes a BOM (electron-builder then refuses `package.json`); edit such files from Python.
- Python patch scripts write with `newline=chr(10)`.
- Reusing one commit message file gives the next commit the old message.
- The node's publish action runs on a push only when `pyproject.toml` changes; otherwise
  `gh workflow run publish_action.yml --repo DenRakEiw/ComfyUI-InpaintCanvas --ref master`.
- `tools/run_gates.sh` and the mutation helpers restore only the files they saved; check `git diff --stat` after a mutation
  round.
- A background `grep` loop meant to stop a workflow after a phase does not fire in time; read its journal by hand or give it
  a phase switch in `args`.

**Testing and benchmarking**
- A mutation that is not run against a fresh instance proves nothing: the renderer caches the ES modules it imported at
  start. Close the app, patch, start again.
- Restart the app before every benchmark or memory run; after several large documents the GL path degrades.
- A "before" row that runs after `mipsSettled()` measures a warm document.
- An A/B that flips between rows compares two pictures; compare bytes in one state, with
  `releaseCaches({ mirrors: true, deep: true })` between the reads.
- A benchmark row only measures what its document exercises (the perf stack always carries a filter layer).
- ComfyUI holding the card changes op rows by 3 to 5×; A/B a suspected regression in the same session, with the card freed
  (`/free` on an empty queue) if possible.
- The layers reach the local store through `ed.syncLayers()`; a test that reloads right after a change calls it first.
- `editor_test.py`'s `window.__t` is 600 × 300 by the time later steps run; call `new_canvas` first.
- A test that sets `layer.blend` or `layer.visible` by hand leaves the composite version where it was, and the wand's
  coarse pass answers from before the change; go through `set_layer` (it calls `touch`).
- Three 8-bit roundings in a blend formula are up to 1.45 levels off and a level from the shader on 29 % of the bytes of
  a half-transparent layer; one rounding of exact products is within 0.5. Measure a kernel against exact floats
  before blaming the other path.

**Tile engine code**
- A tile's bytes are a view into a SharedArrayBuffer in the app: no `ImageData`, `Blob` or `crypto.subtle` over them
  (`imageDataOf` copies into a scratch), `t.data.buffer` is the 64 MB chunk (use `byteOffset`), and a worker may read a
  tile while this thread writes it: a job's answer counts only if the tile's version is still the one it was made from.
- A worker must never write a tile it was given by slot; it extends or converts a copy.
- Whoever hands tiles to a job holds them until the answer is in (a `clone()` for a file, the scheduler's batch for mips):
  the slot goes back to the arena when the tile object is collected.
- `makeCanvas` and `flattenToCanvas` throw above Chromium's canvas limits since E5. Code that needs the whole picture asks
  `bandPlan` / `readBand` / `readBox`, or a row source (`inpaint_bands.js`).
- A copy-on-write copy that takes the original's chain buffer must take ownership, or the last holder writes into it in place.
- A rebuild that asks for chains and then drops them asks again forever; cells are kept per tile version.
- `frozen` too high only costs a copy; too low writes into a shared tile. A release must never let go of pixels the document
  still holds.
- A second walk of the layer stack (like `passStores` beside `drawLayersInto`) is where this design breaks; keep it next to
  `drawLayer`'s branches.

## How the app is put together

- `electron/main/main.js`: window, `scumble://app/` scheme (renderer files) with
  `scumble://app/comfy/*` proxied to the ComfyUI server by `electron/main/comfy.js`
  (auth headers live there; the websocket too, events are forwarded over IPC).
  Same-origin, so `<img>` from `/comfy/view` never taints a canvas.
- `renderer/editor/`: the editor, edited here since C0 and built into the node by
  `python tools/build_node.py` (then `python tools/node_test.py`, commit both repos;
  `docs/BUILD_NODE.md`). `renderer/editor/host.js` is the app side: `api` (fetchApi, apiURL,
  queuePrompt, events) and `host` (recipe, settings targets, generate, autosave, export); the
  node's `js/host.js` answers the same members, and `build_node.py --check` fails when the
  editor calls one that either host lacks. Never edit the node's generated `js/` files.
- Recipes are API-format prompts; `host.queueGenerate` injects `canvas_state`,
  `result_source[_local]` and the node params into the canvas node and writes the
  Settings-panel values into the recipe nodes directly (`settings: [{index, node,
  input, label}]`), so `setting_n` outputs are not used.
- State: every tab's `getValue()` JSON in one bundle, autosaved to
  `%APPDATA%/Scumble/autosave.json` and restored at the next start from the local file
  mirror (`%APPDATA%/Scumble/files/`), no server needed. Layer pixels are uploaded like
  in the node (`input/inpaint_canvas`), but the upload lands in the mirror and is
  forwarded; `ensureOnServer` re-uploads before a run.
- `renderer/shell.js`: tab bar, settings dialog (ComfyUI + auth + Test, API keys,
  recipes, helpers, local files), menu commands, restore at start; exports `newDocument`,
  `activate`, `closeDocument`, `openSettings`, `selectRecipe`, `loadRecipes`,
  `importRecipe`, `testConnection`, `connect` for tests (`import("./shell.js")` from
  the console). `window.editor` is always the active tab.
- Helpers in-app: editor → `host.findObjects` / `host.cutoutInApp` / `host.selectPoint`
  (source scaled to 1024² in the renderer) → IPC `helpers:objects|cutout|segment` →
  `electron/main/onnx/index.js` → `sam2.js` / `matting.js` on the `Runtime` → label
  map / alpha back, scaled to the image in the renderer. Models and folder in
  `docs/HELPERS.md`.
- Agents: MCP client → `Scumble --mcp` (`electron/main/mcp/server.js`) → `AgentBackend` in
  `main.js` → the running instance over `electron/main/local.js` (named pipe) or the app
  started headless in the same process → `electron/main/bridge.js` (IPC `commands:request` /
  `commands:reply`) → `commands.call` in `renderer/shell.js`. `docs/MCP.md`.
- Provider runs: `host.runProvider` (the recipe resolved to the chosen provider's variant by
  `shell.js`) → `renderer/editor/stitch.js` (crop) → IPC `provider:edit` →
  `electron/main/providers/index.js` picks the adapter and the key (`keys.js`) →
  `stitch.js` (composite mask, colour match) → mirror upload → `addResults`. Recipe
  formats in `docs/RECIPES.md`.

## Working rules

- Development folder is `F:\canvas`. Scratch files go to the session scratchpad, not here.
- Commit as DenRakEiw: `git -c user.name=DenRakEiw -c user.email=89697885+DenRakEiw@users.noreply.github.com`,
  no Claude trailer in commit messages. Push with `-c credential.helper='!gh auth git-credential'`.
- The user's ComfyUI (port 8188) is a production machine: check `/queue` before
  queueing anything, never restart it unasked, delete own test prompts from the queue.
- Python patch scripts must write with `newline=chr(10)`; a mistyped `newline="\\n"`
  once truncated a 7,000-line file.
- Test with real runs: start `./node_modules/.bin/electron . --remote-debugging-port=9555`
  (9333 is usually taken by the node's headless tab), then `python tools/cdp.py eval|shot|log`
  and `python tools/smoke_test.py` (load, select, generate through the recipe, save,
  then the helpers and exports; `--no-helpers` for the short version) and
  `python tools/commands_test.py` (command core + sample plugin, no ComfyUI needed).
  `python tools/mcp_test.py` talks to the MCP server over stdio through
  `electron/main/mcp/launch.js` (proxy mode while the dev instance runs, headless when
  nothing runs; `--exe dist/win-unpacked/Scumble.exe` for the package, `--direct` for the
  old registration, which the Python client rejects by design).
  `python tools/llm_test.py` checks the OpenAI-compatible upsample endpoint against
  `tools/llm_mock.py` (a mock server it starts itself; no ComfyUI, no key, no local model).
  `python tools/generate_test.py` covers "Generate new" (a base image from the prompt
  alone) against the loopback provider, no ComfyUI and no key needed.
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
  to stay visible on white, and copy / paste of a layer between tabs.
  `node tools/helpers_test.js` runs the ONNX modules without Electron.
  `python tools/composite_test.py` compares the GPU compositor against Canvas 2D and two
  stored references in `tools/refs/` (`--update` rewrites them, `--tolerance n` allows n
  levels); run it after anything that touches drawing.
  `python tools/perf_test.py [2048x1152 6000x4000 12000x8000]` is the drawing benchmark
  (synthetic documents in their own tab, no ComfyUI; `docs/PERFORMANCE.md` §7).
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
- Answer in German; code, comments and docs in English.
