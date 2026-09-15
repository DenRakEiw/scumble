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

## Where things stand (2026-09-15, late: 0.1.14 tagged, the live stroke, the atlas field, ToAPIs)

**Read this block first; it supersedes the "Where the next session starts" part of the block below.** 0.1.13 is
published. 0.1.14 is tagged and its **draft** is built; publishing it is the user's step
(`gh release edit v0.1.14 --draft=false`). `CHANGELOG.md` 0.1.14 has the user-facing bullets.

**What 0.1.14 carries, on `main`, pushed:**
- **The live stroke** (74d60ac). In 0.1.13 brush, eraser (also on a mask), clone / heal, gradient and a dragged
  rectangle / ellipse / freehand shape showed only the first dab until the release, on both backends, every size and
  zoom (reported with a screen recording on the installed 0.1.13).
  - Cause: the screen keeps its composited scene behind `sceneSignature()`, whose only input that moves during a gesture
    is `pixelVersion`. Every dab used to raise it through `touchSource(buffer canvas)`; **28bfad0** (C5 c, the sparse
    stroke store) dropped that call from `layerDab`, `cloneDab`, `gradientDab` and `shapeDab`. First bad commit 28bfad0,
    bisected on both backends (4bd31a4 good).
  - Fix: `strokeDirty()` raises `pixelVersion`; only the scene key moves (no mirror, no display level).
  - Gates: `editor_test.py` `live_stroke_reaches_the_screen_before_the_release` (shots right after a move, no rests) and
    the reworked `live_stroke_preview_shows_what_the_commit_writes`; `docs/PLAN_BCE.md` §C7 "The live stroke that did not
    show" has the A/B and the review round. Scratch records: `bug-live/fix.md`, `finish.md`.
- **The atlas field** (a8303fd). *Settings › Rendering › Tile atlas* had `min="16" step="64"`, so its own default 512 was
  invalid and the dialog's *Close* (a validated form submit) refused to close. All three memory rows are `step="1"`
  now, stored values are shown rounded (`wholeMB()`), Generate new's width / height are clamped to 64..8192. Gate step
  `settings_form_accepts_its_own_values`.
- **ToAPIs** (6ff9666, 0adb281, 837f7b7, e3a47b4, review fixes ec7b032), the user's decisions of 2026-09-15:
  - first in every provider list, key link `https://toapis.com/login?aff=vfR1` (referral; README says so for ToAPIs and
    WaveSpeed); recipe defaults unchanged, **no automatic fallback**; the official channel is the default where one
    exists (the mask only on `gpt-image-2-official`), a *Channel* row for vip / standard; upsampling through ToAPIs' Chat
    Completions (three rows, only with a key); *check balance* (`GET /v1/balance`).
  - **Nothing has run against the live API**, on the user's decision: no key was used, every variant note says so and
    says crop, mask and references become public `files.toapis.com` URLs.
  - `docs/RECIPES.md` "ToAPIs" › **"Only a real key can verify"** is the live-test list: `image_urls` strings vs `{url}`
    objects per channel, a PNG's alpha surviving the upload and the mask polarity on `gpt-image-2-official`, the real
    output size for custom ratios and `auto`, the ids `gemini-3.1-flash-lite-image-official` and
    `gemini-3-pro-image-official`, `metadata.prompt_extend: false` on Qwen, FLUX over 1440, `billing.cost_usd` per tier,
    durations, which result shape arrives, the error language, JPEG uploads for the fallback, which "10MB" is counted,
    the Nano Banana / Seedream pro output sizes per tier, how the gateway answers status queries in an outage, and
    whether Seedream's 3:1 limit applies to references. The design (scratchpad `toapis/design.md`) lists the same.
  - **The review round** (two lenses, two refuting verifiers per finding; ec7b032): provider setting targets named no
    recipe, so a *Channel* "standard" chosen on Qwen via ToAPIs ran GPT Image 2 on its maskless channel (major; the node
    id is `provider/<recipe>/<provider>` now); the Generate-new dialog sent "64:43" for 3:2; one 5xx on a status query
    or the download threw a paid task away; *auto* bought 2K where 1K covers (page tables in `options.tier_sizes`);
    references never got the JPEG fallback; Seedream's 3:1 input was unchecked (`limits.ratio` widens the crop,
    `options.max_ratio` refuses); upsampling retried any 4xx without the crop and lost "text only"; the 10 MB guard
    counted MiB. Ten adapter / llm mutations red in `node tools/toapis_test.js` (57 checks), three app mutations red in
    the `toapis` gate. Records: scratchpad `toapis/build/build.md` and `release.md`.

**The release.** The commit that carries this block is tagged `v0.1.14` and the workflow builds a **draft** from
`CHANGELOG.md` 0.1.14. Publishing it is the user's step. Still the user's call: the v0.1.11 draft and the merged branches
(`c2-tiles`, `fix-mask-undo`, `px-spike`, `c0-editor-source`).

Gates on ec7b032 (fresh instances, logs under `dist/gates/gates/<label>/`):
- `rel14-tiles` (`--strict --tiles on`, pixels editor composite commands shape brush film glb ailabel size transparent
  generate log mcp nodecopy toapis llm): ALL PASS.
