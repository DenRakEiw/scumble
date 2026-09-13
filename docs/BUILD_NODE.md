# The node's editor is built from this repo

Since C0 (`docs/PLAN_BCE.md` §2, `docs/NEXT_PLAN.md` 4b, 2026-09-13) **`renderer/editor/` is the
source of the editor** for both hosts: Scumble and the ComfyUI node ComfyUI-InpaintCanvas.
Before that the node's `js/` was the source and `tools/sync_editor.py` copied it here with 49
patches (`docs/SYNC.md`); both are gone, their table is kept at the end of this file.

```
python tools/build_node.py            # writes the node's js/ and records the build in its DEVELOPMENT.md
python tools/build_node.py --check    # writes nothing; fails on a hand edit in the node or a missing host member
python tools/node_test.py             # the node's flavour in a hidden Electron window, no ComfyUI needed
```

## What goes where

| File | Owner | In the node |
|---|---|---|
| `renderer/editor/inpaint_canvas.js`, `inpaint_filters.js`, `inpaint_filters_gl.js`, `inpaint_curves.js`, `inpaint_text.js`, `inpaint_raster.js`, `inpaint_export.js`, `inpaint_worker.js`, `inpaint_compositor.js`, `inpaint_brushes.js`, `fonts/` | this repo | generated into `js/` with a first line naming the source |
| `renderer/editor/host.js` | this repo | not copied: the node has its own `js/host.js` |
| `renderer/editor/stitch.js`, `renderer/editor/px/` | this repo | not copied (app-only; `px/` goes with C2) |
| `js/host.js` | node repo | what the editor asks ComfyUI: `app`, `api`, the litegraph node |
| `js/inpaint_node.js` | node repo | the litegraph extension (thumbnail widget, queuePrompt wrapper, setting outputs, event routing); it was the block `sync_editor.py` cut off the end of `inpaint_canvas.js` |
| `js/inpaint_bridge.js` | node repo | the MCP command bridge of the node |

The GL filter module and the compositor reach the node with C0 (they guard themselves:
without WebGL2 the Canvas 2D paths run).

## The host contract

The editor never imports `app` or reads the graph; it calls `host.*` (from `./host.js`) and
`api` (same module). `tools/build_node.py` checks that every `host.<member>` the editor modules
use exists in **both** `renderer/editor/host.js` and the node's `js/host.js`, and that every
module that uses `host` imports it. Members where the hosts differ in kind, not only in
implementation:

- `overlay` (node `true`, app `false`): the editor is an overlay over the graph, so it shows the
  "Inpaint Canvas" title, a close button and the "Esc: close" hint; in the app it is the window.
