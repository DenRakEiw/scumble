# CLAUDE.md — Scumble (desktop app)

Read this first, then `docs/BRIEF.md` (vision, decisions, architecture, phases).
`docs/BUGS.md` is the bug list: what is reported and not fixed, and what has to be
measured before anyone writes code. Put a new report there, not in this file.
`docs/NAMES.md` holds the name research, `docs/RUNPOD.md` the Docker template notes,
`docs/TESTING.md` what each test tool covers and the known flakes.

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
  `/object_info/InpaintCanvas` and, when the pack is missing, only tells the user to install it (the status line,
  *Settings › ComfyUI* Test); it installs nothing itself, there is no Manager install in the code. The Manager
  cannot install the pack today either (`docs/BUGS.md`), so public texts give the `git clone` line.
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
- Release channel: **GitHub Releases** of `DenRakEiw/scumble` (public); `electron-updater` reads `latest.yml`; a
  `v<version>` tag (matching `package.json`) builds a **draft** release in CI, and publishing it makes it visible.
  **Every release needs its CHANGELOG section first** (the tag build fails without it; the app shows the same text).
  Installers are **unsigned**; signing goes **the Microsoft Store first** (an MSIX re-signed by Microsoft; the GitHub
  installer stays unsigned; `runFullTrust`, no self-update, MCP by the execution alias), **then the SignPath
  Foundation** (free for OSS; fallback Certum; Azure Trusted Signing is paid and not for EU individuals).
  `docs/CODE_SIGNING_POLICY.md`, `docs/STORE.md`.
- **Every published release also gets a dev blog post** on https://www.denrakeiw.com/scumble/blog (repo
  `F:\portfolio_web`, deployed by a Vercel Hobby account). **Read `docs/RELEASING.md` before a release**: the whole
  chain, the post's shape, and the Vercel trap (commit the website with its own identity, never the `DenRakEiw`
  noreply address of this repo, and no `Co-Authored-By` trailer: a second author blocks a Hobby deploy).

## Where things stand (2026-10-10: **0.1.45 released and Latest**; the Nik block's releases 2 and 3, the Qwen fix, the fill fix and the `.mcpb` out; the registry publish and the Store update open)

