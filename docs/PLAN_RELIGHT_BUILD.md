# Relight: the build plan (Umbauplan, item 43)

**Status: planned 2026-10-11 against `0d0be6b` (0.1.46 released). Nothing built.** The other agent builds it one session
per sitting; this account reviews after every session and makes the release at the end (the user, 2026-10-11). The
research and the first shape are in `docs/PLAN_RELIGHT.md` (2026-10-09; its §1 refreshed 2026-10-11); this file is the
build plan: the design decided, the sessions with their anchors, tests and questions. Every effort figure is **inferred,
not measured**. Every line number is from `0d0be6b`; grep the name before editing.

The user's words (2026-10-09 and 2026-10-11): rebuild the relight feature Photoshop's beta got on 2026-09-28; light
points placed on the picture, each with its own light colour, lighting the image; different kinds of rays (light types)
to choose from; use Rust where it makes sense. This plan may name other products (the rule of 2026-09-29 covers
CLAUDE.md, the posts, the CHANGELOG, the manual and the README).

## 1. How to use this plan

- **One session per sitting** (the user's rule since 2026-09-30): one row of §5, its local commit, the hand-over line in
  CLAUDE.md "Where things stand", its CHANGELOG `## Unreleased` line, then `/clear`. A session that runs out of context
  stops at a committed state. The rules of `docs/PLAN_NIK9_BUILD.md` §1.1 apply unchanged (commit as DenRakEiw, every
  app gate `--offline`, new gate steps in a new gate, no gate needs a real model, downloads need the user's yes, the
  text rule, tests by risk, the dev instance, the Write tool for scripts, new editor modules into `tools/build_node.py`
  FILES, a new host member into the `EditorHost` typedef and the node's own `js/host.js`).
- **Say the behaviour first.** Before a session that changes how pixels land (L1a, L4, L5), the hand-over of the
  session before says the effect in one plain sentence (§3 holds the sentences); the user reads it before the build.
- **A review after every session** by this account (the Nik 9 pattern: agents read the commit, each finding refuted or
  confirmed by a second one, the fixes in a commit of their own). The builder leaves the gates' summaries in the
  hand-over and does not push.
- **The release** is this account's: the CHANGELOG section, `npm run dist`, the exe gates, the tag, the post, the
  Store update, the registry (`docs/RELEASING.md`), after the user's test of the dev build.
- **Questions** are in §6 (R-D1 to R-D9) with the suggested answer; a session that needs one names it and asks before
  it starts. Where the user says nothing by the time the session starts, the suggested answer is taken and the
  hand-over says so.
- **Session layout:** goal (what the user sees), preconditions, changes (with anchors), tests (with the tier), docs,
  risks, effort.

## 2. What the model feature does (read 2026-10-11)

Photoshop (Beta) 27.12.0, announced 2026-09-28; generative, server-side, 30 credits per *Done* (about $0.30), internet
needed. Sources in §8.

- **A Relight layer** (*Layer › New Relight layer*, the Layers panel flyout) over an unlocked pixel, Rotate Object or
  Smart Object layer; the source layer is hidden, the Relight layer holds the rendered result and a badge; a mask on
  the source is copied to it; selections are ignored; it reads the active layer alone (stamp visible first). It can be
  masked, faded and blended like any layer; it does not follow later edits of the source.
- **Up to three lights** (minimum one; *Add light* greys out at three), dragged anywhere on the canvas, also outside
  the picture (not below its bottom edge). A default white light starts in the middle. Per light: **Left/Right**,
  **Low/High**, **Close/Far** (depth: Close in front of the subject towards the camera, Far behind it for a rim or
  backlight; the handle grows with Close and shrinks with Far), **Intensity** (0 % adds nothing), **Colour** (Kelvin
  presets 1000-10000 K, default 5500 K, higher = bluer; or *Custom color* through the picker; no eyedropper),
  **Diffusion** (the source's size: low = hard shadows like a bare bulb, high = soft, wrapping light like a softbox),
  an eye (off), *Reset*, a trash icon. One review names a soft / hard shadow roll-off choice; the guides do not.
- **Original lighting** (global, 100 % keeps the picture's light, 0 % removes it): the feature takes the existing light
  away and lights the scene with its own; visible sources in the frame (a window, a lamp) stay lit as scene lights;
  all lights off leaves the ambient remainder. On landscapes the sun cannot be removed without losing the scene.
- **Preview and Done:** a low-resolution, soft preview while dragging (free); *Done* renders at the document's pixel
  size (generated smaller and upscaled: hair, skin and fabric come back softer; faces sometimes changed) and costs 30
  credits; *Edit lighting* reopens the lights, every further *Done* costs again; Escape / *Discard* is free. The final
  can differ from the preview in brightness and colour. 8-bit only (a 16 / 32-bit document gets a warning), RGB / Lab /
  CMYK / Grayscale, Actions and scripting, Content Credentials attached.
- **The complaints** (the beta forum, the reviews): the 3D placement is clunky (no depth indicator; a light inside an
  object misbehaves), fine detail is lost, 30 credits is a lot, no brightness control, the handle cannot be hidden,
  "a flashlight, not the sun" on landscapes, composites suffer (one layer). Asked for: gobos, flash vs continuous, a
  depth indicator, a lower price.
- **How it works:** not published. Project Light Touch (MAX Sneaks 2025) was a virtual light "that accounts for depth
  and occlusion"; one guide says it "rebuilds the lighting", another "recalculates highlights, contact shadows and
  contours". It is a neural renderer on a server; nothing of it is a shader.

**What Scumble does differently** (the decisions of §4): every light is **also a sun or a spot**, not only a point;
the **in-app route is instant and free** (a shader on the depth map, the picture's detail untouched), the generative
routes are the second step; **the lights are kept in the document** and re-edited at no cost on the in-app route; a
generative answer keeps the picture's detail through a ratio against the original (§4.6); the depth is **visible**
(*Show depth map* exists, R1-S6) and the handle's depth is read off the map; the lights work on the **whole visible
picture** (like the Realism Pass), never one layer alone.

## 3. The behaviour in one sentence each

- **The in-app route** lays a geometry-aware light over the visible picture: each light brightens the surfaces that
  face it, falls off with distance, is blocked where the depth map says a nearer surface lies between, and can flatten
  the picture's own directional shading (the *Original light* slider); it never regenerates pixels, so there are no
  new highlights in eyes, no reflections, no shadows the depth map cannot see, and every texture stays exactly as it
  is. A filter layer, instant, free, re-editable, maskable.
- **The Magnific route** sends the picture with a light map drawn from the same lights and gets a regenerated picture
  back; with *Detail from the original* on, only its light (the ratio to the original at low resolution) is laid over
  the full-resolution picture. A pixel layer, about €0.10 a run.
- **The ComfyUI and fal routes** turn the lights into words (direction, colour, softness) for a model that relights
  from a prompt; the lights' exact places are not sent. A pixel layer.

## 4. The design

### 4.1 The light model

**The scene is a height field in map pixels** (orthographic, phase 1): the depth map `ed.maps.depth` (u16 "far", 0
near, 65535 far, at map resolution up to `WORK_MAX` 4096 on the long side, `inpaint_depth.js:7`, with the guide and
the edge snap of R2-S4 / R2-S5) gives every map texel a height `z = depthScale * far01`, where `depthScale` is the
filter's *Depth* slider in percent of the map's long side (default 50: the scene is half as deep as it is wide; relative
depth from the model is disparity, not metres, so this is a look, not a measurement). A pixel's 3D point is `p = (mx,
my, z)` in map pixels; picture pixels go to map pixels through the map's `xf` (`passToMap`, `inpaint_maps.js:320`).
Perspective (a FOV) is phase 2 with MoGe-2's camera (§5 N1); the orthographic field needs no FOV, matches Photoshop's
three sliders (Left/Right, Low/High, Close/Far) and keeps the normals consistent with the shadows.

**Normals** (phase 1) from the height field: `n = normalize(-dz/dx, -dz/dy, 1)` after a Gaussian of `sigma` map
pixels (the *Smooth normals* slider, default 2; the depth's edge snap already put the picture's contours into the
map). Phase 2 replaces them by a normal model's map where present (§5 N1).

**Lights**, up to four (R-D6), each `{ id, type, x, y, dist, intensity, color, diffusion, on, angle?, cone?, edge? }`:
- `type`: **point** (default), **sun** (directional: parallel rays, no falloff; direction vector is `(mx - cx, my - cy, -dist / 100 * scaleZ)` relative to the map centre `(cx, cy)`, giving elevation via `dist` and azimuth via handle displacement from the centre), **spot** (a point with a cone: `cone` the half angle in degrees, `edge` the
  softness of the rim in percent; it aims at `aim: [x, y]`, a second handle). "Different kinds of rays" (the user).
- `x, y`: picture pixels, may lie outside the picture (the preview draws the handle on the view).
- `dist`: Close/Far, −100..100; the light's height `lz = zSurface(x, y) − dist / 100 * depthScale * long` where
  `zSurface` is the map's height under the handle (clamped into the map): 0 puts the light on the surface it hovers
  over, negative towards the camera (in front), positive behind it (a rim light). The handle's radius shows it
  (larger in front, smaller behind), and the map's height under it is read off the depth map, which answers the
  forum's "no depth indicator".
- `intensity`: 0..300 % (default 100); `color`: a Kelvin value 1000..10000 (default 5500) **or** a hex colour (a
  string); `diffusion`: 0..100 (default 30): the source's radius for the soft shadows (a disc of taps) **and** a wrap
  of the Lambert term (`(n·l + w) / (1 + w)`, `w = diffusion / 100`), so a large diffusion lights around the edge
  like a softbox; `on`: the eye.
- **Range** per light (point and spot): the distance at which the light has fallen to half, in percent of the long
  side (default 50); falloff `att = 1 / (1 + (d / range)^2)`.

**Shading per picture pixel, in linear light** (sRGB in, sRGB out; the twin uses the same transfer):

```
F      = P / S_fit                           the picture with its own directional shading taken out (clamped, see below)
S_fit  = ka + kd * max(0, n · l0)            the fitted original light (a directional light + ambient; §4.2 "fit")
o      = original / 100                      the Original light slider (default 100)
Lsum   = Σ_i on_i * C_i * I_i * ndl_i * att_i * cone_i * V_i
out    = F * ( o * S_fit + (1 - o) * ambient + Lsum )
```

`ndl_i` the wrapped Lambert term, `V_i` the light's visibility (the shadow map, 0..1, times the *Shadows* strength),
`cone_i` the spot's cone term (1 for point and sun), `ambient` the *Ambient* slider (default 15 %: all lights off and
`o = 0` leaves a dim picture, not a black one), `C_i` the light's colour as linear RGB (Kelvin through a Planckian
approximation, `kelvinToRgb`, normalised so 5500 K is white). With no lights and `o = 1` the output is the input
exactly (`F * S_fit = P`): the filter at its defaults is the identity, which is what the tests pin first. The division
by `S_fit` lifts the picture's own shadows (so a new light into an old shadow shows the texture); it is clamped by the
*Recover shadows* slider (the largest gain, default 3×) and `S_fit >= 0.1`, and the gain fades to 1 in the darkest
tones (noise). Highlights roll off through a soft shoulder (`x < 0.8 ? x : 0.8 + 0.2 * (1 - exp(-(x - 0.8) / 0.2))`)
before the transfer back to sRGB, so a strong light does not clip flat. Specular (a gloss term) is phase 2.

**The fitted original light** (the *Original light* slider needs it): a least-squares fit of the picture's luminance
against the normals on the `wholeStats` sample (`belowStats`, `inpaint_canvas.js:14783-14805`, size 256: the composite
below the layer at 256 px and `ctx.maps`): `Y ≈ ka + kd * max(0, n · l0)` over opaque pixels, solved for `l0` (unit)
and `ka, kd >= 0` by three alternating passes (an initial `l0` from the luminance-weighted mean of the normals, then
the 2 × 2 solve of `ka, kd`, then `l0` as the weighted normal residual, twice); `S_fit` is normalised so its mean is
1. It is one small pure function (`fitOriginalLight`), JS, Node-tested on a synthetic sphere; its `l0` is drawn on
the canvas as a grey handle ("the picture's own light", not draggable, a click on it adds a light there). On a
multi-light scene the fit is a compromise and the slider flattens less; that is the honest limit of a non-generative
delight (§7).

### 4.2 Where the maths runs

| Part | Resolution | Where | Why |
|---|---|---|---|
| The per-pixel shading (§4.1) | the picture (up to 15k, in tiles above 33 MP) | **the WebGL2 filter shader** (`registerGLFilter`, `inpaint_filters_gl.js:968`; the pattern `registerHazeGL`, `inpaint_depthfx.js:230`) with the **JS CPU twin** (`applyRelight`, the rule: the twin is the reference and the fallback, `docs/PLAN_WASM.md` §3.2) | a fragment shader beats any CPU kernel per pixel; the CPU twin runs in the tests and on machines without WebGL2 |
| Normals from the height field | the map (≤ 4096²) | **Rust** `height_normals` (§4.3), in the worker pool, cached on the layer | 16.7 M texels of f32 maths, once per depth map and *Depth* / *Smooth* change |
| The shadow (visibility) map per light | the map, or a quarter of it while dragging | **Rust** `shadow_march` (§4.3), by bands over the pool, cached on the layer per light | `w · h · steps · taps` samples (1024² × 32 × 4 = 134 M per light): JS is 3-6× slower, the GPU cannot share it between frames |
| The fitted original light | the 256-px sample | JS (`fitOriginalLight`) | tiny |
| The light map for Magnific | ≤ 2048 on the long side | the same shader with `u_mode = 1` (the light term alone, tone-mapped) through `applyFilterGL` at that scale, or the CPU twin | no second implementation of the lights |
| The words for the prompt routes | - | JS (`lightsToWords`) | pure |

**The cache on the layer** (`layer._relight`, like a film layer's `_lutData` / `_plateImg`: never saved, rebuilt on
open, included in `readSig` of `realismWhole`, `host.js:2862`): `{ key, normals: { data: Uint8Array RGBA8, w, h },
vis: { data: Uint8Array RGBA8, w, h, keys: [4] }, fit: { l0, ka, kd }, pending }`. `key` is the depth map's
`dataVersion` + `depthScale` + `sigma`; each light's `vis` channel has its own key (type, x, y, dist, diffusion, range,
depthScale, the map version). `ensureRelightMaps(layer, { quick })` on the editor compares the keys, runs the worker
ops for what differs (`quick`: a quarter-size vis while a handle drags, `INTERACTIVE` priority, `inpaint_pool.js:19`),
and calls `markFilterChanged(layer, { soon: true })` when they land. The shader draws with what the cache holds (no vis
yet: `V = 1`), so a drag is never blocked. **Exports wait:** `encodeComposite` / `flattenToCanvas` with `forRun` call
`await ed.relightSettled()` first (the pattern of `mipsSettled`); the CPU twin computes the maps itself through the JS
twins when the cache is missing (the tests, the fallback). The vis texture packs four lights into RGBA8; the normals
into RGB8; both go up as static samplers keyed by `key` (the dehaze pattern for `u_t` / `u_tguide`, R2-S14).

### 4.3 Rust: the kernels (`crates/px`, ABI 18 → 19)

Both are map-resolution f32 / u8 loops with no per-pixel branching worth a GPU, the kind that moved before (`range_max`
5× in 0.1.46, `docs/PLAN_WASM.md` §1). The rules of `docs/PLAN_WASM.md` §3 apply: the JS twin stays in
`renderer/editor/px/kernels_js.js` and is the reference (`tools/px_test.js` runs both on the same bytes, equality
within one level), the dispatch in `kernels.js` (the `rangeMax` template, `kernels.js:137`), `px_abi_version` → 19
(`crates/px/src/lib.rs:46`, `renderer/editor/px/px.js:14`), both builds through `python tools/build_px.py` then
`--check`, one measurement row in `docs/PERFORMANCE.md`.

- **`height_normals(depth: *const u16, w, h, scale: f32, sigma: f32, out: *mut u8)`** → RGBA8 (`n * 127.5 + 127.5`,
  A 255). A f32 copy of the heights (`scale * far / 65535`), three box passes from `sigma` (`maskf::box_blurs`,
  `lib.rs:149`, the radii as `gaussBlur` in `inpaint_edges.js:333` derives them), central differences with clamped
  borders, normalise, pack. Scratch: one f32 plane (`px_alloc`, sized before the loop: a wasm memory growth invalidates
  every view). Expected 3-5× over JS; about 60-100 ms at 4096² single-threaded.
- **`shadow_march(depth: *const u16, w, h, scale: f32, light: *const f32 [x, y, z, kind], radius: f32, taps: u32,
  steps: u32, bias: f32, row0: u32, rows: u32, out: *mut u8)`** → u8 visibility (0 shadow, 255 lit) for the rows
  `row0 .. row0 + rows` (one band per pool job). Per texel: `p = (x, y, z(x, y) + bias)`; for each of `taps` light
  positions on a Vogel disc of `radius` around the light (`vogelDisc`, `inpaint_lensblur.js:51`, the same spiral in
  Rust), march `steps` points from `p` towards the light (a point light: to the light's position; the sun, `kind 1`: a
  fixed direction, to the map's edge), sample the height field at each (nearest texel; bilinear only if the look asks
  for it), and the tap is blocked when the surface there lies in front of the ray by more than `bias`; the texel's
  visibility is the share of taps that reach the light. A spot is a point for the march (its cone is in the shader).
  Expected 3-6× over JS; the quick quarter-size pass under 20 ms per light, the full 1024-2048² pass 50-300 ms per
  light over four workers.
- Not Rust: the fit (65 k samples), `kelvinToRgb`, `lightsToWords`, the light map composition (the shader does it).
- Phase 2 kernels (§5 N2): `horizon_ao` (a horizon-based ambient occlusion from the height field, the same march
  shape, darkens the `ambient` term in creases), and the normals' guided upsample if the normal model's map is smaller
  than the depth map.

### 4.4 The filter layer `relight`

A built-in filter in `FILTERS` (`inpaint_filters.js`, after `lens_blur` ~:1189) with its module
`renderer/editor/inpaint_relight.js` (pure maths, the twins, the GL registration; `tools/build_node.py` FILES):

```
relight: {
    label: "Relight",
    params: [
        { key: "lights", type: "custom", default: [] },                         // the list of §4.1; the row's own block edits it
        { key: "original", label: "Original light", min: 0, max: 100, step: 1, default: 100, unit: "%" },
        { key: "ambient", label: "Ambient", min: 0, max: 100, step: 1, default: 15, unit: "%" },
        { key: "depth_scale", label: "Depth", min: 5, max: 200, step: 1, default: 50, unit: "%" },
        { key: "shadows", label: "Shadows", min: 0, max: 100, step: 1, default: 60, unit: "%" },
        { key: "sigma", label: "Smooth normals", min: 0, max: 8, step: 0.5, default: 2, hidden: true },
        { key: "recover", label: "Recover shadows", min: 1, max: 6, step: 0.1, default: 3, hidden: true },
        { key: "route", type: "custom", default: "app" },                        // the row's route select (§4.6)
    ],
    maps: () => ["depth"],
    wholeStats: relightStats, wholeStatsSize: 256,                              // the fit (§4.1)
    reach: 0,
    apply: applyRelight,
}
```

- `params.lights` is an object param like `params.limit` (F6; `limit` is the precedent for a non-scalar param in the
  document, `docfile.js:62`); `type: "custom"` params are skipped by the generic slider builder
  (`buildFilterControls`, `inpaint_canvas.js:18549`) and drawn by `buildRelightBlock(layer)` (the `buildLimitBlock`
  pattern, `:18681`): one row per light (a colour dot in the light's colour, its number, the type select point / sun /
  spot, the eye, *Reset*, the trash), the selected light's sliders (Intensity, Diffusion, Close/Far, Range; the spot's
  Cone and Edge; the colour: a Kelvin select 2700 Tungsten, 3200 Halogen, 4000 Fluorescent, 5500 Daylight, 6500
  Overcast, 8000 Shade, 10000 Blue sky, *Custom* with the colour input and an eyedropper through `pickOnce`), *Add
  light* (greys out at four), the hint row when the depth map is missing (*Compute depth map* inline, the haze pattern
  R2-S12), the route select and its *Render* button (§4.6). Sliders preview through `filterPreview` and commit one undo
  step (`:18554-18555`).
- `skip`: no depth map, or no light on and `original == 100` (the identity).
- GL: `registerRelightGL()` with the uniforms `u_map, u_guide, u_m0, u_m1, u_snap` (the depth map and the snap, as
  haze), `u_normals, u_vis` (the cache's samplers), `u_fit` (vec4: `l0.xyz, ka`) and `u_kd`, `u_lights` (a `vec4[4]`
  of x, y, z, range in map pixels), `u_lcolor` (`vec4[4]`: linear RGB × intensity, the wrap), `u_lkind` (`vec4`: 0
  point, 1 sun, 2 spot), `u_lcone` (`vec4[4]`: aim xy, cos of the cone, the edge), `u_lmask` (`vec4`: on × shadows),
  `u_original, u_ambient, u_recover, u_mode`. `SAMPLE_GLSL` and `SNAP_GLSL` are prepended as in haze; the normals and
  the visibility are sampled bilinearly at the map's resolution and **snapped against the guide** like the depth (the
  shadow edge follows the picture's contour, not the map's texel). The `uniforms` of `registerGLFilter` know scalar
  types only (`PLUGIN_TYPES`, `:969`): check whether `vec4[4]` arrays pass or go in as 16 vec4 uniforms (`u_l0..3`);
  the plan's names are indicative.
- CPU twin `applyRelight(src, p, info)`: the same maths per pixel through `u16Bilinear` (`inpaint_weights.js:224`) and
  `snapField` (`inpaint_edges.js:73`) on the cache's planes; within 2 levels of the GL twin (haze's tolerance), checked
  by the gate's `glVsCpu` (`tools/depthfx_test.py`).
- `FEATURES` (`docfile.js:45-100`): `{ id: "relight", since: "0.1.47", reader: 6, sample: { layers: [{ kind: "filter",
  filter: "relight" }] } }` (0.1.46 is reader 5); `tools/document_test.js` asserts reader 6. `deriveMap` follows a turn,
  crop or resize for the depth map already; **the lights' `x, y, aim` follow the geometry too** through the
  `geometry` path filter params take (grep `geometry` in `inpaint_canvas.js` for how `lens_blur` / the film points
  move their coordinates; the Boxes plugin's handler in `plugins/boxes/main.js` is the model).
- `filter_types` exposes the params with `needs: "depth"` on the filter (the haze precedent), so an agent sees it.
- `set_filter(layer, params: { lights: [...] })` edits the lights from MCP without a new command (the list is
  validated: at most four, the fields clamped, unknown fields dropped: `normalizeLights`, pure, Node-tested).

### 4.5 The handles on the canvas

A built-in tool **`lights`** (key **L**; the editor's own tool, in the pointer switch `inpaint_canvas.js:5709-5800` and
`setTool`), selected automatically when a relight layer is added or its row's *Edit lights* is pressed, like the film
pack's control points select `film.point` (`plugins/film/main.js:183`); the film pack's `points.js` (`onDown` :214,
`onMove` :329, `draw` :490) is the model for the handle maths, the Boxes tool (`plugins/boxes/tool.js`) for the
palette and the hit order. While the tool is active and the active layer is a relight layer:

- The overlay draws every light as a ring in its colour (the type as the glyph: a dot, a sun, a cone), its number,
  the selected one thicker; the ring's radius follows `dist` (larger in front, smaller behind); a spot draws a dashed
  line to its aim handle; the fitted original light as a grey ring with "own light" (§4.1); a hidden light dashed.
  `drawAlways` off: nothing when another tool is active, nothing in exports (the overlay is view-only, like the boxes).
- A drag moves the light (or the spot's aim); **Alt + drag up / down changes Close/Far**, the wheel over a handle its
  diffusion (Shift: intensity); a click on empty canvas adds a light there when fewer than four (R-D6); Delete removes
  the selected light; Escape deselects; the arrows nudge; a double click opens the colour (the Kelvin select).
- During a drag the preview runs on `filterPreview` (`:2100`, the low-resolution pass) with the **quick** cache (a
  quarter-size shadow map, §4.2); on pointer up the full maps are computed and one undo step is pushed ("Move light",
  "Add light" ...); the row's sliders show the selected light.
- `host.depthSupported` false (the node, no helpers): the tool and the filter are hidden, as haze's depth types are.

### 4.6 The routes

The relight layer's row holds a **route select** (`params.route`: `app` | a relight recipe id with its provider) and
a *Render* button; the in-app route needs no button (the layer is the result). The generative routes read the same
lights; their preview is the in-app shader; *Render* sends and the answer lands as a **pixel layer** named "Relight
(<route>)" above the picture, under the top run of filter layers, one undo step, through the whole-picture pattern of
`realismWhole` (`host.js:2831`: `encodeComposite({ forRun, upTo })`, the run token, `readSig`, the landing) made
generic as `host.relightWhole(editor, layer, { route, deadline })`; the relight filter layer is **hidden** (not
removed) so *Render* can run again with new lights, and its params keep `last: { route, seed, ms }`.

Relight recipes are provider recipes with **`task: "relight"`** (the `task: "upscale"` precedent, `docs/RECIPES.md`
:1088; `runProvider`'s switch at `host.js:2992-2997`), one file `recipes/relight.json` with a variant per host, so the
route select is `upFillRecipes` / `upFillProviders` of the Upscale dialog in small (`shell.js:1861`). The recipe's
`limits` cap what goes out (the whole picture scaled to the route's long side, never a crop).

| Route | Sends | Settings rows | State |
|---|---|---|---|
| **app** | nothing | - | §4.1-4.5 |
| **magnific** `image-relight` (`POST /v1/ai/image-relight`, polled at `/{task-id}`; the schema in `tools/refs/magnific/image-relight.json`, saved 2026-10-11 from the OpenAPI document; the adapter's dialect table `ROUTES`, `magnific.js`) | `image` (base64), **`transfer_light_from_lightmap`** (the light map, §4.2: black where no light reaches, the lights' colours and shapes, the ambient as the floor), `prompt` (the words of `lightsToWords` plus the user's text), `light_transfer_strength` (the dialog's *Strength*, default 100), `change_background: false` (always: the picture is the scene), `interpolate_from_original` (a switch, default off), `style` (a select, default `standard`), `preserve_details` (default true), `advanced_settings` only when the user opened them (`engine`, `transfer_light_a`, `transfer_light_b`, `fixed_generation`; whites / blacks / brightness / contrast / saturation left out) | Strength, Style, Preserve details, Interpolate | the adapter exists (two upscalers ran live); this route never ran; the long-side cap is not in the schema: 2048 until measured |
| **comfyui** local: `recipes/relight_qwen_local.json` on Qwen-Image-Edit-2509 with the LoRA `Qwen-Image-Edit-2509-Relight.safetensors` (dx8152, Apache-2.0, trigger "重新照明" = Relight; recommended with the Lightning LoRA `lightx2v/Qwen-Image-Lightning`) through `LoraLoaderModelOnly` × 2 on the 2509 chain (`TextEncodeQwenImageEditPlus`, the shape of `recipes/cloud_qwen_image_edit_2509.json`) | the picture as image 1 and the prompt `Relight: <lightsToWords>` + the user's text | the LoRA strength, the steps | needs the 2509 checkpoint and both LoRAs on the user's ComfyUI (the model rows link them; the missing-file refusal of issue #4 covers it); the user has Qwen Image Edit 2.1, whose LoRAs are not the same family: **not run live unless the user frees ComfyUI** |
| **comfycloud**: the same chain on Comfy Cloud (its catalog holds `Qwen-Image-Edit-2509-Relight.safetensors`; the template `image_qwen_image_edit_2509_relight` is the reference graph) | the same | the same | docs only |
| **fal** `fal-ai/iclight-v2` | `image_url`, `prompt` (the words), `initial_latent` ∈ None / Left / Right / Top / Bottom from the first light's position, `enable_hr_fix: true`, `image_size` the picture's aspect | - | adapter exists; direction words only |
| **fal** `bria/fibo-edit/relight` | `image_url`, `light_direction` ∈ front / side / bottom / top-down, `light_type` from Bria's list (midday, blue hour light, low-angle sunlight, sunrise light, spotlight on subject, overcast light, soft overcast daylight lighting, cloud-filtered lighting, fog-diffused lighting, moonlight lighting, starlight nighttime, soft bokeh lighting, harsh studio lighting) | Light type (a select) | re-renders at about 1 MP (the Comfy node's note): the ratio landing is what saves it |
| any edit model by prompt | exists today (Generate with "relight ...") | - | not a route of the layer |

**`lightsToWords(lights, { size })`** (pure, Node-tested): the first light on gives the direction (left / right /
above / below / front, from its position against the picture's centre and `dist`), its colour the words (warm 2700 K,
neutral, cool 8000 K, or "a <colour> light"), its diffusion soft / hard, its type ("sunlight", "a spotlight", "a
light"); further lights are listed; the result also carries `latent` (iclight's enum), `bria: { direction }`, and a
`prompt` sentence such as "Relight: a soft warm light from the upper left, a cool rim light from behind on the right".

**Detail from the original** (a switch on the generative routes, default on, R-D8): the answer `R` comes back at the
route's size; the picture `P` is scaled to it; the ratio `R / max(P, ε)` per channel (clamped 0.2..5) is upsampled to
the picture with the guided filter against the full-resolution picture (`guidedFilter`, `inpaint_depth.js:213`, r 8,
eps 1e-3, in the worker) and multiplied onto the full-resolution picture: the model's light, the picture's detail (the
forum's first complaint). Off: the answer itself, stretched to the picture as `realismWhole` stretches by a pixel.

### 4.7 Commands, policy, settings, docs

- **`relight`** command (`renderer/commands.js`, beside `realism_pass` :1357): `{ doc, layer?, lights?, original?,
  ambient?, depth_scale?, shadows?, route?, prompt?, timeout }`: without `layer` adds a relight layer (the depth map
  computed first when missing, through `ensureDepthMap`, `:12354`: an agent needs no second call), sets the lights
  (`normalizeLights`), and for `route != "app"` renders and lands the pixel layer; answers `{ layer, lights, fit:
  { direction }, route, seconds, notes }`. The lights' edits after that go through `set_filter`.
- **Policy** (`electron/main/assistant/policy.js`): `relight` AUTO for `route: "app"` (or no route), ASK with a card
  for a paid route ("relights the whole picture through <route>: this costs money, or queues on your ComfyUI"), the
  `upscale` row's shape (:157); `RUNS` (:21) and `TIMEOUT_DEFAULTS` (:343, 600) take it; `tools/assistant_test.js`
  counts it.
- **Settings:** `settings.relight` holds the relight panel's values the user picked, flat (`{ strength, style, detail,
  light_type, lora_strength, ... }`, written by `host.setRelightSettings`; the defaults live in `host.relightSettings`,
  never in the file; `docs/PLAN_RELIGHT_FIXES.md` F3); the Magnific rows in the layer's route block, not in Settings.
- **Menus:** *Layer › New relight layer* (the Add Filter list has it too, under the depth filters), *Image › Relight*
  as the same entry; the tool column's L.
- **Docs:** `docs/MANUAL.md` a "Relight" section after "Filter layers" (:260): the lights, the types, the sliders, the
  routes and their costs, what the in-app route does not do (§3), the depth map's role, the detail switch;
  `docs/COMMANDS.md` through `tools/commands_doc.py`; `docs/RECIPES.md` "Relight recipes (`task: "relight"`)";
  `docs/HELPERS.md` (phase 2: the normal model); `docs/TESTING.md` the `relight` gate; the CHANGELOG line per session.

## 5. Sessions

### 5.1 At a glance

| # | Id | Session | Needs | Tier | Days |
|---|---|---|---|---|---|
| 1 | L0a | The light model, pure: `inpaint_relight.js` maths, the fit, `kelvinToRgb`, `lightsToWords`, `normalizeLights`; the JS twins of the two kernels; Node tests | - | L | 1 |
| 2 | L0b | The Rust kernels `height_normals`, `shadow_march` (ABI 19), the dispatch, `tools/px_test.js`, the measurement | L0a | F (kernels) | 1 |
| 3 | L1a | The filter layer: FILTERS row, the GL twin and the CPU twin, the cache and the worker ops, `relightSettled`, `FEATURES`, `filter_types`; sliders only | L0a, L0b | F (pixels on export) | 1.5 |
| 4 | L1b | The row's light block (the list, the selected light's controls, Kelvin, the hint, *Add light*), `set_filter` with lights, the geometry follow | L1a | N | 1 |
| 5 | L2 | The `lights` tool: handles, drag, Close/Far, add / delete, the quick preview, undo steps, the own-light ring | L1b | N | 1.5 |
| 6 | L3 | `relight` command, policy, settings, the menu entries, the gate `relight` (both backends), the manual's section | L2 | N | 1 |
| 7 | L4 | The Magnific route: the light map (`u_mode`), the dialect, the recipe, `relightWhole`, the ratio landing, the route block | L3 | N (+ L for the request shape) | 1.5 |
| 8 | L5 | The prompt routes: the ComfyUI local recipe, the Comfy Cloud variant, fal iclight-v2, Bria; `lightsToWords` wired; `/object_info` hints | L4 | L | 1 |
| 9 | L6 | Docs pass, CHANGELOG, COMMANDS.md, HELPERS.md, the exe-independent gates on both backends, the hand-over for the release | L5 | L | 0.5 |
| 10 | R | **The release** (this account): review of the whole, the user's test, CHANGELOG section, `npm run dist`, exe gates, tag, post, Store, registry | L6 | - | 1 |
| 11 | N1 | Phase 2: MoGe-2 ViT-S normal (ONNX, MIT): registry row, runner, `ed.maps.normals`, the shader reads it when present; the camera (FOV, metric depth) measured | R | N | 1.5 |
| 12 | N2 | Phase 2: `horizon_ao` (Rust), specular (gloss), the spot's gobo (a mask picture), light presets (fal's and Bria's words as presets on the in-app lights) | N1 | N | 1.5 |
| 13 | N3 | Phase 2: the 15k measurement (the shading in tiles, the cache's memory), the perf rows, the tuning | N2 | F | 1 |

Phase 1: about 10 days of sessions to the release; phase 2 about 4. The order L0a → L6 is strict except L5, which
can go before L4 (no shared file).

### 5.2 L0a: the light model, pure

**Goal.** `renderer/editor/inpaint_relight.js` exists with every pure function the later sessions call, tested in Node;
nothing in the app changes yet (the module is imported by nothing).

**Changes.**
- `inpaint_relight.js` (pure ASCII, no DOM at import; `tools/build_node.py` FILES): `LIGHT_MAX = 4`, `LIGHT_TYPES`,
  `KELVIN_PRESETS`, `defaultLight(i, size)` (the first light white 5500 K, in front of the centre, `dist −30`),
  `normalizeLights(list)` (clamps, drops unknown fields, at most four, ids `light_1..`), `kelvinToRgb(k)` (a Planckian
  approximation, linear RGB, 5500 K = (1, 1, 1) after the normalisation; a hex colour through `hexToRgb` and the sRGB
  → linear transfer), `lightToMap(light, map, params)` (the light's position in map pixels and its `z`, §4.1),
  `fitOriginalLight(small, normalsSmall)` (§4.1), `shadePixel(...)` (the twin's per-pixel maths, the shader mirrors it),
  `lightsToWords(lights, size)`, `relightStats(small, size, ctx)` (the `wholeStats` provider: samples the normals at 256
  px through `ctx.maps` when the cache is absent it builds them with the JS twin; answers `{ fit, seq }`).
- `renderer/editor/px/kernels_js.js`: `heightNormals(depth, w, h, scale, sigma, out)` and `shadowMarch(depth, w, h,
  scale, light, radius, taps, steps, bias, row0, rows, out)` (the JS twins, §4.3); `kernels.js` exports them (JS only
  until L0b).
- `tools/relight_test.js` (Node): the identity (no lights, original 100 → `shadePixel` returns the input within 1e-6),
  a sphere lit from the left is brighter on the left, the sun has no falloff, the spot's cone ends, a light behind the
  surface lights nothing without wrap, `kelvinToRgb(5500) ≈ 1`, 2700 K warmer than 8000 K, `fitOriginalLight` on a
  synthetic sphere recovers the direction within 10°, `normalizeLights` drops the fifth light and clamps, `lightsToWords`
  for the four corners and a rim light, `heightNormals` on a ramp gives the ramp's normal, `shadowMarch` on a step
  occludes behind the step and not in front, a disc radius softens the edge monotonically.

**Tests.** Light: the Node test, `lint`, `types`. **Docs.** None yet. **Risk.** The fit's robustness: a flat picture
(no normals) must answer `kd = 0`, `ka = mean`. **Effort** 1 d.

### 5.3 L0b: the Rust kernels

**Goal.** `height_normals` and `shadow_march` in `crates/px` (ABI 19), dispatched with the JS twins as the fallback,
measured.

**Changes.** `crates/px/src/relight.rs` (the two kernels, §4.3; the Vogel disc as a const table of 16 taps, `taps`
picks the first n), `lib.rs` exports (`#[no_mangle] pub unsafe extern "C"`), `px_abi_version` 19, `px.js` `PX_ABI` 19
and the two wrappers on `Px` (views on wasm memory, `px_alloc` for the f32 plane in `height_normals`), `kernels.js`
dispatch with `releaseIfLarge`, `tools/px_test.js` (both kernels against the twins on random maps and the edge cases
of L0a, equality within one level), `python tools/build_px.py` both builds then `--check`; the measurement on a 4096²
map and a 1024² map (one light, 32 steps, 4 taps) in `docs/PERFORMANCE.md` (JS vs Rust, the bench's `photo` map or
a ramp with steps).

**Tests.** Full for the kernels (the Node twin test on both wasm builds and the scalar one; no app gate yet). **Risk.**
The band interface (`row0, rows`) must read rows outside the band (the march leaves it): the kernel takes the whole
map and writes its rows only. **Effort** 1 d.

### 5.4 L1a: the filter layer

**Goal.** *Add filter › Relight* on a document with a depth map shows the picture unchanged (the identity); `set_filter`
with a light in the params lights it; an export writes what the screen shows; the CPU twin equals the GL twin.

**Changes.** The `FILTERS` row (§4.4, `type: "custom"` params skipped by the generic builder: check
`buildFilterControls` :18549 for how a custom param is left alone), `registerRelightGL()` registered beside haze
(`inpaint_filters_gl.js:976`, inside the import-cycle guard pattern of `registerHazeGL`: the flag after the call),
`applyRelight` (the CPU twin), the cache (§4.2) with the worker ops `relight_normals` and `relight_shadow` in
`inpaint_worker.js` (dispatch :1202; the ops call `kernels.js` so Rust runs in the worker), `ensureRelightMaps` and
`relightSettled()` on the editor, the export's await (`encodeComposite` / `flattenToCanvas` with `forRun`: grep
`mipsSettled` for the place), the static samplers (the dehaze pattern), `FEATURES` reader 6, `filter_types`,
`normalizeLights` on `set_filter`'s way in (`renderer/commands.js` `set_filter`), the `geometry` follow of the lights'
coordinates, the hint row when the map is missing (the haze pattern).

**Tests.** Full (an export path): `tools/relight_test.py` starts (the `depthfx_test.py` shape: a 600 × 400 document,
a solid base, a depth ramp with a step through `setMap`): (a) the identity at defaults, bitwise; (b) one point light on
the left: the left half brighter than the right, the step's shadow side darker than its lit side; (c) GL against CPU
within 2 levels at scale 1 and at a scaled pass (`glVsCpu`); (d) `original 0` with no lights: the ramp's own shading
flattened (the variance of the luminance along the ramp drops by half); (e) a sun: no falloff (two points at different
distances within a level); (f) a spot: outside the cone unchanged; (g) the cache: moving a light recomputes its channel
alone (the other channels' keys unchanged); (h) an export after a change waits (`encodeComposite` equals
`flattenToCanvas` within 2 levels, and equals the screen's draw); (i) without a map: the filter is a no-op and the hint
shows; (j) the document round trip keeps the lights and reader 6; both backends.

**Docs.** The CHANGELOG line. **Risks.** The `vec4[4]` uniforms (§4.4); the import cycle (the haze lesson of 0.1.46:
the gate asserts the GL twin ran); the cache's memory at 4096² (RGBA8 normals 64 MB + vis 64 MB: measured, released
with the layer, `releaseCaches` knows it). **Effort** 1.5 d (split point: the twins and the cache, then the export
await and the gate).

### 5.5 L1b: the row's light block

**Goal.** The relight layer's row edits the lights without the canvas: the list, the selected light's controls, the
colour, *Add light*, the eye, *Reset*, the trash; every change one undo step; the sliders preview live.

**Changes.** `buildRelightBlock(layer)` (§4.4) in `inpaint_canvas.js` beside `buildLimitBlock` (:18681), called from
`buildFilterControls` for the `relight` filter; the colour row (the Kelvin select, *Custom* with the colour input and
`pickOnce`); the skins (`docs/SKINS.md`: the block's classes in every skin, the `skins` gate); `list_layers` reports the
lights' count and the selected light.

**Tests.** Normal: `relight_test.py` cases (k) the block's controls change the params and push one undo step each,
(l) *Add light* greys out at four, (m) the eye turns a light's contribution off (the bytes equal the layer without
it); the `skins` and `help` gates. **Effort** 1 d.

### 5.6 L2: the `lights` tool

**Goal.** The lights are dragged on the canvas (§4.5), with the quick preview while dragging and one undo step per
gesture; a click adds a light; the picture's own light is shown.

**Changes.** The tool in `inpaint_canvas.js` (the pointer switch :5709-5800, `setTool`, the tool column's button and
key L, the overlay draw in the view's draw pass where the boxes and the film points draw theirs), `ensureRelightMaps(...,
{ quick: true })` on the drag, the full maps on pointer up, the undo labels, the cursor, the status line's hint; the
row's *Edit lights* selects the tool; the tool deselects when the active layer is not a relight layer.

**Tests.** Normal: `relight_test.py` cases (n) a drag through CDP pointer events moves the light and pushes one undo
step ("Move light"), (o) Alt-drag changes `dist`, (p) a click adds a light, Delete removes it, (q) during the drag the
quick cache is used (its `w` is a quarter), after it the full one, (r) the overlay is not in an export; the `editor`
gate unchanged. **Risks.** Pointer events in a hidden gate window (CLAUDE.md "An occluded window ... drops keys": the
gate uses `Input.dispatchMouseEvent` with focus emulation on). **Effort** 1.5 d.
**Built 2026-10-11:** `lights` canvas tool implemented with handles, drag, Alt-dist, wheel diffusion/intensity, arrow nudge, click-add, delete, quick quarter-size preview, and view-only overlays; cases (n)-(r) green in `tools/relight_test.py`; gates `l2_on`, `l2_off`, and `l2_ed` pass.

### 5.7 L3: the command, the policy, the entries, the gate

**Goal.** An agent relights a picture in one call; the assistant asks only for a paid route; the menus have the
entries; the `relight` gate runs in `tools/run_gates.sh` on both backends.

**Changes.** `relight` in `renderer/commands.js` (§4.7, `route: "app"` only in this session: the paid routes answer
"not built yet" until L4 / L5), `policy.js` rows, `tools/assistant_test.js`, `electron/main/settings.js`, the menu
entries (`electron/main/main.js` the Layer and Image menus; `shell.js`'s command switch :3126 pattern), `docs/COMMANDS.md`
(`tools/commands_doc.py`), the `relight` gate in the gates list (CLAUDE.md and `docs/TESTING.md`), the manual's section.

**Tests.** Normal: `relight_test.py` (s) `relight` on a document without a map computes the map through the stand-in
(`host.helperCall` replaced as `editor_test.py:3426-3443` does) and lands the layer, (t) `relight` with `layer` edits
the existing one; the `commands`, `assistant`, `help`, `lint`, `types` gates. **Effort** 1 d.
**Built 2026-10-11:** `relight` command in `renderer/commands.js` with `P.arr` helper; `electron/main/assistant/policy.js` AUTO for in-app route, ASK card for generative routes; menu entries in Image and Layer; MANUAL.md chapter; `relight` gate in `tools/run_gates.sh`; cases (s) and (t) pass in `tools/relight_test.py`.

### 5.8 L4: the Magnific route

**Goal.** *Render* with Magnific sends the picture and the light map, lands "Relight (Magnific)" as a pixel layer with
the detail ratio, in one undo step; the request shape is Node-tested; nothing runs live unless the user is present
with the key.

**Preconditions.** `tools/refs/magnific/image-relight.json` (saved 2026-10-11; the field names of §4.6 come from it).

**Changes.** The light map: `u_mode = 1` in the shader and the twin (the light term alone, ambient as the floor,
tone-mapped, the alpha opaque), rendered through `applyFilterGL` at the route's size (≤ 2048 long side) from a
`pictureInput`-sized pass (the cache at that scale); `magnific.js`: the `relight` dialect in `ROUTES` (the body of
§4.6, `change_background` always false, the poll as the upscalers'), `layout(req)` for the two pictures;
`recipes/relight.json` (`task: "relight"`, `providers.magnific`, `limits`), `docs/RECIPES.md`; `host.relightWhole`
(§4.6, from `realismWhole`: the run token, `readSig`, the landing as a pixel layer under the top filter run, the relight
layer hidden, `last` in its params); the detail ratio in the worker (guided upsample); the row's route block (the select,
*Render*, the Magnific rows, the *Detail from the original* switch); `relight` command's `route`.

**Tests.** Normal + Light: `tools/relight_request_test.js` (Node: the body for one light and for four, `change_background`
false, the advanced block only when opened, a `test-` key goes to the loopback and never to Magnific, the light map's
bytes for a known light on the ramp: brighter near the light, black behind the step); `relight_test.py` (u) *Render*
against the loopback mock lands the layer, hides the relight layer, one undo step, the ratio keeps a 1-px texture of
the base (the base's high-frequency variance survives within 10 %); the `export` gate. **Risks.** Magnific's input cap
for this route is not in the schema (2048 until measured live); the ratio where the model changed content (the switch,
§4.6). **Effort** 1.5 d.
**Built 2026-10-11:** Magnific relight route (`image-relight`) with opaque light map mode 1, dialect body and layout; `recipes/relight.json` with `task: "relight"`; `detailRatio` guided filter ratio transfer in `inpaint_relight.js` and `inpaint_worker.js`; `host.relightWhole` landing under filter run in 1 undo step; `tools/relight_request_test.js` (all 6 suites pass); Case (u) in `tools/relight_test.py` (passes on both tiles and canvas backends).

### 5.9 L5: the prompt routes

**Goal.** The ComfyUI local recipe, the Comfy Cloud variant, fal iclight-v2 and Bria as routes of `recipes/relight.json`,
built from the docs, never run; the missing-file hints on the user's ComfyUI.

**Changes.** `recipes/relight_qwen_local.json` (`kind: "comfy"`, the 2509 chain with the two `LoraLoaderModelOnly`
nodes, the model rows with their download links, the Inpaint Canvas node as every local recipe has it: the whole
picture goes as the crop with `align` off), the Comfy Cloud variant (the template's graph, `comfycloud.js`'s calls),
the fal variants (`fal.js`: two models, `lightsToWords` into `prompt` / `initial_latent` / `light_direction` /
`light_type`), `/object_info` checks for the LoRA files (the issue #4 refusal with the link), the route select's rows.

**Tests.** Light: `tools/relight_request_test.js` extended (the fal bodies, the ComfyUI prompt's LoRA nodes and the
trigger word, the Cloud graph's shape); `recipes` gate. **Effort** 1 d.
**Built 2026-10-11:** `recipes/relight_qwen_local.json` local ComfyUI recipe; `recipes/relight.json` prompt routes (fal IC-Light v2, fal Bria with 13 light types, Comfy Cloud); `fal.js` layout and `relightInput`; `comfycloud.js` relight call; `inpaint_canvas.js` route controls; `host.js` ComfyUI local model checks and prompt execution; `tools/relight_request_test.js` suites 7, 8, 9 pass; `recipes_test.js` (195 checks pass); `relight` in-app gates pass on tiles and canvas.

### 5.10 L6: the docs pass and the hand-over

The manual's section complete (with one figure of the handles, masked keys), `docs/HELPERS.md` (the phase 2 note),
`docs/TESTING.md`, `docs/COMMANDS.md`, the CHANGELOG `## Unreleased` lines joined into the release's paragraphs, the
gates `relight depthfx limit document commands assistant export skins help lint types nodecopy` on both backends, the
hand-over in CLAUDE.md "Where things stand" with the summaries, no push. 0.5 d.
**Built 2026-10-12:** Documentation pass complete: `docs/MANUAL.md` relight section with handles, shortcuts, and routes; `docs/HELPERS.md` phase 2 MoGe-2 normal model note; `docs/TESTING.md` relight gates; `docs/COMMANDS.md` 95 commands regenerated; `CHANGELOG.md` unreleased entries; `renderer/commands.js` route validation; `limit_test.py` R2-S5 dual backend fixes; gates `relight` (16s), `depthfx` (6s), `limit` (7s), `document` (41s), `commands` (15s), `assistant` (34s), `export` (160s), `skins` (8s), `help` (4s), `nodecopy` (12s) PASS on both `--tiles on` and `--tiles off` with `--offline`; node tests and static checks (`lint`, `types`, `build_node --check`, `skins_test`, `manual_test`, `recipes_test`, `relight_request_test`) all clean PASS.

### 5.11 R: the release (this account)

The review of the whole (the Nik pattern, two agents per finding), the user's test of the dev build (the sentences of
§3 said beforehand), the CHANGELOG section, `npm run dist`, the exe gates (`relight` among them), the tag, the post on
the website, the Store update, the registry's `server.json`, the node build only if a node version ships.

### 5.12 N1-N3: phase 2 (after the release, on the user's word)

- **N1 the normal model:** `Ruicheng/moge-2-vits-normal-onnx` (MoGe-2 ViT-S normal, MIT; the DINOv2 encoder Apache-2.0;
  the ONNX graph holds `forward()` alone: inputs `image` [1, 3, H, W] (and `num_tokens` in the dynamic export), outputs
  `points`, `normal`, `mask`, `metric_scale`; the post-processing of `.infer()` (the focal and shift recovery, the
  reprojection) is not in the graph): the registry row (`models.js:64` pattern, `kind: "normals"`, the file's size and
  SHA from the download, the user's yes), `electron/main/onnx/normals.js` (the `depth.js` shape; the normalisation as
  MoGe's `infer` does it, read in the repo before the build), IPC `helpers:normals`, `host.computeNormals`,
  `ed.maps.normals` (a DocMap of kind `normals`, RGBA8 like the guide; `mapToJSON` with `genc: "rgba8"`; `FEATURES`
  `maps-normals`), the shader reads `u_normals` from the map when present (the height-field normals as the fallback and
  for the shadows' bias), the `relight` gate's stand-in; measured against the height-field normals on the user's
  pictures. Then the camera: `metric_scale` and the points' shift recovered as the repo does (a Node port of
  `recover_focal_shift`), the perspective 3D point in the kernels and the shader behind a switch, judged by eye.
- **N2 looks:** `horizon_ao` (Rust), a gloss term (specular, per light, default off), the spot's gobo (a mask picture
  from a layer, the forum's request), light presets (the fal and Bria words as named presets that place the in-app
  lights), *Hide handles* (the forum's request) as a view toggle.
  **Built 2026-10-12 (N2):** 8 studio/atmosphere light presets (`LIGHT_PRESETS`, `applyLightPreset`) with dropdown UI and single undo step; Blinn-Phong specular gloss term ($0..100\,\%$, default 0) with 100% mathematical parity between JS twin and WebGL2 shader; procedural spot gobo patterns (`none`, `blinds`, `window`, `leaves`, `stripes`) in JS and GLSL; hide handles view toggle (`H` shortcut and eye button in relight controls header); `tools/relight_test.js` suites 14-16 pass; `tools/relight_test.py` cases v, w, x, y pass; `relight` in-app gates pass on both `--tiles on` (15s) and `--tiles off` (15s).
- **N3 the 15k measurement:** `perf:15000x10000` and `exportperf` rows with a relight layer, the cache's memory
  (`tools/mem_test.py --map`), the tile seams at 33 MP, tuning (steps and taps by map size).
  **Built 2026-10-12 (N3):** Measured 15000x10000 (150 MP) document with relight filter layer and 4096 depth map: `perf:15000x10000,--filter=relight` (46s: filter tick 15.7 ms, pan at 60 fps 0.2 ms, pan at 1:1 0.3 ms, brush dab + frame 0.8 ms, undo step 33.4 ms, full composite 283.4 ms, compositor memory 94.8 MB in 82 atlas pages); `exportperf:15000x10000,--filter=relight` (23s: composite_bands 1658 ms [blocked 232 ms, 11.3 MB], layer_from_tiles 738 ms, psd 2138 ms, 1233 pool jobs completed with 0 errors); `mem:6000x4000,--rounds,2,--map,4096x2731` (22s: 704/707 canvases collected, 0 textures leaked, 0 pool leaked, pan 3.64 ms, levels tick 8.13 ms).

## 6. Open questions for the user (ask before the session that needs them)

- **R-D1 (L3-L5) Which generative routes?** Suggested: Magnific (the light map fits best) first; the Qwen LoRA local
  and on Comfy Cloud; fal's iclight-v2 and Bria as the two word routes. No IC-Light SD 1.5 (decided 2026-10-09); IC-Light
  v2's weights are still not public (checked 2026-10-11), fal is the only way to it.
- **R-D2 (L1a) decided here:** the in-app route is a filter layer `relight` (the lights in its params, re-editable,
  maskable, limitable, undoable per change); a generative route lands a pixel layer and hides the filter layer.
- **R-D3 (N1) The normal model** in phase 2 (suggested): the height-field normals are judged on the user's pictures
  after L2; if they fail on faces (the gradient of relative depth is flat on a nose, a cheek), N1 moves before L4.
- **R-D4 (L1a) Shadows** on by default at 60 % (suggested; behind the slider, 0 turns the march off): the quality on
  relative depth is the unknown; judged by eye after L2.
- **R-D5 decided here:** the lights live in the filter's params; reader 6.
- **R-D6 (L1a) Four lights** (one RGBA8 visibility texture; eight would be a second texture, 64 MB more at 4096²).
  Photoshop allows three.
- **R-D7 (L2) The gestures:** Alt + drag for Close/Far and the wheel for diffusion (suggested), or sliders only.
- **R-D8 (L4) *Detail from the original*** on by default (suggested): the model's light on the picture's own pixels;
  off gives the model's pixels.
- **R-D9 (L1a) The defaults:** the first light white 5500 K, 100 %, diffusion 30, in front of the centre (`dist` −30),
  *Original light* 100 (the picture as it is until a slider moves), *Ambient* 15, *Depth* 50.

## 7. Risks and traps

- **Relative depth.** Depth Anything answers disparity; the height field is a look, not a measurement: the *Depth*
  slider is the user's knob, and MoGe-2's metric depth (N1) is the fix. A light "inside" an object (the forum's case)
  is `dist` near 0 on a texel whose neighbours are nearer: the march's `bias` keeps the surface from shadowing itself.
- **The delight is a fit, not a decomposition.** On a scene with several lights or a sky, *Original light* flattens
  less than Photoshop's; the manual says so. The intrinsic decomposition models that would do it properly are either
  academic-only (Careaga & Aksoy, `compphoto/Intrinsic`), RAIL++-M-licensed diffusion models (Marigold IID Lighting,
  about 2 GB, seconds per picture on a card, not for an instant filter), or non-commercial (RGB↔X, UniRelight): none
  goes into the app; a ComfyUI recipe on Marigold IID could serve a later "Original light" of a different quality.
- **The import cycle** of `inpaint_filters_gl.js` (haze's and lens blur's twins were never registered before 0.1.46):
  the gate asserts `applyFilterGL` returns a result before any GL-against-CPU comparison.
- **The cache's memory**: two RGBA8 planes at the map's size per relight layer (128 MB at 4096²); released with the
  layer, dropped by `releaseCaches`, rebuilt on demand; a second relight layer shares nothing (two layers = two caches;
  fine, rare).
- **Exports must wait for the cache** (§4.2); the canvas backend's `flattenToCanvas` is synchronous: the CPU twin
  computes the maps itself when the cache is missing, which is slow but right.
- **`texSubImage2D` and the SharedArrayBuffer** (CLAUDE.md): the cache's planes may live in a SAB (a worker wrote
  them): the upload takes a view, both unpack switches set.
- **Magnific**: `transfer_light_from_lightmap` and `transfer_light_from_reference_image` exclude each other; every
  call costs credits whatever the plan; the input cap of this route is unknown (2048 until measured); `change_background`
  defaults to true on the API and must be sent false.
- **The Qwen LoRA** is for Qwen-Image-Edit-2509; the user's local Qwen Image Edit 2.1 is a different checkpoint
  family: the recipe names 2509 and its files, and refuses with the links when they are missing (issue #4's path).
- **Pointer gestures in gates** (L2): focus emulation on, `Input.dispatchMouseEvent` in image coordinates through the
  view's transform; a test that reads the screen canvas after a drag uses real pointer events, not a composite
  (CLAUDE.md "Canvas copy trap").
- **Reader 6**: a document with a relight layer needs 0.1.47; an older reader shows the layer as unknown and keeps it.

## 8. Sources (read 2026-10-11)

- Adobe's announcement: https://community.adobe.com/announcements-698/relight-is-now-available-in-photoshop-beta-1644153
- The complete guide (the controls, credits, bit depth, resolution): https://photoshoptrainingchannel.com/relight-layer-photoshop/
- The workflow and the off-canvas placement: https://photoshopcafe.com/how-to-use-relight-layer-in-photoshop-to-change-lighting/
- The reviews: https://fstoppers.com/photoshop/photoshop-can-now-move-light-your-photo-904920,
  https://www.iso1200.com/2026/10/photoshop-betas-relight-change-lighting.html,
  https://www.creativebloq.com/design/graphic-design/photoshops-newest-ai-tool-is-immediately-dividing-opinion
- Magnific relight: the OpenAPI document `magnific-api-v1-openapi.yaml` (the `relight-request` schema, saved to
  `tools/refs/magnific/image-relight.json`); the Comfy partner node `MagnificImageRelightNode` lists the same fields.
- fal `fal-ai/iclight-v2`: https://fal.ai/models/fal-ai/iclight-v2/api; Bria: https://fal.ai/models/bria/fibo-edit/relight/api
  and the Comfy partner node `BriaRelight` ("re-renders the whole frame at about 1 megapixel").
- IC-Light v2 weights still unreleased: https://github.com/lllyasviel/IC-Light/issues/139.
- The Qwen LoRA: https://huggingface.co/dx8152/Qwen-Image-Edit-2509-Relight (Apache-2.0); Comfy Cloud's catalog lists
  `Qwen-Image-Edit-2509-Relight.safetensors` and the template `image_qwen_image_edit_2509_relight`.
- MoGe-2 ONNX: https://github.com/microsoft/MoGe/blob/main/docs/onnx.md (`Ruicheng/moge-2-vits-normal-onnx`, MIT).
- Marigold IID (code Apache-2.0, weights RAIL++-M): https://huggingface.co/prs-eth/marigold-iid-lighting-v1-1;
  Careaga & Aksoy (academic use only): https://github.com/compphoto/Intrinsic.
