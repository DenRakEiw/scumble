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

The editor code came from the ComfyUI custom node **Inpaint Canvas**
(`F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI\custom_nodes\ComfyUI-InpaintCanvas`,
GitHub `DenRakEiw/ComfyUI-InpaintCanvas`, GPL-3.0). **Since C0 (2026-09-13) `renderer/editor/`
in this repo is the source of the editor** and the node's `js/` is a build of it
(`python tools/build_node.py`, `docs/BUILD_NODE.md`); the node keeps its own `js/host.js`,
`js/inpaint_node.js` and `js/inpaint_bridge.js`. That repo stays the backend node and keeps
living. Read its `CLAUDE.md`, `DEVELOPMENT.md` (§1–23) and `GUIDE.md` before touching editor
code.

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
  **Before SignPath comes the Microsoft Store** (the user, 2026-09-23: qualifying for SignPath takes
  time, and a user who needs a signed installer should have one meanwhile). An **MSIX** submitted to
  the Store is **re-signed by Microsoft** after certification - no certificate to buy or hold - and a
  developer account has been free since 2025-09 for individuals and 2026-05 for companies (an identity
  check replaces the fee). **It signs only the Store copy: the GitHub installer stays unsigned** and
  keeps its SmartScreen paragraph, and submitting the `.exe` to the Store instead would require the
  publisher to sign it first, so this is a second channel, not a replacement. The build has to be
  `runFullTrust` (an AppContainer package cannot reach `127.0.0.1`, which would cut the app off from
  the user's ComfyUI), must not self-update (the Store updates its copy), and must register MCP by the
  execution alias rather than the versioned `WindowsApps` path, as the AppImage does. To be tested,
  not assumed: the single-instance pipe, the plugin folder and every `%APPDATA%` path (keys, autosave,
  file mirror) under a packaged app's redirection. GPL-3.0 is no obstacle (VLC and Krita are in the
  Store). `docs/CODE_SIGNING_POLICY.md` holds the whole decision.
- **Every published release also gets a post in the dev blog on the user's website**
  (https://www.denrakeiw.com/scumble/blog; the user, 2026-09-21). The site is the repo `F:\portfolio_web`
  (GitHub `DenRakEiw/Portfolio_vercel`, Next.js, deployed by Vercel). A post is one entry at the top of `devlog` in
  `lib/scumble-posts.ts` (slug `v0-1-NN`, `version`, `date`, `time` = the release's `publishedAt` from
  `gh release view` in German time with its offset, `release` link, title, summary, `body` paragraphs): the
  CHANGELOG section retold in a loose, personal first-person voice, in English like the rest of the site, no
  markdown in the strings; `hub.version` in `lib/scumble.ts` follows the release. Before the post, `node tools/manual_sync.js` (the manual and its reader, docs/PLAN_HELP.md), committed
  with it. `npx tsc --noEmit -p .` and
  `npx next build` before committing. **Who pushes matters: Vercel runs on a free (Hobby) account, which deploys
  only commits of its one owner.** Commit with the website repo's own identity (its local `user.email` is
  `schoenebergde@gmail.com` since 2026-09-25, when the user reconnected the Git account to Vercel: the deploys of
  that address go through, one of `dennis.schoeneberg@me.com` was blocked the same day), never as the `DenRakEiw`
  noreply address this repo uses, and **no `Co-Authored-By` trailer** (a second author blocks a Hobby deploy);
  stage only the files of the post. **Git deploys work again since 2026-09-25** (0.1.29's post went live by git,
  `db4197d`). Read the commit's status afterwards (`gh api repos/DenRakEiw/Portfolio_vercel/commits/<sha>/status`);
  should it say blocked again, deploy exactly that commit with the CLI from a clean export, never from the working
  tree: `git archive <sha> | tar -x -C <scratch>`, copy `.vercel/project.json` into it, `vercel --prod --yes`
  there. Then check the live page (posts are anchors on `/scumble/blog`, `#v0-1-NN`, not pages of their own).

The session hand-over blocks that used to live here ("Where things stand / stood", 2026-09-09 to
2026-09-23) are in `docs/HISTORY.md`, newest first, verbatim. They are a record, not instructions.

