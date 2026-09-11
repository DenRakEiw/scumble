# CLAUDE.md — Scumble (desktop app)

Read this first, then `docs/BRIEF.md` (vision, decisions, architecture, phases).
`docs/BUGS.md` is the bug list: what is reported and not fixed, and what has to be
measured before anyone writes code. Put a new report there, not in this file.
`docs/NAMES.md` holds the name research, `docs/RUNPOD.md` the Docker template notes.

**Name: Scumble** (decided 2026-09-07). A scumble is a thin, semi-opaque layer of paint
brushed over a dry layer so the one below shows through; that is what an inpaint result
over the image is. Pronounced "skum-bl". Domains `scumble.app` and `scumble.de` were free
on 2026-09-07 (`scumble.com` is taken); the user registers them and checks trademarks
(DPMA, EUIPO, USPTO, classes 9 and 42) before the first public mention. Use the name in
the app, the installer (`Scumble Setup.exe`), the MCP server name (`scumble`) and the
repo; the ComfyUI node keeps its name Inpaint Canvas.

## Who and what

Built for and with DenRakEiw (GitHub DenRakEiw, German-speaking, answers in German).
A standalone desktop editor for AI inpainting: layers, selection by text,
retouch, filter layers, colour match per layer, text, PSD/ORA export. Local rendering
through the user's own ComfyUI, API rendering through fal.ai and direct providers,
SAM/RMBG in-app via ONNX. MCP-capable from the start. Windows first, Linux second.

The editor code comes from the ComfyUI custom node **Inpaint Canvas**
(`F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI\custom_nodes\ComfyUI-InpaintCanvas`,
GitHub `DenRakEiw/ComfyUI-InpaintCanvas`, GPL-3.0, ~9,500 lines of vanilla JS in `js/`).
That repo stays the backend node and keeps living; this folder is the app. Read its
`CLAUDE.md`, `DEVELOPMENT.md` (§1–19) and `GUIDE.md` before touching editor code.

## Decisions already made (do not reopen without the user)

- Shell: **Electron** (identical Chromium on Windows and Linux; `ctx.filter` and canvas
  performance; Node process for `sharp` exports and the in-app MCP server).
- Local rendering: **the user's ComfyUI**, local or remote (RunPod). The app never
  bundles Python/Torch. The node pack must be installed there; the app checks
  `/object_info` and offers to install it via the Manager.
- API rendering: **fal.ai** as the aggregator, plus direct adapters (Black Forest Labs
  Flux.2, OpenAI gpt-image, Google Gemini image) and the ComfyUI API nodes as fallback.
  Keys in the OS credential store via Electron `safeStorage`, never in config files.
  Prompt upsampling runs on the same keys, or on a local OpenAI-compatible server
  (Ollama / LM Studio / vLLM, `settings.llm.compat`, no key needed).
- Helper models: **SAM2 and RMBG-2.0 in-app via ONNX Runtime** (DirectML on Windows,
  CUDA/CPU on Linux); model files downloaded into the app data folder **or** read from a
  linked ComfyUI `models/` folder. SAM3 stays a ComfyUI helper (no ONNX export).
- Recipes instead of graphs: the user picks "Flux.2 Klein local", "SDXL inpaint",
  "Flux.2 via fal" etc.; a recipe is a workflow template with a fixed Inpaint Canvas
  node id that the app fills and queues. Users can import their own workflow as a
  recipe if it holds an Inpaint Canvas node.
- MCP: the bridge commands from the node (`js/inpaint_bridge.js`, 46 tools) become the
  app's command core; `app.exe --mcp` runs the stdio MCP server in-process (TypeScript
  SDK); headless = the app without a window.
- Filters move to **WebGL2** (grain, curves, colour balance, LUT as shaders), CPU path as
  fallback; the same code goes back into the node.
- Film names: **keep the real names in the grain presets and the film pack**, own
  parametric values only (no manufacturer LUTs), disclaimer in the preset tooltip and
  the About dialog, never in product name or marketing; lawyer check before a sale.
- Plugins: **JavaScript plugins on the command core** (plugin folders with
  `plugin.json`, filter / panel / action / tool extension points), the film pack is the
  first built-in plugin; Python plugins later, not now. Plan in `docs/BRIEF.md` §5.
