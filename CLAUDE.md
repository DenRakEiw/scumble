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

## Where things stand (2026-09-08, early)

**Phase 1 is complete.** Next session: **phase 2** (`docs/BRIEF.md` §5: fal.ai and direct
adapters, key storage via safeStorage, connection dialog for remote ComfyUI / RunPod,
recipe import). Everything below is built and verified with real runs
(`tools/smoke_test.py`: Flux.2 Klein 9B generate, then SAM3 select by text, RMBG
cutout, Qwen-VL upsampling, SAM2 objects, grain filter layer, layer / mask / PSD export,
all PASS; a generate queued from a background tab landed in that tab).

Landed on 2026-09-08 after the light version:

- **Tabs**: one `InpaintEditor` per document, all mounted in `#editor-host`, inactive
  ones hidden with `.shell-hidden`; `host._editors` / `host.editor` (active) /
  `host.activate()`; the keydown handler is patched to `host.isActive(this)`. Events:
  results by `prompt_id` (`host.editorByPrompt`), helper masks / texts by
  `info.canvas_node` = `editor.node.id` (`host.editorById`). Autosave is a bundle
  `{version: 2, active, nextId, docs: [{id, state}]}` in `autosave.json`; `host.restore`
  also reads the old single-state format. Menu: Ctrl+T / Ctrl+W / Ctrl+Tab.
  Open image goes into the active tab while it is empty, otherwise into a new one.
- **WebGL2 filters** in `renderer/editor/inpaint_filters_gl.js` (see `docs/SYNC.md`),
  hooked into `applyFilter` by a sync patch; CPU fallback stays.
- **Settings dialog** (`<dialog id="shell-settings">` in the shell, Ctrl+,): server URL
  and connect, local file store (stats, open folder, remove files no open document
  references and older than an hour: IPC `files:prune`), rendering path, about.

Landed on 2026-09-07 (phase 1 light):

- **Local file mirror** (`electron/main/files.js`, wired in `main.js` `installProtocol`):
  `/comfy/upload/image` stores under `<userData>/files/<type>/<subfolder>/<name>` and
  forwards when connected; `/comfy/view` serves the mirror first, else fetches and keeps
  a copy (not `temp`). IPC `comfy:ensure` → `ensureOnServer(refs)` (HEAD-check, upload
  what is missing; a per-server "known" set skips repeats); `host.queueGenerate` calls
  it with base / mask / control / references from the state JSON. `host.onConnected`
  resets `editor.uploaded`. `host.restore(state)` restores the autosave at start from
  the mirror, offline too; only a state whose base is not mirrored waits for connect.
- **Node params UI** (`host.buildGenerateExtras`, patched in after the Refine button):
  padding, target_size, feather, multiple_of → `settings.nodeParams`, info panel follows.
- **Layer / mask export** go through `host.saveExport` (native dialog / fixed path).
- **Icon** on the window and in the installer; the editor's own title span is gone.

Known small things: `loadFile` uploads with `overwrite=false`, so re-loading an image
with a name already in the mirror yields `name (1).png` (ComfyUI's own rule, harmless).
The mirror never deletes; the node's `cleanupFiles()` only cleans the server.

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
- `renderer/shell.js`: tab bar, settings dialog, menu commands, restore at start;
  exports `newDocument`, `activate`, `closeDocument`, `openSettings` for tests
  (`import("./shell.js")` from the console). `window.editor` is always the active tab.

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
