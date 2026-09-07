# Scumble

A desktop editor for AI inpainting. Krita-style layers, selection by brush, shape,
magic wand, object hover or text, retouch tools, filter layers, text layers, colour
match, PSD / ORA export. Rendering happens on your own ComfyUI (local or remote) or,
later, through API providers. The editor is the same code as the ComfyUI node
[Inpaint Canvas](https://github.com/DenRakEiw/ComfyUI-InpaintCanvas); the app is the
standalone window around it.

Status: **phase 1 light** (2026-09-07). Electron window, editor, ComfyUI connection,
one recipe (Flux.2 Klein 9B local), open image, select, generate, save PNG / PSD / ORA,
layer and mask export to files, the node's crop parameters in the Generate panel, a
local file store (the document no longer depends on the server), all helpers verified
in the app (SAM3 select by text, RMBG cutout, Qwen-VL prompt upsampling, SAM2 objects),
NSIS installer with icon. See `docs/BRIEF.md` for the plan and `CLAUDE.md` for the
working notes.

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
Ctrl+S saves the visible image.

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
electron/main/     main process: window, scumble:// scheme with the ComfyUI proxy, websocket, menu, dialogs, settings, file mirror
electron/preload.js
renderer/          shell (connection bar, recipe picker, progress) and the editor
renderer/editor/   synced copy of the node's editor, see docs/SYNC.md; host.js is the app side of it
recipes/           workflow templates in ComfyUI API format with a fixed canvas node id
tools/             sync_editor.py, cdp.py (DevTools driver), smoke_test.py
docs/              BRIEF.md (vision, decisions, phases), SYNC.md, NAMES.md, RUNPOD.md
```

## Licence

All rights reserved for now (the node stays GPL-3.0; see `docs/BRIEF.md` §3).
Bundled fonts are OFL / Apache licensed, see `renderer/editor/fonts/licenses`.
