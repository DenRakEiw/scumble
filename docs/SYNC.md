# Editor sync with the ComfyUI node

The editor source still lives in the node repo (`ComfyUI-InpaintCanvas/js`). The app
carries a patched copy in `renderer/editor/`, produced by `tools/sync_editor.py`.
Never edit `renderer/editor/*.js` by hand: change the node, or add a patch.

```
python tools/sync_editor.py            # node at F:\Comfyui\...\ComfyUI-InpaintCanvas
python tools/sync_editor.py --node X   # another checkout
```

The script copies `inpaint_canvas.js`, `inpaint_filters.js`, `inpaint_curves.js`,
`inpaint_text.js`, `inpaint_raster.js`, `inpaint_export.js` and `fonts/`, applies the
patch list, cuts the litegraph extension block at the end of `inpaint_canvas.js` and
appends the exports. Every patch must match exactly once (or the stated count);
otherwise it stops and names the patch, which is the signal that the node changed at
that spot.

## What the patches do

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
| PNG `workflow` chunk = graph serialize | `host.workflowForPng()`: recipe id, prompt, node params |
| `referencedFiles()` scans graph nodes and workflow tabs | scans `host.editors()` only |
| `exportLayerPng()` / `exportMaskPng()` upload to ComfyUI's `output/` | `host.saveExport(blob, name)` like `exportImage` |
| Title span "Inpaint Canvas" in the editor's top bar | removed (the shell bar carries the name) |
| Generate section ends with the Refine button | `host.buildGenerateExtras(editor, sec)` adds the node's own widgets (padding, target_size, feather, multiple_of) |
| window-level keydown handler runs for every open editor | `host.isActive(this)` guard: several editors share the window (tabs), only the active one gets shortcuts |
| `applyFilter()` in inpaint_filters.js runs the CPU code | asks `applyFilterGL()` (renderer/editor/inpaint_filters_gl.js) first; `info.cpu = true` forces the CPU path; the table builders are exported for the GL module |
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

## WebGL2 filters (app-only, to go back into the node)

`renderer/editor/inpaint_filters_gl.js` runs levels, curves, brightness / contrast,
hue / saturation, colour balance, black & white, invert, LUT and grain as one fragment
shader pass; blur, sharpen and vignette stay on Canvas 2D (`ctx.filter`, gradients).
The shader mirrors the CPU maths including the 8-bit rounding between passes, so both
paths agree within one level (LUT: two, its nodes are stored as RGBA8). The grain noise
field is generated exactly like in `applyGrain` (the generator is duplicated there for
now; when the module moves into the node, split `noiseCanvas()` out of `applyGrain` and
share it) and uploaded as a texture straight from the canvas, never read back. The curve
editor's histogram comes from a 256 px thumbnail. Measured on a 4000 × 3000 image:
grain 325 ms → 7 ms, curves 61 → 4 ms, colour balance 100 → 5 ms (cached noise, warm
context). `compareFilterPaths()` in the module is the regression check.

## Crop and stitch in the app (app-only)

`renderer/editor/stitch.js` ports the node's `InpaintCanvas.run` (crop) and
`InpaintCanvasStitch.stitch` to Canvas 2D and typed arrays, for recipes that render
through an API provider without ComfyUI (`host.runProvider`). Same formulas and order
as nodes.py (auto params, min span, multiple rounding, fill modes, denoise and
composite masks, colour match); differences and what is not ported are listed at the
top of the file and in docs/RECIPES.md. The node keeps its Python version; nothing
here changes the synced editor files.

## Things the node has that the app does not use yet

- The `/inpaint_canvas/fonts` user font route: proxied through, so user fonts uploaded
  from the node show up, but the app has no own upload path yet.
- `cleanupFiles()`: works through the proxy against the node's cleanup route; the keep
  list only knows this editor's files, so run it with care while ComfyUI workflows in a
  browser reference files too.