## Where things stand (2026-09-26, evening)

**0.1.29 is Latest** (published 2026-09-26 18:07 German time on the user's word "3a und dann release"): skins,
Magnific, Oxen.ai and quit safety (3a); exe gates `--offline` ALL PASS on both backends (`rel29-exe`,
`rel29-exe-canvas`); dev blog post "Close it, it waits now" (`v0-1-29`, portfolio `db4197d`, with the manual sync).
Done of the plan below: **1 skins** (`2471831`, the review's ask-card bypasses fixed: `protectAsk`), **2 providers**
(`7425173`), **3a quit safety** (`9d81033`, gate `quit`, `electron/main/quit.js` and `autosave.js`). **Next, the
user's order: 3b to 3f** - the `.scumble` format first (the biggest: save / save as, dirty marker, close asks, recent
files, file association), then the history panel, TIFF, PSD masks, the metadata switch; then packages 4 to 6. The
design pass of package 3 of the morning died with the usage limit (every agent failed): 3b starts with a fresh one.
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

## Open threads (condensed on 2026-09-26 from the hand-overs of 2026-09-19 to 2026-09-23)

The full hand-over blocks of those days are in `docs/HISTORY.md`, verbatim. What still matters from them:

**Releases.** 0.1.29 is Latest (published 2026-09-26: skins, Magnific, Oxen.ai, quit safety). The next CHANGELOG
section is "0.1.30 — unreleased" once something lands. Check `gh release list` before believing any release state
written down anywhere. Every release: the CHANGELOG section first, `npm run dist`, exe gates `--offline` on both
backends, the manual sync (`node tools/manual_sync.js`) and a dev blog post (the decisions block above).

**Open, from before 2026-09-26 (none started):**
- **B3, the macOS build** (`docs/PLAN_0_1_24.md` "Session B3"): unblocked since the logo exists (`build/icon.png`
  1024 px); was next in the user's order of 2026-09-23 before the build of 2026-09-26 took over.
- **The Store package per release** (`npm run dist:store`; `docs/STORE.md`, `docs/STORE_LISTING.md`). The user
  submitted the listing on 2026-09-23 (publish after certification); identity `DenRakEiw.Scumble`, Store ID
  `9NDBTNNMXF2R`. When it is live, the Store link goes onto the website hub, README and a blog post. The coupling of
  GitHub releases to the Store (`msstore` CLI in `build.yml`) only on the user's word. **Signing: the Store first, then
  SignPath.**
- **The headless MCP instance of this repo's `.mcp.json` intercepts the installed app** (it runs the dev tree on the
  default profile; a Start-menu Scumble hands over to it). A fix (a profile of its own for the MCP registration,
  `docs/BUGS.md` "A headless MCP instance can block the app from starting") was offered, not decided.
- **Comfy Router live runs** of FLUX.2, Seedream and Magnific (offered, not asked for; the key is in the scratch
  profile `dist/live-keys`, about $243 of credit then). `GET /customers/balance`'s `amount_micros` counts cents.
- **Linux: built by CI, never run** (`docs/BUGS.md`).
- **Types stage 3** (`docs/PLAN_TYPES.md`): `electron/preload.js`'s `window.scumble` is `any` in `types/globals.d.ts`.
- **The manual** (`docs/MANUAL.md` is its one source; the website builds `/scumble/manual` from copies made by
  `tools/manual_sync.js` - never edit it on the website): the assistant's screenshot is an empty panel, there is no
  colour-match figure (it needs a result that is *unintentionally* off), the log screenshot is empty.
- **Screenshot trap:** *Settings > API providers* shows the last four characters of stored keys; mask them before any
  settings screenshot goes on the web.
- **Tutorial material** (`docs/TUTORIAL.md`, `docs/images/tutorial/`, `docs/images/video/`) stays uncommitted until
  the user says so.
- **The node repo is behind** (its `js/` is built from 7f01699; master is fba1fd8). `nodecopy` builds and tests it in a
  scratch copy; build it into the real repo only when a node version is meant to ship.
- **The assistant:** A10 (a budget, "allow for this chat") and A11 (its own undo steps) only on the user's word.