**0.1.45 is out** (tag v0.1.45, published 2026-10-10T08:38:53Z, title "colour grading, HSL, effects, haze and dehaze, a Claude
Desktop extension"; the post `v0-1-45` on the website, the manual synced, hub 0.1.45). It holds releases 2 and 3 of
`docs/PLAN_NIK9_BUILD.md` (R2-S1..S14, R3-S2..S13 by the other agent, each reviewed), plus three things of this
account the same morning: **the `mcpb` branch merged** (the Claude Desktop extension `scumble-<version>.mcpb` as the
sixth release asset, `docs/PLAN_MCPB.md`; `docs/PLAN_WASM.md`, item 44), **issue #4 fixed** (a model file the server
lacks stays the recipe's choice, marked, the run refused with the download link; the `recipes` gate's step, and run
live on the user's ComfyUI), and **a fill layer clipped to the picture** when the view is zoomed out (the user's find
in the test instance; `applyFilterLayer`). Exe gates on the final build: `recipes commands composite limit film mcpb`
(tiles), earlier `mcpb recipes commands document edges depthfx grading film` (tiles) and `mcpb recipes commands`
(canvas), all PASS. `server.json` is 0.1.45 **with the `packages` entry** (the asset's SHA-256, `mcp-publisher
validate` ok). **Waiting for the user:** the registry publish (`mcp-publisher login github` with the device code,
then `publish`; 0.1.44's publish was skipped on purpose); the Store update (`npm run dist:store` needs the user's test
instance from `dist/win-unpacked` closed; then Partner Center through Claude in Chrome with
`dist/store-listing/whats-new-0.1.45.txt`); the test profile `dist/test-profile-0.1.45` and the older
`dist/portable-test/` to delete; an answer on issue #4 (outward-facing, on the user's word); Smithery and GitHub's
MCP registry with the `.mcpb` (`docs/PLAN_MCP_LISTINGS.md`).


**0.1.44 is out** (tag v0.1.44, published 2026-10-09T10:07:52Z, title "depth maps, range selections, filter limits"; the post
`v0-1-44` committed to the website with the manual synced, its deploy status to be read). It is **release 1 (masks) of
`docs/PLAN_NIK9_BUILD.md`**: F1-F8, R1-S1..S11 built by the other agent on 2026-10-08/09, reviewed twice by this account
(`docs/REVIEW_NIK9_2026-10-08.md`; the day-2 findings fixed in 91fe509: the limit's weight in the alpha under a blend mode,
invert once, the depth histogram of the map store, the effect view screen-only, stale after an edit, and eight smaller),
then the user's own test of the exe: the depth row now follows a loaded picture (renderInfo), the range bar has two zones
(edges above, feather handles in a strip below; it was unreachable with a feather of 0), `WORK_MAX` 4096 (1.06 s on
15k, a 22 MB map). Exe gates green on both backends (two flakes re-run, `docs/TESTING.md`). **Decided 2026-10-09 (the
user): releases 2 and 3 are built as one block** by the other agent, a review by this account after every session, one
release at the end after the user's test; release 4 (blend modes) independent.
- **R2-S1 built** (2026-10-09): = F10 with Release 2 extension (Plugin API 4): `wholeStats` (function or true), `wholeStatsSize`
  (64..1024, default 256), param type `color` (#rrggbb lower case), `hidden: true`, `cancelFilterParams` preview rollback without undo,
  `belowStats` versioned by `${compositeVersion}:${readsMap ? mapsVersion : 0}:${n}`, `mapsOf` layer map tracking. Gates `commands`
  (14s on tiles, 13s on canvas), `film` (11s / 11s), `lint` (29s), `types` (5s), `help` (3s) ALL PASS on both `--tiles on` and `--tiles off`
  with `--offline`. Review findings resolved in `0f3f625`.
- **R2-S2 built** (2026-10-09): Edge maths (`renderer/editor/inpaint_edges.js`, pure ASCII, no DOM at import): constants `SNAP_TAU` (0.02),
  `SNAP_DEFAULT` (50); `snapParams(strength)` mapping 0..100 to `[sigmaR, tau]`; CPU twin `snapField` and GLSL twin `SNAP_GLSL`;
  detail pass helpers `tileBoxes`, `fusedSize`, `fitScaleShift`, `fuseTiles` with raised-cosine overlap blending; `rangeMax` (separable 4x4);
  `edgeTiles` (256x256 document tile edge flagging under affine transform). Unit tests in `tools/edges_test.js` covering all 11 PLAN cases.
  Node build synced and committed in node repo (`91e0428`). Review findings resolved in `ce7a0fc`.
- **R2-S3 built** (2026-10-09): Depth detail & snap benchmark (`tools/depth_bench.py`): measured global pass, large inputs (1036, 1400, 1568 px),
  tiles 2×2 / 3×3, edge snap vs full-resolution guided filter, memory and costs across `scene.jpg`, `skin.jpg`, and `adobe_15000x10000.jpg`;
  visual crops generated in `scratch/bench/`; section "Release 2 checkpoint (measured 2026-10-09)" appended to `docs/PLAN_NIK9.md` confirming
  decisions R2-D1 (Tiles 2×2), R2-D2 (snap default 50), R2-D3 (Snap + Flatten), R2-D10 (accept 44.7 MB guide). Gates `lint`, `types`, `help`
  ALL PASS on both `--tiles on` and `--tiles off` with `--offline`. Review findings resolved in `fef6aec`.
- **R2-S4 built** (2026-10-09): Guide and snap setting in document; `depth-snap` row: DocMap extended with `guide` (RGBA8 Uint8ClampedArray/SAB),
  `guideRef`, `guideVersion`; `deriveMap` preserves guide across geometry changes; `guideView` sampler; `mapToJSON` / `mapFromJSON` RGBA8 PNG
  persistence; `FEATURES` in `docfile.js` adds `depth-snap` row (minReader 4, since 0.1.45); `depth_map` command adds `edges` param;
  `setMapMeta` preview/commit modes; maps undo memory tracking. Gates `document` (44s/39s) and `commands` (13s/13s) ALL PASS on both
  `--tiles on` and `--tiles off` with `--offline`. Review findings resolved in `e862417`.
- **R2-S5 built** (2026-10-09): Snap in the Limit stage and effect view; *Edges* slider: added `u_guide` (sampler2D) and `u_snap` (vec2) uniforms to `LIMIT_SHADER` in `renderer/editor/inpaint_limit.js` with prepended `SNAP_GLSL` and `snapField` call; updated CPU twin `limitStageCPU` and fill bake `limitAlphaRows` with `snapField` when `sigmaR > 0`; verified pure ASCII; added `.ipc-depth-edges-row`, `.ipc-depth-edges-slider`, and `.ipc-depth-edges-val` with interactive range slider (0..100, default 50) inside `renderDepthRow()` in `inpaint_canvas.js`, firing `setMapMeta("depth", { snap: { strength } }, { preview: true })` on input, committing on change, and reverting on Escape via `cancelMapMeta("depth")`; updated `tools/limit_test.js` and `tools/limit_test.py`; updated `docs/MANUAL.md`. Gate `limit` ALL PASS on both `--tiles on` (1s) and `--tiles off` (2s) with `--offline`. Review findings resolved in `9ea81b0`.
- **R2-S6 built** (2026-10-09): Depth edge snapping in Select by depth: extended worker op `range_select` with `snap: [sigmaR, tau]`, `guide: { sab, w, h }`, and `picture: { sab, x0, y0, w, h }`; picture bytes read and sampled only for bands containing edge tiles identified via `rangeMax` (cached in WeakMap) and `edgeTiles`; edge tile rows drawn into one reused `willReadFrequently` scratch canvas and dispatched to worker pool while non-edge rows pass `picture: null`; verified exact CPU twin agreement within 1 level, bitwise identity outside edge tiles vs snap 0, and intersect mode parity; 15k test at 15000x10000 measured at 1233 ms with only 40 edge rows sampled and exactly 1 scratch canvas created; gate `edges` (`tools/edges_test.py` + `tools/edges_test.js`) and gate `selection` ALL PASS on both `--tiles on` and `--tiles off` with `--offline`. Review findings resolved in `b69be58`.
- **R2-S12 built** (2026-10-10): Haze by depth built-in filter layer: implemented `haze` filter with `maps: () => ["depth"]`, bilateral edge snap, `wholeStats: hazeStats` (sampling airlight & affine scale/shift), `wholeStatsSize: 256`, `apply: applyHaze` in `renderer/editor/inpaint_depthfx.js` (pure ASCII, `registerHazeGL()`); re-exported `SAMPLE_GLSL` from `inpaint_maps.js` via `inpaint_filters_gl.js` avoiding circular TDZ; added `skip` hook check in `applyPluginGL`; conditional params via `when: (p) => ...` and `needs` in `filter_types` command; updated `buildFilterControls` to filter params by `when` and re-render on select changes; `docfile.js` adds `haze` feature row (reader 4, since 0.1.45); `tools/depthfx_test.py` validates cases a–i on both backends; gates `depthfx`, `export`, `limit`, `commands`, `document`, `lint`, `types`, and `build_node.py --check` ALL PASS on both `--tiles on` and `--tiles off` with `--offline`. Review findings resolved in `6510e6c`. Ready for R2-S13.
- **R2-S13 built** (2026-10-10): Dehaze maths foundation (`renderer/editor/inpaint_haze.js`, pure ASCII, no DOM at import): implemented `minFilter` (separable van Herk / Gil-Werman with replicated edges in O(1) ops/px), `darkChannel` (min_c(I_c / A_c) filtered by `minFilter`), `airlight` (mean of I over top max(16, ceil(0.001*n)) dark pixels via binary min-heap clamped to [0.2, 1]), `guidedFilter` (bound to `boxBlurs` and `guidedFilterCore` from `inpaint_depth.js`), and `dehazeStats` (wholeStats provider returning airlight, 16-bit quantized transmission map, guide RGBA, and sequence key); added `inpaint_haze.js` to `FILES` in `tools/build_node.py` and synced node build; created unit test suite `tools/haze_test.js` verifying exact minFilter against brute force, edge cases, constant dark channel, airlight within 0.03/ch, transmission recovery with Pearson corr >= 0.9, guided filter brute force agreement within 1e-4, epsilon limits, determinism, and 768x512 cost in ~30 ms (< 60 ms budget); integrated `tools/haze_test.js` as the Node pre-step in `tools/depthfx_test.py`; added GL vs CPU compareFilterPaths check to `depthfx_test.py`. Gates `depthfx` (3s/3s on both `--tiles on` and `--tiles off`), `lint` (0 errors), `types` (0 errors), and `build_node.py --check` ALL PASS with `--offline`. Review findings resolved in `30626af`. Ready for R2-S14.
- **R2-S14 built** (2026-10-10): Dehaze built-in filter layer: implemented CPU twin `applyDehaze` and WebGL2 twin `registerDehazeGL` in `renderer/editor/inpaint_depthfx.js` (pure ASCII) with radiance recovery, sky protection (K = 0.25 * protect, clamp t >= 0.1), auto mode (bilateral snap against 768px transmission field `u_t` and guide `u_tguide`), and depth mode (exponential transmission from depth map with bilateral snap); static sampler caching for `u_t` (RG8) and `u_tguide` (RGBA8) keyed by `stats.seq`; dummy 1x1 fallback textures for unassigned samplers; `skip` hook for amount 0 or depth mode without depth map; added `dehaze` to `FILTERS` in `inpaint_filters.js` with parameters `amount`, `mode` (auto/depth), `density` (conditional on depth mode), and `protect`; filter controls hide `needs: "depth"` options when `!host.depthSupported`; `FEATURES` in `docfile.js` adds `dehaze` row (since 0.1.45, reader 4); `tools/document_test.js` asserts reader 4; `tools/export_test.py` adds `dehaze` and `dehaze#depth` test cases with stack program tolerance support; `tools/depthfx_test.py` covers cases j1-j2 (GL vs CPU parity), k (synthetic scene recovery: 87% error reduction), l (amount 0 identity), m (protect sky region <= 3 levels), n (stats caching under same composite version), and o (byte-stable export across runs). Gates `depthfx` (both backends), `export`, `document`, `commands`, `lint`, `types`, and `build_node.py --check` ALL PASS with `--offline`. Review findings resolved in `03111b7`. Ready for R2-S8.
- **R2-S8 built** (2026-10-10): Depth edits inside the selection (the object snap): implemented `selectionOnMap(selCanvas, s, map)` and `editMap(map, weight, op, value)` in `renderer/editor/inpaint_maps.js` (pure ASCII) with operations `flatten` (weighted median of v under w >= 0.5, mix(v, m, w)), `offset` (clamp(v + w*value*65535)), and `smooth` (mix with gaussBlur sigma 3 via boxBlurs on f32 copy); added `async editDepth(op, value, { label })` to `InpaintCanvas` (`inpaint_canvas.js`) projecting selection at map resolution through `selectionCanvasSettled` with automatic scratch release; added *Flatten*, *Nearer*, *Farther*, and *Smooth* interactive buttons in `renderDepthRow()` enabled when a selection exists; added `depth_edit` command in `renderer/commands.js` (`Document and files` group in `tools/commands_doc.py`) with `depth_edit: AUTO` in `policy.js` and `assistant_test.js` coverage; added unit tests in `tools/edges_test.js` and in-app CDP tests in `tools/edges_test.py` covering cases a-h (ramp flatten, soft alpha 128 halfway, undo/redo map object identity, offset clamping, smooth variance reduction >= 50%, limited layer re-rendering with cache miss, 15k memory safety without mirror over 64 MB, and turned 90 deg frame tracking); updated `docs/MANUAL.md`, `CHANGELOG.md`, and `docs/COMMANDS.md`. Gates `edges` (11s/17s on both `--tiles on` and `--tiles off`), `commands` (15s), `assistant` (35s, 38/38 steps), `lint` (0 errors), `types` (0 errors), and `build_node.py --check` ALL PASS with `--offline`. Review findings resolved in `a98c67b`. Ready for R2-S7.
- **R2-S7 built** (2026-10-10): The detail pass (conditional on R2-D1): implemented `DEPTH_LARGE = 1568` in `renderer/editor/inpaint_depth.js`; added worker job `depth_fuse` in `inpaint_worker.js` calling `fuseTiles` with transferred buffer; implemented `pictureInputBox(editor, box, w, h, opts)` and `depthDetail(editor, opts)` in `renderer/editor/host.js` supporting `tiles` (grids 2x2 and 3x3) and `large` routes, abort signal checks, and progress reporting; wired `depthDetailSetting`, `getDepthDetail`, `setDepthDetail` in `host.js` and `shell.js` with `depth: { detail: "standard" }` in `electron/main/settings.js`; clamped `depth_map` assistant timeout to 900s in `electron/main/assistant/policy.js` with 254 test checks verified in `tools/assistant_test.js`; added `detail` parameter to `depth_map` in `renderer/commands.js` and `docs/COMMANDS.md`; added live progress and *Cancel* button during detail computation plus *Detail* selector (*Standard*, *Fine*, *Finest*) in `renderDepthRow()` in `inpaint_canvas.js`; updated node repo stubs in `js/host.js` and verified clean sync with `tools/build_node.py`; added unit tests in `tools/edges_test.js` Section 11 (3x3 grid tiling and fused size) and in-app CDP tests in `tools/edges_test.py` covering cases a-f (standard 1 call, fine 4+1 calls, finest 9+1 calls, uniform input shapes preventing DirectML engine re-allocations, live progress events 1..n, MAE against truth <= 0.7 * standard, cancel after call 3, stand-in exception handling preserving previous map, and `meta.detail` save/open round-trip). Gates `edges` (15s/20s on both `--tiles on` and `--tiles off`), `commands` (13s), `assistant` (33s), `lint` (0 errors), `types` (0 errors), and `build_node.py --check` ALL PASS with `--offline`. Reviewed with 0 Must Fix in `5947ce0`.
- **R2-S11 built** (2026-10-10): Depth from a layer (conditional on R2-D8): added `depthFromLayer(layer, { invert = false })` in `renderer/editor/inpaint_canvas.js` supporting layer sampling at working resolution (`WORK_MAX = 4096`) via `sampleRegionSettled("layer", ...)`, Rec. 601 luma conversion, far disparity calculation (`far = invert ? luma : 1 - luma`), guided filter refinement against grey picture input via worker job `depth_guide`, whole-picture layer coverage validation (refusing partial/filter/group layers with "the layer must cover the whole picture"), and setting `DocMap` with metadata `{ source: "layer", layer: layer.name, snap: { strength: SNAP_DEFAULT }, invert }`; added *From layer...* flyout in `renderDepthRow()` with normal and inverted actions; added command `depth_from_layer { layer, invert }` in `renderer/commands.js` and `docs/COMMANDS.md`; updated `tools/commands_doc.py`; added `depth_from_layer: AUTO` to `electron/main/assistant/policy.js` with 254 test checks verified in `tools/assistant_test.js`; added Section 12 in `tools/edges_test.js` verifying luma maths, inversion symmetry, and guidedFar quantization smoothing; added in-app CDP tests in `tools/edges_test.py` verifying monotone depth gradient down rows matching ramp within 1.2 levels, inversion flipping monotonicity, partial layer refusal, and undo restoring previous map; node repo synced and verified with `tools/build_node.py --check`. Gates `edges` (16s/22s on both `--tiles on` and `--tiles off`), `commands` (13s), `assistant` (33s), `lint` (0 errors), `types` (0 errors) ALL PASS with `--offline`. Reviewed with 0 Must Fix in `092886f` / `57f9697`. Release 2 completely finished.
- **R3-S2 built** (2026-10-10): Colour grading filter layer: created pure ASCII module `renderer/editor/inpaint_grade.js` (no imports, no DOM at import) implementing `hueRgb`, `gradeIdentity`, `gradeWeights` (smoothstep transitions, partition of unity sum w = 1.0), `tintOf` (zero-luma chromatic vector), and `colorGradeTables(p)` generating 256-entry `Float32Array` offset tables; added `inpaint_grade.js` to `FILES` in `tools/build_node.py` and synced node build; factored `applyOffsets` in `inpaint_filters.js` and added built-in `color_grade` filter with 14 parameters (`sh_hue`, `sh_sat`, `sh_lum`, `mid_hue`, `mid_sat`, `mid_lum`, `hi_hue`, `hi_sat`, `hi_lum`, `glob_hue`, `glob_sat`, `glob_lum`, `balance`, `blending`); factored `setOffsets` in `inpaint_filters_gl.js` uploading 256x1 RGBA32F offset texture in `u_mode 2` with identity fast-path returning `false`; added `color-grade` row to `FEATURES` in `docfile.js` (since 0.1.45, reader 4); updated `special` dictionary in `tools/export_test.py`; created comprehensive unit test suite `tools/grade_test.js` (7 checks passed); created in-app CDP gate `tools/grading_test.py` covering GL vs CPU parity (max <= 1 across 5 parameter sets, color_balance baseline max 1), analytic pixel values on grey 128 (midtones tint, highlights isolation, global lum), command surface (`add_filter`, `list_layers`, `set_filter` unknown param naming 14 keys, `filter_types` listing 14 params), and full document save/open round-trip; verified mutation test on `color-grade` row failing `document_test.js`. Gates `grading` (2s/1s on `--tiles on` and `--tiles off`), `export` (115s), `document` (36s), `commands` (14s), `lint` (0 errors), `types` (0 errors), and `build_node.py --check` ALL PASS with `--offline`. Reviewed with 0 Must Fix in `95c4b4f` / `7f4feed`.
- **R3-S3 built** (2026-10-10): Colour grading wheel control: created pure ASCII module `renderer/editor/inpaint_wheels.js` (DOM only, no DOM at import) implementing `WHEEL_SIZE = 72`, `WHEEL_R = 32`, `puckToHueSat(dx, dy, R)`, `hueSatToPuck(hue, sat, R)`, and `buildWheelsControl(layer, param, callbacks)` presenting four wheels in a 2x2 grid (Shadows, Midtones, Highlights, Global) with puck dragging for hue and saturation, double-click reset to sat 0, and per-wheel brightness range sliders; prepended `{ key: "wheels", label: "Wheels", type: "custom", default: null }` and marked the 12 `*_hue`, `*_sat`, `*_lum` params `hidden: true` in `FILTERS.color_grade` in `inpaint_filters.js` with `control: (layer, p, cb) => buildWheelsControl(layer, p, cb)`; added `.ipc-wheels` and `.ipc-wheel` CSS grid rules in `inpaint_canvas.js`; added `inpaint_wheels.js` to `FILES` in `tools/build_node.py` and synced node build; updated unit tests in `tools/grade_test.js` (9 checks passed) verifying puck reference points (R/2, 0) -> (0, 50) and (0, -R/2) -> (90, 50) and round trip within 1e-9 on a grid; updated in-app CDP gate `tools/grading_test.py` verifying 4 wheels canvases, exactly 6 range sliders (4 wheel lum + balance and blending), pointer events from centre to (0, -R/2) giving `mid_hue` 90 +- 1 and `mid_sat` 50 +- 1 with undo step labelled "Colour grading: Wheels", undo restoring sat 0, double-click resetting sat to 0, and `set_filter { params: { sh_hue: 10 } }` updating parameter; updated `docs/MANUAL.md`. Gates `grading` (1s/2s on `--tiles on` and `--tiles off`), `export` (115s), `document` (36s), `commands` (12s), `lint` (0 errors), `types` (0 errors), and `build_node.py --check` ALL PASS with `--offline`. Reviewed with 0 Must Fix in `2a5b18e` / `71fecf6`.
- **R3-S4 built** (2026-10-10): HSL in 8 channels (`hsl`): added pure ASCII exports to `renderer/editor/inpaint_grade.js` for `HSL_CHANNELS` (8 channels: red 0 deg, orange 30 deg, yellow 60 deg, green 120 deg, aqua 180 deg, blue 240 deg, purple 270 deg, magenta 300 deg), `hslWeights(h) -> [k0, k1, w0, w1]` (smooth periodic partition of unity sum w = 1.0), `hslIdentity(p)`, `hslUniforms(p)`, `hslPixel(r, g, b, p)` (in double precision preserving neutral greys within 1e-9 and leaving low saturation C < 0.02 within 1 level), `HSL_UNIFORMS` (6 `vec4`), and GLSL shader twin `HSL_GLSL` (`vec4 shade(vec4 c, vec2 uv)`); implemented `buildHslControl(layer, param, callbacks)` in `renderer/editor/inpaint_wheels.js` with mode buttons (Hue, Saturation, Luminance), Reset button (Shift resets all 3 modes, regular click resets current mode), and 8 swatched channel sliders (-100..100); added custom control label support to `inpaint_canvas.js` commit callback; registered built-in `hsl` filter layer in `renderer/editor/inpaint_filters.js` immediately following `hue_sat` with custom `channels` control, 24 hidden sliders (`red_h..magenta_l`), `reach: 0`, and `apply: applyHsl`; registered WebGL filter twin `hsl` via `registerGLFilter` in `renderer/editor/inpaint_filters_gl.js`; added `hsl` row to `FEATURES` in `docfile.js` (since 0.1.45, reader 4); updated `tools/document_test.js` sample assertion; updated `special` dictionary in `tools/export_test.py` with tolerance 2; added suites 11-18 in `tools/grade_test.js`; added in-app CDP tests in `tools/grading_test.py` verifying DOM controls, 8 swatched slider rows, mode switching, pointer slider drags with undo labelled "HSL: Red Hue", undo restoring value, Reset button, GL vs CPU parity on both backends, grey preservation, and full document save/open round-trip. Gates `grading` (2s/2s on `--tiles on` and `--tiles off`), `export` (117s), `document` (39s), `lint` (0 errors), `types` (0 errors), and `build_node.py --check` ALL PASS with `--offline`. Reviewed with 0 Must Fix in `55f2355` / `REVIEW_NIK9_2026-10-09.md`. Ready for R3-S5.
- **R3-S5 built** (2026-10-10): Control points v2 (softness, ellipse, texture v2, Escape routing): created pure ASCII module `plugins/film/shapes.js` implementing `SHAPES` (`circle`, `ellipse`), `TEXELS` (32), `innerOf(s)`, `ellipseFollow(pt, m, s)`, `pointWeight(pt, x, y)`, and GLSL twin `SHAPE_GLSL` with `pointFalloff(shape, dNorm, soft)` matching CPU within float precision; softness slider (diffusion 0..100, default 75) with continuous smoothstep falloff, preserving bit-identical behaviour on default 75 vs legacy points; ellipse shape with `r`, `ry`, and `angle`, draggable long axis placement, and dual resize handles; Escape key routing in `inpaint_canvas.js` deselecting points in `film.points` and releasing active box in `boxes` tool; added `point-shapes` row to `FEATURES` in `docfile.js` (since 0.1.45, reader 4 when any non-circle or softness != 75 is used); updated `tools/document_test.js` sample assertion; created unit test suite `tools/points_shapes_test.js` (5 suites covering contract, CPU identity across 200,000 points, softness extremes, ellipse rotation, and GLSL contracts); in-app CDP tests in `tools/film_test.py` covering GL vs CPU parity on ellipse and softness, pure CPU SHA-256 bit-identity on all 3 reference scenes, boundary point tracking across canvas crop/undo/redo/resize/rotate/flip/straighten, and interactive ellipse creation/handle drag/escape deselect. Gates `film` (12s/12s on both `--tiles on` and `--tiles off`), `boxes` (9s), `document` (38s), `assistant` (33s), `commands` (14s), `lint` (0 errors), `types` (0 errors), and `build_node.py --check` ALL PASS with `--offline`. Reviewed with 0 Must Fix in `c7930ef` / `REVIEW_NIK9_2026-10-09.md`.
- **R3-S6 built** (2026-10-10): Polygon and line control points: extended `plugins/film/shapes.js` with polygon and line mathematics: `polySigned(pts, px, py)` (exact segment Euclidean distance with even-odd ray casting), `polyBox(pts, T)` (bounding box expanded by transition width $T$), `interiorAnchor(pts)` (guaranteed interior anchor for concave polygons), `lineFromDrag(A, B)` (normal vector $n$, feather $r$, orientation $angle$), texture packing in `pointsTexture2` (texel 5 holds expanded bbox, texels 6..13 hold up to 16 polygon vertices; texel 4 holds line normal and $T$), CPU twins in `pointWeight`, GLSL twins in `SHAPE_GLSL` with expanded bbox early-out, affine map `mapShape` (mapping polygon corners and analytical line normal transform $n' = \text{normalize}(L^{-T} n)$, $r' = r / |L^{-T} n|$ preserving line weights within $10^{-15}$), and handle hit testing; updated `plugins/film/points.js` with tool drawing state `drawing` for polygon corners (3..16 vertices, close with Enter/double-click/click near first corner, Escape cancels, Backspace undoes last corner), line drag from zero to full effect, handle drags (corners, center anchor, line ends A and B, line center), canvas overlay drawing, layer row controls (feather slider for polygon; feather, angle, and softness for line), and `film.add_point` command parameter validation; 24 MP band GPU pre-measure completed at 2.8 ms (budget <= 150 ms); extended unit tests in `tools/points_shapes_test.js` to 12 suites (all pass); extended in-app tests in `tools/film_test.py` covering GPU vs CPU parity, box reads, affine transformation tracking, interactive polygon and line creation, and command error checking. Gates `film` (12s/11s on `--tiles on` and `--tiles off`), `boxes` (9s), `document` (38s), `assistant` (34s), `commands` (13s), `lint` (0 errors), `types` (0 errors), and `build_node.py --check` ALL PASS with `--offline`. Reviewed with 0 Must Fix in `eed8d8e` / `dce7958`.
- **R3-S7 built** (2026-10-10): Preset hover preview: implemented 120 ms dwell hover preview in Film looks panel (plugins/film/main.js) and mini list buttons on all filter row selects (renderer/editor/inpaint_canvas.js); factored choice preview helpers (applyChoice, previewChoice, cancelChoicePreview, commitChoice, openChoiceList); fixed BUGS:152; measured 15000 x 10000 hover response time at 6.1 ms; updated grading_test.py and film_test.py. Gates grading (both backends) and film (both backends) ALL PASS with --offline. Reviewed with 0 Must Fix in `91f2e37` / `5cc4a45`.
- **R3-S8 built** (2026-10-10): Paste a mask (plus control points copy and paste): added mask clipboard to InpaintCanvas; implemented maskFromLayer(target, source) with token safety, copy-on-write clone() for equal geometry, and transformedAsync with transparent edges for non-equal geometry (1 undo step); added "from_layer" to maskOp and MASK_OPS with source parameter on set_mask; updated mask menu with Copy mask and Paste mask from <name>; added film.copy_points and film.paste_points with document scaling, sqrt area radius scaling, anchor colour re-sampling, 1 undo step, and assistant policy AUTO; measured 15000 x 10000 paste at 25.5 ms and no mirror over 64 MB; created tools/masks_test.py (all 7 PLAN cases pass). Gates masks (both backends), film (both backends), assistant, commands, lint, types, build_node.py --check ALL PASS with --offline. Reviewed with 0 Must Fix in `a1ba819` / `docs/REVIEW_NIK9_2026-10-09.md`.
- **R3-S9 built** (2026-10-10): Effects plugin and chromatic shift filter: second built-in plugin `plugins/effects/` (`plugin.json`, `name: "Effects pack"`, `enabledByDefault: true`); `common.js` with `PRELUDE` (premultiplied bilinear texture sampling `vec4 bilin(vec2 p)` with edge clamp) and pure JS twins `bilinAt`, `makeRunner`, `shader`; `chromatic.js` implementing chromatic shift across styles `plates` (120 deg apart), `lateral` (radial from center), and `linear` (directional along angle) with exact GPU GLSL and CPU twins (max <= 1), `amount: 0` identity, single-pixel white column color separation, scale 0.5 offset halving; `main.js` registering filter `effects.chromatic_shift` with `chain: true` and action `effects.add_chromatic` in Plugins menu; `effects-filters` feature row in `docfile.js` (reader 4); unit tests in `tools/effects_math_test.js` (11/11 pass); in-app CDP tests in `tools/effects_test.py` (all pass on both backends); `docs/EFFECTS.md` created, `docs/MANUAL.md` updated. Gates `effects` (1s/2s on both `--tiles on` and `--tiles off`), `export`, `document`, `commands`, `lint`, `types`, `build_node.py --check` ALL PASS with `--offline`. Reviewed with 0 Must Fix in `103eaa3` / `5b6a200`.
- **R3-S10 built** (2026-10-10): Glass displacement filter I: pure ASCII module `plugins/effects/glass.js` (`// @ts-check`, no DOM at import) implementing `glassField` with $|d| \le 1$ across 4 styles (`ribbed`, `reeded`, `wavy`, `blocks`), `GLASS_SHADER` (avoiding built-in uniform collisions via `u_glassSize` and `u_glassSeed`, directional specular sheen with $L = \text{normalize}(-1, -1, 0.75)$), and CPU twin `applyGlass`; `main.js` registering filter `effects.glass` with `chain: true` and action `effects.add_glass` ("Glass layer"); preserved `def.skip` in `plugins.js`; added `effects.glass` to `special` dict in `export_test.py`; unit tests in `tools/effects_math_test.js` (18/18 checks pass); in-app CDP tests in `tools/effects_test.py` verifying GPU vs CPU parity across all 4 styles (max <= 1), `amount: 0` / `sheen: 0` identity, ribbed on x-ramp unchanged $\pm 1$ where $\sin = 0$, scale 0.5 preview mean 0.2127 <= 3.0, commands, and document save/open round-trip; `docs/EFFECTS.md` and `CHANGELOG.md` updated. Gates `effects` (1s/1s on `--tiles on` and `--tiles off`), `export` (122s), `lint`, `types`, `build_node.py --check` ALL PASS with `--offline`. Reviewed with 0 Must Fix in `70e68fe` / `fdcc2fc`.
- **R3-S11 built** (2026-10-10): Frosted, pebbled glass and frost blur (the 15k measurement): extended `plugins/effects/common.js` with `fbm(p, seed)` (GLSL & JS normalized by / 7) and `blur(src, sigma)` with mirrored edge padding; extended `plugins/effects/glass.js` with styles `frosted` (fractal value noise) and `pebbled` (3x3 jitter search with margin $[0.15, 0.85]$, guaranteeing $d = 0$ at jittered points), added `frost` param (0..20 px) applying pre-displacement blur on `workingSrc` when `frost * scale > 0.05`, updated `reach` and `skip`; added `--filter-params` to `tools/export_test.py` and special entry `"effects.glass#frost"`; extended `tools/effects_math_test.js` (22/22 checks pass); extended `tools/effects_test.py` with in-app parity for `frosted` and `pebbled`, `frost` with `amount: 0` equal $\pm 1$, `filter_types` listing 7 params, and document save/open round-trip verifying `frost: 4`; measured 15000 x 10000 export performance: `effects.glass` defaults 1575 ms composite_bands (112 ms blocked), `effects.glass` frosted with frost blur (amount 10, frost 4) 1512 ms composite_bands (149 ms blocked) vs `film.look` 4606 ms composite_bands (166 ms blocked); updated `docs/EFFECTS.md` and `CHANGELOG.md`. Gates `effects` (2s/1s on `--tiles on` and `--tiles off`), `export` (126s), `lint` (0 errors), `types` (0 errors), `build_node.py --check` ALL PASS with `--offline`. Reviewed with 0 Must Fix in `757e686` / `3ccff98`.
- **R3-S12 built** (2026-10-10): Docs pass, measurements, the user's look: updated `docs/MANUAL.md` (Filter layers chapter: Colour grading wheels, HSL in 8 channels, Effects pack with Chromatic shift & Glass displacement, preset hover preview; film pack: softness 0..100, four shapes circle/ellipse/polygon/line, Escape routing, copy/paste points; Layers notes: copy/paste mask); updated `docs/PLUGINS.md` (API version 4 in line 63); updated `docs/DOCUMENTS.md` (section 4.1 points params to `docs/FILM.md`, section 8 `FEATURES` adds `hsl`, `point-shapes`, `effects-filters`); updated `docs/TESTING.md` (Release 2 `depthfx`, Release 3 gates `grading`, `masks`, `effects` and Node tests `grade_test.js`, `points_shapes_test.js`, `effects_math_test.js`); updated `CLAUDE.md` gate runner list (`edges depthfx grading masks effects`); updated `docs/BUGS.md` (BUGS:152 fixed, Escape routing to plugin tools & boxes fixed, 15k glass speed confirmed); regenerated `docs/COMMANDS.md` with 105 commands (including `film.copy_points`, `film.paste_points`, and updated `film.add_point` parameters); verified manual with `node tools/manual_test.js` and skins with `node tools/skins_test.js`. Reviewed with 0 Must Fix in `328e842` / `70fec7b`.
- **R3-S13 prepared locally** (2026-10-10): The release: updated `CHANGELOG.md` turning `## Unreleased` into `## 0.1.45 - 2026-10-10` with consolidated items; updated version in `package.json` to 0.1.45; ran `npm run dist` producing `dist/win-unpacked/Scumble.exe` and `dist/Scumble Setup 0.1.45.exe`; ran `npm run dist:portable` producing `dist/Scumble-0.1.45-portable-win-x64.zip` (173.2 MB); verified release notes through `python tools/release_notes.py 0.1.45` and `node tools/updater_test.js`; ran exe gates `--offline --exe dist/win-unpacked/Scumble.exe`: `edges depthfx grading masks effects` ALL PASS on `--tiles on` (17s, 5s, 6s, 4s, 3s) and `--tiles off` (22s, 5s, 5s, 2s, 4s); core regression exe gates `selection limit maps maskview clip groups film document commands assistant` ALL PASS on `--tiles on`. Ready for the user's release command (step 4 look with user, tag push, publish draft, manual sync, and blog post).
**Waiting for the user:**
- **The Store update**: `dist/Scumble-0.1.44.msix` (187,490,440 bytes) and `dist/store-listing/whats-new-0.1.44.txt`
  built; Partner Center through Claude in Chrome, *Submit for certification* only on the user's yes.
- **The MCP Registry**: `server.json` is 0.1.44 (109 tools); `mcp-publisher login github`, `validate`, `publish`.
- The portable test copy under `dist/portable-test/` (started for the user's test; delete when done).
- Item 43 (relight) is researched and planned (`docs/PLAN_RELIGHT.md`), its §5 questions open; after the Nik block.

**0.1.43 is out** (tag v0.1.43, published 2026-10-07T20:27:04Z; the post `v0-1-43` live; the manual synced). Built the
same day from `docs/PLAN_0_1_43.md`, every row with its "As built": Nano Banana 2.1 on Gemini direct and seven hosts
(N1, N2; never run live), B1-B6 (agent errors, the assistant's notices, the Film looks panel, the ComfyUI window, the
cutout's 24 GB, the boxes after Generate new), S1 (Settings groups), S2 (star and share). The exe gates ran on both
backends; the editor gate without two mips-worker steps that failed at the morning's commit too while DaVinci Resolve
rendered a video (`docs/TESTING.md`). **Waiting for the user:**
- **The Store update**: `dist/Scumble-0.1.43.msix` (187,427,628 bytes) and `dist/store-listing/whats-new-0.1.43.txt` are
  built; the submission in Partner Center through Claude in Chrome, *Submit for certification* only on the user's yes.
- **The MCP Registry**: `server.json` is 0.1.43; `mcp-publisher login github` (the user's device code), `validate`,
  `publish`. 0.1.42's publish never happened either (its listing still says 96 tools; 105 now).
- **P3's live run** (`bash tools/run_gates.sh rel42-portable --exe dist/win-unpacked/Scumble.exe portable`) once the
  user's Scumble is closed.
- Tell the user (still open from 0.1.42): their DLSS5 Fit Input Size node allows 33 MP outputs, above Scumble's 27.9 MP.
- A live run of Nano Banana 2.1 (about $0.05 at 2K with the user's key) settles v1 / v1beta and the thinking level's
  spelling (`docs/PLAN_0_1_43.md` §5); the ComfyUI window's new layout was never seen in a real ComfyUI page.
- **Found and not built** (`docs/BUGS.md`): Generate new on WaveSpeed without references goes to ten model ids whose
  pages answer 404.

Older hand-overs, the full text of the list and of the open threads are in `docs/HISTORY.md` (newest first,
verbatim). Check `gh release list` before believing any release state written down anywhere.

**Still asked, waiting for the user's word:**
- **The user asked earlier** whether a GitHub community setup makes sense (Discussions with Showcase / Ideas / Q&A /
  Workflow recipes, a Now / Next / Later / Won't do roadmap, 3-5 good first issues, CONTRIBUTING / issue templates /
  SECURITY, a pinned "Share your workflow" thread). Answered: yes to Discussions, the templates, CONTRIBUTING and
  SECURITY, a small roadmap as one pinned issue or discussion without other products' names, kept with each release;
  good first issues only if outside PRs are wanted; the pinned thread once Discussions are on and seeded. **Nothing
  done, waiting for the user's pick** (outward-facing; its own section after a commit).
- **Asked earlier, still waiting for the user's word:** the README for reach (a GIF, install buttons, a comparison
  table, Discussions), the Inpaint Canvas node's registry entry linking to Scumble, how to post on Show HN (the
  comparison table names other products, the user's rule of 2026-09-29).

**One section per session, then `/clear` (the user, 2026-09-30: "immer clear nach abschnitten"; before: at most two
build steps, 2026-09-28):** one numbered step of the plan, its commit and the hand-over, then stop. the context rose to 85 % in
one session of eight steps (its own tool output and patch scripts, not this file); commit, write the hand-over, stop.
Read maps and code with grep and offsets, edit with Edit rather than long patch scripts, keep gate output to a summary.

**How the work goes (the user, 2026-09-26):** tests by risk (Working rules); few agents - the main loop builds, one or
two background agents take separate files (a gate, tests against a stated API, docs), one package at a time, a local
commit per step; check the 5-hour window (`mcp__ccd_session_mgmt__get_usage`) and stop at a committed state around 70
to 80 %. A release only on the user's word; everything before it (CHANGELOG, `npm run dist`, exe gates) may be
prepared locally.

## Open threads

The full text is in `docs/HISTORY.md` ("Open threads", moved there on 2026-09-27 night).
- **The Store listing is live** (the user, 2026-09-30: https://apps.microsoft.com/detail/9NDBTNNMXF2R, signed by
  Microsoft; identity `DenRakEiw.Scumble`). The README links it (Install (Windows): Store or GitHub), the website hub too since 0.1.38
  (2026-10-03, with the post). Submission 1 (2026-09-30) held the first Store version; **0.1.41 was submitted
  2026-10-04 (submission 2, the user in Partner Center: the MSIX built here, the What's new text, the trailer
  "Scumble explained" with `dist/store-listing/hero-1920x1080.png` as its thumbnail); 0.1.42 followed and is the
  live Store version (the listing, read 2026-10-07).**
  **A Store update with every release, clicked through in the user's Chrome** (the user, 2026-10-04: first "nur nach
  essenziellen änderungen", then "wenn du es in chrome machen kannst dann doch jedes mal"; the submission API needs a
  company account, the user's is not one): `npm run dist:store`, a What's new text, then Claude in Chrome in Partner
  Center (the user logged in; the upload of the ~190 MB MSIX through the extension never tried yet; *Submit for
  certification* only after the user's yes in chat each time). If the upload does not work: essential changes only,
  the user's three steps by hand (`docs/RELEASING.md`).
- **Not started:** B3, the macOS build (`docs/PLAN_0_1_24.md`); Comfy Router
  live runs beyond GPT Image 2, Nano Banana 2 (2026-09-23) and FLUX 3 Image (2026-10-03; the key in `dist/live-keys`); Linux built by CI, never run; types stage 3 (`docs/PLAN_TYPES.md`);
  the manual's empty assistant and log screenshots and a missing colour-match figure (`docs/MANUAL.md` is the one
  source, the website copies it via `tools/manual_sync.js`); the node repo is behind (build it only when a node version
  ships; `nodecopy` tests it); the assistant's A10 / A11 only on the user's word.
- **Material:** *Settings > API providers* shows the last four characters of stored keys: mask them in any screenshot
  for the web. The tutorial material (`docs/TUTORIAL.md`, `docs/images/tutorial/`, `docs/images/video/`) stays
  uncommitted until the user says so.
- **Standing:** the user's ComfyUI (8188) is a production machine (no `smoke` and no forwarding gate unless the user
  says it is free; gates run `--offline`). Tune for 15k, not 30k. One-channel masks on ice; `inpaint_canvas.js` is
  split only where a subject is reworked anyway; the object tool's change A parked; tiles are the default, the canvas
  backend the escape hatch. A parked idea, not a plan: a mobile companion.
- **Unverified:** ToAPIs and ModelArk live; OpenRouter beyond GPT Image 2.5 Flare / Sunburst and FLUX 3 Image (live 2026-10-03); Magnific beyond the two
  upscalers and Oxen (docs only); the Qwen Image Edit 2.1 local recipe (models not downloaded); a real SAM2 / RMBG model
  on the slice 6 code; the user's own 15k file. Deferred from 3f: the source's EXIF / XMP in exports, an ICC profile in
  PSD and TIFF. Not checked: a double click in Explorer on an installed build, TIFFs written by other image editors.

## What comes next (the list)

The numbered list the user adds to (the numbers are cited elsewhere). The full text and research of every item is in
`docs/HISTORY.md` "What comes next" (the latest full copy): read it before planning one of them.
- Built: 1-13, 17 (the side panel's width), 18 (the logo; open: the mascot's other poses, the About dialog, the
  website), 20 (skins; later on the user's word: a theme editor, light / dark after the OS, density, icon sets), 23
  (23a in 0.1.31, 23b for 0.1.32), 24 (the canvas-only view).
- 5: the object tool's change A (the image-size label map, `dist/c6map/c/objects.md` §7-§9), parked.
- 14: upscaling beyond the API upscalers (ComfyUI, ONNX, a desktop upscaler by CLI / MCP), parked, only listed.
  Added 2026-10-03 for a later update (the user asked for DLSS): DLSS itself needs a game renderer's motion vectors
  and depth and has no picture API; NVIDIA's RTX Video Super Resolution node is installed on the user's ComfyUI, so a
  local upscale recipe on it, then the whole picture for local upscale recipes: `docs/PLAN_RTX_VSR.md`. 2026-10-04: the
  user wants RTX VSR as a local **and** a Comfy Cloud upscaler (Comfy Cloud has the node; its API form is in the plan),
  and DLSS 5 Neural Rendering on pictures (the community pack `ComfyUI-DLSS5-Enhancer`, not installed yet: the user
  installs it; the design and the jury question in the plan's last section). **Decided the same day: RTX VSR (local
  and Comfy Cloud) goes into 0.1.42, and so does item 37.**
- 37: the **Realism Pass** (the user, 2026-10-04: "der ideale fix für das plastic skin problem von flux"; the name is
  the user's): DLSS 5 Neural Rendering through the community pack ComfyUI-DLSS5-Enhancer on the user's own ComfyUI,
  labelled **"Realism Pass (Windows only, RTX only)"**, no Comfy Cloud alternative, local only (the worker is Windows
  only; NVIDIA's SDK has no Neural Rendering, Linux or otherwise). **The next feature, release 0.1.42** with RTX VSR
  and the portable zip (item 36): `docs/PLAN_0_1_42.md`; research in `docs/PLAN_RTX_VSR.md`'s last section. **R1 (the
  recipe, the server check, the hints, shipped presets L and M) built 2026-10-04**, not run live; R2a and R2b the
  same day; **redesigned that evening as a refiner** (the whole picture at 1x as a new layer, never a Generate result:
  plan §1 "The Realism Pass is a refiner"); **R3a, R3b and R4 built the same night** (`host.realismWhole`; the Upscale entry, the Image menu, `realism_pass`; the assistant's row and readiness in `status` / `list_recipes`), R5 to P3 the next night; **released in 0.1.42 (2026-10-05)**, with the Realism Pass Upscale and the 27.9 MP cap found live.
  OpenDLSS-NR and the other open reimplementations of the network (checked 2026-10-05): **parked until there is a
  cleaner way** (the user; `docs/PLAN_RTX_VSR.md` last section: they all need NVIDIA's extracted weights; found there:
  the runtime's NR library is an unsigned, modified build; the RTX 40 / 30 question in `docs/BUGS.md`).
- 38: new commands for MCP agents (the user, 2026-10-04: "schau auch noch ob noch mehr commands in den mcp aufgenommen
  werden können"): 28 verified candidates in `docs/PLAN_MCP_COMMANDS.md`; **the user picked 12** (marked ✓) for 0.1.42,
  sessions F2a / F2b after the six fixes of F1 (all six picked from `docs/BUGS.md` the same day). The other 16 wait
  for a later update. **The 12 built (F2a, F2b), released in 0.1.42.**
- 39: a tidier Settings dialog (the user, 2026-10-05, with a screenshot of *Settings › Recipes*: "das einstellungs menü
  aufräumen. die model liste ist zu lang / auch die anbieterliste; kann man das aufklappbar machen?"): 60 recipe rows
  and 16 key rows in one flat list today. **Decided the same day:** recipes in three collapsible groups (ComfyUI /
  Comfy Cloud / API models, family sub-headings, count / ready / in use on each group's line, the active one open), no
  filter field, only the two long lists collapsible (recipes and API providers), the open state in `localStorage`.
  `docs/PLAN_SETTINGS.md` (what exists, the shape, the traps: the gates that read the rows, rebuilds that reset the
  DOM, the skins; both answered 2026-10-07: the providers one group as they are, Remove only on own recipes). **Built
  2026-10-07 for 0.1.43 (S1).**
- 40: a GitHub star link in the app (the user, 2026-10-05: "irgendwo in der app ... wo es nicht nervt", then the exact
  wording and places): **"⭐ Star on GitHub"** directly in the Help menu (beside *Scumble on GitHub*,
  `electron/main/main.js:695`) and in *Settings › About* (today one line with the repo link, `renderer/index.html:186`,
  `shell.js:2605`), and **after a successful update, once per version: "⭐ If Scumble is useful to you, consider
  starring the repo — it helps the project get discovered."** (the user's wording of 2026-10-07, replacing "Enjoying
  the new version? ⭐ Star us on GitHub"): on the first start of a new version (the last version seen kept in the settings), a quiet line that can
  be closed, never a modal and never again for that version; whether it shows in the Store copy (the Store updates
  it) and beside item 32's update dialog is a design question. Opens https://github.com/DenRakEiw/scumble through
  `shell.openExternal`. **Beside it "↗ Share the project"** (the user, the same evening): suggested, not yet confirmed,
  a small menu at the button (Windows has no share sheet for Electron): *Copy link* (text + link to the clipboard,
  "Link copied") and the platforms' own share pages in the browser (X intent, LinkedIn share-offsite, Bluesky intent,
  Reddit submit) with a prefilled line such as "Scumble: a free, open-source editor for AI inpainting"; the link the
  website hub https://www.denrakeiw.com/scumble (download, videos, manual), no UTM or tracking. In the same three
  places as the star. Small (a few hours together). **Built 2026-10-07 for 0.1.43 (S2): the shared link is the GitHub repo.**
- 41: **Nano Banana 2.1** as a new model (the user, 2026-10-07, with Google's page
  https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/nano-banana-2-1). Known so far (Gemini
  API model page, 2026-10-07; the Cloud page renders no body for a fetch): model id `gemini-nano-banana-2.1`, GA,
  released 2026-10-06; text, image, video and PDF in, image and text out; up to 14 reference pictures (4 characters,
  10 objects); 1K / 2K / 4K (default 1K), also 1:4, 4:1, 1:8, 8:1 at 2K and 4K; thinking (minimal / medium / high),
  search grounding (web and image search); news says better editing and subject consistency at half the price
  (unchecked). Scumble today: `recipes/nano_banana_2.json` (Gemini 3.1 Flash Image) with a direct `gemini` variant
  (`electron/main/providers/gemini.js` takes the model from the recipe) and variants on fal, Replicate, WaveSpeed,
  Comfy Cloud, ToAPIs, OpenRouter, Comfy Router and Oxen. Likely shape: a recipe `nano_banana_2_1.json` on the
  direct Gemini adapter first (model id, the size classes, the new ratios, the 14-picture limit in `layout`), the
  other hosts as they list it; open: whether its edit path differs from 2's, the thinking level as a setting.
  **Planned for 0.1.43 (2026-10-07): `docs/PLAN_0_1_43.md` N1 (Google direct) and N2 (fal, Replicate, WaveSpeed,
  OpenRouter, Comfy Cloud, Comfy Router, ToAPIs; Oxen does not list it), docs only, no live run.** **N1 and N2 built 2026-10-07** (`recipes/nano_banana_2_1.json` with eight hosts, `gemini.js` thought parts and Thinking).
- 42: **Match an inpaint layer's edges to the layer below** (the user, 2026-10-07: "manchmal kommt der inpaint leicht
  verschoben heraus, damit kann man es automatisch auf die ebene darunter matchen"): edit models re-render the whole
  crop and often shift or slightly scale it, so contours double where the selection border crosses an edge. Known:
  the node already does this at stitch time (`nodes.py` `_align_patch`: an affine ECC fit, OpenCV, on the ring where
  the base stays visible, at most 512 px; kept only within 8 % scale, 0.03 shear, 5 % shift and when the ring
  difference drops by 3 % or more; it reports aligned / reason / scale / shift); the app has the crop setting
  `align: true` but `renderer/editor/stitch.js` `finishResult` answers `{ aligned: false, reason: "not available in
  the app" }` (no OpenCV in the app; the manual says so). Two parts: (a) the same fit at result time in the app (an
  ECC / Lucas-Kanade fit in `crates/px` or a small JS one; OpenCV.js is Apache-2.0 but about 8 MB), so new results land
  aligned; (b) **after the fact** on any layer: a layer-menu entry, an MCP command and maybe a button on result
  layers, "Match edges to the layer below", fitting the layer's own edge ring (its alpha / mask border) against the
  composite under it, moving or warping the layer as one undo step, with the report in the status line and a manual
  nudge as the fallback. Tests: normal tier (a result shifted and scaled by known amounts comes back within a pixel;
  a flat area or a too-large fit refuses). **Built 2026-10-08** (affine Lucas-Kanade edge ring fit in `renderer/editor/edgefit.js`, `matchEdges` on `InpaintEditor`, context menu entry, MCP command `match_edges`, live result alignment in `renderer/editor/stitch.js`, `tools/edgefit_test.js` 9/9 passing).
- 15: Qwen Image Edit 2.1: the local recipe never ran; the API side is open.
- 43: **Relight: virtual lights on the picture** (the user, 2026-10-09, with a link to a commercial editor's beta of
  2026-09-28; **the update after the Nik 9 block**, releases 2 and 3). Up to a few lights dragged on the canvas, each
  with colour, intensity and diffusion, an Original light slider, a screen-only preview, the result as a new layer.
  Research and the plan: `docs/PLAN_RELIGHT.md` (the depth map carries placement, falloff and shadows; normals come
  first from its gradient, in phase 2 from MoGe-2 ViT-S normal, MIT, ONNX; routes: an in-app shader on the filter
  infrastructure, Magnific's relight endpoint taking Scumble's own light map, a local generative recipe only on a current model (no IC-Light SD 1.5, the user), fal's two
  direction-word endpoints as presets; the user's questions R-D1 to R-D5 in its §5; about 6-8 sessions plus 4-5).
  Nothing built.
- 44: **grow the Rust kernels, no rewrite** (the user, 2026-10-09, after asking whether Scumble should be rewritten in
  Rust: no, the shell stays Electron; "schreibe auf den plan wasm kernel wachsen lassen"): `docs/PLAN_WASM.md` ranks
  the CPU paths worth moving into `crates/px` (the edge snap and guided filter maps, histograms and the limit rows,
  the compositor's CPU band, the stroke kernels, a threads spike), with the rules (measure first, the JS kernel stays
  the reference and fallback, both wasm builds, one kernel per session). Nothing built.
- 16: Oxen.ai: built from the docs, never run (no key).
- 19: 3D layers from AI models (Meshy / Hunyuan 3D / TRELLIS into glb layers), only listed.
- 21: lens flares (an optional plugin, 7-9 days), no place in the order yet.
- 22: a filter-suite update (an update of its own; `docs/PLAN_NIK9.md`, 34-46 days plus two folded packages), suggested
  after B3. **The build plan (Umbauplan) is `docs/PLAN_NIK9_BUILD.md`** (the user, 2026-10-04: "nur den plan ... als
  eine art umbau plan .md", "detaillierter ... was später den umbau vereinfacht"; one workflow, 12 agents, anchors
  read at b6c5238): foundations F1-F12 first, then 57 core sessions (61 / 66 with the optional ones), 48.5-55 days
  inferred; release 4 (blend modes) and release 3 do not depend on release 1; the user's open questions in its §6.
  **Release 1 (masks) built 2026-10-08/09 by the other agent and released as 0.1.44 (2026-10-09)** after two reviews
  and the user's test; **releases 2 and 3 next, as one block with one release at the end** (the user, 2026-10-09),
  a review after every session; release 4 independent.
- 25: the app's own dialogs instead of the native boxes: built 2026-10-01 (`renderer/dialogs.js`, main's `askWindow`
  with the native box as the fallback), released in 0.1.36.
- FLUX 3 Image (not numbered; BFL's launch 2026-10-01): released in 0.1.36 the same night.
- 28: boxes in the prompt for FLUX 3 Image and Ideogram 4 (the user, 2026-10-01 night: the selection as a FLUX 3
  bounding box, then a plugin like Kijai's Ideogram 4 prompt builder): `docs/PLAN_BOXES.md` (BFL's documented rows
  on a 0-1000 grid; the design: the renderer sends box geometry as fractions of the crop, main's
  `providers/boxes.js` writes the rows after `resolveNames`, plugins supply boxes through
  `scumble.generate.register`; S1 the selection as a box behind a FLUX 3 row, S2 the hook, S3a-c the built-in
  "Boxes" plugin, S4 Keep rows from the SAM2 objects; §8-§12 the implementation plan per session, §6 the live
  checks after S1, §7 the open questions). **S1 built 2026-10-02** (the selection as a box; its Settings row went in S3d), **S2 the same day**
  (plugin API 3, `scumble.generate.register`, the sample's source behind `sample.box`) and **S3a the same night**
  (`plugins/boxes`: the data, the panel in the Generate pane, the six commands, the generate source), **S3b** the
  same night (the canvas tool X and the overlay), **S3c** the next session (the crop frame, the paste warning), **S3d**
  the session after (one Boxes switch under the prompt field, the first box turns it on), **S3e** the one after (the
  caption's place words, ids from the description, the warnings, the tool's hit order); none released, all under
  Unreleased. The live checks §6.1-6.3 ran on 2026-10-02 night, released in 0.1.37 the same night; S4 optional. **S5 (Ideogram 4)
  built 2026-10-03** after live check §6.4 (fal passes the caption), released in 0.1.39 the same day.
- 26: reference layers named in the prompt as `@img1`, written as each model's own name for the picture: built
  (S1-S5, 2026-09-29; `docs/PLAN_REFS.md`), released as 0.1.34 the same night.
- 27: groups with their own opacity and blend mode (isolated groups: the group composited first, then faded or blended
  as one, so overlapping layers inside do not show through each other; a nested composite in every path and the
  blend-atop ops in the kernel, 7 - 9 days; `docs/PLAN_0_1_31.md` §6 step 5). Parked, someday maybe (the user,
  2026-09-30: "nicht so wichtig"; merging the layers and setting that layer's opacity does it today).
- 29: FLUX 3 Image on the other providers (the user, 2026-10-02): fal (blackforestlabs/flux-3/edit-image and its text
  sibling), WaveSpeed (the user's link was image-to-video; whether it has FLUX 3 Image is part of the research),
  OpenRouter (black-forest-labs/flux-3-image) and Oxen.ai (flux-3-image), as variants of `recipes/flux3.json` on the
  existing adapters. Researched: `docs/PLAN_FLUX3.md` "FLUX 3 Image on other providers". **Comfy Router (B1) and OpenRouter
  (B3) built 2026-10-02 late night, run live and released in 0.1.38 (2026-10-03)**; **fal (B4), Oxen (B5) and WaveSpeed (B6) built 2026-10-03**,
  released in 0.1.39 (2026-10-03), not run live.
- 30: Ideogram 4 support as an update of its own (the user, 2026-10-02: "ein anderer release", not with item 28's
  boxes). Known so far (one web search, 2026-10-02): Ideogram 4.0 is Ideogram's first open-weight model (9.3B flow
  DiT, Qwen3-VL-8B text encoder, June 2026; weights non-commercial, 256-2048 px, aspects up to 6:1), structured JSON
  prompts with bounding boxes, Turbo / Default / Quality tiers on Ideogram's own API, a remote MCP server; on fal
  since September 2026. Scumble today: `recipes/ideogram_4.json` (fal `ideogram/v4/image-to-image`, Comfy Router and
  Oxen text only); fal ran live 2026-10-03 with the boxes as its JSON caption (B2, item 28 S5). Open: Ideogram's own API as a direct adapter (the tiers, edit / remix with a
  mask?), a local ComfyUI recipe on the open weights (the user has Ideogram 4 nodes), the JSON caption with the
  boxes (item 28 S5, built 2026-10-03 on fal). Not researched in depth, nothing planned.
- 31: Ideogram 4.5 (the user, 2026-10-02: "kannst du in diesem release noch ideogram 4.5 hinzufügen", then "nur über
  documentation hinzufügen, kein test nötig"): in the next release with item 28, built from the providers' docs only,
  no live run. Hosts: Replicate (`ideogram-ai/ideogram-4-5`), Comfy Router (the schema saved as
  `tools/refs/comfyrouter/ideogram_ideogram-4-5.json`), WaveSpeed (`ideogram-ai/ideogram-v4.5/edit` and siblings); the
  adapters exist. Research and the build plan: `docs/PLAN_IDEOGRAM45.md`. **I0 + I1 built 2026-10-02** (the shared
  helpers, `recipes/ideogram_4_5.json` with its Replicate variant, `tools/ideogram45_test.js`; Unreleased), **I2** the
  same day (the WaveSpeed variant, the `accepts` allowlist), **I3** the same day (the Comfy Router variant), **the README / MANUAL lines** the same day: built, under
  Unreleased. Released in 0.1.37 (2026-10-02 night), never run live.
- 32: a popup when a new version is out (the user, 2026-10-02 night: "Beim start der app nach updates suchen und mit pop
  up benachrichtigen wenn es eine neue version gibt"). **Half of it exists:** the installed app checks GitHub 8 s after
  the start (`main.js` `updater.check()`, unless *Settings > Updates* has it off; not headless, not in agent mode, not
  in the Store copy), downloads by itself (`autoDownload`) and then shows only a quiet `Update to <version>` button in
  the title row (`#shell-update`); the release notes sit in *Settings > Updates*. Missing: a dialog through item 25's
  `renderer/dialogs.js` once the update is downloaded, with the version and its CHANGELOG notes, *Restart and update* /
  *Later* (maybe *Skip this version*); once per version, not on every start; not while a document is busy or unsaved
  without asking first (the restart path `restartPlan` exists); none in the Store copy (the Store updates it) and none
  for Linux packages that cannot update themselves. Small (about half a day); planned as `docs/PLAN_0_1_38.md` A1. **Built 2026-10-02 late night** (c3872b7), with a real
  Skip (no install on quit), released in 0.1.38 (2026-10-03).
- 33: every box its own colour and a double click that describes a box on the canvas (the user, 2026-10-02 night,
  with a screenshot of six green boxes: "jede neu box soll eine andere farbe haben", then "mit doppelklick auf die box
  ... den prompt im canvas in die box schreiben"): built the same night (7de1423), released in 0.1.38 (2026-10-03).
- 34: Generate new with presets and boxes (the user, 2026-10-03: "wie können wir flux3 bbox prompting als 'generate
  new' nutzen? macht es sinn presets für 'new' zu nehmen ... aspect ratio und model auswahl ... 1k, 2k, 4k"): a New
  dialog with the model, its own aspect presets and its size classes makes the canvas the boxes are drawn on in the
  output's aspect; Generate new follows the document's aspect while boxes go. Today the dialog's aspect is its own
  (1:1 at first, then the last one), so boxes go stretched when it differs from the canvas (BFL: send the aspect the
  boxes were designed for); FLUX 3 takes only New boxes on a new image, and Generate new with boxes never ran live on
  FLUX 3. `docs/PLAN_NEW_PRESETS.md` (what exists, the trap, four steps, the open questions). Nothing built.
- 35: ComfyUI in Scumble (the user, 2026-10-03: "ist es möglich eine art browser in scumble zu öffnen in dem dann
  comfyui läuft?", the point being the connection to the recipes, "das ist erstmal das wichtigste update", and "auch
  die option testen comfy.cloud in scumble"): ComfyUI's own page in a window of its own (a `BaseWindow` with Scumble's
  bar on top), a recipe opened there as its graph and the graph saved back as a recipe; Comfy Cloud in the same window,
  and recipes without the Inpaint Canvas node (Comfy Cloud has none and takes no custom nodes) run there through
  `comfycloud.js`'s calls. The user's answers (2026-10-03): a window of its own, Comfy Cloud API access yes, *Save to
  recipe* overwrites, all five steps in **one update**, the *ComfyUI* button after *Help* and *Assistant*. Two rules for
  every step (the user, the same day): **Scumble keeps working without any ComfyUI installed**, and **no ComfyUI
  install path is assumed** (users' installs differ; everything through the URL and `/object_info`): §2.5.
  `docs/PLAN_COMFY_VIEW.md`: what exists, the design, V1-V5 (one session each), the traps. Nothing built.
- 36: a portable version as a `.zip`, from the release after 0.1.41 on (the user, 2026-10-03: "ab dem nächsten release
  auch als portable version, ja, als .zip"; asked first whether it is usual: yes in Scumble's field, ComfyUI itself
  ships as "windows portable", Blender / Krita / Inkscape offer zips). Agreed shape: the `win-unpacked` folder zipped
  (not electron-builder's one-file `portable` target, which unpacks to a temp folder on every start); a marker next to
  `Scumble.exe` puts every app-data path (settings, autosave, the file mirror, plugins, helper models, documents'
  temps) into a folder beside it (`app.setPath("userData", ...)` before anything reads it, the single-instance pipe
  follows the path); API keys stay bound to the Windows account (safeStorage / DPAPI), so another PC asks for them
  again (the manual says so); no self-update (electron-updater does not do zips): item 32's dialog shows *Download*
  with the release link instead of *Restart and update*; MCP registration names the exe's own path. CI: a zip asset in
  `.github/workflows/build.yml` beside the installer; the installer stays the recommended download (README, website).
  To test: the data folder (quit, document, autosave, settings gates on a portable layout), two portable copies side by
  side, the update notice. About half a day to a day. **P1 (the data folder, the update notice, stale keys) and P2
  (`npm run dist:portable` = `tools/portable_zip.js`, the CI upload to the draft, the docs) built 2026-10-05**
  (`docs/PLAN_0_1_42.md`); P3 (the `portable` gate on the exe, on the user's word) is open.

## Gate runner and flakes

`bash tools/run_gates.sh <label> [--strict] [--copy] [--tiles on|off] [--offline] [--exe PATH] <gates...>` starts a fresh instance on
port 9555 with its own profile (with `test_base.png`), runs each gate with a timeout, and writes logs and `summary.txt` under
`dist/gates/gates/<label>/` (or `$SCUMBLE_GATES`). `tools/close_app.py` closes an instance by its DevTools port
(`SCUMBLE_CDP_PORT`). Gates: `pixels editor composite commands shape brush film glb ailabel size transparent generate log
mcp nodecopy toapis openrouter ark recipes assistant llm export pxjobs upscale layered platform lint types help skins
magnific oxen quit document docux metadata tiff canvasonly clip groups comfyview portable selection limit maps depth maskview edges depthfx grading masks effects mcpb`, plus `docperf:<W>x<H>` (a .scumble save and open at size), `smoke` (a real Flux run; check `/queue` first, and not while the user needs
ComfyUI), `perf:<W>x<H>`, `exportperf:<W>x<H>[,--filter=film.look]`, `tiffperf:<W>x<H>` (a TIFF export and open at size) and `huge:<W>x<H>` (the 30k gate; it refuses to run
against a connected instance). `quit` and `quit:<W>x<H>` start and close their own instances (port +17): a test that
closes the app must send WM_CLOSE, since a page's `window.close()` skips the window's close event. **`--offline` starts the instance with `--no-comfy`**: it does not connect, so no upload is
forwarded to the user's server. A fresh gate profile otherwise connects to `127.0.0.1:8188`, the user's ComfyUI, and
forwards every upload of every gate to its input folder; use `--offline` for everything but `smoke`. Run a change on both backends (`--tiles on` and `--tiles off`); a release also runs against
`dist/win-unpacked/Scumble.exe` with `--exe`, each run on its own profile.

Known flakes: `docs/TESTING.md` "Known flakes". **Re-run a failing gate before believing it** when its step is listed
there; add a new flake there, with the date and what was ruled out.

## Traps worth keeping

**Chromium, canvas, WebGL**
- Chromium applies `UNPACK_PREMULTIPLY_ALPHA_WEBGL` to `ArrayBufferView` uploads too; set both unpack switches explicitly
  before every typed-array upload, or premultiplied tile bytes get premultiplied twice.
- Once at least 100 `getImageData` calls have disabled acceleration and they reach 95 % of all canvases created, Chromium
  makes every new canvas software; a test with a readback after every step can trip it.
- `globalCompositeOperation` `copy` and `destination-in` apply to the whole canvas; a regional use needs `clip()` first (the
  vanishing-layer bug of 0.1.8).
- `drawImage` with `copy` and image smoothing on changes pixels by up to 2 levels even at the same size and whole offsets
  (a GPU canvas into a CPU one, measured 2026-09-26); `source-over` or smoothing off gives the bytes. `canvasRows` sets
  smoothing off.
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
- A `contenteditable="plaintext-only"` element gets no `getTargetRanges()` for deletes (Backspace: `[]`, measured
  2026-09-29): the prompt field computes every delete from its own string. `innerText` breaks lines around flex items and
  absolutely positioned elements (both are blockified): a chip that `innerText` must read as `@img1` is `inline-block`
  with `inline-block` children.
- A popup that opens under a resting pointer gets `pointerenter` / `pointermove` from Chromium's move of no distance
  after the layout (measured 2026-09-29, the @ picker's rows): hover-select on `pointermove` with a non-zero
  `movementX` / `movementY`, or the row under the mouse steals Enter.
- `texSubImage2D` and `readPixels` take a view on a `SharedArrayBuffer` here (Electron's Chromium): no copy between the
  workers' buffer and the GPU (B item 7 part 2). 572 MB go up in 0.1 s and come back in 0.2 s, on the main thread.

**Electron and Windows**
- `session.webRequest` headers reach a page's websocket handshake only when the URL filter names the `ws://` /
  `wss://` origin beside the `http(s)://` one (measured 2026-10-03, Electron 44.2.0; a `login` answer covers the
  websocket by itself). `Menu.setApplicationMenu` puts the menu on every window on Windows and Linux, a `BaseWindow`
  included: a window that must not fire Scumble's accelerators drops it again after every `buildMenu` and sets
  `setIgnoreMenuShortcuts(true)` on its views (`comfyview.js`).
- An occluded window (a gate behind other windows) reports `visibilityState` "hidden" and drops keys sent with
  CDP `Input.dispatchKeyEvent` unless `Emulation.setFocusEmulationEnabled` is on; a key into the editor's page
  reaches no menu accelerator while another Scumble window has the focus.
- electron-updater installs a downloaded update on every normal quit (`autoInstallOnAppQuit`, on by default) and adds
  that quit handler only when a download ends with the switch on: a Skip has to turn it off in main, and a Skip taken
  back has to add the handler (`updater.js` `_applySkip`, 6.8.9).
- Claude Desktop runs a `node` extension server in an Electron UtilityProcess whose `nodeHost.js` replaces
  `process.stdout.write` and `process.stdin` by MessagePort messages and loads the entry with `import()`: a child
  spawned with `stdio: "inherit"` answers nobody, and `require.main === module` is never true (the `.mcpb` starter,
  `docs/PLAN_MCPB.md` §1; measured 2026-10-09).
- In the main process `process.stdin` never emits `data` from a pipe (read fd 0 with `fs.createReadStream`); Electron prints
  a CR LF to stdout before any JS runs (hence the MCP launcher); a window created hidden stays hidden after `show()`,
  `restore()` brings it up.
- Electron has no `window.prompt`; the editor has its own `ask()` modal.
- Only one instance runs per data folder (single-instance lock and named pipe), including headless `--mcp`
  instances; a portable copy has its own data folder, so it runs beside an installed one.
- `npm run dist:store` rewrites `dist/win-unpacked` without `resources\app-update.yml` (`npm run dist` writes it):
  `npm run dist:portable` goes between the two, and refuses a `win-unpacked` without the feed. Git Bash's `tar` is
  GNU tar and writes no zip; `%SystemRoot%\System32\tar.exe -a -c -f x.zip` (bsdtar) does, and Explorer's zip
  handler unpacks it (measured 2026-10-05).
- An unsigned MSIX cannot be installed when it holds an app (0x80073D2B), whatever `-AllowUnsigned` and the
  publisher OID say, and a registered layout refuses that OID (0x80073D2D); a test install is Developer Mode plus
  `Add-AppxPackage -Register` of the unpacked layout with a plain test publisher (`docs/STORE.md`).
- `makeappx.exe` started from electron-builder's cache under `%LOCALAPPDATA%` fails with "side-by-side
  configuration is invalid" (from Node and PowerShell; Git Bash ran it), the same files from `F:` run.
- With `ELECTRON_RUN_AS_NODE` and `-e`, a switch after the code is taken for a Node option ("bad option:
  --mcp"); after `--` it lands in `process.argv[1]`, not `[2]`.
- `mcp_test.py --user-data-dir` must come before `--cmd`, which otherwise takes it for its JSON.
- A test that starts the exe from Python needs its absolute path: `subprocess` with the runner's relative
  `dist/win-unpacked/Scumble.exe` fails with WinError 2 (`docux`, 2026-09-27).

**Tooling, shell, git**
- The Bash tool's heredoc breaks on an apostrophe in its text even with a quoted delimiter (`unexpected EOF while looking
  for matching`), and turns `\u0080` in Python source into the character. Write scripts and JS with the Write tool; a
  patch script imports a small `patch(path, [(old, new)])` helper and asserts each `old` occurs once.
- A patch script's `open(p, "w").write(s)` truncates first: when the heredoc turned `\ud800` into a lone surrogate, the
  write failed and left an empty file (an untracked test, 2026-09-29; recovered from a review agent's full Read in its
  transcript). Encode first (`b = s.encode("utf-8")`, then write the bytes), or use the Edit tool.
- The Write tool itself turns `\u0080` in a JS regex into the literal character. Check a written file for non-ASCII
  (`grep -nP "[^\x00-\x7F]"`) when it holds escapes.
- A backtick in a comment inside a GLSL template literal ends the JS string; `node --check` on an ES module file here
  reports nothing, the app reports `Unexpected identifier` at import.
- A Bash-tool heredoc with an unquoted delimiter (`<<EOF`) runs every backtick span in its text as a command; quote it
  (`<<'EOF'`) or use the Write tool. Heredocs also turn `\\n` in Python source into real newlines, and long Python heredocs
  fail to parse: write scripts with the Write tool.
- PowerShell `Set-Content` writes a BOM (electron-builder then refuses `package.json`); edit such files from Python.
- The tools' Python has tifffile without `imagecodecs`: it writes no LZW, PackBits or zstd and cannot pack 1 / 2 / 4
  bits; Pillow writes LZW (`tiff_lzw`) and PackBits, `tools/tiff_fixtures.py` builds the rest by hand.
- Reusing one commit message file gives the next commit the old message.
- A comment edit in `crates/px/src/*.rs` changes the wasm bytes (panic locations carry line numbers): rebuild with
  `python tools/build_px.py` after any `.rs` edit, then `--check`.
- `editor_test.py`'s steps are Python strings that are not raw: `\\n` in their JS, or `String.fromCharCode(10)`; a
  plain `\n` becomes a newline inside a JS string literal.
- The node's publish action runs on a push only when `pyproject.toml` changes; otherwise
  `gh workflow run publish_action.yml --repo DenRakEiw/ComfyUI-InpaintCanvas --ref master`.
- `tools/run_gates.sh` and the mutation helpers restore only the files they saved; check `git diff --stat` after a mutation
  round.
- A background `grep` loop meant to stop a workflow after a phase does not fire in time; read its journal by hand or give it
  a phase switch in `args`.

**Testing and benchmarking**
- References taken with `--update` go stale with every later fix to the same path: run the gate on both backends again
  before the commit. A backend that is off by the same bytes as the other points at the references, not at itself (the
  linear light column, 2026-09-28).
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
- The renderer keeps its own copy of the settings (`settings` in `shell.js`). A test that calls
  `window.scumble.settings.set()` directly changes the stored file, not the window's view, and a later gate in the
  same instance that reads both (`list_recipes` against `settings.get()`) fails on the difference: the `toapis` gate
  left `gpt_image_2` on toapis and made `openrouter` red on 2026-09-20 when it ran before it. Its cleanup now puts
  every recipe it switched back through `selectRecipe`, so the order no longer matters; a gate that switches
  anything in the window has to do the same.

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
- The assistant: the panel (`renderer/assistant.js`) -> IPC `assistant:*` ->
  `electron/main/assistant/` (the loop, the policy, the four adapters) -> an in-process MCP client
  over `InMemoryTransport` -> the same `createServer` external agents get -> `bridge.js` with
  `meta` (the user-activity wait, the busy check, the turn and its undo step) -> `commands.call`.
  Chats under `<userData>/assistant/`, `docs/ASSISTANT.md`, the plan in `docs/PLAN_ASSISTANT.md`.
- The ComfyUI window (item 35, `docs/PLAN_COMFY_VIEW.md`): `electron/main/comfyview.js` (a `BaseWindow` made at the
  first open: the bar `scumble://app/comfybar.html` with `electron/comfybar_preload.js`, whose `comfyview:*` calls
  main answers for the bar alone, over the page, a `WebContentsView` in `persist:comfyui` with no preload). The
  auth of *Settings › ComfyUI* goes on as headers for the target's origin only; `--no-comfy` shows the start page
  unless a test passes a stub's URL. `tools/cdp.py` skips the bar's target.
- Documents (`.scumble`): `host.saveDocument` / `openDocument` (`renderer/editor/host.js`: `flushEditor` uploads the
  edited layers first, `documentDirty` / `settleKey` keep the "*", `rememberClosed` / `reopenClosed` the closed tabs)
  -> IPC `documents:*` -> `electron/main/documents.js` (a job per request, a lock per path, `idle()` for the quit) ->
  `electron/main/docfile.js` (the stored zip, temp file and rename, the mirror import). `docs/DOCUMENTS.md`.
- Provider runs: `host.runProvider` (the recipe resolved to the chosen provider's variant by
  `shell.js`) → `renderer/editor/stitch.js` (crop) → IPC `provider:edit` →
  `electron/main/providers/index.js` picks the adapter and the key (`keys.js`), lays the pictures out with the
  adapter's `layout(req)` and resolves the prompt's markers `{@ref:i}` against it (`providers/refs.js`, item 26) →
  `stitch.js` (composite mask, colour match) → mirror upload → `addResults`. Recipe
  formats in `docs/RECIPES.md`. The prompt's `@img1` tokens follow the reference layers by id
  (`renderer/editor/reftokens.js`, `refsMutated` at every change of the shown references; `docs/PLAN_REFS.md` C2).

## Working rules

- **Test by risk, not by habit (the user, 2026-09-26: "weniger tests").** The user found the testing too heavy and
  decided three tiers; this overrides the "both backends, mutation round, measurement for everything" habit of the
  sessions before. **Full** (both backends, a mutation round, a 15k measurement where it applies): only what can lose
  or corrupt pixels or data - document save / restore and the `.scumble` format, autosave and quit safety, Rust
  kernels, the compositor (blend modes, clipping, groups), export writers. **Normal** (one gate step per new feature on
  the tiles backend plus the existing gates the change directly touches; the canvas backend only when a pixel path
  changed; no mutation round): tools and features - brushes, heal, remove, liquify, layer UI. **Light** (plain-Node
  tests of request shapes, `lint`, `types`, one look in the app; the user judges looks by eye): skins, providers built
  against docs, docs and the manual. Exe gates once per release, not per package. No screenshot gates for looks.
- Development folder is `F:\canvas`. Scratch files go to the session scratchpad, not here.
- Commit as DenRakEiw: `git -c user.name=DenRakEiw -c user.email=89697885+DenRakEiw@users.noreply.github.com`,
  no Claude trailer in commit messages. Push with `-c credential.helper='!gh auth git-credential'`.
- The user's ComfyUI (port 8188) is a production machine: check `/queue` before
  queueing anything, never restart it unasked, delete own test prompts from the queue.
- Python patch scripts must write with `newline=chr(10)`; a mistyped `newline="\\n"`
  once truncated a 7,000-line file.
- Test with real runs: a dev instance `./node_modules/.bin/electron . --remote-debugging-port=9555
  --user-data-dir=<scratch> --no-comfy` (the Bash tool's `run_in_background`; 9333 is the node's headless tab), then
  `python tools/cdp.py eval|shot|log`, and `SCUMBLE_CDP_PORT=9555 python tools/close_app.py` to close it. Scripted waits
  use `setTimeout`, never `requestAnimationFrame` (it stops in a hidden window). One instance at a time: stop the dev
  instance before starting `dist/win-unpacked/Scumble.exe`. What each test tool covers: `docs/TESTING.md`.
- Answer in German; code, comments and docs in English.
- **No other product's name as the model for a feature** (the user, 2026-09-29: copyright and trademarks) in this file,
  in the blog posts, the CHANGELOG, the manual or the README: describe what the feature does, not whose it resembles.
  The providers and models Scumble runs through keep their names where a text is about running them. Plans and
  research notes under `docs/` may name them (the user: "bei Plan ist es nicht so schlimm, nur nicht auf der Webseite").
