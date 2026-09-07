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

## Where things stand (2026-09-07, late)

Phase 0 is built and verified with a real Flux.2 Klein 9B run: `npm start` opens the
editor, connects to ComfyUI, the recipe `recipes/flux2_klein_local.json` is filled from
`serializeForPrompt()` and queued, the stitched result comes back over the websocket as
a layer, Ctrl+S saves a PNG through a native dialog, `npm run dist` makes
`dist/Scumble Setup 0.0.1.exe` (unsigned, default icon). Next: phase 1 from
`docs/BRIEF.md` §5 (all tools verified in the app, WebGL2 filters, tabs, settings UI
for the node params, local document store instead of server-side layer uploads).

## Phase 1 light: in progress (2026-09-07, late evening)

Agreed with the user: a slimmed phase 1 before phase 2 (WebGL2 filters and tabs
postponed). Steps, in order; tick them off here as they land:

1. [ ] **Local file mirror** so the document no longer depends on the server.
   `electron/main/files.js` is written but not wired yet: every `/comfy/upload/image`
   is stored under `<userData>/files/<type>/<subfolder>/<name>` and forwarded to the
   server when connected; `/comfy/view` serves the mirror first, else fetches from the
   server and keeps a copy (not `temp`). `ensureOnServer(refs)` HEAD-checks and
   re-uploads before a run. To do: route those two paths in `main.js` `installProtocol`
   (instead of the plain proxy), IPC `comfy:ensure`, call it from `host.queueGenerate`
   with every `{filename, subfolder, type}` found in the state JSON, reset
   `editor.uploaded = editor.makeUploaded()` in `host.onConnected`, restore the
   autosaved state immediately (mirror) and only fall back to "after connect" when
   `editor.base` stays null. No editor patch needed for this.
2. [ ] **Node params UI** (padding, target_size, feather, multiple_of): one-line patch
   in `tools/sync_editor.py` after `sec.appendChild(this.refineBtn);` in the Generate
   section: `host.buildGenerateExtras(this, sec);`. The controls live in host.js,
   commit to `settings.nodeParams` via `window.scumble.settings.set`, then
   `editor.renderInfo(); editor.draw()`.
3. [ ] **Layer / mask export** (`exportLayerPng`, `exportMaskPng`, lines ~5418-5445 of
   the synced file) still upload to the server's output folder: patch to
   `host.saveExport(blob, name)` like `exportImage`.
4. [ ] **Helpers verified in the app**: extend `tools/smoke_test.py` with select by text
   (SAM3, `segmentByText()` with `segInput.value`, wait for `!segmentPending` and the
   status leaving "Segmenting"), cutout of the result layer (`cutoutLayer(layer)`, wait
   for `!cutoutPending`, then `layer.mask`), `upsamplePrompt()` (`!upsamplePending`),
   `ensureObjects()` (`!objectsPending`, `objects.count`), `addFilterLayer("grain")`
   plus `undoStep()`, PSD export via the `saveExport` override with `saveFormatSel.value = "psd"`.
   Run after a generate so Flux is loaded first; the node frees helpers before local runs.
5. [ ] **Icon and polish**: `build/icon.png` / `build/icon.ico` exist (drawn by a PIL
   script, gold scumble stroke over a blue block); set `"icon": "build/icon.png"` in the
   `build` config and `icon` on the BrowserWindow (guard with existsSync). Remove the
   editor's own "Scumble" title span (patch `top.appendChild(el("span", "ipc-title", "Scumble"));` to nothing).
6. [ ] Update README, SYNC.md, this file; `npm run dist`; commit and push as DenRakEiw.

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
- State: `getValue()` JSON autosaved to `%APPDATA%/Scumble/autosave.json` and restored
  on the next start once connected; layer pixels are still uploaded to the server's
  `input/inpaint_canvas` like in the node (phase 1 replaces this with a local store).

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
  and `python tools/smoke_test.py` (load, select, generate through the recipe, save).
  `window.editor` and `import("./editor/host.js")` are reachable from the console.
  Only one instance runs at a time (single-instance lock); stop the dev instance before
  starting `dist/win-unpacked/Scumble.exe`. `Stop-Process -Name electron` in PowerShell.
- Answer in German; code, comments and docs in English.