- `rel14-canvas` (`--strict --tiles off`, pixels editor composite commands size generate transparent toapis): the known
  flake, `commands_test.py` hanging after every step had printed `[ok]` (the runner's 420 s timeout); the re-run
  `rel14-canvas2` ALL PASS.
- `npm run dist` → `Scumble Setup 0.1.14.exe`. Against `dist/win-unpacked/Scumble.exe`, each on its own profile:
  `rel14-exe` (pixels editor commands composite brush toapis mcp, no `--tiles`: `{ tiles: true, from: "default" }`) ALL
  PASS; `rel14-exe-canvas` (`--tiles off`: pixels editor composite) ALL PASS; `rel14-exe-smoke` a real Flux run in 97 s,
  PASS, the ComfyUI queue empty before and after.

**Where the next session starts:**
1. **C6 (c) slices 3 to 7** of `dist/c6map/c/critic.md` §5 (the maps are older than the code; see the block below for
   what each slice holds and the user's three decisions for C6 (c)).
2. **C6 (d)**, the base; then **C4** (`snapshotRect`'s box sharing no tile unless tile-aligned, the `frozen` counter);
   then the rest of **§C7** (the node's browser, Firefox, the 30k gate, the docs list, the memory gate).
3. **The user tests the tile engine on their own 15k file** (what to ask for: the block below, "What the user is to test").
4. **Phase R, Rust kernels** (`docs/PLAN_BCE.md` §2b, decided 2026-09-15 to come after C7): the crate is in the history
   at c75c4f1 (`crates/px/`, `renderer/editor/px/px.js`, `bench.js`), 2 to 3 days, B's 3× rule measured on the real jobs.
5. **Phase E**.

**Also known, not built:**
- **The object tool (O) on 15k documents is slow**: two full flattens for the model input, a 320 MB id map, about
  1.3 GB per hovered object. The input belongs to C6 (c) slice 6 (`sourceCanvas`, the cutout input, `segmentPoint`,
  the input hash); the id map and the hover shapes need a follow-up of their own.
- **The user's helper models** now live in `ComfyUI/models/onnx`, with Scumble's model folder set to `ComfyUI/models`.
- **The Helpers list in Settings was empty once** in the user's running 0.1.13 window; cause unknown, not reproduced.

## Where things stood (2026-09-15: 0.1.13 tagged, tiles on by default)

**The block above supersedes this one's "Where the next session starts".** The records are
`docs/PLAN_BCE.md` §C6 "C6 as built" ((b2), (b3), (c1), (c2), each with its measurements, its mutations and the review fixes)
and §C7 "The default, as built"; `CHANGELOG.md` 0.1.13 has the user-facing bullets.

**The user's decision (2026-09-15): the tile engine is on by default in the installed app from 0.1.13**, with a switch in
Settings › Rendering to turn it off (the user is the only user so far and wants to test it on their own 15k files). The
canvas backend stays as the escape hatch. The node (ComfyUI-InpaintCanvas) is not released with it and keeps its own default
(off).

**Built since the block below, on `main`, pushed:**
- **C6 (b2)** 726dc66, the three benchmark rows that moved in (b), broken down by an A/B against 00a3ade:
  - `getValue` 5-8 ms is the selection's PNG, whose background encode lands during the benchmark's waits: old, on both trees.
  - The commit's time is the collector working on the commit's own garbage, not the chains in flight.
  - The PNG row was charged with the landings the rows before it had asked for.

  Built: a landing of the **selection's** chains draws the overlays again and drops no view cache. A landing of a layer's, a
  mask's or the base's chains drops `_fcacheView` / `_mcacheView` / `_mstatsView` only **above the lowest landed layer**, once,
  when everything has settled. A sampled pass keeps statistics of its own (`_mstatsSample`). `perf_test.py`'s `op()` waits for
  `mipsSettled()`. Invert's re-runs while its chains land went from 30 to 0.
- **C6 (b3)** bc3814d, `layerMatchedPart`: a sampled pass colour-matches only the part of a matched layer it shows. Before, every
  fine box of the flood matched the whole 2048² result (196-224 ms a box); now 7-27 ms. The wand and bucket rows stay noisy,
  because they depend on the state the rows before them leave.
- **C6 (c1)** 81210d1, box reads at level 0:
  - A film control point's colour is the 3 × 3 mean of the **points layer's input** under it (the user's decision):
    `flatten({ box, below, exact })` / `readBox`, padded by the new optional filter field `reach`, or cut out of the whole
    flatten below the points when a filter declares no reach (the look's halation, vignette, normalise, frame).
  - `Document.selection()` reads its bounds (`selection({ box: true })`); the sample plugin's `mean_color` with a selection,
    *Selection to new layer* and the probe read boxes.
  - The bucket's fine rounds read `sel.toCanvas(box)`.
  - The filter cache key carries the pass's box and scale.
  - A point add without filter layers takes 109-143 ms at 15k. Under the perf document's film look it is the whole flatten
    below again: 5.1-5.4 s, the same as before (c1).
- **C6 (c2)** 1513624 … b1a9afb, six holes in region passes that still made display mirrors, one commit each:
  - (a) A masked layer, or a live stroke outside the screen's own, composes in a pass scratch (`drawLayerPass`).
  - (b) `sampleRegion("layer")` reads tiles.
  - (c) A filter layer's mask reads tiles, and so does a mask stroke on it.
  - (d) A move / scale / smudge gesture draws the layer from tiles.
  - (e) A layer's row during a stroke on it comes from its thumbnail. The row shows the picture from before the stroke.
  - (f) The peek is a base-only pass.

  At 15k: the wand with a masked layer 1.3-1.8 s → 0.3 s, the eyedropper on it 1044 → 15-34 ms, the peek's first frame 558 → 50-60
  ms, a move drag's first frame 425 → 0.2 ms. The perf footer holds 1 mirror of 16 MB, against 2 of 588 MB.
- **Review fixes** 10def79 for (b3), (c1) and (c2):
  - The control points' shader and CPU path now add the pass's origin. A zoomed view had shown the effect shifted since phase 1, on
    both backends.
  - A point's colour is padded by the declared reach.
  - `pad` counts whole canvas pixels.
  - A level-0 read that is not for the screen takes a region slot of its own.
  - `flatCache` lets go when the composite version moves.
  - `_filterMaskView` is released and counted.
- **The default** 7a89601:
  - `electron/main/tilemode.js`: `--tiles` / `--no-tiles` > `SCUMBLE_TILES` > a boolean `tiles` in settings.json > **on**, with
    `from: "default"`. Nothing writes the setting on its own.
  - Settings › Rendering › *Tile engine*: a box, a note saying what decided this window, and *Restart now*. The button is IPC
    `app:relaunch` in `electron/main/restart.js`. It saves first (`saveBeforeRestart()`: `syncLayers()`, then waits for the
    selection's encode), drops `--mcp` / `--headless` / `--cmd` from the relaunch, and installs an update that has already been
    downloaded.
  - Gate steps `tile_engine_row_writes_the_setting_and_names_its_source` and `restart_now_saves_the_edits_of_the_last_seconds`,
    plus `node tools/tilemode_test.js` and `node tools/restart_test.js`.
- **Memory**, `mem_test.py 15000x10000 --rounds 2`, one document, renderer / GPU process:
  - Tiles on: about 4.5 GB / 2 GB. Tiles off: 0.7 GB / 7.5 GB. Closed documents are collected on both backends.
  - Three 15k documents open on tiles: 10.4 GB renderer and a 65 ms pan.
  - **§C7's memory gate is not met** (at most 300 MB of GPU process per document, 4 rounds, the renderer against the tile bytes).
    The levels-tick drift check reads FAIL (+22 %). The default went on anyway, on the user's decision.

**The release.**
- The commit that carries this block is tagged `v0.1.13`, and the workflow builds a **draft**. **Publishing it is the user's
  step** (`gh release edit v0.1.13 --draft=false`); only then do installed apps update.
- The v0.1.11 draft and the merged branches (`c2-tiles`, `fix-mask-undo`, `px-spike`, `c0-editor-source`) are still the user's
  call.

Gates:
- **Dev, on 7a89601** (fresh instances, strict), all ALL PASS:
  - `rel-final-tiles` and `rel-final-default`, the fifteen gates each.
  - `rel-final-canvas` (`--tiles off pixels editor composite commands`), on the re-run. The first run hit
    `live_stroke_preview_shows_what_the_commit_writes` on canvases, 157 levels, a flake.
  - Before the review fixes: `rel-tiles`, `rel-canvas`, `rel-default` and `rel-copy`.
  - `rel-smoke`: a real Flux run, PASS, the queue empty before and after. The run took **387 s**, against the runner's 420 s timeout
    (91 s on the exe right after). Probably ComfyUI loading the models again after the user's own jobs; not checked.
- **Built:** `npm run dist` → `Scumble Setup 0.1.13.exe`.
- **Against `dist/win-unpacked/Scumble.exe`**, each on its own profile, all ALL PASS:
  - `rel-exe`: pixels editor commands ailabel brush glb composite mcp, with no `--tiles`. The backend step and the row read
    `{ tiles: true, from: "default" }`.
  - `rel-exe-canvas`: `--tiles off`, pixels editor composite commands.
  - `rel-exe-smoke`: a real Flux run in 91 s, the queue empty before and after.

**What the user is to test:** their own 15k file in the installed 0.1.13, with tiles on. If it stutters, ask for two things:
- **which action** it was: pan, zoom, brush, mask, a selection operation, the wand, Generate or export;
- **Settings › Rendering's numbers** while it stutters, and *Help › Console › Copy all* for any error.

Then the same with the engine off (untick the box, *Restart now*) for comparison. What is still slow on purpose is listed in the
CHANGELOG's lead bullet:
- the smudge brush;
- a wand across the whole picture, and invert;
- whole flattens: renders, exports, the object tool, upsampling, `screenshot`;
- a film point under a film look;
- whole-layer copies: background removal, select by text, select from layer, the autosave;
- several 15k tabs open at once.

**Where the next session starts:**
1. **C6 (c) slices 3 to 7** of `dist/c6map/c/critic.md` §5.
   - **Where the maps are:** the critic and the five maps it checked (`commands-plugins.md`, `match.md`, `objects.md`,
     `region-holes.md`, `sample-region.md`) are copied there from the session scratchpad, with the user's decisions as
     `decisions.md`. The build / fix reports of (b2) and (c1) sit in `dist/c6map/` (`b2-ab.md`, `b2-build.md`, `b2-fix.md`,
     `c1-build.md`, `c1-fix.md`), the release default's in `dist/c6map/rel/`. All of this is git-ignored.
   - **What is done:** slice 1 is (c1) and slice 2 is (c2) a-f. Slice 0's A/B was (b2).
   - **The maps are older than the code:** they were written at 987961b, before (b2) … (c2). Line numbers have moved, and some
     items are done: the bucket's `toCanvas`, the filter cache key, `_mstatsSample`, the origin of the control points.
   - **What is left:**
     - **3:** a one-shot exact reader in `inpaint_tiles.js`: a `keep` separate from `screen`, a landing handed to the read that
       waits for it, and the thumbnail route.
     - **4:** async readers on it: the film panel's `flatten({ maxSize, settled })`, the glb backdrop, the flood's coarse pass.
     - **5:** `promptContextCanvas` and `screenshot`.
     - **6:** the helper inputs: `sourceCanvas`, the cutout input, `segmentPoint`, the input hash.
     - **7:** colour match:
       - 7a: the null-statistics race, which (b2) / (b3) left and reproduced (a statistics drop between the flood's passes
         makes the wand select a different region);
       - 7b: the matched region view;
       - 7c: statistics independent of the pass, per decision 1 below;
       - 7d: GPU uniforms.
   - Critic §6 lists the open measurement decisions.
2. **The user's decisions for C6 (c)** (2026-09-15), copied from `decisions.md`:
   1. Colour match statistics independent of the pass: **(a)**. The screen, the navigator, the eyedropper, the wand / bucket
      samples and the plugin panels share one statistics entry per layer per change, taken from levels of the whole padded
      surroundings. The full-resolution flatten (exports, runs, uploads) keeps its own `_mstats`, and its output stays
      byte-identical. Measure during the build how far (b) (the export on the same entry) would move real inpaint results,
      including a sampling that keeps texture (point samples instead of box means), and report it. (b) comes back to the user
      only with those numbers.
   2. Film control points read the colour of the points layer's input (everything below the points layer) under the point, not
      the whole composite: **(b)**. CHANGELOG bullet. *(Built in (c1).)*
   3. `sample.mean_color` without a selection stays an exact full-resolution read: **(a)** (phase E makes it fast). With a
      selection it reads the selection's bounds. *(Built in (c1).)*
3. **C6 (d), the base:** item 3 of the block below.
4. **C4:** item 4 of the block below, including `snapshotRect`'s box that shares no tile unless it is tile-aligned, and the
   `frozen` counter.
5. **The smudge tool on tiles:** 400-750 ms per move at 15k, read from the layer's mirror; it needs its own step.
6. **Measured in the release review and not broken down** (§C7 "The default, as built"):
   - A cold whole flatten on tiles: 4.7-11.4 s with a film look, 0.9-2.5 s without, against 0.22-0.31 s on canvases.
   - `perf_test.py`'s "full composite" worst: 1.9-2.7 s in C5, 4.9-8.0 s since C6 (b).
   - A whole-layer `toCanvas()` 184-253 ms.
   - Several open 15k documents: the levels tick 49-64 ms.

   The rest of §C7 is open too: the node's browser, Firefox, the 30k gate, the docs list, the memory gate.
7. **The node repo** is still at 647db5d, behind by C3, C5, C6 and this default. `nodecopy` passes. Build it into the real repo only
   when a node version is meant to ship.

## Where things stood (2026-09-15, 01:30: C6 steps a and b are built and pushed)

**The block above supersedes this one's "Where the next session starts".** `docs/PLAN_BCE.md`
§C6 "C6 as built" is the record (measurements, decisions, every mutation with its red, the review fixes). The user stopped the
session here on purpose ("commit und push, dann Stop bis morgen").

**Done this session, on `main`, pushed:**
- **C5's owed gate**: `smoke_test.py --no-helpers` with a real Flux run PASS with tiles on (196 s) and off (94 s), the ComfyUI
  queue empty before and after.
- **C6 (a)** `00a3ade`, "the atlas is keyed right". Three real defects in C3/C5 code, each reproduced red first:
  - A second "mask from selection" kept showing the first mask (both masks had `_version` 1). Tile versions now come from one
    module-wide counter (`pixelSeq`).
  - Replaced pixels (flip, turn, a new mask, undo restores, a new base) were never forgotten by the atlas. Three flips of a 15k
    layer kept 2.4 GB alive until their pages aged out. The compositor now holds pixels weakly, and `retainPixels(live)` drops
    what the document does not hold.
  - A slot's gutter went stale when only a neighbour changed (76 / 104 levels at a tile border). Each slot records its
    neighbours' versions, and only the ring is re-uploaded.
- **C6 (b)** `e32d4ae`, "mips off the main thread". Measured first:
  - At fit on 15k every chain was built twice: the layer thumbnail built 2,360 into a thrown-away scratch, then the atlas built
    them again.
  - A whole `touch()` rebuilt chains for unchanged tiles.
  - The frame after a whole change blocked 530–790 ms.

  Built:
  - `touch()` no longer bumps tile versions; every write already goes through `writable` / `_share` / `_dropTile`.
  - The thumbnail reuses chains.
  - A `mips` job runs in a **worker of its own** (`ChainScheduler` in `inpaint_tiles.js`).
  - The screen shows the previous chain, or a nearest-sampled coarse slot, until the fresh one lands.
  - `watchChains()` / `redrawThumbsOf` refresh thumbnails and view caches on landing; `ed.mipsSettled()` lets tests wait.

  After: that frame is **12–26 ms**, the picture is sharp about 0.4–0.9 s later, and a whole touch costs 3–6 ms. The review
  confirmed 16 findings plus 1 split; all were fixed with counter-proofs (23 mutations red).
- Gates on `e32d4ae`: `--tiles on` and `--tiles off` with all 15 gates ALL PASS, `--copy` ALL PASS, `perf:15000x10000` PASS.
  `smoke` was **not** re-run after (a) and (b).

**Where the next session starts:**
1. **Three benchmark rows moved the wrong way in (b) and were not broken down**:
   - `PNG of the composite` blocked 30 → 88–284 ms;
   - `getValue` 0 → 5–8 ms;
   - `its commit, band by band` 562 → 604–698 ms.

   Measure these first (A/B against `00a3ade`), before C6 (c). Also, the film panel's `Document.flatten({ maxSize })` reads
   exact mips through `sampleRegion` and builds every chain on the main thread while the worker's chains land: 141 ms, the
   longest block after a whole change. That is C6 (c)'s.
2. **C6 (c), the small readers from levels.** The code maps this session made (at d7234e4; line numbers have moved) and the
   build / fix reports of (a) and (b) are kept in `dist/c6map/` (ignored by git): `readers.md`, `base.md`, `undo.md`,
   `mips.md`, `worker.md`, and `critic.md`, which corrects the others. The full-resolution readers left in tile mode are:
   - `promptContextCanvas` (a whole flatten for a 1024 px picture);
   - `host.findObjects` / `sourceCanvas` (one or two whole flattens for a 1024² model input, plus a 286 MB id array);
   - the `screenshot` command;
   - the film control points' `sampleColor` fallback (`doc.flatten()`);
   - `peekBase` (the base mirror plus a GPU copy).

   The holes that still build the 572 MB display mirror inside "small" passes:
   - a colour-matched layer in any region pass (`layerMatchedPixels`);
   - `sampleRegion(source: "layer")`;
   - a filter layer with a mask (`maskPx.drawTo`);
   - a live stroke's layer thumbnail.

   One probable bug to verify: `matchStats`' `_mstatsView` is shared by the screen pass and every sample pass (a 1 × 1
   eyedropper pass can store `null` stats). Decide with a measurement whether `composite_tile` with blend modes is needed at
   all; the Canvas 2D `sampleRegion` already composites tiles at a level.
3. **C6 (d), the base**:
   - `basePx` built eagerly and `base.img` released;
   - the `canvas` undo step keeps base pixels (a free `clone()` on tiles) instead of the `<img>`;
   - `cropCanvasNow` through `resized`;
   - `resizeImageNow` is the one draw of the `<img>` itself: measure the resampler difference before dropping it;
   - `setBaseFromCanvas` / `flattenNow` / `mergeDownNow` decode their own upload again (transparency round trip: measure).
4. **C4** (after C6). Found by this session's map:
   - `snapshotRect` puts its box at `floor(x) - 2`, so `copyRect` shares **no** tile unless the box is tile-aligned: a stroke's
     undo step copies every tile its box overlaps. Align the copy to the tile grid on tiles.
   - `frozen` is left too high by every released step, every replace-restore, `selmove`'s `orig` clone, `layer._textUndo`, and
     the mask clones in fill / clear on a mask. Too high only costs a copy; **too low would write into a shared tile**, so a
     release must never let go of pixels the document still holds.
   - The redo copy of a `layerrect` grows 6 px per round trip.
   - `memoryReport` now counts chains, but not edge copies or undo-held old bases.
5. **The smudge tool on tiles** (measured in (b), not changed): 400–750 ms per pointer move at 15k, because it reads the 572 MB
   display mirror and builds a pyramid every move. It is a C5 stroke-store leftover; it needs its own step.
6. **`smoke`** once more before any release (check `/queue` first). The node repo is still at 647db5d, behind by C3, C5 and C6;
   `nodecopy` passes.

**Gate flakes seen this session** (re-run before believing):
- `commands_test.py` hung in `Page.captureScreenshot` after every step printed `[ok]` (2 of 4 full runs in (a)).
- `composite_test.py` once got a 1200 × 794 canvas against its 1200 × 800 reference and then crashed on `KeyError 'bytes'` in
  its own failure message (a one-line test bug, not fixed).
- `live_stroke_preview_shows_what_the_commit_writes` and the composite window step failed once right after a diagnostic instance
  was closed.
- The marching ants (120 ms) broke a screen comparison 2 in ~10 runs; steps that compare the screen draw the selection as a tint.

**Traps met on 2026-09-14 / 15:**
- A background `grep` loop on a workflow's `journal.jsonl`, meant to stop the workflow after its build agent, did not fire in
  time; the review round ran anyway. Stop a workflow by reading its journal by hand, or give it a phase switch in `args`.
- A copy-on-write copy that takes the original's chain buffer must take ownership: the last holder of the original writes into
  it in place otherwise.
- A whole thumbnail rebuild that asks for chains it then drops asks again forever (1.8 million requests); cells are kept per
  tile version.

## Where things stood (2026-09-14, night: C5 steps a to e are built and pushed)

**The block above supersedes this one's "Where the next session starts".** `docs/PLAN_BCE.md` §C5 "C5 as built"
is the record (five steps, each with its decisions, its measurements and its counter-proofs), plus
"Where C5 leaves the magic wand and the bucket, measured". `CHANGELOG.md` 0.1.13 has the five
user-facing bullets.

**The display mirror is gone.** On `main` (dff8b47, 4bd31a4, 28bfad0, 9152217, 2ddb163, pushed),
measured on a 15000 x 10000 document in tile mode:

- **(a)** The live stroke is composed in the **region the pass draws**, in a scratch of the window's
  size (`layerRegionView` / `refreshStrokeView`), not in a canvas as large as the layer filled from
  the layer's display **mirror**. First dab plus its frame **180.6 → 0.9 ms**, mirrors alive during a
  stroke **2 (1144 MB) → 0**, display pyramids **187.8 → 0**. The **base** also still drew through
  `displaySource` in a region pass (572 MB mirror + 188 MB pyramid on its own); it takes
  `drawTilesInto` now. On the **canvas backend** the same step takes 572 MB off a stroke.
- **(b)** A stroke is clipped and applied **band by band** (`strokePatch`, `strokeBands`,
  `StrokeBuffer.cells`), so `clippedStroke` / `p.clipCanvas` / `clipScratch` are gone. A 40-dab
  stroke across the picture clipped to a selection: dabs and frames **870.6 → 29.4 ms**, its commit
  **1312.6 → 281.6 ms**, and 1.12 GB of clip canvases gone.
- **(c)** The **stroke buffer is a sparse store** on tiles (`StrokeBuffer.draw()` replaces
  `ensure()`): that stroke's buffer **560.7 → 26.5 MB**. The gradient keeps the canvas buffer (it
  rebuilds the whole thing per move) and `paintShape` composes its transform now (C1 rule 12).
- **(d)** A transparency **mask is a sampler** in the atlas shader (`u_mask`, `a_muv`,
  `tileMaskOf`), so `layer._masked` is gone: **1.86 GB** (a 572 MB canvas, two 572 MB mirrors, a
  143 MB pyramid) and a mask brush's edit **253.3 → 1.2 ms**. One row got worse: a change to the
  **whole** mask 17.6 → 157 ms (2,400 mip chains rebuilt on the main thread) — that is C6's.
- **(e)** Grow, shrink and feather send only the **selection's box plus the operation's halo**
  through the worker, and invert walks the mask's own tiles (`MaskPixels.invert()` /
  `TileMaskPixels.invert()`). Blocked [wall] ms: grow **1288 [4237] → 273 [2305]**, shrink
  **1207 [3298] → 271 [1514]**, feather **1386 [2366] → 229 [592]**, invert **1535 [2742] →
  1047 [1047]**. The canvas backend gains too (grow 140 [2322] → 75 [1252]).

**Where the next session starts.** `docs/PLAN_BCE.md` §C5 ends with **"Where C5 leaves the magic
wand and the bucket, measured"**: the wand is `sampleCanvas` 153 ms + the flood **3,118 ms in the
worker** + writing a whole-picture answer into the mask **1,661 ms**, and the write was tried band
by band and got **30 times worse** (150 sub-rectangle draws from a 15000 x 10000 canvas). What is
left there is a flood over the whole picture — a kernel and a band question, phase E's, not mask
tiles'. **C6** is the next step by size: a whole-layer or whole-mask change rebuilds every visible
tile's mip chain on the main thread (157 ms for a mask at 15k), which is what C6's `mips` worker job
is for. **C4** is still the short clean-up it was (byte accounting and the `frozen` counter).
**Not built on purpose, with the measurement in the plan**: the compositor's three op modes for the
stroke store — with the compositor standing down for a gesture a stroke costs one 21.9 ms frame and
then 0.1 ms a dab, so they would buy that one frame.

**Gates** (fresh dev instances, own profiles, strict): `--tiles on` and `--tiles off` with `pixels
editor composite commands shape brush film glb ailabel size transparent generate log mcp nodecopy`
ALL PASS, and `--copy --tiles off pixels editor composite commands` ALL PASS. New gate steps:
`editor_test.py` `live_stroke_preview_shows_what_the_commit_writes` (seven gestures, the screen just
before the commit against the screen just after it, with a "the stroke really painted" floor),
`a_stroke_across_the_picture_keeps_only_the_tiles_it_touched`,
`gradient_tool_keeps_the_canvas_buffer_and_fills_the_layer` (the gradient tool had **no** gate at
all before), `grow_feather_and_invert_are_the_answers_a_whole_image_run_gives`;
`shape_test.py` `a_shape_dragged_smaller_leaves_nothing_behind`; `pixels_test.js` `mask_invert`;
and two rows in `perf_test.py` (`stroke across the picture (40 dabs)`, `its commit, band by band`).
**Twenty mutations, every one red** — they are listed per step in `docs/PLAN_BCE.md` §C5.
The benchmark rows were taken twice, the second time with the card free (ComfyUI's models unloaded
through `/free` on an empty queue); the numbers agree, so the A/B conclusions do not rest on a busy
card. **`smoke_test.py` did not run**: the user queued a video upscale in their ComfyUI while the
gates were going, our prompt sat behind it and hit the runner's timeout. Our own prompt was deleted
from the queue (`afa4d09d`); their jobs were not touched. A real Flux run is the one gate C5 owes.

**The node repo is untouched** and still at master 647db5d (built from scumble 7f01699), so its
`js/` is behind by C3 *and* C5. The `nodecopy` gate builds and tests the editor into a scratch copy
on every run and passes, so the build is sound; `python tools/build_node.py` + `node_test.py`
against the real repo is a deliberate step for whoever ships the next node version.

**Traps met on 2026-09-14 (night), worth keeping:**
- **A sub-rectangle draw from a very large canvas is not cheap.** Banding the wand's whole-picture
  answer into 150 draws of 1024 px cost **30x** one whole draw (1,661 → 49,525 ms). Bands only pay
  when the *source* of each band is small too.
- A `CanvasGradient` belongs to the context that made it; on tiles every dab draws on a scratch of
  its own, so a cached one has to be keyed by the context as well.
- Two gate flakes to recognise: `node tools/brush_test.js` hung once at exit under load (it had
  printed every PASS), and `closed_tabs_are_collected` failed once against an instance that had 50+
  tabs from repeated runs. Both passed on a fresh run; re-run before believing either.
- `tools/run_gates.sh` and the mutation helpers restore only the files they saved: a counter-proof
  that patches `inpaint_tiles.js` is not undone by a script that keeps `inpaint_canvas.js`. Check
  `git diff --stat` after a mutation round.

## Where things stand (2026-09-14, late: C3 steps a to d are built and pushed)

**Read this block first; it supersedes the "Next" line of the block below.** `docs/PLAN_BCE.md` §C3
"C3 as built" is the record (decisions, traps, the measurements, and **"What C3 still owes"**, which
is where the next session starts); `docs/PERFORMANCE.md` §9 has the C3 numbers.

**The screen draws tiles now.** On `main` (a8065ad, 2462b30, 11e4897, 4003194, c4a8281 plus two doc
commits, pushed), in tile mode:

- **(a)** `tileWithGutter(tx, ty, level, out)` on the tile store is one atlas slot: the tile at a
  level, **premultiplied**, with a one-pixel gutter of its neighbours' edge pixels; `extendTile()`
  gives the last tile of a row or column a clamp-extended copy before its mips are built, so the
  image's own edge does not fade by a level of mip.
- **(b)** The GPU compositor keeps an **atlas per (pixels object, level)** and draws the visible tiles
  instanced (`drawArraysInstanced`, the rectangles in image coordinates and the region a uniform, so a
  pan reuses the buffers). `glLayerSpec` hands a tile store over as itself with
  `floor(-log2(scale))`. Budget `settings.memory.atlasMB` (512, a row in Settings › Rendering), LRU by
  bytes; the pages go with the pixels (`forgetPixels`).
- **(c)** `regionCanvas(rect, level)` is the part of the pixels a view shows, from the tiles' mips
  (whole tiles, one tile of margin, two levels kept, one `putImageData` on a whole rebuild).
  `drawSelectionInto` draws the tint, the marching ants and the navigator from it.
- **(d)** `drawTilesInto` puts the **Canvas 2D** path on it too (`drawLayer`, for a plain layer in a
  view pass), which is the path a filter layer in the stack, a live stroke, a transform and compare
  force.

**The numbers** (15000 × 10000, `perf_test.py`, which has four new rows and a footer saying what the
display costs on tiles): first frame from fit to 1:1 on the GPU stack **1027 → 35 ms**, pan at 1:1 on
the Canvas 2D path **41 → 2.5 ms**, the opacity slider 56 → 8, a selection change 78 → 21, an undo
step 66 → 18, the worst `redraw with ants` frame 391-479 → 47-70, the document's display pyramids
**956 → 196 MB**, and the compositor holds 91 MB of atlas pages where the old path made a 600 MB CPU
mirror per source plus a GPU copy of it.

**What C3 still owes, and where to start**: `docs/PLAN_BCE.md` §C5 ends with **"Where C5 starts, as
the tree stands after C3"**, which names every site and the numbers to beat. In short: the **live
stroke's preview** is the last thing that makes
a display mirror (`layerWithStroke` copies the whole layer into a full-size canvas at the first dab:
355 ms and 1.1 GB at 15k, measured A/B) — that is C5's stroke store. The mask sampler (`u_mask`) and the three op modes C3 did not build
belong to that step, after which `WINDOW_PX` / `_source` / `_texture` and the display pyramid can go.
The seconds left in tile mode are C5's other half: grow / shrink / invert / feather 1.1 to 1.6 s, the
wands 1.0 to 4.4 s, the bucket 1.1 s, all of which still materialise the whole selection. **C4 is
not the next step**: C2 already replaced the undo steps' PNGs with copy-on-write clones, so what is
left there is byte accounting and a `frozen` counter, a short clean-up after C5. The full-resolution Canvas 2D path of exports, runs and the flattened composite still
reads the mirror; that is phase E.

**Gates** (fresh dev instances, own profiles, strict): `--tiles on` and `--tiles off` with `pixels
editor composite commands shape brush film glb ailabel size transparent generate log mcp nodecopy`
ALL PASS, `--copy --tiles off pixels editor composite commands` ALL PASS, and `smoke_test.py
--no-helpers` with a real Flux run in both modes (the queue empty before and after each). Every fix
has a counter-proof (a mutation of it is red): the gutter, the clamp extension, the premultiply, the
unpack switch, `forgetPixels`, the tile path itself, the region's origin, the region's dirty set, and
the Canvas 2D branch.

**Gate changes worth knowing**: `composite_test.py`'s gpu-vs-2d step now shoots **at 1:1 as well** and
that is the row it gates on tiles (the tile compositor must agree with Canvas 2D to the level there);
the fractional-zoom row is reported, like the window step's `fit` row. That window step checks the
**atlas** on tiles instead of the source windows (a pan **back** must upload nothing).
`editor_test.py` has `selection_overlay_is_drawn_from_the_mask_itself` (both backends, same expected
pixels) and its backend step now also checks the Canvas 2D path with a filter layer.

**Traps met on 2026-09-14, worth keeping:**
- **Chromium applies `UNPACK_PREMULTIPLY_ALPHA_WEBGL` to an `ArrayBufferView` upload too** (the WebGL
  spec says it applies to DOM sources and `ImageData` only). A canvas source uploaded earlier in the
  same frame leaves the switch on, and already-premultiplied tile bytes are then premultiplied twice:
  a text layer lost its anti-aliased edge (65 levels on 1,389 pixels) while every layer **on its own**
  was exact. Set both unpack switches explicitly before every typed-array upload.
- A benchmark row only measures what its document exercises: `perf_test.py`'s stack always carries a
  filter layer, so it never touched the GPU compositor and C3 (b) moved none of its rows until the
  three "GPU stack" rows were added.
- ComfyUI holding the card changes the op rows by 3 to 5× (`stroke commit` 336 → 845 ms with the same
  code). A/B any suspected regression in the same session before believing it.
- `run_gates.sh` hung once after every step of `commands_test.py` had printed `[ok]` (the runner's
  420 s timeout, not a failure); the re-run passed in a second.

## Where things stood (2026-09-14, morning: 0.1.12 released with C1 and C2)

**The block above supersedes this one's "Next" line.** `docs/PLAN_BCE.md` is the plan
(§C1 "C1 as built" with "The C1 close-out"; §C2 "C2 as built" with "The final C2 review", "C2 finished" and
**"What C3 inherits"**, which is where C3 starts); `docs/PERFORMANCE.md` §9 "C1" and "C2" hold the numbers.

**0.1.12 is released** (tag `v0.1.12` on main 7f01699, published 2026-09-14 06:59 UTC as Latest, CI build
run 34815555598; `latest.yml` on the public feed says 0.1.12, so installed apps update). On the user's
decision ("ein Release 0.1.12 mit C1 + C2", tag and publish after green exe gates) it carries:

- **C1**, the `LayerPixels` / `MaskPixels` interface (`renderer/editor/inpaint_pixels.js`), with its close-out.
- **C2**, the tile store (`renderer/editor/inpaint_tiles.js`) as the second backend behind **`ed.tileMode`**:
  `--tiles` / `--no-tiles` > env `SCUMBLE_TILES` (1 / 0) > a boolean `tiles` in settings.json (never written as a
  default) > on in dev, **off in the packaged app**; the node reads `localStorage["inpaint_canvas.tiles"]` (off).
  `status` reports `pixels: { tiles, from }`. Tile mode is not fit for users yet (15000 × 10000: stroke commit
  284 ms against 1, grow / shrink / invert / feather 1.2-1.5 s, renderer 3.55 GB for 12000 × 8000 against 0.49);
  canvas mode measured within noise of the build before C2 in every `perf_test.py` row.
- **The mask-undo fix**: c6bc6a6 (C1 close-out) had broken the undo of a mask brush stroke ("could not load
  true"); fixed before it shipped (branch `fix-mask-undo` 4644070, merged), step `mask_brush_stroke_undo_and_redo`.
- **The merge review's fix** (7f01699): the canvas backend's `drawInto` now also refuses an async callback, as the
  tile backend did; `docs/PLUGINS.md` has the two missing callback rules (no pixel reads from `ctx`, synchronous).

How it got there: `fix-mask-undo` fast-forwarded into main, `c2-tiles` merged (04cb406; one conflict in the undo
image loading, resolved to C2's form), release notes (1bcc2b0), a two-lens review with refuting verifiers (one
finding, fixed), then gates on 7f01699: dev strict `--tiles on` and `--tiles off` with pixels editor composite
commands shape brush film glb ailabel size transparent generate log mcp nodecopy ALL PASS, `--copy` ALL PASS;
`npm run dist` and on `dist/win-unpacked/Scumble.exe`: pixels editor commands ailabel brush glb composite mcp
PASS (tiles off, strict off, `tilesFrom` "packaged build"), `--tiles` pixels editor composite commands PASS,
smoke PASS (real Flux run, queue empty before and after). The CI installer is built separately from the local
one (same commit, not byte-identical).

**The node** (master 647db5d, pushed): `js/` built from scumble 7f01699 (now with `js/inpaint_tiles.js` and
`js/px/kernels_js.js`), `node_test.py` PASS, which also puts the mask-undo fix in front of git users. The Comfy
Registry publish of 0.3.2 ran (publish_action run 34814844844, success) and the version is
**NodeVersionStatusPending**. **For the user**: `https://api.comfy.org/nodes/comfyui-inpaintcanvas/versions`
lists every earlier version (0.3.1 down to 0.2.0) as **NodeVersionStatusBanned** with no reason given, so the
registry may never have offered an installable version; the reason should be on the publisher page at
registry.comfy.org. Nothing was changed about it.

**Still open, the user's calls**: the **v0.1.11 draft** release is still a draft (superseded by 0.1.12; publish
or delete it); the merged branches `c2-tiles`, `fix-mask-undo`, `px-spike`, `c0-editor-source` still exist on
the remote. `package.json` is **0.1.13** with an empty `## 0.1.13 — unreleased` section in `CHANGELOG.md`.

**Next (done since, see the block above): C3, the compositor draws tiles** (`docs/PLAN_BCE.md` §C3), on main. Start from "What C3 inherits": the
display mirrors and GPU screen copies to delete, the tile-mode costs with numbers, the per-document level-5 canvas
that was not built. Work the way C1 and C2 were built: a workflow per step (build, a three-lens review, two
refuting verifiers per finding, a fixer with a counter-proof per fix), the gate runner with `--tiles on` and
`--tiles off`, and node gates against a scratch copy (`build_node.py --node <copy>`, `node_test.py --node <copy>`)
until a step is meant for the node. The gate runner is **`bash tools/run_gates.sh <label> [--strict] [--copy] [--tiles on|off] [--exe PATH] <gates...>`**
(fresh instance on 9555, own profile with `test_base.png`, per-gate timeout, logs and `summary.txt` under
`dist/gates/gates/<label>/` or `$SCUMBLE_GATES`; gate `nodecopy` builds and tests the node in a scratch copy;
`tools/close_app.py` closes an instance by its DevTools port, `SCUMBLE_CDP_PORT`).

**Traps met on 2026-09-13 / 14, worth keeping:**
- **Chromium switches canvas acceleration off for the whole document** once at least 100 `getImageData` calls
  have disabled acceleration and they reach 95 % of all canvases the document ever created
  (`html_canvas_element.cc`): every new canvas without `willReadFrequently` is software from then on, and
  pan / stroke costs jump (64-107 ms pan with a filter layer). A test script with a screen readback after every
  step can trip it; ordinary use did not in 300 selection changes.
- An OffscreenCanvas never moves to the GPU and draws like a CPU `<canvas>`, but it **clips without
  anti-aliasing** (an arc clip 588 bytes apart): the `drawInto` rules allow clips on whole pixels only.
- A canvas 65,536 px on a side draws and reads nothing; 65,535 works.
- Skia's CPU raster is not exactly translation-invariant (a selection shape drawn far from the origin differs
  in about 600 pixels, alpha up to 68 levels, from the same shape on a scratch at the origin).
- `img.decode()` never resolves in a hidden window; wait for `onload`.
- Commit message files: reuse one and the next commit gets the old message (happened once on c2-tiles, fixed
  with a `--force-with-lease` of that branch).
- The node's publish action runs on a push only when `pyproject.toml` changes; otherwise
  `gh workflow run publish_action.yml --repo DenRakEiw/ComfyUI-InpaintCanvas --ref master`.

## Where things stand (2026-09-13, late: phase B and C0 built)

**Phase B is done** on the branch `px-spike` (pushed, fe9bf0e..cc3be22): `docs/PERFORMANCE.md`
§10 has the table and the decision **JS kernels** (Rust SIMD128 only 2.0 to 2.4× on the rule
rows, EDT band and opaque mip chain, in the Electron renderer in front, Node and Firefox).
`renderer/editor/px/kernels_js.js` holds the kernels C uses (tested by `node tools/px_test.js`),
the Rust crate is deleted (history at c75c4f1). Binding findings for C/E: tile buffers copied
into each other start on a 4 KB boundary (4K aliasing), V8's efficiency mode slows JS 1.5-2×
when the window is not in front, tile size 256, today's `floodMask` beats the flood twin.
`docs/PLAN_BCE.md` §B3 and its §4 table carry the outcome.

**C0 is done** on the branch `c0-editor-source` in **both** repos (app 83f12dd, based on
px-spike; node 6494fc2 + 689df64, based on master 83887b6), pushed, **not merged**:
`renderer/editor/` is the source of the editor, `tools/sync_editor.py` and `docs/SYNC.md` are
gone, `docs/BUILD_NODE.md` explains `tools/build_node.py` (writes the node's js/, `--check`
verifies parsing, imports and that every `host.*` exists in both hosts) and
`tools/node_test.py` (the node's flavour against ComfyUI stand-ins, no ComfyUI needed).
Gates PASS on a fresh dev instance: editor, composite, shape, brush, commands, film, glb,
ailabel, size, transparent, generate, log, mcp, node_test (commands and film need
`files/input/inpaint_canvas/test_base.png` in the test profile's mirror; copy it from
ComfyUI's `input/inpaint_canvas/`). `package.json` 0.1.11 with its CHANGELOG section.

**Closed on 2026-09-13 (after the hand-over above was written):** ComfyUI was started by
the user; `smoke_test.py --no-helpers` PASS (real Flux run 72.5 s, queue empty before and
after) and the node checked in a real ComfyUI tab (extension registered, node created, editor
opened as an overlay with title and close button, no Inpaint Canvas console errors). On the
user's go: px-spike and c0-editor-source merged into the app's main and the node's master
(which fixes the broken node for its users), 0.1.10's CHANGELOG bullets folded into 0.1.11
(0.1.10 was never tagged), tag v0.1.11 pushed. **The workflow builds a draft release; run the
exe gates on its installer (the recipe in the 2026-09-12 second block) and publish the draft
only on the user's go.** The node's `pyproject.toml` version was not bumped, so the Comfy
Registry does not ship the fix yet (that is the user's call too).

**Next**: C1, the `LayerPixels` facade with a canvas backend (`docs/PLAN_BCE.md` §2 C1, its
own release 0.1.12; bump `package.json` and open the CHANGELOG section first).

## Where things stand (2026-09-13)

**The implementation plan for phases B, C and E is `docs/PLAN_BCE.md`** (written 2026-09-13
after reading the code line by line; it wins over `docs/PLAN_TILES.md` where they differ). It
is the file the session that builds the tile engine follows: B0 to B3 (the Rust spike, no
Rust toolchain is installed on this machine yet), C0 (`docs/NEXT_PLAN.md` 4b, the editor
source moves into this repo), C1 (the `LayerPixels` facade with a canvas backend, the one
migration of the 277 sites, its own release), C2 to C7 (tiles, atlas compositor, undo as tile
refs, stroke store, mips in the worker), E1 to E6 (COOP/COEP, the worker pool over a
`SharedArrayBuffer` arena, bands, streamed PNG / PSD / ORA, filters with halos, the 30k gate).
Every decision is in its §4 table; every step names its gate. Phase D is deliberately not in
it. The user's go for B was given on 2026-09-13 ("wir machen dann einen clear und opus wird
den plan umsetzen"); ask once, in one sentence, after B's table before starting C0.

**Phase A of `docs/PLAN_TILES.md` is built**, on the user's "starte den geplanten Umbau, Phase 1"
(2026-09-12 late; the plan's phases are lettered, A is the first): five items, each in the node
repo first (commits 0c3ce45 A1, 009320e A4, 9bf54c0 A3, 5dd1dbb A2, 83887b6 `DEVELOPMENT.md`
§23) and synced, A5 app-only (`electron/main/gpumem.js`, the memory watch, Free VRAM), each with
its gate step (`editor_test.py`: selection undo / bounds, wand and bucket region, stroke
buffers; `composite_test.py`: source windows) and its commit. `docs/PLAN_TILES.md` §7 says what
was built and how it differs from the plan, `docs/PERFORMANCE.md` §9 has the before / after
table, `docs/BUGS.md` the 15k entry updated, `CHANGELOG.md` the 0.1.10 bullets. Gates at the
end: editor, shape, brush, composite, commands, film, glb, ailabel, log all PASS on the dev
instance; `docs/COMMANDS.md` regenerated (the `status` command's memory carries the card).
`smoke_test.py --no-helpers` PASS (a real Flux run, the ComfyUI queue empty before and
after), `npm run dist` built `Scumble Setup 0.1.10.exe`, and the editor, composite, commands,
brush, glb, ailabel and shape gates PASS against `dist/win-unpacked/Scumble.exe` on its own
profile. Both repos are pushed. **The 0.1.10 tag waits for the user's go** (the section in
`CHANGELOG.md` is written).
**Not verified by the user**: nothing of phase A has been tried on their own 15k file; the
first thing to ask for is the card's numbers from Settings › Rendering while it stutters.

**What phase A found, and what the next session should know**: a readback on a GPU canvas
costs whatever is queued before it (0.5 to 1.2 s for 2048² right after a fill), so the wins
came from fewer and smaller readbacks; the film plugin's panel flattened the whole document at
full resolution on every change (fixed, `Document.flatten({ maxSize, box })`); a
`willReadFrequently` canvas is no saving in Chromium 152; `destination-in` and `copy` apply
to the whole canvas, a regional one needs `clip()` first; the benchmark's op rows swing by
hundreds of ms between runs on the shared card, so restart before a run and read the first
one. Per-document memory (2.3 GB layers, 0.95 GB pyramids, 0.57 GB base and selection each
at 15k) is untouched: that is phase C, and the decisions in `docs/PLAN_TILES.md` §6 (1, 3, 4)
are still the user's.

**Traps met on 2026-09-13**: a Bash-tool heredoc turns `\\n` in a Python source into a real
newline (write the script with the Write tool, or use the Edit tool); the test document
`window.__t` of `editor_test.py` is 600 × 300 by the time later steps run (call `new_canvas`
first); Chromium keeps a small canvas in software, so pixels from a buffer that grew onto the
GPU differ from an all-GPU canvas by a few levels; a preview's regional `destination-in`
needs a clip region.

## Where things stand (2026-09-12, evening)

**0.1.9 is released** (tag `v0.1.9`, published 2026-09-12 16:13 UTC, `Scumble-Setup-0.1.9.exe`
plus `latest.yml`, so the apps in the field update themselves). **Before the next change ships:
bump `package.json` to 0.1.10 and open a `## 0.1.10 — unreleased` section in `CHANGELOG.md`.**
Both repos are clean and pushed. What the user owes: the *Help › Console › Copy all* output of a
failed gpt-image run and of a Comfy Cloud run on 0.1.9, and whether *"Base selected."* appears
in the erase bug (`docs/BUGS.md`). What comes next (0.1.10): those two provider fixes, then the
15k document measured (`perf_test.py 15000x10000`, `app:metrics`) before anyone builds tiles.
**Measured on 2026-09-12** (the 15k entry in `docs/BUGS.md`): the frame path is at the screen's rate,
the stutter is memory (4.3 GB VRAM per 15k document, shared with ComfyUI) and whole-document
steps; `docs/PLAN_TILES.md` is the plan (phase A quick wins, phase B Rust spike, phase C tiles),
waiting for the user's decisions listed at its end.
**The user's decision on 2026-09-12 (late): "ja, die Performance muss maximal besser
werden", and then "noch nicht umsetzen, nur planen".** So the plan is approved in principle
and **nothing of it is to be built until the user says go**; phase A (the quick wins) is the
first thing to build when they do, with the notes at the end of `docs/PLAN_TILES.md`. The
only change made: `package.json` is 0.1.10 with an empty `## 0.1.10 — unreleased` section in
`CHANGELOG.md` (the standing rule before any change ships). The four decisions the plan asks
for (VRAM check on the user's machine, phase A, the Rust spike, phase C with `NEXT_PLAN.md`
item 4b) are still open one by one.

**The five steps of `docs/PLAN_0_1_7.md` "Build order after 0.1.8" are built, each with its
gate, its commit and its push** (a to e, in that order, node repo first where the editor
changed, then `tools/sync_editor.py`). Per step:

- **a, Escape closes the Settings and Generate-new dialogs.** One line in the node's
  `_docKey`: a key whose target sits inside `dialog[open]` returns early. Gate
  `escape_closes_the_shell_dialogs` in `tools/editor_test.py` (a synthetic keydown for
  `defaultPrevented`, a real key through CDP `Input.dispatchKeyEvent` for the native close;
  the runner takes Python callables as steps for that). Red on the old code, green after.
- **b, SVG import.** Done in the editor, not the mirror: `isSvgFile` / `svgSize` /
  `rasterizeSvg` (node repo) turn the file into a PNG before the upload; `loadFile(file,
  { size, ask })` asks with the size dialog (prefilled with the declared size, else 2048 on
  the long side, ratio tied by default: `ask()` takes `linked: "on"`), `addImageLayers` fits
  it to the document without asking, `load_image` takes `width` / `height` and never asks.
  `mimeOf` and the Open dialog know `.svg` too. Gate `svg_import_rasterises_on_the_way_in`.
- **c, the EU AI label plugin** `plugins/ailabel/` (`docs/PLUGINS.md` built-in list). The
  twelve Commission SVGs ship with a `NOTICE` (source URL, the verbatim terms: "publicly
  available for everyone to use freely, without the need for attribution"; no named licence;
  **the user approved shipping them on 2026-09-12**). `black` in a file name is the black pill
  with white letters, `white` the white pill with dark letters, `transparent` the pill at
  50 %. Panel, two actions, commands `ailabel.add` / `remove` / `info`; adding again replaces;
  command arguments never change the panel's stored settings. Gate `tools/ailabel_test.py`.
- **d, custom brushes** (`docs/BRUSHES.md`). The reader now parses the `desc` block
  (Photoshop's Action Descriptor, which neither GIMP nor abrupng reads) and maps names and
  spacings to the bitmaps by UUID; verified on Photoshop 2026's three packs and a 377 MB
  third-party pack (every bitmap named, every desc block consumed to its last byte). Tips
  persist through `electron/main/brushes.js` (`<userData>/brushes/`), `host.brushLibrary` is
  shared by every tab. Spacing slider, *Follow stroke*, thumbnail, box cursor, Remove; the
  eraser stamps a tip through the same path. Commands `list_brush_tips` / `set_brush`. Gate
  `tools/brush_test.py` (runs `node tools/brush_test.js` first). The node's `DEVELOPMENT.md`
  §22 has the format notes.
- **e, the GLB layer plugin, stage 1** `plugins/glb/` (`docs/GLB.md`). three.js 0.186
  vendored by `tools/vendor_three.py` (2.3 MB, the npm package has no minified ES build), the
  dialog with the picture as the backdrop, colour pass with alpha cropped to the object,
  depth pass with the near / far planes hugging the object, the file in the local store and
  the parameters in the plugin storage by layer id, *Edit* in place. Commands `glb.place` /
  `edit` / `info`. Gate `tools/glb_test.py` (a cube written as a glTF binary by the test).
  **Found on the way: `scumble.storage.get()` returned a promise**, so no plugin had ever read
  its data back (the film pack's group, the label's settings). `renderer/plugins.js` loads the
  data before `activate` and serves `get()` from a cache now; `set` writes through.

**Provider adapters, corrected by the user on 2026-09-12**: FLUX over BFL, Nano Banana over
Google and Seedream over fal **have run live and work**. OpenAI gpt-image still had problems
on the user's side, and the user reports the OpenAI extras (transparent background) as missing
in their installed version; Comfy Cloud "seems not to work". Details of both failures were
still being collected. Everything in this file that says "no adapter has ever run live" is
older than this note.

**Second block of 2026-09-12 (after the five steps)**, one commit: the installer was built
(`npm run dist`) and **every gate ran against the packaged exe** on its own profile (commands,
ailabel, glb, brush, editor, `mcp_test.py --exe ... --user-data-dir <dir>` in proxy mode 0.8 s,
`smoke_test.py --no-helpers` with a real Flux run): plugins, vendored three.js and brushes work
from the asar. `mcp_test.py` got `--user-data-dir` (the launcher forwards it; it must come
*before* `--cmd`, which otherwise takes it for its JSON) and its raw step closes stdin (an open
stdin kept the relay alive, 180 s timeout). **Comfy Cloud** failures read the node's exception
from the job history (`failureDetail` in `comfycloud.js`, exported for tests; the status endpoint
says only "error", which is what the user saw). **API resolution rows default to 2K** wherever
offered. **Normalise filter** (node repo `colourStats` / `applyNormalize`, app GL mode 7 in
`inpaint_filters_gl.js`, gate step `normalise_filter_moves_colours_to_the_mean_on_both_paths`
in `editor_test.py`, GPU vs CPU max 2 levels). **Export Canvas row** (frame, anchor, fill;
`export` takes `canvas_width` / `canvas_height` / `anchor` / `fill`; step
`export_canvas_frames_the_picture`). Gates after: editor, commands, size, composite PASS,
`docs/COMMANDS.md` regenerated. **0.1.9 is released** (tag `v0.1.9`, the workflow built `Scumble-Setup-0.1.9.exe` plus `latest.yml`, the draft published 2026-09-12 on the user's go; `package.json` needs the bump to 0.1.10 and a new `CHANGELOG.md` section before the next change ships).

**Third block of 2026-09-12: the console and the log file** (plan §3, which the plan had
called done although nothing existed; asked for again after the bare Comfy Cloud "error").
`electron/main/log.js`, IPC `log:*`, `read_log`, the renderer capture at the top of
`shell.js`, `#log-dialog`, `host.hookStatus` (status title, click opens the console, error-
looking status texts logged), provider failures logged with the request's shape in
`providers/index.js`. Gate `tools/log_test.py`. The file is `<userData>/logs/scumble.log`;
when the user reports an error, ask for *Help › Console › Copy all* or that file.

**Fourth block of 2026-09-12, last before the release: edge snapping while scaling.** Asked
for as "wie ein Magnet leicht einrasten" when a layer is dragged to the full picture.
`snapScale()` in the node's editor (synced) runs after `applyScale()` in the unrotated scale
gesture: the dragged edges snap to the canvas edges, its centre and the guides within 8 screen
px by shifting the pointer and re-applying the scale (so a kept aspect stays consistent), Alt
keeps it free, rotated layers are not snapped, the pink guide lines show for scaling too. Gate
step `scale_snaps_to_the_canvas_edges` in `editor_test.py`.

**Also on 2026-09-12**: the GitHub description of `DenRakEiw/scumble` no longer says
"Krita-style" (asked for during the session; changed with `gh repo edit`). The Normalise
filter the user asked about is built (see the second block).

**Traps met today, worth keeping**: a long Python heredoc in the Bash tool failed to parse
with "unexpected EOF" (write the script with the Write tool instead); Chromium fires only
`cancel`, not always `close`, on a `<dialog>` closed by a real Escape; `.ipc-view canvas` is
`position: absolute; width: 100%`, so a canvas placed in the options bar needs inline size
and `position: static`; the layers of a document reach the local store through
`ed.syncLayers()`, which the autosave calls on its own timer, so a test that reloads right
after a change has to call it first.

**Gates at the end of the session**: every gate ran against the packaged exe on its own
profile (`editor`, `commands`, `ailabel`, `brush`, `glb`, `mcp_test.py --exe ... --user-data-dir`,
`smoke_test.py --no-helpers` with a real Flux run) before the release, and `log_test.py`,
`editor_test.py`, `commands_test.py`, `ailabel_test.py` on the dev instance after the last
changes. `docs/COMMANDS.md` regenerated (72 commands, `read_log` is the newest).

## Where things stand (2026-09-11, late)

**Read `docs/BUGS.md` first.** The vanishing layer is fixed (first bullet below). What is
left open there: the erase that "switches to the base" (probably the same bug seen from the
other side, one question to the user still unanswered) and the jerky 15k document.

**0.1.8 is released** (v0.1.8, published 2026-09-11 21:05 UTC, installer 187 MB plus
`latest.yml`, so the apps in the field update themselves): the vanishing-layer fix below,
the marquee click fix and the *Highres fix* rename. 0.1.7 (16:56 UTC the same day) carried
the transparent OpenAI results. `package.json` is **0.1.9** with an unreleased
`CHANGELOG.md` section holding the model folder scan; the tag waits for the user.

**Built on 2026-09-12: the model folder scan** (Settings › Helpers, *Scan folder*; asked for
as "den ComfyUI models folder angeben, scannen, automatisch verknüpfen"). `scanFolder` /
`matchScan` in `electron/main/onnx/models.js` attribute every ONNX file in the folder to a
registry entry by exact name, by the registry's exact byte size (unique sizes only: the four
SAM2 decoders share one) or by the Hugging Face snapshot layout, store the links in
`settings.helpers.links`, and report PyTorch weights per model in `elsewhere`. **On the
user's own ComfyUI folder the honest result is: nothing linkable** (SAM2 and RMBG are there
as `.safetensors` / `.pth`, which ONNX Runtime cannot load), and the row now says so instead
of "not downloaded". `docs/HELPERS.md` "The folder scan". Gate `node tools/scan_test.js`.

**The plan for the sessions after a /clear is `docs/PLAN_0_1_7.md`**, "Build order after
0.1.8": §7 Escape in Settings, the SVG import entry, §8 EU AI label plugin, §6 .abr brushes,
§9 GLB layer plugin. The user wants them built one after the other; each has its gate.

**Fixed after 0.1.7, in 0.1.8:**

- **A whole layer vanished from the screen after an erase nowhere near it** (the two screen
  recordings of 2026-09-11; `docs/PERFORMANCE.md` phase 5 bug 3 has the write-up). Reproduced
  on the first try once the *real pointer handlers* were driven on a zoomed-out view and the
  **screen** was read, not a full-resolution composite: layer alpha 111,000 before and after,
  the composite green, the screen white. `touchSourceRect` refreshed the stroke's rectangle in
  each pyramid level with `globalCompositeOperation = "copy"`, and Chromium applies `copy` to
  the whole canvas, so the level kept only the strip around the stroke; both paths draw from
  that level below 0.5 zoom. Now `clearRect` plus `source-over`. Fixed in the node repo and
  synced (the sync touched only those nine lines); the node's `DEVELOPMENT.md` §21e has the
  rule. Gate: `editor_test.py` step `erase_stroke_keeps_the_rest_of_the_layer_on_screen`,
  which reads white for the far block on the old code. `composite_test.py`, `commands_test.py`
  and `shape_test.py` PASS after the change. It also explains the first recording (erasing
  "took rectangular chunks out": only the last stroke's rectangle of the layer stayed visible)
  and very likely the "erase switches to the base" report.
- **A marquee click left a small selection behind when zoomed out.** Rectangle and ellipse
  had no drag threshold, so a hand that wobbled by one screen pixel drew a rectangle of
  whatever that pixel is worth in image space: on a 15k image about eleven image pixels,
  right under the cursor, instead of the deselect the click was meant to be. Brush and
  eraser are clipped to the selection, so retouch then stopped with nothing on screen to
  explain why. Measured in screen pixels now, `startPx` plus a three pixel threshold.
  Verified against the old path: the same wobble leaves 6000,5000 to 6011,5009 before and
  nothing after. `tools/editor_test.py` has the case; it only ever exercised the click
  *inside* a selection and the lasso, which is why it stayed green.
- **The brush ring never disappears again.** It was a one pixel line in the paint colour, so
  painting red over red left no cursor at all, and a 400 px brush on a small layer looked
  like a tool that fills rectangles. Dark halo underneath now, and it moved into
  `drawBrushRing(ctx, s)` so a test can draw it into its own canvas.
- **The *API size* row is *Highres fix*** and its choices read without a tooltip: Maximum,
  2x crop, 4x crop, Target size, Off (crop size).
- **The prompt templates were never loaded at start.** `host.promptTemplateIds` and
  `refreshPromptTemplates()` sat *inside* `saveCompat()` in `shell.js`, so no template
  appeared until the Settings dialog had been opened once, and "Generate a new image"
  offered none at all.

**Built but not verified: brush tips from Photoshop .abr files.** `js/inpaint_brushes.js`
(node repo, synced) reads the format after GIMP's `gimpbrush-load.c` and scurest/abrupng,
both GPL-3.0: versions 1 and 2 are a flat list, 6 and 10 keep the sampled brushes in an
`8BIM` `samp` block, PackBits per row, computed round tips skipped. The brush stamps a tip
instead of the round dab, with the file's own spacing, and a Tip select plus Import sit next
to the colour in the tool options bar; images work too. **The reader is proven only on a
synthetic version 1 file** (size, spacing, alpha polarity, where the stored value is the
coverage the way GIMP reads it). Nothing has met a real pack or a version 6 file, the
stamping has no gate, and imported tips do not survive a restart.

## Where things stand (2026-09-11)

**A 15k PNG is still jerky to work on** (reported 2026-09-11, the first entry in the new
`docs/BUGS.md`). Not reproduced or measured here, and the PNG-versus-JPEG part of the report
is not confirmed: after decoding, the format cannot matter, so either the encode on the
autosave path or a difference in pixel size explains it. The size is under the compositor's
16,384 limit, so this is **not** the documented Canvas 2D fall-back; the first suspect is the
memory the untiled full-resolution layers hold. The bug entry says what to measure first.


**Transparent results from the OpenAI image models** (2026-09-11, asked for after reading
`developers.openai.com/api/docs/guides/image-prompting`). `background: auto | opaque |
transparent` is an ordinary settings row on the `openai` variant of the three gpt-image
recipes, and the row is the whole switch: `host.supportsTransparency()` looks for it, the
Generate-new dialog shows its checkbox for it, `docs/RECIPES.md` "Transparent results" has
the contract.

- **The stitch is where it matters.** `finishResult()` used to overwrite the answer's alpha
  with the composite mask, which threw a cut-out away. With `info.keepAlpha` (set in
  `host.runProvider` from the run's own parameters) the model's alpha is **multiplied** by
  the blend mask instead: a clean cut-out keeps its edges, a model that ignored the request
  behaves exactly as before, and there is no hard rectangle either way. Colour match is
  skipped for such a run. `transparentPixels()` (a 128x128 grid sample) says in the status
  line whether transparency really came back.
- **The whole OpenAI parameter set** is in the adapter now: `background`, `output_format`,
  `output_compression`, `moderation`, plus `sizeFor(model, w, h)`, which holds a free size
  inside each model's own rules. A transparent JPEG is sent as PNG. **`input_fidelity` was
  being sent to exactly the wrong model**: the docs say to omit it on gpt-image-2 (always
  high fidelity) and it belongs to 1.5 and 1, so the recipe row is gone and the adapter
  gates on the model id.
- **GPT Image 2.5 reaches 3840 px** (was 2048): both edges a multiple of 16, ratio at most
  3:1, total 655,360 to 8,294,400 px. The floor needed a new limit, **`minPixels`**
  (`editLimits()` in `recipes.js`, honoured in `prepareCrop()`), because a small selection
  would otherwise be refused. `text.sizes` for 2.5 is 1024 to 3840.
- **`generate_new` takes `background`**, the dialog has a *transparent background* tick that
  appears only for a variant with the row, and a local recipe refuses it with a clear error.
  For an edit run the MCP path is `set_settings({ background: "transparent" })`.
- **A built-in prompt template `transparent-asset`** writes the cut-out wording (the docs are
  explicit that the parameter alone is not enough), offered for the OpenAI recipes.
- **Fixed on the way**: `host.promptTemplateIds` and `refreshPromptTemplates()` sat *inside*
  `saveCompat()` in `shell.js`, so no template was loaded until the Settings dialog had been
  opened once and the Generate-new dialog offered none. They run at module start now.
- **Gate: `python tools/transparent_test.py`** (8 steps; the first runs the adapter's
  `_sizeFor` / `_common` in plain Node, the rest drive the loopback provider, which answers
  a `background: "transparent"` request with an opaque disc on a transparent ground).
- **Not verified**: no OpenAI key has ever run through this. fal, WaveSpeed and Comfy Cloud
  may pass `background` to the same models and are deliberately **not** wired for it, because
  nothing in their schemas was checked.

**Photoshop and Krita are gone from the descriptive text** (2026-09-11, asked for). README,
the MCP server instructions, the CHANGELOG entries, `docs/BRIEF.md`, `docs/PLAN_0_1_7.md`,
this file, and two editor tooltips (changed in the node repo and synced). **Still there on
purpose**: the code comments in the synced editor files (about 35, they explain why
something behaves the way it does) and the prior-art citations in `docs/PERFORMANCE.md`,
where the names carry the source links.

**Gates after both changes, on a dev instance with its own `--user-data-dir`**:
`transparent_test.py` PASS, `size_test.py` PASS, `generate_test.py` PASS,
`commands_test.py` PASS, `composite_test.py` PASS (gpu vs 2d max 1 level),
`smoke_test.py --no-helpers` PASS (72 s real Flux run, the ComfyUI queue empty before and
after). `docs/COMMANDS.md` regenerated. `package.json` is **0.1.7** and `CHANGELOG.md` has
its `## 0.1.7 — unreleased` section; the tag waits for the user.


**The next five items are planned in `docs/PLAN_0_1_7.md`** (written 2026-09-11 with the user,
in the order to work them): the prompt template upload under the dialog's dropdown, the
`draw_shape` command, a console and a log file, a liquify brush, and Python plugins. Items 1 to 3
are 0.1.7, items 4 and 5 are 0.1.8. That file also carries what stays open after them.

**The "Generate a new image" dialog is fixed** - it no longer grows a scrollbar and no longer
clips the Upsample button. Confirmed by the user on 2026-09-11, off the list.

**0.1.6 is released and both repos are pushed** (`gh release list`: v0.1.6 published
2026-09-11 10:48 UTC, `CHANGELOG.md` has its dated section). `package.json` is still 0.1.6;
the next release needs the version bump and a new `CHANGELOG.md` section first.

**The emitted crop follows the provider, not one global number** (2026-09-11, asked for as
"beste Qualität, das Maximum der Anbieter ausreizen"; `docs/RECIPES.md` "How big the crop goes
out"). Every API run used to send a 1024 px crop because `nodeParams.target_size` governed the
local *and* the API path, while the adapters pass whatever size they are handed straight on.

- A provider variant now carries `limits` (`{ min, max, step, pixels }`, normalised by
  `editLimits()` in `electron/main/recipes.js`, a recipe-level `limits` covering all its
  variants). **FLUX.2 and FLUX.1 Fill are capped at 1440** - the user measured an error at
  2048 - **gpt-image at 2048 with an 8,294,400 px budget** (the OpenAI partner node's own
  rule), **Seedream 5 on fal at 4096 with a 4 MP (pro) / 16 MP (lite) budget** and on Comfy
  Cloud at 2496 / 4992, everything else keeps the conservative default `{256, 2048, 16, 0}`.
  Raise one with a source; most providers' real maxima are still unverified. **fal serves the
  schema without a key** - `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>` -
  and Seedream's turned out to be an *area* budget rather than a side limit, which is what the
  first pass got wrong. A variant may override the recipe's `limits`, which is how the fal and
  Comfy Cloud numbers sit in the same recipe.
- `host.cropLimits()` merges those limits with **`host.apiSize`** (`settings.apiSize`, the
  *Highres fix* select built in `buildGenerateExtras`, app-only, no sync patch): `max` (default),
  `x2`, `x4` (the high-res fix the user asked for: the crop at twice / four times its own
  size, still under the ceiling), `target`, `crop`. `prepareCrop(editor, params, limits)` in
  `renderer/editor/stitch.js` resolves it in `emitTarget()`; **a ComfyUI recipe gets null and
  is untouched**, because there the node crops.
- Gate: **`python tools/size_test.py`** (9 steps, loopback only, no ComfyUI and no key).

**Seven models added** (2026-09-11): `z_image_turbo` (fal `fal-ai/z-image/turbo/inpaint`, a
real **mask** endpoint - only the second one after Qwen and FLUX.1 Fill), `ideogram_4`
(`ideogram/v4/image-to-image`, no mask), `grok_imagine` (`xai/grok-imagine-image/v2.0/edit`),
`reve` (WaveSpeed `reve/2.1/edit`), and three **text-to-image-only** recipes, `krea_2`,
`recraft_v4`, `z_image`. 22 recipes now.

- Ids read from fal's own model index on 2026-09-11 (`https://fal.ai/api/models?keywords=x`
  lists endpoint ids, `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>` gives
  the input schema - **use those two URLs, they answer without a key**). Reve came from
  `wavespeed.ai/models/reve`; its input field names are WaveSpeed's edit convention and are
  **not** verified.
- New variant flag **`edit: false`**: the variant has only a `text` shape, and
  `host.runProvider` refuses with "use Generate new, not Generate". Two small fal adapter
  switches came with it: `fields.mask = false` (an image-to-image endpoint without a mask,
  Ideogram 4) and `options.omit` (fields a strict endpoint refuses; Recraft V4 takes neither
  a seed nor an output format).
- Ideogram 4, Krea 2 and Recraft V4 have **no masked edit endpoint at all** on fal; Ideogram
  is wired as a whole-crop image-to-image with a Strength slider and the stitch keeps the
  selection.

**Gates after the change, all on a dev instance with its own `--user-data-dir`**:
`size_test.py` PASS, `commands_test.py` PASS, `generate_test.py` PASS, `smoke_test.py
--no-helpers` PASS (real Flux run, the ComfyUI queue empty before and after). The *Highres fix*
row was checked live in the Generate section. **Not done**: no adapter has run against a live
API, and the size ceilings of Nano Banana, Seedream, Qwen and the new models are the
conservative default rather than the providers' own numbers.

**A shape tool** (2026-09-11, after comparing our tool column with other editors'): rectangle,
ellipse, polygon, polyline, Bezier and freehand, filled and/or outlined, key **Y** (U belongs to
the film plugin's control points). Written **in the node repo** and brought over with
`python tools/sync_editor.py`, so it is not a patch and the node has it too; the sync round trip
touched only `inpaint_canvas.js`. Rectangle / ellipse / freehand reuse the `layerpaint` pointer
with a stroke buffer that `shapeDab()` redraws on every move, which is where the live preview,
the clip to the selection, the brush opacity and the undo step come from; polygon / polyline /
Bezier collect `shapePoints` and draw as an overlay until `finishShape()`. `paintShape()` sets a
transform from image to layer pixels, so the outline width is in image pixels whatever the
layer's own resolution is. Gate: **`python tools/shape_test.py`** (12 steps, reads the pixels
back). **Not built**: shapes are pixels, not editable objects, and there is no `draw_shape`
command for MCP yet.

**The transform tool already has Distort and Warp** - I claimed otherwise on 2026-09-11 and was
wrong. `subModeButtons` in the node's editor has scale, rotate, distort (drag the four corners,
a perspective) and warp (a grid). Only a liquify brush is missing.

**Export can save smaller** (2026-09-11, asked for with a screenshot of another editor's Export As):
a Size row under the editor's Export row takes a percentage or a free width and height, and
JPEG / WebP got a Quality row under it. `host.exportCanvas(editor, fmt)` and
`host.exportQuality(editor)` are two new sync patches in `exportImage()` (the third change,
the status line naming the written size, was folded into the existing `saveExport` patch -
**patches must not overlap another patch's replacement text**). Everything else is app-side in
`host.js`: the per-document state, the row, and `resizeForExport`, which walks a big reduction
down in halving steps because one bilinear draw skips pixels below half size. PSD and ORA stay
full size (their layers would each have to be scaled) and the row disables itself for them. The
`export` command takes `scale`, `width`, `height`, `quality` and restores the document's own
setting afterwards; `commands_test.py` has the step, `docs/COMMANDS.md` is regenerated.
**Not built**: canvas size (the working area around the image), 8-bit PNG, and a resampling choice.

**A console / log panel is on the list and not built** (asked 2026-09-11 after a Comfy Cloud
run with gpt-image failed): an error only reaches `editor.setStatus()`, `.ipc-status` clips it
with an ellipsis and has no `title`, the full text lives only in the renderer DevTools console,
and the main process - where the adapters run - logs nowhere.

## Where things stood (2026-09-10)

**Release 0.1.5 is prepared but not tagged** (2026-09-10, night). `package.json` is 0.1.5 and
`CHANGELOG.md` has a 0.1.5 section with the two items below. The tag waits for the user's
go-ahead: `git tag v0.1.5 && git push --tags`, then `gh release edit v0.1.5 --draft=false`.

**0.1.4 was already released** (tag `v0.1.4`, published 2026-09-10 12:26 UTC with the
installer and `latest.yml`, so the apps in the field are on it). The paragraph in this file
that called it "prepared but not tagged" was stale, and following it cost a detour: the
0.1.4 section was folded into 0.1.5 and had to be put back. **Check `gh release list` before
believing a release note here.**

**`docs/NEXT_PLAN.md` items 1 and 2 are done, 3 was already done, 4 is untouched.** The file
stays as written: it is the record of the two decisions in item 4 (blur as a shader pass,
recommendation *not now*; the editor source moving into this repo, recommendation *yes, after
0.1.5*). Neither is to be built without the user's yes.

- **Item 1, the MCP handshake** (`electron/main/mcp/launch.js`, `docs/MCP.md` "Why the
  launcher exists"). Electron writes a CR LF to stdout before any of our JavaScript runs and
  it cannot be suppressed from the app; the Python `mcp` client kills the whole session over
  it. The launcher is a plain Node script the same executable runs in Node mode
  (`ELECTRON_RUN_AS_NODE=1`, which prints nothing and can read the packaged asar): it spawns
  the app as a child with that variable removed, relays stdin, and drops the **leading** run
  of CR / LF / space bytes from the child's stdout before passing everything else through
  untouched. `.mcp.json`, `tools/mcp_test.py` and the docs register the launcher;
  `Scumble --mcp` still works directly for tolerant clients and for scripts. **Help > Copy
  MCP registration** (two entries, `mcpRegistration()` in `main.js`) puts the `claude mcp
  add` line or the Claude Desktop JSON with the real install paths on the clipboard, because
  nobody types an asar path by hand; the renderer answers with a status line
  (`menu` command `mcp-copied`).
- **Item 2, prompt upsampling on a local OpenAI-compatible server** (`askCompatible` in
  `electron/main/llm.js`, `docs/HELPERS.md`). `settings.llm.compat = { url, model }` plus an
  optional key under the secret name `compat`; the entry appears as `compat:<model>` in
  `llm.list()` and as `app:compat:<model>` in the editor's upsample select as soon as both
  fields are filled. The URL may end in `/v1` or not. IPC `llm:models` (`GET <base>/models`)
  feeds the *Test* button and a `<datalist>` on the model field. A **text-only model gets one
  retry without the image** (a 4xx, or an error naming images / vision) and `ask()` returns
  `note: "text only"`, which `host.upsampleInApp` appends to the status line. `<think>` blocks
  are stripped, the timeout is 120 s, a refused connection reads "No server at &lt;url&gt;".
  Settings › Local / OpenAI-compatible endpoint holds URL, model, key and Test;
  `providers/compat.js` is a key-row-only entry kept **out** of `describeAll()` so the row is
  not shown twice. **No real Ollama / LM Studio has been tried**: the gate is
  `tools/llm_test.py` against `tools/llm_mock.py`.

- **"Generate new", a base image from the prompt alone** (asked for during the bug hunt,
  because on an API provider the blank canvas was being uploaded as the image to edit). A
  button in the editor's top bar opens a shell dialog (`openGenerateNew` in `shell.js`,
  app-only): local or API, the model, the prompt with the upsample backends beside it,
  aspect ratio and long side or a free width and height, and the seed. It all runs through
  one command, `generate_new`, so the MCP tool and the test take the same path. **Local**
  renders a flat canvas of the wanted size through the recipe and flattens the result into
  the base; the Flux.2 Klein chain starts its sampler from an empty latent, so the flat
  input carries nothing (measured: the same seed with fill "neutral" and with no fill gives
  near-identical pictures). **API** goes through `host.runGenerate` with `kind: "text"`, no
  crop, no mask, no references, and `editor.setBaseFromCanvas()` puts the answer in.
  Recipes did not have to be edited: `normalize()` in `recipes.js` derives every variant's
  `text` shape (fal and WaveSpeed lose a trailing `/edit`, the others keep the id), and a
  variant can override it or set `text: false`. Comfy Cloud has no text path and says so.
  `providers/loopback.js` writes a real PNG of the asked-for size with zlib, which is what
  makes `tools/generate_test.py` a gate without any key.

- **Prompt instruction templates** (`electron/main/prompts.js`, `prompts/*.md`,
  `docs/PROMPTS.md`), asked for as "a skill .md upload". Deliberately *not* an agent: one
  call, one instruction, no tools. A Markdown file with a front matter (`name`,
  `description`, `use`, optional `for`) and a body with `{prompt}` `{model}` `{aspect}`
  `{region}` `{hint}` placeholders; four built in, the user's own in `<userData>/prompts/`
  override a built-in of the same id. `host.fillPromptTemplate()` always appends the app's
  output rule, so a careless template still yields a prompt. The editor asks
  `host.upsampleInstruction(ctx)` and falls back to `builtInUpsampleInstruction()`, which is
  the only thing the node repo needed for it.
- **The size list per model**: `TEXT_SIZES` in `recipes.js` (Gemini 1024 / 2048 / 4096 for
  its 1K / 2K / 4K classes, OpenAI 1024 / 1536, the rest a free ladder to 4096), carried in
  the variant's `text.sizes` and shown in the dialog. `gemini.js` turns the requested pixels
  into `imageConfig.imageSize`. The list never depended on whether a key was stored, which
  was the user's first guess when 2048 was the maximum for everything.

**Gates for 0.1.5, all on one fresh dev instance on 2026-09-10** (the user closed their own
Scumble first; both share the single-instance lock and the named pipe):
`mcp_test.py` PASS in all three modes — proxy 0.8 s, headless 2.5 s, `--exe
dist/win-unpacked/Scumble.exe` 2.6 s — plus its new `raw` step, which spawns the launcher
with `--cmd ping` and asserts the first stdout byte is `{`. `mcp_test.py --direct` is the
documented FAIL (`b'\r\n{'`) and is deliberately not part of the gate. `llm_test.py` PASS
(listed, vision sees the crop, the text-only model triggers exactly one retry without the
image, the offline error names the URL, settings restored), `commands_test.py` PASS,
`composite_test.py` PASS (gpu vs 2d max 1 level), `film_test.py` PASS (35 cases, worst 3),
`smoke_test.py --no-helpers` PASS (19 s Flux run, the ComfyUI queue was empty before and
after). The settings row and the two Help entries were exercised live: the *Test* button
filled the datalist from the mock ("2 models: mock-vision, mock-text") and the menu handlers
put the right lines on the clipboard (checked through the main-process inspector,
`electron . --inspect=9556`, `Menu.getApplicationMenu()`). `docs/COMMANDS.md` regenerated.

**Not verified here**: `claude mcp add` with the copied line, because the `claude` CLI is not
on this machine's PATH. The Python client is the stricter of the two, and it passes.

**Phase 6 (memory) is done** — `docs/PERFORMANCE.md` "Phase 6" has the measurement, the
node's `DEVELOPMENT.md` §21f the rules, `docs/PHASE6_PLAN.md` the plan it was worked
through. The symptom (a session got slower the more large documents it had seen) was
**not** in the drawing code: every closed document stayed reachable through one event
listener, and with it its whole layer stack.

- **The leak**: a plugin panel's `build` closes over that tab's `Document`, and the
  listeners it registered were never removed. Both bundled plugins do it. Four 96 MP
  documents built and closed left **301 canvases holding 18.8 GB** alive and the GPU
  process at 19 GB; a pan frame cost 47 ms instead of 4. Found with a heap snapshot
  (`HeapProfiler.takeHeapSnapshot` through CDP, then the shortest path from the GC root) —
  the canvas census says *what* survived, only the retaining path says *why*. Take the
  snapshot early next time.
- **The fix** is in `renderer/plugins.js`: listeners registered while a panel is being
  built belong to that panel instance (`buildScope`, a module variable because both
  plugins keep the `scumble` from `activate()` instead of the one `build()` is handed),
  and `host.on("removed")` unmounts the panel, runs its `destroy`, and clears `reg.els` /
  `reg.buttons` (Maps keyed by the editor). `docs/PLUGINS.md` says so for plugin authors.
- **After**: the same four rounds end at 7 canvases / 34 MB, pan 3.6 → 4.1 ms, levels tick
  9.0 → 10.0 ms, renderer 97 MB.
- **Instrumentation that stays**: IPC `app:metrics` (`main.js` + `preload.js`,
  `app.getAppMetrics()` plus the renderer's own numbers — the bytes are in the **GPU
  process**), `ed.memoryReport()`, `GLCompositor.stats()`, `glPoolStats()`, and
  `tools/mem_test.py`. Do not reach for `performance.measureUserAgentSpecificMemory()`:
  `scumble://` is not cross-origin isolated, so it has always returned null.
- **Smaller, measured, not the cause**: the compositor loses its GL context in `dispose()`
  and its texture cache is bounded in bytes (1 GB) instead of by a count of 48;
  `ed.releaseCaches({ deep })` gives caches back and returns the bytes; **Free VRAM** calls
  it and says how much; `renderer/shell.js` `watchMemory` releases the caches of background
  tabs every 30 s above `settings.memory.gpuLimitMB` (default 3072, row in Settings ›
  Rendering, 0 = off); the `status` command reports `memory: { gpuMB, rendererMB }`.
- **What is left and is not a leak**: after four 96 MP documents the GPU process sits about
  1.3 GB above its start, flat across rounds — `releaseCaches({ deep: true })` brings it to
  +58 MB, so it is memory the GL path holds for reuse. And four 96 MP documents *open at
  once* really are 19 GB of live pixels: 40 ms a frame, which is what the memory watch is
  for. `dropCanvas`, undo tiles and layer eviction were **not** built and are not needed.
- **Gates, all on fresh instances**: `composite_test.py`, `commands_test.py`,
  `film_test.py`, `perf_test.py` at 2048x1152 / 6000x4000 / 12000x8000 and
  `perf_test.py --chain 6000x4000` (both within noise of the recorded numbers),
  `smoke_test.py --no-helpers` (real Flux run), `mem_test.py` in both variants.
- **`tools/mcp_test.py` failed here, and it was not phase 6**: the installed 0.1.3 failed
  the same way. Fixed in 0.1.5 by the launcher (see the head of this section).

**Three bugs fixed on 2026-09-10 (after 0.1.3), all reported by the user, two of them
regressions of the GPU compositor** (`docs/PERFORMANCE.md`, "Phase 5, the two bugs the
compositor shipped with"; the node's `DEVELOPMENT.md` §21e has the two new rules). Gates on
the dev instance after the fix: `composite_test.py`, `commands_test.py`, `film_test.py`,
`smoke_test.py --no-helpers` (real Flux run), `perf_test.py` unchanged within noise.

- **A brush stroke or an erase did not reach the screen.** `touchSourceRect` refreshes the
  pyramid levels inside a rectangle and deliberately left `_dispVer` alone; the compositor
  keys its texture cache on that number, so it kept drawing the texture from before the
  stroke. The pixels were never lost (exports and runs were correct), the screen showed the
  old ones. The rect touch now raises the version, carries the pyramid entry to it and
  raises the version of every level it redrew.
- **Colour match did nothing.** Its statistics come from what is under the layer, which
  Canvas 2D reads off the target it has drawn into; a GPU pass clears that target first, so
  `matchStats` found no samples and returned null. `glViewComposite` now passes a thunk
  (`glMatchBackdrop`) that composites the stack below the layer, resolved only on a cache
  miss: pan 0.1 ms unchanged, a slider tick 4.3 ms against 3.4 ms on Canvas 2D at 24 MP.
- **A reference layer lost the mask row** (RMBG cutout, mask from selection, edit / apply /
  remove) because references are drawn by `renderReferences`. The row is `buildMaskRow()`
  now and the selected reference gets it; a cut-out reference uploads its masked pixels,
  which the run path already supported.
- **Why the gate missed both compositor bugs, and what it does now**: `composite_test.py`
  drew the Canvas 2D shot first and the GPU shot re-used its cached match canvas, so the two
  paths shared one cache, and nothing in the test ever changed pixels through a rectangle
  touch. The gpu-vs-2d step drops the match statistics before every shot and erases into a
  paint layer first. Verified by reverting the fix: 174 levels on 51,300 pixels, FAIL.

**Landed on 2026-09-10 (night): high-res performance phases 1 to 4** (pushed in both repos;
`commands_test.py`, `film_test.py`, `smoke_test.py --no-helpers`, `mcp_test.py` PASS, the
new `tools/perf_test.py` is the benchmark). `docs/PERFORMANCE.md` §1b and the phase
sections have the details and the numbers, the node's `DEVELOPMENT.md` §21 to §21d the
mechanisms. In short:

- **Phase 1**: a display pyramid per source canvas, the screen composites only the visible
  region at screen resolution (`viewPass`), the composited scene is cached behind a
  signature so overlays cost nothing, brush undo is a copy of the touched rectangle and
  every other snapshot encodes off the main thread, the selection's box comes from hints.
- **Phase 2**: colour match as a shader pass, the grain field is one cached tile anchored at
  the image origin, dabs refresh the display levels in place, renders above the drawing
  buffer go through an off-screen texture.
- **Phase 3**: `js/inpaint_worker.js`, a module worker both hosts serve from next to the
  editor, takes PNG encoding, the upload hashes and the PSD / ORA writers.
- **Phase 4**: grow, shrink, feather, invert, the magic wand and the bucket run in the
  worker and hand back the new bounds; grow only touches the band around the selection.

Interactive gestures on a **96 MP** document are 0.1–8 ms (they were 250–900 ms at 66 MP),
a full export with a three-filter film stack 0.7 s, and the discrete operations that used
to freeze the window for 1–4 s now hold it for 100–400 ms. Deliberately left for later: the
ping-pong texture chain between filter layers, the selection as a typed array, layer tiles.

**Releases**: 0.1.2 carries the phases 1–4 and the large-image fix, 0.1.3 adds the GPU
compositor. Both are published on GitHub Releases, so the installed app updates itself.

- **Fix, the New button did nothing in the app**: Electron has no `window.prompt` (it
  throws "prompt() is not supported"), so the size question never appeared. The editor has
  its own small modal now (`InpaintEditor.ask({title, message, value})`, `.ipc-ask` styles,
  `askOpen` guard in the window key handler); `window.confirm` does work in Electron.
- **Fix, images above 64 MB could not be loaded** (reported 2026-09-10, app only, not a
  side effect of the performance work): `uploadBlob` sends files over `LARGE_UPLOAD`
  (64 MB, a 10k photo easily) through the node's streaming route
  `/inpaint_canvas/upload`, and `main.js` only knew `/upload/image` and `/view`, so that
  route went to `comfy.proxy` and the file never reached the local mirror. With ComfyUI
  down the upload answered 502; with a stale connection state the upload went to the
  server but the following `/comfy/view` found nothing, and the image silently never
  appeared. `mirror.handleRawUpload()` now serves the route like every other upload
  (query params in, raw body, `{name, subfolder, type, size}` back), and `pushToServer`
  picks the streaming route above 64 MB or after a 413, which also fixes `ensureOnServer`
  for runs with large layers. Regression step `large_upload_route` in
  `tools/commands_test.py` (it uploads twice and watches the mirror grow, so it fails on
  the bug even when ComfyUI is connected; verified by reverting the fix).

**Phase 6 is finished** (see the top of this section). Its plan, `docs/PHASE6_PLAN.md`, is
kept as written: the six hypotheses it ranked are ticked off in `docs/PERFORMANCE.md`, and
the measurement overturned most of them. What the performance work leaves open on purpose:
layer tiles above 16384 px on a side (the compositor returns null there and Canvas 2D takes
over), the full-resolution GPU path, and a blur as a shader pass, which is a decision about
the film pack's output and belongs to the user.

**Phase 5 has its second step** (2026-09-10): the filter chain stays on the GPU
(`docs/PERFORMANCE.md`, phase 5 step 2). Measured first, as asked: a round trip
canvas -> texture -> canvas costs **0.6 to 1.0 ms whatever the size** (it synchronises the
2D canvas with the WebGL context at both ends, it is not pixel work), a ping-pong prototype
ran five passes in 0.1 ms, and a film stack paid seven round trips per frame. So
`inpaint_filters_gl.js` grew render targets: a `GLSurface` is an RGBA8 texture with a
framebuffer, `info.chain` makes a pass write into one and read one, `u_dstTop` keeps every
texture top down so nothing downstream notices, `beginScope()` / `endScope(keep)` pool them
and `glChainStats()` counts the round trips. Two users: the stages inside one filter (a
plugin declares `chain: true` and resolves with `scumble.gl.toCanvas()` where it really
reads pixels - the film pack does that in `common.js`) and consecutive filter layers
(`drawLayersInto` carries the chain, `flushFilterChain` puts it down, `applyFilterLayer`
keeps it only when the layer covers its input one to one).

- **The pixels do not change.** A result that goes onto the canvas is still drawn over the
  composite in the old order, and the chain is flushed underneath it first, so only the
  *upload of the next filter's input* is saved. `tools/composite_test.py` has a new step
  that renders the same stack with the chain on and off in one run, including a layer with
  opacity + blend and a masked one: **identical, 0 levels**, view and full resolution.
- **What it bought** (`python tools/perf_test.py --chain 6000x4000`, pan, median ms):
  five filter layers 2.9 -> 1.5, three 1.8 -> 1.4, film look alone 3.4 -> 2.7, one filter
  layer unchanged. An extra filter layer costs 0.6 ms before and 0.15 ms after. Round trips
  for the film stack: 14 per frame -> 5.
- **What it did not buy, and why**: the full film stack stayed at 5.5 ms. What is left in
  it is the two **Canvas 2D blurs** inside halation (`ctx.filter = blur(σ)`): the chain has
  to touch down there and wait. The next lever for that stack is a blur as a shader pass -
  **not built**, because it changes the look of every blur-based film filter (Skia's box
  blurs against a gaussian) and `film_test.py` compares the two paths against each other,
  not against a picture. That is a decision about the film pack's output, for the user.
- **`CHAIN_MAX_PIXELS` is 10 MP.** Measured on the full-resolution composite: up to 8 MP the
  chain is about twice as fast, at 12 MP even, at 16 MP and above clearly slower (the
  surfaces stop fitting the 320 MB pool, so textures are created and destroyed per frame).
  A screen pass is 2 to 8 MP, so exports, runs and thumbnails keep the path they had.
  `ed.filterChainOff = true` switches the chain off at run time.
- Gates on the dev instance: `composite_test.py`, `film_test.py` (35 cases, worst 3),
  `commands_test.py`, `smoke_test.py --no-helpers` (real Flux run) all PASS; the ordinary
  `perf_test.py` is unchanged within noise at 2.4 / 24 / 96 MP. The editor changes are sync
  patches (`tools/sync_editor.py`, round trip verified), the node repo is untouched: the GL
  filter module is still app-only and the chain goes back with it.
- Watch out when measuring: after several large documents in one page the GL path degrades
  badly (a `levels` filter that costs 0.8 ms cold-clean measured 12 ms after four 96 MP
  documents had been built and closed). Restart the app between benchmark runs, or the
  numbers are nonsense. That is phase 6 (memory) territory.

**Phase 5 has its first step** (2026-09-10): `js/inpaint_compositor.js` stacks the visible
region on the GPU, one shader pass per layer, sources cached as textures by the version
`touchSource` bumps. It agrees with Canvas 2D to **1 level over 1.5 million pixels** in the
editor; the nine blend modes follow the W3C spec and were checked over every colour and
alpha combination (2.3 levels premultiplied). `glCompositeUsable()` falls back to Canvas 2D
for filter layers, a running stroke, a transform, compare, peek, exports and runs.
`python tools/composite_test.py` is the gate: it draws the same view both ways in one run
and compares, plus two stored references (`tools/refs/`).

**The measurement is sobering and worth reading before continuing** (`docs/PERFORMANCE.md`,
phase 5): median frame cost is the same on both paths (0.1 ms), because phases 1 and 2
already removed what phase 5 was written to remove. The compositor's win is the worst case,
9.8 ms to 0.2 ms at a large window with 15 layers. So judge the remaining steps by
measurement, not by the plan's estimate: the filter chain on the GPU (ping-pong textures,
no canvas round trip per filter layer per frame) is the one still worth doing; layer tiles
matter only above 16384 px on a side (the compositor returns null there today and Canvas 2D
takes over); the full-resolution path only if a measurement asks for it. Then phase 6
(memory: undo as compressed tiles, the objects map bounded, layers evicted to the mirror).

**Landed on 2026-09-10** (tested on the dev instance: `commands_test.py` PASS, the
preset row and the mode switch exercised through CDP, the three LLM adapters up to the
providers' "invalid key" answers with dummy keys; not committed as a release yet):

- **Old models removed**: `recipes/nano_banana.json` (gemini-2.5-flash-image) and
  `recipes/gpt_image_1_5.json`; `openai.js` sends `input_fidelity` only for gpt-image-2,
  `gemini.js` falls back to `gemini-3.1-flash-lite-image`. 15 model recipes remain.
- **Prompt upsampling through the provider keys** (`electron/main/llm.js`, IPC
  `llm:list` / `llm:ask`, `docs/HELPERS.md`): GPT-5.6 Luna / Terra (OpenAI Responses
  API), Gemini 3.8 Flash / 3.5 Flash Lite, Claude Opus 5 / Haiku 4.5 (new key row
  `providers/anthropic.js`, key only). They appear in the editor's upsample select after
  the ComfyUI nodes once the key is stored (`host.upsampleBackends()`, refreshed by
  `host.refreshLLMs()` after a key is saved or cleared). `upsample_prompt` and "select by
  text from the prompt" use them too. Model ids checked on 2026-09-09 (OpenAI
  `developers.openai.com/api/docs/models`, Google `ai.google.dev/gemini-api/docs/models`).
  Not yet: a generic OpenAI-compatible endpoint (Ollama / LM Studio / OpenRouter) with
  its own URL + model fields, which would give a free local upsampler without ComfyUI.
- **The local / api select switches recipes**: the recipe select shows only the recipes
  of the current mode, the editor's select switches the group and picks the recipe last
  used there (`settings.recipeByMode`, `host.onModeChanged` in `shell.js`). Before, the
  select changed the mode while the recipe stayed, so "api" still showed the local list.
- **Setting presets** for ComfyUI recipes (`host.renderPresets`, `settings.recipePresets`,
  `docs/RECIPES.md`): a Preset row at the top of the Settings section saves the model /
  text encoder / VAE combination (every `*_name` file combo) under a name; Save turns the
  select into a name field (Enter / Escape), `(custom)` while nothing matches.
- **High-res performance plan** in `docs/PERFORMANCE.md` (measurements, pipeline map, Chromium
  limits, six phases: pyramid + viewport composite, GPU match / filter chain, worker, dirty
  rects, WebGL2 compositor, memory). Decided with the user on 2026-09-10; phase 1 is next.
  Also fixed: a filter layer is renamed on every type change (node repo, uncommitted there).
- The sync brought the node's new large-upload path along (`uploadCanvas` uses
  `/inpaint_canvas/upload` above 64 MB or on a 413), untested in the app.

## Where things stood (2026-09-09, late)

**Release 0.1.1 (2026-09-09, night)**: the night's work below is tested in the app and
released. `package.json` is 0.1.1, tag `v0.1.1` pushed, the workflow builds the installer
and opens a draft release; **publishing the draft is still a manual step**
(`gh release edit v0.1.1 --draft=false`), only then does the user's desktop app see the
update. Tests run on the dev instance: `film_test.py` PASS (35 cases, worst 3 levels),
`commands_test.py` PASS (twice, before and after the shell.js fix), `smoke_test.py
--no-helpers` PASS (96 s Flux run + loopback provider).

- **Fix, stale key state**: the provider select in Settings › Recipes kept its "(no key)"
  option labels after a key was saved or cleared (`syncRecipeRows` only refreshed the meta
  line and the selected value). New `providerOptionLabel(pid)` in `renderer/shell.js`,
  called both when the options are built and in `syncRecipeRows`. Verified live: with a
  dummy WaveSpeed key all 16 rows switched from "WaveSpeedAI (no key)" to "WaveSpeedAI"
  without reopening the dialog (the dummy key was cleared again, `secrets.json` is empty —
  the user has no provider key stored at all, which is why every row reads "no key").
- **Large-image filter verified in the app**: synthetic 10864 × 6062 image (grid every
  256 px, coloured corner markers), film look Portra 400 with grain and halation off,
  3.9 s. Against the same look on the image downscaled to 1358 × 757 the tiled result
  differs by 0.38 levels mean / 16 max (resampling only), corners in the right places.

**Landed on 2026-09-09 (night):**

- **Bug fix, large images**: Chromium caps the WebGL drawing buffer at about 33 MP (5760²
  on the RTX 5090, whatever MAX_VIEWPORT_DIMS says) and keeps the canvas size, so a filter on
  a 10864 × 6062 image showed only its lower-left corner stretched to full size (film look,
  grain, every GL filter). `renderer/editor/inpaint_filters_gl.js` now checks
  `drawingBufferWidth/Height` and renders in tiles (`renderTiled`, uniform `u_tile` shifts
  `gl_FragCoord`); the 64 MP area limit is gone, only the 16384 px side limit remains.
  Verified on a standalone page (scratchpad `tiletest.html` importing the module; invert and
  a plugin shader at 2000 × 1000, 10864 × 6062, 12000 × 8000 all exact, 100–200 ms), and in
  the app on a 10864 × 6062 image (see the release note above).
- **Providers**: LetzAI and OpenRouter removed (adapters, recipe variants, docs). New
  `providers/wavespeed.js` (WaveSpeedAI, `POST /api/v3/<model>`, poll
  `predictions/<id>/result`, URL-only inputs so crop / mask / refs go through
  `media/uploads`; keyUrl is the user's referral link `https://wavespeed.ai/?ref=dennisi6`,
  WaveSpeed pays 10 % on a referred user's first 30 days) with variants in all 16 model
  recipes, and `providers/comfycloud.js` (Comfy Cloud v1 API, builds LoadImage → Partner
  Node → SaveImage, node class names and dotted dynamic-input keys read from the local
  ComfyUI 0.35 `comfy_api_nodes/`; needs a paid plan) with variants in 14 recipes (no
  FLUX.2 flex / klein partner node). The user applied to the Comfy.org affiliate program
  (30 % recurring for 3 months on subscriptions); once the link exists, put it into
  `comfycloud.js` `keyUrl`. **Neither adapter has run against the live API.** Research
  notes: Segmind pays up to 30 % for 12 months but lacks FLUX.2 / Nano Banana 2; fal and
  Replicate only have unverified third-party listings; OpenAI, Google, BFL have nothing.

**Phase 5 has its first half**: the repo is public, GPL-3.0, release 0.1.0 is on GitHub
(unsigned), auto-update works end to end (a 0.0.9 build found, downloaded and installed
0.1.0 from the release). Phases 1–4c and 5a are in. What is still open in phase 5, decided
with the user on 2026-09-09:

- **Code signing**: apply at the SignPath Foundation (`signpath.org/terms`) once the project
  has some visible use; needs a "code signing policy" page in the repo (roles: committers,
  reviewers, approvers), MFA on the GitHub account and the SignPath GitHub Actions step in
  `build.yml`. Fallback Certum Open Source (about 70 EUR first year, smartcard). No paid
  Microsoft signing (user's decision).
- **Linux** AppImage/deb: `npm run dist:linux` and an `ubuntu-latest` job in `build.yml`,
  then a real test (`local.js` unix socket, ONNX CUDA/CPU providers, icons). About a day.
- **macOS** only with an Apple Developer account (99 USD/year for Developer ID + notarization;
  no free path, Gatekeeper blocks unsigned apps hard since Sequoia). Not planned.
- **Android**: not sensible (Electron + Node main process: sharp exports, ONNX, named pipes,
  MCP). Tablets can use the ComfyUI node in the browser instead.
- Still open from before: the first real RunPod pod (`docker/runpod/`), the seven API provider
  adapters against live APIs (no keys yet; the user applied for fal / OpenAI OSS credits on
  2026-09-09), film pack follow-ups (`docs/BRIEF.md` §3), a Claude Code / Claude Desktop
  session that drives Scumble through `--mcp`, a website.

Landed on 2026-09-09 (evening, after the release):

- **Model recipes**: a provider recipe is one model with a variant per provider
  (`providers: { gemini | openai | bfl | fal | replicate | wavespeed | comfycloud: { model,
  input, fields, fixed, settings, options, note } }`, `default` = home provider, `family`
  groups the lists). Settings › Recipes shows a provider select per row (choice in
  `settings.recipeProviders`), `select_recipe(id, provider)`, `list_recipes` lists
  `providers`. `electron/main/recipes.js` `normalize()` turns the old one-provider shape
  (and the smoke test's loopback) into the new one; `shell.js` `resolveRecipe()` merges the
  chosen variant into what host and commands see. 17 model recipes: Nano Banana 2 / 2 Lite
  / Pro / 1, GPT Image 2.5 Flare / Sunburst / 2 / 1.5, FLUX.2 max / pro / flex / klein,
  FLUX.1 Fill, Seedream 5 Lite / Pro, Qwen Image Edit, LetzAI inpainting
  (`tools`-less: the generator script lived in the session scratchpad, edit the JSON
  files directly). Removed gpt-image-1 and gpt-image-1-mini.
- **New adapters**: `providers/openrouter.js` (unified image API `POST /api/v1/images`,
  `input_references`, `b64_json` back, no mask: handled like Gemini) and
  `providers/letz.js` (`POST /user-assets` → PUT upload → `POST /image-edits` mode `in`
  with the base64 mask, poll `/image-edits/<id>`, `imageVersions.original`). fal adapter:
  `fields` (`image` / `images` / `mask` names) and `options.sizing = "none"`; OpenAI adapter:
  gpt-image-2.5-flare / -sunburst (quality xhigh / max), `input_fidelity` only for 1.x / 2.
  **None of the seven adapters has run against a live API yet.** Replicate input names
  for the new models (`input_images` for FLUX.2, `image_input` for Nano Banana / Seedream)
  are the best reading of third-party docs, replicate.com blocked the schema pages.
- Model ids checked on 2026-09-09: Google `gemini-3.1-flash-image`,
  `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`; OpenAI
  `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` (released 2026-09-08), `gpt-image-2`; fal `fal-ai/nano-banana-2/edit`, `fal-ai/flux-2-max/edit`,
  `fal-ai/bytedance/seedream/v5/lite/edit`, `bytedance/seedream/v5/pro/edit` (no `fal-ai/`
  prefix), `openai/gpt-image-2/edit`; OpenRouter slugs from
  `GET https://openrouter.ai/api/v1/images/models` (public, no key), e.g.
  `black-forest-labs/flux.2-max`, `bytedance-seed/seedream-5-0-lite`.

Landed on 2026-09-09 (phase 5a):

- **Auto-update** `electron/main/updater.js` (`electron-updater` 6.8, MIT): GitHub Releases
  feed from `build.publish` in `package.json` (electron-builder writes
  `resources/app-update.yml` into the NSIS build only, **not** into `--dir` builds), check
  8 s after start in the windowed packaged app (never headless / agent-started / dev),
  background download, `autoInstallOnAppQuit`, `quitAndInstall(silent, run after)`.
  Settings › Updates (check at start on/off = `settings.updates.check`, Check now, Restart
  and install, status line), a blue `Update to x.y.z` button in the top bar once
  downloaded, Help › Check for updates. IPC `update:status|check|install`, event
  `update:status`. States dev / idle / checking / latest / downloading / downloaded / error;
  a 404 on the feed reads "No release published yet.".
- **Releases**: `.github/workflows/build.yml` builds the NSIS installer on `windows-latest`
  (Node 22, `npm ci`); on a `v<version>` tag (must equal `package.json`, checked) it creates
  the draft release first (electron-builder otherwise races itself into two drafts, seen on
  v0.1.0), then `electron-builder --publish always` uploads the installer, `.blockmap` and
  `latest.yml`; other pushes keep the installer as a workflow artifact. Publishing the draft
  by hand (`gh release edit v0.1.0 --draft=false`) makes it visible to the app. Release
  0.1.0: https://github.com/DenRakEiw/scumble/releases/tag/v0.1.0. Assets get hyphens
  instead of spaces (`Scumble-Setup-0.1.0.exe`), electron-updater expects exactly that.
- **Licence** GPL-3.0 everywhere (LICENSE, package.json, About, Help menu, README, BRIEF);
  README rewritten for the public repo (SmartScreen paragraph).
- **Tests**: Settings dialog and `python tools/commands_test.py` PASS on the dev instance;
  the packaged 0.1.0 reported "up to date" against the release; a local 0.0.9 build found
  and downloaded 0.1.0 within 30 s (blue button in the top bar) and installed it silently
  through Restart and install. Test recipe: set the version to 0.0.9 in `package.json`
  (Python, never PowerShell `Set-Content`: it writes a BOM and electron-builder refuses the
  file), `npm run dist`, run `dist/win-unpacked/Scumble.exe --remote-debugging-port=9555`,
  `python tools/cdp.py eval "window.scumble.updates.status()"`, restore the version.

Landed on 2026-09-09 (phase 4c, `docs/MCP.md` has the details):

- **`Scumble --mcp`**: stdio MCP server (`electron/main/mcp/server.js`,
  `@modelcontextprotocol/sdk` 1.30, MIT) with one tool per command of the command core, plugin
  commands included (`film.apply_look` → `film_apply_look`; tool names allow `[A-Za-z0-9_-]`
  only). Schemas from `describe()`, `screenshot` as image content, errors as `isError` text,
  `readOnlyHint` on the read-only commands, `tools/list_changed` after a plugin reload, `ping`
  reports `mcp: {mode, pid}`. If Scumble is running the server drives that instance, otherwise
  it starts the app headless in its own process and quits it when the client goes.
- **`--headless`** (the app without a window; a second start of Scumble shows it) and
  **`--cmd <name> [json]`** (one command against the running or a short-lived headless
  instance, JSON on stdout, exit 1 on error).
- **Plumbing**: `electron/main/bridge.js` (main → renderer request / reply over IPC, ready
  gating, timeouts), `electron/main/local.js` (named pipe `\\.\pipe\scumble-<hash>` / unix
  socket, NDJSON, opened by every running instance), `AgentBackend` in `main.js` (socket, else
  take the lock and start headless), `needWindow()` in front of every dialog, close = hide while
  an MCP client is attached, window title `Scumble · n agents connected`, `preload.js`
  `scumble.commands`, `shell.js` answers `commands:request` and sends `commands:ready` at the
  end of its start.
- **Electron on Windows, three traps** (all handled, keep them in mind): `process.stdin` in
  the main process never emits `data` from a pipe (read fd 0 with `fs.createReadStream`);
  Electron prints a CR LF to stdout before any JS runs and it cannot be suppressed from the
  app — **handled since 0.1.5 by the Node-mode launcher** `electron/main/mcp/launch.js`,
  which clients register instead of the exe; a window created hidden stays hidden after
  `show()`, `restore()` brings it up.
- **Tests**: `python tools/mcp_test.py [--exe dist/win-unpacked/Scumble.exe] [--direct]`
  (Python `mcp` client, through the launcher since 0.1.5; PASS 2026-09-09 in proxy mode with the app open, 1.5 s, and headless with the dev
  electron and the packaged exe, about 5 s, the process ends with the session), `python
  tools/commands_test.py` PASS, `python tools/smoke_test.py --no-helpers` PASS after the
  change (one run right after the commands test reported FAIL with only its tail captured; the
  re-runs passed, cause not identified).

Landed on 2026-09-09 (phase 4b, `docs/FILM.md` and `docs/PLUGINS.md` have the details):

- **Film pack** `plugins/film/` (built in): eleven filter types, each with a GLSL path and a
  CPU twin (`common.js` holds the shared maths, `tools/film_test.py` checks both paths on 35
  parameter sets, worst difference 3 levels in the three-stage film look): `film.look`
  (stock colour matrix / mono weights, warmth, tint, saturation, parametric tone curve with
  toe / shoulder per film class, fade, push, grain by speed through the built-in grain
  filter, halation default per stock), `film.halation`, `film.glow`, `film.tonal_contrast`,
  `film.structure`, `film.bleach_bypass`, `film.cross_process`, `film.split_tone`,
  `film.light_leak`, `film.frame`, `film.bw` (colour filters, toners, structure, grain), and
  `film.points` (control points: radial falloff × colour similarity, tool U with overlay,
  Delete / Escape, sliders in the layer row, one undo step per gesture). "Film looks" panel
  with one thumbnail per stock (46 stocks from the grain presets, `looks.js` adds tone class,
  halation and ISO), six Plugins-menu actions, commands `film.looks`, `film.apply_look`,
  `film.add_point`. Trademark note in the stock tooltip and About.
- **Plugin API additions** (`renderer/plugins.js`, `renderer/editor/inpaint_filters_gl.js`):
  `sampler2D` uniforms (canvas / ImageData / `{data, width, height}` as RGBA8 or RGBA32F,
  units 5+; `precision highp sampler2D` in the plugin source), `values(params, info, src)`,
  `scumble.gl.shade(shader, canvas, values, info)` for multi-pass filters (program cached per
  definition object), `scumble.filters.apply(id, ...)` / `filters.ids()`, tool `draw(doc, ctx,
  view)` + `drawAlways` and `onKey`, `Document.draw()` and `setFilterParams(layer, patch,
  {preview})` (undo like the editor's sliders), select params with `title`; only the select
  named `preset` fills params / renames the layer, other selects just set a value. *Reload
  plugins* now reloads submodules too: `main.js` `serveFile` rewrites relative imports in
  plugin modules to carry the `?v=` query.
- **Editor patches** (`tools/sync_editor.py`, rows in `docs/SYNC.md`): `host.pluginOverlay`
  in `drawOverlays`, the preset-select rule and `p.title` in the filter controls.
- **Tests**: `python tools/film_test.py` (9 steps, PASS 2026-09-09), `python
  tools/commands_test.py` PASS, `python tools/smoke_test.py --no-helpers` PASS after the
  change. Contact sheet of every filter: `dist/smoke/film/sheet.jpg` (made by hand this
  session, not part of a script).

Known small things (film pack): the CPU path of the control points is O(pixels × points)
(a 12 MP image with ten points takes a few seconds without a GPU); the rough frame edge and
light leak jitter use an integer hash that JS and GLSL compute identically, the value-noise
interpolation on top differs in the last float bits (never more than a level). Plugin
`custom` params are stored as-is in the document JSON (the points list); `filter_types`
omits their default.

Landed on 2026-09-08 (phase 4, `docs/COMMANDS.md` and `docs/PLUGINS.md` have the details):

- **Command core** `renderer/commands.js`: the node's bridge table ported to documents
  (tabs) instead of graph nodes, 59 commands, each with `description`, `params` schema
  (type, description, default, required, enum), `scope` app / doc, `needsImage`.
  `commands.run(name, args)` throws, `commands.call` returns `{ok, ...}`, `describe()` is
  the table as data, `register(name, def, owner)` for plugins. Document commands take
  `doc`; `export*` take a `path` (`host.exportPath` bypasses the dialog); `load_image` /
  `add_image_layer` take a `path` (IPC `file:read`) or a mirror ref. `host.shell`
  (newDocument, activate, closeDocument with `{force}`, selectRecipe, recipes) is how
  commands reach the shell. `tools/commands_doc.py` regenerates `docs/COMMANDS.md` from
  the running app.
- **Plugins** `renderer/plugins.js` + `electron/main/plugins.js`: folders in
  `<userData>/plugins/<id>/` and built-in `plugins/<id>/` (shipped in the asar,
  `build.files`), `plugin.json` manifest, ES module served as
  `scumble://app/plugins/<id>/...` (main.js `serveFile`, path-checked), loaded with
  `import()` plus a cache-busting query so *Reload plugins* works without restart.
  `activate(scumble)` gets the API (`makeApi`): `Document` wrapper (getPixels /
  setPixels as ImageData with undo, addLayer, selection mask in / out, run), command
  core, `filters` (into `FILTERS` / `FILTER_IDS`, optional GLSL through
  `registerGLFilter` in `inpaint_filters_gl.js`: the fragment defines `vec4 shade(vec4,
  vec2)`, `filter` is a reserved GLSL word), `panels` (`editor.addSection`), `actions`
  (Plugins menu built in main.js from IPC `plugins:menu`, `menu` event `plugin:<id>`),
  `tools` (button in the tool column, pointer routing through `host.pluginPointer`,
  keys through `host.pluginKey`, select / deselect through `host.toolChanged`), events
  (`host.on`: built, activate, changed, tool, removed), `storage` (settings.json
  `pluginData`). Every registration is tracked per plugin and removed on disable /
  reload. Settings › Plugins lists state, registrations and errors.
- **Sample plugin** `plugins/sample`: Posterize filter (CPU + GLSL, bit-exact), a panel,
  two actions, the colour-probe tool (K), the `sample.mean_color` command.
- **Editor patches** (`tools/sync_editor.py`, rows in `docs/SYNC.md`): exports of the DOM
  helpers, `toolsEl` / `_addTool`, `addSection`, `host.editorBuilt`, the three pointer
  hooks, `pluginKey` before the tool switch, `toolChanged` in `setTool`.
- **Tests**: `python tools/commands_test.py` (12 steps, PASS 2026-09-08; needs the app on
  port 9555 and the test image in the mirror), `python tools/smoke_test.py --no-helpers`
  PASS after the change (76 s Flux run + loopback provider).

Landed on 2026-09-08 (phase 3, `docs/HELPERS.md` has the details):

- **In-app helper models** through `onnxruntime-node` 1.29 in the main process
  (`electron/main/onnx/`): `runtime.js` (one session per file, DirectML → CPU on
  Windows, CUDA → CPU on Linux, CoreML on macOS; `logSeverityLevel 3`), `models.js`
  (registry, lookup in the model folder and its `onnx/`, `sam2/`, `RMBG/` subfolders,
  resumable downloads with progress and a Hugging Face token for gated repos),
  `sam2.js` (encoder, decoder, automatic mask generator ported from SAM2 with the same
  parameters as the node's `InpaintCanvasObjectMap`, point prompts), `matting.js`
  (BiRefNet / RMBG, sigmoid when the output is a logit), `index.js` (the IPC facade:
  status, configure, downloads, objects, segment, cutout, free).
- **Models** (`models.js`): SAM2 tiny / small / base+ / large from
  `vietanhdev/segment-anything-2-onnx-models` (Apache-2.0; encoder `image`
  1×3×1024×1024 → `high_res_feats_0/1`, `image_embed`; decoder with dynamic batch);
  BiRefNet lite and BiRefNet (`onnx-community`, MIT), RMBG-1.4 (free download,
  non-commercial), RMBG-2.0 (gated, needs the token). All fp32. Model folder default
  `<userData>/models`, or a ComfyUI `models` folder (downloads then go to its `onnx/`).
- **Editor integration** (patches in `tools/sync_editor.py`, rows in `docs/SYNC.md`):
  `objectBackendAvailable()` / `ensureObjects()` prefer `host.findObjects()` when a
  SAM2 model is present (label map at ≤ 2048 px long side, nearest-scaled to the image,
  `applySegmentIds()` split out of `applySegmentsFile()`); `availableCutoutBackends()`
  lists `host.cutoutBackends()` (`app:<model>`) first and `cutoutLayer()` calls
  `host.cutoutInApp()` (`applyCutoutImage()` split out of `applyCutoutFile()`); a click
  beside every object in the object tool runs one SAM2 point prompt on the cached
  embedding (`host.selectPoint`, Shift adds, Alt subtracts); Free VRAM also releases
  the ONNX sessions, and `helperUsed` is set so a local run frees them first.
- **Settings › Helpers** (`shell.js` `renderHelpers`): device auto / GPU / CPU, the SAM2
  model for the object tool, model folder (Change / App folder / Open), one row per
  model with Download (progress bar, Cancel, resume of `.part` files) or Remove, the
  Hugging Face token (key `hf-token`), a runtime line (version, providers tried, what
  is loaded on which provider, failures).
- Measured on the RTX 5090 (DirectML): SAM2 base+ objects on the 512 × 384 test image
  1.2 s warm (4.2 s with session creation), point prompt 0.4 s, BiRefNet lite cutout
  2.5 s warm (10 s cold), RMBG-1.4 0.9 s. With the card full of ComfyUI's models (29 of
  32 GB) DirectML pages and the object map takes 125 s; Free VRAM fixes it and the
  status line says so after a slow run (`host.slowHelperHint`). CPU path: about 24 s. `node tools/helpers_test.js` checks the
  modules without Electron on a synthetic image (PASS 2026-09-08).
- `package.json`: `onnxruntime-node` dependency, `asarUnpack` for its `bin/` (DLLs next
  to the `.node` binding), `npm run helpers-test`.

Known small things: `loadFile` uploads with `overwrite=false`, so re-loading an image
with a name already in the mirror yields `name (1).png` (ComfyUI's own rule, harmless).
The mirror never deletes; the node's `cleanupFiles()` only cleans the server. The
editor's per-document `settings` keep their value when a recipe with the same target
id is re-selected (by design); the Settings panel falls back to the first combo entry
when the stored file name is not on the server. The helper input is squashed to
1024 × 1024 (SAM2's own transform and what the RMBG node does too), so very wide
images get coarser masks; the object map is computed at ≤ 2048 px long side.

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
