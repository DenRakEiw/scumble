# Plugins

A plugin is a folder with a `plugin.json` and a JavaScript module. Scumble loads it at start
(and on *Reload plugins*) and hands its `activate(scumble)` function one API object. With it
the plugin reads and writes documents, runs the command core, and registers the four
extension points: **filter types**, **side panels**, **menu actions** and **tools**, plus its
own commands. Everything a plugin registers is tracked, so disabling it in *Settings ›
Plugins* or reloading takes all of it out again without a restart. Only JavaScript for now
(Python plugins as a stdio process come later, see `docs/BRIEF.md` §5).

Folders:

- `<userData>/plugins/<id>/` — the user's plugins (`%APPDATA%/Scumble/plugins` on Windows;
  *Settings › Plugins › Open folder*, or the *Plugins* menu).
- `<app>/plugins/<id>/` — built-in plugins shipped with the app (`plugins/sample` is the
  reference: one of every extension point, ~150 lines).

A user plugin with the same folder name as a built-in one replaces it. The folder name is the
plugin id (letters, digits, `-`, `_`); every registered thing is prefixed with it
(`sample.posterize`, `sample.probe`), so plugins cannot collide.

## plugin.json

```json
{
  "name": "Sample plugin",
  "version": "1.0.0",
  "description": "one line for the Settings list",
  "author": "you",
  "homepage": "https://...",
  "entry": "main.js",
  "registers": ["filter", "panel", "action", "tool", "command"],
  "enabledByDefault": true
}
```

`entry` (default `main.js`) is an ES module inside the folder. `registers` is informational,
with one exception: `"registers": ["skin"]` makes the folder a **skin**, a stylesheet and no
module (no `entry`), chosen under *Settings › Appearance* instead of enabled here
(docs/SKINS.md). `enabledByDefault: false` ships a plugin switched off. The enabled state lives
in `settings.json` (`plugins.enabled` / `plugins.disabled`).

## The module

```js
export function activate(scumble) {
    scumble.filters.register({ ... });
    scumble.log("loaded");           // console, prefixed with the plugin id
}
export function deactivate() {}     // optional: before unload / reload
```

