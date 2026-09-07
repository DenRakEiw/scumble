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
| `installBridge(...)` (MCP command bridge) | not imported yet (phase 4: the bridge becomes the command core) |
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
| `app.registerExtension` block (node widget, queuePrompt wrapper, `executed` / `execution_error` routing) | dropped; `host.js` routes the websocket events to the one editor |

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

## Things the node has that the app does not use yet

- `inpaint_bridge.js` (46 commands) - phase 4.
- The `/inpaint_canvas/fonts` user font route: proxied through, so user fonts uploaded
  from the node show up, but the app has no own upload path yet.
- `cleanupFiles()`: works through the proxy against the node's cleanup route; the keep
  list only knows this editor's files, so run it with care while ComfyUI workflows in a
  browser reference files too.
