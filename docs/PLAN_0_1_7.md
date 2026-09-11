# Plan after 0.1.6: template upload, console, draw_shape, liquify, Python plugins, custom brushes

Written 2026-09-11 with DenRakEiw, for the sessions after this one. Read `CLAUDE.md` first.
The five items are in the order they should be worked; 1 to 3 are one release (**0.1.7**),
4 and 5 the next one (**0.1.8**). Every item names the files it touches and the gate that
proves it, so none of them needs this conversation to be understood.

**Done on 2026-09-11**: both repos are pushed and 0.1.6 is released (v0.1.6, published
10:48 UTC). The next release needs the version bump in `package.json` and its own
`CHANGELOG.md` section before the tag.

**Closed on 2026-09-11**: the "Generate a new image" dialog no longer grows a scrollbar and no
longer clips the Upsample button. The user confirmed it works; it is off the list.

---

## 1. Load a prompt template (.md) straight from the dialog

### Why

The Markdown prompt templates shipped in 0.1.5 can only be imported in Settings › Prompts,
three clicks away from where they are used. The user asked for a load button **under the
template dropdown** in "Generate a new image" ("upload skill .md"), with the short
description of the loaded file visible. This is also the answer to the open complaint from
2026-09-10 that "the .md support has to be solved differently": it is not the format that is
wrong, it is where the upload lives.

### Design

Everything needed already exists: `prompts.importFile(path)` in `electron/main/prompts.js`
copies a `.md` into `<userData>/prompts/` and returns `{ id, path }`, the IPC `prompts:import`
opens the file dialog, and `host.refreshPromptTemplates()` re-reads the list.

- **`renderer/index.html`** (line 148, the row with `#gen-template`): a button
  `#gen-template-add` right after the select, title "Load a prompt template (.md)". Keep the
  row able to shrink - that row was the one that grew the scrollbar.
- **`renderer/shell.js`**: `ui.genTemplateAdd`, a click handler that calls
  `window.scumble.prompts.import()`, then `await host.refreshPromptTemplates()`,
  `genFillTemplates()`, selects the imported id and calls `genSyncTemplateNote()` so the
  description appears under the dropdown at once. On an error, put the message into
  `#gen-template-note` with the same `Error invoking remote method` prefix stripped as
  `ui.promptImport` does (`shell.js` line 863).
- **The description**: `genSyncTemplateNote()` already shows `t.description`. A template whose
  front matter has no `description` should fall back to "no description in the file" rather
  than an empty line, so the user sees that the import worked.
- The Settings › Prompts row stays as it is; both paths use the same importer.
- Optional, ask first: the same button in the editor's Prompt section, where the upsample
  runs for an edit. It has a use-case select today, not a template select, so it is a bigger
  change than it looks.

### Gate

`prompts:import` takes an optional `path` in `electron/main/main.js` (line 415): with one, skip
the dialog and call `importFile(path)` directly. Then `tools/generate_test.py` gets a step that
writes a small `.md` into the scratch folder, imports it through the IPC, and asserts it appears
in `#gen-template`, is selected, and that its description is under the dropdown. Remove it again
with `prompts:remove`.

Estimate: 1 hour.

---

## 2. `draw_shape`: the shape tool over MCP

### Why

The shape tool landed on 2026-09-11 (rectangle, ellipse, polygon, polyline, Bezier, freehand,
`CLAUDE.md`). An agent cannot reach it: `renderer/commands.js` has no command for it, so the
MCP tool list has none either. Everything else the editor can do is scriptable; this is the one
gap.

### Design

- **Node repo first** (`js/inpaint_canvas.js`, then `python tools/sync_editor.py`): pull the
  drawing out of `finishShape()` into one method

  ```
  drawShape({ kind, points, x, y, w, h, fill, fillColor, stroke, strokeColor, width, radius, layer })
  ```

  which resolves the layer with `shapeTarget()`, builds the path (the dragged kinds from
  `x, y, w, h`, the clicked kinds from `points`), and goes through `paintShape()` +
  `commitStroke()` + `markLayerChanged()` exactly as the tool does today. `finishShape()` then
  becomes a caller, so the tool and the command cannot drift apart.
