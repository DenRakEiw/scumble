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
- Licence: **left open on purpose.** The node stays GPL-3.0. The app repo starts as
  "All rights reserved" until decided; a CLA goes in before any outside contribution
  is merged (contributions that only land in the node and are never copied into the
  app do not affect the app). Only MIT/Apache/BSD/OFL dependencies in the app.

## Where things stand (2026-09-08, evening)

**Phase 2 is complete** except for the first real RunPod test. Next session: **phase 3**
(`docs/BRIEF.md` §5: SAM2 and RMBG in-app via ONNX Runtime, model download or linked
ComfyUI `models/` folder, object hover from SAM2 automask). Before that, if the user
has a RunPod account ready: build and push `docker/runpod/`, start a pod, Test +
Connect from the app, one Flux.2 Klein run (see `docker/runpod/README.md`).

Verified with real runs on 2026-09-08 (`tools/smoke_test.py`, all PASS): the shipped
Flux.2 Klein recipe and the *imported* node example workflow (subgraph flattened)
through the user's ComfyUI, the loopback provider round trip (crop → main process →
stitch → result layer equals the base inside the selection), the key store (DPAPI),
the probe / Test button, and the recipe import of UI and API format. **The four real
provider adapters ran against their documented schemas only, not against the live
APIs: no keys were available in this session.** First thing to do with a key: pick the
provider's recipe, run once on a small selection, and fix what the API answers.

Landed on 2026-09-08 (phase 2):

- **Provider recipes** (`kind: "provider"`, `docs/RECIPES.md`): fal.ai (Flux Fill pro,
  Qwen Image Edit inpaint, Flux.2 pro edit), BFL (Flux Fill pro, Flux.2 / Kontext edit
  with an endpoint combo), OpenAI gpt-image edit, Gemini image edit. Adapters in
  `electron/main/providers/<id>.js` with one interface (`edit(request, ctx)`); the
  crop and the stitch happen in the renderer (`renderer/editor/stitch.js`, a port of the
  node's `run` / `stitch`; not ported: ECC align, Lanczos, Navier-Stokes border fill).
  `host.runProvider` builds the request, `host.uploadResult` stores the RGBA patch in
  the mirror as `output/inpaint_canvas/n<id>_result_<stamp>.png`, `addResults` adds the
  layer like a node result. The Settings panel shows the recipe's `settings[]` with
  their own `spec`. Busy state: `editor.providerPending`, indeterminate progress bar
  via `host.onProviderRuns`. Hidden `loopback` provider for tests.
- **Keys** in `electron/main/keys.js` (safeStorage, `<userData>/secrets.json`, the
  renderer sees only set / last four chars). Settings › API providers: one row per
  provider (Save / Clear / get-a-key link). The recipe note in the top bar says when
  the selected recipe's key is missing.
- **Remote ComfyUI**: `settings.comfy.auth` = `{type: none|basic|bearer|header, user,
  header}`, secret under key `comfy-auth`; `authHeaders()` in `comfy.js` is applied to
  every proxied request and the websocket. `ComfyClient.probe()` behind the Test button
  (version, devices with VRAM, queue, node pack version via `/inpaint_canvas/info`,
  loader combo lists → per-recipe "model files present / missing" line in the dialog).
  `comfy:connect` takes a string (URL) or `{url, auth, secret}`.
- **Recipe import** (`electron/main/recipes.js`): Settings › Recipes › Import, or
  File › Import Workflow as Recipe. UI format (needs `/object_info`; subgraphs
  flattened with `instance:inner` ids, promoted widgets, reroutes, primitives, bypass,
  mute), API format (`result_source[_local]`, setting links), Scumble recipe files.
  User recipes live in `<userData>/recipes/`, listed before the shipped ones, Remove
  in the dialog. Combo specs are stored as the single chosen value; the live list
  comes from `/object_info`.
- **RunPod template draft** in `docker/runpod/` (ai-dock base, `provision.sh` with
  `SCUMBLE_RECIPES` / `SCUMBLE_HELPERS` / `HF_TOKEN`), untested on a pod.
- `backgroundThrottling: false` on the window: with the window hidden, `canvas.toBlob`
  and timers were throttled to one per second (a provider run took 5 s instead of 1).
- Menu: File › Import Workflow as Recipe. `shell.js` exports `selectRecipe`,
  `loadRecipes`, `importRecipe`, `testConnection`, `connect` for tests.

Known small things: `loadFile` uploads with `overwrite=false`, so re-loading an image
with a name already in the mirror yields `name (1).png` (ComfyUI's own rule, harmless).
The mirror never deletes; the node's `cleanupFiles()` only cleans the server. The
editor's per-document `settings` keep their value when a recipe with the same target
id is re-selected (by design); the Settings panel falls back to the first combo entry
when the stored file name is not on the server.

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
  recipes, local files), menu commands, restore at start; exports `newDocument`,
  `activate`, `closeDocument`, `openSettings`, `selectRecipe`, `loadRecipes`,
  `importRecipe`, `testConnection`, `connect` for tests (`import("./shell.js")` from
  the console). `window.editor` is always the active tab.
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
  then the helpers and exports; `--no-helpers` for the short version).
  `window.editor` and `import("./editor/host.js")` are reachable from the console.
  Only one instance runs at a time (single-instance lock); stop the dev instance before
  starting `dist/win-unpacked/Scumble.exe`. `Stop-Process -Name electron` in PowerShell.
- Answer in German; code, comments and docs in English.