The module is loaded from `scumble://app/plugins/<id>/<entry>` (same origin as the app, so
`fetch(scumble.url("lut.cube"))` and `<img src>` of the plugin's own files work). Relative
imports inside the plugin folder work too. Errors thrown in `activate` show up in *Settings ›
Plugins* with the stack; errors thrown later in callbacks land in the status bar and the list.

## The `scumble` object

| member | what |
|---|---|
| `version` | API version, `2` (2 added `documents.data`; a plugin that needs it checks `scumble.version >= 2`) |
| `id`, `name`, `manifest` | from `plugin.json` |
| `url(rel)` | URL of a file in the plugin folder |
| `log(...)`, `warn(...)` | console with the plugin id |
| `commands.run(name, args)` | the command core (`docs/COMMANDS.md`); throws on failure |
| `commands.call(name, args)` | never throws: `{ ok, result }` or `{ ok: false, error }` |
| `commands.list()` | every command with its parameter schema |
| `commands.register(name, def)` | add a command (see below) |
| `documents.active()` | the active tab as a `Document`, or `null` |
| `documents.all()`, `documents.byId(id)` | every tab / one tab |
| `filters.register(def)` / `unregister(id)` | filter types |
| `filters.apply(id, canvas, params, info)` / `filters.ids()` | run any filter type (built-in or plugin) on a canvas (or a layer's `px`, read as its canvas), GPU path when available: the film pack chains the built-in grain this way |
| `gl.shade(shader, canvas, values, info)` / `gl.available()` | one shader pass over a canvas (`shader = { code, uniforms, label }`, compiled once per object) for multi-pass filters; null without a GPU path; the source and `sampler2D` values may be a layer's `px` |
| `gl.toCanvas(v)` / `gl.isSurface(v)` | a GPU surface (what `gl.shade` hands back inside a filter chain) as a canvas, or a canvas unchanged; see "Staying on the GPU" |
| `panels.register(def)` / `unregister(id)` | side panels |
| `actions.register(def)` / `unregister(id)` / `run(id)` | Plugins menu entries |
| `tools.register(def)` / `unregister(id)` | tools in the tool column |
| `events.on(type, fn)` | `built`, `activate`, `changed`, `tool`, `removed`, `theme` (a skin was switched: `fn({ doc: null, skin })`, `skin` the id or `""`; read the tokens with `getComputedStyle(document.documentElement)`, docs/SKINS.md); `fn({ doc, ... })`; returns `off()` |
| `storage.get()` / `storage.set(patch)` | a small persistent object per plugin (`settings.json`): `get()` returns a copy synchronously (loaded before `activate`), `set(patch)` merges at once and writes through in the background |
| `documents.data(doc).get()` / `.set(patch)` | (API 2) a JSON object per plugin **and per document**: saved with the document in the session and in its `.scumble` file, where every file ref inside it (`{ filename, subfolder, type }`) is packed and comes back renamed if it had to be; `get()` returns a copy, `set(patch)` merges and marks the document changed. Data of a plugin that is off or missing rides along unchanged |
| `ui.status(text)` | the status bar of the active tab |
| `ui.el(tag, cls, text)`, `ui.icon(name)`, `ui.button(label, title, onClick)`, `ui.slider(label, {min, max, step, value, unit}, onChange)` | DOM helpers in the editor's style |
| `ui.confirm(text)` | a yes / no dialog |
| `makeCanvas(w, h)` | a canvas |
| `host` | the app's host object and raw editors: unstable, for what the API does not cover |

## `Document`

One tab. Pixel access is ImageData in and out; every write is one undo step.

| member | what |
|---|---|
| `id`, `name`, `width`, `height`, `loaded`, `active` | facts |
| `status(text)` | status bar |
| `run(name, args)` | a command on this document |
| `layers()`, `layer(key)`, `activeLayer()` | summaries: `{ id, name, kind, visible, opacity, blend, x, y, w, h, locked, mask, filter, params, text, ... }` |
| `rawLayer(key)` | the editor's layer object (`px`, `maskPx`, params ...); unstable, see "Layer pixels" below |
| `flatten({ maxSize, box, below, pad, exact, settled })` | the visible picture as a canvas at image size; `maxSize` (long side) or `box` (`[x0, y0, x1, y1]`) composite only that size or part, which a thumbnail or a colour sample should ask for. `below` (a layer key): the layers under that layer only, the picture a filter layer there takes as its input. `pad` (with `box`): the box is composited with that many pixels of its surroundings, so a filter that reads its neighbours sees them; the canvas is still the box (with `maxSize` the margin is rounded up to whole pixels of that canvas). `exact` (with `box`, no `maxSize`): the box's pixels as the full-resolution flatten has them (see "Reading a part of the picture" below). `settled` (with `maxSize` or `box`): **the call returns a promise** of the same canvas, with the mip levels it reads built in the app's worker instead of on your thread (see "A picture that does not freeze the window" below) |
| `getPixels()` | `{ data: ImageData, x: 0, y: 0, w, h }` of the flattened picture |
| `getPixels(layer)` | the layer's own pixels (unmasked) plus its placement `x, y, w, h` in image pixels; `w, h` differ from the ImageData size when the layer is scaled |
| `setPixels(layer, imageData, { undo = true })` | write a layer's pixels back (same size, or the pixels are replaced and the placement kept); filter and locked layers refuse |
| `addLayer(imageData \| canvas \| null, { name, x, y, w, h, activate })` | a new paint layer, placed at `x, y`; `null` = empty at image size; a canvas is adopted (do not draw into it afterwards) |
| `selection({ box })` | `{ mask: Uint8Array(width × height), bounds: {x, y, w, h}, width, height }` or `null`; with `box: true` the mask of the bounds only (`width` × `height` are the bounds' size, `x`, `y` where they sit). Only the bounds are read either way |
| `setSelection(mask, mode)` | from a `Uint8Array` (>0 = selected); `replace`, `add`, `subtract` |
| `undo()`, `redo()` | |
| `draw()` | repaint the canvas and overlays (no cache invalidation) |
| `setFilterParams(layer, patch, { preview })` | change a filter layer's params: `preview: true` during a drag (low-res, no undo step yet), the final call without it pushes one undo step |
| `refresh(layer?)` | after changes on raw layer objects: caches off, lists and canvas redrawn; with a layer, its pixels and mask are marked changed first (after writing through `rawLayer(layer).px` / `maskPx`) |
| `editor` | the raw editor (unstable) |

Layers are addressed like in the commands: id, exact name, a unique part of the name, or
`"active"`. The base image has no layer object of its own; to change it, duplicate it into a
layer (`run("duplicate_layer")` on the base is not possible, use `getPixels()` + `addLayer`)
or flatten.

### Reading a part of the picture (0.1.13)

A plugin that needs a few pixels of the picture should not flatten all of it: on a 15000 ×
10000 picture that is 150 million pixels, a full-resolution run of every filter layer, and in
tile mode a full-size display copy of every layer kept afterwards. `flatten({ box })` composites
the box only. Two things differ from the whole flatten inside a box, and the options handle them:

- **Filters that read their neighbours** (blur, sharpen, glow, halation, structure) see only
  the box. `pad` gives them its surroundings. `exact: true` pads by as far as the stack's
  filter layers say they reach (a filter's `reach`, below), so the box comes out as the whole
  flatten has it; when a filter does not say, or its result depends on the whole picture
  (vignette, normalise, the film look's halation, a frame or light leak), or a colour-matched
  layer is near the box, or a layer near it is drawn scaled or at a fractional position (a text
  layer is rendered at twice its size), it flattens the whole picture once (kept until the
  picture changes) and cuts the box out of it. Byte for byte on a stack of pixel-by-pixel
  layers; with a blur in the stack Skia's blur of the smaller canvas comes out 1 to 3 levels apart.
- **`below`** stops at a layer: the input of a filter layer there.

The built-in plugins do this: the film pack's control points read the 3 × 3 colour under a
point from `flatten({ box, below: <the points layer>, exact: true })`; the sample plugin's
`mean_color` and *Selection to new layer* read the selection's bounds with `exact: true`, and its
probe tool one 256 px square per square the cursor enters. `flatten()` without options and
`getPixels()` are unchanged: the whole picture at full resolution.

### A picture that does not freeze the window (0.1.15)

`flatten({ maxSize })` and `flatten({ box })` composite at a mip level of the layers. When a tile
has no level yet — which is every tile of a layer right after a flip, a turn, a filter, a fill, an
undo or a fresh result — that level is built where it is read. On a 15000 × 10000 picture that is
2,088 chains and **half a second in one task**: the window does not repaint, the cursor does not
move, and 185 MB of levels are left on the tiles afterwards.

**`settled: true` makes the call a promise** and has the app's worker build those levels instead:

```js
const flat = await scumble.doc.flatten({ maxSize: 192, settled: true });
```

Measured at 15000 × 10000, right after a flip: the main thread is held **46 ms instead of 700**,
and 33 MB of levels are kept instead of 221. The picture arrives about half a second later in wall
clock, and it is the same picture, byte for byte. Ask for it wherever you can await:

- the document may have changed by the time it resolves — check what you need again after the
  await, exactly as after any other one;
- if your panel guards itself with a `busy` flag, hold that flag **across** the await, or a second
  change will start a second render into the same canvases (the film looks panel does this);
- without the tile engine, at scale 1, and in a build with no worker the promise resolves with the
  same canvas the synchronous call would have given, so the option is always safe to pass.

The built-in plugins use it: the film looks panel's thumbnails and the GLB dialog's backdrop.

### Layer pixels (0.1.12)

A layer's pixels are no longer a canvas on the layer object: they are `layer.px`, a
`LayerPixels` (`renderer/editor/inpaint_pixels.js`), and a layer mask is `layer.maskPx`, a
`MaskPixels` (`null` when the layer has no mask). The tile engine (docs/PLAN_BCE.md, phase C)
puts tiles behind the same interface, so a plugin that goes through it keeps working then.

- **Unchanged**: `getPixels`, `setPixels`, `addLayer`, `selection()`, `setSelection`,
  `flatten`. A plugin that only uses the `Document` API needs no change.
- **`addLayer(canvas)` adopts the canvas**, as it always did: the canvas becomes the layer's
  pixels. Do not keep drawing into a canvas you handed over; with the tile engine it is copied
  in and later draws never reach the layer. Write through `setPixels` instead.
- **Deprecated, for one release**: `rawLayer(key).canvas`, `rawLayer(key).mask` and
  `doc.editor.selection` still answer with a canvas and log a warning once. A development build
  (the app run from its source) is strict and throws instead, so a leftover use shows up at
  once; start it with `SCUMBLE_STRICT=0` to get the warning instead. Their canvas is a read-only
  view: in the tile engine it is a copy, and a write into it is lost.
- **Instead**, if the `Document` API is not enough: `rawLayer(key).px` / `.maskPx` with
  `width`, `height`, `readRect(x, y, w, h)` (ImageData), `writeRect(imageData, x, y, op, alpha)`,
  `drawInto(rect, ctx => ...)` (Canvas 2D drawing clipped to `rect` = `[x0, y0, x1, y1]`, from a
  fresh context state; do not read `ctx.canvas`, and do not read pixels back from `ctx`
  (`getImageData`: with the tile engine `ctx` belongs to a scratch canvas of `rect`, so the read
  is shifted by the rect's origin; read through `readRect` before or after the callback instead).
  Keep the callback synchronous: with the tile engine the drawing is copied into the layer when
  the callback returns, so nothing drawn after an `await` arrives, and a callback that returns a
  promise throws on either backend. The transform `ctx` comes with maps the pixels'
  own coordinates and is not necessarily the identity: with the tile engine it is a translation
  onto a scratch canvas of `rect`. Compose on it with `scale`, `translate`, `rotate`,
  `transform` and `save` / `restore`; never call `setTransform` / `resetTransform`, and do not
  read `getTransform()` as absolute, or the drawing lands shifted. Inside the callback also do not
  call `putImageData` (it ignores the transform and the clip), `isPointInPath` /
  `isPointInStroke` (device coordinates), do not clip to anything but rectangles on whole pixels
  (the tile engine's scratch clips without anti-aliasing), and do not read or write the same
  pixels through `px` (it throws: a nested write would be overwritten, a read would not see what
  the callback drew); other pixels are fine),
  `drawTo(ctx, ...drawImage arguments)`,
  `bounds()` and `toCanvas()` (read-only). After writing, call `doc.refresh(key)` so the screen,
  the upload and the caches see it; unlike `setPixels` such a write has no undo step unless the
  plugin pushes one. The selection stays behind `selection()` / `setSelection()`. The pixels
  of a document all belong to one backend (tiles or one canvas each, `doc.editor.pixels`), so do
  not assign a `px` / `maskPx` of your own or one taken from another document: replace pixels
  with `setPixels` or `addLayer`, which make them in the document's backend.

## Filter types

```js
scumble.filters.register({
    id: "posterize",                      // -> "sample.posterize"
    label: "Posterize (sample)",
    params: [
        { key: "levels", label: "Levels", type: "number", min: 2, max: 32, step: 1, default: 6, unit: "" },
        { key: "mono", label: "Monochrome", type: "bool", default: false },
        // { key: "mode", type: "select", options: [{ id: "a", label: "A" }, "b"], default: "a", title: "tooltip" }
        // { key: "preset", type: "select", options: [{ id: "x", label: "X", amount: 3 }, { id: "custom", label: "Custom" }] }
        // { key: "curve", type: "custom", default: {...} }  with control(layer, param, callbacks) -> element
    ],
    apply(src, params, info) { ... return canvas; },   // CPU path, required
    glsl: {                                            // optional WebGL2 path
        uniforms: { u_levels: "float", u_mono: "bool" },    // float, int, bool, vec2, vec3, vec4, sampler2D
        values: (params, info, src) => ({ u_levels: params.levels, u_mono: !!params.mono }),
        code: `vec4 shade(vec4 c, vec2 uv) { ... }`,        // must define shade(); "filter" is reserved in GLSL
    },
});
```

A select param named `preset` is a preset list: picking an entry copies its other fields
(`amount: 3` above) into the params, renames the layer after it, and a drag on any slider
without `keepPreset: true` switches it back to the `custom` entry (so give it one). Any
other select (a mode, a style) just sets its value. `title` is the tooltip of a param.

The filter appears in the type list of every filter layer, works in `add_filter` /
`set_filter`, and is stored in documents by its full id. `apply(src, params, info)` gets a
canvas and returns a canvas of the same size (returning nothing keeps the input);
`info.scale` is 1 at full resolution and smaller for previews (shrink radii with it),
`info.seed` the layer's seed, `info.cache` an object that lives with the layer for reuse
between runs, `info.origin` where the input's top-left corner sits in the image, in the input's
own pixels (image coordinates times `info.scale`; `[0, 0]` for the whole picture). A pass over
a box, or the screen zoomed in, hands a filter a part of the picture: a filter that places
something in the image (a point, a field of grain) adds `info.origin` to its pixel coordinates
(`uv * u_size + origin` in GLSL, passed as a `vec2` uniform). `reach` (optional, 0.1.13): how many image pixels around a pixel (at full
resolution) the filter's result there reads, a number or a function of the params (and the picture's size, 0.1.17); 0 for a
filter that works pixel by pixel, left out when the result depends on the whole picture or its
size, or on where the input sits in it without `info.origin`. Readers of a box of the picture pad by it (`flatten({ box, exact: true })`), and a filter
without it makes them flatten the whole picture. The GLSL fragment gets `u_src` (the input; sample neighbours with
`uv + vec2(dx, dy) / u_size`), `u_size`, `u_scale`, `u_seed` and the declared uniforms, and
is compiled lazily on first use; when it fails to compile the CPU path runs and a warning
names the error in the console. `values(params, info, src)` also gets the source canvas.
A `sampler2D` uniform's value is a canvas, ImageData or image (uploaded as RGBA8, sample
it with the `uv` handed to `shade`), or `{ data, width, height }` with a Uint8ClampedArray
(RGBA8; a 256 × 1 table, say) or a Float32Array (RGBA32F, read with `texelFetch`); add
`linear: true` for bilinear filtering of 8-bit sources. Plugin samplers sit on texture
units 5 and up. `u_seed`, `u_size`, `u_pictureSize` and `u_pictureOrigin` are taken (do not
redeclare them), and `filter`, `half`, `sample` are reserved GLSL words.

**A filter that belongs to the whole picture (0.1.17).** A pass hands a filter a part of the
picture: the screen's region, a box a tool reads, a band of an export (an export is written in
bands of 256 rows and more, never from one canvas of the picture). A filter whose geometry is the
picture's (a vignette, a frame, a light leak) or that reads numbers of the whole picture must not
take them from its input, or every band gets a frame of its own:

- `info.full` is the whole picture's size in the input's pixels (`[w, h]`, the image size times
  `info.scale`) and `info.origin` where the input sits in it. In GLSL the same two are
  `u_pictureSize` and `u_pictureOrigin`, and `pictureUv(uv)` gives the position in the whole
  picture (0 to 1) for the `uv` handed to `shade`. Use those instead of `src.width` / `u_size`
  and `uv` for anything placed in the picture.
- `wholeStats: true` on the filter definition asks for `info.stats`: `{ mean, lo, hi }` per
  channel (the 1 % and 99 % levels) of the whole picture below the filter layer, the same numbers
  for every pass.
- `reach` may take the picture's size: `reach(params, { width, height })`. The film look's
  halation is a blur of 1.2 % of the picture's long side, so its reach is three sigma of that.

A filter that does this has a `reach` (0 for a vignette), a box of the picture is exact under
it, and a document with it is exported in bands. One that still depends on its input's size
leaves `reach` out; a document larger than any canvas (above 268 MP) is then exported as the
bands come out.

Filters that need more than one pass (a blur between two shader stages) skip the `glsl`
block and orchestrate in `apply`: blur with Canvas 2D, then `scumble.gl.shade(shader, canvas,
values, info)` with the blurred canvas as a `sampler2D` value, falling back to a pixel loop
when it returns null (or when `info.cpu` is set). `plugins/film/common.js` has the runner
and the shared maths; `docs/FILM.md` the filters built that way.

### Staying on the GPU (`chain`)

Every stage that goes through a canvas costs a synchronisation between the 2D canvas and
the GPU, about 0.6 to 1.0 ms whatever the size, and a filter with four stages paid eight of
them per frame. So the editor runs a **filter chain**: with `info.chain` set (it does that
for every filter layer at screen resolution) `gl.shade` and `scumble.filters.apply` hand
back a *surface* — a texture — instead of a canvas, and take one as input.

A filter opts in with `chain: true` in its definition, which is a promise about its
`apply`: it may be handed a surface instead of a canvas, so **anything in it that reads
pixels calls `scumble.gl.toCanvas(src)` first** (`drawImage`, `getImageData`, `ctx.filter`).
A surface has `width` and `height` and can be passed straight to the next `gl.shade`, to
`scumble.filters.apply` and as a `sampler2D` value. Without the flag the framework resolves
the input to a canvas before calling `apply`, which is always safe and always costs one
round trip. The film pack sets the flag and resolves inside `common.js` (`open`,
`copyCanvas`, `blur`), so its own filters never see the difference.

Do not hold on to a surface after `apply` returns: it goes back to the editor's pool. Keep both paths in agreement; `compareFilterPaths` in
`renderer/editor/inpaint_filters_gl.js` measures the difference (the sample's posterize
matches to the bit). A document that holds a plugin filter shows a plain "grain" layer when
the plugin is missing at load time; plugins load before the session is restored.

## Panels

```js
scumble.panels.register({
    id: "info", title: "Sample", pane: "image" | "gen", open: false,
    build(container, doc, scumble) { container.appendChild(...); },
    destroy(container, doc) {},        // optional
});
```

A collapsible section at the end of the Image or Generate pane, once per tab (existing and
future ones). `build` runs per tab with that tab's `Document`; keep state on `container` or
in closures, and use `scumble.events.on("changed", ...)` to refresh.

**Listeners you register inside `build` belong to that panel**: when the tab closes they are
removed, `destroy` runs, and the section goes with it. That matters because `build` closes
over a whole document - one listener that outlived its tab used to keep every image ever
opened in memory (docs/PERFORMANCE.md, phase 6). A listener registered in `activate` lives as
long as the plugin, as before, so keep document state out of it: hold `doc.id`, not `doc`.
Only listeners registered while `build` itself is running are scoped, so register them
directly rather than from a later timeout.

## Actions

```js
scumble.actions.register({ id: "desaturate", label: "Desaturate active layer", accelerator: "CmdOrCtrl+Shift+D", key: "Shift+K", run(doc, scumble) { ... } });
```

An entry in the app's *Plugins* menu (with an optional Electron accelerator) that runs on the
active document; `key` is an in-editor single-key shortcut (no Ctrl / Alt, `Shift+` allowed)
that fires when the canvas has focus. Actions also run through the command core:
`run_action` with the full id. Return values reach `run_action` callers.

## Tools

```js
scumble.tools.register({
    id: "probe", label: "Probe", title: "tooltip", icon: "eyedropper" | "<svg ...>" | "Pr", key: "K",
    hint: "status line when selected", allowEmpty: false,
    onSelect(doc), onDeselect(doc),
    onHover(doc, ev), onDown(doc, ev), onMove(doc, ev), onUp(doc, ev),
    onKey(doc, { key, lower, shift, raw }) -> true when handled,   // Delete, Escape, arrows ... while the tool is active
    draw(doc, ctx, { scale, dpr, angle, active }), drawAlways: false,   // overlay in image coordinates
});
```

A button in the tool column under *Plugins* (one per tab); `icon` is one of the editor's icon
names, an inline SVG, or up to two characters. While the tool is active, pointer gestures on
the canvas go to the plugin instead of the editor: `ev = { x, y (image pixels), inside, shift,
alt, ctrl, button, pressure, pointerType, raw }`. Panning (space, middle button), zoom and the
usual shortcuts keep working. `onKey` sees single keys (no Ctrl / Alt) before the editor's
own shortcuts while the tool is active. `draw` paints on the canvas overlay after the grid
and guides, with the view transform applied: draw in image pixels and divide line widths
and font sizes by `scale` (times `dpr`); it runs while the tool is active, or always with
`drawAlways: true` (the film pack's control points show while their layer is active). Call
`doc.draw()` to repaint after a state change.

## Commands

```js
scumble.commands.register("mean_color", {
    description: "...", params: { radius: { type: "number", description: "...", default: 8 } },
    needsImage: true, scope: "doc",
    run(doc, args, scumble) { return { ... }; },
});
```

Registered as `<plugin>.<name>`, listed by `list_commands`, callable by other plugins, tests
and MCP (`docs/MCP.md`; the tool name replaces `.` with `_`). `params` is the same schema the built-in commands use (`type`,
`description`, `default`, `required`, `enum`).

## Settings › Plugins

The list shows every plugin with its state (loaded, disabled, error with the first lines of
the stack), what it registered, and a checkbox to enable / disable it. *Reload plugins*
unloads everything and loads the folders again, so editing a plugin's files and reloading is
the development loop (the entry is imported with a fresh `?v=` query and the app rewrites
the relative imports inside plugin modules to carry it, so submodules reload too); the
*Plugins* menu has the same entries. Runtime errors from callbacks
are collected per plugin (the last eight) and shown there too.

Skins are not in this list: *Settings › Appearance* lists them (docs/SKINS.md), and *Reload
plugins* reloads them too. The `list_plugins` command returns every folder with a `kind`
field, `"plugin"` or `"skin"`; a skin is always `enabled: false` and never `loaded`.

## Testing

`python tools/commands_test.py` (app running with `--remote-debugging-port=9555`) exercises the
command core and the sample plugin: filter on the GPU and CPU path, panel, actions with undo,
the tool through the pointer hooks, the command, reload and disable / enable.
`python tools/film_test.py` does the same for the film pack (`docs/FILM.md`): every filter on
both paths, the commands, the control point tool with undo, the overlay, the panel.

## Built-in plugins

- `plugins/sample`: one of every extension point, the template (~150 lines).
- `plugins/film`: the film pack (`docs/FILM.md`), the first real plugin: eleven filter types
  with shader and CPU paths, a tool with overlay and keys, a thumbnail panel, actions,
  commands. It imports the app's `GRAIN_PRESETS` by absolute path (`/editor/inpaint_filters.js`),
  which built-in plugins may do; user plugins should treat the app's modules as unstable.
- `plugins/ailabel`: the EU AI label. The European Commission's icons for labelling
  AI-generated content (twelve SVGs in `assets/`, third-party data, `NOTICE` has the source
  and the terms) rasterised at the wanted size and placed as an ordinary paint layer: a panel
  (label, style, ground, size, position, opacity), two Plugins-menu actions, the commands
  `ailabel.add` / `ailabel.remove` / `ailabel.info`. Adding again replaces the label. About
  200 lines on the plain API, no editor patch; `tools/ailabel_test.py` is its gate.
- `plugins/skin_90s` and `plugins/skin_duck`: the two built-in skins, **90s** and **Duck**
  (docs/SKINS.md): a `plugin.json` and a `skin.css` each, no code.
- `plugins/glb`: a 3D object (.glb / .gltf) placed in the picture through a dialog and
  rendered into a layer, with an optional depth layer for a ControlNet, re-editable
  (`docs/GLB.md`). three.js vendored under `vendor/` by `tools/vendor_three.py`; a panel, two
  actions, the commands `glb.place` / `glb.edit` / `glb.info`; `tools/glb_test.py` is its gate.
