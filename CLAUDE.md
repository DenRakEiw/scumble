# CLAUDE.md — Scumble (desktop app)

Read this first, then `docs/BRIEF.md` (vision, decisions, architecture, phases).
`docs/BUGS.md` is the bug list: what is reported and not fixed, and what has to be
measured before anyone writes code. Put a new report there, not in this file.
`docs/NAMES.md` holds the name research, `docs/RUNPOD.md` the Docker template notes,
`docs/TESTING.md` what each test tool covers and the known flakes.

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

## Where things stand (2026-09-27, night)

The hand-over blocks of before, and the full text of the list below, are in `docs/HISTORY.md` (newest first, verbatim).

**Released:** 0.1.31 is Latest (published 2026-09-27 17:10 CEST; dev blog post `v0-1-31` live). Check `gh release list`
before believing any release state written down anywhere. The 0.1.31 packages (canvas-only view, Undo history, PSD
masks and the mask switch, mask operations, the side panel's width, 23a rotate / flip) are described in the plan's
"Built" paragraphs and in HISTORY.md's block of 2026-09-27 evening.

**The build in progress is 0.1.32 = 23b + package 4 (brushes)**, the user's word of 2026-09-27 ("baue Paket 4 und
23b"); package 5 is 0.1.33. The plan is `docs/PLAN_0_1_31.md` (§7 for 23b with its "23b built" paragraph, §4 for the
brushes). **23b is built and committed locally, not pushed** (CHANGELOG "Unreleased" has it):
- 1b61e27 **the resampler** `renderer/editor/inpaint_resample.js` (pure, integer maths, Catmull-Rom / bilinear,
  `transformed()` on both backends; `tools/resample_test.js` plain Node; `pixels` case `transformed`);
- 47f884e **the pool path** `transformedAsync` (a `resample` worker job per row of destination tiles; 15k store 1.6 s);
- d72925e **one map for the geometry** (`docXf` replaces `docOrient`; guides held by the snapshots; saved selections and
  history entries get `xf`; crop / extend / resize follow; the plugin `geometry` event carries `kind` and `m`; film and
  glb on it) and **text with a free angle** (`text.angle` / `text.box`, `setTextAngle`, the transform tool keeps text);
- e26519f **the straighten** `straightenDocument` / command `straighten_canvas` (one step; 15k with four layers 9.6 s);
- 36afbcd **the pending canvas frame** (`canvasFrame`: Enter / Apply / double click, Esc, aspect presets, lines, the
  straighten line, the tilt preview in the scene draw only).
