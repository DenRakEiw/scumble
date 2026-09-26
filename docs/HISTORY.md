# History of the session hand-overs

The session hand-over blocks that used to live in CLAUDE.md, newest first, verbatim. They are a record: line numbers, 'next steps' and states in them are stale; `docs/PLAN_BCE.md`, `CHANGELOG.md` and `docs/BUGS.md` are the maintained records.

The blocks of 2026-09-19 to 2026-09-23 were moved here on 2026-09-26 (CLAUDE.md keeps a condensed "Open threads" section and the open items of the list).

The block of 2026-09-26 (evening) and the full text of the list were moved here late on 2026-09-26, when package 3b was built (CLAUDE.md keeps a short "Where things stand" and a condensed list).

## Where things stand (2026-09-26, evening)

**0.1.29 is Latest** (published 2026-09-26 18:07 German time on the user's word "3a und dann release"): skins,
Magnific, Oxen.ai and quit safety (3a); exe gates `--offline` ALL PASS on both backends (`rel29-exe`,
`rel29-exe-canvas`); dev blog post "Close it, it waits now" (`v0-1-29`, portfolio `db4197d`, with the manual sync).
Done of the plan below: **1 skins** (`2471831`, the review's ask-card bypasses fixed: `protectAsk`), **2 providers**
(`7425173`), **3a quit safety** (`9d81033`, gate `quit`, `electron/main/quit.js` and `autosave.js`). **Next, the
user's order: 3b to 3f** - the `.scumble` format first (the biggest: save / save as, dirty marker, close asks, recent
files, file association), then the history panel, TIFF, PSD masks, the metadata switch; then packages 4 to 6. The
design pass of package 3 of the morning died with the usage limit; **3b's design is `docs/PLAN_DOCUMENTS.md`** (read it
first), with the user's answers of 2026-09-26 (§9: Ctrl+S saves the document, Ctrl+Shift+S Save As, Ctrl+Shift+E
exports; the result history goes in the file with a switch in Save As; fonts the user added travel; no question on
quit). **Package 3b (the `.scumble` format) is built, D1 to D5** (all local, not pushed, not released;
`docs/PLAN_DOCUMENTS.md` "D1 built" to "D5 built" say what was checked): D1 `ec01d08` the container (`electron/main/docfile.js`); D2 `e959cda` save / open / Save As
(`electron/main/documents.js`, plugin API 2 `documents.data`, the glb plugin per document, an unknown filter id kept);
D3 `a6b38df` the dirty "*", close asks, Reopen Closed Tab (Ctrl+Shift+T), Open Recent, the history question on Save
As, the drop, the progress chip, the manual chapter "Documents"; D4 `b2804a1` the file association (NSIS + MSIX), argv
and the second start, `save_document` / `open_document` and their policy rows; D5 `1159345` + `01f06cf` + the commit
after it: the format spec `docs/DOCUMENTS.md`, hardening from its review, the gates `document` (steps 1-8, 11),
`docux` (9, 10, 12) and `docperf:WxH` (15k: a 457 MB file written in 0.4 s, opened in 5 s on tiles), both backends,
mutation rounds 18/18 (Node), 10/10 (`document`), 6/6 (`docux` / `docperf`). Not checked by anyone: a double click in
Explorer (needs an installed build: the user's word), a key on a real keyboard. **Next, the user's order: 3c** (the
history panel), then 3d TIFF, 3e editable PSD masks, 3f the PNG metadata switch; whether 3b ships as a release of its
own is the user's call.
Still open for the user: Ctrl+S as "save the document" (plan, open questions), LaMa shipped or downloaded, releases
per package or bundled (0.1.29 was one release for three packages).

**The user decided a large build on 2026-09-26, and it is `docs/PLAN_0_1_29.md`** (read it first): (1) skins
(item 20) with two example skins named **"90s"** (a late-90s media-player look, own artwork, no Winamp marks) and
**"Duck"** (after Pollen Robotics' Microduck, its press-kit palette); (2) **Magnific as a full provider** (M1) and
**Oxen.ai** (O1, item 16); (3) **documents and safety** - an own document format (`.scumble` proposed) that reopens
fully editable, quit safety (a quit or update install skips the pixel flush today), a history panel, **TIFF** open
and save, editable PSD masks, a switch for the PNG metadata; (4) **brushes** - smudge / clone / heal fast at 15k, a
pro smudge, flow, pressure curves, a larger size cap, frequency separation with the linear light mode, dodge and
burn; (5) **repair, remove, liquify** - a Poisson healing brush, an in-app LaMa remove brush, patch, liquify;
(6) **layers pro** - multi-selection with align, clipping, mask operations, groups. Built in that order, each with
gates on both backends and a checkpoint commit; about 60 to 100 working days by the review's estimates. Moved to the
later list the same day: the masks-and-selections and grading-and-panels packages (into item 22) and rotating the
document (item 23). The review's findings that are bugs went to `docs/BUGS.md` ("Found by reading on 2026-09-26").

## What comes next (the list, as of 2026-09-26, full text)

The numbered list the user adds to. Items 1 to 13 are built and their text is in `docs/HISTORY.md` (the block of
2026-09-19); the numbers are kept because other documents cite them.

5. **The object tool's bigger change A** (`dist/c6map/c/objects.md` §7 to §9: the image-size label map, the per-object
   shape canvases): parked by the user on 2026-09-18 (if the coarse outlines at 15k turn out to matter, compute the
   label map only in the hovered object's box, on demand).
14. **Upscaling, a future feature (asked for by the user on 2026-09-21; parked: only on the to-do list, not planned
   in detail, not built, nothing below verified).** Upscale the document, a layer or the selection by a model, in
   three routes the user named: (a) **through the user's ComfyUI**, as a recipe with `UpscaleModelLoader` +
   `ImageUpscaleWithModel` (`comfy.js` already lists `UpscaleModelLoader` models for the recipe settings), the models
   the user already has in `models/upscale_models`; (b) **in the app**, on the ONNX Runtime the helpers already use,
   with upscale models downloaded or read from the linked ComfyUI `models/` folder (only ONNX files load there; the
   usual `.pth` / `.safetensors` upscalers need an ONNX export, as the helper scan of 2026-09-12 found for SAM2 /
   RMBG), tiled for large pictures; (c) **API upscaling**, e.g. Topaz Labs and Magnific, as provider adapters with
   key rows like the other providers. **Asked, to be checked before planning:** whether a **locally installed
   Topaz** (Gigapixel / Photo AI) can be driven from Scumble, e.g. through a command-line interface of the desktop
   app (which products and licences offer one, what it takes and returns), and whether it can go **over MCP**:
   either an external agent chains Scumble's own tools (`export` -> Topaz -> `load_image` / `add_image_layer`), or
   Scumble calls a Topaz-side MCP server or CLI itself. Also to decide: where the result lands (the whole document
   resized, which clears undo like *Resize*, or a new layer), the size limits (a 4x of a 15k picture is past the
   65,535 px side and the gigapixel cap), and whether the assistant's policy asks before an upscale (it costs money
   on an API and queues on ComfyUI, so yes by the existing rule).
15. **Qwen Image Edit 2.1, a model to support (asked for by the user on 2026-09-21). The local ComfyUI recipe is
   BUILT and shipped in 0.1.23 (`recipes/qwen_image_edit_2_1_local.json`, not run yet); the API side below is open.** Today `recipes/qwen_image_edit.json` runs older Qwen edit endpoints (fal
   `fal-ai/qwen-image-edit/inpaint` with a mask, Replicate `qwen/qwen-image-edit`, WaveSpeed
   `wavespeed-ai/qwen-image/edit-plus`) and, on ToAPIs and Comfy Cloud, Qwen Image 3.0; there is no local Qwen recipe.
   **To find out before building:** which providers serve 2.1 and under which ids (fal, Replicate, WaveSpeed,
   OpenRouter, ToAPIs, ModelArk is ByteDance only), whether any of them takes a mask, its size limits and input count
   (the `limits` block needs a source, not the 2048 default), its price; whether it is a new variant in
   `qwen_image_edit.json` or a recipe of its own; and whether open weights exist for a **local ComfyUI recipe**
   (which nodes, text encoder and VAE). Each new variant gets its row in the `recipes` gate.
16. **Oxen.ai as an API provider (asked for by the user on 2026-09-21, https://www.oxen.ai/ai/models; on the list only,
   not built, not run against the live API).** An aggregator of "200+ models through one API", like fal or OpenRouter.
   What its docs said on 2026-09-21 (`https://docs.oxen.ai/llms.txt`; the models page itself sits behind a Vercel
   browser check and could not be read by script): base `https://hub.oxen.ai/api/ai`, a Bearer key; **image edit**
   `POST /images/edit` with `model` (e.g. `qwen-image-edit`, `nano-banana-2-edit`, `gpt-image-2-edit`,
   `xai-grok-imagine-image-edit`), `prompt`, `input_image` (a URL or, for some models, an array of URLs) and
   `response_format` `url` / `b64_json`, answered in the same request (`images[0].url`); **image generation** for
   "Generate new" at `/images/generate`; an **async queue** for long jobs; `GET /models` and `/models/search` list the
   models; per-model parameters on a "model references" page; **chat completions** OpenAI-compatible at the same base
   (streaming, vision, tool calling), so it can also be a row of the LLM / assistant registry (`providers.js`,
   `llm_custom.js`) for prompt upsampling and the assistant. **To find out before building:** whether `input_image`
   takes a data URL or needs a hosted file (then an upload step and a privacy note like ToAPIs'), whether any edit
   model takes a mask, the per-model size limits and input counts (the `limits` block needs a source), prices and
   balance endpoint, where the data goes and what is kept, and which of the recipes' models it serves (an `oxen`
   variant in each, last, no default changed, like OpenRouter). Pieces as for every provider: an adapter in
   `electron/main/providers/`, a key row, `docs/RECIPES.md`, a plain-Node test of the request shape, a loopback mock
   and a gate.
17. **A side panel of adjustable width (asked for by the user on 2026-09-21, with a screenshot). The horizontal
   scrollbar is gone since 0.1.23 (panel 320 px, rows that fit); the drag handle below is still open.** The panel right of the canvas (Image / Generate tabs, the layer list) is a fixed `.ipc-side { width:290px }`
   in the editor's `STYLE` (`renderer/editor/inpaint_canvas.js`), and an expanded layer row (Opacity, Match with its
   *surroundings* select, Blend, Role, the cutout row) is wider than that, so the layer list and the reference list
   get a horizontal scrollbar. The wish: drag the panel's left edge to make it wider or narrower. Assessed as small
   (about half a day with a gate step): a drag handle on the left edge that sets the width (a CSS variable, clamped,
   e.g. 240 px to half the window), the width kept per install (the app's settings; the node could keep it in
   `localStorage`), and `resizeCanvas()` called while dragging, which already refits the view when its size changes;
   editor code, so `build_node.py --check` and `nodecopy`, and a step in `editor_test.py` (drag, width kept after a
   reload, view refitted, no horizontal scrollbar at the default width). **Independent of it and smaller:** the
   expanded row could wrap or shrink its controls so no horizontal scrollbar appears at 290 px at all.
18. **A logo for Scumble: DRAWN on 2026-09-22 (for 0.1.27), the mascot is open.** `build/icon.svg` is the source
   (plus `icon-small.svg` for 16 / 24 px, `icon-tile.svg` for macOS, `icon-plain.svg` without a background),
   `build/icon.png` is 1024 px and `build/icon.ico` holds 16 to 256 with **the small sizes drawn separately**
   (PNG entries, written by hand because PIL resamples one picture for every size). It is a creature made of
   sienna paint (`#C4643A`) over a chalk stroke (`#EFE7DA`) on near-black brown (`#1B1714`), the stroke showing
   through its body as `#D08967`: the name's meaning as a figure. The colours came from a survey of the field
   (Photoshop owns `#001E36` / `#31A8FF`, Affinity purple, Krita magenta / cyan), the legibility from measuring
   every candidate at 16, 24, 32 and 48 px: an S mark read best at 16 but the user chose the creature
   ("Der Klecks ueberall"), which holds to 24 px and below that is a coloured blob with a light band. The old icon
   is kept as `build/icon-0.1.26.png`. **Open:** the mascot's other poses (a six-expression sheet exists as
   generated drafts only), the website and the About dialog. The original wording of this item:
   there was no vector source and no 1024 px master. A logo means: a mark that reads at 16 px (taskbar, tab, tray) and at 1024 px (macOS icns,
   the website), a vector source (SVG) committed under `build/`, the exports electron-builder needs (`icon.png` at
   1024, `icon.ico` with 16 to 256, later `icon.icns`), the About dialog, the README and the website
   (`F:\portfolio_web`, the Scumble pages). The name's idea (a thin semi-opaque layer over a dry one) is the obvious
   starting point. Who designs it, and whether a draft comes from here first, is the user's call. **B3 waits for
   it** (the macOS icon needs the 1024 px master).
19. **3D layers from AI models (asked for by the user on 2026-09-23; on the list only, not planned, not built).**
   Scumble already has 3D layers: the `glb` plugin (`plugins/glb/`, `glb.place` / `glb.edit` / `glb.info`,
   `docs/COMMANDS.md`) renders a `.glb` / `.gltf` into a layer by position, distance, rotation and scale and keeps it
   editable. The idea: make the model itself with an image-to-3D (or text-to-3D) model, from a selection or a layer
   (a cut-out object) or a prompt, and place the answer as a glb layer, so an object can be turned, relit and put back
   into the picture; the inpainting models then blend it in. Routes to check: the **Comfy Router** serves Meshy
   (`meshy/meshy-5` .. `meshy-7.1`, `remesh`, `rigging`, `animations`) and Tencent Hunyuan 3D (`hunyuan-3d-part`,
   `-smart-topology`, `-texture-edit`, `-uv`; no plain image-to-3D there on 2026-09-23), all on the same Comfy key
   (`comfyrouter.js`, one more dialect); fal and Replicate host TRELLIS / Hunyuan3D / Tripo-style image-to-3D; a local
   ComfyUI recipe (Hunyuan3D 2.x nodes) is a third way. **To find out before planning:** which models take one image
   and answer a textured GLB (not only a mesh), the answer's size and format (GLB or a zip of OBJ + textures), the time
   (minutes: the queue and its 30-minute wait fit), the price, and whether the glb plugin's renderer shows the
   answer's PBR materials well enough that the result is worth inpainting over.
20. **Skins: a docking point for custom app looks (asked for by the user on 2026-09-25; BUILT on 2026-09-26,
   `docs/SKINS.md`, `docs/PLAN_0_1_29.md` §1; the example skins are named "90s" and "Duck" by the user).** Developers drop a skin into a folder and the app wears it. **The user's
   answers:** the app only (not the ComfyUI node, so `build_node.py` / `nodecopy` stay out of it except where the
   editor's shared `STYLE` is touched), and ship example skins from the start - a **Winamp-like** look and a look after
   Pollen Robotics' / Hugging Face's **Microduck** robot (palette from https://pollen-robotics.com/microduck/press-kit/).
   **What the code has today (2026-09-25):** not one CSS custom property. 89 distinct colours are hard-coded in four
   places: `renderer/shell.css` (151 colour values), `assistant.css` (67), `help.css` (46) and the editor's `STYLE`
   string in `renderer/editor/inpaint_canvas.js` (lines 929 to 1128); on top, 68 `fillStyle` / `strokeStyle` colours
   drawn on canvas (the selection blue `#7cc7ff`, rulers, labels), 22 inline styles set from JS in the editor and
   `inpaint_modal.js`, 4 in `shell.js`, and `backgroundColor: "#181818"` in `main.js`. The icons are SVG with
   `currentColor` and follow by themselves. The CSP (`renderer/index.html`) allows inline styles and keeps `url()` to
   `'self'` / `scumble://app`, so a skin cannot phone home. **The shape agreed in the brainstorm:** (1) **tokens
   first** - about 25 to 30 CSS variables (`--sc-bg`, `--sc-surface`, `--sc-fg`, `--sc-muted`, `--sc-accent`,
   `--sc-danger`, `--sc-selection`, `--sc-border`, `--sc-radius`, `--sc-font`, ...) replacing the 89 colours, the
   default theme pixel-identical to today (a screenshot gate on both backends), canvas overlays reading the tokens
   through `getComputedStyle` once per theme change; worth it on its own (a light mode, contrast, Store screenshots).
   (2) **a skin is a plugin without JS**: a folder with `plugin.json` (`"registers": ["skin"]`), a `skin.css` and its
   own images and fonts, picked in a *Settings > Appearance* section and switched live through the existing *Reload
   plugins* path. The tokens are the stable contract (a `docs/SKINS.md`, versioned, a gate that every token exists);
   **free CSS on top is allowed** (a Winamp look needs gradients, bevels, an LCD panel, a pixel font, bitmaps - tokens
   alone cannot do it) and marked unstable, like app modules for user plugins. No JS in a skin. **Protected from
   skins:** the assistant's ask cards (a skin must not hide a question before a paid run), the masked API keys, and
   the selection outline's contrast on white (`editor_test.py` has that case). (3) optional later: a theme editor in
   the Settings (a colour picker per token, export as a skin folder), light / dark after the OS (`nativeTheme`), a
   compact density, icon sets. **Open, the user's call:** the names of the two example skins - "Winamp" and
   "Microduck" are other people's marks and a shipped skin under that name reads as an endorsement, so the brainstorm
   suggested the look without logos or original artwork under own names (e.g. "Amp '98", "Duckling"), the same rule
   as the film names (real names only in the film presets); for Microduck, asking Pollen Robotics / Hugging Face
   whether an official skin is fine is an option. **Rough effort (not measured):** 4 to 5 days - tokens 1.5 to 2, the
   docking point with assets about 1.5, the two example skins about 1; the theme editor extra. **Order:** after B3
   (macOS), not before.
21. **Lens flares, "something like Flarecore" (asked for by the user on 2026-09-25; brainstormed only, OPTIONAL, not
   planned in detail, not built).** https://github.com/cyco-creates/Flarecore is a ComfyUI node pack (Apache-2.0,
   PyTorch in linear light, one author, 0.2.0 beta 1 at `5e8f2bb` of 2026-09-18). **The user's reason:** rarely used
   ("eher nicht so oft"), it is feature completeness for a pro tool. **What a 10-agent brainstorm found (read through
   the GitHub API, nothing cloned or run):** the engine is a sum of analytic per-pixel fields along the axis from the
   light P to a movable anchor E (`P + t(E-P)`; `flare/elements.py` 146-525: glow (Moffat), iris (n-gon by angular
   folding, roundness, hollow, coma, crescent), streak, ring, hoop, glint rays, orbs, spectral, texture); no FFT, no
   model. 72 presets (not the README's 74), 732 elements: glow 271, iris 211, streak 74, glint 74 (86 % together),
   texture 49 (using only 10 of the 197 PNGs). The 197 PNGs (78.1 MB) are AI-generated (3 carry OpenAI C2PA, against
   the repo's own "nothing from third-party tools"); 30 presets carry lens brand names (ARRI, Cooke, Zeiss, Panavision
   ...), partly fitted to screenshots from the login-gated Cineflares; `schema_version` stayed 1 through 15 schema
   commits. Most of it is video (tracking, image visibility across frames, flicker) or experimental (Lens Lab).
   **Rejected:** a port that reads Flarecore's preset format (a moving, unversioned target, brand names) and a bridge
   that runs FlareRender on the user's ComfyUI (not installed there, not on the Comfy Registry, no live preview - every
   slider change a queue run on the production machine; its `flare_pass` is sRGB and clamped, so Screen over it is
   about 16 levels brighter in the midtones than its linear add). **The shape, a compact version, about 7 to 9 days:**
   a built-in plugin `plugins/flare/`, one filter type `flare.lens` with `reach: 0` like `film.light_leak` (normal
   blend; the shader decodes to linear, adds the flare accumulated in float, encodes again, a +-0.5 LSB dither hashed on
   the picture pixel - `BLEND_MODES` has no add and needs none then); five element kinds translated from Flarecore
   (glow, iris / ghost, streak, glint, ring) with the Apache-2.0 header per translated file, a NOTICE and a credit in
   About; a tool with two handles (light, anchor) after `film/points.js`, the light's colour sampled on the click;
   8 to 10 own presets with neutral names (a Node check that fails on a brand name; the preset select gets its own
   `title`, or the film-stock tooltip shows); occlusion through the filter layer's existing mask; **coordinates
   relative to the picture** (`resizeImageNow` does not move filter params); the assistant and MCP through `add_filter`
   / `set_filter` (both AUTO in `policy.js`), no new commands; the renderer validates and clamps every value, because
   `applyParams` (`commands.js` 974-989) assigns a `custom` value raw and sets a preset select's id only. Gates on both
   backends: GPU vs CPU within 2 levels, bands equal to the whole flatten, drag and undo, an
   `exportperf:15000x10000,--filter=flare.lens` row. The open-ended part is the look tuning: a build on the user's own
   pictures after about 4 days, before the rest. **Only on the user's word, later:** several lights per layer, detect
   the light, occlusion from a SAM2 selection or depth (Depth Anything V2 Small ONNX, Apache-2.0, 50 MB fp16; the
   user's ComfyUI holds only the Large model, CC-BY-NC), a Flarecore JSON importer pinned at `5e8f2bb`, textures (after
   a core fix: plugin samplers are re-uploaded every pass and units 6 / 7 collide with the framework's), "bake to
   layer" for PSD (layered exports skip filter layers). **Known traps:** a generate after the flare bakes it into the
   result (results go on top; film layers have the same problem); a plugin never reaches the ComfyUI node. **Order:**
   optional, no place in the order until the user names one.
22. **Nik 9 parity: depth masks and the rest of DxO Nik Collection 9's feature set (asked for by the user on
   2026-09-25; brainstormed, not planned into sessions, not built; an update of its own, NOT optional).** The whole
   research and shape is **`docs/PLAN_NIK9.md`**; read it before planning, do not research it again. **The user's
   answers:** it is for editing the finished picture after inpainting (adjustments by distance: grading, haze,
   halation), the edges are to be done properly ("besser richtig umsetzen"), and the scope is all of Nik 9 that
   Scumble lacks ("wenn dann alles"). **The shape, four releases:** (1) masks - an in-app Depth Anything V2 Small
   helper (Apache-2.0; the onnx-community repo is deprecated and its successor uses external data, so pin commit
   `4472b73...` or teach the registry a data file), the depth map a **document** resource (working map up to 4096 px,
   guided in a pool worker, u16 PNG mirror ref), *Select by depth* and *Limit by depth* live on filter layers (a
   post-stage in `applyFilter`), luminosity and colour-range sources on the same range bar, an Intersect selection
   mode, the Object tool's box drag, a layer-mask overlay; (2) edges (a tiled detail pass, a guided snap of the mask
   at full resolution in the depth-edge band, SAM2 / BiRefNet snap, a refine brush) and depth filters (haze, dehaze;
   lens blur on the user's word); (3) filters and control points (HSL 8 channels, chromatic shift, the grading wheel,
   glass, elliptical / polygonal / line points, diffusion); (4) the 18 missing blend modes (core: GL, Rust kernel and
   ABI, Canvas 2D, PSD / ORA, the node). **About 34 to 46 working days in all, inferred.** A checkpoint on the user's
   pictures once the model runs decides how much edge work release 2 needs. **Order:** not fixed yet; suggested
   after B3 (macOS). **Folded in on 2026-09-26 (the user: "kommt später, zusammen mit Nik"):** the masks-and-selections
   package - refine edge for any selection (hair, fur, colour decontamination, output to a mask), a soft selection
   from a layer's alpha (`selectionFromLayer` cuts at 127 today, `inpaint_canvas.js` ~6196) with add / subtract /
   intersect, a Bezier selection and stored paths, commands for saved selections, a black-and-white mask view - and
   the grading-and-panels package - a dither at the filter chain's final 8-bit write, a histogram / info panel, a
   navigator, own presets for filter layers with .cube export, colour match on luminance only or against a chosen
   reference region, vibrance, selective colour, a channel mixer, a gradient map, surface blur and median. Estimates
   from the review: 6.5-12.5 and 11-19.5 days.
23. **Rotate and straighten the whole document (on the later list, the user, 2026-09-26).** Rotate 90 / 180, flip the
   document, straighten by a drawn line, crop presets with overlays. Estimate 2 to 3.5 days (crop presets 1 to 2
   more). Every layer, mask, selection and saved selection has to follow, like *Resize*.

## Where things stand (2026-09-23)

**The manual is written and live, and it is the website's, not this repo's.** 16 chapters in
`F:\portfolio_web`, `lib/scumble-manual.ts`, rendered by `app/scumble/manual/page.tsx`: a contents
list with anchors, per chapter a screenshot, the steps that need doing as a numbered list, and short
notes. Order: install, where it renders (the API keys), the first edit, selecting, recipes, layers
and colour match, filters, text / shapes / objects, upscaling, export, the assistant, agents and
plugins, large pictures, **under the hood** (the crop, the Highres fix and the stitch, written from
`stitch.js` and `docs/RECIPES.md`), **keyboard shortcuts** (44 rows in six groups, read out of
`inpaint_canvas.js`'s key handler and the menu in `main.js`; the `keys` field of the `Chapter` type),
settings and trouble. **The hub card stopped saying "In preparation" for the dev blog** - all three
cards had that line hard-coded; it comes from the data now (`sectionState()` in `lib/scumble.ts`),
and manual and blog joined the sitemap. **A click on a screenshot opens it full size**
(`components/scumble-shot.tsx`, a native `<dialog>`: Escape, backdrop and a button close it; on a
phone it keeps its 1600 px and scrolls, because fitting it to the screen would not enlarge it).
Website commits `8d6c2f7`, `a917753`, `8e10581`, each deployed **by CLI from a clean export** (the
git deploy is blocked as always).

**The 14 screenshots were taken from the running dev app over CDP** at 1600 x 946, into
`public/projects/scumble/manual/`. **Trap worth keeping:** the *Settings > API providers* shot
showed `key set (...qOPM)` and `(...b662)` - the last four characters of the user's real keys. They
were masked in the DOM before the shot and the dialog checked afterwards for any fragment (0). Check
every settings screenshot for that before it goes on the web.

**The tutorial material is `docs/TUTORIAL.md` and `docs/images/tutorial/`.** All three pictures are
**the user's own** (2026-09-23), so no licence stands in the way: `scene.jpg` (the woman in front of
the blue Porsche, 16:9) carries the tutorial because it is the only one that teaches every chapter in
one frame, `skin.jpg` goes to the filter and retouch chapter, `titlecard.jpg` to the video. The four
brand marks in the scene - the Balmain band on the shirt, the Chanel double-C on the necklace, the
lettering on both socks - were removed **in the app**, four runs of GPT Image 2.5 Flare through
OpenRouter, **$0.22 and about two minutes**, no colour match needed and no patch edge findable at
1:1; the result is `scene-clean.jpg` and the selections and times are in the file. The video script
(a Q&A between two voices, about three minutes) is in there too.