- Licence: **GPL-3.0** (decided 2026-09-09; `LICENSE`, `package.json`, About, README).
  The same licence as the node, no CLA, no dual licensing (that is also what the free
  SignPath Foundation signing requires). Only MIT/Apache/BSD/OFL dependencies in the app.
- Release channel: **GitHub Releases** of `DenRakEiw/scumble` (public since 2026-09-09).
  `electron-updater` reads `latest.yml` there; `.github/workflows/build.yml` builds the
  installer on `windows-latest` and publishes a **draft** release on a `v<version>` tag
  (the tag must match `package.json`); publishing the draft makes it visible to the app.
  **Every release needs its section in `CHANGELOG.md` first**: the workflow builds the
  release body from it through `tools/release_notes.py` and fails the tag build when the
  section is missing, and the app shows the same text in Settings › Updates before you
  restart into the new version.
  First releases are **unsigned**; code signing goes through the SignPath Foundation
  (free for OSS) once the project has a public release and some use, fallback Certum
  Open Source. Azure Trusted Signing is paid and not for individuals in the EU.

## Where things stand (2026-09-11, late)

**Read `docs/BUGS.md` first.** The vanishing layer is fixed (first bullet below). What is
left open there: the erase that "switches to the base" (probably the same bug seen from the
other side, one question to the user still unanswered) and the jerky 15k document.

**0.1.7 is released** (v0.1.7, published 2026-09-11 16:56 UTC): transparent results from the
OpenAI image models, the whole documented parameter set for them, GPT Image 2.5 up to
3840 px with a `minPixels` floor, and a prompt template for cut-outs. `package.json` is
**0.1.8** now with an unreleased CHANGELOG section holding the marquee fix and the
*Highres fix* rename; the tag waits for the user.

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

## How the app is put together

- `electron/main/main.js`: window, `scumble://app/` scheme (renderer files) with
  `scumble://app/comfy/*` proxied to the ComfyUI server by `electron/main/comfy.js`
  (auth headers live there; the websocket too, events are forwarded over IPC).
  Same-origin, so `<img>` from `/comfy/view` never taints a canvas.
- `renderer/editor/`: the node's editor, copied and patched by `tools/sync_editor.py`
  (`docs/SYNC.md` lists every patch). `renderer/editor/host.js` is the app side:
  `api` (fetchApi, apiURL, queuePrompt, events) and `host` (recipe, settings targets,
  generate, autosave, export). Do not edit the synced files by hand.
- Recipes are API-format prompts; `host.queueGenerate` injects `canvas_state`,
  `result_source[_local]` and the node params into the canvas node and writes the
  Settings-panel values into the recipe nodes directly (`settings: [{index, node,
  input, label}]`), so `setting_n` outputs are not used.
- State: every tab's `getValue()` JSON in one bundle, autosaved to
  `%APPDATA%/Scumble/autosave.json` and restored at the next start from the local file
  mirror (`%APPDATA%/Scumble/files/`), no server needed. Layer pixels are uploaded like
  in the node (`input/inpaint_canvas`), but the upload lands in the mirror and is
  forwarded; `ensureOnServer` re-uploads before a run.
- `renderer/shell.js`: tab bar, settings dialog (ComfyUI + auth + Test, API keys,
  recipes, helpers, local files), menu commands, restore at start; exports `newDocument`,
  `activate`, `closeDocument`, `openSettings`, `selectRecipe`, `loadRecipes`,
  `importRecipe`, `testConnection`, `connect` for tests (`import("./shell.js")` from
  the console). `window.editor` is always the active tab.
- Helpers in-app: editor → `host.findObjects` / `host.cutoutInApp` / `host.selectPoint`
  (source scaled to 1024² in the renderer) → IPC `helpers:objects|cutout|segment` →
  `electron/main/onnx/index.js` → `sam2.js` / `matting.js` on the `Runtime` → label
  map / alpha back, scaled to the image in the renderer. Models and folder in
  `docs/HELPERS.md`.
- Agents: MCP client → `Scumble --mcp` (`electron/main/mcp/server.js`) → `AgentBackend` in
  `main.js` → the running instance over `electron/main/local.js` (named pipe) or the app
  started headless in the same process → `electron/main/bridge.js` (IPC `commands:request` /
  `commands:reply`) → `commands.call` in `renderer/shell.js`. `docs/MCP.md`.
