# Scumble

> **Work in progress.** Scumble is in an early state (0.1.x). Not every feature has been
> tested end to end yet, and the API provider adapters (Google Gemini, OpenAI, Black Forest
> Labs, fal.ai, Replicate, WaveSpeedAI, Comfy Cloud) have been written from the providers'
> documentation but have not run against the live APIs so far. Expect rough edges, keep backups of your
> images, and please report what breaks in the
> [issues](https://github.com/DenRakEiw/scumble/issues).

A desktop editor for AI inpainting. Open an image, select an area (brush, shape, magic
wand, object hover or a text description), write a prompt, generate. The result lands as a
layer over the selection and can be blended in with colour match, erased in parts,
regenerated, stacked with filter and text layers, and exported with all layers to PSD or
OpenRaster.

Rendering happens on your own [ComfyUI](https://github.com/comfyanonymous/ComfyUI)
(local or remote, for example on RunPod) or through API providers: Google (Nano Banana
2 / 2 Lite / Pro), OpenAI (GPT Image 2.5 Flare / Sunburst, 2), Black Forest Labs
(FLUX.2 max / pro / flex / klein, FLUX.1 Fill), ByteDance Seedream 5, Qwen Image Edit,
each through the model's own API or through fal.ai, Replicate, WaveSpeedAI and Comfy Cloud. Object masks and background removal
run inside the app through ONNX Runtime (SAM2, BiRefNet, RMBG). The editor is the same
code as the ComfyUI node [Inpaint Canvas](https://github.com/DenRakEiw/ComfyUI-InpaintCanvas);
Scumble is the standalone window around it, plus recipes, plugins and an MCP server.

Windows first (installer below), Linux builds are planned. Free software, GPL-3.0.
What has been verified so far: local rendering through ComfyUI, the in-app helper models,
the film pack, the command core, the MCP server and auto-update; the API providers are
untested (see the note above).

## Features

- Krita-style layers: paint, image, filter and text layers, masks, blend modes, opacity,
  colour match per layer, retouch tools (clone, heal, smudge), transform, crop and extend.
- Selection by brush, rectangle, ellipse, lasso, magic wand, object hover (SAM2 in-app)
  or by text (SAM3 on the ComfyUI side); grow, feather, invert, from layer.
- Filter layers on the GPU (WebGL2): grain with film presets, curves, levels, colour
  balance, HSL, LUT (.cube), vignette, sharpen, blur and more; a film pack plugin with
  film looks, halation, glow, bleach bypass, cross processing, split toning, light leaks,
  frames and control points.
- Recipes instead of node graphs: pick a model ("FLUX.2 [max]", "Nano Banana 2") and the
  provider it runs on (its own API, fal.ai, Replicate, WaveSpeedAI, Comfy Cloud); import your own ComfyUI
  workflow as a recipe if it holds an Inpaint Canvas node.
- Start from nothing: *Generate new* makes the base image from the prompt alone, locally
  or through a provider, and you edit it from there.
- Export PNG, JPEG, WebP, PSD and ORA with layers, masks and selections.
- JavaScript plugins (filters with CPU and WebGL2 paths, panels, menu actions, tools,
  commands) and a command core with 60+ documented commands.
- MCP server: Claude Code, Claude Desktop or any MCP client can drive the editor (Help >
  Copy MCP registration puts the line for your client on the clipboard); `--headless` and
  `--cmd` for scripts.
- Tabs with session restore, a local file mirror (no server needed to reopen your work),
  API keys in the OS credential store, auto-update from GitHub releases.

## Install (Windows)

Download `Scumble Setup <version>.exe` from the
[latest release](https://github.com/DenRakEiw/scumble/releases/latest) and run it. The
installer is not code-signed yet, so SmartScreen shows "Windows protected your PC" once:
click *More info*, then *Run anyway*. Updates are downloaded by the app itself (Settings >
Updates), which also shows what changed, and do not go through SmartScreen again.
[CHANGELOG.md](CHANGELOG.md) lists every version. How releases are built, who approves
them and what the app sends over the network is in the
[code signing policy](docs/CODE_SIGNING_POLICY.md).

For local rendering you need a ComfyUI with the node pack
[ComfyUI-InpaintCanvas](https://github.com/DenRakEiw/ComfyUI-InpaintCanvas) installed and
the models of the recipe you pick (the shipped Flux.2 Klein recipe wants the Flux.2 Klein
9B model, the Qwen3 8B text encoder and the Flux.2 VAE; the recipe's Settings panel lets
you choose the file names you have). For an API provider put the key into Settings > API
providers; no ComfyUI is needed then.

## First steps

Type the ComfyUI URL in the top bar (default `http://127.0.0.1:8188`), Connect, open an
image (Ctrl+O, drop, paste), paint a selection, type a prompt, Generate (Ctrl+Enter).
Ctrl+S saves the visible image. Every document is a tab (Ctrl+T new, Ctrl+W close,
Ctrl+Tab next); a run keeps going while another tab is in front. Ctrl+, opens the settings
(server and auth, API keys, recipes, helper models, plugins, local files, updates).

Every image the editor uploads or receives is kept under `%APPDATA%/Scumble/files/`
(`input/` and `output/`, mirroring ComfyUI's folders). The server only holds copies:
before a run the app uploads what the server lacks, so a fresh or restarted ComfyUI
(RunPod) works without re-loading the document, and the last session is restored at
start even while no server is connected.

## Run from source

```
npm install
npm start
```

Build the installer with `npm run dist` (`dist/Scumble Setup <version>.exe`, NSIS,
unsigned). Releases are built by GitHub Actions: pushing a tag `v<version>` that matches
`package.json` publishes a draft release with the installer, its blockmap and `latest.yml`
(the auto-update feed); publishing the draft makes it visible to the app.

Tests (`tools/`): `smoke_test.py` (needs a ComfyUI), `commands_test.py` (command core and
the sample plugin), `film_test.py` (GPU and CPU paths of the film pack), `mcp_test.py`
(the MCP server over stdio), `llm_test.py` (the OpenAI-compatible upsample endpoint against
a mock server), `editor_test.py` (editor behaviour that is easy to break again), `generate_test.py`
(making an image from the prompt alone, against the loopback provider),
`helpers_test.js` (ONNX modules without Electron). See `CLAUDE.md` for the development
notes.

## Layout

```
electron/main/     main process: window, scumble:// scheme with the ComfyUI proxy, websocket, menu, dialogs, settings,
                   file mirror, keys.js (safeStorage), recipes.js, providers/ (fal, replicate, bfl, openai, gemini, wavespeed, comfycloud),
                   onnx/ (SAM2, matting), plugins.js, updater.js (GitHub releases), bridge.js + local.js + mcp/ (agents)
electron/preload.js
renderer/          shell.js (connection bar, recipe picker, tabs, settings), commands.js (the command core),
                   plugins.js (plugin loader and the `scumble` API)
renderer/editor/   synced copy of the node's editor, see docs/SYNC.md; host.js is the app side of it,
                   inpaint_filters_gl.js the WebGL2 filter path, stitch.js the in-app crop / stitch for provider runs
recipes/           ComfyUI recipes (API-format prompts with a fixed canvas node id) and model recipes (one per model, a variant per provider), docs/RECIPES.md
plugins/           built-in plugins: sample (one of every extension point) and film (the film pack), docs/PLUGINS.md, docs/FILM.md
docker/runpod/     Dockerfile + provision.sh for a ComfyUI box on RunPod (draft, docs/RUNPOD.md)
tools/             sync_editor.py, cdp.py (DevTools driver), the tests, commands_doc.py
docs/              BRIEF.md (vision, decisions, phases), COMMANDS.md, PLUGINS.md, FILM.md, MCP.md, RECIPES.md, HELPERS.md, SYNC.md, CODE_SIGNING_POLICY.md
.github/workflows/ build.yml (Windows installer, draft release on a version tag)
```

## Licence

GPL-3.0, the same licence as the Inpaint Canvas node and ComfyUI. See `LICENSE`. Free to
use, modify and redistribute; modified versions must be published under the same licence.
Bundled fonts are OFL / Apache licensed, see `renderer/editor/fonts/licenses`. Film names
in the grain presets and the film pack are trademarks of their owners; the looks are
Scumble's own approximations, not licensed products.