- **`renderer/commands.js`**: `draw_shape`, `needsImage: true`, `scope: "doc"`, params
  `kind` (enum, default rectangle), `points` (array of `[x, y]` for polygon / polyline /
  bezier / freehand), `x` `y` `width` `height` (for rectangle / ellipse), `fill` (bool,
  default true), `color` (fill colour, default the editor's), `stroke` (bool), `stroke_color`,
  `stroke_width` (default 4), `radius`, `layer` (`P.layer()`, default the active one). It
  returns the layer and the bounding box it drew into.
- A Bezier point may carry its handle: accept `[x, y]` or `[x, y, hx, hy]` in `points`, which
  is what `shapePointPath()` already reads.
- Regenerate `docs/COMMANDS.md` with `python tools/commands_doc.py`; the MCP server builds its
  tool list from `describe()`, so `draw_shape` appears by itself (`tools/list_changed` is only
  needed for plugin commands).

### Gate

A step in `tools/shape_test.py`: draw a rectangle and a polygon through `commands.run`, read the
pixels back the way the other steps do, and check that one command is one undo step.

Estimate: 1 to 2 hours.

---

## 3. A console in the app, and a log file

### Why

Asked for on 2026-09-11 after a Comfy Cloud run with GPT Image failed and there was nowhere to
look. Today an error reaches `editor.setStatus()` only; `.ipc-status` is `white-space:nowrap;
overflow:hidden; text-overflow:ellipsis` with no `title`, so a long adapter message is cut off
on screen. The full text lives only in the renderer DevTools console, and the **main process**,
where every provider adapter, the ONNX runtime, the mirror and the MCP bridge run, logs nowhere
at all: a packaged Windows GUI exe shows no stdout, even when started from a terminal.

### Design

**`electron/main/log.js`** (new), the single place both processes write to:

- `record({ level, source, message, detail })` with `level` of `info | warn | error`, `source`
  a short tag (`main`, `renderer`, `fal`, `comfycloud`, `onnx`, `mcp`, `update`).
- A ring buffer of the last 2000 entries for the panel, and an append to
  `<userData>/logs/scumble.log`. Rotate at 1 MB into `scumble.1.log`, keep two files. Write
  with a queue, never synchronously on the main thread.
- Patch `console.log / warn / error` in the main process so existing calls (`main.js` line 125,
  348, 472, 548 and the adapters' `ctx.log`, `providers/index.js` line 67) land in it without
  being rewritten.
- `process.on("uncaughtException")` and `process.on("unhandledRejection")` record an `error`
  entry before anything else happens.
- Entries carry a monotonic id so the panel can ask for "everything after N".

**IPC** (`main.js` + `electron/preload.js`): `log:add` (renderer to main), `log:list({ after })`,
`log:clear`, `log:open` (the folder, `shell.openPath`), and an event `log:entry` pushed to the
window so an open panel grows live.

**Renderer capture** (`renderer/shell.js`, early in its start): wrap `console.warn` and
`console.error`, add `window.addEventListener("error")` and `"unhandledrejection"`, and forward
to `log:add` with source `renderer`. Keep the original console call so DevTools still works.

**The panel**: a `<dialog id="log-dialog">` next to the Settings dialog in `renderer/index.html`,
with a level filter, a text filter, **Copy all**, **Open folder**, **Clear**, and a line per
entry (time, level, source, message; the detail folded out on click). Opened from **Help ›
Console**, from `Ctrl+Shift+L`, and from a click on the status line.

**The status line** stays as it is in the synced editor. The app hooks it from outside, in
`host.editorBuilt(editor)`, the same place the export Size row is built:

```
const orig = editor.setStatus.bind(editor);
editor.setStatus = (t) => { orig(t); if (editor.statusEl) editor.statusEl.title = t; };
```

plus a click listener on `editor.statusEl` that opens the panel. **No new sync patch** - that is
the point of doing it this way.

**Adapters**: in `electron/main/providers/index.js` the `catch` around an adapter call records an
`error` entry with the provider id, the model and the request shape (never the key, never the
image bytes) and then rethrows unchanged, so the status line keeps the short message and the
console holds the whole thing.

### Gate

`tools/log_test.py` (new): write an entry from the renderer (`console.error` in the page) and one
from the main process (an IPC that calls `record`), read both back through `log:list`, check the
file under `<userData>/logs` exists and holds them, check the rotation by writing past 1 MB, and
check that the panel opens and filters. `commands_test.py` must stay green - the wrapped console
must not swallow anything.

Estimate: half a day.

---

## 4. A liquify brush

### Why

The comparison with other painting programs' toolboxes on 2026-09-11 left exactly one gap
after the shape tool: the transform tool has scale, rotate, distort (a free four-corner
perspective) and warp (a grid), but no free-form push of pixels. It is the tool for a face, a fold in cloth, a horizon.

### Design

A fifth mode in the transform tool, next to the four in `subModeButtons`
(`js/inpaint_canvas.js` line 1797, node repo, then sync).

- **The field.** A displacement field over the active layer's box, `Float32Array(2 * gw * gh)`,
  the grid at most 512 on the long side (a smooth field needs no more, and it keeps the memory
  and the upload small). Sampled bilinearly; `[0, 0]` everywhere means untouched.
- **The brushes**, buttons in the sub-bar: **Push** (add the pointer delta), **Grow** and
  **Shrink** (add or subtract the radial vector), **Swirl left / right** (the perpendicular),
  **Restore** (fade the field back to zero). Size and Strength come from the existing brush
  controls (`moveCtl` in `buildOptsBar`).
- **A dab** walks the grid nodes inside the radius and adds `strength * falloff(d / r) * v`
  with a smoothstep falloff. That is a few hundred nodes per dab whatever the image size, so it
  stays interactive on a 96 MP document, which a per-pixel approach would not.
- **The preview** resamples the layer through the field. GPU: a pass in
  `renderer/editor/inpaint_filters_gl.js` that uploads the field as a texture (RG16F, or RGBA8
  with a scale factor when the extension is missing) and samples the source at
  `uv + displacement`. CPU twin in `js/inpaint_worker.js` for the fallback, bilinear, so the two
  paths can be compared the way `composite_test.py` compares the compositor.
- **Applying** follows the other modes: `startPending("liquify")` while dabbing, the sub-bar
  shows Apply / Cancel, Enter writes the resampled pixels into the layer canvas and Escape drops
  the field. One undo step per *pending gesture*, not per dab: `pushUndoSnapshot` of the layer
  box before the first dab.
- Only the active layer, like every other transform mode. A filter or text layer refuses with
  the message those modes already use.

### Gate

`tools/liquify_test.py` (new): put a hard edge into a layer, push a dab across it and check the
edge moved by about the expected number of pixels and that the area outside the radius is
untouched; grow and shrink move a ring the right way; Escape leaves the pixels alone; Enter is
one undo step. Plus a GPU-against-CPU comparison in one run, tolerance a couple of levels.
`composite_test.py` and `perf_test.py` afterwards, because this touches drawing.

Estimate: one day.

---

## 5. Python plugins

### Why

`docs/BRIEF.md` §5 has had "Python plugins (stdio process) later, not now" since phase 4. The
JavaScript plugin system carries the film pack and the sample plugin; what Python adds is the
ecosystem: numpy, OpenCV, scikit-image, and the scripts users already have for ComfyUI.

### Design

Deliberately **not** a second plugin system. A Python plugin is the same folder with the same
`plugin.json`, plus `"runtime": "python"` and `"entry": "main.py"`.

- **`electron/main/pyplugins.js`** (new): spawns the interpreter (`settings.plugins.python`, else
  `py` on Windows / `python3` elsewhere; the resolved path and the version go into Settings ›
  Plugins), and speaks **NDJSON over stdio** in the shape `electron/main/bridge.js` already uses
  for the MCP bridge: `{ id, method, params }` out, `{ id, result }` or `{ id, error }` back.
  One process per plugin, killed when the plugin is disabled or reloaded.
- **`plugins/_python/scumble.py`**, shipped with the app: the client the plugin imports. It
  offers `@command(name, description, params)` and `@action(label)` decorators for registering,
  and `scumble.run("select_rect", x=..., y=...)` for calling **any of the 63 commands** back,
  which is what makes it useful without a second API surface.
- **Extension points in v1: commands and menu actions only.** No panels (there is no DOM over
  stdio) and no per-frame filters: a filter would mean a full image over the pipe per preview.
  A pixel round trip for a *one-off* filter (base64 PNG in, PNG out, no live slider) can come
  later if someone asks; write it down as the known limit instead of half-building it.
- **The handshake**: the app sends `{ method: "activate" }`, the plugin answers with its
  registrations, and `renderer/plugins.js` registers them as ordinary plugin commands and
  actions whose implementation forwards through main to the process. Everything that already
  tracks a plugin's registrations and removes them on disable keeps working unchanged.
- **Failure**: a call gets a timeout (30 s, per call), a crashed process is restarted once, and a
  second crash disables the plugin with the reason in Settings › Plugins. The process's stderr
  goes into the console from item 3 with the plugin id as the source - which is why this comes
  after it.
- Security: the same trust as a JavaScript plugin, which is "it runs as you". Say so in
  `docs/PLUGINS.md`; a plugin folder is not a sandbox.

### Gate

`plugins/sample_py/` (new, shipped like `plugins/sample`): registers one command that reads the
layer list through `scumble.run("list_layers")` and one menu action. `tools/pyplugin_test.py`
starts it, calls the command through the command core, checks the answer, kills the process and
checks the registrations are gone. Skips itself with a clear message when no interpreter is
found, so the gate does not fail on a machine without Python.

Estimate: two days.

---

## 6. Custom brushes: users add their own tips from .abr files

Asked for on 2026-09-11 (after the 0.1.8 release): "custom Pinsel, User können ihre eigenen
Pinsel hinzufügen, also ABR-Dateien".

### Why

The round dab is the only brush. Painters have libraries of Photoshop `.abr` packs (and
GIMP `.gbr` / `.gih`, Krita `.kpp` bundles) and expect to load them; a textured tip is what
makes retouch on a result layer look painted rather than stamped.

### Where it stands

**The core is built and committed, and marked unverified** (2026-09-11, `js/inpaint_brushes.js`
in the node repo, synced; `CLAUDE.md` "Built but not verified"). `readAbr()` reads versions 1
and 2 (a flat list) and 6 and 10 (the `8BIM` `samp` block, PackBits per row, computed round
tips skipped), after GIMP's `gimpbrush-load.c` and scurest/abrupng, both GPL-3.0. The brush
stamps a tip instead of the round dab with the file's own spacing (`stampDab`), and the tool
options bar has a *Tip* select plus *Import* (`.abr`, `.png`, `.jpg`, `.webp`; a `.abr` adds
every tip it holds). **Proven only on a synthetic version 1 file.** So this item is not "build
the feature" but "finish it":

### Design

- **Verify against real packs first.** Get two or three `.abr` files (a version 6 pack with
  sampled tips, a version 10 one, an old version 1 or 2) and check size, spacing, alpha
  polarity and the tip count against GIMP's reading of the same file. Fix the reader where
  it disagrees. Computed (parametric) tips are skipped by design; say so in the status line
  ("12 tips imported, 3 computed tips skipped").
- **Persistence.** Imported tips are lost at restart today. Store them under
  `<userData>/brushes/<id>.png` plus a `brushes.json` (name, spacing, source file) through
  a new IPC (`brushes:list|save|remove`), load them at editor start (`host.brushTips()`), and
  give the select a *Remove* next to *Import*. The node keeps its in-memory list (no file
  system there); the app patch goes through `tools/sync_editor.py`.
- **Stroke quality.** Spacing as a slider (default from the file), a *Rotate to stroke
  direction* tick, size jitter and angle jitter later; the Photoshop dynamics beyond that are
  out of scope. The stamp must honour hardness = off (a tip has its own edge), opacity and
  pressure like the round dab, and the eraser must be able to use a tip too.
- **Preview.** A 48 px thumbnail of the tip next to the select, and the brush ring drawn as
  the tip's bounding box when a tip is active, so the user sees what will land.
- **Formats after `.abr`**: GIMP `.gbr` (trivial header + raw bytes) and `.gih` (an image
  hose, first frame only), Krita `.kpp` (a PNG with the preset in a text chunk, tip only).
  Only if asked.
- **MCP**: `list_brush_tips` and `set_brush({ tip, size, hardness, spacing })`, so an agent can
  pick a tip; `paint_stroke` does not exist yet and is not part of this item.

### Gate

`python tools/brush_test.py`: the reader on the stored sample files (`tools/refs/brushes/`,
one per version, small, licence-checked), a stamped stroke's coverage against the round dab
on the same path, persistence across a `location.reload()`, and one erase with a tip.
Estimate: half a day for verify + persistence, another half for the stroke quality points.

## Order and releases

| # | Item | Estimate | Release |
|---|---|---|---|
| 1 | Template upload in the dialog | 1 h | 0.1.7 |
| 2 | `draw_shape` | 1-2 h | 0.1.7 |
| 3 | Console and log file | half a day | 0.1.7 |
| 4 | Liquify | 1 day | 0.1.8 |
| 5 | Python plugins | 2 days | 0.1.8 |
| 6 | Custom brushes from .abr, verified and persistent | 1 day | 0.1.9 |

Items 4 and 5 both touch the node repo or the plugin core; 3 must land before 5, because the
Python process's stderr has nowhere to go until it exists.

## What stays open after these five

Not part of this plan, still on the list in `CLAUDE.md` and in the memory file
`scumble-feature-ideas`:

- **No provider adapter has ever run against a live API**, now eight models over up to five
  providers. The largest untested surface in the app.
- **The size ceilings** of Nano Banana, Qwen, Z-Image, Ideogram, Grok and Reve sit at the
  conservative default of 2048; only FLUX, GPT Image and Seedream are sourced.
- **The output resolution defaults to 1K** on most providers although 2K and 4K are offered.
  The user was asked on 2026-09-11 and has not decided; the recommendation is 2K, to match the
  crop the app now sends.
- Export: canvas size, 8-bit PNG, a resampling choice.
- Linux build, code signing through the SignPath Foundation, the first real RunPod pod, a
  website.
- Layer tiles above 16384 px a side, and the full-resolution GPU path.
- The two decisions in `docs/NEXT_PLAN.md` §4: the blur as a shader pass (recommendation: no)
  and the editor source moving into this repo (recommendation: yes, and overdue).