- `text` (node: a table, app: `null`): the few texts the node words differently (the download
  button, the export tooltips naming the output folder, "workflow embedded", the "no language
  model / SAM2 / RMBG" messages that name ComfyUI nodes instead of Settings, the film preset
  tooltip without Scumble's trademark sentence). The editor's `hostText(key, fallback)` falls
  back to Scumble's wording.
- `graph()` (node `app.graph`, app `null`) and `referencedTexts()` (node: the open workflow tabs,
  app: nothing): the node's `settingTargetsFromGraph()` and the file cleanup's keep list.
- `saveExport(blob, name, { editor, download })`: the app opens a save dialog, the node uploads
  into ComfyUI's output folder (and downloads a copy with `download`); both return an object
  with `path`, the node's also carries the upload ref.
- Everything app-only answers "not here" in the node: `objectsInApp()` false,
  `upsampleBackends()` / `cutoutBackends()` empty, `generateNewAvailable()` false,
  `upsampleInstruction` null, the plugin hooks no-ops, `exportCanvas` the full-size flatten and
  `exportQuality` 0.92.

A new `host.*` call in the editor needs a member in both files; `--check` names the missing one.

## The freeze (2026-09-13)

- `tools/sync_editor.py` ran once more and changed nothing in `renderer/editor/`.
- Node repo `ComfyUI-InpaintCanvas` at `83887b6`, its `js/` tree `a10d3af151b6507d69b4ef38ca792b7d9d49b467`.
- App repo at `cc3be22` (branch `px-spike`, phase B), C0 on the branch `c0-editor-source` in both repos.
- The "Synced from ComfyUI-InpaintCanvas" first line left every file in `renderer/editor/`.

**Found by the freeze: the node's editor could not be created since 2026-09-10.** Node commits
`33c6c4b` (the "Generate new" hook) and `3fc2b7f` (the upsample instruction hook) call `host.*`
in `inpaint_canvas.js`, which in the node never had a `host`; the app's copy imported one
through a sync patch, so every app gate stayed green. In ComfyUI `new InpaintEditor(node)` threw
`ReferenceError: host is not defined` in `buildModal()`, i.e. `onNodeCreated` failed for every
Inpaint Canvas node. `tools/node_test.py` reproduces it against the node as it was, and passes
on the build.

**Found by the review of C0** (three lenses, every finding verified):
- ComfyUI imports *every* `.js` of `js/` into its page, `inpaint_worker.js` too. Its
  `self.onmessage` then sat on the window and answered any message posted to the page with an
  error posted to the page, forever (56,476 message events in 500 ms after one foreign
  message). The handler is installed only inside a worker now; `node_test.py` asserts it.
  Rule: no module in `renderer/editor/` may have page-level side effects at import.
- `node --check file.js` exits 0 on a broken ES module (Node 24 retries a file with import
  syntax as ESM without parsing it), so the first parse check checked nothing.
  `build_node.py` parses with `--input-type=module` and self-tests on a broken module.
- The node's `host.js` loads `uploadBlob` with a dynamic `import()`; `build_node.py` resolves
  `const { … } = await import("./x.js")` too, and `node_test.py` exports an image and checks
  the upload went to `output`.

## Gates of a change to the editor

Every app gate as before (`CLAUDE.md` "Working rules"), then `python tools/build_node.py` and
`python tools/node_test.py`, and before a node release one real run in the ComfyUI browser tab
(check `/queue` first). Commit both repos.

## History: how the sync worked until C0

### The patch table (what each patch did, and where it lives now)

| Node | App |
|---|---|
| `import { app } / { api }` from ComfyUI | `import { api, host } from "./host.js"` |
| `installBridge(...)` (MCP command bridge) | not imported: `renderer/commands.js` is the port of its table (docs/COMMANDS.md) |
| `LiteGraph.registered_node_types` (helper backend availability) | `host.nodeTypes()` built from `/object_info` |
| Escape closes the editor overlay | `host.onEscape(editor)`: the editor is the window |
| `document.body.appendChild(root)` | `host.mount(root)` into `#editor-host` |
| Close button, "Esc: close" hint, "Download" button | removed / relabelled |
| `settingTargets()` walks the graph links of `setting_n` outputs | `host.settingTargets(editor)`: the recipe's `settings` list, specs from `/object_info` (the graph version stays as `settingTargetsFromGraph`, unused) |
| `resultInputState()` reads the node's `result` / `result_local` links | `host.resultInputState(editor)`: from the recipe's mode |
| `widgetValue()` reads the node's padding / target_size / feather / multiple_of widgets | `host.widgetValue()`: `settings.nodeParams` |
| `app.queuePrompt(0)` (graphToPrompt + the queuePrompt wrapper) | `host.queueGenerate(editor)`: fills the recipe with `serializeForPrompt()` and POSTs `/prompt` |
| `notifyChanged()` marks the litegraph canvas dirty | `host.changed(editor)`: debounced autosave of `getValue()` |
| export uploads to ComfyUI's `output/` | `host.saveExport(blob, name)`: native save dialog (or a fixed path for scripts) |
| `exportImage()` flattens and encodes at full size with quality 0.92 | `host.exportCanvas(this, fmt)` and `host.exportQuality(this)`: the Size row the app appends under the Export row (percentage or a free width and height, JPEG / WebP quality); PSD and ORA stay full size, and the status line names the size that was written |
| PNG `workflow` chunk = graph serialize | `host.workflowForPng()`: recipe id, prompt, node params |
| `referencedFiles()` scans graph nodes and workflow tabs | scans `host.editors()` only |
| `exportLayerPng()` / `exportMaskPng()` upload to ComfyUI's `output/` | `host.saveExport(blob, name)` like `exportImage` |
| Title span "Inpaint Canvas" in the editor's top bar | removed (the shell bar carries the name) |
| Generate section ends with the Refine button | `host.buildGenerateExtras(editor, sec)` adds the node's own widgets (padding, target_size, feather, multiple_of) |
| window-level keydown handler runs for every open editor | `host.isActive(this)` guard: several editors share the window (tabs), only the active one gets shortcuts |
| `applyFilter()` in inpaint_filters.js runs the CPU code | asks `applyFilterGL()` (renderer/editor/inpaint_filters_gl.js) first; `info.cpu = true` forces the CPU path; the table builders are exported for the GL module |
| `inpaint_compositor.js` (the WebGL2 layer compositor) | copied unpatched; it guards itself with `GLCompositor.available()`, so the node keeps working in a browser without WebGL2 |
| `inpaint_worker.js` (PNG encoding, upload hashes, the PSD / ORA writers) | copied unpatched; it is created from `import.meta.url`, so it loads from `scumble://app/editor/` here and from `/extensions/...` in ComfyUI |
| `matchCanvas()` in inpaint_filters.js runs the colour match pixel loop | asks `applyMatchGL()` first (mode 6 of the filter shader, the six statistics as uniforms); the CPU loop stays the fallback |
| `app.registerExtension` block (node widget, queuePrompt wrapper, `executed` / `execution_error` routing) | dropped; `host.js` routes the websocket events to the one editor |
| `objectBackendAvailable()` needs Kijai's SAM2 loader on the server | true as well when `host.objectsInApp()` (a SAM2 ONNX model is downloaded); the "needs Kijai" status names Settings › Helpers |
| `ensureObjects()` queues the SAM2 helper prompt | after the staleness check: `host.findObjects(this, {hash, layer})` when a model is present (phase 3), else the helper prompt |
| `applySegmentsFile()` decodes the label PNG and fills `this.objects` | split: the decode stays, the rest is `applySegmentIds(ids, w, h, count, pending)` which the in-app path calls directly |
| `toggleObjectAt()` says "No object here" | with a SAM2 model in-app: `host.selectPoint(this, ix, iy, p)`, one point prompt on the cached embedding |
| `availableCutoutBackends()` filters `CUTOUT_BACKENDS` by node types | `host.cutoutBackends()` (`app:<model>`, `inApp: true`) listed first |
| `cutoutLayer()` uploads the layer and queues the RMBG helper prompt | picks the backend from the merged list; `inApp` → `host.cutoutInApp()` + `applyCutoutImage()`; the "no nodes" texts name Settings › Helpers |
| `applyCutoutFile()` loads the mask PNG and applies it | split: the load stays, the rest is `applyCutoutImage(img, pending)` (any drawable, scaled onto the layer) |
| `freeHelperModels()` POSTs `/free` | first `host.freeHelpers()` (ONNX sessions); without a server only that |
| exports at the end | also `el, icon, iconButton, miniButton, selectInput, numberInput` (DOM helpers for plugins.js) |
| tool column `tools` and its `addTool` closure | `this.toolsEl`, `this._addTool` (plugin tools get a button) |
| `section()` closure over the current pane | `this.addSection(title, open, build, paneId)` (plugin panels) |
| end of the constructor | `host.editorBuilt(this)` (plugins add their panels and tools to new editors) |
| `onPointerDown` after `toImage`, `onPointerMove` after `this.hover`, `onPointerUp` after the capture release | `host.pluginPointer(this, phase, e, ix, iy[, p])`: a plugin tool takes the gesture (`pointer.kind === "plugin"`) |
| `onKey` before the tool `switch` | `host.pluginKey(this, e, k)`: single-key shortcuts of plugin tools / actions |
| `setTool` | `host.toolChanged(this, tool, prev)` (plugin tools' onSelect / onDeselect) |
| `modeSel` change sets `genSettings.mode` | also `host.modeChanged(this, mode)`: the shell switches to the recipe last used in that mode (`settings.recipeByMode`) |
| `renderSettings()` starts with the setting rows | `host.renderPresets(this, list, targets)` first: a Preset row (saved model / text encoder / VAE combinations per recipe, `settings.recipePresets`) |
| `availableUpsampleBackends()` filters `UPSAMPLE_BACKENDS` by node types | plus `host.upsampleBackends()` (`app:<provider>:<model>`, `inApp: true`) after them: API language models with a stored key |
| `upsamplePrompt()` uploads the context crop and queues the VLM helper prompt | picks the backend from the merged list; `inApp` → `host.upsampleInApp(this, backend, instruction)` (IPC `llm:ask`, then `applyTextResult`) |
| `segmentByText()` links the VLM's STRING output into the segmentation prompt | with an `inApp` model: `host.askLLM()` names the object first, the term goes into the prompt as text |
| "no language model nodes installed" texts | mention Settings › API providers |
| `drawOverlays()` before the screen-space part | `host.pluginOverlay(this, ctx)` (plugin tools draw in image coordinates, phase 4b) |
| the filter preset select: every select fills params and renames the layer | only the param named `preset` does; other selects (mode, style, colour) set their value; `p.title` is the tooltip (phase 4b) |
| `applyFilterLayer()` filters `ctx.canvas` and draws the result back, `filteredCanvas()` always returns a canvas | both take and return the GPU filter chain: filter layers that follow each other hand their result on as a texture (`drawLayersInto` carries it, `flushFilterChain` puts it on the canvas, `nextIsFilterLayer` asks whether it may go on), phase 5 step 2 |
| `applyFilter()` runs the CPU code when the GPU path says no | the input is turned into a canvas first (`glToCanvas`) unless the filter declares `chain` (a plugin whose `apply` runs its own shader stages) |

Unchanged and still true in the app: uploads go to `/upload/image` with
`input/inpaint_canvas` (`n{id}_...` names, hash de-duplicated), helper prompts (SAM3,
RMBG, Qwen-VL) are queued at the front with `api.queuePrompt(-1, ...)`, results arrive
as `executed` events with `inpaint_result` / `inpaint_mask` / `inpaint_text`, the state
JSON is the node's `canvas_state` (see the node's DEVELOPMENT.md §4). The editor does
not know that `/comfy/upload/image` and `/comfy/view` are answered by the local file
mirror (`electron/main/files.js`) rather than the server: uploads are stored under
`<userData>/files/<type>/<subfolder>/` and forwarded when connected, views come from
the mirror first (server fetches are kept, except `temp`), and `host.queueGenerate`
calls `ensureOnServer` with the refs from the state JSON before every run.

### WebGL2 filters (app-only, to go back into the node)

`renderer/editor/inpaint_filters_gl.js` runs levels, curves, brightness / contrast,
hue / saturation, colour balance, black & white, invert, LUT and grain as one fragment
shader pass; blur, sharpen and vignette stay on Canvas 2D (`ctx.filter`, gradients).
The shader mirrors the CPU maths including the 8-bit rounding between passes, so both
paths agree within one level (LUT: two, its nodes are stored as RGBA8). The grain noise
field comes from `grainNoiseCanvas()` in `inpaint_filters.js` itself (one cached tile of
cells, repeated and anchored at the image origin), so both paths always see the same
field; it is uploaded as a texture straight from the canvas, never read back. The colour
match is mode 6 of the same shader. Pictures larger than the drawing buffer (about 33 MP)
render once into an off-screen texture and are copied out with `blitFramebuffer`
(`renderToTexture`), instead of running the shader again per tile. The curve
editor's histogram comes from a 256 px thumbnail. Measured on a 4000 × 3000 image:
grain 325 ms → 7 ms, curves 61 → 4 ms, colour balance 100 → 5 ms (cached noise, warm
context). `compareFilterPaths()` in the module is the regression check.

Since phase 5 step 2 the module also keeps **render targets**: a `GLSurface` is an RGBA8
texture with a framebuffer, and with `info.chain` a pass writes into one instead of a
canvas and reads one instead of uploading. That is what turns a stack of filter layers,
and the stages inside one filter, into one upload and one read back. Surfaces are stored
top down like a canvas texture (`u_dstTop` flips the fragment mapping when the target is a
surface), so nothing downstream needs to know where its input came from; `beginScope()` /
`endScope(keep)` hand every surface a run took back to the pool except its result;
`glChainStats()` counts the round trips. The cap is `CHAIN_MAX_PIXELS` (10 MP: a screen
pass, not a full-resolution render, see docs/PERFORMANCE.md phase 5 step 2).

### Crop and stitch in the app (app-only)

`renderer/editor/stitch.js` ports the node's `InpaintCanvas.run` (crop) and
`InpaintCanvasStitch.stitch` to Canvas 2D and typed arrays, for recipes that render
through an API provider without ComfyUI (`host.runProvider`). Same formulas and order
as nodes.py (auto params, min span, multiple rounding, fill modes, denoise and
composite masks, colour match); differences and what is not ported are listed at the
top of the file and in docs/RECIPES.md. The node keeps its Python version; nothing
here changes the synced editor files.

### Things the node has that the app does not use yet

- The `/inpaint_canvas/fonts` user font route: proxied through, so user fonts uploaded
  from the node show up, but the app has no own upload path yet.
- `cleanupFiles()`: works through the proxy against the node's cleanup route; the keep
  list only knows this editor's files, so run it with care while ComfyUI workflows in a
  browser reference files too.