**Standing constraints and decisions (still valid):**
- **The user's ComfyUI (8188) is a production machine:** no `smoke` and no gate that forwards to it unless the user
  says it is free; gates run `--offline`.
- The user works up to about 15k; 30k is not the size to tune for. B item 6 (one-channel masks) stays on ice; no stage
  2 split of `inpaint_canvas.js` (a subject is split out only when it is reworked anyway); the object tool's change A
  (image-size label map) is parked. §C7's memory gate (300 MB of GPU process per document) is not met; tiles stay the
  default anyway, the canvas backend is the escape hatch.
- **A parked idea, not a plan:** a mobile companion (mark a place, say the prompt, the run happens on the desktop or an
  API), not a mobile editor.

**Still unverified:** the ToAPIs and ModelArk adapters never ran against the live API; OpenRouter ran live for GPT
Image 2.5 Flare and Sunburst only (0.1.27); Magnific (beyond the two upscalers) and Oxen are built from the docs only
(2026-09-26); the Qwen Image Edit 2.1 local recipe never ran (the models are not downloaded); a real SAM2 / RMBG model
has not run in the app on the slice 6 code; the user has not reported back on their own 15k file.

## What comes next (the list)

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

## Gate runner and flakes

`bash tools/run_gates.sh <label> [--strict] [--copy] [--tiles on|off] [--offline] [--exe PATH] <gates...>` starts a fresh instance on
port 9555 with its own profile (with `test_base.png`), runs each gate with a timeout, and writes logs and `summary.txt` under
`dist/gates/gates/<label>/` (or `$SCUMBLE_GATES`). `tools/close_app.py` closes an instance by its DevTools port
(`SCUMBLE_CDP_PORT`). Gates: `pixels editor composite commands shape brush film glb ailabel size transparent generate log
mcp nodecopy toapis openrouter ark recipes assistant llm export pxjobs upscale layered platform lint types help skins
magnific oxen quit`, plus `smoke` (a real Flux run; check `/queue` first, and not while the user needs
ComfyUI), `perf:<W>x<H>`, `exportperf:<W>x<H>[,--filter=film.look]` and `huge:<W>x<H>` (the 30k gate; it refuses to run
against a connected instance). `quit` and `quit:<W>x<H>` start and close their own instances (port +17): a test that
closes the app must send WM_CLOSE, since a page's `window.close()` skips the window's close event. **`--offline` starts the instance with `--no-comfy`**: it does not connect, so no upload is
forwarded to the user's server. A fresh gate profile otherwise connects to `127.0.0.1:8188`, the user's ComfyUI, and
forwards every upload of every gate to its input folder; use `--offline` for everything but `smoke`. Run a change on both backends (`--tiles on` and `--tiles off`); a release also runs against
`dist/win-unpacked/Scumble.exe` with `--exe`, each run on its own profile.

Known flakes; **re-run before believing any of these**:
- `commands_test.py` hangs after every step has printed `[ok]` (the runner's 420 s timeout, sometimes in
  `Page.captureScreenshot`).
- `editor_test.py` `closed_tabs_are_collected` fails with the last tabs still alive, or against an instance with 50+ tabs
  from repeated runs.
- The live stroke steps (`live_stroke_reaches_the_screen_before_the_release`, `live_stroke_preview_shows_what_the_commit_writes`)
  fail when a real mouse is over the test window (they drive synthetic pointer events), or right after a diagnostic
  instance was closed.
- The marching ants (120 ms) break a screen comparison now and then; steps that compare the screen draw the selection as a
  tint.
- `composite_test.py` once got a 1200 × 794 canvas against its 1200 × 800 reference and then crashed with `KeyError 'bytes'`
  in its own failure message (a test bug, not fixed).
- `node tools/brush_test.js` hung once at exit under load after printing every PASS.
- `editor_test.py` `closed_tabs_are_collected` failed twice in five runs of the editor gate alone on the canvas backend
  (`--tiles off`, 2026-09-17, B item 2) and passed on the rerun each time; the code under it had not changed.
