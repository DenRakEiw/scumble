# New commands for MCP agents (0.1.42 session F2)

**Status (2026-10-05): F2a and F2b built** (all twelve picks, marked ✓ built below; `docs/PLAN_0_1_42.md` F2's two "As built" notes); the other 16 wait for a later update. **Before (2026-10-04): a research list.** The user asked during R1's session: "schau auch noch ob noch
mehr commands in den mcp aufgenommen werden können". Every command of the command core is an MCP tool by itself
(`electron/main/mcp/server.js` turns `commands.describe()` into the tool list), so a new tool is a new command in
`renderer/commands.js` or a plugin's `register`. A read-only workflow (8 agents) swept five ways: the native menu and
the shell, the editor's tools and panels, the dialogs and plugins, the node's bridge and the docs, and typical agent
jobs (retouch, composite, variants, batch, print, inspect). 181 raw candidates, 94 after merging; each was checked
by an adversarial verifier against the code. Verdicts: low_value 54, add 31, already_exists 6, no_editor_feature 3.
Anchors are from 2026-10-04 (grep first). `node` marks a change in `renderer/editor/*` that ships to the node build.
**The user's pick (2026-10-04): the 12 marked ✓ below** (asked for a recommendation first: the six of high value, the
two fixes of existing commands, the two selections, `list_settings` and `apply_preset`), built as sessions F2a and F2b
of `docs/PLAN_0_1_42.md` after F1 (F1's annotation flags then go on every new command). The other 16 stay here for a
later update (`CLAUDE.md` item 38).

## Worth adding (verdict add), by value for agents

| # | Command | Value | Effort | What it does |
| --- | --- | --- | --- | --- |
| 1 | `transform_layer` ✓ built (F2a) | high | M | Rotate a layer by any angle about its centre, distort it to four corner points (perspective), warp it on an n x n grid of points, or turn it 90 degrees, baked in one undo step (a text layer's rotation stays editable as its angle). |
| 2 | `cancel_run` ✓ built (F2a) | high | S | Cancel the API provider runs in flight (one document's or every document's) and report which runs were cancelled; a later step could also stop Scumble's own prompts on the local ComfyUI. |
| 3 | `copy_to_layer` ✓ built (F2a) | high | S | Copy (or cut) the selected pixels of a layer, a whole layer, or the merged picture into the shared clipboard and paste them as a new layer at the same place, in this tab or another (`doc` for each step). |
| 4 | `list_recipes_readiness` ✓ built (F2a) | high | S | Add to each recipe in list_recipes: ready (provider key stored, in-app model downloaded, or node types present on the server) with the reason when not, new_image (has a text-to-image route), the text sizes it offers, background (takes transparent), and limits.max (the longest side a document-scope upscale accepts). |
| 5 | `resize_image` ✓ built (F2a) | high | S | Resample the whole document (base, every layer and mask, the selection) to a new width and height, or by a percent / long side with the aspect kept when one side is given, in one undo step. |
| 6 | `screenshot_region` ✓ built (F2a) | high | S | Extend screenshot with box [x, y, w, h] (a region at up to 1:1, e.g. the inpainted area on a large document), what "base" (the picture without layers, the before) and what "mask" (the selection or a layer's mask in black and white). |
| 7 | `draw_shape` | medium | M | Draw a rectangle (corner radius), ellipse, polygon, polyline, Bezier or freehand shape from points as pixels on a layer, with fill and / or outline (width, colour), clipped to the selection. |
| 8 | `paint_stroke` | medium | M · node | Paint or erase a polyline of image-pixel points [[x, y, pressure]] with the current brush (or given colour, size, hardness, opacity, flow, tip) on a layer's pixels or, with target "mask", on its mask (paint reveals, erase hides), or with the selection brush; one undo step per stroke. |
| 9 | `patch_selection` | medium | M | Patch the selection from the picture at an offset dx, dy with Blend 0..100 (Source) or copy it there (Destination); content-aware move moves the selected piece by dx, dy and fills its old place with LaMa (Move) or copies it (Extend). |
| 10 | `apply_preset` ✓ built (F2b) | medium | S | List, apply, save or delete the selected recipe's Settings presets (named combinations of model files: unet / ckpt / clip / vae / lora), including the presets M and L that 0.1.42 ships in the Realism Pass recipe file. |
| 11 | `boxes.check` | medium | S | What Generate would do with the boxes now: the crop it sends, the boxes left out, cut, spilling outside the selection or too small, boxes without a description, boxes the recipe cannot place, and the rows text the model gets. |
| 12 | `crop_info` | medium | S | Report what the next Generate will send: the crop rectangle, context and edge (grow, feather, blend), the emitted size after Target and Multiple, batch count, the reference routing (img1 -> <image3>, fit, not sent), the control layers and whether the result input is wired. |
| 13 | `import_recipe` | medium | S | Import a ComfyUI workflow (with an Inpaint Canvas node), a recipe JSON or a Comfy Cloud export from an absolute path as a user recipe, reload the list and optionally select it; return id, mode, settings count and notes (the app's form of the node bridge's load_workflow). |
| 14 | `list_fonts` | medium | S | List the font families add_text / set_text accept (bundled and imported, with family and file ref), and import a .ttf / .otf / .woff from a path. |
| 15 | `list_providers` | medium | S | List the API providers with label, whether a key is stored (true / false only), the key URL, whether a balance query exists and which provider shares another's key. The key flags went into list_recipes' `provider_keys` in F2a (id, label, key, shares_key). |
| 16 | `list_settings` ✓ built (F2b) | medium | S | The selected recipe's Settings panel as data, read-only: each row's index, label, input, kind (number, combo, text, toggle), its options (model files, LoRAs, samplers) or min / max / step, and the current value, plus the recipe's saved presets. |
| 17 | `load_filter_file` | medium | S | Load a .cube 3D LUT from a path into a LUT filter layer (new or given), load a grain plate image into a grain layer, or remove the plate; as `lut_path` / `plate_path` params on add_filter / set_filter or a command of its own. |
| 18 | `probe_comfy` | medium | S | Read-only check of the configured ComfyUI without connecting: version, latency, devices and free VRAM, queue (running / pending), whether the Inpaint Canvas node pack is installed, and per local recipe which model files the server has and which are missing. |
| 19 | `read_manual` | medium | S | Return the user manual (docs/MANUAL.md): whole, one chapter by slug or heading, or the chapters / paragraphs matching a query, as the node's MCP server offered its GUIDE.md resource. |
| 20 | `read_pixels` | medium | S | Return the RGBA / hex value at a point or the values of a small box of the visible picture or one layer, and / or a 256-bin per-channel histogram with mean, min and max of a box or the selection (sampled at a scale for large pictures); optionally make the point's colour the paint colour. |
| 21 | `select_color` ✓ built (F2b) | medium | S | Magic wand / colour range: select the area of similar colour at x, y (tolerance 0..255, contiguous on or off, sample image or layer) with replace, add or subtract. |
| 22 | `select_shape` ✓ built (F2b) | medium | S | Select an ellipse (x, y, w, h) or a polygon / lasso (a list of points) with replace, add or subtract, optionally feathered, without sending a full-size mask. |
| 23 | `set_api_size` | medium | S | Set the Highres fix for API runs (max, x2, x4, target, crop): how far the crop is pushed up before it goes to a provider; best as an `api_size` param on set_node_params, also reported in status. |
| 24 | `set_crop_fix` ✓ built (F2b) | medium | S | Fix set_crop's schema and checks: colorMatch, withOriginal and align as booleans; fill (none / neutral / blur / border / green), extendFill (stretch edges / average color / grey / green / black / noise) and paste (selection / crop) as enums; context and feather take auto or manual (pixels come from set_node_params); validate instead of storing raw values; say that extend_canvas takes its fill from extendFill. |
| 25 | `set_filter_preset_fix` ✓ built (F2b) | medium | S | Make add_filter / set_filter apply a preset's values the way the UI does when params.preset is given (grain 'Film' presets, B&W colour filters), push the filter undo step the UI pushes, and list option labels and groups in filter_types. |
| 26 | `get_recipe` | low | S | One recipe in full: its API-format graph, settings rows, needed node types, saved workflow (on request) and its provider variants (model, fields, limits, text route, factor), so an agent can inspect it, or change it and re-import it. |
| 27 | `reopen_closed_tab` | low | S | Bring back the most recently closed tab of this session, layers and file link included (close_document's own description already points at this). |
| 28 | `text_spacing` | low | S | Add letter_spacing (image pixels) and line_height (multiple of the size) to add_text and set_text, and report them (with outline) in the layer summary. |

Already in F1 (the user's six fixes), found again by the sweep: `flip_layer_fix`, `mcp_annotations_fix`, `remove_layer_refusal_fix`.

## Details of each candidate

### `transform_layer` (value high, effort medium: about a day)

- **What:** Rotate a layer by any angle about its centre, distort it to four corner points (perspective), warp it on an n x n grid of points, or turn it 90 degrees, baked in one undo step (a text layer's rotation stays editable as its angle).
- **Where a user reaches it today:** Move/scale tool (T) subbar: Rotate / Distort / Warp modes, Angle field, Apply (Enter), rotate-90 buttons; drag just outside a corner to rotate
- **Anchor:** renderer/editor/inpaint_canvas.js:2521 startPending(mode), :2548 pendingDst (p.angle radians, p.points corners or (n+1)^2 grid), :2642 applyPending, :4396 rotateLayer90(dir)
- **Params:** layer, mode rotate|distort|warp|rotate90, angle (deg), corners [[x,y]x4], grid {n, points}, dir
- **Evidence:** no rotate/distort/warp command (set_layer only x/y/w/h, flip_layer, set_text angle for text); startPending/applyPending need no pointer: renderer/editor/inpaint_canvas.js:2521 and :2642
- **Notes:** Drive from commands.js: set the active layer and clear a multi-selection, startPending, set ed.pending.angle / .points (warp: set ed.warpGridSel.value or overwrite p.n and p.points), applyPending. startPending and applyPending do not check isLocked: the command must. A text layer keeps rotate editable; distort / warp turn it into pixels; a live mask is baked in. Base not transformable (straighten_canvas covers the whole picture). Pixel path: both backends; policy row ASK on a user's layer.

### `cancel_run` (value high, effort small: hours)

- **What:** Cancel the API provider runs in flight (one document's or every document's) and report which runs were cancelled; a later step could also stop Scumble's own prompts on the local ComfyUI.
- **Where a user reaches it today:** Title row › Cancel beside the run timer (shown while an API run is in flight); a local ComfyUI run has no stop in Scumble at all
- **Anchor:** renderer/editor/host.js:1983 (cancelProviderRuns; runs in host._providerRuns carry .editor for a per-doc filter) -> IPC provider:cancel electron/main/main.js:1045 -> electron/main/providers/index.js cancel
- **Params:** doc? (only that document's runs; default all), returns {cancelled:[{doc, provider, label, seconds}]}
- **Evidence:** renderer/editor/host.js:1983 cancelProviderRuns exists, no command calls it (grep cancel in renderer/commands.js: none); bridge.js:121 cancel only drops requests not yet run (shell.js:2650-2664), so an MCP or assistant Stop never reaches a running generate; docs/PLAN_ASSISTANT.md:3449 lists 'Cancelling a running generate' as left out on purpose for the command core
- **Notes:** Requests run concurrently in the renderer (onRequest is not serialised), so the cancel lands while generate waits. generate's provider branch (commands.js:806) then waits up to 30 s in until() before 'no result arrived': make it end at once on a cancelled run. Local ComfyUI runs stay out (no /interrupt path; the user's 8188 is production, only Scumble's own prompt ids could ever be touched). A provider may still bill an aborted run: say so in the answer. Needs a policy row (AUTO is fine).

### `copy_to_layer` (value high, effort small: hours)

- **What:** Copy (or cut) the selected pixels of a layer, a whole layer, or the merged picture into the shared clipboard and paste them as a new layer at the same place, in this tab or another (`doc` for each step).
- **Where a user reaches it today:** Ctrl+C / Ctrl+Shift+C (merged) / Ctrl+X, then Ctrl+V (renderer/editor/inpaint_canvas.js:3087-3090); layer row tooltip 'Ctrl+C copies it, Ctrl+V pastes it here or in another tab'
- **Anchor:** renderer/editor/inpaint_canvas.js:10366 copySelection({merged, cut}), :10389 copyLayer, :10412 pasteClipboard; clipboard accessor :1812
- **Params:** layer? (default active; base = merged), merged, cut, to_doc?
- **Evidence:** copySelection / copyLayer / pasteClipboard (inpaint_canvas.js:10366/10389/10412) are only reachable by Ctrl+C/X/V (inpaint_canvas.js:3087-3090); findLayer (commands.js:133) cannot address the base, so duplicate_layer + set_mask cannot lift a piece of the base
- **Notes:** Save ed.clipboard before and restore it after, so the user's Ctrl+V is not hijacked (the clipboard is module-wide, shared by all tabs). With no active layer copySelection takes the merged picture, which equals the base when nothing is above it. Merged uses flattenToCanvas (throws on documents over the canvas limit). Cut writes pixels: ASK in the policy. Typical agent use: lift an object to a layer, then set_layer x/y or transform_layer.

### `list_recipes_readiness` (value high, effort small: hours)

- **What:** Add to each recipe in list_recipes: ready (provider key stored, in-app model downloaded, or node types present on the server) with the reason when not, new_image (has a text-to-image route), the text sizes it offers, background (takes transparent), and limits.max (the longest side a document-scope upscale accepts).
- **Where a user reaches it today:** Settings › Recipes meta line ('no key', 'model not downloaded'), the provider '(no key)' labels, the Generate new dialog (recipe list, sizes, Transparent row), the Upscale dialog note
- **Anchor:** renderer/shell.js:467 providerKeyState(r) (expose on host.shell :285); renderer/commands.js:434 list_recipes
- **Params:** none; per recipe ready, reason, new_image, sizes, background, limits.max; per provider key: bool
- **Evidence:** list_recipes (commands.js:434) has no key / model / node state; providerKeyState (shell.js:467) is not on host.shell; generate fails late with 'no key' or 'model not downloaded'
- **Notes:** Booleans only, never the key or its hint. Local recipes: node types against host.nodeTypes(). Fold list_providers' key flags into the same change.

### `resize_image` (value high, effort small: hours)

- **What:** Resample the whole document (base, every layer and mask, the selection) to a new width and height, or by a percent / long side with the aspect kept when one side is given, in one undo step.
- **Where a user reaches it today:** Image tab › Canvas section (canvas tool C) › Resize W x H with aspect lock › Resize (renderer/editor/inpaint_modal.js:692)
- **Anchor:** renderer/editor/inpaint_canvas.js:5109 resizeImage(nw, nh) -> :5112 resizeImageNow
- **Params:** width, height (one keeps the aspect) or percent / long_side
- **Evidence:** renderer/editor/inpaint_canvas.js:5109 resizeImage(nw, nh) is called only by the UI button (inpaint_modal.js:692) and by host.js:1716 (upscale landing); no command resamples the document (export scale only writes a file, upscale needs an AI recipe)
- **Notes:** Refuses while a turn or job runs (turnBlocked) and only reports through the status line: the command must compare width/height after the await and throw ed.status. makeCanvas throws above Chromium's canvas limits (E5) for huge targets: clamp. One undo step. Named missing in PLAN_ASSISTANT §9. Normal tier, both backends; policy ASK.

### `screenshot_region` (value high, effort small: hours)

- **What:** Extend screenshot with box [x, y, w, h] (a region at up to 1:1, e.g. the inpainted area on a large document), what "base" (the picture without layers, the before) and what "mask" (the selection or a layer's mask in black and white).
- **Where a user reaches it today:** No direct UI: the user zooms the view, peeks the base with \, toggles the selection display; screenshot always shows the whole picture scaled to max_size <= 4096
- **Anchor:** renderer/commands.js:173 shotCanvas; renderer/editor/inpaint_canvas.js:7258 sampleRegionSettled(source, box, scale) (falls back to sampleRegion on the canvas backend, so it works on both), :7275 selectionCanvasSettled
- **Params:** box [x,y,w,h] on screenshot; what adds base and mask
- **Evidence:** screenshot (commands.js:1231, shotCanvas :173) only renders the whole picture scaled to max_size or one layer unmasked; no box, no base-only, no mask view
- **Notes:** The box is the valuable part (judge an inpainted area at 1:1 on a large document). Use sampleRegionSettled for the box on both backends instead of flattenToCanvas. base: drawBaseInto; mask: selectionCanvasSettled on tiles, sel.drawTo on canvas. Read-only, policy already AUTO. Light tier.

### `draw_shape` (value medium, effort medium: about a day)

- **What:** Draw a rectangle (corner radius), ellipse, polygon, polyline, Bezier or freehand shape from points as pixels on a layer, with fill and / or outline (width, colour), clipped to the selection.
- **Where a user reaches it today:** Toolbar Shape (Y) + options bar Kind / Fill / Outline / Width / colour / Radius (renderer/editor/inpaint_canvas.js:2240)
- **Anchor:** renderer/editor/inpaint_canvas.js:9670 finishShape(close) over ed.shapePoints [{x,y,hx,hy}] and ed.shapeOpts (:2239), :9648 paintShape
- **Params:** kind rectangle|ellipse|polygon|polyline|bezier, points or x,y,w,h, fill, fill_color, stroke, stroke_color, width, radius, layer
- **Evidence:** no command draws outlines or shapes as pixels; finishShape (inpaint_canvas.js:9670) needs only shapePoints + shapeOpts, no pointer; planned as docs/PLAN_0_1_7.md §2
- **Notes:** Polygon / polyline / bezier run app-only; rectangle (with radius) and ellipse can be sent as bezier points with handles (4 kappa points for an ellipse), so no editor edit is needed. The planned drawShape() refactor would be cleaner but shared with the node. Fill uses ed.color, outline shapeOpts.color: set both for the call and restore. Annotations ('circle the cat in red') are a plausible assistant request. Pixel path: policy row.

### `paint_stroke` (value medium, effort medium: about a day, ships to the node)

- **What:** Paint or erase a polyline of image-pixel points [[x, y, pressure]] with the current brush (or given colour, size, hardness, opacity, flow, tip) on a layer's pixels or, with target "mask", on its mask (paint reveals, erase hides), or with the selection brush; one undo step per stroke.
- **Where a user reaches it today:** Toolbar Paint (P), Erase (E), Selection brush (B) / Deselect brush (D) dragged on the canvas; on a mask with the layer's mask edit on; Shift+click draws a straight line
- **Anchor:** renderer/editor/inpaint_canvas.js:5966 layerStroke(p, x0, y0, pts), :6161 finishStroke, :7897 commitLayerPaint, :5887 selectionDab; pointer setup :5440-5463
- **Params:** layer, points [[x,y,pressure]], target pixels|mask|selection, erase, color, size, hardness, opacity, flow, tip
- **Evidence:** no command paints (set_brush only stores settings; dodge_burn_layer makes a layer nothing can paint); the pointer path builds a StrokeBuffer (inpaint_canvas.js:5440-5463), and StrokeBuffer (inpaint_canvas.js:1679) is not exported (export list :18660), so commands.js cannot build the pointer object
- **Notes:** Needs a small strokeAlong(points, opts) in inpaint_canvas.js (build the layerpaint/maskpaint object, layerStroke, commitLayerPaint), so build_node.py + node_test. Synthetic PointerEvents (tools/brush_test.py) depend on the view: not for agents. A hard round polyline is already possible without editor change through the shape tool (shapeOpts.kind polyline + shapePoints + finishShape(false)), see draw_shape. Named missing in PLAN_ASSISTANT §9 (the assistant tells the model it cannot paint). Pixel path: both backends, policy row.

### `patch_selection` (value medium, effort medium: about a day)

- **What:** Patch the selection from the picture at an offset dx, dy with Blend 0..100 (Source) or copy it there (Destination); content-aware move moves the selected piece by dx, dy and fills its old place with LaMa (Move) or copies it (Extend).
- **Where a user reaches it today:** Toolbar Retouch group › Patch / Content-aware move (Shift+J) + options bar Mode / Blend: lasso or select, then drag the selection
- **Anchor:** renderer/editor/inpaint_canvas.js:8116 patchExtent(name, min), :8099 patchRefusal, :8282 patchRun(p), :8341 moveRun(p); p = {tool, mode, E, selA, d:[dx,dy], lim}
- **Params:** dx, dy, mode source|destination|move|extend, blend 0..100
- **Evidence:** patchExtent / patchRun / moveRun take a plain object, no event (inpaint_canvas.js:8116, :8282, :8341); only the drag (patchPress :8150) builds it, and no command calls them
- **Notes:** Repeat patchPress's checks in the command (patchRefusal, LaMa for move, removeMaxHole 2048, the layer and lim clamp of d), or move them into a small editor method (then shared). Move holds async like Remove: wait for ed.removePending. Content-aware move ('move this object 100 px left with its old place filled') is a plausible agent task no other command does. Pixel path: both backends, policy row.

### `apply_preset` (value medium, effort small: hours)

- **What:** List, apply, save or delete the selected recipe's Settings presets (named combinations of model files: unet / ckpt / clip / vae / lora), including the presets M and L that 0.1.42 ships in the Realism Pass recipe file.
- **Where a user reaches it today:** Generate tab › Settings section › Preset row (select, Save, Delete)
- **Anchor:** renderer/editor/host.js:1102 applyPreset(editor, targets, preset); preset list as in renderPresets :1028 (shipped r.presets + host.presets[r.id])
- **Params:** preset name on set_settings; list in list_settings
- **Evidence:** host.applyPreset (host.js:1102) and the shipped presets (renderPresets host.js:1028 reads r.presets, the Realism Pass's L and M) are reachable only through the Preset select
- **Notes:** Only apply and list; save / delete (persistent settings.recipePresets) stay UI. Apply mirrors renderPresets' filter (provider recipes have none). The working tree already holds R1's shipped-preset code in host.js: build after R1 is committed, line numbers move.

### `boxes.check` (value medium, effort small: hours)

- **What:** What Generate would do with the boxes now: the crop it sends, the boxes left out, cut, spilling outside the selection or too small, boxes without a description, boxes the recipe cannot place, and the rows text the model gets.
- **Where a user reaches it today:** Boxes panel warnings and its Copy rows button
- **Anchor:** plugins/boxes/main.js:193 (cropCheck), :210 (bareOf), :154 (unplacedOf), :265 (copyRows / clipboardText)
- **Params:** doc (or fold into boxes.list as a `check` field)
- **Evidence:** boxes.list (plugins/boxes/main.js:488-492) returns boxes, recipe takes and switch only; the panel's warnings come from cropCheck (:193, out/cut/spill/small), bareOf (:210) and unplacedOf (:154), none reachable by a command
- **Notes:** Plugin-only. Return copyRows' got.text/rows/notes instead of writing the clipboard (:274). cropCheck is null without a selection or boxes. Read-only: policy AUTO row (boxes_check).

### `crop_info` (value medium, effort small: hours)

- **What:** Report what the next Generate will send: the crop rectangle, context and edge (grow, feather, blend), the emitted size after Target and Multiple, batch count, the reference routing (img1 -> <image3>, fit, not sent), the control layers and whether the result input is wired.
- **Where a user reaches it today:** Generate tab › Crop section › info rows under the crop settings
- **Anchor:** renderer/editor/host.js:407 (host.cropFrame); renderer/editor/inpaint_canvas.js:14348 (autoParams for grow/feather/blend), ed.refLayoutInfo (read at :14409), host.resultInputState(ed) (used at commands.js:788)
- **Params:** doc
- **Evidence:** No command reports the planned crop: status gives only crop settings and selection bounds (commands.js:251); host.cropFrame(ed) (renderer/editor/host.js:407 -> stitch.js:462 planFrame) already returns {x,y,w,h,emitted,paste,aspect} for the selected recipe without any DOM, which the Boxes plugin uses (plugins/boxes/main.js:177)
- **Notes:** Corrected anchor: no split of renderInfoRows is needed, so it stays app-only (commands.js). Returns null crop without a selection (the whole image goes). Could instead be a crop_plan field in status. Read-only: policy AUTO row.

### `import_recipe` (value medium, effort small: hours)

- **What:** Import a ComfyUI workflow (with an Inpaint Canvas node), a recipe JSON or a Comfy Cloud export from an absolute path as a user recipe, reload the list and optionally select it; return id, mode, settings count and notes (the app's form of the node bridge's load_workflow).
- **Where a user reaches it today:** File › Import Workflow as Recipe...; Settings › Recipes › Import workflow ...
- **Anchor:** renderer/shell.js:627 importRecipe(file) -> IPC recipes:import -> electron/main/main.js:824 importRecipe
- **Params:** path (required, absolute .json), select (default false)
- **Evidence:** shell.js:627 importRecipe(file) already takes a path (the dialog opens only without one, main.js:824); not on host.shell (shell.js:285) and no command; the node bridge had load_workflow (COMMANDS.md:1069 lists it as gone)
- **Notes:** Writes a user recipe file (persistent) and, with select, changes the recipe of every tab: ASK. A UI-format workflow reads /object_info from the connected ComfyUI (GET), a Comfy Cloud export Comfy Cloud's with the stored key. Return id, mode, settings count, notes.

### `list_fonts` (value medium, effort small: hours)

- **What:** List the font families add_text / set_text accept (bundled and imported, with family and file ref), and import a .ttf / .otf / .woff from a path.
- **Where a user reaches it today:** Text layer row › Font select (renderer/editor/inpaint_canvas.js:13686); layers header 'font' file input / font file drop (addFontFiles)
- **Anchor:** renderer/editor/inpaint_text.js:52 fontList(); import: renderer/editor/inpaint_canvas.js:13745 addFontFiles(files) with renderer/commands.js:230 fileFrom
- **Params:** none (list); path for an import
- **Evidence:** add_text's description says 'see the editor's font list', which no command returns; setFont (commands.js:~1313) accepts any name and falls back silently
- **Notes:** The list is read-only and AUTO. The import writes into the local store (persistent): ASK; fileFrom types files as images, give fonts their own branch. Also let add_text / set_text refuse an unknown family instead of falling back.

### `list_providers` (value medium, effort small: hours)

- **What:** List the API providers with label, whether a key is stored (true / false only), the key URL, whether a balance query exists and which provider shares another's key.
- **Where a user reaches it today:** File › Settings › API providers (the key rows); the recipe picker's '(no key)' labels
- **Anchor:** electron/main/providers/index.js:78 describeAll (via window.scumble.providers.list) or the shell's cached `providers` (shell.js:651 loadProviders)
- **Params:** none; returns [{id, label, key: bool, shares_key, balance: bool}]
- **Evidence:** no command reports key state; list_recipes (commands.js:434) gives provider ids only; shell.js:467 providerKeyState and main.js:1043 providers:list -> providers/index.js:78 describeAll hold it
- **Notes:** Drop key.hint (last four characters) and never accept a key. Best built in the same change as list_recipes_readiness (a per-provider key boolean in list_recipes covers most of it); a separate command is only worth it for keyUrl / balance flags.

### `list_settings` (value medium, effort small: hours)

- **What:** The selected recipe's Settings panel as data, read-only: each row's index, label, input, kind (number, combo, text, toggle), its options (model files, LoRAs, samplers) or min / max / step, and the current value, plus the recipe's saved presets.
- **Where a user reaches it today:** Generate tab › Settings section (the recipe's own inputs) and its Preset row
- **Anchor:** renderer/editor/host.js:1152 settingTargets(editor) + renderer/editor/inpaint_canvas.js:17823 settingKind(t)
- **Params:** filter? / max_options; returns [{index, label, input, kind, options|min,max,step, value}], presets
- **Evidence:** set_settings (commands.js:661) with values {} already returns index / label / input / value, but no kind, combo options or ranges, and stores any value unchecked; settingKind exists (inpaint_canvas.js:17823)
- **Notes:** Read-only, app-only. Could equally be the answer shape of set_settings. Cap combo lists (model folders can hold hundreds). Lets an agent pick valid model / sampler names instead of guessing.

### `load_filter_file` (value medium, effort small: hours)

- **What:** Load a .cube 3D LUT from a path into a LUT filter layer (new or given), load a grain plate image into a grain layer, or remove the plate; as `lut_path` / `plate_path` params on add_filter / set_filter or a command of its own.
- **Where a user reaches it today:** Image tab › filter layer row › '.cube' load button (LUT); grain layer 'Plate' image button and trash (renderer/editor/inpaint_canvas.js:15290-15315)
- **Anchor:** renderer/editor/inpaint_canvas.js:12348 loadLutFile(layer, file), :12367 loadPlateFile(layer, file), :12388 removePlate; renderer/commands.js:230 fileFrom
- **Params:** lut_path / plate_path / remove_plate on add_filter and set_filter
- **Evidence:** add_filter type lut makes a LUT layer that no command can give a .cube, so it does nothing; loadLutFile / loadPlateFile take a File (inpaint_canvas.js:12348, :12367)
- **Notes:** loadLutFile catches errors into the status line: check layer.lut afterwards and throw ed.status. Reads a user file by path (as load_image; ASK in the assistant). Each pushes its own filter undo step.

### `probe_comfy` (value medium, effort small: hours)

- **What:** Read-only check of the configured ComfyUI without connecting: version, latency, devices and free VRAM, queue (running / pending), whether the Inpaint Canvas node pack is installed, and per local recipe which model files the server has and which are missing.
- **Where a user reaches it today:** File › Settings › ComfyUI › Test
- **Anchor:** electron/main/main.js:947 probeComfy (IPC comfy:probe :973, window.scumble.comfy.probe() with no conn uses the stored URL and auth) -> electron/main/comfy.js:126 probe; renderer/shell.js:366 recipeModelReport
- **Params:** none; returns version, latency, devices with free VRAM, queue {running, pending}, node pack, per local recipe missing model files
- **Evidence:** ping / status report only connected yes or no (commands.js:244 status); probe exists behind Settings › Test only (shell.js:340)
- **Notes:** GET only, queues nothing. Lets an agent follow the 'check /queue first' rule and see missing model files before a local run fails. Never take a URL or secret as an argument (the stored target only); recipeModelReport needs exposing through host.shell.

### `read_manual` (value medium, effort small: hours)

- **What:** Return the user manual (docs/MANUAL.md): whole, one chapter by slug or heading, or the chapters / paragraphs matching a query, as the node's MCP server offered its GUIDE.md resource.
- **Where a user reaches it today:** Help › Scumble help (F1), the Help panel and its search field
- **Anchor:** electron/preload.js:230 (help.manual) -> electron/main/main.js:548; renderer/help/manual.js:79 (parseManual), :204 (chapterText); search as renderer/help.js:115
- **Params:** chapter (slug or title), query; none = the table of contents
- **Evidence:** No command or MCP resource carries the manual (server.js has none; the node offered inpaint-canvas://guide); the renderer can read it via window.scumble.help.manual() (electron/preload.js:230 -> main.js:548 readManual) and parse it with renderer/help/manual.js:79 parseManual / :204 chapterText
- **Notes:** 98 KB, 20 chapters: never return the whole file by default. help.js's searchManual reads module state loaded at :380, so the command parses on its own. Read-only, policy AUTO. An MCP resource in server.js would miss the in-app assistant.

### `read_pixels` (value medium, effort small: hours)

- **What:** Return the RGBA / hex value at a point or the values of a small box of the visible picture or one layer, and / or a 256-bin per-channel histogram with mean, min and max of a box or the selection (sampled at a scale for large pictures); optionally make the point's colour the paint colour.
- **Where a user reaches it today:** Toolbar Eyedropper (I) / Alt+click with the brush (one pixel into the paint colour); the sample plugin's colour probe tool (K)
- **Anchor:** renderer/editor/inpaint_canvas.js:7258 sampleRegionSettled(source image|layer, box, scale); :9726 pickColor
- **Params:** x,y or box [x,y,w,h], source image|layer, histogram (bool), scale
- **Evidence:** sample.mean_color (plugins/sample/main.js:129) gives only the mean of the selection or the whole picture (a 1 px read needs select_rect first, an extra selection undo step); screenshot is lossy JPEG
- **Notes:** Read-only; cap the box (return values for small boxes, stats for larger). Useful to match a text or fill colour to the picture exactly. Light tier, AUTO. A core command rather than the sample plugin, which is a template.

### `select_color` (value medium, effort small: hours)

- **What:** Magic wand / colour range: select the area of similar colour at x, y (tolerance 0..255, contiguous on or off, sample image or layer) with replace, add or subtract.
- **Where a user reaches it today:** Toolbar Select group › Magic wand (W) + options bar Tolerance / Contiguous / Sample (renderer/editor/inpaint_modal.js:257)
- **Anchor:** renderer/editor/inpaint_canvas.js:7306 wandSelect; options ed.fillOpts (:2203)
- **Params:** x, y, tolerance 0..255, contiguous, sample image|layer, mode
- **Evidence:** renderer/editor/inpaint_canvas.js:7306 wandSelect(ix, iy, mode) takes image coordinates, no pointer; no command calls it (select_point needs SAM2, select_by_text needs ComfyUI)
- **Notes:** Set fillOpts for the call and restore it. Works offline with no model (unlike select_point / select_by_text): useful for flat backgrounds, skies, studio walls. Named missing in PLAN_ASSISTANT §9. Policy AUTO.

### `select_shape` (value medium, effort small: hours)

- **What:** Select an ellipse (x, y, w, h) or a polygon / lasso (a list of points) with replace, add or subtract, optionally feathered, without sending a full-size mask.
- **Where a user reaches it today:** Toolbar Select group › Ellipse (Shift+R), Lasso (L), Polygon (Shift+L) (renderer/editor/inpaint_modal.js:250-253)
- **Anchor:** renderer/editor/inpaint_canvas.js:5863 closePolygon (set ed.polyPoints / ed.polyMode), :6217 applyShapeToSelection(shape, mode, box, at, label)
- **Params:** shape ellipse|polygon, x,y,w,h or points [[x,y]...], mode, feather?
- **Evidence:** only select_rect, select_mask (image-sized array or base64 PNG) exist; polygon has a programmatic path (polyPoints + closePolygon), the ellipse is inline in onPointerUp (inpaint_canvas.js:5739-5757) but applyShapeToSelection takes any drawn canvas
- **Notes:** Ellipse: draw it on a box-sized canvas in commands.js and pass it with `at`; no editor edit. One selection undo step. Saves agents a full-size mask upload. Named missing in PLAN_ASSISTANT §9 (lasso and ellipse selections). Policy AUTO.

### `set_api_size` (value medium, effort small: hours)

- **What:** Set the Highres fix for API runs (max, x2, x4, target, crop): how far the crop is pushed up before it goes to a provider; best as an `api_size` param on set_node_params, also reported in status.
- **Where a user reaches it today:** Generate tab › Generate section › 'Highres fix' select under Padding / Target / Feather / Multiple
- **Anchor:** renderer/editor/host.js:426 setApiSize(mode)
- **Params:** api_size max|x2|x4|target|crop on set_node_params; report it there and in status
- **Evidence:** host.setApiSize (host.js:426, API_SIZES :50) is only wired to the Highres fix select (host.js:2212); set_node_params (commands.js:653) has no api_size
- **Notes:** Persistent and app-wide (every tab, every later API run), changes resolution and the bill: report it in the answer and ASK in the assistant policy.

### `set_crop_fix` (value medium, effort small: hours)

- **What:** Fix set_crop's schema and checks: colorMatch, withOriginal and align as booleans; fill (none / neutral / blur / border / green), extendFill (stretch edges / average color / grey / green / black / noise) and paste (selection / crop) as enums; context and feather take auto or manual (pixels come from set_node_params); validate instead of storing raw values; say that extend_canvas takes its fill from extendFill.
- **Where a user reaches it today:** Generate tab › Crop section (Context, Feather, Paste, Fill, Original, Color match, Align) (renderer/editor/inpaint_modal.js:944, :664)
- **Anchor:** renderer/commands.js:642 (set_crop); CROP_DEFAULTS renderer/editor/inpaint_canvas.js:921; UI values renderer/editor/inpaint_modal.js:922-931, :942-955, :664
- **Params:** context: auto|manual|<px -> host.setNodeParam('padding')>, feather: auto|manual|<px -> feather node param>, fill: none|neutral|blur|border|green, colorMatch: boolean, extendFill: stretch edges|average color|grey|green|black|noise, withOriginal: boolean, align: boolean, paste: selection|crop
- **Evidence:** renderer/commands.js:644 types colorMatch and align as strings and :647 stores any value raw; renderer/editor/stitch.js:443-445 reads align: cs.align !== false and color_match: !!cs.colorMatch, so "false" keeps both on; fill/extendFill/paste are unchecked; cropRect (inpaint_canvas.js:14357) treats any non-"auto" context as manual and takes pixels from the padding widget, so context "200" ignores the number
- **Notes:** A fix of an existing command, not a new tool. Keep accepting the whole object set_crop/status return (commands_test.py:676 passes crop0 back) and the strings "true"/"false". document_test.py:208 sets context "64" / feather "12" and old .scumble files store such strings: cropRect must keep reading any non-auto value as manual. Say in the description that extend_canvas takes its fill from extendFill (inpaint_canvas.js:11035 via syncCropControls :14377).

### `set_filter_preset_fix` (value medium, effort small: hours)

- **What:** Make add_filter / set_filter apply a preset's values the way the UI does when params.preset is given (grain 'Film' presets, B&W colour filters), push the filter undo step the UI pushes, and list option labels and groups in filter_types.
- **Where a user reaches it today:** Image tab › layer list › filter layer row › 'Film' / preset select
- **Anchor:** renderer/commands.js:1322 (applyParams), :1027 (set_filter), :1008 (filter_types)
- **Params:** unchanged; params.preset applied first (its fields), explicit params after; filter_types options as {id,label,group}
- **Evidence:** applyParams (renderer/commands.js:1328-1331) sets only the select key; the UI (inpaint_canvas.js:15362-15372) also copies the preset's fields (GRAIN_PRESETS inpaint_filters.js:55 carry amount/size/speckle/chroma/look; film.bw BW_FILTERS plugins/film/looks.js:60 carry filter_hue/filter_strength), resets look and renames the layer, and pushes a filter undo step; set_filter pushes none (only setFilterType :12300 does), and shell.js:2669-2682 adds one only for the assistant's meta.turn
- **Notes:** Fix, not a new tool. Today an external undo after set_filter undoes the step before it. Once set_filter pushes its own {kind:'filter'} step, electron/main/assistant/policy.js:356 (undoStep returns 'filter' for set_filter) must return null or the assistant gets two steps. film.apply_look (plugins/film/main.js:32) already covers film.look stocks, whose options carry no fields. The same missing-undo gap exists for external set_layer soft fields and set_text (policy.js:358-365 covers them for the assistant only): worth its own item.

### `get_recipe` (value low, effort small: hours)

- **What:** One recipe in full: its API-format graph, settings rows, needed node types, saved workflow (on request) and its provider variants (model, fields, limits, text route, factor), so an agent can inspect it, or change it and re-import it.
- **Where a user reaches it today:** Settings › Recipes (name and meta only); View › Edit Recipe in ComfyUI shows the graph visually
- **Anchor:** renderer/shell.js:285 host.shell.recipes() / resolveRecipe
- **Params:** id, workflow (default false)
- **Evidence:** list_recipes (commands.js:434) is a summary; host.shell.recipes() (shell.js:285) already holds each recipe's prompt, settings, providers and workflow
- **Notes:** Read-only. Mainly useful together with import_recipe (read, change, re-import) or to explain why a run behaves as it does; return the UI workflow only on request (large).

### `reopen_closed_tab` (value low, effort small: hours)

- **What:** Bring back the most recently closed tab of this session, layers and file link included (close_document's own description already points at this).
- **Where a user reaches it today:** File › Reopen Closed Tab (Ctrl+Shift+T)
- **Anchor:** renderer/editor/host.js:2584 (host.reopenClosed); shell wrapper renderer/shell.js:258
- **Params:** none (scope app); returns docSummary or {reopened: null}
- **Evidence:** close_document's own description (renderer/commands.js:430) points the agent at File › Reopen Closed Tab, which no command reaches; host.reopenClosed (renderer/editor/host.js:2584) is pointer-free and returns the editor
- **Notes:** Survives only as the undo of the agent's own close_document (otherwise irreversible for an agent without a .scumble file). Session-only list (host.closed). Not destructive: policy AUTO.

### `text_spacing` (value low, effort small: hours)

- **What:** Add letter_spacing (image pixels) and line_height (multiple of the size) to add_text and set_text, and report them (with outline) in the layer summary.
- **Where a user reaches it today:** Text layer row › Line height and Letter spacing number fields
- **Anchor:** renderer/commands.js:1041 add_text, :1067 set_text, :60 layerSummary
- **Params:** line_height 0.5..4, letter_spacing -50..200 (image px)
- **Evidence:** t.lineHeight / t.letterSpacing exist (inpaint_canvas.js:13713-13719, used in rendering :4181) but add_text / set_text (commands.js:1041, :1067) do not take them
- **Notes:** Two params and the summary; multi-line text layout is otherwise not controllable. Trivial, so worth folding into the next text change.

## Covered already (verdict already_exists)

- `remove_area`: recipes/lama_remove.json:1 ('LaMa remove (in-app)', provider inapp, no key, no server, fills the selection from its surroundings); select_recipe id lama_remove + select_rect/select_mask/select_point + generate runs it as a result layer
- `fill_selection`: add_filter type fill (params color) + set_mask op from_selection (commands.js:1013, :985); on a mask in edit mode, set_mask from_selection is the same reveal
- `clear_selected_pixels`: set_mask op hide_selection (non-destructive) and op apply to bake it (commands.js:985; inpaint_canvas.js:12722 maskFromSelection)
- `gradient_on_layer`: add_filter type gradient (shape linear/reflected/radial, from, to, from_opacity, to_opacity, angle, scale, x, y) + set_mask from_selection (commands.js:1013, COMMANDS.md add_filter)
- `move_reference`: move_layer with delta (commands.js:907) moves a reference past the next reference in the stack, which is what moveReference does (inpaint_canvas.js:3735 reorderLayer past the next reference); set_prompt refs pins tokens to layer ids
- `crop_canvas`: extend_canvas with negative values calls ed.cropCanvas (renderer/commands.js:1146); straighten_canvas with angle 0 and x/y/width/height or aspect crops without a turn (commands.js:1176-1196, straightenDocumentNow inpaint_canvas.js:4720-4727)

## No editor feature behind it (verdict no_editor_feature)

- `gradient_mask`: Write a linear or radial gradient into a layer's mask (from, to), for blending a composite into the picture. Approximation today: select_rect + select_feather (large radius) + set_mask from_selection. New code would live in the shared editor.
- `copy_layers_to_document`: Copy layers, filter and fill layers with their parameters, LUT and masks from one tab into another (a look built once, applied to a batch). Only masks and LUT data are missing from the replay path; new logic, not worth it now.
- `export_print_options`: Write a resolution (dpi) into TIFF / PNG / JPEG / PSD exports and optionally an sRGB ICC profile. Export writer change in renderer/editor (Full test tier), not an MCP-only change.

## Judged of low value for agents (verdict low_value), names only

`add_language_model`, `bucket_fill`, `cancel_document_job`, `canvas_only`, `check_updates`, `clear_undo`, `cloud_copy_recipe`, `compare_options`, `connect_comfy`, `cutout_layer_backend`, `download_helper`, `film.preview_looks`, `film.set_point`, `filter_types_param_shapes`, `free_memory`, `import_brush_tips`, `import_prompt_template`, `layer_bounds`, `liquify_stroke`, `list_earlier_states`, `list_helpers`, `list_objects`, `list_open_dialogs`, `list_recent_documents`, `list_results`, `merge_layers`, `move_selection`, `open_comfyui`, `open_settings`, `plugin_tool_event`, `provider_balance`, `prune_files`, `quit_app`, `reload_plugins`, `reload_recipes`, `reload_window`, `remove_group`, `remove_recipe`, `retouch_stroke`, `saved_selections`, `select_by_text_options`, `set_brush_color`, `set_helpers`, `set_llm_endpoint`, `set_memory_limits`, `set_plugin_enabled`, `set_reference_fit`, `set_skin`, `set_tile_engine`, `set_tool`, `set_upsample`, `set_view`, `solo_layers`, `upsample_text`.

Their reasons are in the workflow's journal of 2026-10-04 (run `wf_d14472a5-492`); a pick from them is possible.
