# Film pack

The film pack is Scumble's first real plugin (`plugins/film/`, built in, phase 4b of
`docs/BRIEF.md`): a Nik Collection / DxO FilmPack style set of **filter layers** on the
plugin API of `docs/PLUGINS.md`. Every filter has a WebGL2 path and a CPU path with the same
maths (at most one or two levels apart, `tools/film_test.py` checks it); the CPU path runs
when there is no GPU, when `info.cpu` is set, and in tests.

All looks are Scumble's own parametric approximations: no manufacturer LUTs, profiles or
measurements. Film names are used referentially, with the trademark note in the stock
list's tooltip and in Settings › About (decided 2026-09-08, `docs/BRIEF.md` §3). Real LUTs
go through the built-in LUT filter layer.

## Filters

All of them are ordinary filter layers: add one with the fx button in the layer list (or
the *Plugins* menu, or `add_filter` with the type id), pick the type in the row's select,
drag the sliders, give the layer a mask to limit where it applies. Types and parameters:

| type | what | parameters |
|---|---|---|
| `film.look` | **Film look**: a stock's colour matrix / black-and-white weighting, warmth and tint, saturation, a parametric tone curve (toe, shoulder, contrast, fade) built from the stock's class, grain by speed through the built-in grain filter, and a halation default (strong for CineStill 800T, none for black and white) | `preset` (stock; `custom` = adjustments only), `strength`, `exposure` (EV), `push` (stops: more contrast, more and coarser grain), `contrast`, `saturation`, `warmth`, `tint`, `fade`, `grain` (% of the stock's own), `halation` (% of the stock's own) |
| `film.halation` | **Halation**: highlights above the threshold blurred and screened back in a warm tint (the red glow of film without an anti-halation layer) | `threshold`, `radius` (px), `strength`, `hue`, `saturation` |
| `film.glow` | **Glow / Orton**: a blurred copy blended back | `mode` (soft light = Orton, screen = bloom, lighten = diffusion), `radius`, `amount`, `threshold` (highlights only) |
| `film.tonal_contrast` | **Tonal contrast**: local contrast (detail against a large-radius blur) with separate gain in highlights, midtones and shadows, a saturation touch and protection of the tonal ends | `highlights`, `midtones`, `shadows`, `radius`, `saturation`, `protect` |
| `film.structure` | **Structure / Detail**: small-radius local contrast; negative values soften (skin) | `amount`, `radius`, `luminance` (luminance only) |
| `film.bleach_bypass` | **Bleach bypass**: the picture overlaid with its own luminance (the skipped bleach step), desaturated and contrasty | `strength`, `desaturate`, `contrast`, `brightness` |
| `film.cross_process` | **Cross processing**: per-channel curves per style (slide film in C-41: cyan shadows, yellow highlights, high contrast; negative film in E-6: flat and muted; Lomo; cool blues) | `style`, `strength`, `contrast`, `shift` (green ↔ magenta) |
| `film.split_tone` | **Split toning**: a hue for the highlights and one for the shadows, a balance point, optional luminance preservation | `hi_hue`, `hi_sat`, `sh_hue`, `sh_sat`, `balance`, `preserve` |
| `film.light_leak` | **Light leak**: one to three soft anisotropic light blobs screened over the picture, resolution independent, deterministic per variant | `style` (warm edge, streak, corner burst, two streaks, bars), `strength`, `hue`, `saturation`, `spread`, `position`, `angle`, `seed` (variant) |
| `film.frame` | **Frame**: painted inside the picture (the canvas keeps its size): thin line, matte with a key line, film rebate with rounded corners, slide mount, instant print (wide bottom), rough torn edge (value noise), oval matte | `style`, `colour`, `width` (% of the short side), `softness`, `radius` (corners), `inset` (key line), `roughness`, `seed` |
| `film.bw` | **Black & white film** (Silver Efex style): a colour filter in front of the lens (yellow, orange, red, deep red, green, blue, or a custom hue), brightness, contrast, structure, shadows and highlights, a chemical toner (sepia, selenium, cyanotype, platinum, gold, split) and grain | `preset` (filter), `filter_hue`, `filter_strength`, `brightness`, `contrast`, `structure`, `shadows`, `highlights`, `tone`, `tone_strength`, `grain` |
| `film.points` | **Control points**: local adjustments, see below | `points` (list), `strength` |

The maths, in short: everything runs on RGB in 0..1. Tone curves are 256-entry tables
(the GPU reads them from a 256 × 1 texture, the CPU indexes the same table). The black and
white weights behind a colour filter of hue φ are the luma weights scaled by
`1 + 2.4 · s · (cos(φ − hue_channel) · 0.5 + 0.5 − 0.5)` and normalised, so a red filter
weights red 0.70 / green 0.25 / blue 0.05 at full strength. Halation, glow, tonal contrast,
structure and the black-and-white structure blur through `ctx.filter` on a canvas padded
with mirrored edges (the same blur the built-in blur filter uses), then one shader pass
combines source and blur. Light leaks and frames are analytic per pixel in normalised
coordinates; the rough frame edge and the leak jitter use an integer hash on the lattice
that JS and GLSL compute identically.

