# Project brief: Scumble, the standalone Inpaint Canvas desktop app

Written 2026-09-07 at the end of the ComfyUI node session, as the hand-over into this
folder. Everything the next session needs to start building is here or linked.

## 1. Vision

A desktop image editor for AI inpainting that feels like a painting program, not like a
node graph. Open an image, select an area (by rectangle, brush, lasso, magic wand or by
describing the object), write a prompt, generate. The result lands as a layer over the selection
and can be blended in with colour match, erased in parts, regenerated, layered with
filters and text, and exported with all layers to PSD or OpenRaster.

Rendering happens elsewhere: locally through the user's own ComfyUI (on the same
machine or on a RunPod box), or through API providers. The app is the editor, the
workflow and the agent interface, never the model host.

Target users: people who already run ComfyUI and want inpainting without graph
plumbing, and people who work with API models and want a real editor around them.

## 2. Where the code comes from

The ComfyUI custom node **Inpaint Canvas** (`DenRakEiw/ComfyUI-InpaintCanvas`, local
checkout at `F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI\custom_nodes\ComfyUI-InpaintCanvas`)
already contains the whole editor, ~9,500 lines of vanilla JS:

| File | What |
|---|---|
| `js/inpaint_canvas.js` (~7,500) | editor: tools, layers, selection, transform, view, generate round trip, persistence |
| `js/inpaint_filters.js` | filter layers: grain (film presets, plates), sharpen, blur, levels, curves, brightness/contrast, HSL, colour balance, B/W, invert, LUT, vignette (CPU, per pixel) |
| `js/inpaint_curves.js` | curves widget |
| `js/inpaint_text.js` | text layers, bundled OFL/Apache fonts in `js/fonts/` |
| `js/inpaint_raster.js` | raster helpers (flood fill, masks, smudge/clone/heal dabs) |
| `js/inpaint_export.js` | PSD (PackBits) and ORA writers, PNG text chunks |
| `js/inpaint_bridge.js` | command table for the MCP server, 46 commands |
| `nodes.py` | backend: crop with context, stitch with colour match and alignment, helper nodes for SAM/RMBG/VLM results, routes |
| `mcp/inpaint_canvas_mcp.py` | stdio MCP server (Python), headless mode via Chromium |

