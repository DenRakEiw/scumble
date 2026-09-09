# CLAUDE.md — Scumble (desktop app)

Read this first, then `docs/BRIEF.md` (vision, decisions, architecture, phases).
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
A standalone desktop editor for AI inpainting: Krita-style layers, selection by text,
retouch, filter layers, colour match per layer, text, PSD/ORA export. Local rendering
through the user's own ComfyUI, API rendering through fal.ai and direct providers,
SAM/RMBG in-app via ONNX. MCP-capable from the start. Windows first, Linux second.

The editor code comes from the ComfyUI custom node **Inpaint Canvas**
(`F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI\custom_nodes\ComfyUI-InpaintCanvas`,
GitHub `DenRakEiw/ComfyUI-InpaintCanvas`, GPL-3.0, ~9,500 lines of vanilla JS in `js/`).
That repo stays the backend node and keeps living; this folder is the app. Read its
`CLAUDE.md`, `DEVELOPMENT.md` (§1–19) and `GUIDE.md` before touching editor code.

## Decisions already made (do not reopen without the user)

- Shell: **Electron** (identical Chromium on Windows and Linux; `ctx.filter` and canvas
  performance; Node process for `sharp` exports and the in-app MCP server).
- Local rendering: **the user's ComfyUI**, local or remote (RunPod). The app never
  bundles Python/Torch. The node pack must be installed there; the app checks
  `/object_info` and offers to install it via the Manager.
- API rendering: **fal.ai** as the aggregator, plus direct adapters (Black Forest Labs
  Flux.2, OpenAI gpt-image, Google Gemini image) and the ComfyUI API nodes as fallback.
  Keys in the OS credential store via Electron `safeStorage`, never in config files.
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
- Plugins: **JavaScript plugins on the command core** (Krita-style folders with
  `plugin.json`, filter / panel / action / tool extension points), the film pack is the
  first built-in plugin; Python plugins later, not now. Plan in `docs/BRIEF.md` §5.
- Licence: **GPL-3.0** (decided 2026-09-09; `LICENSE`, `package.json`, About, README).
  The same licence as the node, no CLA, no dual licensing (that is also what the free
  SignPath Foundation signing requires). Only MIT/Apache/BSD/OFL dependencies in the app.
- Release channel: **GitHub Releases** of `DenRakEiw/scumble` (public since 2026-09-09).
  `electron-updater` reads `latest.yml` there; `.github/workflows/build.yml` builds the
  installer on `windows-latest` and publishes a **draft** release on a `v<version>` tag
  (the tag must match `package.json`); publishing the draft makes it visible to the app.
  First releases are **unsigned**; code signing goes through the SignPath Foundation
  (free for OSS) once the project has a public release and some use, fallback Certum
  Open Source. Azure Trusted Signing is paid and not for individuals in the EU.

## Where things stand (2026-09-09, late)

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
  (`providers: { gemini | openai | bfl | fal | replicate | openrouter | letz: { model,
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
  `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`, `gemini-2.5-flash-image`; OpenAI
  `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` (released 2026-09-08), `gpt-image-2`,
  `gpt-image-1.5`; fal `fal-ai/nano-banana-2/edit`, `fal-ai/flux-2-max/edit`,
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
  Electron prints a CR LF to stdout before any JS runs (clients skip it with one warning, it
  cannot be suppressed); a window created hidden stays hidden after `show()`, `restore()`
  brings it up.
- **Tests**: `python tools/mcp_test.py [--exe dist/win-unpacked/Scumble.exe]` (Python `mcp`
  client; PASS 2026-09-09 in proxy mode with the app open, 1.5 s, and headless with the dev
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
- `renderer/editor/`: the node's editor, copied and patched by `tools/sync_editor.py`
  (`docs/SYNC.md` lists every patch). `renderer/editor/host.js` is the app side:
  `api` (fetchApi, apiURL, queuePrompt, events) and `host` (recipe, settings targets,
  generate, autosave, export). Do not edit the synced files by hand.
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
  `python tools/mcp_test.py` talks to `--mcp` over stdio (proxy mode while the dev instance
  runs, headless when nothing runs; `--exe dist/win-unpacked/Scumble.exe` for the package).
  `node tools/helpers_test.js` runs the ONNX modules without Electron. Start the dev
  instance with the Bash tool's `run_in_background`; a plain `&` job dies with the shell.
  `window.editor` and `import("./editor/host.js")` are reachable from the console.
  Only one instance runs at a time (single-instance lock); stop the dev instance before
  starting `dist/win-unpacked/Scumble.exe`. `Stop-Process -Name electron` in PowerShell.
- Answer in German; code, comments and docs in English.