**Found on the way and not yet fixed - it is the next session's item 4.** The OpenRouter image
adapter **has been running live since 2026-09-21**: the user's log holds about 40 successful runs,
most of them on 2026-09-22 between 14:47 and 15:37. So `docs/RECIPES.md` ("has not run against the
live API", the OpenRouter section) and, worse, the **recipe descriptions the user reads in the
picker** ("Adapter written from the provider's docs, not run against the live API yet") are stale for
OpenRouter. Also measured on the way: a crop whose context reaches bare legs is **refused by
OpenAI's safety system** through OpenRouter (`safety_violations=[sexu...]`); a tighter
`set_crop { context: "24" }` went through. Worth a line in `docs/RECIPES.md` when that section is
touched.

**Signing: the Microsoft Store comes before SignPath** (the user, 2026-09-23). Qualifying for the
SignPath Foundation needs visible use and takes as long as it takes; an **MSIX** submitted to the
Store is **re-signed by Microsoft** after certification, and a developer account has been free since
2025-09 for individuals and 2026-05 for companies. **It signs only the Store copy** - the GitHub
installer stays unsigned and keeps its SmartScreen paragraph, and submitting the `.exe` instead would
want it signed first. The whole decision with its conditions is in `docs/CODE_SIGNING_POLICY.md` and
in the release-channel block above.

**A linter is in the repository** (`eslint.config.mjs`, `npm run lint`, the gate `lint`, a step in
CI; `docs/PLAN_TYPES.md` §"Stage 1"). Eleven correctness rules, no style rules, unused names as
warnings, five environments. The first run: 55 errors, 52 of them the config not yet knowing those
environments; what was left over 41,333 lines was **one** deliberate canvas reset (annotated now,
the only source line this changed) and 18 unused names, all left standing as warnings. **No latent
crash.** CI green on `adee77a`, the `lint` gate 3 s.

**Stage 2 of `docs/PLAN_TYPES.md` is built: the three contracts are typedefs now, and `npm run types`
checks them** (`tsconfig.check.json`, the gate `types`, a **Types** step in CI after Lint, `typescript`
and `@types/node` as devDependencies; `docs/PLAN_TYPES.md` §"Stage 2 - as built"). `EditorApi` and
`EditorHost` (the **40** members the editor modules call, which is what `build_node.py --check` greps
for) in `renderer/editor/host.js`; `CommandParam` / `Command` / `CommandDescriptor` / `CommandCore` in
`renderer/commands.js`; `Recipe` / `ProviderVariant` / `EditLimits` / `UpscaleFactor` / `TextShape` /
`SettingRow` in `electron/main/recipes.js`. **`checkJs` is off on purpose**: with it on the first run
said 534 errors, almost all of them in `inpaint_canvas.js`, `inpaint_tiles.js` and `px/` - a file is
checked because it carries `// @ts-check`, so the `include` list is the whole truth. **Not the plan's
word:** `@satisfies` on the `host` object does not work (it checks excess properties on the literal and
re-types `this` inside every method, so the shell's ~110 members would have to stand in the contract);
the check is an assignment in the new, never-loaded `types/contracts.js` instead. The node's own
`js/host.js` still cannot be reached from here - another repository, no tsconfig - so the grep stays.
**What changed in files that ship: seven lines**, all of them DOM properties that were being handed
numbers (`i.min = 1` -> `"1"`, `input.value = v` -> `String(v)`; the DOM coerced them anyway) plus one
cast for `document.activeElement.blur()`. **No defect was found**, as in stage 1; what the typedefs did
find is three shapes the prose never stated (`text: false` in a variant, the old one-provider shape's
top-level `note`, the optional fields of the helper status). **Teeth: 15 mutations, 12 red.** The three
green ones are the tool's limit and are written down: in a `.js` file TypeScript treats every parameter
as implicitly optional, so an implementation that *grew* a parameter is still assignable (two of them),
and the command table's type is circular, so `names()`'s answer cannot be judged. **A blind spot that
showed itself:** the typedef was written from the app's implementations, and a scan of the editor's
call sites found two members where the editor passes more - `exportCanvas(editor, fmt)` and
`saveExport(blob, name, { editor, download })`; both typedef lines were wrong and no checker would have
said so. Gates `--offline` on both backends (`lint types recipes commands editor export mcp`):
**ALL PASS** (`s2-tiles`, `s2-canvas`), and **CI green on `7758a96`** with the new Types step
(both jobs, the gate 3 s). **Next in stage 3, and it is the fourth contract:**
`electron/preload.js` - `window.scumble` is declared `any` in `types/globals.d.ts`, so every
`window.scumble.*` in a checked file is unjudged.

**The MSIX package for the Microsoft Store is built and ran installed** (`docs/STORE.md`, "Run on the
installed test package": ComfyUI over loopback, the redirected data and a DPAPI key across a restart, the
single instance through the alias, the plugin folder in Explorer and a plugin written there from outside,
MCP through the alias in proxy and headless mode, `app.relaunch`, SAM2 on DirectML, a clean uninstall; the
App Certification Kit not run, no Windows SDK here). The user switched Developer Mode on for it; the test
package is uninstalled again. **`python tools/mcp_test.py --store`** runs the MCP test the way the Store
copy's registration starts it; the launch code now splices a placeholder into `process.argv`, because with
`-e` the launcher's arguments sat one slot early.
`npm run dist:store:test` (`tools/build_store.js --test`) makes `dist/Scumble-<version>-test.msix` (195 MB
for 0.1.26) with a test identity; `npm run dist:store` builds the package for Partner Center with the identity the
user reserved the same day (`DenRakEiw.Scumble`, `CN=F2BCAA24-...`; the family name
`DenRakEiw.Scumble_eh52rqbjjrbdj` Partner Center showed is what `msix.publisherId()` computes, and a check
holds it). **Not submitted:** the installed test comes first. `build/AppxManifest.xml` is electron-builder's template plus an **execution alias**
(`scumble.exe`) and full trust; `build/appx/` holds the tile artwork rendered from the logo SVGs by
`tools/appx_assets.js`. **`electron/main/msix.js`** is everything the Store copy does differently, switched
by `process.windowsStore`: its own data folder **`%APPDATA%\Scumble Store`** (Windows lets a package change
files that exist outside but puts new ones in its private `LocalCache`, so sharing `Scumble` with a GitHub
copy would split the data), every Explorer folder translated to the real `LocalCache` path (the family name
from the package's `AppxManifest.xml` and Windows' publisher-id hash, verified against four installed
packages), the updater in a state `store` (no electron-updater, no menu entry, the Updates section says the
Store updates it), and the MCP registration as the alias in Node mode with `-e` code that loads the
launcher from `process.resourcesPath` (`mcp/registration.js`; the last argument of the `claude mcp add`
line is quoted now unless it is a bare switch, so the old lines are byte for byte the same). Tests:
`node tools/platform_test.js` 18 checks (9 new), the `platform` gate a new app step; **15 of 15** Node
mutations and 1 of 1 renderer mutation red; gates `--offline` (`platform mcp commands lint types`) ALL
PASS (`store-dev`). **Two findings that decide the next step:** an unsigned MSIX **cannot hold an app**
(`Add-AppxPackage -AllowUnsigned`: 0x80073D2B, "cannot contain executable activations", even with the
unsigned-publisher OID), so installing the test package needs **Developer Mode** (register the unpacked
layout) or a trusted test certificate - a system setting, the user's call; and electron-builder's legacy
`makeappx.exe` (2019) does not start here, the 1.1.0 toolset's does only from a copy outside `%LOCALAPPDATA%`
(`build_store.js` stages it in `dist/.store-kit`). **Next for this item:** with Developer Mode on, run
STORE.md's nine-point list (ComfyUI over loopback, the redirected data and keys, the single instance, the
folders, the MCP alias with `ELECTRON_RUN_AS_NODE` through it, `app.relaunch`, DirectML, uninstall, the
App Certification Kit). Not in CI yet; no CHANGELOG line (nothing changes for the installer's users).

**NEXT, in this order (the user, 2026-09-23 evening, before a `/clear`): ~~1. Comfy Router as a provider~~ (built, the
paragraph below), 2. the macOS build (B3) with the logo.** State at the second `/clear` of that evening: Comfy Router
and HY Image 3.5 are in **0.1.28, published**. Open, none of it started: (a) the live runs of FLUX.2, Seedream and
Magnific through the Router (offered, not asked for; the key is in `dist/live-keys`, about $243 of credit); (b) the
Store package for 0.1.28 (`npm run dist:store`; the first submission is the user's, in Partner Center); (c) **the
headless MCP instance of this repo's `.mcp.json` intercepts the installed app**: it runs the dev tree on the default
profile, so a Start-menu Scumble handed over to it and the user saw the dev window (0.1.27 by its `package.json` at
start, no updater, "check for updates" did nothing). The installed app was still **0.1.25** and had not checked for
updates since 2026-09-22; the MCP instance was stopped on the user's word so the installed app could update to
0.1.28. A fix (a profile of its own for the MCP registration, `docs/BUGS.md` "A headless MCP instance can block the
app from starting") was offered and not yet decided.

**Live, the same evening (the user's key, entered in the dev instance on the scratch profile `dist/live-keys`, which
keeps it; the user's first key was not a Comfy key - 64 hex characters, refused on every route - the second,
`comfyui-...`, works):** GPT Image 2 through the Router (inpaint with the mask, Quality low, 23.6 s) and Nano Banana 2
(1K, 15.8 s) each gave a result layer in the selection; the notes of those two variants say so, the rest of the
Router variants are still unrun (FLUX.2, Seedream, Magnific offered to the user, not run). **`GET
/customers/balance`'s `amount_micros` counts cents** (it fell by exactly 3.432 for an HY run the node prices at
$0.03432; the account held about $243). The queue's result read carries no `X-Comfy-Credits-Used`, so `info.credits`
is null on a queued run. A probe that reads the key from the scratch profile through `safeStorage` and asks the free
routes (model list, `/customers/me`, balance) without printing the key is in that session's scratchpad
(`router/probe/`).

**HY Image 3.5 Preview is built too, for 0.1.28, and ran live** (the user asked for it before the release, route
chosen by the user: "Direkt über den Proxy"). It is **not on the Router** (240 models, Tencent only 3D) but only a
Partner Node pair (`HunyuanImageEditApi`, `HunyuanImageTextToImageApi`, ComfyUI PR #16462 of 2026-09-22; the user's
ComfyUI 0.37.0 lacks them). New provider **`comfypartner`** ("Comfy Partner API", `providers/comfypartner.js`,
`keyName: "comfycloud"`, helpers shared from `comfyrouter.js` `_shared`): `POST /customers/storage` -> signed
`upload_url` / `download_url`, `PUT` the picture without the key, then `POST
/proxy/tencent/v1/wand/hunyuan-image/v35-generation` (synchronous) -> `choices[0].delta.image.url`; "download image
failed" is sent twice more under new keys (the node's rule); `@ImageN` becomes "Image N". **Not a documented public
API** - the note, the docs and a 404's words say so. Recipe `hy_image_3_5` (family Tencent, edit up to 5 pictures,
Detail standard / high, crops to 2048 px and 4.2 MP, Generate new up to 4096). Live: one edit at 2048 x 2048 in
27.9 s, $0.03432. Tests: `tools/comfyrouter_test.js` section 10 (now 88 checks), the `comfyrouter` gate three more
steps (mock routes for storage, upload, the proxy); mutations 17 of 17 red after one check was added (the one green
left out is an equivalent mutation: `readFailure` already scrubs the key). Gates `--offline` (`comfyrouter recipes
generate`, tiles also `lint types`): ALL PASS on both backends (`hy-tiles`, `hy-canvas`).

**0.1.28 is published** (Latest since 2026-09-23 21:24 German time, on the user's word "ja go go go"; CI built the draft: windows, linux, both `latest*.yml`; dev blog post "One key, sixteen models" (`v0-1-28`, portfolio `73c8e5f`, with the manual sync), live by CLI deploy, the git deploy blocked as always). Built on 2026-09-23 ( `package.json` 0.1.28, CHANGELOG "0.1.28 — 2026-09-23": Comfy Router,
HY Image 3.5). `npm run dist` made `Scumble Setup 0.1.28.exe` (128.4 MB). Exe gates `--offline`: `rel28-exe` (tiles:
platform layered upscale log pixels editor composite commands mcp recipes llm export assistant help comfyrouter) ALL
PASS but `comfyrouter`, whose steps all passed and whose cleanup failed after `upscale` had remembered a provider (its
restore ran before `selectRecipe`'s unawaited writes; the order is fixed, `rel28-exe-cr` = upscale recipes comfyrouter
ALL PASS); `rel28-exe-canvas` (tiles off: platform layered upscale pixels editor composite film export assistant help
comfyrouter) ALL PASS but `editor` (the live-stroke flake, "a real mouse over the window?"), green on the rerun
`rel28-exe-canvas-ed`.

**Comfy Router is built, for 0.1.28 (2026-09-23; CHANGELOG "0.1.28 — unreleased", `docs/RECIPES.md` "Comfy Router";
`package.json` still 0.1.27). Written without a key; the live runs are in the paragraph above.**
`electron/main/providers/comfyrouter.js`, written from the Router's pages read as Markdown (`<page>.md`: quickstart,
queue, providers, reference), `api.comfy.org/openapi` for the queue and error field names, and **each model's
published input schema** (`docs.comfy.org/router-schemas/<p>/<m>.json`, copied into `tools/refs/comfyrouter/`, 16
files). It uses **the queue** (submit with `X-API-Key` + one UUID `Idempotency-Key` per run, resent under the same key
on a lost answer / 409 concurrency / 429 / 503 up to three submits; status polls on `Retry-After`, 1 to 15 s; the
result read, 202 = poll again; `PUT .../cancel` after 15 min, 30 for upscale; the status / result URLs composed from
host + model + UUID, never from the answer) and falls back to the **synchronous route** under a new key when the
queue answers `403 not_enabled` (a legacy key without a workspace). The body is the partner's native schema, one
**dialect** per provider segment: `openai` (reuses `openai._common` / `_sizeFor`, the RGBA mask), `vertexai`
(camelCase `inlineData`, the mask as a second picture, the last non-`thought` picture of the answer), `bfl` (FLUX.2
`input_image..9`, 256..2048; FLUX.1 Fill), `byteplus` (reuses `ark._size`; **the Router's schema gives Seedream
other pixel ranges than ModelArk's docs**: lite to ~9.4 MP, pro 1 to 4.2 MP), `qwen`, `freepik` (upscale), and
text-only `xai`, `ideogram`, `krea` (their Router schemas take no picture). **No key row:** the adapter's
`keyName: "comfycloud"`; `providers/index.js` has `keyNameOf()` and `describeAll()` a `sharesKey` field, and
`renderProviders()` in `shell.js` skips such an entry (the Comfy Cloud row's hint names the Router). **Sixteen
recipes** got a `comfyrouter` variant, last, no default changed ("Also on Comfy Router."); `comfyrouter` is in
`TEXT_PROVIDERS`. Not wired: Recraft V4 (no size list), SeedVR2 (URL input, target resolution), FLUX.2 flex / klein
(not served). **Tests:** `node tools/comfyrouter_test.js` (68 checks; every body of every variant validated against
its published schema), the new gate **`comfyrouter`** (`tools/comfyrouter_test.py` + `tools/comfyrouter_mock.py`, 13
steps, refuses a profile holding a Comfy Cloud key); `openrouter_test.js` / `.py` and `upscale_test.js` now allow
Comfy Router after their provider. Mutations: **52 of 52** Node red (the first round's two survivors got checks: an
OpenAI `kind: "edit"` sends no mask, `constructor/x` is refused), 1 of 1 app (the skipped key row). Gates `--offline`
on both backends (`comfyrouter recipes openrouter ark toapis upscale generate size transparent mcp commands`, tiles
also `lint types`): **ALL PASS** (`cr-tiles2` + `cr-tiles3` for openrouter after its fix, `cr-canvas`). **What only a
real key can settle** is listed at the end of the RECIPES section (the queue with the user's key, the live
validation, whether the masks reach the model as edits, output sizes, prices via `X-Comfy-Credits-Used`). Not done:
*check balance* on the Comfy Cloud row (`GET /customers/balance` exists, unwired).

**SEO and GEO for the Scumble pages are done and live (item 3, 2026-09-23; portfolio `f72a510`, CLI deploy).** Found and
fixed: the root layout's `alternates.canonical: "/"` was inherited by every page, so `/scumble`, `/manual` and `/blog`
each declared the home page their canonical; the layout has none now and every page states its own (home `/`,
imprint `/impressum`). `lib/scumble-seo.ts` in the website: `scumbleMeta()` (canonical, title by search intent with
`absolute`, description, OpenGraph/Twitter card naming the page), the `facts` and the 8-question `faq` (shown on the
hub and marked up with the same words), JSON-LD `SoftwareApplication` + `FAQPage` (hub), `TechArticle` with its 17
chapters as `hasPart` (manual), `Blog` with every `BlogPosting` (blog), `BreadcrumbList` everywhere, the Person got
`@id` `/#person`. Share images 1200 x 630 per page (`app/scumble/**/opengraph-image.png` and `twitter-image.png`,
the mascot draft + the page's title). GEO: the hub opens with a definition sentence and a facts list, `/llms.txt`
(route, built from the same data) and the whole manual as `/scumble/manual.md`. Headings "Scumble manual" / "Scumble
dev blog", a nav at the foot of every subpage (the other doors and the download), blog titles are permalinks, the
sitemap has the release date and priorities (hub 0.9, manual 0.8, blog 0.6). `robots.ts` already allowed every
crawler, AI bots included. **The Store listing** was submitted by the user the same day (publish right after
certification); when it is live, the Store link goes onto the hub, README and a blog post.

**0.1.27 is published** (Latest since 2026-09-23 15:52, on the user's word "mach den release"; `package.json` 0.1.27, CHANGELOG
"0.1.27 — 2026-09-23": Help, the logo, the upscale prompt, OpenRouter's live notes, the clean package). **Found while
building it and fixed:** `build.win.files` / `build.linux.files` held only the onnxruntime exclusions since B1, and
electron-builder takes a platform list as the whole list, so **0.1.26 shipped the whole project folder** (docs,
tools, crates, docker, types, `.claude/`, CLAUDE.md; nothing private: `.claude/` held a launch config with a temp
path and the MCP switch); both lists carry the top-level list now, `platform_test.js`
`a_platform_file_list_is_never_exclusions_alone` holds them to it (red on the 0.1.26 list) and
`the_built_package_holds_the_app_and_nothing_of_the_repository` reads `dist/win-unpacked`'s asar when there is one.
Installer **128.4 MB** (0.1.26: 133.6), installed 410 MB. **OpenRouter (item 4) is done in it:** the notes of GPT
Image 2.5 Flare and Sunburst say they ran live (the user's log: about 44 and 112 edits since 2026-09-21), the other
twelve OpenRouter variants that the adapter ran live but that model not; `docs/RECIPES.md` has the safety-refusal
finding. Exe gates `--offline`: `rel27-exe` (tiles: platform layered upscale log pixels editor composite commands mcp
recipes llm export assistant help) and `rel27-exe-canvas` (tiles off: platform layered upscale pixels editor
composite film export assistant help) ALL PASS but `editor`, each a known flake
(`helper_inputs_read_levels_and_upload_nothing`, `closed_tabs_are_collected`), green on the reruns `rel27-exe-ed` and
`rel27-exe-canvas-ed`; the final package (rebuilt for the manual's size line) `rel27-exe-final` (platform help)
PASS. No `smoke`. Dev blog post "Ask the manual" (`v0-1-27`, portfolio `9aecf75`), live by CLI deploy.
**The Store is prepared, not submitted:** `dist/Scumble-0.1.27.msix` (186.6 MB, `DenRakEiw.Scumble`, English only:
`build.appx.languages` lost `de-DE`, because every declared language needs a full listing), the listing texts in
`docs/STORE_LISTING.md` (description, features, keywords, the `runFullTrust` sentence, the privacy URL, the age
rating answers) and seven screenshots in `dist/store-listing/`. **The upload in Partner Center is the user's.**

**Help is built (2026-09-23, for 0.1.27; `docs/PLAN_HELP.md` "As built", CHANGELOG 0.1.27).**
**`docs/MANUAL.md` is now the manual's one source** (17 chapters; a new one on Help, and F1 in the
shortcuts), `renderer/help/manual.js` its one reader, and **the website builds `/scumble/manual` from
copies of both** (`node tools/manual_sync.js [--check]` copies them into `F:\portfolio_web`,
`content/scumble/MANUAL.md` and `lib/scumble-manual-reader.js`; portfolio `f5329db`, live by CLI deploy).
**So a manual change is made here and synced, never on the website**, and every release runs the sync
before its blog post. The app: *Help* button and **F1** (*Help › Scumble help* replaces *Editor guide*),
a `<dialog id="help">` column (`renderer/help.js`, `help.css`) with the searchable manual and a chat above
it that answers from it (`electron/main/assistant/help.js`: the assistant's four adapters with no tools,
every *Language models* row, `settings.help.model`; chats are not kept). Tests: `tools/manual_test.js`
(7, with **drift checks**: every menu accelerator in the shortcuts chapter, every `Settings › X` and
`<Menu> › X` an existing section or item), the `help` section of `tools/assistant_test.js` (12, 238 in
all), the new gate **`help`** (six app steps against the mock); mutations 15 of 16 red (the green one is a
guarantee the editor gives twice). Gates `--offline` tiles ALL PASS (`help-tiles`), canvas ALL PASS on
the rerun. **The live check of §5 ran** on the user's OpenRouter key (Gemini 3.8 Flash, a scratch profile deleted
afterwards): a question the manual does not answer got "the manual does not cover" with the docs links,
nothing invented; a covered one the right answer and its chapter. **About one cent a question**, measured
(10k input, 400 to 700 reasoning tokens), not the plan's "fractions of a cent". Its answer is the
chapter's screenshot (`help.jpg`, portfolio `f116061`, live by CLI).

**The order changed later the same day (the user: "also bauen wir erst weiter den hilfe assistent und danach
machen wir ein ms store release"):** item 5 (Help) next, then the 0.1.27 release with item 4's OpenRouter line
in it, and the **first Microsoft Store submission** with the same version (`npm run dist:store`, uploaded by
the user in Partner Center by hand; the listing texts and screenshots can come from the manual); then, if the
user wants it, the GitHub-release-to-Store coupling (`msstore` CLI in `build.yml`, which needs an Entra ID app
linked to Partner Center; only submissions after the first can go through the API). SEO (item 3) after that.
The list below is the order as it stood before:

**Next, in this order** (the user, 2026-09-23, each after a `/clear`):

1. ~~**Stage 2 of `docs/PLAN_TYPES.md`**~~ - **built on 2026-09-23**, see the paragraph above.
2. **The MSIX package for the Microsoft Store** - **built and run installed on 2026-09-23**
   (`docs/STORE.md` is the whole of it; the paragraph below). Eight of STORE.md's nine points held on the
   registered test package (the certification kit needs the Windows SDK); what is left is the user's
   submission in Partner Center. **The Partner Center identity is in** (2026-09-23: `DenRakEiw.Scumble`, family
   `DenRakEiw.Scumble_eh52rqbjjrbdj`, Store ID `9NDBTNNMXF2R`; `npm run dist:store` builds the real package).
3. ~~**SEO for the four Scumble pages**~~ - **done 2026-09-23, with GEO** (the paragraph at the top). The plan was: titles and
   descriptions by search intent, JSON-LD (`SoftwareApplication`, `HowTo`, `BlogPosting`), an
   OpenGraph image per page, heading hierarchy, internal links, sitemap priorities. The manual is the
   lever - it is the only page with real prose about "AI inpainting editor", "ComfyUI desktop app",
   "PSD export".
4. ~~**The stale "not run against the live API" line for OpenRouter**~~ - **done in 0.1.27** (2026-09-23).
5. ~~**Help: the manual in the app, with a chat on top**~~ - **built on 2026-09-23, for 0.1.27** (the
   paragraph "Help is built" above the order; `docs/PLAN_HELP.md` "As built"). The plan as it stood:
   A Help button whose panel **renders the manual itself**, searchable, with no key and no network,
   and a chat above it that answers from the same text on whichever model the user has a key for.
   The chat is the assistant's loop **with an empty tool set** - no MCP client, no policy, no undo,
   no screenshots, and therefore **any model, including the cheap text-only ones the assistant
   cannot use**. Half the work is §2 of that plan and it pays on its own: **the manual lives only in
   the website repository today** and will drift from the code it describes, so it moves to
   `docs/MANUAL.md` here and the website generates its chapters from it. Today's
   `Help > Editor guide` opens the ComfyUI node's README, which is the wrong file in the wrong
   repository; this replaces it (F1). About two days.

**Open on the manual, none of it blocking:** the assistant's screenshot is an empty panel (a real
turn would cost a few cents on the user's OpenRouter key and make the strongest picture in the
manual); there is no colour-match figure, because it was measured and the obvious candidate teaches
the wrong thing - Match 100 on the red handbag pulls it toward the blue car and the paving, so that
figure needs a result that is *unintentionally* off, a piece of wall or paving; and the log
screenshot is empty, because the safety-system error was cleared out of it before the shot.

**New idea, parked** (the user asked on 2026-09-23 whether Kotlin / Swift would make sense): **a
mobile companion, not a mobile editor.** A WebView wrapper of the editor fails on memory - iOS ends
an app at a few hundred MB to about a gigabyte and a 15k document needs multiples of that - and a
native rewrite is a second product; the one asset that ports cleanly is the **Rust kernels** (JNI /
uniffi), and ONNX has mobile builds. The shape that would make sense: look at the picture, mark a
place with a finger, say the prompt, the run happens on the desktop Scumble or through an API, the
result lands there. It would be the fourth platform before the first three are done (Windows
unsigned, Linux never run, macOS not built), so it is an idea, not a plan.

## Where things stand (2026-09-22)

**2026-09-22, after 0.1.26: the Upscale dialog's prompt field, for 0.1.27** (the user's report; `docs/BUGS.md` "The
creative upscalers seem to take no prompt", CHANGELOG "0.1.27 — unreleased"). Clarity and Magnific Creative always
sent the Generate tab's prompt, invisibly; the dialog now shows a Prompt row for `usesPrompt` recipes (prefilled from
the tab, sent as the `upscale` command's new `prompt`, the tab's prompt untouched), `list_recipes` has `usesPrompt`.
Gate step in `upscale_test.py`, 6 of 6 mutations red, gates `--offline` on both backends (`upscale recipes mcp commands
assistant`, canvas also `editor`) ALL PASS. Not released. **The same evening the logo was drawn and is in 0.1.27 too**
(item 18 of "What comes next": `build/icon.svg` and the new `icon.png` / `icon.ico`; the user's word, "kommt aber
erst mit naechstem release rein" - no release for the icon alone).

**2026-09-22: 0.1.26 is published** (Latest since 18:04 German time, on the user's word "kannst du es pushen";
`package.json` 0.1.26, CHANGELOG "0.1.26 — 2026-09-22": the smaller installer and the Linux build). `npm run dist`
built `Scumble Setup 0.1.26.exe` (133.6 MB); exe gates `--offline`: `rel26-exe` (tiles: platform layered upscale log
pixels editor composite commands mcp recipes llm export assistant) and `rel26-exe-canvas` (tiles off: platform layered
upscale pixels editor composite film export assistant) ALL PASS at the first try. **The first tag through the new
`draft` job worked:** one draft, both builds attached (`Scumble-Setup-0.1.26.exe` 133 MB, `scumble-0.1.26.AppImage`
162 MB, `scumble-0.1.26.deb` 128 MB, `latest.yml` and `latest-linux.yml` both answer 0.1.26). The dev blog post
"Smaller, and on Linux" went up first as a post without a release (portfolio `cee23e7`) and became the 0.1.26 post
(`v0-1-26`, `99d111a`, `hub.version` 0.1.26), both live by CLI deploy (the git deploy blocked again). The Linux build
has still run nowhere.

**2026-09-22, evening: B1 + B2 are built - the smaller Windows installer and the Linux build, for 0.1.26**
(`docs/PLAN_0_1_24.md` "B1 + B2 as built", CHANGELOG "0.1.26 — unreleased"; `package.json` is still 0.1.25). **B1:**
`build.win.files` drops `onnxruntime-node`'s darwin, linux and win32/arm64 folders, `electronLanguages` keeps en-US
and de: installer **188.1 -> 133.6 MB**, installed 676 -> 421 MB; DML and CPU sessions load from the package (the
exe in Node mode on the user's SAM2 tiny decoder, read only). Exe gates `--offline` on that package: `b1-exe`
(tiles: layered upscale log pixels editor composite commands mcp recipes llm export assistant) and `b1-exe-canvas`
(tiles off: layered upscale pixels editor composite film export assistant) ALL PASS. **B2:** `build.yml` has a
`draft` job (tag check, draft from the CHANGELOG) that `windows` and a new `linux` job need; `linux` builds AppImage,
.deb and `latest-linux.yml` with `ONNXRUNTIME_NODE_INSTALL=skip` (**helpers on the CPU on Linux**, no CUDA provider
shipped). `electron/main/mcp/registration.js` (an AppImage registers `"$APPIMAGE" --mcp`, no launcher; Windows' text
byte for byte as before), `keysNote` / `showKeysNote` in `shell.js` (amber warning for `basic_text`). New gate
**`platform`** (9 Node checks, 2 app steps); mutations 9 of 9 (Node) and 4 of 4 (app, fresh instance each) red; dev
gates `--offline` on both backends (`platform mcp commands llm editor`) ALL PASS. **Nothing has run on Linux** (no
WSL / Docker here; `docs/BUGS.md` "Linux: built, never run"); **the first Linux CI build is green** (run
35744363504 on `c1e23da`: `linux` 1 min 12 s, AppImage + .deb artifact 289 MB; `windows` 133.5 MB).
**Trap:** editing `tools/run_gates.sh` while a run of it is going breaks that run (bash reads the script as it goes:
`syntax error near unexpected token fi`). **Next:** B3 (macOS, needs the 1024 px
icon source) or the 0.1.26 release, on the user's word. **The user (2026-09-22): B3 is postponed, and a logo has to
be designed first** (item 18 of "What comes next"; B3 needs its 1024 px master).

**2026-09-22: 0.1.25 is built and tagged** (`package.json` 0.1.25, CHANGELOG "0.1.25 — 2026-09-22": PSD / ORA open with
their layers, the PSD export's non-ASCII names, U2, the upscalers' live runs). **U3 moved out of it** on the user's word
("mach den release fertig"): in-app ONNX upscaling is optional now, not planned for a release. `npm run dist` built
`Scumble Setup 0.1.25.exe`; exe gates `--offline` against `dist/win-unpacked/Scumble.exe`: `rel25-exe` (tiles: layered
upscale log pixels editor composite commands mcp recipes llm export assistant) and `rel25-exe-canvas` (tiles off:
layered upscale pixels editor composite film export assistant) ALL PASS at the first try. No `smoke` (U2 has not run
on a server; the release notes say so). Tag `v0.1.25` pushed, CI built the draft, and **0.1.25 is Latest since
2026-09-22** (published on the user's word; `latest.yml` answers `version: 0.1.25`). The dev blog post "Layers in, layers
out" (`v0-1-25`, portfolio commit `65afaec`) went live by CLI deploy (the git deploy was blocked again). **Next:** B1 + B2 (the smaller Windows installer and the Linux build), which the user asked about.

**2026-09-22, later: U2 is built - an upscale model on the user's ComfyUI, for 0.1.25** (`CHANGELOG.md` "0.1.25 -
unreleased", `docs/PLAN_0_1_24.md` "U2 as built", `docs/RECIPES.md` "The shipped ComfyUI recipes" and "On the user's
ComfyUI"; `package.json` is still 0.1.24). `recipes/upscale_model_local.json`: `InpaintCanvas` -> `ImageFromBatch` ->
`UpscaleModelLoader` (*Model*, slot 1, default `4x-UltraSharp.pth`) -> `ImageUpscaleWithModel` -> `result_local`,
`"task": "upscale"` on a ComfyUI recipe (`normalize()` gives it `factor.fixed`, any other task becomes `edit`).
**Selection only**: the node's stitch fits the model's larger answer back into the box. `host.queueGenerate` refuses
without a selection, sends `host.upscaleState(state)` (no fill, no Original copy, no references, no refine; the
document's crop settings untouched) and forces `target_size: 0` after merging the user's node params (the recipe's own
value would lose to them). The `upscale` command refuses `scope: "document"` by name and runs the selection through
`generate`'s path; the dialog lists the recipe, greys the whole picture out, hides factor and provider, and disables
*Upscale* without a selection, a connection or one of the `needs`. The assistant's question now says "costs money, or
queues on your ComfyUI". No editor change (no `nodecopy`). Tests: `node tools/upscale_test.js` **95 checks** (a
section for the recipe file), gate `upscale` step `a_comfy_upscale_recipe_queues_the_crop_as_it_is_and_only_the_selection`
(catches `api.queuePrompt` in the window: **nothing is queued anywhere**); mutation round **15 of 15 red** (fresh
instance each). Checked against the user's `/object_info` (read only, the queue untouched). **Not run on a server**:
`smoke` with a real model file waits for the user's ComfyUI. **Next: U3** (in-app ONNX upscaling, whole picture in
bands), then the 0.1.25 release with U2.

**2026-09-22: PSD and ORA open with their layers, for 0.1.25** (the user's bug report the same day; `docs/BUGS.md`
"A PSD saved with layers cannot be opened with them"). New `renderer/editor/inpaint_layered.js` (`readPsd` /
`readOra`, no DOM, in `build_node.py` FILES and `docs/BUILD_NODE.md`), the editor's `readLayered` / `loadLayered`
(`loadFile` sniffs the first bytes; `addImageLayers` adds a dropped file's layers), `.psd` / `.ora` in the open
dialog's filters. Found and fixed on the way: **the PSD export lost every non-ASCII layer name** (a `luni` block in
both writers now). New gate **`layered`** (`node tools/layered_test.js` 44 checks, then 7 app steps); mutation round
18 of 18 red; gates `--offline` on both backends (`layered export editor commands mcp upscale`, tiles also
`nodecopy`) ALL PASS; checked on the user's real Photoshop files (read only, locally).

**2026-09-22: the U1 checkpoint ran** with the user's fal and Magnific keys (entered in a dev instance on the scratch
profile `dist/live-keys`, which keeps them; `docs/RECIPES.md` "The checkpoint, 2026-09-22"): Topaz Precision on fal (a
selection 25 s, a 1907 x 1073 picture to 3814 x 2146 in 24 s), Magnific Precision V2 (the same box in **311 s**) and
Magnific Creative (13 s), all 2x, every answer aligned. The status line now warns that Magnific Precision is slow.
One 4x run too (Topaz, the whole picture to 7628 x 4292 in 34 s). Not run live, on the user's word ("koennen die user
testen"): the other fal upscalers, Comfy Cloud, other factors, `limits.max`.

**2026-09-22: U1 is built - upscaling through the providers, for 0.1.24** (`package.json` 0.1.24, CHANGELOG "0.1.24 — 2026-09-22"; `docs/PLAN_0_1_24.md` "U1 as built", `docs/RECIPES.md` "Upscale recipes" and "Magnific"). An *Upscale*
button next to *Generate new* (the app host's `buildUpscaleButton`, so the node needs nothing) opens `#up-dialog`
(model, provider, the selection or the whole picture, the factor) and runs the new command `upscale` (`scope`,
`factor`; the assistant asks, 30 min timeout, a `layers` undo step for the selection, none for the whole picture).
`host.runUpscale`: the selection's crop box (with context) at its own size, no fill, no references, the answer fitted
back by the stitch as a result layer; the whole picture sends the base alone and the answer becomes the base through
`resizeImage(nw, nh, { base })` (layers, masks, selection scaled, one `canvas` step), refused above `limits.max`.
*Generate* with an upscale recipe selected upscales the selection. Recipe format: `task: "upscale"`, `factor { default,
min, max, steps, fixed }`, `usesPrompt` (normalized in `recipes.js`, family *Upscale*). Nine recipes: Topaz Precision /
Bloom / Wonder, Clarity, SeedVR2, Recraft Crisp / Creative (fal, `fal.js` `upscale`, 30 min queue wait), Magnific
Precision (V2, 2-16) and Creative (2/4/8/16, 25.3 MP cap) through the new `providers/magnific.js` (async tasks on
`api.magnific.com`, `x-magnific-api-key`, base64, host and `test-` key rules as ModelArk) and, **not in the plan**,
Comfy Cloud as the last variant of both Magnific and both Recraft recipes (Partner Nodes, `comfycloud.js` `upscale`).
**The survey** could only read keyless lists: this install stores a BFL key only (no fal, Magnific, Replicate,
WaveSpeed, ToAPIs, OpenRouter key); findings in `docs/RECIPES.md`. Tests: `node tools/upscale_test.js` (84 checks) and
the gate `upscale` (`tools/upscale_test.py`, 10 steps, loopback upscaler with a magenta frame marker); mutation rounds
**64 of 64** (Node, on a copy of the tree) and **17 of 17** (app, fresh instance each; four survivors of the first run
were each answered with a check or a change). **The checkpoint was skipped on the user's word** ("also push"; the fal key the user named is not in this
machine's `%APPDATA%/Scumble/secrets.json`, which holds BFL only; the Magnific key comes after the update): nothing
has run against a live API. Exe gates `--offline` against `dist/win-unpacked/Scumble.exe`: `rel24-exe` (tiles: upscale
log pixels editor composite commands mcp recipes llm export assistant) and `rel24-exe-canvas` (tiles off: upscale
pixels editor composite film export assistant) ALL PASS at the first try. Tag `v0.1.24` pushed, CI built the draft, and
**0.1.24 is Latest since 2026-09-22** (published from this session on the user's word; `latest.yml` answers
`version: 0.1.24`). The dev blog post "Make it bigger" (`v0-1-24`, portfolio commit `cf92b73`) went live by CLI deploy
(the git deploy was blocked again).

**2026-09-22: the plan for the next sessions is `docs/PLAN_0_1_24.md`** - seven sessions with a `/clear` after each
larger one: U1 upscaling through the providers (fal already hosts Topaz precision / creative / generative, Clarity,
SeedVR2, Recraft behind the existing adapter and key; selection mode on the existing run path, a whole-picture mode
that replaces the base like *Resize*; release 0.1.24), U2 an upscale recipe on the user's ComfyUI, U3 in-app ONNX
upscaling with the whole picture in bands (0.1.25), M1 Magnific as a full provider (Mystic, FLUX, Seedream 4.5,
Z-Image, Image Expand; async tasks on `api.magnific.com`, docs readable at docs.freepik.com), O1 Oxen.ai (0.1.26; three probes with a key first, a data URL in
`input_image` decides the edit route), B1 + B2 the smaller Windows installer (151 MB of foreign ONNX binaries) and
the Linux CI build, B3 macOS prepared without the developer account (mac block, entitlements, `cmdKey`, an unsigned
CI artifact, nothing released). U4 (Topaz / Magnific direct, a local Topaz) only on the user's word; **no Topaz photo
product is installed here** (Topaz Video only), so a local route cannot be tested. **What the user said the same
day:** the assistant has run against a real key and works (so the checkpoint of `docs/PLAN_ASSISTANT.md` is
answered by use); Qwen Image Edit 2.1 has no API yet, item 15's API side is closed; the Qwen local recipe is still
untested (the models are not downloaded); the website stays on CLI deploys for now. **Start the next session with
U1** (the plan's section says what to read and what the checkpoint needs: the fal key for one live Topaz run).

## Where things stand (2026-09-21)

**2026-09-21: 0.1.23, a small patch** (`package.json` 0.1.23, CHANGELOG "0.1.23 - 2026-09-21"). (1) **Layer names
were invisible** (GitHub issue #1, `docs/BUGS.md` "Fixed, waiting for its release"): measured in a fresh instance, the
panel 291 px, a row 259 px (247 with the list's scrollbar), its content 274 px, the name of every layer with the full
button set 0 px - the name was the only element that gave in, so nothing could be double-clicked and the list
scrolled sideways; the rename itself was never broken. `.ipc-side` is **320 px** now, the row's minis 22 px with a
3 px gap, `.ipc-name` `min-width:48px`, the kind select shrinks (44 to 84 px), the expanded rows' selects shrink, a
text layer's rows wrap, and a rename pushes a `layers` undo step. Gate step `editor_test.py`
`layer_rows_fit_the_panel_and_names_can_be_renamed` (17 layers, the active row of each kind, nothing past the list's
edge, a real `dblclick` + Enter + undo), red on the 0.1.22 code and red without the undo step. **What the wider panel
moved:** `a_colour_matched_layer_draws_from_its_own_tiles`' flip check went red on the canvas backend only (an A/B:
green at 290 px with every other change in); two fresh matches of one state differ by 2 levels on 12,402 of 8.7 M
bytes there at the new geometry, and that backend has no provisional statistics, so its bound is 2 and the tiles
bound stays 1 (a mutation that keeps the provisional entry is red at 1 and green at 2 - a blanket 2 would have
blinded the step). (2) **`recipes/qwen_image_edit_2_1_local.json`**, from the user's ComfyUI template
(`image_qwen_image_2_1_image_edit.json`): subgraph flattened, save / compare nodes dropped, the crop batch split by
`ImageFromBatch` into `images.image_1..3` because `TextEncodeQwenImage21` reads `image[:1]` per input (an autogrow
input is a flat dotted key in an API prompt); `docs/RECIPES.md` "The shipped ComfyUI recipes". Checked against the
user's `/object_info` (every class, input, link and setting target); **not run** - the three Qwen 2.1 model files
were not on that server. (3) The *upscale* upsample use case (committed earlier the same day, `c0df448`).
Gates `--offline`: tiles `p23-tiles` (pixels editor composite commands shape brush film recipes llm generate mcp log
nodecopy assistant) ALL PASS, canvas `p23-canvas` ALL PASS after the bound (editor rerun `p23-canvas-ed3`). `npm run dist`
built `Scumble Setup 0.1.23.exe`; exe gates `--offline` against `dist/win-unpacked/Scumble.exe`: `rel23-exe` (tiles: log
pixels editor composite commands mcp recipes llm export assistant) and `rel23-exe-canvas` (tiles off: pixels editor
composite film export assistant) ALL PASS at the first try. No `smoke` (the user's ComfyUI). Tag `v0.1.23` pushed, CI
built the draft, and **0.1.23 is Latest since 2026-09-21** on the user's word; `latest.yml` on the feed answers
`version: 0.1.23` (check `gh release list` before believing any release state written down anywhere).

## Where things stand (2026-09-20)

**2026-09-20, after 0.1.21: the language models are the user's own list now, and the picker stopped warning about
itself, for 0.1.22** (`package.json` 0.1.22, CHANGELOG "0.1.22 - unreleased"; the user: "fuer die llm's im agent und
prompt upsampling sollen auch anbieter wie openrouter verwendet werden koennen, also brauchen wir settings in
einstellungen um das umzusetzen. Ausserdem entferne die 'not tested' hinweise"). OpenRouter was already both a
provider of the assistant and an upsampling backend since 0.1.21; what was missing is a place in the Settings and the
freedom to name **any** model. **New: `electron/main/llm_custom.js`** (plain Node, no Electron) holds
`settings.llm.models`, a list of `{ provider, model, label, upsample, assistant, vision }`, normalised on every read
(unknown provider, empty id and duplicates dropped, id cut at 200 and name at 120, at most 50 rows, prototype keys
are not providers). **One registry for both features:** it reads the assistant's `providers.js`, so the ten providers,
their key rows and their base URLs are the same list for the assistant and for prompt upsampling. `llm.list()`
appends the rows marked *upsample* after the built-in ones (`key` from that provider's own credential row, the local
endpoint from its URL) and `ask()` resolves them; `picker()` appends the rows marked *assistant* to their provider
group, after the curated models and never repeating one, and `providerOf(value, custom)` gives the loop the row's own
name and `vision` (a row marked blind loses `screenshot`, like any blind model). **New for upsampling: `askChat`** -
DeepSeek, Moonshot, Z.ai and WaveSpeedAI had key rows for the assistant only; a row of theirs now goes through the
same `askCompatible` client as the ToAPIs and OpenRouter rows, to the base `llm_custom.endpoint()` reads from the
registry (ToAPIs and the local endpoint keep their own paths, their host comes from the settings). **UI:**
*Settings > Language models* (provider select, model id with OpenRouter's live tool-model list as suggestions, name,
three checkboxes, Add, a row list with Remove), `llm:providers` as the one new IPC channel, and
`refreshAssistantModels()` so a new row reaches the panel's cached picker. **The dialog reads the settings file, not
the window's cached copy** (the endpoint above writes `settings.llm` without touching that cache; the trap is in
"Testing and benchmarking"). **The "not tried with a real key" mark is gone** with the `tried` flag of every registry
entry and the field `picker()` and `noticeFor()` carried: a row says only what is true of that model. The honest
sentence stays in `docs/ASSISTANT.md` ("What it cannot do") and in the release notes - `docs/BUGS.md` moved the
report to "Fixed, waiting for its release". **Tests:** `node tools/models_test.js` (29 checks, plain Node, the first
step of the `llm` gate), `tools/llm_test.py` step 5 (the dialog writes the row, both pickers take it, the request
reaches the provider on its own key, Remove takes it out again) and `tools/assistant_test.py`
`the_picker_carries_the_users_own_models_and_no_warning_about_itself` (37 steps now). **Mutations: 15 of 16 on the
Node side** (the green one takes the `hasOwnProperty` guard out of `endpoint()`, which no check can see because no
prototype member has a `.base`; written down, not papered over) **and 5 of 5 against the two app gates** (the rows
dropped from `list()`, from `ask()`, from the Add button, from `picker()`, and the mark put back). Gates `--offline`
on both backends (`llm toapis openrouter generate log mcp commands editor assistant`): **ALL PASS** (`lm-tiles`,
`lm-canvas`), each at the first try. **Not covered by any gate, and it is the old line:** no row has run against a
live API - the four new upsampling hosts (DeepSeek, Moonshot, Z.ai, WaveSpeed) are written from the registry's base
URLs, and nothing checks that a model id exists at its provider or that it takes tools; the provider's own error is
what the user sees. **The release:** `npm run dist` built `Scumble Setup 0.1.22.exe`, the CHANGELOG section is dated
2026-09-20, and the exe gates ran `--offline` against `dist/win-unpacked/Scumble.exe` - `rel22-exe` (tiles: log pixels
editor composite commands mcp toapis llm openrouter export assistant) **ALL PASS at the first try**, `rel22-exe-canvas`
(tiles off: pixels editor composite film export assistant) with `editor` and `composite` red and **both green on the
rerun `rel22-exe-canvas-b`**, each a known flake (the live stroke says "a real mouse over the window?", composite's
source windows the same shape as the 0.1.19 release). **No `smoke`** (it needs the user's ComfyUI), and no model has
run against a live API. The tag `v0.1.22` is pushed, CI built the draft, and **0.1.22 is Latest since 2026-09-20**
on the user's word ("machen wir klar", the same evening); `latest.yml` on the feed answers `version: 0.1.22` (check
`gh release list` before believing any release state written down anywhere).

**2026-09-20: the two defects the OpenRouter session found are fixed, for 0.1.21** (`docs/BUGS.md` "Fixed, waiting
for its release"; CHANGELOG 0.1.21; `docs/RECIPES.md` "Import"). (1) **FLUX.2 [flex] on fal** carried
`num_inference_steps` and `safety_tolerance` both at `"index": 1`; measured in the app on the old file before the fix,
the panel showed two rows instead of three (no *Steps* at all) and the request went out as
`num_inference_steps: "2", guidance_scale: 2.5, safety_tolerance: "2"` - 2 steps instead of 50, and as a string. The
row is slot 3 now. (2) **A recipe with a `providers` map could not be imported** (`importFile` took only the old
one-provider shape): `hasVariants` takes either shape, an empty map and an array count as no provider and get a
message of their own, and `importFile` answers the **normalized** recipe as `list()` serves it - two defects of the
same path that came with it, because the Settings note read "Imported ... (undefined, 0 nodes, 0 settings)" for a
provider recipe (it names the providers now) and the refusal carried the IPC prefix (stripped, as the file's three
other handlers do). **New gate `recipes`** (`tools/recipes_test.js` in plain Node, then `tools/recipes_test.py` in
the app): every settings row of every shipped recipe owns its slot (1 to 8) and its key - 138 rows in 91 provider
variants plus the comfy recipes, the only shared slot in the tree was the FLUX one - and the importer in both shapes,
what stays refused, and the import through the Settings dialog end to end. A mutation round of **19 turned a check
red, all 19** (17 in Node, 2 in the renderer against a restarted app). Gates `--offline` on both backends
(`recipes pixels editor composite commands size transparent generate log mcp toapis openrouter ark llm`):
**ALL PASS on tiles and on the canvas backend**, each at the first try. **Found on the way and fixed:** the `toapis`
gate left the *window's* view of `gpt_image_2` on toapis while restoring the stored settings, which made the
`openrouter` gate red when it ran after it (`openrouter` alone on a fresh profile passed); its cleanup now puts every
recipe it switched back through `selectRecipe`, and the trap is in "Testing and benchmarking" below. **0.1.21 is
still unreleased** (0.1.20 is Latest); ComfyUI (8188) did not answer in this session, so the two points that need it
are still open.

**2026-09-20: the `buildModal` split (item 11) is built** (`docs/BUILD_NODE.md`, its file table and the module-cycle
note). `renderer/editor/inpaint_modal.js` (758 lines) holds `buildEditorModal(ed)` and one function per part -
`buildTopBar`, `buildTools`, `buildView`, `buildSidePanel`, `buildLayers`, `buildReferences`, `buildSelection`,
`buildCanvasPanel`, `buildExport`, `buildPrompt`, `buildGenerate`, `buildSettings`, `buildHistory`, `buildCrop` -
and the class keeps a four-line `buildModal()` that calls it; `inpaint_canvas.js` is 12,808 lines down to 12,126.
**The move is proven**, by a verifier written against the untouched copy (the session's scratchpad,
`verify_modal.js`): the module taken apart, `ed` read back as `this`, the indentation level put back, the pieces
returned to the method's order - **654 of 654 non-empty lines identical, 0 different**. What changed: `this` -> `ed`
at **524 places, in code only** (a scanner that knows strings, template holes, comments and regex literals, 14 tests
of its own; the 6 `this` in tooltip text - "Everything in this editor" - are untouched), one indentation level, 72
frame lines (heads, doc comments, calls, braces), and **one line that is not a pure move**: `pane = this.panes.gen;`
became `toGenPane()`, because `pane` is a closure of the side panel and the Generate tab is filled after it.
`inpaint_modal.js` imports the DOM helpers and `hostText`, `REF_FITS`, `REF_DEFAULTS`, `UPSAMPLE_CASES`,
`randomSeed` back from `inpaint_canvas.js` (now exported) and reads all of them inside functions only: the same
cycle rule as stage 1. **That one translated line had no gate**, so `editor_test.py` got
`every_panel_sits_in_the_tab_it_belongs_to` (Selection / Canvas / Export in the Image tab, Prompt / Generate /
Settings / History / Crop in the Generate tab, neither in the other, and the lists and bars present); four
mutations against a restarted app (no `toGenPane`, no Crop panel, no tool column, no reference list) all turn it
red. Gates `--offline` on both backends (`pixels editor composite commands shape brush film glb ailabel size
transparent generate log mcp recipes`, tiles also `nodecopy`): **ALL PASS**, at the first try. The dialog was also
looked at in a running app (no console error, every panel in its tab, the plugins' sections still arriving through
`ed.addSection`).

**2026-09-20: the assistant (item 13) is started - A0, the server split, is built** (`docs/PLAN_ASSISTANT.md`
"A0 as built", `docs/MCP.md`). `electron/main/mcp/server.js` now has `createServer(backend, opts)` beside
`serve(backend, opts)` (= `createServer` plus the stdio transport), exports `{ serve, createServer, toTool,
toolName, textOf, INSTRUCTIONS }`, and takes its `changed` listener off the backend again when the server closes
(the Bridge outlives an in-memory session; Node warns after ten). **Nothing an external agent sees changed, and it
is proven:** the server's info, capabilities, instructions and all 72 tools (62 core, 10 plugin) read through
`mcp_test.py`'s own client, in proxy and in headless mode, before and after the split - four reads, one md5
(`05837058b7b253f9156769bd89b9f14f`). **Not the plan in one point:** its `onclose` chain is gone, because nothing
sets `server.onclose` before `createServer` does (an unreachable branch; its mutation was the only one to survive).
`tools/assistant_test.js` is the new plain-Node test (section 1, 11 checks, including the listener over 20 sessions
and a child process that runs the real `serve()` on stdio and lists the same tools); 8 of 8 mutations red. Gates:
`node tools/assistant_test.js` PASS, `mcp` headless PASS, `mcp commands` on both backends ALL PASS. `--exe` was not
run: the package in `dist/win-unpacked` is 0.1.20, so that run belongs to the assistant's own release (A9).

**2026-09-20: A1 is built too - the loop, the policy, the registry and the Anthropic adapter, in plain Node**
(`docs/PLAN_ASSISTANT.md` "A1 as built"). Eight modules under `electron/main/assistant/`, none of which requires
Electron: `http.js` (the streamed POST, the retries only before the first byte, `scrub`, the test-key rule both
ways, and `loopbackBase` / `compatBase` / `refusesImage` written again from code that does not export them),
`sse.js`, `providers.js` (the ten providers, all marked "not tried with a real key"), `models.js` (the prices of
2026-09-19), `prompt.js`, `policy.js` (the whole §5 table as data, `clamp`, `undoStep`), `anthropic.js` and
`index.js` (the turn: pin, canonical arguments, policy, ask, the call through the in-process MCP client,
ownership by all three rules, the caps, Stop). **Two things the plan did not have, both found by the mutation
round:** a tool that takes a layer but no `doc` had its layer references sent unresolved (now `takesDoc ||
takesLayer`), and the pinned document closed **by the user** mid-turn is answered and ends the turn (the
assistant closing it itself only drops the pin). `node tools/assistant_test.js` is **98 checks** (sections 1 to
10 in their Anthropic shape, the policy table as 54 rows, the leading example, the golden request body); the
mutation round is **36 of 36 red**, after four survivors were each answered with a check or with the removal of
a branch `decide` already covered. Gates: the node test PASS, and `toapis llm mcp commands` re-run, which is what
proves `llm.js` and the command core are untouched. **Nothing is wired into the app yet** (that is A4): no IPC,
no panel, `bridge.run` still takes two arguments, so the assistant cannot be used from the window. **A2 followed the same day** (the next paragraph).

**2026-09-20: A2 is built - Chat Completions and its seven providers, in plain Node** (`docs/PLAN_ASSISTANT.md` "A2 as
built"). `electron/main/assistant/chat.js` is the one adapter; OpenRouter, DeepSeek, Moonshot (Kimi), Z.ai (GLM), ToAPIs,
WaveSpeed and the local endpoint differ only in the dialect data of `providers.js` (the reasoning field, the thinking
switch, the length field, where a screenshot goes, `stream_options` / `tool_stream` / `session_id` / `provider` /
`cache_control`, `strict: false` on Moonshot's tools, the final error codes with their plain words). Tool calls are
rebuilt by `index` and parsed at the end (a whole call in one delta and an `arguments` object too), one `tool` message
per call with an `Error: ` prefix on an error result, a screenshot inline on Moonshot and as one follow-up `user` message
elsewhere, the assistant message replayed as rebuilt with `reasoning_content` on every message (`""` when none came)
and OpenRouter's `reasoning_details` concatenated unmodified; usage read from either last chunk; the seven final
answers (the 402s, Moonshot's quota and daily limit, Z.ai's 1113 / 1261 / 1301) never retried, the overloads and rate
limits retried like any 429. **Not the plan's word:** `openrouterIgnore()` delegates to the image adapter's
`chinaHosts` (one fetch of the host list per session for both, its seven-host dated list); `checkKey` got `localOk`
for the local server's own key, which goes to a loopback URL by nature; `index.js` reads the tool schema from a
family-neutral `chat.schemas` map (A1's lookup used the Anthropic tool shape, so on any other family `doc` would never
have been injected and no layer reference resolved: a latent A1 defect, caught by the first chat-family run); the 18 MB
cap holds for `google/*` and `gemini-*` ids on any provider; an answer that is not an event stream and a stream that
ends empty are errors, not empty turns. **Tests:** `node tools/assistant_test.js` is **179 checks** (sections 11 to 15
new: the golden body of every provider, the loop per dialect, the reasoning replay across turns, images in both
places, the local server's image fallback, keys and hosts, the final answers, cost, and the same answer cut at every
one of its 1,857 byte offsets); a mutation round of **95 against a copy of the tree** (the scratchpad's `mutate_a2.js`),
**all 95 red** (77 of the first 80 at the first run; the three survivors and the review's gaps each got a check).
**A review of four lenses with two refuters per finding (27 findings, 22 held, 5 fell) fixed ten things, four of them
A1's:** a stream that ends before its `finish_reason` pushed its half answer as the answer (on Anthropic too; now an
error that pushes nothing); pruning ran at every new user message once more than `keepImages` were attached instead of
above twice that (the plan's batches); `refusesImage` was wider than `llm.js`'s rule, so a local server's 400 about an
unsupported parameter would have stripped every screenshot and turned `screenshot` off; the "(stopped)" line stood
twice in a pending user message. A2's own: a refusal with calls left them unanswered (every later request a 400), a
server without `index` merged or split its calls, an `arguments` array ran as a tool's arguments, two error paths in
the adapter were unscrubbed, a failed host-list read was asked again before every call. Rejected: `reasoning` for
every curated OpenRouter model (kept; the live list is A4's), the truncated error body (`err.body` is whole), the
`localOk` gap (already red in the mutation round). Gates: the node test PASS, `toapis llm` `--offline` ALL PASS
(`a2-node`, and `a2-node2` after the fixes). **Nothing is wired into the app yet** (A4), and no dialect has run against a
live key. **Next was A3** in the plan; the user asked for A4 first ("jetzt a4 verdrahten"), which is the next paragraph.

**2026-09-20: A4 is built - the door between the window and the loop, with its review worked through**
(`docs/PLAN_ASSISTANT.md` "A4 as built" and "A4, the review and what it changed"). Built **before A3**, on the
user's word ("jetzt a4 verdrahten"), for the two families that exist; OpenAI and Gemini stand in the picker as
"not built yet" until A3 lands. **IPC** in `main.js` (`assistant:send` / `stop` / `answer` / `reset` /
`state` / `models` / `openrouterModels` / `tools` / `noticed`, the instance made at the first call so the SDK is
not loaded at start, every event of the loop on `assistant:event`), `window.scumble.assistant.*` and
`commands.onCancel` in the preload, **`bridge.run(name, args, meta)`** with `commands:cancel` for a request the
turn abandoned while it waited, the shell's handler reading `meta` (a request without `meta` takes the old path
byte for byte), **`renderer/assistant_wait.js`** (the user-activity wait), `DEFAULTS.assistant` in `settings.js`,
the relaunch refusal and `before-quit`, and **three key rows** (DeepSeek, Moonshot / Kimi, Z.ai / GLM; `docs/HELPERS.md`).
**`tools/assistant_mock.py`** plays all four families (Responses and Gemini already, for A3) and
**`tools/assistant_test.py`** is the new gate `assistant`, which refuses a profile that holds a key and an instance
connected to ComfyUI, and goes last in a list. **The review** (six lenses, two refuters per finding) was cut short
by the other session's usage limit - 36 findings, 16 of 72 verdicts - and this session read the workflow's journal
and judged the rest by reading. **Fixed:** the non-atomic "a turn is running" guard (two sends in the
`connect()` / `newChat()` window started two loops on one chat, the first unstoppable); **a file drop left the
Bridge dead for the whole session** (Chromium announces the navigation before `will-navigate` can prevent it, the
Bridge dropped `ready`, and no `commands:ready` ever came again: measured, an external `--cmd ping` then timed out
at 40 s; `attach()` takes the same rule now); the two plugin reads taking the user-activity wait (the Bridge is
called with command names, the policy's sets hold tool names); `state()` blocking up to 120 s on a renderer that
is not ready; **every assistant log line written empty** (`text` where `log.record` reads `message`, and the test's
own stub had the same typo); `lastTurn` set for read-only turns; the stale tool diff after `reset()`; OpenRouter's
live list cached across a change of base; the local server's key ignoring the test-key rule; and in the wait, a
closed tab's editor kept alive, the wrong document judged, and `upsample_prompt` overwriting a prompt the user was
typing. **The gate's own three:** its cleanup deleted **every key row even when the setup had refused to run on a
profile holding the user's real keys**; the reload step wiped the state the cleanup relies on (it is in Python now,
and the cleanup brings the window back to the app when a step took it off); `Mock.reset()` cleared the failures the
runner reads, so after the first failure every later one was invisible. `node tools/assistant_test.js` is **192
checks**, the gate **19 steps**, the mutation rounds **17 (the build) and 16 (the fixes), all red**. Gates
`--offline` on both backends (`llm toapis log generate mcp commands editor assistant`): **ALL PASS**
(`a4b-tiles`, `a4b-canvas`). **Trap worth keeping:** a page on a custom scheme cannot navigate itself to a `file:`
URL, so a `file:` probe proves nothing about a drop; the probe is an `https` URL on a dead local port.
**A3 followed the same day** (the next paragraph).

**2026-09-20: A3 is built too - OpenAI Responses and Gemini, the last two families**
(`docs/PLAN_ASSISTANT.md` "A3 as built"). Built **after A4**, so both adapters went into a loop the app
already drives: the picker's "not built yet" is gone for OpenAI and Google, and the gate runs a turn on
**all four families** (`every_family_runs_a_turn_in_the_app`: anthropic, openai, gemini, openrouter,
deepseek, moonshot, zai, toapis, wavespeed, compat). **`responses.js`**: the history is a list of input
*items*, not messages; items are taken whole from `response.output_item.done` and never rebuilt from the
deltas, `store: false`, a screenshot in the parts form of `output` (`input_text` + `input_image`), an
error result prefixed `Error: `, `response.incomplete` a cut, a `refusal` part a refusal, a stream
without a terminal event pushes nothing. **Not the plan's word:** the request also asks for
`include: ["reasoning.encrypted_content"]` (the plan says `store:false` returns it by itself and §7 lists
that as unverified; asking costs nothing if it does and is what makes the replay work if it does not).
**`gemini.js`**: `generateContent` with `x-goog-api-key`, the model's parts sent back in their order and
**never merged** (a `thoughtSignature` stays on its part), tool results one user content of
`functionResponse` parts, a screenshot an `inlineData` part inside that response with the JSON answer
pointing at it by `displayName`, `MAX_TOKENS` a cut, the block reasons refusals, no `toolConfig`, and the
registry's 18 MB cap. **Three things the plan did not have:** `appendUserText` per adapter (the loop adds
a stopped turn's text to the pending user message, and A1's helper writes Anthropic-shaped parts, which
neither new family takes); a `functionCall` without an `id` must not be answered with the loop's own id
(`rawId`); and a `functionResponse.response` is a struct, so an array or scalar result goes in under a
name. `node tools/assistant_test.js` is **214 checks** (section 17), the mutation round **26 of 26 red**,
gates `--offline` on both backends (`llm toapis log generate mcp commands editor assistant`) **ALL PASS**
(`a3-tiles`, `a3-canvas`). **Nothing has run against a live key.**
**The checkpoint ran the same day** (the next paragraph).

**2026-09-20: the checkpoint ran, in the short form the user asked for** (`docs/PLAN_ASSISTANT.md`
"Checkpoint as run"; the user: "so viele tests brauchen wir nicht nur ganz kurz die funktion ... nur ein
kurzer call je modell maximal um verdrahtung zu testen"). One live turn per model against the real hosts,
on a scratch profile. **The keys the user holds are Anthropic, OpenAI and Google** (plus bfl, fal,
replicate, comfycloud for the image providers); **no key for the Chat Completions family**, which stays
"not tried with a real key". What the hosts answered: Anthropic **401 `authentication_error`** on both
models, OpenAI **401 `invalid_api_key`** (the stored key does not have OpenAI's `sk-` shape), Google
**429 `RESOURCE_EXHAUSTED`, "Your project has exceeded its monthly spending cap"** - which means that
request **authenticated**. So every family builds its request from the settings, reaches its real host
over the real key, reads the answer, keeps the key out of the error and ends the turn cleanly; **no
model could pay for a task, so there is no go or no-go per model yet.** **Found and fixed on the spot:**
a 429 that will never clear was retried (15.3 s of four identical refusals, and raw JSON as the error);
`gemini.js`, `responses.js` and `anthropic.js` now have `finalWords(status, body)` like `chat.js`'s
dialects - a spending cap, an empty account, an invalid key and a model the provider does not serve are
final and **read as a sentence**, a plain rate limit is still retried; measured live again, all four
rows answer in **0.5 to 0.6 s**. `a_final_answer_is_not_retried_and_reads_as_words` is the check (four
mutations red), the node test is **215 checks**, gates `--offline` on both backends (`llm toapis mcp
commands assistant`) **ALL PASS**. **Trap worth keeping:** on Windows `safeStorage` encrypts with a key
that lives in `<userData>/Local State`, so a scratch profile holding a copy of `secrets.json` alone
decrypts nothing and every row reads "no API key" - copy both. **What the user has to decide:** a
working key (Anthropic, OpenAI, Google - or an OpenRouter key, which would also cover the Chat
Completions family), then the five-task form of the checkpoint costs well under a dollar. **The user's
word (2026-09-20): "hab gerade keinen key, lass uns das testing ueberspringen, machen wir nach release
mach dann eh extreme bug suchen"** - so the model-by-model verdicts wait for the release and the user's own
bug hunt, and building went on with A5.

**2026-09-20: A5 is built - the panel** (`docs/PLAN_ASSISTANT.md` "A5 as built"). `renderer/assistant.js`
(about 600 lines) and `assistant.css`, a `<dialog id="assistant">` in a new `#shell-main` row of
`index.html`, a bar button, **View > Assistant (Ctrl+Shift+A)**, and **`tool_end`** as a new event of the
loop. The plan's three rules hold: a non-modal `show()` (the canvas stays usable, the panel stays out of the
top layer), **one window capture `keydown` listener** registered at shell start so it runs before any editor
question's, and **no markup written anywhere** (`renderText` builds with `createElement` and `textContent`;
the Node check `no_markup_writes` holds the file to it). The picker is grouped by provider, a provider
without a key greyed out, models marked ("cannot look at the picture", "not tried with a real key"), a free
OpenRouter id from the live list; the chat shows bubbles, streamed text rendered once when the block ends,
tool cards (`running`, `done in N s`, the result in a `<details>`, a screenshot thumbnail) and ask cards
with the policy's reason, the file, the recipe and old > new values, **neither button a default**; an ask
opens the panel by itself. **Three things the plan did not have and one it had wrong:** `tool_end` (the
panel cannot say what a call did without it; `state()` strips its data URL so a reloaded panel carries no
base64 over IPC); **a call id is unique inside its turn, not the chat** (every family numbers per request,
so `tool_end` found an older turn's card - the cards live in a `Map` the turn empties; the gate found it);
**Escape and the focus guard fought each other**; and the plan's `keepFocus` flag is set by a focus event
**a window in the back never gets** - the guard reads the `focusout` instead. Gate: **five new steps, 24 in
all**; a mutation round of **13, 10 red** (the three green ones are each a rule a second rule already
covers, written down). Gates `--offline` on both backends (`editor composite generate transparent size log
mcp commands assistant`): **ALL PASS** (`a5-tiles`, `a5-canvas`). **Trap worth keeping:** Chromium delivers
**no focus or blur events at all** to a window that is not focused, and a gate runs behind the terminal:
`focus()` moves `activeElement` silently, so a focus test has to dispatch the `focusout` the real app would
fire. **A6 followed the same day** (the next paragraph).

**2026-09-20: A6 is built - the chats on disk and the reset** (`docs/PLAN_ASSISTANT.md` "A6 as built").
`electron/main/assistant/store.js`, four channels (`assistant:chats` / `:open` / `:delete` /
`:resetAll`), **`log.forget(source)`**, the panel's *Chats* list and a **Settings > Assistant** section
(how many chats to keep, the step cap, *Delete all assistant data*). A chat is written at the end of
**every** turn to `<userData>/assistant/chats/<id>.json` through a temporary file that is renamed, its
screenshots beside it. **The pictures are taken out of the JSON and the way they go back is the point:**
the marker `$image:<n>.jpg|<prefix>` carries the prefix the family's own shape had, so the history comes
back **byte for byte** - Gemini and DeepSeek answer 400 on a history that was edited. `store.js` knows no
family: it walks the JSON and replaces what looks like image bytes. **Reopening** goes on only on the
provider and model the chat was saved with and only with a key for them, else **read-only** (the field and
Send disabled, `_start` refuses); ownership (`owned`, `seen`) is not restored, so the policy asks again
before a layer of an earlier session is touched. A file that does not parse is a row with a delete button,
a picture whose file is gone becomes a line. **The reset** removes `<userData>/assistant/` whole, writes
the defaults back, calls `log.forget("assistant")` (the ring **and** `scumble.log` / `scumble.1.log`) and
closes the panel - **no key row is touched**, and the gate checks that. **What the mutation round found,
and it is the plan's own:** the **one line per turn in the app log** (A1's, the one the reset takes out)
**had never been written**, so "no assistant line left in the log" was a check that could not fail;
`recordTurn()` writes it now and the gate proves the lines were there first. Node **224 checks**
(section 19), the gate **29 steps**, a mutation round of **14, 13 red** (the green one writes the file
without the rename, which only a crash mid-write would show). Gates `--offline` on both backends
(`editor log mcp commands assistant`): **ALL PASS** (`a6-tiles` after two known start-of-instance flakes
of `editor` - `a_settled_read...` and `erase_stroke...`, the third run 68 of 68 -, `a6-canvas` at the
first try). **A7 followed the same day** (the next paragraph).

**2026-09-20: A7 is built - Ctrl+Z for every step, and "Undo this turn"** (`docs/PLAN_ASSISTANT.md`
"A7 as built"). **Per step:** `policy.undoStep` names the editor's own step kind for the call about to go
out, `backendFor` sends it as `meta.undo` with the layer it is about, and the shell's handler calls
`ed.pushUndo()` right before `commands.call` - no command and no editor behaviour changes for it.
**Per turn:** `turnSnapshot()` / `restoreTurn()` in `inpaint_canvas.js` (a `canvas` step **plus a
copy-on-write clone of every layer's pixels and mask** - a `canvas` step keeps the layers by reference,
which a row of edits that write in place would lose - **plus what no undo step holds**: prompt, negative
prompt, generation and crop settings, the recipe's setting values), `applySnapshot`'s new `turn` branch and
`releaseSnapshot` releasing the clones. `renderer/assistant_turns.js` keeps the last changing turn's
snapshots, **one per document, taken at that turn's first change there**, holds no editor, and a closed tab
takes its snapshot with it. The restore pushes the present as one `turn` step, so **Ctrl+Z takes the
restore back**; the snapshot sits outside the stack, so **a turn of 35 steps comes back whole** although
the stack trimmed to 30. **The user's own edits** during a turn are watched as **trusted** pointer, key and
input events inside an editor root, and the button asks before it discards them. After a restore
`assistant:turnUndone` sets `chat.undone`, so the next state note says so. **Canvas backend:** no snapshot
(600 MB per full layer at 15k), and the gate's four turn steps skip there,
`turn_undo_is_refused_on_the_canvas_backend` being the check instead. Gate **36 steps**, a mutation round
of **13, 12 red** (the green one takes the per-layer clones out: every auto call that writes pixels in
place asks first, so only the selection's clone is covered by a step - written down, not papered over).
Gates `--offline` on both backends (`editor composite pixels nodecopy mcp commands assistant`): **ALL
PASS** (`a7-tiles`, `a7-canvas` / `a7-canvas2`). **Traps worth keeping:** a test cannot fake the user -
`dispatchEvent(new KeyboardEvent(...))` is never trusted, which is the point of the rule; the gate uses CDP
`Input.insertText` into the editor's own prompt field. And a mutation that breaks a gate run leaves the
gate's test keys in the profile, so every later run dies in `setup` - a runner that counts that as red
proves nothing. **A8 and A9 followed the same day** (the next paragraph).

**2026-09-20: A8 (the documentation) and A9 (the release) - the assistant is in 0.1.21.**
**A8** is its documentation, not its measurements: `docs/ASSISTANT.md` (the whole feature for the user - the
key rows and the providers, what a turn is, what asks before it acts, **how to take it back**, the chats and
the reset, **where the picture goes** per provider, what it cannot do, the keys and the focus rules, what it
costs), one sentence in `docs/PROMPTS.md`, the in-process client in `docs/MCP.md`, the assistant's path in
this file's "How the app is put together". **Not done and written into the plan** (`docs/PLAN_ASSISTANT.md`
"A8, as far as the user asked for it"): the 15k measurement and the rule it would decide (a screenshot cap
on the canvas backend), the remaining §6 gate steps and the plan's twenty-one-mutation round - what exists
instead is **36 gate steps and 66 mutations across A4 to A7**. **A9:** `npm run dist` built
`Scumble Setup 0.1.21.exe`; **exe gates against the package, `--offline`, ALL PASS at the first try** -
`rel21-exe` (tiles: log pixels editor composite commands mcp assistant toapis llm export) and
`rel21-exe-canvas` (tiles off: pixels editor composite film export assistant), the assistant gate **36 of 36
on both**. The CHANGELOG's 0.1.21 section is dated 2026-09-20 and its assistant part rewritten (it is in this
version, not "coming"); the tag **`v0.1.21`** is pushed, CI built the draft, and **the user published it the
same evening: 0.1.21 is Latest since 2026-09-20** (`latest.yml` on the feed answers `version: 0.1.21`; check
`gh release list` before believing any release state written down anywhere). **No `smoke`** (the user's
ComfyUI was not free), and **no model has completed a task against a live API** - the picker marks every
provider "not tried with a real key", and that is what the user's own bug hunt after the release is for.

**Where the assistant stands after 0.1.21, for whoever comes next.** Built and shipped: A0 to A9 of
`docs/PLAN_ASSISTANT.md` (each with its own "as built" section there). **What is not done, and why:** the
checkpoint's model-by-model verdicts and A8's measurements at 15k, both on the user's word ("lass uns das
testing ueberspringen, machen wir nach release mach dann eh extreme bug suchen"); the remaining gate steps
of §6 and the plan's twenty-one-mutation round (36 gate steps and 66 mutations exist instead); the per-layer
clone of a turn snapshot has no check of its own (every auto call that writes pixels in place asks first,
so no gate turn reaches it). **What the user has to bring:** a key that can pay - Anthropic, OpenAI or
Google (their stored ones were invalid or capped on 2026-09-20), or an OpenRouter key, which would also
cover the seven Chat Completions providers and the route comparison. **Optional and only on the user's
word:** A10 (a budget, "allow for this chat", a basic tool set) and A11 (the assistant's own undo steps).
**Reported by the user the same evening, on the list, not fixed:** the picker marks **every** model "not
tried with a real key" and so reads as a warning about the app (`docs/BUGS.md`, "The assistant's picker
warns about itself"); what the mark should be instead is the user's call, and the honest sentence belongs
in `docs/ASSISTANT.md`, not on every row. **After the assistant comes SignPath** (the user, 2026-09-19:
"assistant kommt vor codesignierung").

## Where things stand (2026-09-19)

**2026-09-19, evening: OpenRouter (item 12) is built, for 0.1.21** (`package.json` 0.1.21, `CHANGELOG.md` "0.1.21 —
unreleased"; `docs/RECIPES.md` "OpenRouter", `docs/HELPERS.md` "Through the OpenRouter key"). **Not the item's plan:**
the image adapter (`electron/main/providers/openrouter.js`) uses OpenRouter's unified Image API, `POST /api/v1/images`
(`input_references` as data URLs, `b64_json` back, `usage.cost`), because the current docs describe only that route
for images; the chat `modalities` route has no guide any more. Only the parameters each model's endpoints list in
`GET /api/v1/images/models` go out (`options.accepts`), no pixel size (no model lists `size`), an edit sends no
`aspect_ratio`, *Resolution* auto takes the smallest tier covering the crop; no mask field exists, so GPT Image and Nano
Banana get the mask as a second picture (as the Gemini adapter), FLUX.2 / Seedream / Grok an instruction edit, Krea 2
and Recraft V4 are text only. `openrouter` is a variant in 14 recipes, **last** in each (no default changed), the key
row after Comfy Cloud, `TEXT_PROVIDERS` has it. Four upsampling rows (Gemini 3.8 Flash, GPT-5.6 Luna, Claude Haiku 4.5,
Mistral Small 4) with a per-row `reasoning` switch and `provider: { data_collection: "deny", ignore }`. **Privacy:** no
attribution header on any request (the trademark check); every image and chat request carries `provider.ignore` with the
hosts OpenRouter lists in China (`GET /api/v1/providers`, once per session, a dated fallback list), so **Qwen Image 3 is
not offered** (its only host, Alibaba, has a CN datacentre); Nano Banana Pro's 4K goes only to Google AI Studio
(`options.only_for` -> `provider.only`). Host rule: `settings.openrouter.base` is openrouter.ai or a loopback mock only,
a `test-` key goes only to the mock and a real key never there. *check balance* reads `GET /api/v1/key` (the key's own
limit, the period's use; the account's credits need a management key). Retries: 429, 529, an overloaded 503 and the
in-flight 402 once, never before `Retry-After`, not at all past 60 s ("try again in N s"). **On the way, for every
provider:** `llm.ask()` takes the key out of every upsampling error (it was left in on the direct OpenAI / Gemini /
Anthropic adapters and in ToAPIs' errors), and the OpenAI-compatible client throws on a refusal (`content_filter` /
`message.refusal`) and on `finish_reason: "error"` instead of returning partial text. **Tests:** `node
tools/openrouter_test.js` (12 sections, 168 checks), gate `openrouter` (`tools/openrouter_test.py` against
`tools/openrouter_mock.py`); a final mutation round of 95 mutations (the scratchpad's `or_mutate3.js`) turned a test red
for every one. Gates `--offline` on both backends: `openrouter toapis llm generate size transparent mcp log` ALL PASS
(after the last code change `openrouter toapis llm mcp` again). Two reviews (four lenses, then three, two refuters per
finding) found 13 and 8 defects, all fixed or written down. **Not run against the live API**: the user's key decides
what `docs/RECIPES.md` "Only a real key can verify" lists. Found on the way and filed, not fixed (`docs/BUGS.md` "What
OpenRouter (item 12) found on the way"): FLUX.2 [flex] on fal has two settings rows at index 1; a model recipe with a
`providers` map cannot be imported.

**2026-09-19, later the same evening: BytePlus ModelArk (item 12b) is built, for 0.1.21 too** (`docs/RECIPES.md`
"BytePlus ModelArk", CHANGELOG 0.1.21). `electron/main/providers/ark.js`: `POST <host>/api/v3/images/generations`,
synchronous, `image` as lowercase data URLs, **`size` always `WxH`** (the crop's own shape inside the model's
method-2 pixel range; a text run exactly the dialog's aspect), **`watermark: false`** (the default is true),
`response_format: "b64_json"`, `output_format: "png"`; no mask (instruction edit), no seed, no `n`. An `ark` variant
right after `toapis` in `seedream_5_pro` (`dola-seedream-5-0-pro-260628`, 0.92 to 4.6 MP, 10 pictures, Johor only)
and `seedream_5_lite` (`seedream-5-0-260128`, 3.7 to 16.8 MP, 14 pictures, a *Region* row ap-southeast Johor /
eu-west Dublin, `limits.max` 7680 so a 16:1 crop reaches the floor); **fal stays the default** of both. The host
comes only from the region (two fixed hosts, own-property lookup), `settings.ark.base` is a loopback mock only,
with the same `test-` key rule as OpenRouter. Pictures checked before sending (16:1, > 14 px, 36 MP, 30 MB with a
JPEG fallback for opaque ones); retries only for `ModelAccountIpmRateLimitExceeded` / `ServerOverloaded`, never
before `Retry-After`, not past 60 s. **Not run against the live API**; a model must be activated in the console, a key
works only in its region, some accounts need an endpoint id (not supported). **BytePlus' country list (21 April
2026) has Germany and the EU but not the United States** (the user said "bin eu / usa"). Tests: `node
tools/ark_test.js` (161 checks), gate `ark` (`tools/ark_test.py`, `tools/ark_mock.py`); a mutation round of 117
(the scratchpad's `ark_mutate.js`) all red. One review round (three lenses, two refuters each): 10 findings, the 7
that held fixed (the 401 / `InvalidAccountStatus` / `QuotaExceeded` words, the exact text-run aspect, the pro note's
Dublin sentence and input fee, the privacy wording with Indonesia, lite's 16:1 floor, `select_recipe`'s list).
Gates `--offline` on both backends: `ark openrouter toapis llm generate size transparent mcp log` ALL PASS.

**0.1.20 is published** (Latest since 2026-09-19, on the user's word; `latest.yml` on the feed says 0.1.20, the release
body is the CHANGELOG section): `package.json` 0.1.20, `CHANGELOG.md` "0.1.20 — 2026-09-19", `npm run dist` built
`Scumble Setup 0.1.20.exe`, the tag `v0.1.20`, CI's draft published (check `gh release list` before believing any
release state written down anywhere). Exe gates,
all `--offline` against `dist/win-unpacked/Scumble.exe`, each on its own profile: `rel20-exe` (tiles: log pixels editor
composite commands shape brush film glb ailabel size transparent generate mcp toapis llm export pxjobs), `rel20-exe-canvas`
(tiles off: pixels editor composite commands shape brush film size transparent generate) and `rel20-exe-huge`
(`huge:30000x20000`) ALL PASS at the first try. On a huge document the provider crop still takes the canvas fallback
(`readBoxBytes` skips the stack above the canvas limit): 552 ms blocked at 30k in `huge_test`, not the user's size.

**2026-09-19, the session after 0.1.19 (what 0.1.20 carries).** Three of the four daily-use bugs are fixed, each
with a gate step, mutations and both backends' gates ALL PASS (`docs/BUGS.md` "Fixed, waiting for its release"):
large JPEG / WebP / profiled PNG files open through a pool worker (`image_read`; the block at 15k 0.95 to 4.4 s down to
34 to 98 ms, the same bytes), a provider run's crop and stitch run in a stitch worker of their own with the box from the
tile workers (`prepareCropAsync` / `finishResultAsync`, `readBoxBytes`, `stitch_worker.js`; 0.67 / 1.47 / 6.28 s blocked
on a plain / matched / matched-and-filmed 15k document down to 24 / 22 / 51 ms), and on tiles a stroke is committed a
tile at a time through the compositing kernel (`commitStrokeTiles`, `compositeStroke`; the release 70 to 288 ms down
to 34 to 66 ms, `tools/release_test.py` is the new measurement with real mouse events). The fourth ("erasing switches
the active layer to the base") is closed on the user's word (2026-09-19: "bug ist beim letzten test nicht
aufgetreten"): the report's recordings pointed at the display bug fixed in 0.1.8. **`smoke` ran** (the user freed ComfyUI for an hour): on the dev
tree with the three fixes in, tiles and canvas backend with `--no-helpers`, and once in full with every helper (SAM3,
RMBG, Qwen-VL, SAM2 on the server; the in-app SAM2 / RMBG were skipped: no model in a fresh profile), ALL PASS; and a
local run on a 6000 x 4000 document with a soft, a matched and a levels layer: the base went up in bands through the
filter program and reached the node byte for byte (its hash recomputed), the result landed at the crop box. **Found
there:** the node's own stitch spent 15 of the run's 19 minutes on one CPU core (a square `max_pool2d` over the whole
picture's mask); a byte-equal fix (separable dilation, masks on a window) is prepared and tested in that session's
scratchpad and, on the user's word, **committed and pushed in the node repo (`fba1fd8` on master); it goes live in the
user's ComfyUI with its next restart, which the user does** (`docs/BUGS.md` "A local run on a large document spends minutes in the node's
stitch"). Not done: the node in a real ComfyUI tab and in
Firefox (the node repo is behind; building the editor into it is a node release).

**Releases.** **0.1.19 is published** (Latest since 2026-09-18, `v0.1.19`, the CI draft published from this session on the user's
word; `latest.yml` on the feed says 0.1.19, the release body is the CHANGELOG section; no `smoke`; exe gates, all `--offline` against `dist/win-unpacked/Scumble.exe`: `rel19-exe` (tiles, the full list with pxjobs) ALL
PASS, `rel19-exe-huge` (`huge:30000x20000`) PASS, `rel19-exe-canvas` (tiles off: pixels editor composite film export)
ALL PASS on the rerun `rel19-exe-canvas-b` of editor and film, whose first run failed on the live stroke's pointer
message and the film panel's thumbnails (0 of 5 rendered) while the user was at the machine; no `smoke`, on the user's
word). **0.1.18 is published** (Latest since 2026-09-18, published by the user's word at the end of the part 3
session; `latest.yml` on the feed says 0.1.18, the release body is the CHANGELOG section). **`package.json` is 0.1.19
and `CHANGELOG.md` has the 0.1.19 section**, with B item 7 part 3 (item 10 below; committed, pushed, CI green on
2026-09-18) and the `set_layer match_source` fix. 0.1.18 carries B items 1 to 5 and item 7 parts 1 and 2. Exe gates for 0.1.18, all `--offline`: `rel18-exe` (log pixels editor
composite brush film export toapis mcp pxjobs), `rel18-exe-canvas` (tiles off: pixels editor composite film export) and
`rel18-exe-huge` (`huge:30000x20000`) ALL PASS, three of them on a rerun, each a known flake (the settled-read step and
the 1200 x 794 composite canvas together in the first seconds of one exe instance; the live stroke step on the canvas
backend). **`smoke` was not run** (the user's ComfyUI). **0.1.17** (published 2026-09-17) carries phase E
(E1 to E5). Exe gates for 0.1.17, all `--offline`:
`rel17-exe` (log pixels editor composite brush film export toapis mcp pxjobs), `rel17-exe-huge` (`huge:30000x20000`) and
`rel17-exe-canvas` (tiles off: pixels editor composite film export) ALL PASS; CI's `build_px.py --check` passed with the
crate's new dependency (miniz_oxide). **`smoke` was not run** (the user's ComfyUI was busy); instead Pillow 12.2 from the
ComfyUI's own Python read a PNG joined from parts (pixels exact, tEXt intact, `verify()` ok). Check `gh release list`
before believing any release state written down anywhere.

**Phase E is built** (2026-09-17, `docs/PLAN_BCE.md` §3 "E1 as built" and "E2 to E5 as built", CHANGELOG 0.1.17).
What it is, because it is **not the plan's design**: there is no second compositor in the workers. A band of an export is a
**region pass at full resolution** (`sampleRegion` at scale 1 with `boxReach`'s margin, `readBand`), and the worker pool
(`renderer/editor/inpaint_pool.js`, up to 8 workers started on demand, priorities, `cancel(group)`, `progress` replies) does
everything that is not compositing: PNG parts (a Rust deflate with a sync flush per part, joined into one zlib stream:
`inpaint_png.js`), PackBits for PSD, CRCs for ORA, hashes, PNG decoding as a stream, the mip chains. Tiles live in a
SharedArrayBuffer arena (`inpaint_arena.js`) and workers read them by (chunk, slot). `inpaint_bands.js` holds the row sources
and the PNG / PSD / ORA writers. Filters of the whole picture take `info.full` / `info.origin` / `info.stats`. A document
may be larger than any canvas (268 MP): up to 65,535 px a side and a gigapixel, PNG only, opened through the stream reader;
`tools/huge_test.py` is its gate (30000 × 20000: open 9.6 s, PNG 10.5 s, PSD 13.7 s). **Not met and written down in
`docs/BUGS.md`**: an export in bands is slower in wall time than the whole flatten was (6.2 s against 3.4 s at 15k, the
window stays usable), the halation on huge documents, invert at 30k, the 5 ms of the mip refresh. **`smoke` ran on it on
2026-09-19** (see the top of this section): the base upload in bands and a real run met the user's server, PASS.

**Built.** C6 (c) slices 3 to 7a, each with its gates, mutations and measurements in `docs/PLAN_BCE.md` §C6 ("C6 (c3) and
slice 4 as built", "slice 5 / 6 / 7a as built"). The tile engine is on by default in the installed app since 0.1.13, with a
switch in Settings › Rendering; the canvas backend is the escape hatch.

**Constraints right now.**
- **The user needs their ComfyUI instance** (2026-09-16; freed for one hour on 2026-09-19, when `smoke` ran): no `smoke`,
  and no gate that forwards to it (`commands`' `large_upload_route` uploads through the mirror to a connected ComfyUI),
  until the user says it is free.
- **A headless MCP instance can block the app from starting** (`docs/BUGS.md`): this repo's `.mcp.json` starts the dev app
  with `--mcp`, which holds the default profile's single-instance lock, and Scumble then shows no window. Stopping the
  `electron.exe ... --mcp` processes fixes it; the missing hand-over is not measured.
- **§C7's memory gate is not met** (at most 300 MB of GPU process per document); the default went on anyway, on the user's
  decision.
- **The node repo is behind** (its `js/` is built from 7f01699, before C3; master is fba1fd8 since 2026-09-19, pushed:
  1f37ad0, `exportIsPlain` in the node's own `js/host.js`, which the editor asks for since E2 and `build_node.py --check`
  insists on, and fba1fd8, the stitch's masks on a window and a separable dilation, live in the user's ComfyUI after a
  restart; `pyproject.toml` unchanged, so no registry publish ran). `nodecopy` builds and tests it in a scratch copy; build it into
  the real repo only when a node version is meant to ship.

**What comes next, in order** (`dist/c6map/c/` holds the maps; they are older than the code):
1. **7b is built** (2026-09-16, `docs/PLAN_BCE.md` §C6 "C6 (c) slice 7b as built", CHANGELOG 0.1.16): a matched layer on
   tiles is matched in the part a pass shows from its tiles; 1144 MB of mirrors and 837 ms of first frame at 1:1 gone at 15k.
2. **7c is built** (2026-09-16, `docs/PLAN_BCE.md` §C6 "C6 (c) slice 7c as built"): one statistics entry per layer for every
   pass, provisional while chains are in the worker. **The (b) numbers are measured and not yet shown to the user**
   (same section): box means 0.81 levels mean over 32 cases, 5.45 / p99 12 on one textured photo; point samples 0.56, max 8.
3. **7d is built** (2026-09-16, `docs/PLAN_BCE.md` §C6 "C6 (c) slice 7d as built"): the match in the atlas shader.
4. **C6 (d) is built** (2026-09-16, `docs/PLAN_BCE.md` §C6 "C6 (d) as built"): the base is `{ ref, px }`, no <img>.
5. **The object tool's bigger change A** (`dist/c6map/c/objects.md` §7 to §9: the image-size label map, the per-object
   shape canvases): ask the user where it goes.
6. **C4 is built** (2026-09-16, `docs/PLAN_BCE.md` §C4 "C4 as built"): steps on whole tiles, `release()`, exact redo boxes.
7. **The rest of §C7 went as far as it could** (2026-09-16, `docs/PLAN_BCE.md` §C7 "The rest of §C7, as far as it went"):
   docs, `--disable-gpu`, the memory walk (not met: +0.6 to +1.4 GB of GPU process per open 15k document on tiles), the exe
   gates (PASS). **Open, needing the user's ComfyUI:** the node in a real ComfyUI tab and in Firefox, `smoke`, `commands`.
   **Open, needing E5:** the 30k gate. **Next, when the user says so:** a release (0.1.16 has its CHANGELOG section).
8. **Phase R is built** (2026-09-17, `docs/PLAN_BCE.md` §2b "Phase R as built", `docs/PERFORMANCE.md` §12 and §12.1):
   **the user's rule is Rust wherever it is faster, however little** (the 3× rule is gone). Every pixel kernel runs from
   `renderer/editor/px/px.wasm` through `px/kernels.js` in the window and both workers, grow / shrink and the flood as one
   whole-job call each; the JS twins are the fallback (`InpaintEditor.kernels = "js"`). `python tools/build_px.py` rebuilds
   the binaries (commit them; `build.yml` checks them), `node tools/px_test.js` and `python tools/px_jobs.py --check` are the
   gates.
9. **Phase E is built** (2026-09-17, see above). Its open ends are in `docs/BUGS.md` ("What phase E left open").
10. **Phase N is measured and decided** (2026-09-17, `docs/PLAN_BCE.md` §3b "N1 as measured, N2 costed, N3's
   recommendation", `docs/PERFORMANCE.md` §14; `tools/native_test.py` and `tools/native_limits.py` are the tools, run on a
   fresh `--no-comfy` instance). At 15k the browser's share of the wall is a half to 85 % on five rows (open, grow /
   shrink, the wand, PNG and PSD export) and nothing on pan, zoom and stroke frames; all of it is the editor moving tiles
   through canvases, which workers over the arena can do without (option B, about 3 weeks, six items in order). Typed
   arrays end at **15.5 GB** in the renderer (18 full 15k layers), not 8. **The user's decision (2026-09-17): stay on
   Electron and build B; no native tile store, no native editor. The user works up to about 15k**, so B's item 6
   (one-channel masks) goes last and 30k is not the size to tune for. **B item 4 is built** (2026-09-17, same
   section, "B item 4 as built"): `dilateMask` / `boxBlurs` as kernels (ABI 7, `crates/px/src/maskf.rs`), a provider run's
   crop 2.5 s to 0.57 s with the same floats; `node tools/stitch_test.js` is its gate beside `px_test.js`. **B item 1 is built** (2026-09-17, "B item 1 as
   built"): a plain stack (no filter layer, blend mode or colour match) is composited by the pool's workers from the
   arena while they pack it (`stackPlan` / `stackSource` next to `boxReach`, `stackRows` in `inpaint_bands.js`,
   `rowsOfStack` in the worker); 15k PNG 3.5 s to 1.7 s, PSD 3.9 s to 1.3 s, within two levels of the flatten
   (`export_test.py`). `InpaintEditor.stacks = false` forces the bands. **B item 2 is built** ("B item 2 as built"): the
   wand and the bucket on a plain stack flood a `SharedArrayBuffer` the pool composited from the tiles (`floodStack`,
   `floodOverTiles`, worker `stack_into` and `flood` with `sab`), and the wand's answer comes back as selection tiles
   (`applyTilesToSelection`); 15k wand 4.2 s to 1.4 s, the block 1.6 s to 0.18 s, the same selection bytes
   (`editor_test.py` `the_flood_over_tiles_is_the_flood_over_canvases`). **B item 3 is built** ("B item 3 as built"): grow,
   shrink and feather read the selection's box from its tiles in a pool worker and send back the tiles that changed
   (`selectionOverTiles`); 15k grow 0.72 s to 0.51 s, shrink 0.60 s to 0.32 s, the blocks 0.2 s to 0.09 / 0.02 s; grow
   and shrink the same bytes, feather within 5 levels of alpha (the GPU blur). Invert stays on the main thread (0.2 s).
   **B item 5 is built** ("B item 5 as built"): `png_unfilter_rows` (ABI 8) undoes a band of PNG row filters in one
   call, and every plain 8-bit PNG of 32 MP and more (no `iCCP` / `gAMA` / `cHRM`) opens through the stream reader
   (`InpaintEditor.pngStreamFrom`); 15k open 3.2 s to 2.7 s, the block 2.1 s to 0.12 s. The reader is bound by the
   browser's inflater, not by JS as N1 said. **Item 6 (one-channel masks) is set aside by the user
   (2026-09-17): it is the 30k item, the user works up to 15k. Next instead, agreed the same day: B item 7, the worker
   path for the stacks it turns away today, in this order: blend modes in `composite_tile`, filter layers over
   worker-composited bands, a colour-matched layer** (`docs/PLAN_BCE.md` §3b "B item 7"). **Parts 1 and 2 are built**
   (2026-09-18, the night before the release, on the user's standing instruction to build up to 0.1.18 without asking
   again; same section, "B item 7, part 1 / part 2 as built"). Part 1: the eight blend modes in `composite_tile` (ABI 9),
   **rounded once per channel** (exact 16-bit products; within half a level of the exact value, where three rounded
   products were 1.45 off and moved the wand's edge): 15k with a multiply layer PNG 3.4 s to 1.6 s, PSD 3.8 s to 1.1 s,
   the wand 3.9 s to 1.1 s with the same pixels selected. Part 2: **a stack with filter layers anywhere in it is a
   program** (`stackPlan({ filters: true })`, `holdStack`, `programStart` / `programFinish`, `bandSource`): the pool
   composites a band with the filters' reach into a `SharedArrayBuffer`, the bytes go to the GPU as a texture
   (`surfaceFromBytes`), the filters run as in a pass at full resolution, the rows come back once (`readSurfaceBytes`),
   layers above a filter and a filter at an opacity, in a blend mode or through a mask are composited over the result by
   the pool again (a stack layer may be bytes, `sab`); the next band is composited while this one is filtered. Three
   paint layers and a levels layer at 15k: 6.2 s to 1.4 s; with the film look 9.1 s to 5.0 s (block 1.2 s to 0.13 s); the
   wand on a filtered document 3.3 s to 1.5 s. The region pass is the fallback (`NO_PROGRAM`) and keeps its own gate
   (`InpaintEditor.stackFilters = false`, `stackBlends = false` are the A/B switches). Against the flatten: one level on
   1.1 % of the bytes below a filter, a filter never more than one level above what the pass shows. **Part 3 is built**
   (2026-09-18, after the 0.1.18 tag, for 0.1.19; same section, "B item 7, part 3 as built"): a colour-matched layer
   is an entry of `stackPlan` (`match: layer`); `holdStack` is async and takes its statistics from **point samples of
   the tiles** (`stackMatches` / `stackMatchOf`, worker job `stack_points`, the grid of `matchGeometry`, the unchanged
   `statsOfMatch`; kept in `_mstatsStack[Run]`), and the worker matches the rows before `composite_tile`
   (`match_pixels`, ABI 10, `crates/px/src/cmatch.rs`, bit for bit with its twin). 15k with a 5,000 × 3,500 matched
   layer: PNG 6.4 s to 1.8 s (block 1.45 s to 84 ms), PSD 1.8 to 1.0 s, wand 2.5 to 0.9 s. Against the whole
   flatten's statistics on four of the user's photos: mean 0.1 to 2.0 levels, max 7 (the textured landscape); with
   the same statistics the two paths are within 2 levels. Turned away still (the whole flatten as before): a matched
   layer above a filter layer, `readBox` (a provider run's crop), JPEG and WebP, the flatten into the base of a plain
   matched stack; `InpaintEditor.stackMatch = false` is the A/B switch. A design review (three lenses, 12 confirmed
   objections) made the grid integers, stamped the statistics with the clones' version, took the layer's own samples
   over the picture's edge, and gave the job a byte-exact gate (`stack_points_gathers_the_samples_it_names`); the
   same section, "After the design review". A scaled or a fractional layer still saves the old way. Not done
   in part 2: the longest block (0.15 s against the plan's 0.05), an asynchronous read, a mask folded into the alpha
   (a filter at an opacity through a mask is a level off on 18 % of the bytes). Each item is measured
   against its row in `tools/native_test.py` before and after, bytes equal to the path it replaces. What N found on
   the way (the 2.5 s `dilate` of a provider crop, the wand at 30k, the `RangeError` at the cap) is in `docs/BUGS.md`.

11. **Split of `renderer/editor/inpaint_canvas.js`, agreed with the user on 2026-09-17** (over 12,000 lines, one class;
   only that file; **moves only: no behaviour change, no renaming, no tidying on the way**; stage 1 the loose functions at
   the top of the file into modules of their own, then decide with the user whether stage 2 pays: the class's methods
   by subject into files that are hung into the class). **Stage 1 is built** (2026-09-18, after the 0.1.19 state was
   pushed; the design came from a panel the user's second account had started and its usage limit cut short; that
   account's workflow journal and scratchpad were read, nothing re-run that had finished): the
   three groups the agreement names went into three modules, moved byte for byte by line ranges (an independent proof,
   `verify_moves.js` in that session's scratchpad: 40 top-level statements moved, 84 stayed, every one of the 1,176
   comments once). `inpaint_jobs.js` (the worker and pool plumbing: the shared worker and `workerCall`, the mips worker,
   the pool, the tile store's chain transport with its three import-time statements, `buildLayered`, `JOB_TIMINGS`;
   21 names, old lines 64, 160 to 310, 336 to 359), `inpaint_encode.js` (the PNG encoders and the two hash functions:
   `encodeCanvas`, `canvasToBlob`, `encodeTilePixels`, `encodeBands`, `encodeRows`, `partsUsable` and the parts state;
   14 names, old lines 312 to 334, 361 to 369, 407 to 413, 417 to 480) and `inpaint_upload.js` (`SUBFOLDER`,
   `LARGE_UPLOAD`, `uploadBlob`, `uploadCanvas`, `uploadPixels`; old lines 54, 371 to 405, 555 to 565). **The one
   glue:** `nextPartsSeq()` in `inpaint_encode.js`, because the class incremented `partsSeq` at two sites and an
   imported binding is read-only (those two class lines are the only statement whose text changed). `inpaint_jobs.js`
   and `inpaint_encode.js` import `InpaintEditor` back from `inpaint_canvas.js` for the switches on the class
   (`mipsOnPool`, `mipsOnSharedWorker`, `pngParts`), read inside functions only: no module of the cycle touches another
   one's binding while it is evaluated (a scope walk, `toplevel.js`), all four entry orders give the same answers in
   Node (a Chromium page that imports each new module first was not run; ComfyUI imports every file of the node in its
   own order), and `setChainTransport(mipsTransport)` now runs when `inpaint_jobs.js` evaluates (before the class when the
   app enters through `inpaint_canvas.js`, after it when a new module is the entry; nothing reads the scheduler while
   the class file evaluates, its only static initialiser is a number). `inpaint_canvas.js` exports its 22 names as
   before (`uploadBlob` and `uploadCanvas` re-exported as imported bindings; the node's `host.js` and `inpaint_node.js`
   keep working). `tools/build_node.py` FILES and the file table of `docs/BUILD_NODE.md` carry the three names (the
   table also got the six older modules it lacked); ESLint with no-undef / no-import-assign / no-const-assign /
   no-unused-vars over the four files: 0 errors and the original's 3 warnings (a later `++partsSeq` in the class would
   pass `node --check` and throw at run time; only that lint sees it, the config is in the session's scratchpad, not
   in the repo). The three switches no gate sets were checked by hand on a fresh tiles instance (`switch_check.py` in the
   session's scratchpad): the transport is `mipsTransport` with `flights` = `poolSize()` (8) and `arena` true;
   `mipsOnPool = false` and `mipsOnSharedWorker = true` each settle a whole change with `chainScheduler().failure`
   null and `arena` false / back to true; `pngParts = false` makes `parts.usable()` false and an upload of a layer
   still lands in the mirror (the canvas way), true again afterwards. **Gates:** tiles, `--offline`, `split1-tiles` (pixels editor composite commands shape brush film glb ailabel size transparent generate log
   mcp nodecopy toapis llm export pxjobs): all PASS but `editor`, whose four full runs on the split tree failed at four
   different timing-bound steps (the live stroke with its pointer message while the browser pane was in use;
   `closed_tabs_are_collected` twice with the last two tabs alive, a step that passed 3 of 3 alone on both trees and in
   the unchanged tree's full run; `helper_inputs_read_levels_and_upload_nothing` with one upload counted), every step
   of the gate green on the split tree at least once (steps 60 to 65 in a run of their own); **the fifth run,
   `split1-tiles-editor5`, PASS in full** (65 steps, 120 s). Canvas backend, `--offline --tiles off`, `split1-canvas`
   (the same list without pxjobs, which needs tiles): ALL PASS (19 gates, the editor gate in full at the first try). The checkpoint commit before this one
   (`1d5ce8e`) was made on the user's word while the gates ran; its message says a Chromium page check was run, which
   it was not (only the Node runs; this paragraph is right). **Open for the user, the scope:** the design panel (three
   partitions, three judges, four hazard hunts with two refuters per finding; all three partitions mechanically
   equal: same glue, same cycle, all checks green) read the agreement's parenthesis as the whole list (this build,
   "narrow"). The judges' 2:1 favourite is "whole-head": every loose function of the head, into six more leaf modules
   with no new cycle, each rejectable on its own: `inpaint_dom.js` (makeCanvas, el, numberInput, selectInput, icon,
   iconButton, miniButton, STYLE, injectStyle), `inpaint_images.js` (viewUrl, loadImageEl, snapImage, needImage, the
   SVG helpers), `inpaint_stroke.js` (StrokeBuffer, STROKE_BAND), `inpaint_geometry.js` (clampRect, tileDiffBox,
   homography, drawMesh, autoSelectionParams, ensureMinSpan), `inpaint_backends.js` (the segment / upsample / cutout /
   object backend tables and their functions), `inpaint_hosts.js` (editorTileMode, hostText, isSettingOutput,
   settingIndex, linkOf); with it `inpaint_encode.js` would also take canvasRows, hugePngSize, pngIsPlainSrgb,
   pixelsFromPngStream, CRC_TABLE, crc32, asciiJson and pngWithText, and `inpaint_upload.js` UploadCache. The third
   reading ("stage2-ready": the constants out too, into an `inpaint_common.js`) pre-empts the stage 2 decision and was
   scored lowest. Whether the six leaf modules follow, and whether stage 2 comes at all, is the user's call. Kept as
   it was, no tidying: the section title in `inpaint_jobs.js` still reads "PNG encoding, upload hashes and the layered
   export writers" and names `js/inpaint_worker.js`; the class file's header comment (lines 1 to 13) is untouched.
   **The class, measured (2026-09-18, `classmap.js` in that session's scratchpad, espree over the class body):** 11,385
   lines (1194 to 12578), 413 methods with 9,879 lines in them, 264 methods of 20 lines or fewer, 118 of 21 to 50, 21
   of 51 to 100, 10 above 100; 269 `this.*` fields assigned; 33 section banners. So it is not tangled logic but a
   god class: the coupling is the 269 fields every method reaches through `this`, and files hung into the class would
   share them just the same (navigation, not decoupling). The three real blocks: `buildModal` (686 lines, the whole
   UI), `drawSceneOverlays` (246), `onPointerDown` / `onPointerMove` / `onPointerUp` (206 / 139 / 115, the dispatch by
   tool). **Decided by the user on 2026-09-18: the next split step is `buildModal` alone**, into a module of its own
   with one build function per panel (toolbar, layers, settings, filters), pure construction and no state, the
   editor / composite / commands gates checking the surface; about half a day, 6 % of the class and its least
   readable place. Not the whole class, not the pointer handlers (the heart of the live-stroke gates; by tool only when
   a tool is reworked), not the 269 fields into state objects (weeks, and behaviour can move quietly). It comes in a
   session of its own after `smoke` and the node test, under the same rule as stage 1: moves, the byte-for-byte proof,
   both backends, `nodecopy`. **BUILT on 2026-09-20** (see the top of this section): `renderer/editor/inpaint_modal.js`,
   654 of 654 lines proven identical, one line translated (`pane = this.panes.gen` -> `toGenPane()`), a gate step of
   its own for it, both backends ALL PASS. **Not the plan's word in one respect:** "pure construction and no state"
   cannot hold - the method writes 101 fields onto the editor, so every function takes `ed` and writes onto it, as the
   method wrote onto `this`. That is navigation, not decoupling, which is what the class measurement said it would be.

12. **OpenRouter as a provider: BUILT on 2026-09-19 (see the top of this section; the plan below is what was asked,
   not what was built: the image route is `/api/v1/images`, and no `HTTP-Referer` / `X-Title` goes out).** OpenRouter
   (`https://openrouter.ai/api/v1`) is an OpenAI-compatible aggregator with one key for most hosted models. Two uses in
   Scumble, both to be written from the docs and verified only with a real key, like every other adapter:
   (a) **prompt upsampling**: a backend beside the API ones and `settings.llm.compat`, the chat completions endpoint
   with a Bearer key from the credential store (`keys.js`), the model chosen by its id (`openai/...`, `google/...`,
   `anthropic/...`), the optional `HTTP-Referer` / `X-Title` headers; (b) **image edit and "Generate new"**: an adapter
   in `electron/main/providers/` next to the OpenAI and Gemini ones, through chat completions with
   `modalities: ["image", "text"]`, the input picture as an `image_url` data URL, the answer read from
   `message.images[0].image_url.url` (a data URL); one variant per image-capable model id with its `limits`, no mask
   parameter on that API (Scumble's own composite mask and stitch apply, as for Gemini). Settings › API keys gets an
   OpenRouter row, recipes an `openrouter` provider variant, `docs/RECIPES.md` the format, and a plain-Node test of
   the request shape (as `transparent_test.py` does for OpenAI) plus the loopback stand-in in the gates. **To verify
   against the live API before anything ships:** which image models OpenRouter serves at the time (Gemini image,
   gpt-image, Flux), whether an input picture reaches them as an edit, the size and count limits, and the shape of an
   image answer; the docs may have moved since this was written.
12b. **BytePlus ModelArk as a direct Seedream provider: BUILT on 2026-09-19 (see the top of this section; the plan
   below is what was asked, the research paragraph after it corrects it).** Seedream runs today through fal, ToAPIs, WaveSpeed and the ComfyUI API node
   (`ByteDanceSeedreamNodeV3`); ModelArk is ByteDance's own API for it. What was found on 2026-09-19 (the docs,
   `https://docs.byteplus.com/en/docs/ModelArk/1541523`, are rendered by script and could not be read field by field):
   `POST https://ark.ap-southeast.bytepluses.com/api/v3/images/generations` (Singapore; also `ark.eu-west.bytepluses.com`),
   an API key from the ModelArk console, model ids such as `seedream-5-0-pro`, `seedream-5-0-lite`, `seedream-4-5`,
   `seedream-4-0`, a request of `model`, `prompt` (at most 300 tokens) and optional `image` (a URL or base64, one or
   several: single- and multi-image edit and fusion). An adapter in `electron/main/providers/` next to `toapis.js`,
   a key row in Settings › API keys (credential store), an `ark` provider variant in the recipes with its `limits`
   (Seedream's 3:1 `ratio` as on ToAPIs), no mask (Scumble's own composite mask and stitch, as for Gemini), "Generate new"
   through the same endpoint without an image, `docs/RECIPES.md` and a plain-Node test of the request shape plus the
   loopback stand-in. **To verify with a real key before anything ships:** the exact field names (`size` format and
   limits, `seed`, `response_format` `url` / `b64_json`, `watermark`, multi-image fields), the answer's shape, whether an
   input picture is edited or only referenced, the size and count limits, and which region the user's key serves (the
   privacy note: ByteDance, Singapore or the EU endpoint).
   **Researched on 2026-09-19 (the field-level docs are in the served HTML, `window._ROUTER_DATA...MDContent`; the
   session scratchpad's `rep_modelark.md` and `ark/` hold them), correcting the lines above:** the AP region is
   **Johor, Malaysia** (`ark.ap-southeast.bytepluses.com/api/v3`), the EU one Dublin (`ark.eu-west...`), keys are bound
   to a region and requests "may be routed" across regions; model ids carry a date: `dola-seedream-5-0-pro-260628`,
   `seedream-5-0-260128` (also `seedream-5-0-lite-260128`), `seedream-4-5-251128`, `seedream-4-0-250828`, and a model
   must be activated first (404 `ModelNotOpen`; some accounts need an endpoint id); the prompt's 300 is a recommendation;
   `image` is a URL or a `data:image/<fmt>;base64,` string or an array (pro 10, the others 14; each [1/16, 16], at most
   30 MB and 36 MP), **`watermark` defaults to true (send `false`)**, `response_format` `url` (24 h) or `b64_json`,
   `size` a tier (pro 1K / 1.5K / 2K, lite 2K / 3K / 4K) or `WxH` by area (pro 921,600 to 4,624,220 px, lite 3,686,400 to
   16,777,216), ratio [1/16, 16] (not ToAPIs' 3:1), `output_format` png only on 5.0 pro / lite, no mask, no `n`, `seed`
   not in the reference (the SDK sends it); errors `{ error: { code, message, param, type } }`; prices per image (pro
   $0.045 up to 2.61 MP, $0.09 above; lite $0.035); data centres in Malaysia, Indonesia and the EU, no training without
   authorisation, filtered content kept 180 days.
13. **The assistant, a chat agent that drives Scumble over MCP (asked for by the user on 2026-09-18, planned that day
   and revised on 2026-09-19 after the user's answers; not built: about twenty-three and a half working days for its
   one release, twenty-four and a half with the two optional steps).** The plan is `docs/PLAN_ASSISTANT.md`; every
   point of its §8 is decided (2026-09-19). It comes last in the order below but before SignPath (the user,
   2026-09-19: "assistant kommt vor codesignierung"), and ships as a release of its own. The MCP server stays primarily for external agents: the assistant changes no command, parameter,
   annotation or `INSTRUCTIONS` line (splitting `createServer` out of `serve()` is internal, its tool list proven
   byte-equal), and the four defects its planning found (`remove_layer` on a locked layer, `flip_layer`'s axis, the
   `llm:models` compat key, the annotations) are filed in `docs/BUGS.md`, not fixed by it. A collapsible chat column
   right of `#editor-host` (`<dialog id="assistant">` shown with `show()`, open state remembered; shell only); the
   loop in main (`electron/main/assistant/`) with raw `fetch`, every call streamed, four adapters: Anthropic Messages,
   OpenAI Responses (`store:false`), Gemini `generateContent`, and Chat Completions for OpenRouter (item 12's key
   row), DeepSeek, Moonshot (Kimi) and Z.ai (GLM) (three new key rows), ToAPIs, WaveSpeed and the local compat
   endpoint. A picker grouped by provider, only ready providers selectable (a stored key; for the local server, which
   needs none, a saved URL), curated vision models (Claude Sonnet 5, the default, and Opus 5; GPT-5.6 Terra, Sol and
   Luna; Gemini 3.8 Flash, 3.1 Pro preview and 3.5 Flash-Lite; DeepSeek V4.1 Flash; Kimi K3 and K2.6; GLM-5.3-Flash
   and FlashX) plus a free OpenRouter id checked against its live list; a privacy notice per provider saying where the
   pictures go as far as its own terms say (the US, Singapore or the PRC, "any region" for Anthropic's inference and
   for Google, "not stated" for OpenAI's default region, Z.ai's GLM-5.3-Flash cluster and, until their terms are read,
   ToAPIs and WaveSpeed). Through OpenRouter the pictures go on to a host it picks: Scumble sends
   `data_collection: "deny"` (hosts that train are excluded, hosts that keep the data are not) and `provider.ignore`
   with every host OpenRouter lists in China, because on 2026-09-19 StreamLake, Baidu and Alibaba served the curated
   GLM, Kimi and DeepSeek models. It reaches the editor only through an in-process MCP `Client` over
   `InMemoryTransport` and sees the 72 tools minus an exclusion set of six (`list_commands`, `run_action`,
   `set_status` and the three `ailabel_*`), so 66, and 65 for a model without vision; its requests carry `meta` and
   wait up to 20 s for the user's stroke, transform, text edit or question. The policy, decided by the planner for the
   user: everything that can cost money or queue on ComfyUI asks (`generate`, `generate_new`, `select_by_text`,
   `cutout_layer`, `upsample_prompt`), and so do the calls that clear undo, `flatten`, `extend_canvas`, unlocking a
   layer or moving or retexting a locked one, `undo` / `redo`, file reads, exports with a path and global settings;
   removing, merging and the edits the commands record no undo step for run without asking only on the chat's own
   layers; exports without a path or with a wrong extension are refused. Its leading use is the user's own: inpaint
   regions, each on its own result layer, and colour-match them (`generate` asks, `set_layer` `match` on the chat's
   own result runs). Chats are saved under `<userData>/assistant/` (20 kept), and Settings › Assistant has a reset
   that deletes all assistant data, its lines in the app log included, but the keys. Undo: every step on the normal
   stack, on both backends; where a command records none (an added layer, `generate`'s result included, `set_layer`'s
   colour match and other non-geometry fields, `set_filter`'s params, `set_text`) the shell pushes the editor's own
   step kind before the assistant's call (`meta.undo`; no command and no editor change); plus "Undo this turn" on
   tiles (a turn snapshot in `inpaint_canvas.js`, hence `build_node.py --check` and `nodecopy`; refused on the canvas
   backend). Steps (PLAN_ASSISTANT's A0 to A9): A0 the server split; A1 the loop, the policy, the registry and
   Anthropic in plain Node; A2 Chat Completions with its seven providers; A3 OpenAI Responses and Gemini; A4 in the
   app with the key rows and the first gate; a checkpoint with the user's keys on several models across providers,
   before any UI (a ceiling of about $10, set by the user); A5 the panel; A6 chats on disk and the reset; A7 per-step
   undo and turn undo; A8 the whole `assistant` gate (76 steps, twenty-one mutations, `tools/assistant_mock.py` for
   all four families) and the docs; A9 a live check on the packaged app and the release. Optional, only on the user's
   word: A10 a budget, "allow for this chat" and a basic tool set; A11 the assistant's own undo steps. **To verify
   against the live APIs before it ships** (§7): per family the reasoning replay (signatures, encrypted items, thought
   signatures, `reasoning_content` on every assistant message), a JPEG in a tool result where the family takes one
   (Moonshot's `tool` message included: its schema allows one, its only example is a video) and in a follow-up user
   message elsewhere, pruning, the streamed rebuild, cache reads, the tool list's real token count and the error
   shapes; Gemini's request limit (its docs say 20 MB and 100 MB; the cap is 18 MB until then); that OpenRouter still
   routes each model with `data_collection: "deny"` and the hosts in China ignored, and whether it does with
   `zdr: true` (then the user decides); that ToAPIs and WaveSpeed pass tools at all, and where they are and what they
   keep. No OpenRouter attribution headers go out before the trademark check (they make a public app page).
14. **Upscaling, a future feature (asked for by the user on 2026-09-21; parked: only on the to-do list, not planned
   in detail, not built, nothing below verified).** Upscale the document, a layer or the selection by a model, in
   three routes the user named: (a) **through the user's ComfyUI**, as a recipe with `UpscaleModelLoader` +
   `ImageUpscaleWithModel` (`comfy.js` already lists `UpscaleModelLoader` models for the recipe settings), the models
   the user already has in `models/upscale_models`; (b) **in the app**, on the ONNX Runtime the helpers already use,
   with upscale models downloaded or read from the linked ComfyUI `models/` folder (only ONNX files load there; the
   usual `.pth` / `.safetensors` upscalers need an ONNX export, as the helper scan of 2026-09-12 found for SAM2 /
   RMBG), tiled for large pictures; (c) **API upscaling**, e.g. Topaz Labs and Magnific, as provider adapters with
   key rows like the other providers. **Asked, to be checked before planning:** whether a **locally installed
   Topaz** (Gigapixel / Photo AI) can be driven from Scumble, e.g. through a command-line interface of the desktop
   app (which products and licences offer one, what it takes and returns), and whether it can go **over MCP**:
   either an external agent chains Scumble's own tools (`export` -> Topaz -> `load_image` / `add_image_layer`), or
   Scumble calls a Topaz-side MCP server or CLI itself. Also to decide: where the result lands (the whole document
   resized, which clears undo like *Resize*, or a new layer), the size limits (a 4x of a 15k picture is past the
   65,535 px side and the gigapixel cap), and whether the assistant's policy asks before an upscale (it costs money
   on an API and queues on ComfyUI, so yes by the existing rule).
15. **Qwen Image Edit 2.1, a model to support (asked for by the user on 2026-09-21). The local ComfyUI recipe is
   BUILT and shipped in 0.1.23 (`recipes/qwen_image_edit_2_1_local.json`, not run yet); the API side below is open.** Today `recipes/qwen_image_edit.json` runs older Qwen edit endpoints (fal
   `fal-ai/qwen-image-edit/inpaint` with a mask, Replicate `qwen/qwen-image-edit`, WaveSpeed
   `wavespeed-ai/qwen-image/edit-plus`) and, on ToAPIs and Comfy Cloud, Qwen Image 3.0; there is no local Qwen recipe.
   **To find out before building:** which providers serve 2.1 and under which ids (fal, Replicate, WaveSpeed,
   OpenRouter, ToAPIs, ModelArk is ByteDance only), whether any of them takes a mask, its size limits and input count
   (the `limits` block needs a source, not the 2048 default), its price; whether it is a new variant in
   `qwen_image_edit.json` or a recipe of its own; and whether open weights exist for a **local ComfyUI recipe**
   (which nodes, text encoder and VAE). Each new variant gets its row in the `recipes` gate.
16. **Oxen.ai as an API provider (asked for by the user on 2026-09-21, https://www.oxen.ai/ai/models; on the list only,
   not built, not run against the live API).** An aggregator of "200+ models through one API", like fal or OpenRouter.
   What its docs said on 2026-09-21 (`https://docs.oxen.ai/llms.txt`; the models page itself sits behind a Vercel
   browser check and could not be read by script): base `https://hub.oxen.ai/api/ai`, a Bearer key; **image edit**
   `POST /images/edit` with `model` (e.g. `qwen-image-edit`, `nano-banana-2-edit`, `gpt-image-2-edit`,
   `xai-grok-imagine-image-edit`), `prompt`, `input_image` (a URL or, for some models, an array of URLs) and
   `response_format` `url` / `b64_json`, answered in the same request (`images[0].url`); **image generation** for
   "Generate new" at `/images/generate`; an **async queue** for long jobs; `GET /models` and `/models/search` list the
   models; per-model parameters on a "model references" page; **chat completions** OpenAI-compatible at the same base
   (streaming, vision, tool calling), so it can also be a row of the LLM / assistant registry (`providers.js`,
   `llm_custom.js`) for prompt upsampling and the assistant. **To find out before building:** whether `input_image`
   takes a data URL or needs a hosted file (then an upload step and a privacy note like ToAPIs'), whether any edit
   model takes a mask, the per-model size limits and input counts (the `limits` block needs a source), prices and
   balance endpoint, where the data goes and what is kept, and which of the recipes' models it serves (an `oxen`
   variant in each, last, no default changed, like OpenRouter). Pieces as for every provider: an adapter in
   `electron/main/providers/`, a key row, `docs/RECIPES.md`, a plain-Node test of the request shape, a loopback mock
   and a gate.
17. **A side panel of adjustable width (asked for by the user on 2026-09-21, with a screenshot). The horizontal
   scrollbar is gone since 0.1.23 (panel 320 px, rows that fit); the drag handle below is still open.** The panel right of the canvas (Image / Generate tabs, the layer list) is a fixed `.ipc-side { width:290px }`
   in the editor's `STYLE` (`renderer/editor/inpaint_canvas.js`), and an expanded layer row (Opacity, Match with its
   *surroundings* select, Blend, Role, the cutout row) is wider than that, so the layer list and the reference list
   get a horizontal scrollbar. The wish: drag the panel's left edge to make it wider or narrower. Assessed as small
   (about half a day with a gate step): a drag handle on the left edge that sets the width (a CSS variable, clamped,
   e.g. 240 px to half the window), the width kept per install (the app's settings; the node could keep it in
   `localStorage`), and `resizeCanvas()` called while dragging, which already refits the view when its size changes;
   editor code, so `build_node.py --check` and `nodecopy`, and a step in `editor_test.py` (drag, width kept after a
   reload, view refitted, no horizontal scrollbar at the default width). **Independent of it and smaller:** the
   expanded row could wrap or shrink its controls so no horizontal scrollbar appears at 290 px at all.
18. **A logo for Scumble: DRAWN on 2026-09-22 (for 0.1.27), the mascot is open.** `build/icon.svg` is the source
   (plus `icon-small.svg` for 16 / 24 px, `icon-tile.svg` for macOS, `icon-plain.svg` without a background),
   `build/icon.png` is 1024 px and `build/icon.ico` holds 16 to 256 with **the small sizes drawn separately**
   (PNG entries, written by hand because PIL resamples one picture for every size). It is a creature made of
   sienna paint (`#C4643A`) over a chalk stroke (`#EFE7DA`) on near-black brown (`#1B1714`), the stroke showing
   through its body as `#D08967`: the name's meaning as a figure. The colours came from a survey of the field
   (Photoshop owns `#001E36` / `#31A8FF`, Affinity purple, Krita magenta / cyan), the legibility from measuring
   every candidate at 16, 24, 32 and 48 px: an S mark read best at 16 but the user chose the creature
   ("Der Klecks ueberall"), which holds to 24 px and below that is a coloured blob with a light band. The old icon
   is kept as `build/icon-0.1.26.png`. **Open:** the mascot's other poses (a six-expression sheet exists as
   generated drafts only), the website and the About dialog. The original wording of this item:
   there was no vector source and no 1024 px master. A logo means: a mark that reads at 16 px (taskbar, tab, tray) and at 1024 px (macOS icns,
   the website), a vector source (SVG) committed under `build/`, the exports electron-builder needs (`icon.png` at
   1024, `icon.ico` with 16 to 256, later `icon.icns`), the About dialog, the README and the website
   (`F:\portfolio_web`, the Scumble pages). The name's idea (a thin semi-opaque layer over a dry one) is the obvious
   starting point. Who designs it, and whether a draft comes from here first, is the user's call. **B3 waits for
   it** (the macOS icon needs the 1024 px master).
19. **3D layers from AI models (asked for by the user on 2026-09-23; on the list only, not planned, not built).**
   Scumble already has 3D layers: the `glb` plugin (`plugins/glb/`, `glb.place` / `glb.edit` / `glb.info`,
   `docs/COMMANDS.md`) renders a `.glb` / `.gltf` into a layer by position, distance, rotation and scale and keeps it
   editable. The idea: make the model itself with an image-to-3D (or text-to-3D) model, from a selection or a layer
   (a cut-out object) or a prompt, and place the answer as a glb layer, so an object can be turned, relit and put back
   into the picture; the inpainting models then blend it in. Routes to check: the **Comfy Router** serves Meshy
   (`meshy/meshy-5` .. `meshy-7.1`, `remesh`, `rigging`, `animations`) and Tencent Hunyuan 3D (`hunyuan-3d-part`,
   `-smart-topology`, `-texture-edit`, `-uv`; no plain image-to-3D there on 2026-09-23), all on the same Comfy key
   (`comfyrouter.js`, one more dialect); fal and Replicate host TRELLIS / Hunyuan3D / Tripo-style image-to-3D; a local
   ComfyUI recipe (Hunyuan3D 2.x nodes) is a third way. **To find out before planning:** which models take one image
   and answer a textured GLB (not only a mesh), the answer's size and format (GLB or a zip of OBJ + textures), the time
   (minutes: the queue and its 30-minute wait fit), the price, and whether the glb plugin's renderer shows the
   answer's PBR materials well enough that the result is worth inpainting over.
20. **Skins: a docking point for custom app looks (asked for by the user on 2026-09-25; BEING BUILT from 2026-09-26,
   `docs/PLAN_0_1_29.md` §1; the example skins are named "90s" and "Duck" by the user).** Developers drop a skin into a folder and the app wears it. **The user's
   answers:** the app only (not the ComfyUI node, so `build_node.py` / `nodecopy` stay out of it except where the
   editor's shared `STYLE` is touched), and ship example skins from the start - a **Winamp-like** look and a look after
   Pollen Robotics' / Hugging Face's **Microduck** robot (palette from https://pollen-robotics.com/microduck/press-kit/).
   **What the code has today (2026-09-25):** not one CSS custom property. 89 distinct colours are hard-coded in four
   places: `renderer/shell.css` (151 colour values), `assistant.css` (67), `help.css` (46) and the editor's `STYLE`
   string in `renderer/editor/inpaint_canvas.js` (lines 929 to 1128); on top, 68 `fillStyle` / `strokeStyle` colours
   drawn on canvas (the selection blue `#7cc7ff`, rulers, labels), 22 inline styles set from JS in the editor and
   `inpaint_modal.js`, 4 in `shell.js`, and `backgroundColor: "#181818"` in `main.js`. The icons are SVG with
   `currentColor` and follow by themselves. The CSP (`renderer/index.html`) allows inline styles and keeps `url()` to
   `'self'` / `scumble://app`, so a skin cannot phone home. **The shape agreed in the brainstorm:** (1) **tokens
   first** - about 25 to 30 CSS variables (`--sc-bg`, `--sc-surface`, `--sc-fg`, `--sc-muted`, `--sc-accent`,
   `--sc-danger`, `--sc-selection`, `--sc-border`, `--sc-radius`, `--sc-font`, ...) replacing the 89 colours, the
   default theme pixel-identical to today (a screenshot gate on both backends), canvas overlays reading the tokens
   through `getComputedStyle` once per theme change; worth it on its own (a light mode, contrast, Store screenshots).
   (2) **a skin is a plugin without JS**: a folder with `plugin.json` (`"registers": ["skin"]`), a `skin.css` and its
   own images and fonts, picked in a *Settings > Appearance* section and switched live through the existing *Reload
   plugins* path. The tokens are the stable contract (a `docs/SKINS.md`, versioned, a gate that every token exists);
   **free CSS on top is allowed** (a Winamp look needs gradients, bevels, an LCD panel, a pixel font, bitmaps - tokens
   alone cannot do it) and marked unstable, like app modules for user plugins. No JS in a skin. **Protected from
   skins:** the assistant's ask cards (a skin must not hide a question before a paid run), the masked API keys, and
   the selection outline's contrast on white (`editor_test.py` has that case). (3) optional later: a theme editor in
   the Settings (a colour picker per token, export as a skin folder), light / dark after the OS (`nativeTheme`), a
   compact density, icon sets. **Open, the user's call:** the names of the two example skins - "Winamp" and
   "Microduck" are other people's marks and a shipped skin under that name reads as an endorsement, so the brainstorm
   suggested the look without logos or original artwork under own names (e.g. "Amp '98", "Duckling"), the same rule
   as the film names (real names only in the film presets); for Microduck, asking Pollen Robotics / Hugging Face
   whether an official skin is fine is an option. **Rough effort (not measured):** 4 to 5 days - tokens 1.5 to 2, the
   docking point with assets about 1.5, the two example skins about 1; the theme editor extra. **Order:** after B3
   (macOS), not before.
21. **Lens flares, "something like Flarecore" (asked for by the user on 2026-09-25; brainstormed only, OPTIONAL, not
   planned in detail, not built).** https://github.com/cyco-creates/Flarecore is a ComfyUI node pack (Apache-2.0,
   PyTorch in linear light, one author, 0.2.0 beta 1 at `5e8f2bb` of 2026-09-18). **The user's reason:** rarely used
   ("eher nicht so oft"), it is feature completeness for a pro tool. **What a 10-agent brainstorm found (read through
   the GitHub API, nothing cloned or run):** the engine is a sum of analytic per-pixel fields along the axis from the
   light P to a movable anchor E (`P + t(E-P)`; `flare/elements.py` 146-525: glow (Moffat), iris (n-gon by angular
   folding, roundness, hollow, coma, crescent), streak, ring, hoop, glint rays, orbs, spectral, texture); no FFT, no
   model. 72 presets (not the README's 74), 732 elements: glow 271, iris 211, streak 74, glint 74 (86 % together),
   texture 49 (using only 10 of the 197 PNGs). The 197 PNGs (78.1 MB) are AI-generated (3 carry OpenAI C2PA, against
   the repo's own "nothing from third-party tools"); 30 presets carry lens brand names (ARRI, Cooke, Zeiss, Panavision
   ...), partly fitted to screenshots from the login-gated Cineflares; `schema_version` stayed 1 through 15 schema
   commits. Most of it is video (tracking, image visibility across frames, flicker) or experimental (Lens Lab).
   **Rejected:** a port that reads Flarecore's preset format (a moving, unversioned target, brand names) and a bridge
   that runs FlareRender on the user's ComfyUI (not installed there, not on the Comfy Registry, no live preview - every
   slider change a queue run on the production machine; its `flare_pass` is sRGB and clamped, so Screen over it is
   about 16 levels brighter in the midtones than its linear add). **The shape, a compact version, about 7 to 9 days:**
   a built-in plugin `plugins/flare/`, one filter type `flare.lens` with `reach: 0` like `film.light_leak` (normal
   blend; the shader decodes to linear, adds the flare accumulated in float, encodes again, a +-0.5 LSB dither hashed on
   the picture pixel - `BLEND_MODES` has no add and needs none then); five element kinds translated from Flarecore
   (glow, iris / ghost, streak, glint, ring) with the Apache-2.0 header per translated file, a NOTICE and a credit in
   About; a tool with two handles (light, anchor) after `film/points.js`, the light's colour sampled on the click;
   8 to 10 own presets with neutral names (a Node check that fails on a brand name; the preset select gets its own
   `title`, or the film-stock tooltip shows); occlusion through the filter layer's existing mask; **coordinates
   relative to the picture** (`resizeImageNow` does not move filter params); the assistant and MCP through `add_filter`
   / `set_filter` (both AUTO in `policy.js`), no new commands; the renderer validates and clamps every value, because
   `applyParams` (`commands.js` 974-989) assigns a `custom` value raw and sets a preset select's id only. Gates on both
   backends: GPU vs CPU within 2 levels, bands equal to the whole flatten, drag and undo, an
   `exportperf:15000x10000,--filter=flare.lens` row. The open-ended part is the look tuning: a build on the user's own
   pictures after about 4 days, before the rest. **Only on the user's word, later:** several lights per layer, detect
   the light, occlusion from a SAM2 selection or depth (Depth Anything V2 Small ONNX, Apache-2.0, 50 MB fp16; the
   user's ComfyUI holds only the Large model, CC-BY-NC), a Flarecore JSON importer pinned at `5e8f2bb`, textures (after
   a core fix: plugin samplers are re-uploaded every pass and units 6 / 7 collide with the framework's), "bake to
   layer" for PSD (layered exports skip filter layers). **Known traps:** a generate after the flare bakes it into the
   result (results go on top; film layers have the same problem); a plugin never reaches the ComfyUI node. **Order:**
   optional, no place in the order until the user names one.
22. **Nik 9 parity: depth masks and the rest of DxO Nik Collection 9's feature set (asked for by the user on
   2026-09-25; brainstormed, not planned into sessions, not built; an update of its own, NOT optional).** The whole
   research and shape is **`docs/PLAN_NIK9.md`**; read it before planning, do not research it again. **The user's
   answers:** it is for editing the finished picture after inpainting (adjustments by distance: grading, haze,
   halation), the edges are to be done properly ("besser richtig umsetzen"), and the scope is all of Nik 9 that
   Scumble lacks ("wenn dann alles"). **The shape, four releases:** (1) masks - an in-app Depth Anything V2 Small
   helper (Apache-2.0; the onnx-community repo is deprecated and its successor uses external data, so pin commit
   `4472b73...` or teach the registry a data file), the depth map a **document** resource (working map up to 4096 px,
   guided in a pool worker, u16 PNG mirror ref), *Select by depth* and *Limit by depth* live on filter layers (a
   post-stage in `applyFilter`), luminosity and colour-range sources on the same range bar, an Intersect selection
   mode, the Object tool's box drag, a layer-mask overlay; (2) edges (a tiled detail pass, a guided snap of the mask
   at full resolution in the depth-edge band, SAM2 / BiRefNet snap, a refine brush) and depth filters (haze, dehaze;
   lens blur on the user's word); (3) filters and control points (HSL 8 channels, chromatic shift, the grading wheel,
   glass, elliptical / polygonal / line points, diffusion); (4) the 18 missing blend modes (core: GL, Rust kernel and
   ABI, Canvas 2D, PSD / ORA, the node). **About 34 to 46 working days in all, inferred.** A checkpoint on the user's
   pictures once the model runs decides how much edge work release 2 needs. **Order:** not fixed yet; suggested
   after B3 (macOS). **Folded in on 2026-09-26 (the user: "kommt später, zusammen mit Nik"):** the masks-and-selections
   package - refine edge for any selection (hair, fur, colour decontamination, output to a mask), a soft selection
   from a layer's alpha (`selectionFromLayer` cuts at 127 today, `inpaint_canvas.js` ~6196) with add / subtract /
   intersect, a Bezier selection and stored paths, commands for saved selections, a black-and-white mask view - and
   the grading-and-panels package - a dither at the filter chain's final 8-bit write, a histogram / info panel, a
   navigator, own presets for filter layers with .cube export, colour match on luminance only or against a chosen
   reference region, vibrance, selective colour, a channel mixer, a gradient map, surface blur and median. Estimates
   from the review: 6.5-12.5 and 11-19.5 days.
23. **Rotate and straighten the whole document (on the later list, the user, 2026-09-26).** Rotate 90 / 180, flip the
   document, straighten by a drawn line, crop presets with overlays. Estimate 2 to 3.5 days (crop presets 1 to 2
   more). Every layer, mask, selection and saved selection has to follow, like *Resize*.

**Decision (b) of 7c is made (the user, 2026-09-18): exports and runs of a colour-matched layer may move.** They may
take their statistics from tiles instead of from the whole flatten, with **point samples** (measured mean 0.56, max 8
to 9 levels against the full-resolution statistics; not box means, which were 5.45 / p99 12 on a textured photo;
`docs/PLAN_BCE.md` §C6 "C6 (c) slice 7c as built"). **B item 7 part 3 is built on it** (2026-09-18, item 10 above;
CHANGELOG 0.1.19 says a matched layer's export can move by a few levels). **Stage 1 of the split of
`inpaint_canvas.js` is built** (item 11, 2026-09-18) and **0.1.19 is published**. **Decided by the user on 2026-09-18,
on that session's recommendation:** (1) **no stage 2 for now, and no six leaf modules**: hanging methods into the class
is an eager access to it (it would have to stand in `inpaint_canvas.js` below the `class` statement for ComfyUI's
import order), and twelve sites in four subjects read switches on the class name, so a subject is split out only when
that subject is reworked anyway, as the prelude of that work; (2) **the object tool's change A is parked**: if the coarse
outlines at 15k turn out to matter, compute the image-size label map only in the hovered object's box, on demand,
never for the whole picture; (3) **B item 6 stays on ice** (it saves memory, not time; 97 GB of RAM and the 15.5 GB cap
are not the limit at 15k). **Next, in this order** (the user, 2026-09-20, on this session's plan: the two defects,
then `buildModal`, "und den assistent"): ~~the two defects of the OpenRouter session~~ and ~~the `buildModal` split~~
(both 2026-09-20, see the top of this section); ~~the assistant~~ (item 13, A0 to A9, shipped in 0.1.21 the same
day, the release of its own the user asked for: "agent als letztes, wird ein seperates release"); then, on the
user's word of the same evening, ~~the user's own language models in the Settings and the end of the "not tried"
marks~~ (0.1.22, unreleased, see the top of this section); then, on the user's word of 2026-09-22, **the six sessions of `docs/PLAN_0_1_24.md`** (upscaling, Oxen.ai, the
three builds); then the **Microsoft Store package** (MSIX, the interim signed channel, decided
2026-09-23 - see the release-channel decision above and `docs/CODE_SIGNING_POLICY.md`) and **SignPath**
after it ("assistant kommt vor codesignierung"). Waiting on the user's ComfyUI, whenever it is free: one
local run on a large document with the node's stitch fix (`fba1fd8`), and the node in a real ComfyUI tab and in
Firefox when a node version is meant to ship. Nothing else stands before them, unless the user names something else
first.

**Housekeeping done on 2026-09-16.** The merged branches `c0-editor-source`, `c2-tiles`, `fix-mask-undo` and `px-spike`
are deleted locally and on origin; the v0.1.11 draft release and its tag are deleted; `dist/` is cleaned (old installers,
gate profiles, `dist/ab`, `composite`, `smoke`). `tools/run_gates.sh` recreates the profiles it needs.

**Still unverified or open:** the ToAPIs, OpenRouter and ModelArk adapters have never run against the live API (`docs/RECIPES.md` "Only a real key can verify", in each section); a real SAM2 / RMBG
model has not run in the app on the slice 6 code (the full `smoke` of 2026-09-19 ran the server's helpers only; a profile
with the models downloaded or the ComfyUI `models/` folder linked would run them); the user has not reported back on
their own 15k file.


## Where things stand (2026-09-16, evening: 0.1.15 published)

**Read this block first; the block below (7a) still says what the next session starts with: 7b.**

- **0.1.15** carries C6 (c) slices 3 to 7a (`CHANGELOG.md` 0.1.15). The commit that carries this block is tagged
  `v0.1.15`; **published** on the user's go (2026-09-16, Latest; `latest.yml` on the feed says 0.1.15). After the tag, `package.json` went to **0.1.16** with an empty section.
- Gates for the release: `npm run dist` -> `Scumble Setup 0.1.15.exe`; against `dist/win-unpacked/Scumble.exe`, own
  profiles: `rel15-exe` (pixels editor commands composite brush film glb toapis mcp, the default `{ tiles: true, from:
  "default" }`) all PASS but `commands`, and `rel15-exe-canvas` (`--tiles off`: pixels editor composite commands) ALL
  PASS. No Flux run, on the user's word.
- **The user needs their ComfyUI instance for now** (2026-09-16): no `smoke`, and no gate that forwards to it
  (`commands`' `large_upload_route` uploads through the mirror to a connected ComfyUI) until they say it is free.
- **New in `docs/BUGS.md`:** a headless MCP instance (this repo's `.mcp.json` starts the dev app with `--mcp`) held the
  default profile's single-instance lock and Scumble showed no window on start. Stopping the two `electron.exe ... --mcp`
  processes fixed it; cause of the missing hand-over not measured.
- **The `commands` failure was the test**: `screenshot_reads_levels` read `memoryReport().tiles.primedBytes` right after
  the call, and the built-in film panel's own settled flatten (500 ms after a change) holds primed cells on the same
  pixels for a moment - the same cause as the one-off "primed cells were left behind" in slice 6's step. The three steps
  (`screenshot_reads_levels`, `prompt_context_reads_levels_not_a_flatten`, `helper_inputs_read_levels_and_upload_nothing`)
  wait up to 3 s for the cells to drain now; a mutation that drops `job.release()` in `shotCanvas` stays red ("192512
  bytes of primed cells were left behind"). `rel15-exe2` (commands editor on the exe) ALL PASS.

## Where things stand (2026-09-16, evening: C6 (c) slice 7a is built and pushed)

**Read this block first; it supersedes the "What the next session starts with" of the block below.** `docs/PLAN_BCE.md`
§C6 "C6 (c) slice 7a as built" is the record; `CHANGELOG.md` 0.1.15 has its bullet (a user-visible fix).

- **7a, the null-statistics race** (`renderer/editor/inpaint_canvas.js`): every sampled pass (eyedropper, wand, bucket,
  plugin flattens, the film panel) now takes `sampledMatchStats(layer, forRun)`, one entry per layer per change from the
  layer's whole padded surroundings (a sampled pass of its own over the padded box, `upTo` the layer), instead of
  statistics from its own region. Reproduced red first on both backends: a 512 px picture after an eyedropper click was
  102 levels off on 95,172 bytes, the eyedropper picked the unmatched colour. The loop is `statsOfMatch` now; a chain
  landing no longer drops the sampled statistics. The screen (`_mstatsView`) and exports (`_mstats`) are unchanged.
- Gate `sampled_passes_share_the_colour_match_statistics`, three mutations red; all gates PASS on both backends;
  `perf_test.py` 15k within noise. `a_sampled_pass_matches_only_the_part_of_a_matched_layer_it_shows`'s screen bound is
  6 levels until 7c (it read 3-4).
- Seen once, not reproduced: slice 6's step failed "primed cells were left behind" (`s7a-red2`).

**What the next session starts with:**
1. **7b**, the matched region view (`dist/c6map/c/match.md` §3): the matched layer's pixels in a region pass from its tiles
   at the pass's level instead of its display mirror and a Skia pyramid; this removes the 16 MB mirror slices 5 and 6
   show.
2. **7c**, statistics independent of the pass for the screen and the navigator too (the user's decision (a)): put
   `_mstatsView` on the same entry as `sampledMatchStats`, the (b3) step's bound back to 2, and **measure (b)** (exports on
   the same entry, box means and point samples) for the user. **7d**, the match as GPU uniforms.
3. Then C6 (d), the object tool's bigger change A (ask the user), C4, the rest of §C7, phase R.

## Where things stand (2026-09-16, afternoon: C6 (c) slice 6 is built and pushed)

**Read this block first; it supersedes the "What the next session starts with" of the block below.** `docs/PLAN_BCE.md`
§C6 "C6 (c) slice 6 as built" is the record; `CHANGELOG.md` 0.1.15 has its bullet.

- **Slice 6**, the in-app helper models' inputs (`renderer/editor/host.js`): `objectInput` (one uniform region pass on
  tiles, then the squash; a layer with its mask from its tiles), `cutoutInput` (the layer's levels), `inputHash` (the
  map and the SAM2 embedding are keyed on a SHA-1 of the 1024 px input), `helperCall` (one member for the three IPC
  calls). `ensureObjects` takes the in-app branch before `segmentSource`, so nothing is flattened, encoded or uploaded;
  the hover compares `objects.version` with `compositeVersion` instead of `uploaded.baseHash`. Canvas backend
  byte-identical. At 15k: object input 1955 -> 174 ms blocked and 1733 -> 16 MB (the matched result, slice 7b), cutout
  input 571 -> 38 ms. Gate `helper_inputs_read_levels_and_upload_nothing` (model stand-in), seven mutations red, all
  gates PASS on both backends.
- **Not run:** a real SAM2 / RMBG model on this code (no model in a gate profile; the IPC shape is unchanged).
- **Still slow in the object tool** (`dist/c6map/c/objects.md` §7 to §9, bigger changes A, B, C): the label map at image
  size (286 MB), a W x H shape canvas per hovered object (200-400 ms each at 15k, up to 13 kept), the point prompt's
  W x H mask and `layerAlpha`'s full-resolution clip in "active layer" mode. The map recommends A before or with C4.
- **Flake seen twice today:** `editor_test.py` `closed_tabs_are_collected` with the last two of four tabs alive
  (`[false, false, true, true]`), once per backend; both re-runs passed. Not investigated.
- **Trap met today:** a Bash-tool heredoc that is not quoted (`<<EOF`) runs every backtick span of the text it carries
  as a command. Markdown full of `code` then executes file names as shell scripts (it did, without damage) and commits
  the text with the spans missing. Quote the delimiter (`<<'EOF'`) or write the text with the Write tool.

**What the next session starts with:**
1. **Slice 7**, colour match: 7a (the null-statistics race, a real bug), 7b (the matched region view, which also removes
   the 16 MB mirror slices 5 and 6 still show), 7c (statistics independent of the pass, the user's decision (a), with
   the measurement for (b)), 7d (GPU uniforms). `dist/c6map/c/match.md`.
2. Then C6 (d), the object tool's bigger change A (ask the user where it goes), C4, the rest of §C7, phase R.

## Where things stand (2026-09-16, day: C6 (c) slice 5 is built and pushed)

**Read this block first; it supersedes the "What the next session starts with" of the block below.** `docs/PLAN_BCE.md`
§C6 "C6 (c) slice 5 as built" is the record. `CHANGELOG.md` 0.1.15 has its bullet. `package.json` is still **0.1.15**,
unreleased. `docs/BUGS.md` no longer lists the live-stroke fix (0.1.14 is published).

**Done this session:**
- **The two owed benchmark runs** for slices 3 and 4, `perf:15000x10000` on the tree of 01cc8d0: `slice34-perf-tiles`
  (192 px picture after a whole change: old way 468 ms, settled 43 ms [1134 wall], 98 chains built here against 2,360,
  32.7 MB left against 221) and `slice34-perf-canvas`, both PASS. **`smoke` was dropped on the user's word** ("echten
  flux lauf brauchen wir nicht, das funktioniert").
- **Slice 5**: `promptContextCanvas()` is async and reads levels on tiles (`sampleRegionSettled` plus
  `selectionCanvasSettled`, the selection's own tiles, exact); `drawSelectionInto` takes `display`; `screenshot` is
  `shotCanvas(ed, a)` in `renderer/commands.js`, which reads the image, a layer and the tint from levels. Canvas backend
  byte-identical. At 15k: screenshot 2122 -> 286 ms blocked, 1717 -> 0 MB of mirrors; prompt context about 1.9 s -> 0.07
  to 0.7 s, 1.7 GB -> 16 MB, and that 16 MB is the colour-matched result's mirror (slice 7b). Gates
  `prompt_context_reads_levels_not_a_flatten` and `screenshot_reads_levels`, five mutations red, three new rows in
  `perf_test.py`.

**Gate runs** (fresh instances, own profiles, strict): `s5-tiles2` and `s5-canvas` (commands editor) ALL PASS;
`s5-all-tiles` (pixels composite shape brush film glb ailabel size transparent generate log llm toapis nodecopy) and
`s5-all-canvas` (pixels composite film glb llm) PASS; `mcp` failed on both only because `tools/mcp_test.py` looked for
`test_base.png` in `%APPDATA%/Scumble` whatever `--user-data-dir` said, and that file is no longer in the user's own
profile. It reads the image from the profile it is given now; `s5-mcp-tiles` and `s5-mcp-canvas` PASS.

**What the next session starts with:**
1. **C6 (c) slice 6**, the helper inputs (`sourceCanvas`, the cutout input, `segmentPoint`, the input hash;
   `dist/c6map/c/critic.md` §5 and `objects.md`). Also the first half of the slow object tool (O) on 15k documents.
2. **Slice 7**, colour match: 7a is a real reproduced bug; 7b also removes the 16 MB mirror the slice 5 rows still show.
3. Then C6 (d), C4, the rest of §C7, phase R.

## Where things stand (2026-09-16, night: C6 (c) slices 3 and 4 are built and pushed)

**Read this block first; it supersedes the "Where the next session starts" of every block below.** `docs/PLAN_BCE.md`
§C6 "C6 (c3) and slice 4 as built" is the record (the before/after tables, every decision, the six mutations with their
red). `CHANGELOG.md` 0.1.15 has the two user-facing bullets. `package.json` is **0.1.15** with that section open.

**0.1.14 is published** (Latest since 2026-09-15 21:13 UTC) - the block below still calls it a draft, which is stale.

**What was built.** An exact read of the picture at a mip level - the film looks panel's 192 px thumbnails, the GLB
dialog's backdrop, the magic wand's coarse pass - used to build a mip chain for **every tile of every layer on the main
thread** and keep it. Measured on a synthetic 15000 x 10000 document, each row right after a flip:

| read | in one task | chains built here | left on the tiles |
|---|---|---|---|
| `flatten({ maxSize: 192 })`, level 5 | 509.7 ms | 2,088 | +185.5 MB |
| `flatten({ maxSize: 1024 })`, level 3 | 611.6 ms | 2,360 | +221 MB |
| `sampleRegion` at 256 px | 463.6 ms | 2,360 | +221 MB |

After the four rows the document held **669 MB** of chains nothing on the screen wanted.

- **Slice 3**, `renderer/editor/inpaint_tiles.js`: `primeRegion(rect, level)` asks the mips worker for the **interior**
  tiles' chains (`request(..., screen=false, keep=false)`; `keep` is a parameter of its own now), takes **only the level
  it reads** out of each handed chain into a cell (256 bytes a tile at level 5 against 87 KB for the chain) and keeps no
  chain. `_levelBytes` reads those cells **for exact reads only** - a display read has to take the same decision
  `_stampAt` takes. The **edge tiles are left on the old path on purpose**: their chain is the clamp-extended
  `edgeChain` and `_land` never hands the worker's `exts` over; 98 against 2,262 at 15k, about 13 ms, and that is what
  makes the primed read byte-identical. `_primed` is a **Set** (a second read must not take the first one's landings),
  and a job also settles on `sch.settled()`, because `_notify` drops a landing whose tile was replaced since.
  `PRIME_CELL_BUDGET` 48 MB, counted across every read in flight (`primedPromised`).
- **Slice 4**: `passStores` / `primePass` / `sampleRegionSettled` in `inpaint_canvas.js`,
  `Document.flatten({ settled: true })` (a promise; `docs/PLUGINS.md` "A picture that does not freeze the window"), the
  film looks panel's `render()` async with `busy` held across the await, the GLB backdrop filled after the dialog opens,
  and `floodRegion`'s coarse pass awaited.

**After**, same document, same method: the glb backdrop holds the main thread **46.6 ms** (was 700.6) and the flood's
coarse pass **95.2 ms** (was 621.3); chains left behind **32.7 MB** (was 221); wall clock 700 -> 1193 ms, which is the
trade. **The picture is byte-identical** to the old reader at 2048 x 1152 and at 15000 x 10000, at levels 3 and 5,
checked against a full-resolution flatten.

**Gates.** `pixels_test.js` `tiles_primed_exact_read_builds_no_chain_here` and `editor_test.py`
`a_settled_read_builds_its_levels_in_the_worker_not_here` (an A/B in one document: the settled read built 6 chains here
against the old way's 32, 0.5 MB against 2.66, the same picture to the byte). Two new rows in `perf_test.py`
("192 px picture after a whole change", the old way and settled, with their chain counts and the MB they leave).
**Runs** (fresh instances, own profiles, strict): `slice34-tiles --tiles on` with all fifteen gates **ALL PASS**;
`slice34-canvas --tiles off` with fourteen (no nodecopy) all PASS but `editor`, which failed
`live_stroke_reaches_the_screen_before_the_release` at `z045_paint` with its own "a real pointer over the window?"
message - **the user confirmed they had moved the mouse over the test window**; the stroke itself arrived in full
(`end` 1.0, only the middle sample off). `slice34-canvas2 --tiles off editor` **PASS** on the re-run.

**What the next session starts with:**
1. `perf:15000x10000` for the two new rows, and `smoke` (a real Flux run) before any release. Neither has run for this
   change.
2. **C6 (c) slices 5, 6, 7** of `dist/c6map/c/critic.md` §5 (5: `promptContextCanvas` and `screenshot`; 6: the helper
   inputs; 7: colour match, whose 7a is a real reproduced bug). Then C6 (d), then C4, then the rest of §C7, then phase R.
3. **A real pointer over a test window breaks the stroke steps.** `editor_test.py`'s live-stroke steps drive synthetic
   pointer events; a real mouse over that window wins, and the step says so in its own failure text. Re-run before
   believing an `editor` failure at `live_stroke_reaches_the_screen_before_the_release`.

**Traps found this session, worth keeping:**
- **A mutation that is not run against a fresh instance proves nothing.** The renderer caches the ES module it imported
  at start, so patching a file while the app runs leaves the gate reading the old code: the first mutation round came
  out green on all five counter-proofs. Every round must close the app, patch, and start it again.
- **A benchmark whose "before" row runs after a `mipsSettled()` is measuring a warm document.** The first A/B read
  0.4 ms for a 192 px flatten because the flip's chains had already landed; the honest before is 509.7 ms.
- **An A/B that flips between the two rows compares two different pictures.** Byte comparisons belong in one state, with
  `releaseCaches({ mirrors: true, deep: true })` between the reads, or the second read is handed the region canvas the
  first one filled and the comparison is with itself.
- The review's four lenses found 13 things, **3 survived two refuters each**, and all three were about `passStores`
  being a second copy of `drawLayersInto`: its `forRun` defaulted the other way, and it primed colour-matched layers,
  layers under a live stroke and masks off the tile grid, which that pass reads from a canvas and not from tiles. A
  second walk of the stack is the risk in this design; keep it next to `drawLayer`'s branches.

## Where things stand (2026-09-15, late: 0.1.14 tagged, the live stroke, the atlas field, ToAPIs)

**Read this block first; it supersedes the "Where the next session starts" part of the block below.** 0.1.13 is
published. 0.1.14 is tagged and its **draft** is built; publishing it is the user's step
(`gh release edit v0.1.14 --draft=false`). `CHANGELOG.md` 0.1.14 has the user-facing bullets.

**What 0.1.14 carries, on `main`, pushed:**
- **The live stroke** (74d60ac). In 0.1.13 brush, eraser (also on a mask), clone / heal, gradient and a dragged
  rectangle / ellipse / freehand shape showed only the first dab until the release, on both backends, every size and
  zoom (reported with a screen recording on the installed 0.1.13).
  - Cause: the screen keeps its composited scene behind `sceneSignature()`, whose only input that moves during a gesture
    is `pixelVersion`. Every dab used to raise it through `touchSource(buffer canvas)`; **28bfad0** (C5 c, the sparse
    stroke store) dropped that call from `layerDab`, `cloneDab`, `gradientDab` and `shapeDab`. First bad commit 28bfad0,
    bisected on both backends (4bd31a4 good).
  - Fix: `strokeDirty()` raises `pixelVersion`; only the scene key moves (no mirror, no display level).
  - Gates: `editor_test.py` `live_stroke_reaches_the_screen_before_the_release` (shots right after a move, no rests) and
    the reworked `live_stroke_preview_shows_what_the_commit_writes`; `docs/PLAN_BCE.md` §C7 "The live stroke that did not
    show" has the A/B and the review round. Scratch records: `bug-live/fix.md`, `finish.md`.
- **The atlas field** (a8303fd). *Settings › Rendering › Tile atlas* had `min="16" step="64"`, so its own default 512 was
  invalid and the dialog's *Close* (a validated form submit) refused to close. All three memory rows are `step="1"`
  now, stored values are shown rounded (`wholeMB()`), Generate new's width / height are clamped to 64..8192. Gate step
  `settings_form_accepts_its_own_values`.
- **ToAPIs** (6ff9666, 0adb281, 837f7b7, e3a47b4, review fixes ec7b032), the user's decisions of 2026-09-15:
  - first in every provider list, key link `https://toapis.com/login?aff=vfR1` (referral; README says so for ToAPIs and
    WaveSpeed); recipe defaults unchanged, **no automatic fallback**; the official channel is the default where one
    exists (the mask only on `gpt-image-2-official`), a *Channel* row for vip / standard; upsampling through ToAPIs' Chat
    Completions (three rows, only with a key); *check balance* (`GET /v1/balance`).
  - **Nothing has run against the live API**, on the user's decision: no key was used, every variant note says so and
    says crop, mask and references become public `files.toapis.com` URLs.
  - `docs/RECIPES.md` "ToAPIs" › **"Only a real key can verify"** is the live-test list: `image_urls` strings vs `{url}`
    objects per channel, a PNG's alpha surviving the upload and the mask polarity on `gpt-image-2-official`, the real
    output size for custom ratios and `auto`, the ids `gemini-3.1-flash-lite-image-official` and
    `gemini-3-pro-image-official`, `metadata.prompt_extend: false` on Qwen, FLUX over 1440, `billing.cost_usd` per tier,
    durations, which result shape arrives, the error language, JPEG uploads for the fallback, which "10MB" is counted,
    the Nano Banana / Seedream pro output sizes per tier, how the gateway answers status queries in an outage, and
    whether Seedream's 3:1 limit applies to references. The design (scratchpad `toapis/design.md`) lists the same.
  - **The review round** (two lenses, two refuting verifiers per finding; ec7b032): provider setting targets named no
    recipe, so a *Channel* "standard" chosen on Qwen via ToAPIs ran GPT Image 2 on its maskless channel (major; the node
    id is `provider/<recipe>/<provider>` now); the Generate-new dialog sent "64:43" for 3:2; one 5xx on a status query
    or the download threw a paid task away; *auto* bought 2K where 1K covers (page tables in `options.tier_sizes`);
    references never got the JPEG fallback; Seedream's 3:1 input was unchecked (`limits.ratio` widens the crop,
    `options.max_ratio` refuses); upsampling retried any 4xx without the crop and lost "text only"; the 10 MB guard
    counted MiB. Ten adapter / llm mutations red in `node tools/toapis_test.js` (57 checks), three app mutations red in
    the `toapis` gate. Records: scratchpad `toapis/build/build.md` and `release.md`.

**The release.** The commit that carries this block is tagged `v0.1.14` and the workflow builds a **draft** from
`CHANGELOG.md` 0.1.14. Publishing it is the user's step. Still the user's call: the v0.1.11 draft and the merged branches
(`c2-tiles`, `fix-mask-undo`, `px-spike`, `c0-editor-source`).

Gates on ec7b032 (fresh instances, logs under `dist/gates/gates/<label>/`):
- `rel14-tiles` (`--strict --tiles on`, pixels editor composite commands shape brush film glb ailabel size transparent
  generate log mcp nodecopy toapis llm): ALL PASS.
- `rel14-canvas` (`--strict --tiles off`, pixels editor composite commands size generate transparent toapis): the known
  flake, `commands_test.py` hanging after every step had printed `[ok]` (the runner's 420 s timeout); the re-run
  `rel14-canvas2` ALL PASS.
- `npm run dist` → `Scumble Setup 0.1.14.exe`. Against `dist/win-unpacked/Scumble.exe`, each on its own profile:
  `rel14-exe` (pixels editor commands composite brush toapis mcp, no `--tiles`: `{ tiles: true, from: "default" }`) ALL
  PASS; `rel14-exe-canvas` (`--tiles off`: pixels editor composite) ALL PASS; `rel14-exe-smoke` a real Flux run in 97 s,
  PASS, the ComfyUI queue empty before and after.

**Where the next session starts:**
1. **C6 (c) slices 3 to 7** of `dist/c6map/c/critic.md` §5 (the maps are older than the code; see the block below for
   what each slice holds and the user's three decisions for C6 (c)).
2. **C6 (d)**, the base; then **C4** (`snapshotRect`'s box sharing no tile unless tile-aligned, the `frozen` counter);
   then the rest of **§C7** (the node's browser, Firefox, the 30k gate, the docs list, the memory gate).
3. **The user tests the tile engine on their own 15k file** (what to ask for: the block below, "What the user is to test").
4. **Phase R, Rust kernels** (`docs/PLAN_BCE.md` §2b, decided 2026-09-15 to come after C7): the crate is in the history
   at c75c4f1 (`crates/px/`, `renderer/editor/px/px.js`, `bench.js`), 2 to 3 days, B's 3× rule measured on the real jobs.
5. **Phase E**.

**Also known, not built:**
- **The object tool (O) on 15k documents is slow**: two full flattens for the model input, a 320 MB id map, about
  1.3 GB per hovered object. The input belongs to C6 (c) slice 6 (`sourceCanvas`, the cutout input, `segmentPoint`,
  the input hash); the id map and the hover shapes need a follow-up of their own.
- **The user's helper models** now live in `ComfyUI/models/onnx`, with Scumble's model folder set to `ComfyUI/models`.
- **The Helpers list in Settings was empty once** in the user's running 0.1.13 window; cause unknown, not reproduced.

## Where things stood (2026-09-15: 0.1.13 tagged, tiles on by default)

**The block above supersedes this one's "Where the next session starts".** The records are
`docs/PLAN_BCE.md` §C6 "C6 as built" ((b2), (b3), (c1), (c2), each with its measurements, its mutations and the review fixes)
and §C7 "The default, as built"; `CHANGELOG.md` 0.1.13 has the user-facing bullets.

**The user's decision (2026-09-15): the tile engine is on by default in the installed app from 0.1.13**, with a switch in
Settings › Rendering to turn it off (the user is the only user so far and wants to test it on their own 15k files). The
canvas backend stays as the escape hatch. The node (ComfyUI-InpaintCanvas) is not released with it and keeps its own default
(off).

**Built since the block below, on `main`, pushed:**
- **C6 (b2)** 726dc66, the three benchmark rows that moved in (b), broken down by an A/B against 00a3ade:
  - `getValue` 5-8 ms is the selection's PNG, whose background encode lands during the benchmark's waits: old, on both trees.
  - The commit's time is the collector working on the commit's own garbage, not the chains in flight.
  - The PNG row was charged with the landings the rows before it had asked for.

  Built: a landing of the **selection's** chains draws the overlays again and drops no view cache. A landing of a layer's, a
  mask's or the base's chains drops `_fcacheView` / `_mcacheView` / `_mstatsView` only **above the lowest landed layer**, once,
  when everything has settled. A sampled pass keeps statistics of its own (`_mstatsSample`). `perf_test.py`'s `op()` waits for
  `mipsSettled()`. Invert's re-runs while its chains land went from 30 to 0.
- **C6 (b3)** bc3814d, `layerMatchedPart`: a sampled pass colour-matches only the part of a matched layer it shows. Before, every
  fine box of the flood matched the whole 2048² result (196-224 ms a box); now 7-27 ms. The wand and bucket rows stay noisy,
  because they depend on the state the rows before them leave.
- **C6 (c1)** 81210d1, box reads at level 0:
  - A film control point's colour is the 3 × 3 mean of the **points layer's input** under it (the user's decision):
    `flatten({ box, below, exact })` / `readBox`, padded by the new optional filter field `reach`, or cut out of the whole
    flatten below the points when a filter declares no reach (the look's halation, vignette, normalise, frame).
  - `Document.selection()` reads its bounds (`selection({ box: true })`); the sample plugin's `mean_color` with a selection,
    *Selection to new layer* and the probe read boxes.
  - The bucket's fine rounds read `sel.toCanvas(box)`.
  - The filter cache key carries the pass's box and scale.
  - A point add without filter layers takes 109-143 ms at 15k. Under the perf document's film look it is the whole flatten
    below again: 5.1-5.4 s, the same as before (c1).
- **C6 (c2)** 1513624 … b1a9afb, six holes in region passes that still made display mirrors, one commit each:
  - (a) A masked layer, or a live stroke outside the screen's own, composes in a pass scratch (`drawLayerPass`).
  - (b) `sampleRegion("layer")` reads tiles.
  - (c) A filter layer's mask reads tiles, and so does a mask stroke on it.
  - (d) A move / scale / smudge gesture draws the layer from tiles.
  - (e) A layer's row during a stroke on it comes from its thumbnail. The row shows the picture from before the stroke.
  - (f) The peek is a base-only pass.

  At 15k: the wand with a masked layer 1.3-1.8 s → 0.3 s, the eyedropper on it 1044 → 15-34 ms, the peek's first frame 558 → 50-60
  ms, a move drag's first frame 425 → 0.2 ms. The perf footer holds 1 mirror of 16 MB, against 2 of 588 MB.
- **Review fixes** 10def79 for (b3), (c1) and (c2):
  - The control points' shader and CPU path now add the pass's origin. A zoomed view had shown the effect shifted since phase 1, on
    both backends.
  - A point's colour is padded by the declared reach.
  - `pad` counts whole canvas pixels.
  - A level-0 read that is not for the screen takes a region slot of its own.
  - `flatCache` lets go when the composite version moves.
  - `_filterMaskView` is released and counted.
- **The default** 7a89601:
  - `electron/main/tilemode.js`: `--tiles` / `--no-tiles` > `SCUMBLE_TILES` > a boolean `tiles` in settings.json > **on**, with
    `from: "default"`. Nothing writes the setting on its own.
  - Settings › Rendering › *Tile engine*: a box, a note saying what decided this window, and *Restart now*. The button is IPC
    `app:relaunch` in `electron/main/restart.js`. It saves first (`saveBeforeRestart()`: `syncLayers()`, then waits for the
    selection's encode), drops `--mcp` / `--headless` / `--cmd` from the relaunch, and installs an update that has already been
    downloaded.
  - Gate steps `tile_engine_row_writes_the_setting_and_names_its_source` and `restart_now_saves_the_edits_of_the_last_seconds`,
    plus `node tools/tilemode_test.js` and `node tools/restart_test.js`.
- **Memory**, `mem_test.py 15000x10000 --rounds 2`, one document, renderer / GPU process:
  - Tiles on: about 4.5 GB / 2 GB. Tiles off: 0.7 GB / 7.5 GB. Closed documents are collected on both backends.
  - Three 15k documents open on tiles: 10.4 GB renderer and a 65 ms pan.
  - **§C7's memory gate is not met** (at most 300 MB of GPU process per document, 4 rounds, the renderer against the tile bytes).
    The levels-tick drift check reads FAIL (+22 %). The default went on anyway, on the user's decision.

**The release.**
- The commit that carries this block is tagged `v0.1.13`, and the workflow builds a **draft**. **Publishing it is the user's
  step** (`gh release edit v0.1.13 --draft=false`); only then do installed apps update.
- The v0.1.11 draft and the merged branches (`c2-tiles`, `fix-mask-undo`, `px-spike`, `c0-editor-source`) are still the user's
  call.

Gates:
- **Dev, on 7a89601** (fresh instances, strict), all ALL PASS:
  - `rel-final-tiles` and `rel-final-default`, the fifteen gates each.
  - `rel-final-canvas` (`--tiles off pixels editor composite commands`), on the re-run. The first run hit
    `live_stroke_preview_shows_what_the_commit_writes` on canvases, 157 levels, a flake.
  - Before the review fixes: `rel-tiles`, `rel-canvas`, `rel-default` and `rel-copy`.
  - `rel-smoke`: a real Flux run, PASS, the queue empty before and after. The run took **387 s**, against the runner's 420 s timeout
    (91 s on the exe right after). Probably ComfyUI loading the models again after the user's own jobs; not checked.
- **Built:** `npm run dist` → `Scumble Setup 0.1.13.exe`.
- **Against `dist/win-unpacked/Scumble.exe`**, each on its own profile, all ALL PASS:
  - `rel-exe`: pixels editor commands ailabel brush glb composite mcp, with no `--tiles`. The backend step and the row read
    `{ tiles: true, from: "default" }`.
  - `rel-exe-canvas`: `--tiles off`, pixels editor composite commands.
  - `rel-exe-smoke`: a real Flux run in 91 s, the queue empty before and after.

**What the user is to test:** their own 15k file in the installed 0.1.13, with tiles on. If it stutters, ask for two things:
- **which action** it was: pan, zoom, brush, mask, a selection operation, the wand, Generate or export;
- **Settings › Rendering's numbers** while it stutters, and *Help › Console › Copy all* for any error.

Then the same with the engine off (untick the box, *Restart now*) for comparison. What is still slow on purpose is listed in the
CHANGELOG's lead bullet:
- the smudge brush;
- a wand across the whole picture, and invert;
- whole flattens: renders, exports, the object tool, upsampling, `screenshot`;
- a film point under a film look;
- whole-layer copies: background removal, select by text, select from layer, the autosave;
- several 15k tabs open at once.

**Where the next session starts:**
1. **C6 (c) slices 3 to 7** of `dist/c6map/c/critic.md` §5.
   - **Where the maps are:** the critic and the five maps it checked (`commands-plugins.md`, `match.md`, `objects.md`,
     `region-holes.md`, `sample-region.md`) are copied there from the session scratchpad, with the user's decisions as
     `decisions.md`. The build / fix reports of (b2) and (c1) sit in `dist/c6map/` (`b2-ab.md`, `b2-build.md`, `b2-fix.md`,
     `c1-build.md`, `c1-fix.md`), the release default's in `dist/c6map/rel/`. All of this is git-ignored.
   - **What is done:** slice 1 is (c1) and slice 2 is (c2) a-f. Slice 0's A/B was (b2).
   - **The maps are older than the code:** they were written at 987961b, before (b2) … (c2). Line numbers have moved, and some
     items are done: the bucket's `toCanvas`, the filter cache key, `_mstatsSample`, the origin of the control points.
   - **What is left:**
     - **3:** a one-shot exact reader in `inpaint_tiles.js`: a `keep` separate from `screen`, a landing handed to the read that
       waits for it, and the thumbnail route.
     - **4:** async readers on it: the film panel's `flatten({ maxSize, settled })`, the glb backdrop, the flood's coarse pass.
     - **5:** `promptContextCanvas` and `screenshot`.
     - **6:** the helper inputs: `sourceCanvas`, the cutout input, `segmentPoint`, the input hash.
     - **7:** colour match:
       - 7a: the null-statistics race, which (b2) / (b3) left and reproduced (a statistics drop between the flood's passes
         makes the wand select a different region);
       - 7b: the matched region view;
       - 7c: statistics independent of the pass, per decision 1 below;
       - 7d: GPU uniforms.
   - Critic §6 lists the open measurement decisions.
2. **The user's decisions for C6 (c)** (2026-09-15), copied from `decisions.md`:
   1. Colour match statistics independent of the pass: **(a)**. The screen, the navigator, the eyedropper, the wand / bucket
      samples and the plugin panels share one statistics entry per layer per change, taken from levels of the whole padded
      surroundings. The full-resolution flatten (exports, runs, uploads) keeps its own `_mstats`, and its output stays
      byte-identical. Measure during the build how far (b) (the export on the same entry) would move real inpaint results,
      including a sampling that keeps texture (point samples instead of box means), and report it. (b) comes back to the user
      only with those numbers.
   2. Film control points read the colour of the points layer's input (everything below the points layer) under the point, not
      the whole composite: **(b)**. CHANGELOG bullet. *(Built in (c1).)*
   3. `sample.mean_color` without a selection stays an exact full-resolution read: **(a)** (phase E makes it fast). With a
      selection it reads the selection's bounds. *(Built in (c1).)*
3. **C6 (d), the base:** item 3 of the block below.
4. **C4:** item 4 of the block below, including `snapshotRect`'s box that shares no tile unless it is tile-aligned, and the
   `frozen` counter.
5. **The smudge tool on tiles:** 400-750 ms per move at 15k, read from the layer's mirror; it needs its own step.
6. **Measured in the release review and not broken down** (§C7 "The default, as built"):
   - A cold whole flatten on tiles: 4.7-11.4 s with a film look, 0.9-2.5 s without, against 0.22-0.31 s on canvases.
   - `perf_test.py`'s "full composite" worst: 1.9-2.7 s in C5, 4.9-8.0 s since C6 (b).
   - A whole-layer `toCanvas()` 184-253 ms.
   - Several open 15k documents: the levels tick 49-64 ms.

   The rest of §C7 is open too: the node's browser, Firefox, the 30k gate, the docs list, the memory gate.
7. **The node repo** is still at 647db5d, behind by C3, C5, C6 and this default. `nodecopy` passes. Build it into the real repo only
   when a node version is meant to ship.

## Where things stood (2026-09-15, 01:30: C6 steps a and b are built and pushed)

**The block above supersedes this one's "Where the next session starts".** `docs/PLAN_BCE.md`
§C6 "C6 as built" is the record (measurements, decisions, every mutation with its red, the review fixes). The user stopped the
session here on purpose ("commit und push, dann Stop bis morgen").

**Done this session, on `main`, pushed:**
- **C5's owed gate**: `smoke_test.py --no-helpers` with a real Flux run PASS with tiles on (196 s) and off (94 s), the ComfyUI
  queue empty before and after.
- **C6 (a)** `00a3ade`, "the atlas is keyed right". Three real defects in C3/C5 code, each reproduced red first:
  - A second "mask from selection" kept showing the first mask (both masks had `_version` 1). Tile versions now come from one
    module-wide counter (`pixelSeq`).
  - Replaced pixels (flip, turn, a new mask, undo restores, a new base) were never forgotten by the atlas. Three flips of a 15k
    layer kept 2.4 GB alive until their pages aged out. The compositor now holds pixels weakly, and `retainPixels(live)` drops
    what the document does not hold.
  - A slot's gutter went stale when only a neighbour changed (76 / 104 levels at a tile border). Each slot records its
    neighbours' versions, and only the ring is re-uploaded.
- **C6 (b)** `e32d4ae`, "mips off the main thread". Measured first:
  - At fit on 15k every chain was built twice: the layer thumbnail built 2,360 into a thrown-away scratch, then the atlas built
    them again.
  - A whole `touch()` rebuilt chains for unchanged tiles.
  - The frame after a whole change blocked 530–790 ms.

  Built:
  - `touch()` no longer bumps tile versions; every write already goes through `writable` / `_share` / `_dropTile`.
  - The thumbnail reuses chains.
  - A `mips` job runs in a **worker of its own** (`ChainScheduler` in `inpaint_tiles.js`).
  - The screen shows the previous chain, or a nearest-sampled coarse slot, until the fresh one lands.
  - `watchChains()` / `redrawThumbsOf` refresh thumbnails and view caches on landing; `ed.mipsSettled()` lets tests wait.

  After: that frame is **12–26 ms**, the picture is sharp about 0.4–0.9 s later, and a whole touch costs 3–6 ms. The review
  confirmed 16 findings plus 1 split; all were fixed with counter-proofs (23 mutations red).
- Gates on `e32d4ae`: `--tiles on` and `--tiles off` with all 15 gates ALL PASS, `--copy` ALL PASS, `perf:15000x10000` PASS.
  `smoke` was **not** re-run after (a) and (b).

**Where the next session starts:**
1. **Three benchmark rows moved the wrong way in (b) and were not broken down**:
   - `PNG of the composite` blocked 30 → 88–284 ms;
   - `getValue` 0 → 5–8 ms;
   - `its commit, band by band` 562 → 604–698 ms.

   Measure these first (A/B against `00a3ade`), before C6 (c). Also, the film panel's `Document.flatten({ maxSize })` reads
   exact mips through `sampleRegion` and builds every chain on the main thread while the worker's chains land: 141 ms, the
   longest block after a whole change. That is C6 (c)'s.
2. **C6 (c), the small readers from levels.** The code maps this session made (at d7234e4; line numbers have moved) and the
   build / fix reports of (a) and (b) are kept in `dist/c6map/` (ignored by git): `readers.md`, `base.md`, `undo.md`,
   `mips.md`, `worker.md`, and `critic.md`, which corrects the others. The full-resolution readers left in tile mode are:
   - `promptContextCanvas` (a whole flatten for a 1024 px picture);
   - `host.findObjects` / `sourceCanvas` (one or two whole flattens for a 1024² model input, plus a 286 MB id array);
   - the `screenshot` command;
   - the film control points' `sampleColor` fallback (`doc.flatten()`);
   - `peekBase` (the base mirror plus a GPU copy).

   The holes that still build the 572 MB display mirror inside "small" passes:
   - a colour-matched layer in any region pass (`layerMatchedPixels`);
   - `sampleRegion(source: "layer")`;
   - a filter layer with a mask (`maskPx.drawTo`);
   - a live stroke's layer thumbnail.

   One probable bug to verify: `matchStats`' `_mstatsView` is shared by the screen pass and every sample pass (a 1 × 1
   eyedropper pass can store `null` stats). Decide with a measurement whether `composite_tile` with blend modes is needed at
   all; the Canvas 2D `sampleRegion` already composites tiles at a level.
3. **C6 (d), the base**:
   - `basePx` built eagerly and `base.img` released;
   - the `canvas` undo step keeps base pixels (a free `clone()` on tiles) instead of the `<img>`;
   - `cropCanvasNow` through `resized`;
   - `resizeImageNow` is the one draw of the `<img>` itself: measure the resampler difference before dropping it;
   - `setBaseFromCanvas` / `flattenNow` / `mergeDownNow` decode their own upload again (transparency round trip: measure).
4. **C4** (after C6). Found by this session's map:
   - `snapshotRect` puts its box at `floor(x) - 2`, so `copyRect` shares **no** tile unless the box is tile-aligned: a stroke's
     undo step copies every tile its box overlaps. Align the copy to the tile grid on tiles.
   - `frozen` is left too high by every released step, every replace-restore, `selmove`'s `orig` clone, `layer._textUndo`, and
     the mask clones in fill / clear on a mask. Too high only costs a copy; **too low would write into a shared tile**, so a
     release must never let go of pixels the document still holds.
   - The redo copy of a `layerrect` grows 6 px per round trip.
   - `memoryReport` now counts chains, but not edge copies or undo-held old bases.
5. **The smudge tool on tiles** (measured in (b), not changed): 400–750 ms per pointer move at 15k, because it reads the 572 MB
   display mirror and builds a pyramid every move. It is a C5 stroke-store leftover; it needs its own step.
6. **`smoke`** once more before any release (check `/queue` first). The node repo is still at 647db5d, behind by C3, C5 and C6;
   `nodecopy` passes.

**Gate flakes seen this session** (re-run before believing):
- `commands_test.py` hung in `Page.captureScreenshot` after every step printed `[ok]` (2 of 4 full runs in (a)).
- `composite_test.py` once got a 1200 × 794 canvas against its 1200 × 800 reference and then crashed on `KeyError 'bytes'` in
  its own failure message (a one-line test bug, not fixed).
- `live_stroke_preview_shows_what_the_commit_writes` and the composite window step failed once right after a diagnostic instance
  was closed.
- The marching ants (120 ms) broke a screen comparison 2 in ~10 runs; steps that compare the screen draw the selection as a tint.

**Traps met on 2026-09-14 / 15:**
- A background `grep` loop on a workflow's `journal.jsonl`, meant to stop the workflow after its build agent, did not fire in
  time; the review round ran anyway. Stop a workflow by reading its journal by hand, or give it a phase switch in `args`.
- A copy-on-write copy that takes the original's chain buffer must take ownership: the last holder of the original writes into
  it in place otherwise.
- A whole thumbnail rebuild that asks for chains it then drops asks again forever (1.8 million requests); cells are kept per
  tile version.

## Where things stood (2026-09-14, night: C5 steps a to e are built and pushed)

**The block above supersedes this one's "Where the next session starts".** `docs/PLAN_BCE.md` §C5 "C5 as built"
is the record (five steps, each with its decisions, its measurements and its counter-proofs), plus
"Where C5 leaves the magic wand and the bucket, measured". `CHANGELOG.md` 0.1.13 has the five
user-facing bullets.

**The display mirror is gone.** On `main` (dff8b47, 4bd31a4, 28bfad0, 9152217, 2ddb163, pushed),
measured on a 15000 x 10000 document in tile mode:

- **(a)** The live stroke is composed in the **region the pass draws**, in a scratch of the window's
  size (`layerRegionView` / `refreshStrokeView`), not in a canvas as large as the layer filled from
  the layer's display **mirror**. First dab plus its frame **180.6 → 0.9 ms**, mirrors alive during a
  stroke **2 (1144 MB) → 0**, display pyramids **187.8 → 0**. The **base** also still drew through
  `displaySource` in a region pass (572 MB mirror + 188 MB pyramid on its own); it takes
  `drawTilesInto` now. On the **canvas backend** the same step takes 572 MB off a stroke.
- **(b)** A stroke is clipped and applied **band by band** (`strokePatch`, `strokeBands`,
  `StrokeBuffer.cells`), so `clippedStroke` / `p.clipCanvas` / `clipScratch` are gone. A 40-dab
  stroke across the picture clipped to a selection: dabs and frames **870.6 → 29.4 ms**, its commit
  **1312.6 → 281.6 ms**, and 1.12 GB of clip canvases gone.
- **(c)** The **stroke buffer is a sparse store** on tiles (`StrokeBuffer.draw()` replaces
  `ensure()`): that stroke's buffer **560.7 → 26.5 MB**. The gradient keeps the canvas buffer (it
  rebuilds the whole thing per move) and `paintShape` composes its transform now (C1 rule 12).
- **(d)** A transparency **mask is a sampler** in the atlas shader (`u_mask`, `a_muv`,
  `tileMaskOf`), so `layer._masked` is gone: **1.86 GB** (a 572 MB canvas, two 572 MB mirrors, a
  143 MB pyramid) and a mask brush's edit **253.3 → 1.2 ms**. One row got worse: a change to the
  **whole** mask 17.6 → 157 ms (2,400 mip chains rebuilt on the main thread) — that is C6's.
- **(e)** Grow, shrink and feather send only the **selection's box plus the operation's halo**
  through the worker, and invert walks the mask's own tiles (`MaskPixels.invert()` /
  `TileMaskPixels.invert()`). Blocked [wall] ms: grow **1288 [4237] → 273 [2305]**, shrink
  **1207 [3298] → 271 [1514]**, feather **1386 [2366] → 229 [592]**, invert **1535 [2742] →
  1047 [1047]**. The canvas backend gains too (grow 140 [2322] → 75 [1252]).

**Where the next session starts.** `docs/PLAN_BCE.md` §C5 ends with **"Where C5 leaves the magic
wand and the bucket, measured"**: the wand is `sampleCanvas` 153 ms + the flood **3,118 ms in the
worker** + writing a whole-picture answer into the mask **1,661 ms**, and the write was tried band
by band and got **30 times worse** (150 sub-rectangle draws from a 15000 x 10000 canvas). What is
left there is a flood over the whole picture — a kernel and a band question, phase E's, not mask
tiles'. **C6** is the next step by size: a whole-layer or whole-mask change rebuilds every visible
tile's mip chain on the main thread (157 ms for a mask at 15k), which is what C6's `mips` worker job
is for. **C4** is still the short clean-up it was (byte accounting and the `frozen` counter).
**Not built on purpose, with the measurement in the plan**: the compositor's three op modes for the
stroke store — with the compositor standing down for a gesture a stroke costs one 21.9 ms frame and
then 0.1 ms a dab, so they would buy that one frame.

**Gates** (fresh dev instances, own profiles, strict): `--tiles on` and `--tiles off` with `pixels
editor composite commands shape brush film glb ailabel size transparent generate log mcp nodecopy`
ALL PASS, and `--copy --tiles off pixels editor composite commands` ALL PASS. New gate steps:
`editor_test.py` `live_stroke_preview_shows_what_the_commit_writes` (seven gestures, the screen just
before the commit against the screen just after it, with a "the stroke really painted" floor),
`a_stroke_across_the_picture_keeps_only_the_tiles_it_touched`,
`gradient_tool_keeps_the_canvas_buffer_and_fills_the_layer` (the gradient tool had **no** gate at
all before), `grow_feather_and_invert_are_the_answers_a_whole_image_run_gives`;
`shape_test.py` `a_shape_dragged_smaller_leaves_nothing_behind`; `pixels_test.js` `mask_invert`;
and two rows in `perf_test.py` (`stroke across the picture (40 dabs)`, `its commit, band by band`).
**Twenty mutations, every one red** — they are listed per step in `docs/PLAN_BCE.md` §C5.
The benchmark rows were taken twice, the second time with the card free (ComfyUI's models unloaded
through `/free` on an empty queue); the numbers agree, so the A/B conclusions do not rest on a busy
card. **`smoke_test.py` did not run**: the user queued a video upscale in their ComfyUI while the
gates were going, our prompt sat behind it and hit the runner's timeout. Our own prompt was deleted
from the queue (`afa4d09d`); their jobs were not touched. A real Flux run is the one gate C5 owes.

**The node repo is untouched** and still at master 647db5d (built from scumble 7f01699), so its
`js/` is behind by C3 *and* C5. The `nodecopy` gate builds and tests the editor into a scratch copy
on every run and passes, so the build is sound; `python tools/build_node.py` + `node_test.py`
against the real repo is a deliberate step for whoever ships the next node version.

**Traps met on 2026-09-14 (night), worth keeping:**
- **A sub-rectangle draw from a very large canvas is not cheap.** Banding the wand's whole-picture
  answer into 150 draws of 1024 px cost **30x** one whole draw (1,661 → 49,525 ms). Bands only pay
  when the *source* of each band is small too.
- A `CanvasGradient` belongs to the context that made it; on tiles every dab draws on a scratch of
  its own, so a cached one has to be keyed by the context as well.
- Two gate flakes to recognise: `node tools/brush_test.js` hung once at exit under load (it had
  printed every PASS), and `closed_tabs_are_collected` failed once against an instance that had 50+
  tabs from repeated runs. Both passed on a fresh run; re-run before believing either.
- `tools/run_gates.sh` and the mutation helpers restore only the files they saved: a counter-proof
  that patches `inpaint_tiles.js` is not undone by a script that keeps `inpaint_canvas.js`. Check
  `git diff --stat` after a mutation round.

## Where things stand (2026-09-14, late: C3 steps a to d are built and pushed)

**Read this block first; it supersedes the "Next" line of the block below.** `docs/PLAN_BCE.md` §C3
"C3 as built" is the record (decisions, traps, the measurements, and **"What C3 still owes"**, which
is where the next session starts); `docs/PERFORMANCE.md` §9 has the C3 numbers.

**The screen draws tiles now.** On `main` (a8065ad, 2462b30, 11e4897, 4003194, c4a8281 plus two doc
commits, pushed), in tile mode:

- **(a)** `tileWithGutter(tx, ty, level, out)` on the tile store is one atlas slot: the tile at a
  level, **premultiplied**, with a one-pixel gutter of its neighbours' edge pixels; `extendTile()`
  gives the last tile of a row or column a clamp-extended copy before its mips are built, so the
  image's own edge does not fade by a level of mip.
- **(b)** The GPU compositor keeps an **atlas per (pixels object, level)** and draws the visible tiles
  instanced (`drawArraysInstanced`, the rectangles in image coordinates and the region a uniform, so a
  pan reuses the buffers). `glLayerSpec` hands a tile store over as itself with
  `floor(-log2(scale))`. Budget `settings.memory.atlasMB` (512, a row in Settings › Rendering), LRU by
  bytes; the pages go with the pixels (`forgetPixels`).
- **(c)** `regionCanvas(rect, level)` is the part of the pixels a view shows, from the tiles' mips
  (whole tiles, one tile of margin, two levels kept, one `putImageData` on a whole rebuild).
  `drawSelectionInto` draws the tint, the marching ants and the navigator from it.
- **(d)** `drawTilesInto` puts the **Canvas 2D** path on it too (`drawLayer`, for a plain layer in a
  view pass), which is the path a filter layer in the stack, a live stroke, a transform and compare
  force.

**The numbers** (15000 × 10000, `perf_test.py`, which has four new rows and a footer saying what the
display costs on tiles): first frame from fit to 1:1 on the GPU stack **1027 → 35 ms**, pan at 1:1 on
the Canvas 2D path **41 → 2.5 ms**, the opacity slider 56 → 8, a selection change 78 → 21, an undo
step 66 → 18, the worst `redraw with ants` frame 391-479 → 47-70, the document's display pyramids
**956 → 196 MB**, and the compositor holds 91 MB of atlas pages where the old path made a 600 MB CPU
mirror per source plus a GPU copy of it.

**What C3 still owes, and where to start**: `docs/PLAN_BCE.md` §C5 ends with **"Where C5 starts, as
the tree stands after C3"**, which names every site and the numbers to beat. In short: the **live
stroke's preview** is the last thing that makes
a display mirror (`layerWithStroke` copies the whole layer into a full-size canvas at the first dab:
355 ms and 1.1 GB at 15k, measured A/B) — that is C5's stroke store. The mask sampler (`u_mask`) and the three op modes C3 did not build
belong to that step, after which `WINDOW_PX` / `_source` / `_texture` and the display pyramid can go.
The seconds left in tile mode are C5's other half: grow / shrink / invert / feather 1.1 to 1.6 s, the
wands 1.0 to 4.4 s, the bucket 1.1 s, all of which still materialise the whole selection. **C4 is
not the next step**: C2 already replaced the undo steps' PNGs with copy-on-write clones, so what is
left there is byte accounting and a `frozen` counter, a short clean-up after C5. The full-resolution Canvas 2D path of exports, runs and the flattened composite still
reads the mirror; that is phase E.

**Gates** (fresh dev instances, own profiles, strict): `--tiles on` and `--tiles off` with `pixels
editor composite commands shape brush film glb ailabel size transparent generate log mcp nodecopy`
ALL PASS, `--copy --tiles off pixels editor composite commands` ALL PASS, and `smoke_test.py
--no-helpers` with a real Flux run in both modes (the queue empty before and after each). Every fix
has a counter-proof (a mutation of it is red): the gutter, the clamp extension, the premultiply, the
unpack switch, `forgetPixels`, the tile path itself, the region's origin, the region's dirty set, and
the Canvas 2D branch.

**Gate changes worth knowing**: `composite_test.py`'s gpu-vs-2d step now shoots **at 1:1 as well** and
that is the row it gates on tiles (the tile compositor must agree with Canvas 2D to the level there);
the fractional-zoom row is reported, like the window step's `fit` row. That window step checks the
**atlas** on tiles instead of the source windows (a pan **back** must upload nothing).
`editor_test.py` has `selection_overlay_is_drawn_from_the_mask_itself` (both backends, same expected
pixels) and its backend step now also checks the Canvas 2D path with a filter layer.

**Traps met on 2026-09-14, worth keeping:**
- **Chromium applies `UNPACK_PREMULTIPLY_ALPHA_WEBGL` to an `ArrayBufferView` upload too** (the WebGL
  spec says it applies to DOM sources and `ImageData` only). A canvas source uploaded earlier in the
  same frame leaves the switch on, and already-premultiplied tile bytes are then premultiplied twice:
  a text layer lost its anti-aliased edge (65 levels on 1,389 pixels) while every layer **on its own**
  was exact. Set both unpack switches explicitly before every typed-array upload.
- A benchmark row only measures what its document exercises: `perf_test.py`'s stack always carries a
  filter layer, so it never touched the GPU compositor and C3 (b) moved none of its rows until the
  three "GPU stack" rows were added.
- ComfyUI holding the card changes the op rows by 3 to 5× (`stroke commit` 336 → 845 ms with the same
  code). A/B any suspected regression in the same session before believing it.
- `run_gates.sh` hung once after every step of `commands_test.py` had printed `[ok]` (the runner's
  420 s timeout, not a failure); the re-run passed in a second.

## Where things stood (2026-09-14, morning: 0.1.12 released with C1 and C2)

**The block above supersedes this one's "Next" line.** `docs/PLAN_BCE.md` is the plan
(§C1 "C1 as built" with "The C1 close-out"; §C2 "C2 as built" with "The final C2 review", "C2 finished" and
**"What C3 inherits"**, which is where C3 starts); `docs/PERFORMANCE.md` §9 "C1" and "C2" hold the numbers.

**0.1.12 is released** (tag `v0.1.12` on main 7f01699, published 2026-09-14 06:59 UTC as Latest, CI build
run 34815555598; `latest.yml` on the public feed says 0.1.12, so installed apps update). On the user's
decision ("ein Release 0.1.12 mit C1 + C2", tag and publish after green exe gates) it carries:

- **C1**, the `LayerPixels` / `MaskPixels` interface (`renderer/editor/inpaint_pixels.js`), with its close-out.
- **C2**, the tile store (`renderer/editor/inpaint_tiles.js`) as the second backend behind **`ed.tileMode`**:
  `--tiles` / `--no-tiles` > env `SCUMBLE_TILES` (1 / 0) > a boolean `tiles` in settings.json (never written as a
  default) > on in dev, **off in the packaged app**; the node reads `localStorage["inpaint_canvas.tiles"]` (off).
  `status` reports `pixels: { tiles, from }`. Tile mode is not fit for users yet (15000 × 10000: stroke commit
  284 ms against 1, grow / shrink / invert / feather 1.2-1.5 s, renderer 3.55 GB for 12000 × 8000 against 0.49);
  canvas mode measured within noise of the build before C2 in every `perf_test.py` row.
- **The mask-undo fix**: c6bc6a6 (C1 close-out) had broken the undo of a mask brush stroke ("could not load
  true"); fixed before it shipped (branch `fix-mask-undo` 4644070, merged), step `mask_brush_stroke_undo_and_redo`.
- **The merge review's fix** (7f01699): the canvas backend's `drawInto` now also refuses an async callback, as the
  tile backend did; `docs/PLUGINS.md` has the two missing callback rules (no pixel reads from `ctx`, synchronous).

How it got there: `fix-mask-undo` fast-forwarded into main, `c2-tiles` merged (04cb406; one conflict in the undo
image loading, resolved to C2's form), release notes (1bcc2b0), a two-lens review with refuting verifiers (one
finding, fixed), then gates on 7f01699: dev strict `--tiles on` and `--tiles off` with pixels editor composite
commands shape brush film glb ailabel size transparent generate log mcp nodecopy ALL PASS, `--copy` ALL PASS;
`npm run dist` and on `dist/win-unpacked/Scumble.exe`: pixels editor commands ailabel brush glb composite mcp
PASS (tiles off, strict off, `tilesFrom` "packaged build"), `--tiles` pixels editor composite commands PASS,
smoke PASS (real Flux run, queue empty before and after). The CI installer is built separately from the local
one (same commit, not byte-identical).

**The node** (master 647db5d, pushed): `js/` built from scumble 7f01699 (now with `js/inpaint_tiles.js` and
`js/px/kernels_js.js`), `node_test.py` PASS, which also puts the mask-undo fix in front of git users. The Comfy
Registry publish of 0.3.2 ran (publish_action run 34814844844, success) and the version is
**NodeVersionStatusPending**. **For the user**: `https://api.comfy.org/nodes/comfyui-inpaintcanvas/versions`
lists every earlier version (0.3.1 down to 0.2.0) as **NodeVersionStatusBanned** with no reason given, so the
registry may never have offered an installable version; the reason should be on the publisher page at
registry.comfy.org. Nothing was changed about it.

**Still open, the user's calls**: the **v0.1.11 draft** release is still a draft (superseded by 0.1.12; publish
or delete it); the merged branches `c2-tiles`, `fix-mask-undo`, `px-spike`, `c0-editor-source` still exist on
the remote. `package.json` is **0.1.13** with an empty `## 0.1.13 — unreleased` section in `CHANGELOG.md`.

**Next (done since, see the block above): C3, the compositor draws tiles** (`docs/PLAN_BCE.md` §C3), on main. Start from "What C3 inherits": the
display mirrors and GPU screen copies to delete, the tile-mode costs with numbers, the per-document level-5 canvas
that was not built. Work the way C1 and C2 were built: a workflow per step (build, a three-lens review, two
refuting verifiers per finding, a fixer with a counter-proof per fix), the gate runner with `--tiles on` and
`--tiles off`, and node gates against a scratch copy (`build_node.py --node <copy>`, `node_test.py --node <copy>`)
until a step is meant for the node. The gate runner is **`bash tools/run_gates.sh <label> [--strict] [--copy] [--tiles on|off] [--exe PATH] <gates...>`**
(fresh instance on 9555, own profile with `test_base.png`, per-gate timeout, logs and `summary.txt` under
`dist/gates/gates/<label>/` or `$SCUMBLE_GATES`; gate `nodecopy` builds and tests the node in a scratch copy;
`tools/close_app.py` closes an instance by its DevTools port, `SCUMBLE_CDP_PORT`).

**Traps met on 2026-09-13 / 14, worth keeping:**
- **Chromium switches canvas acceleration off for the whole document** once at least 100 `getImageData` calls
  have disabled acceleration and they reach 95 % of all canvases the document ever created
  (`html_canvas_element.cc`): every new canvas without `willReadFrequently` is software from then on, and
  pan / stroke costs jump (64-107 ms pan with a filter layer). A test script with a screen readback after every
  step can trip it; ordinary use did not in 300 selection changes.
- An OffscreenCanvas never moves to the GPU and draws like a CPU `<canvas>`, but it **clips without
  anti-aliasing** (an arc clip 588 bytes apart): the `drawInto` rules allow clips on whole pixels only.
- A canvas 65,536 px on a side draws and reads nothing; 65,535 works.
- Skia's CPU raster is not exactly translation-invariant (a selection shape drawn far from the origin differs
  in about 600 pixels, alpha up to 68 levels, from the same shape on a scratch at the origin).
- `img.decode()` never resolves in a hidden window; wait for `onload`.
- Commit message files: reuse one and the next commit gets the old message (happened once on c2-tiles, fixed
  with a `--force-with-lease` of that branch).
- The node's publish action runs on a push only when `pyproject.toml` changes; otherwise
  `gh workflow run publish_action.yml --repo DenRakEiw/ComfyUI-InpaintCanvas --ref master`.

## Where things stand (2026-09-13, late: phase B and C0 built)

**Phase B is done** on the branch `px-spike` (pushed, fe9bf0e..cc3be22): `docs/PERFORMANCE.md`
§10 has the table and the decision **JS kernels** (Rust SIMD128 only 2.0 to 2.4× on the rule
rows, EDT band and opaque mip chain, in the Electron renderer in front, Node and Firefox).
`renderer/editor/px/kernels_js.js` holds the kernels C uses (tested by `node tools/px_test.js`),
the Rust crate is deleted (history at c75c4f1). Binding findings for C/E: tile buffers copied
into each other start on a 4 KB boundary (4K aliasing), V8's efficiency mode slows JS 1.5-2×
when the window is not in front, tile size 256, today's `floodMask` beats the flood twin.
`docs/PLAN_BCE.md` §B3 and its §4 table carry the outcome.

**C0 is done** on the branch `c0-editor-source` in **both** repos (app 83f12dd, based on
px-spike; node 6494fc2 + 689df64, based on master 83887b6), pushed, **not merged**:
`renderer/editor/` is the source of the editor, `tools/sync_editor.py` and `docs/SYNC.md` are
gone, `docs/BUILD_NODE.md` explains `tools/build_node.py` (writes the node's js/, `--check`
verifies parsing, imports and that every `host.*` exists in both hosts) and
`tools/node_test.py` (the node's flavour against ComfyUI stand-ins, no ComfyUI needed).
Gates PASS on a fresh dev instance: editor, composite, shape, brush, commands, film, glb,
ailabel, size, transparent, generate, log, mcp, node_test (commands and film need
`files/input/inpaint_canvas/test_base.png` in the test profile's mirror; copy it from
ComfyUI's `input/inpaint_canvas/`). `package.json` 0.1.11 with its CHANGELOG section.

**Closed on 2026-09-13 (after the hand-over above was written):** ComfyUI was started by
the user; `smoke_test.py --no-helpers` PASS (real Flux run 72.5 s, queue empty before and
after) and the node checked in a real ComfyUI tab (extension registered, node created, editor
opened as an overlay with title and close button, no Inpaint Canvas console errors). On the
user's go: px-spike and c0-editor-source merged into the app's main and the node's master
(which fixes the broken node for its users), 0.1.10's CHANGELOG bullets folded into 0.1.11
(0.1.10 was never tagged), tag v0.1.11 pushed. **The workflow builds a draft release; run the
exe gates on its installer (the recipe in the 2026-09-12 second block) and publish the draft
only on the user's go.** The node's `pyproject.toml` version was not bumped, so the Comfy
Registry does not ship the fix yet (that is the user's call too).

**Next**: C1, the `LayerPixels` facade with a canvas backend (`docs/PLAN_BCE.md` §2 C1, its
own release 0.1.12; bump `package.json` and open the CHANGELOG section first).

## Where things stand (2026-09-13)

**The implementation plan for phases B, C and E is `docs/PLAN_BCE.md`** (written 2026-09-13
after reading the code line by line; it wins over `docs/PLAN_TILES.md` where they differ). It
is the file the session that builds the tile engine follows: B0 to B3 (the Rust spike, no
Rust toolchain is installed on this machine yet), C0 (`docs/NEXT_PLAN.md` 4b, the editor
source moves into this repo), C1 (the `LayerPixels` facade with a canvas backend, the one
migration of the 277 sites, its own release), C2 to C7 (tiles, atlas compositor, undo as tile
refs, stroke store, mips in the worker), E1 to E6 (COOP/COEP, the worker pool over a
`SharedArrayBuffer` arena, bands, streamed PNG / PSD / ORA, filters with halos, the 30k gate).
Every decision is in its §4 table; every step names its gate. Phase D is deliberately not in
it. The user's go for B was given on 2026-09-13 ("wir machen dann einen clear und opus wird
den plan umsetzen"); ask once, in one sentence, after B's table before starting C0.

**Phase A of `docs/PLAN_TILES.md` is built**, on the user's "starte den geplanten Umbau, Phase 1"
(2026-09-12 late; the plan's phases are lettered, A is the first): five items, each in the node
repo first (commits 0c3ce45 A1, 009320e A4, 9bf54c0 A3, 5dd1dbb A2, 83887b6 `DEVELOPMENT.md`
§23) and synced, A5 app-only (`electron/main/gpumem.js`, the memory watch, Free VRAM), each with
its gate step (`editor_test.py`: selection undo / bounds, wand and bucket region, stroke
buffers; `composite_test.py`: source windows) and its commit. `docs/PLAN_TILES.md` §7 says what
was built and how it differs from the plan, `docs/PERFORMANCE.md` §9 has the before / after
table, `docs/BUGS.md` the 15k entry updated, `CHANGELOG.md` the 0.1.10 bullets. Gates at the
end: editor, shape, brush, composite, commands, film, glb, ailabel, log all PASS on the dev
instance; `docs/COMMANDS.md` regenerated (the `status` command's memory carries the card).
`smoke_test.py --no-helpers` PASS (a real Flux run, the ComfyUI queue empty before and
after), `npm run dist` built `Scumble Setup 0.1.10.exe`, and the editor, composite, commands,
brush, glb, ailabel and shape gates PASS against `dist/win-unpacked/Scumble.exe` on its own
profile. Both repos are pushed. **The 0.1.10 tag waits for the user's go** (the section in
`CHANGELOG.md` is written).
**Not verified by the user**: nothing of phase A has been tried on their own 15k file; the
first thing to ask for is the card's numbers from Settings › Rendering while it stutters.

**What phase A found, and what the next session should know**: a readback on a GPU canvas
costs whatever is queued before it (0.5 to 1.2 s for 2048² right after a fill), so the wins
came from fewer and smaller readbacks; the film plugin's panel flattened the whole document at
full resolution on every change (fixed, `Document.flatten({ maxSize, box })`); a
`willReadFrequently` canvas is no saving in Chromium 152; `destination-in` and `copy` apply
to the whole canvas, a regional one needs `clip()` first; the benchmark's op rows swing by
hundreds of ms between runs on the shared card, so restart before a run and read the first
one. Per-document memory (2.3 GB layers, 0.95 GB pyramids, 0.57 GB base and selection each
at 15k) is untouched: that is phase C, and the decisions in `docs/PLAN_TILES.md` §6 (1, 3, 4)
are still the user's.

**Traps met on 2026-09-13**: a Bash-tool heredoc turns `\\n` in a Python source into a real
newline (write the script with the Write tool, or use the Edit tool); the test document
`window.__t` of `editor_test.py` is 600 × 300 by the time later steps run (call `new_canvas`
first); Chromium keeps a small canvas in software, so pixels from a buffer that grew onto the
GPU differ from an all-GPU canvas by a few levels; a preview's regional `destination-in`
needs a clip region.

## Where things stand (2026-09-12, evening)

**0.1.9 is released** (tag `v0.1.9`, published 2026-09-12 16:13 UTC, `Scumble-Setup-0.1.9.exe`
plus `latest.yml`, so the apps in the field update themselves). **Before the next change ships:
bump `package.json` to 0.1.10 and open a `## 0.1.10 — unreleased` section in `CHANGELOG.md`.**
Both repos are clean and pushed. What the user owes: the *Help › Console › Copy all* output of a
failed gpt-image run and of a Comfy Cloud run on 0.1.9, and whether *"Base selected."* appears
in the erase bug (`docs/BUGS.md`). What comes next (0.1.10): those two provider fixes, then the
15k document measured (`perf_test.py 15000x10000`, `app:metrics`) before anyone builds tiles.
**Measured on 2026-09-12** (the 15k entry in `docs/BUGS.md`): the frame path is at the screen's rate,
the stutter is memory (4.3 GB VRAM per 15k document, shared with ComfyUI) and whole-document
steps; `docs/PLAN_TILES.md` is the plan (phase A quick wins, phase B Rust spike, phase C tiles),
waiting for the user's decisions listed at its end.
**The user's decision on 2026-09-12 (late): "ja, die Performance muss maximal besser
werden", and then "noch nicht umsetzen, nur planen".** So the plan is approved in principle
and **nothing of it is to be built until the user says go**; phase A (the quick wins) is the
first thing to build when they do, with the notes at the end of `docs/PLAN_TILES.md`. The
only change made: `package.json` is 0.1.10 with an empty `## 0.1.10 — unreleased` section in
`CHANGELOG.md` (the standing rule before any change ships). The four decisions the plan asks
for (VRAM check on the user's machine, phase A, the Rust spike, phase C with `NEXT_PLAN.md`
item 4b) are still open one by one.

**The five steps of `docs/PLAN_0_1_7.md` "Build order after 0.1.8" are built, each with its
gate, its commit and its push** (a to e, in that order, node repo first where the editor
changed, then `tools/sync_editor.py`). Per step:

- **a, Escape closes the Settings and Generate-new dialogs.** One line in the node's
  `_docKey`: a key whose target sits inside `dialog[open]` returns early. Gate
  `escape_closes_the_shell_dialogs` in `tools/editor_test.py` (a synthetic keydown for
  `defaultPrevented`, a real key through CDP `Input.dispatchKeyEvent` for the native close;
  the runner takes Python callables as steps for that). Red on the old code, green after.
- **b, SVG import.** Done in the editor, not the mirror: `isSvgFile` / `svgSize` /
  `rasterizeSvg` (node repo) turn the file into a PNG before the upload; `loadFile(file,
  { size, ask })` asks with the size dialog (prefilled with the declared size, else 2048 on
  the long side, ratio tied by default: `ask()` takes `linked: "on"`), `addImageLayers` fits
  it to the document without asking, `load_image` takes `width` / `height` and never asks.
  `mimeOf` and the Open dialog know `.svg` too. Gate `svg_import_rasterises_on_the_way_in`.
- **c, the EU AI label plugin** `plugins/ailabel/` (`docs/PLUGINS.md` built-in list). The
  twelve Commission SVGs ship with a `NOTICE` (source URL, the verbatim terms: "publicly
  available for everyone to use freely, without the need for attribution"; no named licence;
  **the user approved shipping them on 2026-09-12**). `black` in a file name is the black pill
  with white letters, `white` the white pill with dark letters, `transparent` the pill at
  50 %. Panel, two actions, commands `ailabel.add` / `remove` / `info`; adding again replaces;
  command arguments never change the panel's stored settings. Gate `tools/ailabel_test.py`.
- **d, custom brushes** (`docs/BRUSHES.md`). The reader now parses the `desc` block
  (Photoshop's Action Descriptor, which neither GIMP nor abrupng reads) and maps names and
  spacings to the bitmaps by UUID; verified on Photoshop 2026's three packs and a 377 MB
  third-party pack (every bitmap named, every desc block consumed to its last byte). Tips
  persist through `electron/main/brushes.js` (`<userData>/brushes/`), `host.brushLibrary` is
  shared by every tab. Spacing slider, *Follow stroke*, thumbnail, box cursor, Remove; the
  eraser stamps a tip through the same path. Commands `list_brush_tips` / `set_brush`. Gate
  `tools/brush_test.py` (runs `node tools/brush_test.js` first). The node's `DEVELOPMENT.md`
  §22 has the format notes.
- **e, the GLB layer plugin, stage 1** `plugins/glb/` (`docs/GLB.md`). three.js 0.186
  vendored by `tools/vendor_three.py` (2.3 MB, the npm package has no minified ES build), the
  dialog with the picture as the backdrop, colour pass with alpha cropped to the object,
  depth pass with the near / far planes hugging the object, the file in the local store and
  the parameters in the plugin storage by layer id, *Edit* in place. Commands `glb.place` /
  `edit` / `info`. Gate `tools/glb_test.py` (a cube written as a glTF binary by the test).
  **Found on the way: `scumble.storage.get()` returned a promise**, so no plugin had ever read
  its data back (the film pack's group, the label's settings). `renderer/plugins.js` loads the
  data before `activate` and serves `get()` from a cache now; `set` writes through.

**Provider adapters, corrected by the user on 2026-09-12**: FLUX over BFL, Nano Banana over
Google and Seedream over fal **have run live and work**. OpenAI gpt-image still had problems
on the user's side, and the user reports the OpenAI extras (transparent background) as missing
in their installed version; Comfy Cloud "seems not to work". Details of both failures were
still being collected. Everything in this file that says "no adapter has ever run live" is
older than this note.

**Second block of 2026-09-12 (after the five steps)**, one commit: the installer was built
(`npm run dist`) and **every gate ran against the packaged exe** on its own profile (commands,
ailabel, glb, brush, editor, `mcp_test.py --exe ... --user-data-dir <dir>` in proxy mode 0.8 s,
`smoke_test.py --no-helpers` with a real Flux run): plugins, vendored three.js and brushes work
from the asar. `mcp_test.py` got `--user-data-dir` (the launcher forwards it; it must come
*before* `--cmd`, which otherwise takes it for its JSON) and its raw step closes stdin (an open
stdin kept the relay alive, 180 s timeout). **Comfy Cloud** failures read the node's exception
from the job history (`failureDetail` in `comfycloud.js`, exported for tests; the status endpoint
says only "error", which is what the user saw). **API resolution rows default to 2K** wherever
offered. **Normalise filter** (node repo `colourStats` / `applyNormalize`, app GL mode 7 in
`inpaint_filters_gl.js`, gate step `normalise_filter_moves_colours_to_the_mean_on_both_paths`
in `editor_test.py`, GPU vs CPU max 2 levels). **Export Canvas row** (frame, anchor, fill;
`export` takes `canvas_width` / `canvas_height` / `anchor` / `fill`; step
`export_canvas_frames_the_picture`). Gates after: editor, commands, size, composite PASS,
`docs/COMMANDS.md` regenerated. **0.1.9 is released** (tag `v0.1.9`, the workflow built `Scumble-Setup-0.1.9.exe` plus `latest.yml`, the draft published 2026-09-12 on the user's go; `package.json` needs the bump to 0.1.10 and a new `CHANGELOG.md` section before the next change ships).

**Third block of 2026-09-12: the console and the log file** (plan §3, which the plan had
called done although nothing existed; asked for again after the bare Comfy Cloud "error").
`electron/main/log.js`, IPC `log:*`, `read_log`, the renderer capture at the top of
`shell.js`, `#log-dialog`, `host.hookStatus` (status title, click opens the console, error-
looking status texts logged), provider failures logged with the request's shape in
`providers/index.js`. Gate `tools/log_test.py`. The file is `<userData>/logs/scumble.log`;
when the user reports an error, ask for *Help › Console › Copy all* or that file.

**Fourth block of 2026-09-12, last before the release: edge snapping while scaling.** Asked
for as "wie ein Magnet leicht einrasten" when a layer is dragged to the full picture.
`snapScale()` in the node's editor (synced) runs after `applyScale()` in the unrotated scale
gesture: the dragged edges snap to the canvas edges, its centre and the guides within 8 screen
px by shifting the pointer and re-applying the scale (so a kept aspect stays consistent), Alt
keeps it free, rotated layers are not snapped, the pink guide lines show for scaling too. Gate
step `scale_snaps_to_the_canvas_edges` in `editor_test.py`.

**Also on 2026-09-12**: the GitHub description of `DenRakEiw/scumble` no longer says
"Krita-style" (asked for during the session; changed with `gh repo edit`). The Normalise
filter the user asked about is built (see the second block).

**Traps met today, worth keeping**: a long Python heredoc in the Bash tool failed to parse
with "unexpected EOF" (write the script with the Write tool instead); Chromium fires only
`cancel`, not always `close`, on a `<dialog>` closed by a real Escape; `.ipc-view canvas` is
`position: absolute; width: 100%`, so a canvas placed in the options bar needs inline size
and `position: static`; the layers of a document reach the local store through
`ed.syncLayers()`, which the autosave calls on its own timer, so a test that reloads right
after a change has to call it first.

**Gates at the end of the session**: every gate ran against the packaged exe on its own
profile (`editor`, `commands`, `ailabel`, `brush`, `glb`, `mcp_test.py --exe ... --user-data-dir`,
`smoke_test.py --no-helpers` with a real Flux run) before the release, and `log_test.py`,
`editor_test.py`, `commands_test.py`, `ailabel_test.py` on the dev instance after the last
changes. `docs/COMMANDS.md` regenerated (72 commands, `read_log` is the newest).

## Where things stand (2026-09-11, late)

**Read `docs/BUGS.md` first.** The vanishing layer is fixed (first bullet below). What is
left open there: the erase that "switches to the base" (probably the same bug seen from the
other side, one question to the user still unanswered) and the jerky 15k document.

**0.1.8 is released** (v0.1.8, published 2026-09-11 21:05 UTC, installer 187 MB plus
`latest.yml`, so the apps in the field update themselves): the vanishing-layer fix below,
the marquee click fix and the *Highres fix* rename. 0.1.7 (16:56 UTC the same day) carried
the transparent OpenAI results. `package.json` is **0.1.9** with an unreleased
`CHANGELOG.md` section holding the model folder scan; the tag waits for the user.

**Built on 2026-09-12: the model folder scan** (Settings › Helpers, *Scan folder*; asked for
as "den ComfyUI models folder angeben, scannen, automatisch verknüpfen"). `scanFolder` /
`matchScan` in `electron/main/onnx/models.js` attribute every ONNX file in the folder to a
registry entry by exact name, by the registry's exact byte size (unique sizes only: the four
SAM2 decoders share one) or by the Hugging Face snapshot layout, store the links in
`settings.helpers.links`, and report PyTorch weights per model in `elsewhere`. **On the
user's own ComfyUI folder the honest result is: nothing linkable** (SAM2 and RMBG are there
as `.safetensors` / `.pth`, which ONNX Runtime cannot load), and the row now says so instead
of "not downloaded". `docs/HELPERS.md` "The folder scan". Gate `node tools/scan_test.js`.

**The plan for the sessions after a /clear is `docs/PLAN_0_1_7.md`**, "Build order after
0.1.8": §7 Escape in Settings, the SVG import entry, §8 EU AI label plugin, §6 .abr brushes,
§9 GLB layer plugin. The user wants them built one after the other; each has its gate.

**Fixed after 0.1.7, in 0.1.8:**

- **A whole layer vanished from the screen after an erase nowhere near it** (the two screen
  recordings of 2026-09-11; `docs/PERFORMANCE.md` phase 5 bug 3 has the write-up). Reproduced
  on the first try once the *real pointer handlers* were driven on a zoomed-out view and the
  **screen** was read, not a full-resolution composite: layer alpha 111,000 before and after,
  the composite green, the screen white. `touchSourceRect` refreshed the stroke's rectangle in
  each pyramid level with `globalCompositeOperation = "copy"`, and Chromium applies `copy` to
  the whole canvas, so the level kept only the strip around the stroke; both paths draw from
  that level below 0.5 zoom. Now `clearRect` plus `source-over`. Fixed in the node repo and
  synced (the sync touched only those nine lines); the node's `DEVELOPMENT.md` §21e has the
  rule. Gate: `editor_test.py` step `erase_stroke_keeps_the_rest_of_the_layer_on_screen`,
  which reads white for the far block on the old code. `composite_test.py`, `commands_test.py`
  and `shape_test.py` PASS after the change. It also explains the first recording (erasing
  "took rectangular chunks out": only the last stroke's rectangle of the layer stayed visible)
  and very likely the "erase switches to the base" report.
- **A marquee click left a small selection behind when zoomed out.** Rectangle and ellipse
  had no drag threshold, so a hand that wobbled by one screen pixel drew a rectangle of
  whatever that pixel is worth in image space: on a 15k image about eleven image pixels,
  right under the cursor, instead of the deselect the click was meant to be. Brush and
  eraser are clipped to the selection, so retouch then stopped with nothing on screen to
  explain why. Measured in screen pixels now, `startPx` plus a three pixel threshold.
  Verified against the old path: the same wobble leaves 6000,5000 to 6011,5009 before and
  nothing after. `tools/editor_test.py` has the case; it only ever exercised the click
  *inside* a selection and the lasso, which is why it stayed green.
- **The brush ring never disappears again.** It was a one pixel line in the paint colour, so
  painting red over red left no cursor at all, and a 400 px brush on a small layer looked
  like a tool that fills rectangles. Dark halo underneath now, and it moved into
  `drawBrushRing(ctx, s)` so a test can draw it into its own canvas.
- **The *API size* row is *Highres fix*** and its choices read without a tooltip: Maximum,
  2x crop, 4x crop, Target size, Off (crop size).
- **The prompt templates were never loaded at start.** `host.promptTemplateIds` and
  `refreshPromptTemplates()` sat *inside* `saveCompat()` in `shell.js`, so no template
  appeared until the Settings dialog had been opened once, and "Generate a new image"
  offered none at all.

**Built but not verified: brush tips from Photoshop .abr files.** `js/inpaint_brushes.js`
(node repo, synced) reads the format after GIMP's `gimpbrush-load.c` and scurest/abrupng,
both GPL-3.0: versions 1 and 2 are a flat list, 6 and 10 keep the sampled brushes in an
`8BIM` `samp` block, PackBits per row, computed round tips skipped. The brush stamps a tip
instead of the round dab, with the file's own spacing, and a Tip select plus Import sit next
to the colour in the tool options bar; images work too. **The reader is proven only on a
synthetic version 1 file** (size, spacing, alpha polarity, where the stored value is the
coverage the way GIMP reads it). Nothing has met a real pack or a version 6 file, the
stamping has no gate, and imported tips do not survive a restart.

## Where things stand (2026-09-11)

**A 15k PNG is still jerky to work on** (reported 2026-09-11, the first entry in the new
`docs/BUGS.md`). Not reproduced or measured here, and the PNG-versus-JPEG part of the report
is not confirmed: after decoding, the format cannot matter, so either the encode on the
autosave path or a difference in pixel size explains it. The size is under the compositor's
16,384 limit, so this is **not** the documented Canvas 2D fall-back; the first suspect is the
memory the untiled full-resolution layers hold. The bug entry says what to measure first.


**Transparent results from the OpenAI image models** (2026-09-11, asked for after reading
`developers.openai.com/api/docs/guides/image-prompting`). `background: auto | opaque |
transparent` is an ordinary settings row on the `openai` variant of the three gpt-image
recipes, and the row is the whole switch: `host.supportsTransparency()` looks for it, the
Generate-new dialog shows its checkbox for it, `docs/RECIPES.md` "Transparent results" has
the contract.

- **The stitch is where it matters.** `finishResult()` used to overwrite the answer's alpha
  with the composite mask, which threw a cut-out away. With `info.keepAlpha` (set in
  `host.runProvider` from the run's own parameters) the model's alpha is **multiplied** by
  the blend mask instead: a clean cut-out keeps its edges, a model that ignored the request
  behaves exactly as before, and there is no hard rectangle either way. Colour match is
  skipped for such a run. `transparentPixels()` (a 128x128 grid sample) says in the status
  line whether transparency really came back.
- **The whole OpenAI parameter set** is in the adapter now: `background`, `output_format`,
  `output_compression`, `moderation`, plus `sizeFor(model, w, h)`, which holds a free size
  inside each model's own rules. A transparent JPEG is sent as PNG. **`input_fidelity` was
  being sent to exactly the wrong model**: the docs say to omit it on gpt-image-2 (always
  high fidelity) and it belongs to 1.5 and 1, so the recipe row is gone and the adapter
  gates on the model id.
- **GPT Image 2.5 reaches 3840 px** (was 2048): both edges a multiple of 16, ratio at most
  3:1, total 655,360 to 8,294,400 px. The floor needed a new limit, **`minPixels`**
  (`editLimits()` in `recipes.js`, honoured in `prepareCrop()`), because a small selection
  would otherwise be refused. `text.sizes` for 2.5 is 1024 to 3840.
- **`generate_new` takes `background`**, the dialog has a *transparent background* tick that
  appears only for a variant with the row, and a local recipe refuses it with a clear error.
  For an edit run the MCP path is `set_settings({ background: "transparent" })`.
- **A built-in prompt template `transparent-asset`** writes the cut-out wording (the docs are
  explicit that the parameter alone is not enough), offered for the OpenAI recipes.
- **Fixed on the way**: `host.promptTemplateIds` and `refreshPromptTemplates()` sat *inside*
  `saveCompat()` in `shell.js`, so no template was loaded until the Settings dialog had been
  opened once and the Generate-new dialog offered none. They run at module start now.
- **Gate: `python tools/transparent_test.py`** (8 steps; the first runs the adapter's
  `_sizeFor` / `_common` in plain Node, the rest drive the loopback provider, which answers
  a `background: "transparent"` request with an opaque disc on a transparent ground).
- **Not verified**: no OpenAI key has ever run through this. fal, WaveSpeed and Comfy Cloud
  may pass `background` to the same models and are deliberately **not** wired for it, because
  nothing in their schemas was checked.

**Photoshop and Krita are gone from the descriptive text** (2026-09-11, asked for). README,
the MCP server instructions, the CHANGELOG entries, `docs/BRIEF.md`, `docs/PLAN_0_1_7.md`,
this file, and two editor tooltips (changed in the node repo and synced). **Still there on
purpose**: the code comments in the synced editor files (about 35, they explain why
something behaves the way it does) and the prior-art citations in `docs/PERFORMANCE.md`,
where the names carry the source links.

**Gates after both changes, on a dev instance with its own `--user-data-dir`**:
`transparent_test.py` PASS, `size_test.py` PASS, `generate_test.py` PASS,
`commands_test.py` PASS, `composite_test.py` PASS (gpu vs 2d max 1 level),
`smoke_test.py --no-helpers` PASS (72 s real Flux run, the ComfyUI queue empty before and
after). `docs/COMMANDS.md` regenerated. `package.json` is **0.1.7** and `CHANGELOG.md` has
its `## 0.1.7 — unreleased` section; the tag waits for the user.


**The next five items are planned in `docs/PLAN_0_1_7.md`** (written 2026-09-11 with the user,
in the order to work them): the prompt template upload under the dialog's dropdown, the
`draw_shape` command, a console and a log file, a liquify brush, and Python plugins. Items 1 to 3
are 0.1.7, items 4 and 5 are 0.1.8. That file also carries what stays open after them.

**The "Generate a new image" dialog is fixed** - it no longer grows a scrollbar and no longer
clips the Upsample button. Confirmed by the user on 2026-09-11, off the list.

**0.1.6 is released and both repos are pushed** (`gh release list`: v0.1.6 published
2026-09-11 10:48 UTC, `CHANGELOG.md` has its dated section). `package.json` is still 0.1.6;
the next release needs the version bump and a new `CHANGELOG.md` section first.

**The emitted crop follows the provider, not one global number** (2026-09-11, asked for as
"beste Qualität, das Maximum der Anbieter ausreizen"; `docs/RECIPES.md` "How big the crop goes
out"). Every API run used to send a 1024 px crop because `nodeParams.target_size` governed the
local *and* the API path, while the adapters pass whatever size they are handed straight on.

- A provider variant now carries `limits` (`{ min, max, step, pixels }`, normalised by
  `editLimits()` in `electron/main/recipes.js`, a recipe-level `limits` covering all its
  variants). **FLUX.2 and FLUX.1 Fill are capped at 1440** - the user measured an error at
  2048 - **gpt-image at 2048 with an 8,294,400 px budget** (the OpenAI partner node's own
  rule), **Seedream 5 on fal at 4096 with a 4 MP (pro) / 16 MP (lite) budget** and on Comfy
  Cloud at 2496 / 4992, everything else keeps the conservative default `{256, 2048, 16, 0}`.
  Raise one with a source; most providers' real maxima are still unverified. **fal serves the
  schema without a key** - `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>` -
  and Seedream's turned out to be an *area* budget rather than a side limit, which is what the
  first pass got wrong. A variant may override the recipe's `limits`, which is how the fal and
  Comfy Cloud numbers sit in the same recipe.
- `host.cropLimits()` merges those limits with **`host.apiSize`** (`settings.apiSize`, the
  *Highres fix* select built in `buildGenerateExtras`, app-only, no sync patch): `max` (default),
  `x2`, `x4` (the high-res fix the user asked for: the crop at twice / four times its own
  size, still under the ceiling), `target`, `crop`. `prepareCrop(editor, params, limits)` in
  `renderer/editor/stitch.js` resolves it in `emitTarget()`; **a ComfyUI recipe gets null and
  is untouched**, because there the node crops.
- Gate: **`python tools/size_test.py`** (9 steps, loopback only, no ComfyUI and no key).

**Seven models added** (2026-09-11): `z_image_turbo` (fal `fal-ai/z-image/turbo/inpaint`, a
real **mask** endpoint - only the second one after Qwen and FLUX.1 Fill), `ideogram_4`
(`ideogram/v4/image-to-image`, no mask), `grok_imagine` (`xai/grok-imagine-image/v2.0/edit`),
`reve` (WaveSpeed `reve/2.1/edit`), and three **text-to-image-only** recipes, `krea_2`,
`recraft_v4`, `z_image`. 22 recipes now.

- Ids read from fal's own model index on 2026-09-11 (`https://fal.ai/api/models?keywords=x`
  lists endpoint ids, `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>` gives
  the input schema - **use those two URLs, they answer without a key**). Reve came from
  `wavespeed.ai/models/reve`; its input field names are WaveSpeed's edit convention and are
  **not** verified.
- New variant flag **`edit: false`**: the variant has only a `text` shape, and
  `host.runProvider` refuses with "use Generate new, not Generate". Two small fal adapter
  switches came with it: `fields.mask = false` (an image-to-image endpoint without a mask,
  Ideogram 4) and `options.omit` (fields a strict endpoint refuses; Recraft V4 takes neither
  a seed nor an output format).
- Ideogram 4, Krea 2 and Recraft V4 have **no masked edit endpoint at all** on fal; Ideogram
  is wired as a whole-crop image-to-image with a Strength slider and the stitch keeps the
  selection.

**Gates after the change, all on a dev instance with its own `--user-data-dir`**:
`size_test.py` PASS, `commands_test.py` PASS, `generate_test.py` PASS, `smoke_test.py
--no-helpers` PASS (real Flux run, the ComfyUI queue empty before and after). The *Highres fix*
row was checked live in the Generate section. **Not done**: no adapter has run against a live
API, and the size ceilings of Nano Banana, Seedream, Qwen and the new models are the
conservative default rather than the providers' own numbers.

**A shape tool** (2026-09-11, after comparing our tool column with other editors'): rectangle,
ellipse, polygon, polyline, Bezier and freehand, filled and/or outlined, key **Y** (U belongs to
the film plugin's control points). Written **in the node repo** and brought over with
`python tools/sync_editor.py`, so it is not a patch and the node has it too; the sync round trip
touched only `inpaint_canvas.js`. Rectangle / ellipse / freehand reuse the `layerpaint` pointer
with a stroke buffer that `shapeDab()` redraws on every move, which is where the live preview,
the clip to the selection, the brush opacity and the undo step come from; polygon / polyline /
Bezier collect `shapePoints` and draw as an overlay until `finishShape()`. `paintShape()` sets a
transform from image to layer pixels, so the outline width is in image pixels whatever the
layer's own resolution is. Gate: **`python tools/shape_test.py`** (12 steps, reads the pixels
back). **Not built**: shapes are pixels, not editable objects, and there is no `draw_shape`
command for MCP yet.

**The transform tool already has Distort and Warp** - I claimed otherwise on 2026-09-11 and was
wrong. `subModeButtons` in the node's editor has scale, rotate, distort (drag the four corners,
a perspective) and warp (a grid). Only a liquify brush is missing.

**Export can save smaller** (2026-09-11, asked for with a screenshot of another editor's Export As):
a Size row under the editor's Export row takes a percentage or a free width and height, and
JPEG / WebP got a Quality row under it. `host.exportCanvas(editor, fmt)` and
`host.exportQuality(editor)` are two new sync patches in `exportImage()` (the third change,
the status line naming the written size, was folded into the existing `saveExport` patch -
**patches must not overlap another patch's replacement text**). Everything else is app-side in
`host.js`: the per-document state, the row, and `resizeForExport`, which walks a big reduction
down in halving steps because one bilinear draw skips pixels below half size. PSD and ORA stay
full size (their layers would each have to be scaled) and the row disables itself for them. The
`export` command takes `scale`, `width`, `height`, `quality` and restores the document's own
setting afterwards; `commands_test.py` has the step, `docs/COMMANDS.md` is regenerated.
**Not built**: canvas size (the working area around the image), 8-bit PNG, and a resampling choice.

**A console / log panel is on the list and not built** (asked 2026-09-11 after a Comfy Cloud
run with gpt-image failed): an error only reaches `editor.setStatus()`, `.ipc-status` clips it
with an ellipsis and has no `title`, the full text lives only in the renderer DevTools console,
and the main process - where the adapters run - logs nowhere.

## Where things stood (2026-09-10)

**Release 0.1.5 is prepared but not tagged** (2026-09-10, night). `package.json` is 0.1.5 and
`CHANGELOG.md` has a 0.1.5 section with the two items below. The tag waits for the user's
go-ahead: `git tag v0.1.5 && git push --tags`, then `gh release edit v0.1.5 --draft=false`.

**0.1.4 was already released** (tag `v0.1.4`, published 2026-09-10 12:26 UTC with the
installer and `latest.yml`, so the apps in the field are on it). The paragraph in this file
that called it "prepared but not tagged" was stale, and following it cost a detour: the
0.1.4 section was folded into 0.1.5 and had to be put back. **Check `gh release list` before
believing a release note here.**

**`docs/NEXT_PLAN.md` items 1 and 2 are done, 3 was already done, 4 is untouched.** The file
stays as written: it is the record of the two decisions in item 4 (blur as a shader pass,
recommendation *not now*; the editor source moving into this repo, recommendation *yes, after
0.1.5*). Neither is to be built without the user's yes.

- **Item 1, the MCP handshake** (`electron/main/mcp/launch.js`, `docs/MCP.md` "Why the
  launcher exists"). Electron writes a CR LF to stdout before any of our JavaScript runs and
  it cannot be suppressed from the app; the Python `mcp` client kills the whole session over
  it. The launcher is a plain Node script the same executable runs in Node mode
  (`ELECTRON_RUN_AS_NODE=1`, which prints nothing and can read the packaged asar): it spawns
  the app as a child with that variable removed, relays stdin, and drops the **leading** run
  of CR / LF / space bytes from the child's stdout before passing everything else through
  untouched. `.mcp.json`, `tools/mcp_test.py` and the docs register the launcher;
  `Scumble --mcp` still works directly for tolerant clients and for scripts. **Help > Copy
  MCP registration** (two entries, `mcpRegistration()` in `main.js`) puts the `claude mcp
  add` line or the Claude Desktop JSON with the real install paths on the clipboard, because
  nobody types an asar path by hand; the renderer answers with a status line
  (`menu` command `mcp-copied`).
- **Item 2, prompt upsampling on a local OpenAI-compatible server** (`askCompatible` in
  `electron/main/llm.js`, `docs/HELPERS.md`). `settings.llm.compat = { url, model }` plus an
  optional key under the secret name `compat`; the entry appears as `compat:<model>` in
  `llm.list()` and as `app:compat:<model>` in the editor's upsample select as soon as both
  fields are filled. The URL may end in `/v1` or not. IPC `llm:models` (`GET <base>/models`)
  feeds the *Test* button and a `<datalist>` on the model field. A **text-only model gets one
  retry without the image** (a 4xx, or an error naming images / vision) and `ask()` returns
  `note: "text only"`, which `host.upsampleInApp` appends to the status line. `<think>` blocks
  are stripped, the timeout is 120 s, a refused connection reads "No server at &lt;url&gt;".
  Settings › Local / OpenAI-compatible endpoint holds URL, model, key and Test;
  `providers/compat.js` is a key-row-only entry kept **out** of `describeAll()` so the row is
  not shown twice. **No real Ollama / LM Studio has been tried**: the gate is
  `tools/llm_test.py` against `tools/llm_mock.py`.

- **"Generate new", a base image from the prompt alone** (asked for during the bug hunt,
  because on an API provider the blank canvas was being uploaded as the image to edit). A
  button in the editor's top bar opens a shell dialog (`openGenerateNew` in `shell.js`,
  app-only): local or API, the model, the prompt with the upsample backends beside it,
  aspect ratio and long side or a free width and height, and the seed. It all runs through
  one command, `generate_new`, so the MCP tool and the test take the same path. **Local**
  renders a flat canvas of the wanted size through the recipe and flattens the result into
  the base; the Flux.2 Klein chain starts its sampler from an empty latent, so the flat
  input carries nothing (measured: the same seed with fill "neutral" and with no fill gives
  near-identical pictures). **API** goes through `host.runGenerate` with `kind: "text"`, no
  crop, no mask, no references, and `editor.setBaseFromCanvas()` puts the answer in.
  Recipes did not have to be edited: `normalize()` in `recipes.js` derives every variant's
  `text` shape (fal and WaveSpeed lose a trailing `/edit`, the others keep the id), and a
  variant can override it or set `text: false`. Comfy Cloud has no text path and says so.
  `providers/loopback.js` writes a real PNG of the asked-for size with zlib, which is what
  makes `tools/generate_test.py` a gate without any key.

- **Prompt instruction templates** (`electron/main/prompts.js`, `prompts/*.md`,
  `docs/PROMPTS.md`), asked for as "a skill .md upload". Deliberately *not* an agent: one
  call, one instruction, no tools. A Markdown file with a front matter (`name`,
  `description`, `use`, optional `for`) and a body with `{prompt}` `{model}` `{aspect}`
  `{region}` `{hint}` placeholders; four built in, the user's own in `<userData>/prompts/`
  override a built-in of the same id. `host.fillPromptTemplate()` always appends the app's
  output rule, so a careless template still yields a prompt. The editor asks
  `host.upsampleInstruction(ctx)` and falls back to `builtInUpsampleInstruction()`, which is
  the only thing the node repo needed for it.
- **The size list per model**: `TEXT_SIZES` in `recipes.js` (Gemini 1024 / 2048 / 4096 for
  its 1K / 2K / 4K classes, OpenAI 1024 / 1536, the rest a free ladder to 4096), carried in
  the variant's `text.sizes` and shown in the dialog. `gemini.js` turns the requested pixels
  into `imageConfig.imageSize`. The list never depended on whether a key was stored, which
  was the user's first guess when 2048 was the maximum for everything.

**Gates for 0.1.5, all on one fresh dev instance on 2026-09-10** (the user closed their own
Scumble first; both share the single-instance lock and the named pipe):
`mcp_test.py` PASS in all three modes — proxy 0.8 s, headless 2.5 s, `--exe
dist/win-unpacked/Scumble.exe` 2.6 s — plus its new `raw` step, which spawns the launcher
with `--cmd ping` and asserts the first stdout byte is `{`. `mcp_test.py --direct` is the
documented FAIL (`b'\r\n{'`) and is deliberately not part of the gate. `llm_test.py` PASS
(listed, vision sees the crop, the text-only model triggers exactly one retry without the
image, the offline error names the URL, settings restored), `commands_test.py` PASS,
`composite_test.py` PASS (gpu vs 2d max 1 level), `film_test.py` PASS (35 cases, worst 3),
`smoke_test.py --no-helpers` PASS (19 s Flux run, the ComfyUI queue was empty before and
after). The settings row and the two Help entries were exercised live: the *Test* button
filled the datalist from the mock ("2 models: mock-vision, mock-text") and the menu handlers
put the right lines on the clipboard (checked through the main-process inspector,
`electron . --inspect=9556`, `Menu.getApplicationMenu()`). `docs/COMMANDS.md` regenerated.

**Not verified here**: `claude mcp add` with the copied line, because the `claude` CLI is not
on this machine's PATH. The Python client is the stricter of the two, and it passes.

**Phase 6 (memory) is done** — `docs/PERFORMANCE.md` "Phase 6" has the measurement, the
node's `DEVELOPMENT.md` §21f the rules, `docs/PHASE6_PLAN.md` the plan it was worked
through. The symptom (a session got slower the more large documents it had seen) was
**not** in the drawing code: every closed document stayed reachable through one event
listener, and with it its whole layer stack.

- **The leak**: a plugin panel's `build` closes over that tab's `Document`, and the
  listeners it registered were never removed. Both bundled plugins do it. Four 96 MP
  documents built and closed left **301 canvases holding 18.8 GB** alive and the GPU
  process at 19 GB; a pan frame cost 47 ms instead of 4. Found with a heap snapshot
  (`HeapProfiler.takeHeapSnapshot` through CDP, then the shortest path from the GC root) —
  the canvas census says *what* survived, only the retaining path says *why*. Take the
  snapshot early next time.
- **The fix** is in `renderer/plugins.js`: listeners registered while a panel is being
  built belong to that panel instance (`buildScope`, a module variable because both
  plugins keep the `scumble` from `activate()` instead of the one `build()` is handed),
  and `host.on("removed")` unmounts the panel, runs its `destroy`, and clears `reg.els` /
  `reg.buttons` (Maps keyed by the editor). `docs/PLUGINS.md` says so for plugin authors.
- **After**: the same four rounds end at 7 canvases / 34 MB, pan 3.6 → 4.1 ms, levels tick
  9.0 → 10.0 ms, renderer 97 MB.
- **Instrumentation that stays**: IPC `app:metrics` (`main.js` + `preload.js`,
  `app.getAppMetrics()` plus the renderer's own numbers — the bytes are in the **GPU
  process**), `ed.memoryReport()`, `GLCompositor.stats()`, `glPoolStats()`, and
  `tools/mem_test.py`. Do not reach for `performance.measureUserAgentSpecificMemory()`:
  `scumble://` is not cross-origin isolated, so it has always returned null.
- **Smaller, measured, not the cause**: the compositor loses its GL context in `dispose()`
  and its texture cache is bounded in bytes (1 GB) instead of by a count of 48;
  `ed.releaseCaches({ deep })` gives caches back and returns the bytes; **Free VRAM** calls
  it and says how much; `renderer/shell.js` `watchMemory` releases the caches of background
  tabs every 30 s above `settings.memory.gpuLimitMB` (default 3072, row in Settings ›
  Rendering, 0 = off); the `status` command reports `memory: { gpuMB, rendererMB }`.
- **What is left and is not a leak**: after four 96 MP documents the GPU process sits about
  1.3 GB above its start, flat across rounds — `releaseCaches({ deep: true })` brings it to
  +58 MB, so it is memory the GL path holds for reuse. And four 96 MP documents *open at
  once* really are 19 GB of live pixels: 40 ms a frame, which is what the memory watch is
  for. `dropCanvas`, undo tiles and layer eviction were **not** built and are not needed.
- **Gates, all on fresh instances**: `composite_test.py`, `commands_test.py`,
  `film_test.py`, `perf_test.py` at 2048x1152 / 6000x4000 / 12000x8000 and
  `perf_test.py --chain 6000x4000` (both within noise of the recorded numbers),
  `smoke_test.py --no-helpers` (real Flux run), `mem_test.py` in both variants.
- **`tools/mcp_test.py` failed here, and it was not phase 6**: the installed 0.1.3 failed
  the same way. Fixed in 0.1.5 by the launcher (see the head of this section).

**Three bugs fixed on 2026-09-10 (after 0.1.3), all reported by the user, two of them
regressions of the GPU compositor** (`docs/PERFORMANCE.md`, "Phase 5, the two bugs the
compositor shipped with"; the node's `DEVELOPMENT.md` §21e has the two new rules). Gates on
the dev instance after the fix: `composite_test.py`, `commands_test.py`, `film_test.py`,
`smoke_test.py --no-helpers` (real Flux run), `perf_test.py` unchanged within noise.

- **A brush stroke or an erase did not reach the screen.** `touchSourceRect` refreshes the
  pyramid levels inside a rectangle and deliberately left `_dispVer` alone; the compositor
  keys its texture cache on that number, so it kept drawing the texture from before the
  stroke. The pixels were never lost (exports and runs were correct), the screen showed the
  old ones. The rect touch now raises the version, carries the pyramid entry to it and
  raises the version of every level it redrew.
- **Colour match did nothing.** Its statistics come from what is under the layer, which
  Canvas 2D reads off the target it has drawn into; a GPU pass clears that target first, so
  `matchStats` found no samples and returned null. `glViewComposite` now passes a thunk
  (`glMatchBackdrop`) that composites the stack below the layer, resolved only on a cache
  miss: pan 0.1 ms unchanged, a slider tick 4.3 ms against 3.4 ms on Canvas 2D at 24 MP.
- **A reference layer lost the mask row** (RMBG cutout, mask from selection, edit / apply /
  remove) because references are drawn by `renderReferences`. The row is `buildMaskRow()`
  now and the selected reference gets it; a cut-out reference uploads its masked pixels,
  which the run path already supported.
- **Why the gate missed both compositor bugs, and what it does now**: `composite_test.py`
  drew the Canvas 2D shot first and the GPU shot re-used its cached match canvas, so the two
  paths shared one cache, and nothing in the test ever changed pixels through a rectangle
  touch. The gpu-vs-2d step drops the match statistics before every shot and erases into a
  paint layer first. Verified by reverting the fix: 174 levels on 51,300 pixels, FAIL.

**Landed on 2026-09-10 (night): high-res performance phases 1 to 4** (pushed in both repos;
`commands_test.py`, `film_test.py`, `smoke_test.py --no-helpers`, `mcp_test.py` PASS, the
new `tools/perf_test.py` is the benchmark). `docs/PERFORMANCE.md` §1b and the phase
sections have the details and the numbers, the node's `DEVELOPMENT.md` §21 to §21d the
mechanisms. In short:

- **Phase 1**: a display pyramid per source canvas, the screen composites only the visible
  region at screen resolution (`viewPass`), the composited scene is cached behind a
  signature so overlays cost nothing, brush undo is a copy of the touched rectangle and
  every other snapshot encodes off the main thread, the selection's box comes from hints.
- **Phase 2**: colour match as a shader pass, the grain field is one cached tile anchored at
  the image origin, dabs refresh the display levels in place, renders above the drawing
  buffer go through an off-screen texture.
- **Phase 3**: `js/inpaint_worker.js`, a module worker both hosts serve from next to the
  editor, takes PNG encoding, the upload hashes and the PSD / ORA writers.
- **Phase 4**: grow, shrink, feather, invert, the magic wand and the bucket run in the
  worker and hand back the new bounds; grow only touches the band around the selection.

Interactive gestures on a **96 MP** document are 0.1–8 ms (they were 250–900 ms at 66 MP),
a full export with a three-filter film stack 0.7 s, and the discrete operations that used
to freeze the window for 1–4 s now hold it for 100–400 ms. Deliberately left for later: the
ping-pong texture chain between filter layers, the selection as a typed array, layer tiles.

**Releases**: 0.1.2 carries the phases 1–4 and the large-image fix, 0.1.3 adds the GPU
compositor. Both are published on GitHub Releases, so the installed app updates itself.

- **Fix, the New button did nothing in the app**: Electron has no `window.prompt` (it
  throws "prompt() is not supported"), so the size question never appeared. The editor has
  its own small modal now (`InpaintEditor.ask({title, message, value})`, `.ipc-ask` styles,
  `askOpen` guard in the window key handler); `window.confirm` does work in Electron.
- **Fix, images above 64 MB could not be loaded** (reported 2026-09-10, app only, not a
  side effect of the performance work): `uploadBlob` sends files over `LARGE_UPLOAD`
  (64 MB, a 10k photo easily) through the node's streaming route
  `/inpaint_canvas/upload`, and `main.js` only knew `/upload/image` and `/view`, so that
  route went to `comfy.proxy` and the file never reached the local mirror. With ComfyUI
  down the upload answered 502; with a stale connection state the upload went to the
  server but the following `/comfy/view` found nothing, and the image silently never
  appeared. `mirror.handleRawUpload()` now serves the route like every other upload
  (query params in, raw body, `{name, subfolder, type, size}` back), and `pushToServer`
  picks the streaming route above 64 MB or after a 413, which also fixes `ensureOnServer`
  for runs with large layers. Regression step `large_upload_route` in
  `tools/commands_test.py` (it uploads twice and watches the mirror grow, so it fails on
  the bug even when ComfyUI is connected; verified by reverting the fix).

**Phase 6 is finished** (see the top of this section). Its plan, `docs/PHASE6_PLAN.md`, is
kept as written: the six hypotheses it ranked are ticked off in `docs/PERFORMANCE.md`, and
the measurement overturned most of them. What the performance work leaves open on purpose:
layer tiles above 16384 px on a side (the compositor returns null there and Canvas 2D takes
over), the full-resolution GPU path, and a blur as a shader pass, which is a decision about
the film pack's output and belongs to the user.

**Phase 5 has its second step** (2026-09-10): the filter chain stays on the GPU
(`docs/PERFORMANCE.md`, phase 5 step 2). Measured first, as asked: a round trip
canvas -> texture -> canvas costs **0.6 to 1.0 ms whatever the size** (it synchronises the
2D canvas with the WebGL context at both ends, it is not pixel work), a ping-pong prototype
ran five passes in 0.1 ms, and a film stack paid seven round trips per frame. So
`inpaint_filters_gl.js` grew render targets: a `GLSurface` is an RGBA8 texture with a
framebuffer, `info.chain` makes a pass write into one and read one, `u_dstTop` keeps every
texture top down so nothing downstream notices, `beginScope()` / `endScope(keep)` pool them
and `glChainStats()` counts the round trips. Two users: the stages inside one filter (a
plugin declares `chain: true` and resolves with `scumble.gl.toCanvas()` where it really
reads pixels - the film pack does that in `common.js`) and consecutive filter layers
(`drawLayersInto` carries the chain, `flushFilterChain` puts it down, `applyFilterLayer`
keeps it only when the layer covers its input one to one).

- **The pixels do not change.** A result that goes onto the canvas is still drawn over the
  composite in the old order, and the chain is flushed underneath it first, so only the
  *upload of the next filter's input* is saved. `tools/composite_test.py` has a new step
  that renders the same stack with the chain on and off in one run, including a layer with
  opacity + blend and a masked one: **identical, 0 levels**, view and full resolution.
- **What it bought** (`python tools/perf_test.py --chain 6000x4000`, pan, median ms):
  five filter layers 2.9 -> 1.5, three 1.8 -> 1.4, film look alone 3.4 -> 2.7, one filter
  layer unchanged. An extra filter layer costs 0.6 ms before and 0.15 ms after. Round trips
  for the film stack: 14 per frame -> 5.
- **What it did not buy, and why**: the full film stack stayed at 5.5 ms. What is left in
  it is the two **Canvas 2D blurs** inside halation (`ctx.filter = blur(σ)`): the chain has
  to touch down there and wait. The next lever for that stack is a blur as a shader pass -
  **not built**, because it changes the look of every blur-based film filter (Skia's box
  blurs against a gaussian) and `film_test.py` compares the two paths against each other,
  not against a picture. That is a decision about the film pack's output, for the user.
- **`CHAIN_MAX_PIXELS` is 10 MP.** Measured on the full-resolution composite: up to 8 MP the
  chain is about twice as fast, at 12 MP even, at 16 MP and above clearly slower (the
  surfaces stop fitting the 320 MB pool, so textures are created and destroyed per frame).
  A screen pass is 2 to 8 MP, so exports, runs and thumbnails keep the path they had.
  `ed.filterChainOff = true` switches the chain off at run time.
- Gates on the dev instance: `composite_test.py`, `film_test.py` (35 cases, worst 3),
  `commands_test.py`, `smoke_test.py --no-helpers` (real Flux run) all PASS; the ordinary
  `perf_test.py` is unchanged within noise at 2.4 / 24 / 96 MP. The editor changes are sync
  patches (`tools/sync_editor.py`, round trip verified), the node repo is untouched: the GL
  filter module is still app-only and the chain goes back with it.
- Watch out when measuring: after several large documents in one page the GL path degrades
  badly (a `levels` filter that costs 0.8 ms cold-clean measured 12 ms after four 96 MP
  documents had been built and closed). Restart the app between benchmark runs, or the
  numbers are nonsense. That is phase 6 (memory) territory.

**Phase 5 has its first step** (2026-09-10): `js/inpaint_compositor.js` stacks the visible
region on the GPU, one shader pass per layer, sources cached as textures by the version
`touchSource` bumps. It agrees with Canvas 2D to **1 level over 1.5 million pixels** in the
editor; the nine blend modes follow the W3C spec and were checked over every colour and
alpha combination (2.3 levels premultiplied). `glCompositeUsable()` falls back to Canvas 2D
for filter layers, a running stroke, a transform, compare, peek, exports and runs.
`python tools/composite_test.py` is the gate: it draws the same view both ways in one run
and compares, plus two stored references (`tools/refs/`).

**The measurement is sobering and worth reading before continuing** (`docs/PERFORMANCE.md`,
phase 5): median frame cost is the same on both paths (0.1 ms), because phases 1 and 2
already removed what phase 5 was written to remove. The compositor's win is the worst case,
9.8 ms to 0.2 ms at a large window with 15 layers. So judge the remaining steps by
measurement, not by the plan's estimate: the filter chain on the GPU (ping-pong textures,
no canvas round trip per filter layer per frame) is the one still worth doing; layer tiles
matter only above 16384 px on a side (the compositor returns null there today and Canvas 2D
takes over); the full-resolution path only if a measurement asks for it. Then phase 6
(memory: undo as compressed tiles, the objects map bounded, layers evicted to the mirror).

**Landed on 2026-09-10** (tested on the dev instance: `commands_test.py` PASS, the
preset row and the mode switch exercised through CDP, the three LLM adapters up to the
providers' "invalid key" answers with dummy keys; not committed as a release yet):

- **Old models removed**: `recipes/nano_banana.json` (gemini-2.5-flash-image) and
  `recipes/gpt_image_1_5.json`; `openai.js` sends `input_fidelity` only for gpt-image-2,
  `gemini.js` falls back to `gemini-3.1-flash-lite-image`. 15 model recipes remain.
- **Prompt upsampling through the provider keys** (`electron/main/llm.js`, IPC
  `llm:list` / `llm:ask`, `docs/HELPERS.md`): GPT-5.6 Luna / Terra (OpenAI Responses
  API), Gemini 3.8 Flash / 3.5 Flash Lite, Claude Opus 5 / Haiku 4.5 (new key row
  `providers/anthropic.js`, key only). They appear in the editor's upsample select after
  the ComfyUI nodes once the key is stored (`host.upsampleBackends()`, refreshed by
  `host.refreshLLMs()` after a key is saved or cleared). `upsample_prompt` and "select by
  text from the prompt" use them too. Model ids checked on 2026-09-09 (OpenAI
  `developers.openai.com/api/docs/models`, Google `ai.google.dev/gemini-api/docs/models`).
  Not yet: a generic OpenAI-compatible endpoint (Ollama / LM Studio / OpenRouter) with
  its own URL + model fields, which would give a free local upsampler without ComfyUI.
- **The local / api select switches recipes**: the recipe select shows only the recipes
  of the current mode, the editor's select switches the group and picks the recipe last
  used there (`settings.recipeByMode`, `host.onModeChanged` in `shell.js`). Before, the
  select changed the mode while the recipe stayed, so "api" still showed the local list.
- **Setting presets** for ComfyUI recipes (`host.renderPresets`, `settings.recipePresets`,
  `docs/RECIPES.md`): a Preset row at the top of the Settings section saves the model /
  text encoder / VAE combination (every `*_name` file combo) under a name; Save turns the
  select into a name field (Enter / Escape), `(custom)` while nothing matches.
- **High-res performance plan** in `docs/PERFORMANCE.md` (measurements, pipeline map, Chromium
  limits, six phases: pyramid + viewport composite, GPU match / filter chain, worker, dirty
  rects, WebGL2 compositor, memory). Decided with the user on 2026-09-10; phase 1 is next.
  Also fixed: a filter layer is renamed on every type change (node repo, uncommitted there).
- The sync brought the node's new large-upload path along (`uploadCanvas` uses
  `/inpaint_canvas/upload` above 64 MB or on a 413), untested in the app.

## Where things stood (2026-09-09, late)

**Release 0.1.1 (2026-09-09, night)**: the night's work below is tested in the app and
released. `package.json` is 0.1.1, tag `v0.1.1` pushed, the workflow builds the installer
and opens a draft release; **publishing the draft is still a manual step**
(`gh release edit v0.1.1 --draft=false`), only then does the user's desktop app see the
update. Tests run on the dev instance: `film_test.py` PASS (35 cases, worst 3 levels),
`commands_test.py` PASS (twice, before and after the shell.js fix), `smoke_test.py
--no-helpers` PASS (96 s Flux run + loopback provider).

- **Fix, stale key state**: the provider select in Settings › Recipes kept its "(no key)"
  option labels after a key was saved or cleared (`syncRecipeRows` only refreshed the meta
  line and the selected value). New `providerOptionLabel(pid)` in `renderer/shell.js`,
  called both when the options are built and in `syncRecipeRows`. Verified live: with a
  dummy WaveSpeed key all 16 rows switched from "WaveSpeedAI (no key)" to "WaveSpeedAI"
  without reopening the dialog (the dummy key was cleared again, `secrets.json` is empty —
  the user has no provider key stored at all, which is why every row reads "no key").
- **Large-image filter verified in the app**: synthetic 10864 × 6062 image (grid every
  256 px, coloured corner markers), film look Portra 400 with grain and halation off,
  3.9 s. Against the same look on the image downscaled to 1358 × 757 the tiled result
  differs by 0.38 levels mean / 16 max (resampling only), corners in the right places.

**Landed on 2026-09-09 (night):**

- **Bug fix, large images**: Chromium caps the WebGL drawing buffer at about 33 MP (5760²
  on the RTX 5090, whatever MAX_VIEWPORT_DIMS says) and keeps the canvas size, so a filter on
  a 10864 × 6062 image showed only its lower-left corner stretched to full size (film look,
  grain, every GL filter). `renderer/editor/inpaint_filters_gl.js` now checks
  `drawingBufferWidth/Height` and renders in tiles (`renderTiled`, uniform `u_tile` shifts
  `gl_FragCoord`); the 64 MP area limit is gone, only the 16384 px side limit remains.
  Verified on a standalone page (scratchpad `tiletest.html` importing the module; invert and
  a plugin shader at 2000 × 1000, 10864 × 6062, 12000 × 8000 all exact, 100–200 ms), and in
  the app on a 10864 × 6062 image (see the release note above).
- **Providers**: LetzAI and OpenRouter removed (adapters, recipe variants, docs). New
  `providers/wavespeed.js` (WaveSpeedAI, `POST /api/v3/<model>`, poll
  `predictions/<id>/result`, URL-only inputs so crop / mask / refs go through
  `media/uploads`; keyUrl is the user's referral link `https://wavespeed.ai/?ref=dennisi6`,
  WaveSpeed pays 10 % on a referred user's first 30 days) with variants in all 16 model
  recipes, and `providers/comfycloud.js` (Comfy Cloud v1 API, builds LoadImage → Partner
  Node → SaveImage, node class names and dotted dynamic-input keys read from the local
  ComfyUI 0.35 `comfy_api_nodes/`; needs a paid plan) with variants in 14 recipes (no
  FLUX.2 flex / klein partner node). The user applied to the Comfy.org affiliate program
  (30 % recurring for 3 months on subscriptions); once the link exists, put it into
  `comfycloud.js` `keyUrl`. **Neither adapter has run against the live API.** Research
  notes: Segmind pays up to 30 % for 12 months but lacks FLUX.2 / Nano Banana 2; fal and
  Replicate only have unverified third-party listings; OpenAI, Google, BFL have nothing.

**Phase 5 has its first half**: the repo is public, GPL-3.0, release 0.1.0 is on GitHub
(unsigned), auto-update works end to end (a 0.0.9 build found, downloaded and installed
0.1.0 from the release). Phases 1–4c and 5a are in. What is still open in phase 5, decided
with the user on 2026-09-09:

- **Code signing**: apply at the SignPath Foundation (`signpath.org/terms`) once the project
  has some visible use; needs a "code signing policy" page in the repo (roles: committers,
  reviewers, approvers), MFA on the GitHub account and the SignPath GitHub Actions step in
  `build.yml`. Fallback Certum Open Source (about 70 EUR first year, smartcard). No paid
  Microsoft signing (user's decision).
- **Linux** AppImage/deb: `npm run dist:linux` and an `ubuntu-latest` job in `build.yml`,
  then a real test (`local.js` unix socket, ONNX CUDA/CPU providers, icons). About a day.
- **macOS** only with an Apple Developer account (99 USD/year for Developer ID + notarization;
  no free path, Gatekeeper blocks unsigned apps hard since Sequoia). Not planned.
- **Android**: not sensible (Electron + Node main process: sharp exports, ONNX, named pipes,
  MCP). Tablets can use the ComfyUI node in the browser instead.
- Still open from before: the first real RunPod pod (`docker/runpod/`), the seven API provider
  adapters against live APIs (no keys yet; the user applied for fal / OpenAI OSS credits on
  2026-09-09), film pack follow-ups (`docs/BRIEF.md` §3), a Claude Code / Claude Desktop
  session that drives Scumble through `--mcp`, a website.

Landed on 2026-09-09 (evening, after the release):

- **Model recipes**: a provider recipe is one model with a variant per provider
  (`providers: { gemini | openai | bfl | fal | replicate | wavespeed | comfycloud: { model,
  input, fields, fixed, settings, options, note } }`, `default` = home provider, `family`
  groups the lists). Settings › Recipes shows a provider select per row (choice in
  `settings.recipeProviders`), `select_recipe(id, provider)`, `list_recipes` lists
  `providers`. `electron/main/recipes.js` `normalize()` turns the old one-provider shape
  (and the smoke test's loopback) into the new one; `shell.js` `resolveRecipe()` merges the
  chosen variant into what host and commands see. 17 model recipes: Nano Banana 2 / 2 Lite
  / Pro / 1, GPT Image 2.5 Flare / Sunburst / 2 / 1.5, FLUX.2 max / pro / flex / klein,
  FLUX.1 Fill, Seedream 5 Lite / Pro, Qwen Image Edit, LetzAI inpainting
  (`tools`-less: the generator script lived in the session scratchpad, edit the JSON
  files directly). Removed gpt-image-1 and gpt-image-1-mini.
- **New adapters**: `providers/openrouter.js` (unified image API `POST /api/v1/images`,
  `input_references`, `b64_json` back, no mask: handled like Gemini) and
  `providers/letz.js` (`POST /user-assets` → PUT upload → `POST /image-edits` mode `in`
  with the base64 mask, poll `/image-edits/<id>`, `imageVersions.original`). fal adapter:
  `fields` (`image` / `images` / `mask` names) and `options.sizing = "none"`; OpenAI adapter:
  gpt-image-2.5-flare / -sunburst (quality xhigh / max), `input_fidelity` only for 1.x / 2.
  **None of the seven adapters has run against a live API yet.** Replicate input names
  for the new models (`input_images` for FLUX.2, `image_input` for Nano Banana / Seedream)
  are the best reading of third-party docs, replicate.com blocked the schema pages.
- Model ids checked on 2026-09-09: Google `gemini-3.1-flash-image`,
  `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`; OpenAI
  `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` (released 2026-09-08), `gpt-image-2`; fal `fal-ai/nano-banana-2/edit`, `fal-ai/flux-2-max/edit`,
  `fal-ai/bytedance/seedream/v5/lite/edit`, `bytedance/seedream/v5/pro/edit` (no `fal-ai/`
  prefix), `openai/gpt-image-2/edit`; OpenRouter slugs from
  `GET https://openrouter.ai/api/v1/images/models` (public, no key), e.g.
  `black-forest-labs/flux.2-max`, `bytedance-seed/seedream-5-0-lite`.

Landed on 2026-09-09 (phase 5a):

- **Auto-update** `electron/main/updater.js` (`electron-updater` 6.8, MIT): GitHub Releases
  feed from `build.publish` in `package.json` (electron-builder writes
  `resources/app-update.yml` into the NSIS build only, **not** into `--dir` builds), check
  8 s after start in the windowed packaged app (never headless / agent-started / dev),
  background download, `autoInstallOnAppQuit`, `quitAndInstall(silent, run after)`.
  Settings › Updates (check at start on/off = `settings.updates.check`, Check now, Restart
  and install, status line), a blue `Update to x.y.z` button in the top bar once
  downloaded, Help › Check for updates. IPC `update:status|check|install`, event
  `update:status`. States dev / idle / checking / latest / downloading / downloaded / error;
  a 404 on the feed reads "No release published yet.".
- **Releases**: `.github/workflows/build.yml` builds the NSIS installer on `windows-latest`
  (Node 22, `npm ci`); on a `v<version>` tag (must equal `package.json`, checked) it creates
  the draft release first (electron-builder otherwise races itself into two drafts, seen on
  v0.1.0), then `electron-builder --publish always` uploads the installer, `.blockmap` and
  `latest.yml`; other pushes keep the installer as a workflow artifact. Publishing the draft
  by hand (`gh release edit v0.1.0 --draft=false`) makes it visible to the app. Release
  0.1.0: https://github.com/DenRakEiw/scumble/releases/tag/v0.1.0. Assets get hyphens
  instead of spaces (`Scumble-Setup-0.1.0.exe`), electron-updater expects exactly that.
- **Licence** GPL-3.0 everywhere (LICENSE, package.json, About, Help menu, README, BRIEF);
  README rewritten for the public repo (SmartScreen paragraph).
- **Tests**: Settings dialog and `python tools/commands_test.py` PASS on the dev instance;
  the packaged 0.1.0 reported "up to date" against the release; a local 0.0.9 build found
  and downloaded 0.1.0 within 30 s (blue button in the top bar) and installed it silently
  through Restart and install. Test recipe: set the version to 0.0.9 in `package.json`
  (Python, never PowerShell `Set-Content`: it writes a BOM and electron-builder refuses the
  file), `npm run dist`, run `dist/win-unpacked/Scumble.exe --remote-debugging-port=9555`,
  `python tools/cdp.py eval "window.scumble.updates.status()"`, restore the version.

Landed on 2026-09-09 (phase 4c, `docs/MCP.md` has the details):

- **`Scumble --mcp`**: stdio MCP server (`electron/main/mcp/server.js`,
  `@modelcontextprotocol/sdk` 1.30, MIT) with one tool per command of the command core, plugin
  commands included (`film.apply_look` → `film_apply_look`; tool names allow `[A-Za-z0-9_-]`
  only). Schemas from `describe()`, `screenshot` as image content, errors as `isError` text,
  `readOnlyHint` on the read-only commands, `tools/list_changed` after a plugin reload, `ping`
  reports `mcp: {mode, pid}`. If Scumble is running the server drives that instance, otherwise
  it starts the app headless in its own process and quits it when the client goes.
- **`--headless`** (the app without a window; a second start of Scumble shows it) and
  **`--cmd <name> [json]`** (one command against the running or a short-lived headless
  instance, JSON on stdout, exit 1 on error).
- **Plumbing**: `electron/main/bridge.js` (main → renderer request / reply over IPC, ready
  gating, timeouts), `electron/main/local.js` (named pipe `\\.\pipe\scumble-<hash>` / unix
  socket, NDJSON, opened by every running instance), `AgentBackend` in `main.js` (socket, else
  take the lock and start headless), `needWindow()` in front of every dialog, close = hide while
  an MCP client is attached, window title `Scumble · n agents connected`, `preload.js`
  `scumble.commands`, `shell.js` answers `commands:request` and sends `commands:ready` at the
  end of its start.
- **Electron on Windows, three traps** (all handled, keep them in mind): `process.stdin` in
  the main process never emits `data` from a pipe (read fd 0 with `fs.createReadStream`);
  Electron prints a CR LF to stdout before any JS runs and it cannot be suppressed from the
  app — **handled since 0.1.5 by the Node-mode launcher** `electron/main/mcp/launch.js`,
  which clients register instead of the exe; a window created hidden stays hidden after
  `show()`, `restore()` brings it up.
- **Tests**: `python tools/mcp_test.py [--exe dist/win-unpacked/Scumble.exe] [--direct]`
  (Python `mcp` client, through the launcher since 0.1.5; PASS 2026-09-09 in proxy mode with the app open, 1.5 s, and headless with the dev
  electron and the packaged exe, about 5 s, the process ends with the session), `python
  tools/commands_test.py` PASS, `python tools/smoke_test.py --no-helpers` PASS after the
  change (one run right after the commands test reported FAIL with only its tail captured; the
  re-runs passed, cause not identified).

Landed on 2026-09-09 (phase 4b, `docs/FILM.md` and `docs/PLUGINS.md` have the details):

- **Film pack** `plugins/film/` (built in): eleven filter types, each with a GLSL path and a
  CPU twin (`common.js` holds the shared maths, `tools/film_test.py` checks both paths on 35
  parameter sets, worst difference 3 levels in the three-stage film look): `film.look`
  (stock colour matrix / mono weights, warmth, tint, saturation, parametric tone curve with
  toe / shoulder per film class, fade, push, grain by speed through the built-in grain
  filter, halation default per stock), `film.halation`, `film.glow`, `film.tonal_contrast`,
  `film.structure`, `film.bleach_bypass`, `film.cross_process`, `film.split_tone`,
  `film.light_leak`, `film.frame`, `film.bw` (colour filters, toners, structure, grain), and
  `film.points` (control points: radial falloff × colour similarity, tool U with overlay,
  Delete / Escape, sliders in the layer row, one undo step per gesture). "Film looks" panel
  with one thumbnail per stock (46 stocks from the grain presets, `looks.js` adds tone class,
  halation and ISO), six Plugins-menu actions, commands `film.looks`, `film.apply_look`,
  `film.add_point`. Trademark note in the stock tooltip and About.
- **Plugin API additions** (`renderer/plugins.js`, `renderer/editor/inpaint_filters_gl.js`):
  `sampler2D` uniforms (canvas / ImageData / `{data, width, height}` as RGBA8 or RGBA32F,
  units 5+; `precision highp sampler2D` in the plugin source), `values(params, info, src)`,
  `scumble.gl.shade(shader, canvas, values, info)` for multi-pass filters (program cached per
  definition object), `scumble.filters.apply(id, ...)` / `filters.ids()`, tool `draw(doc, ctx,
  view)` + `drawAlways` and `onKey`, `Document.draw()` and `setFilterParams(layer, patch,
  {preview})` (undo like the editor's sliders), select params with `title`; only the select
  named `preset` fills params / renames the layer, other selects just set a value. *Reload
  plugins* now reloads submodules too: `main.js` `serveFile` rewrites relative imports in
  plugin modules to carry the `?v=` query.
- **Editor patches** (`tools/sync_editor.py`, rows in `docs/SYNC.md`): `host.pluginOverlay`
  in `drawOverlays`, the preset-select rule and `p.title` in the filter controls.
- **Tests**: `python tools/film_test.py` (9 steps, PASS 2026-09-09), `python
  tools/commands_test.py` PASS, `python tools/smoke_test.py --no-helpers` PASS after the
  change. Contact sheet of every filter: `dist/smoke/film/sheet.jpg` (made by hand this
  session, not part of a script).

Known small things (film pack): the CPU path of the control points is O(pixels × points)
(a 12 MP image with ten points takes a few seconds without a GPU); the rough frame edge and
light leak jitter use an integer hash that JS and GLSL compute identically, the value-noise
interpolation on top differs in the last float bits (never more than a level). Plugin
`custom` params are stored as-is in the document JSON (the points list); `filter_types`
omits their default.

Landed on 2026-09-08 (phase 4, `docs/COMMANDS.md` and `docs/PLUGINS.md` have the details):

- **Command core** `renderer/commands.js`: the node's bridge table ported to documents
  (tabs) instead of graph nodes, 59 commands, each with `description`, `params` schema
  (type, description, default, required, enum), `scope` app / doc, `needsImage`.
  `commands.run(name, args)` throws, `commands.call` returns `{ok, ...}`, `describe()` is
  the table as data, `register(name, def, owner)` for plugins. Document commands take
  `doc`; `export*` take a `path` (`host.exportPath` bypasses the dialog); `load_image` /
  `add_image_layer` take a `path` (IPC `file:read`) or a mirror ref. `host.shell`
  (newDocument, activate, closeDocument with `{force}`, selectRecipe, recipes) is how
  commands reach the shell. `tools/commands_doc.py` regenerates `docs/COMMANDS.md` from
  the running app.
- **Plugins** `renderer/plugins.js` + `electron/main/plugins.js`: folders in
  `<userData>/plugins/<id>/` and built-in `plugins/<id>/` (shipped in the asar,
  `build.files`), `plugin.json` manifest, ES module served as
  `scumble://app/plugins/<id>/...` (main.js `serveFile`, path-checked), loaded with
  `import()` plus a cache-busting query so *Reload plugins* works without restart.
  `activate(scumble)` gets the API (`makeApi`): `Document` wrapper (getPixels /
  setPixels as ImageData with undo, addLayer, selection mask in / out, run), command
  core, `filters` (into `FILTERS` / `FILTER_IDS`, optional GLSL through
  `registerGLFilter` in `inpaint_filters_gl.js`: the fragment defines `vec4 shade(vec4,
  vec2)`, `filter` is a reserved GLSL word), `panels` (`editor.addSection`), `actions`
  (Plugins menu built in main.js from IPC `plugins:menu`, `menu` event `plugin:<id>`),
  `tools` (button in the tool column, pointer routing through `host.pluginPointer`,
  keys through `host.pluginKey`, select / deselect through `host.toolChanged`), events
  (`host.on`: built, activate, changed, tool, removed), `storage` (settings.json
  `pluginData`). Every registration is tracked per plugin and removed on disable /
  reload. Settings › Plugins lists state, registrations and errors.
- **Sample plugin** `plugins/sample`: Posterize filter (CPU + GLSL, bit-exact), a panel,
  two actions, the colour-probe tool (K), the `sample.mean_color` command.
- **Editor patches** (`tools/sync_editor.py`, rows in `docs/SYNC.md`): exports of the DOM
  helpers, `toolsEl` / `_addTool`, `addSection`, `host.editorBuilt`, the three pointer
  hooks, `pluginKey` before the tool switch, `toolChanged` in `setTool`.
- **Tests**: `python tools/commands_test.py` (12 steps, PASS 2026-09-08; needs the app on
  port 9555 and the test image in the mirror), `python tools/smoke_test.py --no-helpers`
  PASS after the change (76 s Flux run + loopback provider).

Landed on 2026-09-08 (phase 3, `docs/HELPERS.md` has the details):

- **In-app helper models** through `onnxruntime-node` 1.29 in the main process
  (`electron/main/onnx/`): `runtime.js` (one session per file, DirectML → CPU on
  Windows, CUDA → CPU on Linux, CoreML on macOS; `logSeverityLevel 3`), `models.js`
  (registry, lookup in the model folder and its `onnx/`, `sam2/`, `RMBG/` subfolders,
  resumable downloads with progress and a Hugging Face token for gated repos),
  `sam2.js` (encoder, decoder, automatic mask generator ported from SAM2 with the same
  parameters as the node's `InpaintCanvasObjectMap`, point prompts), `matting.js`
  (BiRefNet / RMBG, sigmoid when the output is a logit), `index.js` (the IPC facade:
  status, configure, downloads, objects, segment, cutout, free).
- **Models** (`models.js`): SAM2 tiny / small / base+ / large from
  `vietanhdev/segment-anything-2-onnx-models` (Apache-2.0; encoder `image`
  1×3×1024×1024 → `high_res_feats_0/1`, `image_embed`; decoder with dynamic batch);
  BiRefNet lite and BiRefNet (`onnx-community`, MIT), RMBG-1.4 (free download,
  non-commercial), RMBG-2.0 (gated, needs the token). All fp32. Model folder default
  `<userData>/models`, or a ComfyUI `models` folder (downloads then go to its `onnx/`).
- **Editor integration** (patches in `tools/sync_editor.py`, rows in `docs/SYNC.md`):
  `objectBackendAvailable()` / `ensureObjects()` prefer `host.findObjects()` when a
  SAM2 model is present (label map at ≤ 2048 px long side, nearest-scaled to the image,
  `applySegmentIds()` split out of `applySegmentsFile()`); `availableCutoutBackends()`
  lists `host.cutoutBackends()` (`app:<model>`) first and `cutoutLayer()` calls
  `host.cutoutInApp()` (`applyCutoutImage()` split out of `applyCutoutFile()`); a click
  beside every object in the object tool runs one SAM2 point prompt on the cached
  embedding (`host.selectPoint`, Shift adds, Alt subtracts); Free VRAM also releases
  the ONNX sessions, and `helperUsed` is set so a local run frees them first.
- **Settings › Helpers** (`shell.js` `renderHelpers`): device auto / GPU / CPU, the SAM2
  model for the object tool, model folder (Change / App folder / Open), one row per
  model with Download (progress bar, Cancel, resume of `.part` files) or Remove, the
  Hugging Face token (key `hf-token`), a runtime line (version, providers tried, what
  is loaded on which provider, failures).
- Measured on the RTX 5090 (DirectML): SAM2 base+ objects on the 512 × 384 test image
  1.2 s warm (4.2 s with session creation), point prompt 0.4 s, BiRefNet lite cutout
  2.5 s warm (10 s cold), RMBG-1.4 0.9 s. With the card full of ComfyUI's models (29 of
  32 GB) DirectML pages and the object map takes 125 s; Free VRAM fixes it and the
  status line says so after a slow run (`host.slowHelperHint`). CPU path: about 24 s. `node tools/helpers_test.js` checks the
  modules without Electron on a synthetic image (PASS 2026-09-08).
- `package.json`: `onnxruntime-node` dependency, `asarUnpack` for its `bin/` (DLLs next
  to the `.node` binding), `npm run helpers-test`.

Known small things: `loadFile` uploads with `overwrite=false`, so re-loading an image
with a name already in the mirror yields `name (1).png` (ComfyUI's own rule, harmless).
The mirror never deletes; the node's `cleanupFiles()` only cleans the server. The
editor's per-document `settings` keep their value when a recipe with the same target
id is re-selected (by design); the Settings panel falls back to the first combo entry
when the stored file name is not on the server. The helper input is squashed to
1024 × 1024 (SAM2's own transform and what the RMBG node does too), so very wide
images get coarser masks; the object map is computed at ≤ 2048 px long side.