The editor touches ComfyUI in about a dozen places, all in `inpaint_canvas.js`:
`api.fetchApi` (uploads, `/view`, `/free`, `/queue`), `api.queuePrompt` (helper prompts
for SAM3/RMBG/Qwen-VL), `app.queuePrompt` (the user's graph), `api.addEventListener`
(`executed`, `execution_error`, `status`), `app.graph` / `this.node` (node id, result
input wiring `resultInputState`, setting outputs, thumbnail widget), and
`serializeForPrompt` (uploads base/mask/control before a run and hands the node its
state). Decoupling means putting a `Backend` interface in front of these.

## 3. Decisions (see CLAUDE.md for the short list)

**Shell: Electron.** Same Chromium on Windows and Linux; Tauri's WebKitGTK on Linux
lacks `ctx.filter` (used for feather/blur) and has weaker canvas performance. Electron's
Node process runs `sharp` for fast 16-megapixel PNG/JPEG encoding and hosts the MCP
server. Installer size is irrelevant next to models.

**Rendering backends** behind one interface (`generate(request) -> result image +
placement`, `segment(text|points)`, `cutout(layer)`, `upsamplePrompt`):

1. *ComfyUI adapter*: HTTP + websocket client (the MCP server's `_http`/`_upload` and
   the harness's CDP-free approach are the starting point). Connection dialog with URL,
   optional auth header for remote boxes; checks `/object_info` for `InpaintCanvas`,
   offers Manager install; recipes = workflow templates with a fixed node id, filled
   with the editor state (`serializeForPrompt` output) and queued with the app's
   `client_id`; results come back over the websocket exactly as today.
2. *fal.ai adapter*: one key, many image-edit models (Flux.2 edit/fill, Kontext,
   Qwen-Image-Edit, gpt-image via fal, etc.). Mask + image + prompt in, image out.
3. *Direct adapters*: Black Forest Labs (Flux.2 fill + multi-reference), OpenAI
   gpt-image edit, Google Gemini image. ~100 lines each.
4. *ComfyUI API nodes*: the existing path through the user's ComfyUI, kept as is.

API keys in the OS credential store through Electron `safeStorage`.

**Helper models in-app**: SAM2 (points/box; SAM3 by text stays a ComfyUI helper until
an ONNX export exists) and RMBG-2.0 (or BiRefNet) through `onnxruntime-node` with
DirectML on Windows, CUDA/CPU on Linux. Model files: downloaded into the app data
folder on first use, or read from a linked ComfyUI `models/` folder (`models/sam2`,
`models/RMBG`), user's choice in settings.

**Recipes**: shipped as JSON in `recipes/`: "Flux.2 Klein local" (from
`examples/inpaint_canvas_flux2_klein_local.json`), "Flux.2 API" (from
`examples/inpaint_canvas_flux2_api.json`), "SDXL inpaint". Import of a user workflow
that contains an Inpaint Canvas node. A recipe declares which node id is the canvas,
which inputs are prompt/negative/seed/denoise, and which model files it needs.

**MCP**: the app's command core is the bridge table from the node (`COMMANDS`), moved
into the renderer with a typed IPC to the main process. `app.exe --mcp` runs the stdio
server (official `@modelcontextprotocol/sdk`) in the main process; each tool is one
IPC call. Headless = the same app started without a window, so the whole Chromium
launch logic of the node's Python server disappears.

**Filters on WebGL2**: grain, curves, levels, HSL, colour balance, LUT, vignette as
fragment shaders on the composite; CPU implementation kept as fallback and for the
node until it is ported back. Preview at screen resolution while dragging, full
resolution on release.

**Film names (decided 2026-09-08):** the grain presets keep the real film names
(Kodak Portra 400, Fujifilm Velvia 50, Ilford HP5 ...) as a descriptive reference, and
the film pack may do the same; the values behind them are Scumble's own parameters,
never copied manufacturer LUTs or profiles. A disclaimer sits in the preset tooltip and
the About dialog ("Film names are trademarks of their owners; the looks are Scumble's
own approximations, not licensed products"). Names never go into the product name,
logo or marketing. Referential use of this kind is industry practice (DxO FilmPack,
Dehancer, RawTherapee) and, as long as the app is free and open, hardly a target; a
lawyer confirms it before any sale, together with the licence model.

**Licence**: **GPL-3.0**, decided 2026-09-09 (was "all rights reserved, open by design"
until then). The app is a derivative of the GPL-3.0 node, the same licence keeps the two
repos exchangeable, and it is what the free SignPath Foundation code signing requires (an
OSI licence without commercial dual licensing). No CLA: contributions come in under the
GPL like everywhere else. Money, if any, comes from affiliate links (RunPod, API providers),
sponsoring and paid services around the app, never from a closed edition. Only
MIT/Apache/BSD/OFL dependencies. Not legal advice.

## 4. Architecture sketch

```
electron/
  main/           app lifecycle, windows, menus, IPC, credentials, updates
  main/mcp/       stdio MCP server (--mcp), maps tools to IPC commands
  main/backends/  comfyui, fal, bfl, openai, gemini adapters (Node, fetch/ws)
  main/onnx/      SAM2, RMBG via onnxruntime-node
  main/export/    sharp-based PNG/JPEG encode, PSD/ORA writers (ported from js/inpaint_export.js)
renderer/
  editor/         the editor from the node, split into modules, no ComfyUI imports
  editor/gl/      WebGL2 filter pipeline
  ui/             connection dialog, recipe picker, settings, tabs (Vue or plain DOM)
recipes/          workflow templates
shared/           command table (bridge), types
```

Data flow for a local generate: renderer builds the request (crop settings, selection
mask, flattened base, prompt, recipe id) → main `comfyui` adapter uploads files, fills
the recipe template, POSTs `/prompt` with the app's client id → websocket `executed`
carries `inpaint_result` from the stitch node → renderer adds the result layer at the
reported placement. Same as the node today, only the transport lives in main.

## 5. Phases

**Phase 0, spike (2–3 days):** Electron window, editor extracted with a `Backend`
interface, ComfyUI adapter, recipe "Flux.2 Klein local", open image, select, generate,
save PNG, NSIS installer via electron-builder. Goal: feel it.

**Phase 1, editor complete (1–2 weeks):** all tools and layers from the node working
in the app, WebGL2 filters, native file dialogs, drag and drop, tabs for several
images, autosave of the editor state per file, settings.

**Phase 2, backends (1 week):** fal.ai and direct adapters, key storage, connection
dialog for remote ComfyUI (RunPod, see `docs/RUNPOD.md`), recipe import. Done
2026-09-08 (adapters in `electron/main/providers/`, crop and stitch in the app in
`renderer/editor/stitch.js`, formats in `docs/RECIPES.md`); the RunPod template is a
draft that still needs its first real pod.

**Phase 3, helpers in-app (1 week):** SAM2 and RMBG through ONNX Runtime, model
download or linked ComfyUI folder, object hover from SAM2 automask. Done 2026-09-08
(`electron/main/onnx/`, `docs/HELPERS.md`): SAM2 tiny/small/base+/large and BiRefNet
lite/BiRefNet/RMBG-1.4/RMBG-2.0 as ONNX, DirectML on Windows, a point prompt in the
object tool on top; text segmentation (SAM3) stays a ComfyUI helper.

**Phase 4, command core and plugins (3–4 days), planned 2026-09-08, done 2026-09-08**
(`renderer/commands.js` with 59 commands in `docs/COMMANDS.md`, `renderer/plugins.js` and
`electron/main/plugins.js` with the API in `docs/PLUGINS.md`, `plugins/sample` as the
reference plugin, Settings › Plugins and a Plugins menu, `tools/commands_test.py`)**:** the node's
bridge command table (`inpaint_bridge.js`, 46 commands) becomes the app's command core
in the renderer, typed and documented. On it, a plugin system of its own: a plugin is a
folder in `<userData>/plugins/<name>/` with `plugin.json` (name, version, entry, what it
registers) and a JavaScript module loaded with an API object `scumble` (document,
layers, selection, pixel access as ImageData in and out, undo, status line, files, the
command core). Extension points: filter type (parameter schema for the UI, apply
function, optional GLSL fragment for the WebGL2 path), panel / docker (own DOM area),
menu action, tool. Settings › Plugins: list, enable, open folder, errors, reload without
restart. Python plugins (stdio process) later, not now.

**Phase 4b, film pack (1–2 weeks), done 2026-09-09** (`plugins/film`, `docs/FILM.md`,
`tools/film_test.py`; the API grew `sampler2D` uniforms, `gl.shade` for multi-pass filters,
`filters.apply`, tool `draw` / `onKey`, `Document.setFilterParams`, preset-select rules)**:**
a Nik Collection / DxO FilmPack style package,
built as the first built-in plugin so the API is proven on it: parametric film looks
(colour matrix, tone curve, grain by ISO on the existing grain presets), halation and
glow, light leaks, split toning, tonal contrast, structure / detail, bleach bypass, cross
processing, Silver-Efex-like black and white with colour filters, frames; U-Point-style
control points for local adjustments last (the biggest single item). Own parametric
looks only, no third-party LUT or profile data (users load free LUT sets through the
LUT filter layer). Film names may be used referentially with the disclaimer (see §3).

**Phase 4c, MCP and headless (3–4 days):** `--mcp` server on the same command core,
windowless mode, docs. Landed 2026-09-09 (`docs/MCP.md`): `Scumble --mcp` drives the running
instance over a local socket or starts the app headless, `--headless`, `--cmd`.

**Phase 5, release (1 week):** auto-update through GitHub Releases (landed 2026-09-09:
`electron/main/updater.js`, Settings > Updates, Help > Check for updates, the build
workflow `.github/workflows/build.yml` publishes a draft release on a `v*` tag), licence
GPL-3.0 and the repo public (2026-09-09), first releases unsigned (SmartScreen shows the
"unknown publisher" screen once per download). Code signing: apply at the SignPath
Foundation (free for OSS; needs the public repo, CI builds, a code signing policy page and
some visible use), fallback Certum Open Source (about 70 EUR the first year). Azure
Trusted Signing is paid and, for individuals, US/Canada only. Then Linux AppImage/deb,
website, macOS only with an Apple Developer account (99 USD a year, no free path).

## 6. Open questions for the user

- Name: decided, **Scumble** (see `docs/NAMES.md`); domains and trademark check still to do by the user.
- UI framework for the shell around the editor: plain DOM like the node, or Vue.
  Recommendation: plain DOM for the editor, Vue only if the settings/recipe UI grows.
- Code signing for Windows: SignPath Foundation application once the project has a
  public release and a few users (see phase 5); until then unsigned.
- Whether the node repo becomes a git submodule of the app (shared editor code) or the
  editor moves here and the node consumes a built bundle. Recommendation: editor
  source lives here in `shared/editor`, the node repo gets a build step that copies the
  bundle; until then, copy by hand and keep a `SYNC.md` with what diverged.

## 7. Related context in other places

- Session memory of the assistant: `inpaint-canvas-node`, `inpaint-canvas-mcp`,
  `inpaint-canvas-headless-wip` (under `~/.claude/projects/...ComfyUI/memory/`).
- Node docs: `DEVELOPMENT.md` §1–19 in the node repo, §19 is the MCP bridge.
- Example workflows: node repo `examples/`.
- Marketing material made for the node (video, thumbnails, texts): `Downloads/`
  (`inpaint_canvas_explainer.mp4`, `civitai_article/`).