### The stocks

The film look's stock list is the grain filter's `GRAIN_PRESETS` (grain amount, size,
speckle and colour share per stock, plus the colour "look": saturation, contrast, warmth,
tint, fade, an optional channel mix and the black-and-white weighting) extended in
`plugins/film/looks.js` with a tone class per group and a halation default:

| group | toe | shoulder | halation |
|---|---|---|---|
| Colour negative | 0.12 | 0.30 | 12 % |
| Slide | 0.30 | 0.10 | 6 % |
| Black & white | 0.18 | 0.25 | 0 |
| Cine | 0.08 | 0.45 | 18 % |
| Special & artistic | 0.20 | 0.20 | 10 % |

Per-stock departures: CineStill 800T 55 % halation (no remjet), 400D 35 %, 50D 25 %,
Velvia and Kodachrome a harder toe, the instant look a milky toe and shoulder, expired film
a long shoulder, the 3200 stocks a short toe and long shoulder. `film.looks` lists it all.

## Control points

`film.points` is a filter layer with a list of points. Each point has a centre, a radius,
a colour tolerance and adjustments (exposure in EV, contrast, saturation, warmth,
structure). A pixel's weight for a point is a radial falloff (full inside a quarter of the
radius, zero at the radius) times a Gaussian of the colour distance between the pixel and
the colour sampled under the point when it was placed, measured in luma plus two opponent
axes (the tolerance sets the width, 0 = only that colour, 100 = almost everything inside
the circle). The adjustments of all points are summed with those weights and applied once,
so a point on the sky darkens the sky and leaves the roof inside its circle alone.

The **Control point tool** (U, in the tool column under *Plugins*):

- click on the picture: a new point on the active control points layer (the topmost one,
  or a new layer); keep the button down and drag to set its radius;
- drag the centre to move it (the colour is sampled again at the new place), drag the ring
  to resize it;
- a click on a centre selects; Delete / Backspace removes the selected point, Escape
  deselects; every placement, move, resize and deletion is one undo step;
- the layer row shows the points as numbered chips and the sliders of the selected one
  (size, tolerance, exposure, contrast, saturation, warmth, structure) plus *Remove point*;
- the points are drawn on the canvas while the tool is active or the layer is the active
  layer (the plugin overlay hook, `docs/PLUGINS.md`).

`film.add_point` adds a point from a script or MCP (`x`, `y`, `radius`, `tolerance`,
`exposure`, `contrast`, `saturation`, `warmth`, `structure`); `set_filter` with a `points`
list edits them in bulk. A point's stored `color` is `[luma, r − luma, b − luma]` of the
input under it; leaving it out when writing points makes the plugin sample it on the next
tool interaction, but `add_point` samples it right away.

## Panel, menu, commands

- **Film looks** (a section at the end of the Image pane): a group select and one
  thumbnail per stock, rendered from the current picture through the look's colour stage
  (no grain) at 96 px, refreshed after edits when the section is open. A click applies the
  stock to the active film look layer or adds one.
- **Plugins menu**: Film look layer, Black & white film layer, Halation layer, Light leak
  layer, Frame layer, Control points layer (switches to the tool).
- **Commands** (`docs/COMMANDS.md`): `film.looks` (the stock table, optionally one group),
  `film.apply_look` (`preset`, `strength`: change the active look layer or add one),
  `film.add_point`. Everything else goes through `add_filter` / `set_filter` with the type
  ids above; `filter_types` lists their parameters.

## Files

```
plugins/film/
  plugin.json   manifest
  main.js       registration, the Film looks panel, menu actions, commands
  filters.js    the eleven filter types (shaders + CPU twins), the look's colour stage
  points.js     control points: filter, tool, layer-row control, add_point
  looks.js      the data: stocks (from GRAIN_PRESETS), toners, colour filters, processes, frames
  common.js     GLSL prelude, the CPU pixel loop, blur, tables, tone curve, hash noise, runner
```

The plugin imports `GRAIN_PRESETS` from the app by absolute path
(`/editor/inpaint_filters.js`), which built-in plugins may do; user plugins should treat the
app's modules as unstable.

## Testing

`python tools/film_test.py` (app running with `--remote-debugging-port=9555`, test image in
the mirror): plugin state, every filter type on the GPU and the CPU path with several
parameter sets (max difference ≤ 2 levels, ≤ 0.1 % of samples above 2), the look commands
with undo, `film.add_point`, the tool through the pointer and key hooks (place with size,
move, resize, select, delete, undo), the layer-row control, the panel thumbnails and a click
on one, exports to `dist/smoke/film/`. First PASS 2026-09-09 on the RTX 5090.
