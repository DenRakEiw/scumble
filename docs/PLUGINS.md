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
        // { key: "mode", type: "select", options: [{ id: "a", label: "A" }, "b"], default: "a" }
        // { key: "curve", type: "custom", default: {...} }  with control(layer, param, callbacks) -> element
    ],
    apply(src, params, info) { ... return canvas; },   // CPU path, required
    glsl: {                                            // optional WebGL2 path
        uniforms: { u_levels: "float", u_mono: "bool" },    // float, int, bool, vec2, vec3, vec4
        values: (params, info) => ({ u_levels: params.levels, u_mono: !!params.mono }),
        code: `vec4 shade(vec4 c, vec2 uv) { ... }`,        // must define shade(); "filter" is reserved in GLSL
    },
});
```

The filter appears in the type list of every filter layer, works in `add_filter` /
`set_filter`, and is stored in documents by its full id. `apply(src, params, info)` gets a
canvas and returns a canvas of the same size (returning nothing keeps the input);
`info.scale` is 1 at full resolution and smaller for previews (shrink radii with it),
`info.seed` the layer's seed, `info.cache` an object that lives with the layer for reuse
between runs. The GLSL fragment gets `u_src` (the input; sample neighbours with
`uv + vec2(dx, dy) / u_size`), `u_size`, `u_scale`, `u_seed` and the declared uniforms, and
is compiled lazily on first use; when it fails to compile the CPU path runs and a warning
names the error in the console. Keep both paths in agreement; `compareFilterPaths` in
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
});
```

A button in the tool column under *Plugins* (one per tab); `icon` is one of the editor's icon
names, an inline SVG, or up to two characters. While the tool is active, pointer gestures on
the canvas go to the plugin instead of the editor: `ev = { x, y (image pixels), inside, shift,
alt, ctrl, button, pressure, pointerType, raw }`. Panning (space, middle button), zoom and the
usual shortcuts keep working. The editor's overlay is not drawable by plugins yet; give
feedback through the status line, a layer, or the selection.

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
the development loop; the *Plugins* menu has the same entries. Runtime errors from callbacks
are collected per plugin (the last eight) and shown there too.

## Testing

`python tools/commands_test.py` (app running with `--remote-debugging-port=9555`) exercises the
command core and the sample plugin: filter on the GPU and CPU path, panel, actions with undo,
the tool through the pointer hooks, the command, reload and disable / enable.
