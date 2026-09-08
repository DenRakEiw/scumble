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
- Licence: **left open on purpose.** The node stays GPL-3.0. The app repo starts as
  "All rights reserved" until decided; a CLA goes in before any outside contribution
  is merged (contributions that only land in the node and are never copied into the
  app do not affect the app). Only MIT/Apache/BSD/OFL dependencies in the app.

## Where things stand (2026-09-08, late night)

**Phase 4 is complete** (command core + plugin system). Next session: **phase 4b**, the
film pack as the first real plugin on this API (`docs/BRIEF.md` §5; parametric film
looks, halation, light leaks, split toning, B&W with colour filters, frames; control
points last), then **4c**, the MCP server and headless mode on the command core
(`commands.describe()` already yields the tool list; `app.exe --mcp` with the TypeScript
SDK in the main process, one IPC round trip per tool). Still open from earlier phases:
the first real RunPod pod (`docker/runpod/`), and the five API provider adapters have
never run against a live API (no keys yet; run one small selection per provider first).

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
- Provider runs: `host.runProvider` → `renderer/editor/stitch.js` (crop) → IPC
  `provider:edit` → `electron/main/providers/index.js` picks the adapter and the key
  (`keys.js`) → `stitch.js` (composite mask, colour match) → mirror upload → `addResults`.
  Recipe formats in `docs/RECIPES.md`.

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
  `node tools/helpers_test.js` runs the ONNX modules without Electron. Start the dev
  instance with the Bash tool's `run_in_background`; a plain `&` job dies with the shell.
  `window.editor` and `import("./editor/host.js")` are reachable from the console.
  Only one instance runs at a time (single-instance lock); stop the dev instance before
  starting `dist/win-unpacked/Scumble.exe`. `Stop-Process -Name electron` in PowerShell.
- Answer in German; code, comments and docs in English.
