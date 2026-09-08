# Scumble

A desktop editor for AI inpainting. Krita-style layers, selection by brush, shape,
magic wand, object hover or text, retouch tools, filter layers, text layers, colour
match, PSD / ORA export. Rendering happens on your own ComfyUI (local or remote) or
through API providers (fal.ai, Black Forest Labs, OpenAI, Google Gemini). The editor is the same code as the ComfyUI node
[Inpaint Canvas](https://github.com/DenRakEiw/ComfyUI-InpaintCanvas); the app is the
standalone window around it.

Status: **phase 2 complete** (2026-09-08). Everything from phase 1 (Electron window,
editor, ComfyUI connection, open / select / generate / save PNG / PSD / ORA, layer and
mask export, local file store, tabs with session restore, WebGL2 filter layers,
settings dialog, helpers verified, NSIS installer) plus: API provider recipes (fal.ai,
Black Forest Labs, OpenAI gpt-image, Google Gemini) with crop and stitch in the app,
API keys in the OS credential store, a connection dialog for remote ComfyUI with auth
and a Test button (version, node pack, model files per recipe), import of your own
ComfyUI workflow as a recipe (subgraphs flattened), and a RunPod template draft. Next:
phase 3 (SAM2 / RMBG in-app via ONNX). See `docs/BRIEF.md` for the plan,
`docs/RECIPES.md` for the recipe formats and `CLAUDE.md` for the working notes.

## Run from source

```
npm install
node node_modules/electron/install.js     # only if the Electron binary was not downloaded
npm start
```

Requirements on the ComfyUI side: the node pack `ComfyUI-InpaintCanvas` installed, and
for the shipped recipe the Flux.2 Klein 9B model, the Qwen3 8B text encoder and the
Flux.2 VAE (the recipe's Settings panel lets you pick the file names you have).

Type the ComfyUI URL in the top bar (default `http://127.0.0.1:8188`), Connect, open an
image (Ctrl+O, drop, paste), paint a selection, type a prompt, Generate (Ctrl+Enter).
For an API provider pick one of its recipes in the Recipe list and put the key into
Settings › API providers first; no ComfyUI is needed for those. A remote ComfyUI
(RunPod) gets its URL and auth under Settings › ComfyUI, Test shows what the box has.
Ctrl+S saves the visible image. Every document is a tab (Ctrl+T new, Ctrl+W close,
Ctrl+Tab next); a run or helper keeps going while another tab is in front, and its
result lands in the tab that asked. Ctrl+, opens the settings (server and auth, API keys, recipes, local
files, rendering).

Every image the editor uploads or receives is kept under `%APPDATA%/Scumble/files/`
(`input/` and `output/`, mirroring ComfyUI's folders). The server only holds copies:
before a run the app checks which files it lacks and uploads them, so a fresh or
restarted ComfyUI (RunPod) works without re-loading the document, and the last session
is restored at start even while no server is connected.

## Build the installer

```
npm run dist        # dist/Scumble Setup <version>.exe (NSIS, unsigned)
```

## Layout

```
electron/main/     main process: window, scumble:// scheme with the ComfyUI proxy, websocket, menu, dialogs, settings,
                   file mirror, keys.js (safeStorage), recipes.js (list / import), providers/ (fal, bfl, openai, gemini)
electron/preload.js
renderer/          shell (connection bar, recipe picker, progress) and the editor
renderer/editor/   synced copy of the node's editor, see docs/SYNC.md; host.js is the app side of it,
                   inpaint_filters_gl.js the WebGL2 filter path, stitch.js the in-app crop / stitch for provider runs
recipes/           ComfyUI recipes (API-format prompts with a fixed canvas node id) and provider recipes, docs/RECIPES.md
docker/runpod/     Dockerfile + provision.sh for a ComfyUI box on RunPod (draft, docs/RUNPOD.md)
tools/             sync_editor.py, cdp.py (DevTools driver), smoke_test.py
docs/              BRIEF.md (vision, decisions, phases), RECIPES.md, SYNC.md, NAMES.md, RUNPOD.md
```

## Licence

All rights reserved for now (the node stays GPL-3.0; see `docs/BRIEF.md` §3).
Bundled fonts are OFL / Apache licensed, see `renderer/editor/fonts/licenses`.