- Provider runs: `host.runProvider` (the recipe resolved to the chosen provider's variant by
  `shell.js`) → `renderer/editor/stitch.js` (crop) → IPC `provider:edit` →
  `electron/main/providers/index.js` picks the adapter and the key (`keys.js`) →
  `stitch.js` (composite mask, colour match) → mirror upload → `addResults`. Recipe
  formats in `docs/RECIPES.md`.

## Working rules

- Development folder is `F:\canvas`. Scratch files go to the session scratchpad, not here.
- Commit as DenRakEiw: `git -c user.name=DenRakEiw -c user.email=89697885+DenRakEiw@users.noreply.github.com`,
  no Claude trailer in commit messages. Push with `-c credential.helper='!gh auth git-credential'`.
- The user's ComfyUI (port 8188) is a production machine: check `/queue` before
  queueing anything, never restart it unasked, delete own test prompts from the queue.
- Python patch scripts must write with `newline=chr(10)`; a mistyped `newline="\\n"`
  once truncated a 7,000-line file.
- Test with real runs: start `./node_modules/.bin/electron . --remote-debugging-port=9555`
  (9333 is usually taken by the node's headless tab), then `python tools/cdp.py eval|shot|log`
  and `python tools/smoke_test.py` (load, select, generate through the recipe, save,
  then the helpers and exports; `--no-helpers` for the short version) and
  `python tools/commands_test.py` (command core + sample plugin, no ComfyUI needed).
  `python tools/mcp_test.py` talks to the MCP server over stdio through
  `electron/main/mcp/launch.js` (proxy mode while the dev instance runs, headless when
  nothing runs; `--exe dist/win-unpacked/Scumble.exe` for the package, `--direct` for the
  old registration, which the Python client rejects by design).
  `python tools/llm_test.py` checks the OpenAI-compatible upsample endpoint against
  `tools/llm_mock.py` (a mock server it starts itself; no ComfyUI, no key, no local model).
  `python tools/generate_test.py` covers "Generate new" (a base image from the prompt
  alone) against the loopback provider, no ComfyUI and no key needed.
  `python tools/shape_test.py` covers the shape tool: every kind, fill and outline, the
  corner radius, the clip to the selection and one undo step per shape.
  `python tools/size_test.py` covers the size a crop is emitted at for an API run: the
  provider variant's `limits`, the five API size modes, the pixel budget, and that a local
  recipe keeps its `target_size`. Loopback only, no ComfyUI and no key needed.
  `python tools/transparent_test.py` covers the OpenAI `background` parameter: the adapter's
  size rules and parameter set in plain Node, then the loopback provider's transparent
  answer surviving the stitch, "Generate new" with a transparent base, and the pixel floor.
  `python tools/editor_test.py` covers the editor behaviour reported broken in 0.1.5: the
  New dialog's two size boxes and its focus, the click that deselects, the outline that has
  to stay visible on white, and copy / paste of a layer between tabs.
  `node tools/helpers_test.js` runs the ONNX modules without Electron.
  `python tools/composite_test.py` compares the GPU compositor against Canvas 2D and two
  stored references in `tools/refs/` (`--update` rewrites them, `--tolerance n` allows n
  levels); run it after anything that touches drawing.
  `python tools/perf_test.py [2048x1152 6000x4000 12000x8000]` is the drawing benchmark
  (synthetic documents in their own tab, no ComfyUI; `docs/PERFORMANCE.md` §7).
  `python tools/mem_test.py [12000x8000] [--rounds 4] [--keep]` is the memory walk: a
  document per round, benchmarked, closed and collected, with the private bytes of the
  renderer and of the GPU process, a census of every live canvas and the line that made it.
  Restart the app before every benchmark or memory run. Scripted
  waits must use `setTimeout`, never `requestAnimationFrame`: rAF does not fire while the
  window is hidden, and `drawSoon()` is rAF-based, so a hidden window draws nothing.
  Start the dev instance with the Bash tool's `run_in_background`; a plain `&` job dies
  with the shell.
  `window.editor` and `import("./editor/host.js")` are reachable from the console.
  Only one instance runs at a time (single-instance lock); stop the dev instance before
  starting `dist/win-unpacked/Scumble.exe`. `Stop-Process -Name electron` in PowerShell.
- Answer in German; code, comments and docs in English.
