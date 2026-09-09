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

`entry` (default `main.js`) is an ES module inside the folder. `registers` is informational.
`enabledByDefault: false` ships a plugin switched off. The enabled state lives in
`settings.json` (`plugins.enabled` / `plugins.disabled`).

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
| `version` | API version, `1` |
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
| `filters.apply(id, canvas, params, info)` / `filters.ids()` | run any filter type (built-in or plugin) on a canvas, GPU path when available: the film pack chains the built-in grain this way |
| `gl.shade(shader, canvas, values, info)` / `gl.available()` | one shader pass over a canvas (`shader = { code, uniforms, label }`, compiled once per object) for multi-pass filters; null without a GPU path |
| `panels.register(def)` / `unregister(id)` | side panels |
| `actions.register(def)` / `unregister(id)` / `run(id)` | Plugins menu entries |
| `tools.register(def)` / `unregister(id)` | tools in the tool column |
| `events.on(type, fn)` | `built`, `activate`, `changed`, `tool`, `removed`; `fn({ doc, ... })`; returns `off()` |
| `storage.get()` / `storage.set(patch)` | a small persistent object per plugin (`settings.json`) |
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
| `rawLayer(key)` | the editor's layer object (canvas, mask ...); unstable |
| `flatten()` | the visible picture as a canvas at image size |
| `getPixels()` | `{ data: ImageData, x: 0, y: 0, w, h }` of the flattened picture |
| `getPixels(layer)` | the layer's own canvas (unmasked) plus its placement `x, y, w, h` in image pixels; `w, h` differ from the ImageData size when the layer is scaled |
| `setPixels(layer, imageData, { undo = true })` | write a layer's canvas back (same size, or the canvas is replaced and the placement kept); filter and locked layers refuse |
| `addLayer(imageData \| canvas \| null, { name, x, y, w, h, activate })` | a new paint layer, placed at `x, y`; `null` = empty at image size |
| `selection()` | `{ mask: Uint8Array(width × height), bounds: {x, y, w, h}, width, height }` or `null` |
| `setSelection(mask, mode)` | from a `Uint8Array` (>0 = selected); `replace`, `add`, `subtract` |
| `undo()`, `redo()` | |
| `draw()` | repaint the canvas and overlays (no cache invalidation) |
| `setFilterParams(layer, patch, { preview })` | change a filter layer's params: `preview: true` during a drag (low-res, no undo step yet), the final call without it pushes one undo step |
| `refresh()` | after changes on raw layer objects: caches off, lists and canvas redrawn |
| `editor` | the raw editor (unstable) |

Layers are addressed like in the commands: id, exact name, a unique part of the name, or
`"active"`. The base image has no layer object of its own; to change it, duplicate it into a
layer (`run("duplicate_layer")` on the base is not possible, use `getPixels()` + `addLayer`)
or flatten.

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
between runs. The GLSL fragment gets `u_src` (the input; sample neighbours with
`uv + vec2(dx, dy) / u_size`), `u_size`, `u_scale`, `u_seed` and the declared uniforms, and
is compiled lazily on first use; when it fails to compile the CPU path runs and a warning
names the error in the console. `values(params, info, src)` also gets the source canvas.
A `sampler2D` uniform's value is a canvas, ImageData or image (uploaded as RGBA8, sample
it with the `uv` handed to `shade`), or `{ data, width, height }` with a Uint8ClampedArray
(RGBA8; a 256 × 1 table, say) or a Float32Array (RGBA32F, read with `texelFetch`); add
`linear: true` for bilinear filtering of 8-bit sources. Plugin samplers sit on texture
units 5 and up. `u_seed` and `u_size` are taken (do not redeclare them), and `filter`,
`half`, `sample` are reserved GLSL words.

Filters that need more than one pass (a blur between two shader stages) skip the `glsl`
block and orchestrate in `apply`: blur with Canvas 2D, then `scumble.gl.shade(shader, canvas,
values, info)` with the blurred canvas as a `sampler2D` value, falling back to a pixel loop
when it returns null (or when `info.cpu` is set). `plugins/film/common.js` has the runner
and the shared maths; `docs/FILM.md` the filters built that way. Keep both paths in agreement; `compareFilterPaths` in
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
and (phase 4c) MCP. `params` is the same schema the built-in commands use (`type`,
`description`, `default`, `required`, `enum`).

## Settings › Plugins

The list shows every plugin with its state (loaded, disabled, error with the first lines of
the stack), what it registered, and a checkbox to enable / disable it. *Reload plugins*
unloads everything and loads the folders again, so editing a plugin's files and reloading is
the development loop (the entry is imported with a fresh `?v=` query and the app rewrites
the relative imports inside plugin modules to carry it, so submodules reload too); the
*Plugins* menu has the same entries. Runtime errors from callbacks
are collected per plugin (the last eight) and shown there too.

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