Gates at 36afbcd: `editor` 82 of 82 on both backends, `glb`, `film`, `mcp`, `commands`, `pixels`, `document`,
`canvasonly`, `lint`, `types`, `node tools/assistant_test.js`, `node tools/resample_test.js`, `node
tools/manual_test.js`. Docs of step 7 (MANUAL, CHANGELOG, DOCUMENTS.md, COMMANDS.md, BUGS.md, the plan) are written.
After the user's answers (Rust kernel yes, the size label stays, 4.10 "weiss ich nicht": build it last and let them
judge it): 725ed72 **the Rust resample kernel** (ABI 11; the straighten at 15k with four layers 5.3 s, was 9.6), and
**the review of 23b** (24 findings confirmed, all fixed in the commit after it; the plan lists them).
**Next:** package 4, brushes (plan §4: measure first, then regional sources, pro smudge with a Rust kernel, clone,
flow / pressure / stabiliser, blur / sharpen, the size cap, frequency separation, dodge and burn; 4.10 the optional
brush panel is still the user's question). Open for the user: whether the Rust resample kernel is worth building (the
straighten's 9.6 s at 15k would drop to about 4 to 5), the size label above the frame that hides under the options bar
when the frame touches the top (judged by eye), LaMa shipped or downloaded (package 5), the PNG switch default, item
25's look and timing. Deferred from 3f: the source's EXIF / XMP in exports, an ICC profile in PSD and TIFF. Not
checked: a double click in Explorer on an installed build, TIFFs from Photoshop / Affinity / Lightroom.

**How the work goes (the user, 2026-09-26):** tests by risk (Working rules); few agents - the main loop builds, one or
two background agents take separate files (a gate, tests against a stated API, docs), one package at a time, a local
commit per step; check the 5-hour window (`mcp__ccd_session_mgmt__get_usage`) and stop at a committed state around 70
to 80 %. A release only on the user's word; everything before it (CHANGELOG, `npm run dist`, exe gates) may be
prepared locally.

## Open threads (condensed on 2026-09-26 from the hand-overs of 2026-09-19 to 2026-09-23)

The full hand-over blocks of those days are in `docs/HISTORY.md`, verbatim. What still matters from them:

**Every release:** the CHANGELOG section first, the version in `package.json`, `npm run dist`, exe gates `--offline` on
both backends (0.1.30's list: `dist/gates/gates/rel30-exe*/summary.txt`), push, tag `v<version>`, `gh run watch` the
tag's build, `gh release edit v<version> --draft=false`, then the manual sync (`node tools/manual_sync.js`) and the dev
blog post (the decisions block above; `time` is the release's `published_at` in German time).

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

The numbered list the user adds to; the numbers stay because other documents cite them. Items 1 to 13 are built (their
text is in `docs/HISTORY.md`, the block of 2026-09-19); the full text of every item below, with the research of 14,
15, 19 and 21, is in `docs/HISTORY.md` "What comes next (the list, as of 2026-09-26, full text)" - read it before
planning one of them.

5. **The object tool's change A** (the image-size label map, `dist/c6map/c/objects.md` §7-§9): parked by the user on
   2026-09-18.
14. **Upscaling** (parked, only listed): through the user's ComfyUI (`UpscaleModelLoader`), in the app on ONNX Runtime,
   or by API (Topaz, Magnific; Magnific's two upscalers exist since 0.1.24). To check first: driving a locally installed
   Topaz by CLI or MCP, where the result lands, the size limits.
15. **Qwen Image Edit 2.1:** the local ComfyUI recipe is built (0.1.23, never run: the models are not downloaded); the
   API side (providers, ids, masks, limits, prices) is open.
16. **Oxen.ai:** built on 2026-09-26 from the docs (`docs/RECIPES.md` "Oxen.ai"), never run live (the user has no key).
17. **A side panel of adjustable width:** built 2026-09-27 (e1791c2): a grip on the left edge, 310 px to 60 % of the
   window, kept per install.
18. **The logo:** drawn for 0.1.27 (`build/icon.svg` and its exports); open: the mascot's other poses, the About dialog,
   the website.
19. **3D layers from AI models** (only listed): image-to-3D (Comfy Router's Meshy / Hunyuan 3D, fal / Replicate TRELLIS,
   a local Hunyuan3D recipe) into the glb plugin's layers. To check first: which models answer a textured GLB, the
   time, the price.
20. **Skins:** built on 2026-09-26 (`docs/SKINS.md`); later, on the user's word: a theme editor, light / dark after the
   OS, a compact density, icon sets.
21. **Lens flares like Flarecore** (optional, rarely used; brainstormed only): a built-in plugin `flare.lens` with five
   element kinds translated from Flarecore (Apache-2.0) and own presets, about 7 to 9 days; no place in the order
   until the user names one.
22. **Nik 9 parity** (not optional; an update of its own): `docs/PLAN_NIK9.md` has the research and the shape (depth
   masks, edges, filters and control points, the 18 missing blend modes; 34-46 days), plus the masks-and-selections and
   the grading-and-panels packages folded in on 2026-09-26 (6.5-12.5 and 11-19.5 days). Suggested after B3.
23. **Rotate and straighten the whole document** (on the later list, the user, 2026-09-26): **23a built 2026-09-27**
   (rotate 90 / 180, flip; `docs/PLAN_0_1_31.md` §7), released in 0.1.31. **23b built 2026-09-27** (straighten by any
   angle with a drawn line, crop presets with lines, the pending frame, text with a free angle; for 0.1.32).
24. **A canvas-only view** (the user, 2026-09-27): **built 2026-09-27** (package 1 of `docs/PLAN_0_1_31.md`). As designed: **Tab** (free in the editor's `onKey`, Photoshop's and Krita's key; F11 stays the
   plain window full screen of the View menu's `togglefullscreen`), Tab again or Escape returns (Escape only when the
   editor has nothing pending: `pending`, `polyPoints`, `shapePoints`). App-only, in `renderer/shell.js` (a capture
   keydown listener like the one for Ctrl+S, not in a text field, not while a dialog is open), so the editor source
   and the node stay as they are: a class on the body hides `#shell-bar`, `#shell-tabs`, the help and assistant
   columns and the editor's chrome (`.ipc-top`, `.ipc-tools`, `.ipc-side`, `.ipc-bottom`, the rulers), `.ipc-view`
   fills the window; the window goes full screen over IPC (remember whether it already was; a `leave-full-screen`
   from F11 or the OS ends the mode); the picture is fitted (a view the user had zoomed is put back on the way out);
   a hint "Tab or Esc to return" fades after a few seconds. A View menu entry "Canvas Only" with `registerAccelerator:
   false` (a registered Tab would reach text fields). Normal tier: a gate step (the chrome hidden, the view the window's
   size, full screen on and back, Tab in a text field ignored, Escape with a pending transform cancels only that).
25. **The app's own dialogs** (asked 2026-09-27; the user's answers open): the native message boxes (`askDocument`
   in `electron/main/main.js`: close / changed / newer / history; `askWhileSaving`) and the eight `window.confirm`
   calls of the renderer as one in-app dialog on the editor's `ask()` modal, main asking the window over IPC with the
   native box as the fallback when it does not answer (a busy or hung renderer). Proposed: the skin's colours, the
   structure protected like the assistant's ask card (`protectAsk`: shadow root, top layer), a new async
   `dialogs.ask()` for plugins beside the old `confirm`. Stay native: the file pickers, the crash dialog. About 1 to
   1.5 days.

## Gate runner and flakes

`bash tools/run_gates.sh <label> [--strict] [--copy] [--tiles on|off] [--offline] [--exe PATH] <gates...>` starts a fresh instance on
port 9555 with its own profile (with `test_base.png`), runs each gate with a timeout, and writes logs and `summary.txt` under
`dist/gates/gates/<label>/` (or `$SCUMBLE_GATES`). `tools/close_app.py` closes an instance by its DevTools port
(`SCUMBLE_CDP_PORT`). Gates: `pixels editor composite commands shape brush film glb ailabel size transparent generate log
mcp nodecopy toapis openrouter ark recipes assistant llm export pxjobs upscale layered platform lint types help skins
magnific oxen quit document docux metadata tiff canvasonly`, plus `docperf:<W>x<H>` (a .scumble save and open at size), `smoke` (a real Flux run; check `/queue` first, and not while the user needs
ComfyUI), `perf:<W>x<H>`, `exportperf:<W>x<H>[,--filter=film.look]`, `tiffperf:<W>x<H>` (a TIFF export and open at size) and `huge:<W>x<H>` (the 30k gate; it refuses to run
against a connected instance). `quit` and `quit:<W>x<H>` start and close their own instances (port +17): a test that
closes the app must send WM_CLOSE, since a page's `window.close()` skips the window's close event. **`--offline` starts the instance with `--no-comfy`**: it does not connect, so no upload is
forwarded to the user's server. A fresh gate profile otherwise connects to `127.0.0.1:8188`, the user's ComfyUI, and
forwards every upload of every gate to its input folder; use `--offline` for everything but `smoke`. Run a change on both backends (`--tiles on` and `--tiles off`); a release also runs against
`dist/win-unpacked/Scumble.exe` with `--exe`, each run on its own profile.

Known flakes: `docs/TESTING.md` "Known flakes". **Re-run a failing gate before believing it** when its step is listed
there; add a new flake there, with the date and what was ruled out.

## Traps worth keeping

**Chromium, canvas, WebGL**
- Chromium applies `UNPACK_PREMULTIPLY_ALPHA_WEBGL` to `ArrayBufferView` uploads too; set both unpack switches explicitly
  before every typed-array upload, or premultiplied tile bytes get premultiplied twice.
- Once at least 100 `getImageData` calls have disabled acceleration and they reach 95 % of all canvases created, Chromium
  makes every new canvas software; a test with a readback after every step can trip it.
- `globalCompositeOperation` `copy` and `destination-in` apply to the whole canvas; a regional use needs `clip()` first (the
  vanishing-layer bug of 0.1.8).
- `drawImage` with `copy` and image smoothing on changes pixels by up to 2 levels even at the same size and whole offsets
  (a GPU canvas into a CPU one, measured 2026-09-26); `source-over` or smoothing off gives the bytes. `canvasRows` sets
  smoothing off.
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
- A test that starts the exe from Python needs its absolute path: `subprocess` with the runner's relative
  `dist/win-unpacked/Scumble.exe` fails with WinError 2 (`docux`, 2026-09-27).

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
- The tools' Python has tifffile without `imagecodecs`: it writes no LZW, PackBits or zstd and cannot pack 1 / 2 / 4
  bits; Pillow writes LZW (`tiff_lzw`) and PackBits, `tools/tiff_fixtures.py` builds the rest by hand.
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
- Documents (`.scumble`): `host.saveDocument` / `openDocument` (`renderer/editor/host.js`: `flushEditor` uploads the
  edited layers first, `documentDirty` / `settleKey` keep the "*", `rememberClosed` / `reopenClosed` the closed tabs)
  -> IPC `documents:*` -> `electron/main/documents.js` (a job per request, a lock per path, `idle()` for the quit) ->
  `electron/main/docfile.js` (the stored zip, temp file and rename, the mirror import). `docs/DOCUMENTS.md`.
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
- Test with real runs: a dev instance `./node_modules/.bin/electron . --remote-debugging-port=9555
  --user-data-dir=<scratch> --no-comfy` (the Bash tool's `run_in_background`; 9333 is the node's headless tab), then
  `python tools/cdp.py eval|shot|log`, and `SCUMBLE_CDP_PORT=9555 python tools/close_app.py` to close it. Scripted waits
  use `setTimeout`, never `requestAnimationFrame` (it stops in a hidden window). One instance at a time: stop the dev
  instance before starting `dist/win-unpacked/Scumble.exe`. What each test tool covers: `docs/TESTING.md`.
- Answer in German; code, comments and docs in English.