- `editor_test.py` `selection_keeps_its_bounds_through_a_restore_above_1mp` failed once with no message on the canvas
  backend (2026-09-23, after `help` and `assistant` in the same instance) and passed on the rerun in the same order.
- `editor_test.py` `a_settled_read_builds_its_levels_in_the_worker_not_here` failed once with `requested: 0` in some twenty
  runs since the mip chains go through the pool; not reproduced.
- The first exe instance of the 0.1.18 gates failed `a_settled_read_builds_its_levels_in_the_worker_not_here`
  (`requested: 0`, 11 s into the editor gate) and `composite_test.py`'s view (a 1200 × 794 canvas) in the same run; both
  passed on a fresh instance. Two known flakes at once, in the first seconds of an instance: not looked into.
- `perf_test.py`'s magic wand row (whole-image band) read 2.1, 4.0 and 7.0 s in three runs of the same code while ComfyUI
  ran a job; an A/B against the commit before in the same minute read 3.5 s. It is the card, not the code.
- The `commands` primed-cells checks wait up to 3 s for the film panel's own settled flatten; a failure "primed cells were
  left behind" seen once without a mutation was that race.
- The editor gate run alone on tiles takes about 370 s (120 s inside a full run). On 2026-09-18 (the split, stage 1)
  four runs alone failed at four different timing-bound steps (the live stroke with the pointer message,
  `closed_tabs_are_collected` twice with the last two tabs alive, `helper_inputs_read_levels_and_upload_nothing` with
  one upload counted), while the unchanged tree passed once and `closed_tabs_are_collected` alone passed 3 of 3 on
  both trees; not looked into further.

## Traps worth keeping

**Chromium, canvas, WebGL**
- Chromium applies `UNPACK_PREMULTIPLY_ALPHA_WEBGL` to `ArrayBufferView` uploads too; set both unpack switches explicitly
  before every typed-array upload, or premultiplied tile bytes get premultiplied twice.
- Once at least 100 `getImageData` calls have disabled acceleration and they reach 95 % of all canvases created, Chromium
  makes every new canvas software; a test with a readback after every step can trip it.
- `globalCompositeOperation` `copy` and `destination-in` apply to the whole canvas; a regional use needs `clip()` first (the
  vanishing-layer bug of 0.1.8).
- An OffscreenCanvas clips without anti-aliasing; `drawInto` callbacks allow clips on whole pixels only.
- A canvas 65,536 px on a side draws and reads nothing; 65,535 works. The WebGL drawing buffer caps at about 33 MP whatever
  the canvas size says (filters render in tiles for that).
- A sub-rectangle draw from a very large canvas is not cheap (150 band draws from a 15k canvas cost 30× one whole draw);
  bands only pay when each band's source is small too.
- A `CanvasGradient` belongs to the context that made it; a cached one has to be keyed by the context.
- Skia's CPU raster is not exactly translation-invariant; a GPU readback costs whatever is queued before it; Chromium keeps
  small canvases in software, so a buffer that grew onto the GPU differs from an all-GPU canvas by a few levels.
- `requestAnimationFrame` does not fire in a hidden window (`drawSoon()` is rAF-based), and `img.decode()` never resolves
  there; scripted waits use `setTimeout`, image loads wait for `onload`.
- On a `<dialog>` closed by a real Escape Chromium fires `cancel`, not always `close`.
- `texSubImage2D` and `readPixels` take a view on a `SharedArrayBuffer` here (Electron's Chromium): no copy between the
  workers' buffer and the GPU (B item 7 part 2). 572 MB go up in 0.1 s and come back in 0.2 s, on the main thread.

**Electron and Windows**
- In the main process `process.stdin` never emits `data` from a pipe (read fd 0 with `fs.createReadStream`); Electron prints
  a CR LF to stdout before any JS runs (hence the MCP launcher); a window created hidden stays hidden after `show()`,
  `restore()` brings it up.
- Electron has no `window.prompt`; the editor has its own `ask()` modal.
- Only one instance runs at a time (single-instance lock and named pipe), including headless `--mcp` instances.
- An unsigned MSIX cannot be installed when it holds an app (0x80073D2B), whatever `-AllowUnsigned` and the
  publisher OID say, and a registered layout refuses that OID (0x80073D2D); a test install is Developer Mode plus
  `Add-AppxPackage -Register` of the unpacked layout with a plain test publisher (`docs/STORE.md`).
- `makeappx.exe` started from electron-builder's cache under `%LOCALAPPDATA%` fails with "side-by-side
  configuration is invalid" (from Node and PowerShell; Git Bash ran it), the same files from `F:` run.
- With `ELECTRON_RUN_AS_NODE` and `-e`, a switch after the code is taken for a Node option ("bad option:
  --mcp"); after `--` it lands in `process.argv[1]`, not `[2]`.
- `mcp_test.py --user-data-dir` must come before `--cmd`, which otherwise takes it for its JSON.

**Tooling, shell, git**
- The Bash tool's heredoc breaks on an apostrophe in its text even with a quoted delimiter (`unexpected EOF while looking
  for matching`), and turns `\u0080` in Python source into the character. Write scripts and JS with the Write tool; a
  patch script imports a small `patch(path, [(old, new)])` helper and asserts each `old` occurs once.
- The Write tool itself turns `\u0080` in a JS regex into the literal character. Check a written file for non-ASCII
  (`grep -nP "[^\x00-\x7F]"`) when it holds escapes.
- A backtick in a comment inside a GLSL template literal ends the JS string; `node --check` on an ES module file here
  reports nothing, the app reports `Unexpected identifier` at import.
- A Bash-tool heredoc with an unquoted delimiter (`<<EOF`) runs every backtick span in its text as a command; quote it
  (`<<'EOF'`) or use the Write tool. Heredocs also turn `\\n` in Python source into real newlines, and long Python heredocs
  fail to parse: write scripts with the Write tool.
- PowerShell `Set-Content` writes a BOM (electron-builder then refuses `package.json`); edit such files from Python.
- Python patch scripts write with `newline=chr(10)`.
- Reusing one commit message file gives the next commit the old message.
- The node's publish action runs on a push only when `pyproject.toml` changes; otherwise
  `gh workflow run publish_action.yml --repo DenRakEiw/ComfyUI-InpaintCanvas --ref master`.
- `tools/run_gates.sh` and the mutation helpers restore only the files they saved; check `git diff --stat` after a mutation
  round.
- A background `grep` loop meant to stop a workflow after a phase does not fire in time; read its journal by hand or give it
  a phase switch in `args`.

**Testing and benchmarking**
- A mutation that is not run against a fresh instance proves nothing: the renderer caches the ES modules it imported at
  start. Close the app, patch, start again.
- Restart the app before every benchmark or memory run; after several large documents the GL path degrades.
- A "before" row that runs after `mipsSettled()` measures a warm document.
- An A/B that flips between rows compares two pictures; compare bytes in one state, with
  `releaseCaches({ mirrors: true, deep: true })` between the reads.
- A benchmark row only measures what its document exercises (the perf stack always carries a filter layer).
- ComfyUI holding the card changes op rows by 3 to 5×; A/B a suspected regression in the same session, with the card freed
  (`/free` on an empty queue) if possible.
- The layers reach the local store through `ed.syncLayers()`; a test that reloads right after a change calls it first.
- `editor_test.py`'s `window.__t` is 600 × 300 by the time later steps run; call `new_canvas` first.
- A test that sets `layer.blend` or `layer.visible` by hand leaves the composite version where it was, and the wand's
  coarse pass answers from before the change; go through `set_layer` (it calls `touch`).
- Three 8-bit roundings in a blend formula are up to 1.45 levels off and a level from the shader on 29 % of the bytes of
  a half-transparent layer; one rounding of exact products is within 0.5. Measure a kernel against exact floats
  before blaming the other path.
- The renderer keeps its own copy of the settings (`settings` in `shell.js`). A test that calls
  `window.scumble.settings.set()` directly changes the stored file, not the window's view, and a later gate in the
  same instance that reads both (`list_recipes` against `settings.get()`) fails on the difference: the `toapis` gate
  left `gpt_image_2` on toapis and made `openrouter` red on 2026-09-20 when it ran before it. Its cleanup now puts
  every recipe it switched back through `selectRecipe`, so the order no longer matters; a gate that switches
  anything in the window has to do the same.

**Tile engine code**
- A tile's bytes are a view into a SharedArrayBuffer in the app: no `ImageData`, `Blob` or `crypto.subtle` over them
  (`imageDataOf` copies into a scratch), `t.data.buffer` is the 64 MB chunk (use `byteOffset`), and a worker may read a
  tile while this thread writes it: a job's answer counts only if the tile's version is still the one it was made from.
- A worker must never write a tile it was given by slot; it extends or converts a copy.
- Whoever hands tiles to a job holds them until the answer is in (a `clone()` for a file, the scheduler's batch for mips):
  the slot goes back to the arena when the tile object is collected.
- `makeCanvas` and `flattenToCanvas` throw above Chromium's canvas limits since E5. Code that needs the whole picture asks
  `bandPlan` / `readBand` / `readBox`, or a row source (`inpaint_bands.js`).
- A copy-on-write copy that takes the original's chain buffer must take ownership, or the last holder writes into it in place.
- A rebuild that asks for chains and then drops them asks again forever; cells are kept per tile version.
- `frozen` too high only costs a copy; too low writes into a shared tile. A release must never let go of pixels the document
  still holds.
- A second walk of the layer stack (like `passStores` beside `drawLayersInto`) is where this design breaks; keep it next to
  `drawLayer`'s branches.

## How the app is put together

- `electron/main/main.js`: window, `scumble://app/` scheme (renderer files) with
  `scumble://app/comfy/*` proxied to the ComfyUI server by `electron/main/comfy.js`
  (auth headers live there; the websocket too, events are forwarded over IPC).
  Same-origin, so `<img>` from `/comfy/view` never taints a canvas.
- `renderer/editor/`: the editor, edited here since C0 and built into the node by
  `python tools/build_node.py` (then `python tools/node_test.py`, commit both repos;
  `docs/BUILD_NODE.md`). `renderer/editor/host.js` is the app side: `api` (fetchApi, apiURL,
  queuePrompt, events) and `host` (recipe, settings targets, generate, autosave, export); the
  node's `js/host.js` answers the same members, and `build_node.py --check` fails when the
  editor calls one that either host lacks. Never edit the node's generated `js/` files.
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
- The assistant: the panel (`renderer/assistant.js`) -> IPC `assistant:*` ->
  `electron/main/assistant/` (the loop, the policy, the four adapters) -> an in-process MCP client
  over `InMemoryTransport` -> the same `createServer` external agents get -> `bridge.js` with
  `meta` (the user-activity wait, the busy check, the turn and its undo step) -> `commands.call`.
  Chats under `<userData>/assistant/`, `docs/ASSISTANT.md`, the plan in `docs/PLAN_ASSISTANT.md`.
- Provider runs: `host.runProvider` (the recipe resolved to the chosen provider's variant by
  `shell.js`) → `renderer/editor/stitch.js` (crop) → IPC `provider:edit` →
  `electron/main/providers/index.js` picks the adapter and the key (`keys.js`) →
  `stitch.js` (composite mask, colour match) → mirror upload → `addResults`. Recipe
  formats in `docs/RECIPES.md`.

## Working rules

- **Test by risk, not by habit (the user, 2026-09-26: "weniger tests").** The user found the testing too heavy and
  decided three tiers; this overrides the "both backends, mutation round, measurement for everything" habit of the
  sessions before. **Full** (both backends, a mutation round, a 15k measurement where it applies): only what can lose
  or corrupt pixels or data - document save / restore and the `.scumble` format, autosave and quit safety, Rust
  kernels, the compositor (blend modes, clipping, groups), export writers. **Normal** (one gate step per new feature on
  the tiles backend plus the existing gates the change directly touches; the canvas backend only when a pixel path
  changed; no mutation round): tools and features - brushes, heal, remove, liquify, layer UI. **Light** (plain-Node
  tests of request shapes, `lint`, `types`, one look in the app; the user judges looks by eye): skins, providers built
  against docs, docs and the manual. Exe gates once per release, not per package. No screenshot gates for looks.
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
