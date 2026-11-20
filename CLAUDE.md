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
  `/object_info/InpaintCanvas` and, when the pack is missing, only tells the user to install it (the status line,
  *Settings › ComfyUI* Test); it installs nothing itself, there is no Manager install in the code. Node 0.4.1 is
  Active on the Comfy Registry (read 2026-11-07; 0.4.0 stays flagged, 0.3.4 was Active before it), but
  ComfyUI-Manager's search does not list it: the Manager builds its list from `custom-node-list.json` and only enriches
  those entries with Registry data, so a Registry-only pack is not shown (read 2026-10-18 for QW3, `docs/BUGS.md`; an
  install by id would work). Public texts give the `git clone` line and say the Manager does not list the pack (README,
  manual) until the Manager PR (`dist/node_release/MANAGER_PR.md`, on the user's word) lands.
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
- Release channel: **GitHub Releases** of `DenRakEiw/scumble` (public); `electron-updater` reads `latest.yml`; a
  `v<version>` tag (matching `package.json`) builds a **draft** release in CI, and publishing it makes it visible.
  **Every release needs its CHANGELOG section first** (the tag build fails without it; the app shows the same text).
  Installers are **unsigned**; signing goes **the Microsoft Store first** (an MSIX re-signed by Microsoft; the GitHub
  installer stays unsigned; `runFullTrust`, no self-update, MCP by the execution alias), **then the SignPath
  Foundation** (free for OSS; fallback Certum; Azure Trusted Signing is paid and not for EU individuals).
  `docs/CODE_SIGNING_POLICY.md`, `docs/STORE.md`.
- **Every published release also gets a dev blog post** on https://www.denrakeiw.com/scumble/blog (repo
  `F:\portfolio_web`, deployed by a Vercel Hobby account). **Read `docs/RELEASING.md` before a release**: the whole
  chain, the post's shape, and the Vercel trap (commit the website with its own identity, never the `DenRakEiw`
  noreply address of this repo, and no `Co-Authored-By` trailer: a second author blocks a Hobby deploy).

## Where things stand (2026-11-19: 0.1.58 released; the Store update open)

The hand-overs of 2026-10-13 to 2026-11-19 (0.1.47 to 0.1.58) are in `docs/HISTORY.md`, verbatim, under "Where things
stand, 2026-10-13 to 2026-11-19" (moved on 2026-11-19; the user: "kannst du nochmal die claude.md aufräumen"). Read a
release's block there before touching what it built. Check `gh release list` before believing any release state
written down anywhere.

**The state**
- **0.1.58 is out** (2026-11-18, tag v0.1.58 on `85ea5c9f`): Stay on surface for brush, eraser and bucket on Deep
  paint layers, the fix of issue #15 (a helper job ends its wait when ComfyUI is gone,
  `renderer/editor/host_helperwatch.js`), a small package of item 73, the assistant's `clip` question. The post
  `v0-1-58` is live with the manual sync, the MCP Registry has 0.1.58, the node's editor is pushed
  (`ComfyUI-InpaintCanvas` `d8fc370`, no pyproject bump), `INPAINT_CANVAS_REF` moved. After the tag `main` holds only
  the RunPod ref, `server.json` and docs; `main` equals origin.
- **Unreleased on `main`** (2026-11-20, CHANGELOG "Unreleased"): the assistant's step limit is 100 by default
  instead of 25 (the field takes up to 1,000; every call counts, reads too), a turn that reaches it shows a
  *Continue* button, and the next message's state note tells the model that its turn was cut short (`chat.capped`,
  `prompt.stateNote`). The user's report: "längere agentic tasks funktionieren nicht richtig". Item 75 belongs to the
  same update.
- **The releases since 0.1.47, one line each** (CHANGELOG has the text, HISTORY the hand-over): 0.1.48 status and
  feedback (red error lines, the progress bar, prompts from the history); 0.1.49 Comfy Cloud and Comfy Router on
  Comfy's SDK, FLUX 3 Klein and boxes on the user's ComfyUI; 0.1.50 MOSS-Image with boxes, the Klein prompt upsampler;
  0.1.51 large exports saved in pieces, two skins; 0.1.52 green screen keying through ComfyUI (CorridorKey 2.0),
  LoRAs, GPT Image 2.6, P-H3-Image; 0.1.53 Each area, Krea 3 Edit, the ONNX helpers in their own process; 0.1.54 the
  kernel release (`docs/PLAN_WASM_BUILD.md`, done), MiniMax-H3-Image, Split into layers; 0.1.55 new work in a tab of
  its own, Settings kept per recipe, requests through curl, the long files split (item 56); 0.1.56 Deep paint;
  0.1.57 Generate the new border after an extend, layers that name themselves (Florence-2), one undo step per result,
  the scope, a frame from a video, the contact shadow, the mannequin; 0.1.58 above.
- **GitHub:** the branches `main` and `gh-pages`; open issues #14 (item 74, the reply owed) and #8 (waits for
  Blueforcer/ComfyUI-DLSS5-Enhancer#17, open and unreviewed on 2026-11-19); #15 closed 2026-11-19. Local only:
  `demo-video` (the private demo-video commits, never pushed), `archive/k2-inflate-z`, six merged
  `worktree-agent-*` branches with their worktrees under `.claude/worktrees/`.
- **The user's machine:** ComfyUI v0.45.2 since 2026-11-11 (flags `--windows-standalone-build --enable-cors-header
  --enable-manager`; three packs fail at import as before: `dlss`, `inpaint`, `comfyui-tosvg`); the live node folder
  is at `f7f278f` (the 0.1.57 editor); the node on the Comfy Registry is 0.4.1, Active; the Store's live version is
  0.1.57.
- **Counts:** 124 MCP tools. `mcp-publisher` 1.8.1 lay in session `2d41a0a1`'s scratchpad `mcppub/` (a scratchpad can
  be gone: download it again then).

**Open: the user's step or word**
- **The Store update for 0.1.58:** `dist/Scumble-0.1.58.msix` with `dist/store-listing/whats-new-0.1.58.txt` (the
  user's upload).
- **The live node folder** to `d8fc370` (a fast-forward; it reloads the node in the running ComfyUI).
- **The six merged agent worktrees** and their `worktree-agent-*` branches: remove them (asked, no answer; a
  `node_modules` junction goes first with `cmd //c rmdir`).
- **The reply on issue #14** (item 74).
- **The user's own test of Stay on surface** on the arm picture (a hand flat on the wall is the hard case); a fix goes
  into the next update. Reaching a part of the surface cut off by what stands in front is not built
  (`docs/BUGS.md`; the way left is SAM2's object map).
- **U2 of item 55** (SAM2's speed: the 15k shapes at the map's size, the automask's JavaScript) once the RTX 5090 is
  free; `docs/PLAN_HELPERS_PROCESS.md` §4 and the questions of its §6.
- **Questions never answered** (their text is in HISTORY's copy of the list): items 57, 58, 59 and 69, H1 (ids made
  safe against settings stored under an old id, the ORA 64:1 budget), a repair tool for PNGs cut short (R1), the 21
  of `docs/PLAN_VARIANTS.md` §10, the four of `docs/PLAN_CORRIDORKEY.md` §5 "Stop A", whether *Each area* goes into
  the ComfyUI node.
- **Smaller:** the download of Fibo 2.0 Edit Turbo's file and its live run (asked); short loops of the Lighthouse
  Academy clip for GIF sites (offered; `dist/lighthouse/`); the replies on node issues #1 and #2 (drafts on request);
  the node's untracked CLAUDE.md (`dist/node_boxes_CLAUDE_update.md`); the holding folder
  `F:\_scumble_aufraeumen_2026-10-13` is the user's to delete.
- **The parked Neural Rendering reimplementations** (item 37): read again on 2026-11-19 for Linux and the Mac
  (`docs/PLAN_RTX_VSR.md` "Checked again 2026-11-19"); the user asked whether MLX-DLSS could carry a Realism Pass on
  Linux and a Mac build. Still parked: the weights can be neither shipped nor linked; reopening it is the user's
  decision.

**Built from docs or against mocks, never run live** (say so in public texts; a live run needs the user's key or
ComfyUI): the #15 fix against a real ComfyUI restart; item 73's package against any provider; Seedream 5.5 on
WaveSpeedAI, Comfy Cloud, ToAPIs and Oxen.ai (Comfy Router and OpenRouter ran, the user, 2026-11-16); *Split into
layers* on every host; MiniMax's own API and `minimax_h3_image_local` (its models are on the user's ComfyUI); P-H3-Image;
Fibo 2.0 Edit Turbo; Krea 3 Edit on any host; GPT Image 2.6; item 66 (Parameters in the
ComfyUI window's bar) on a real ComfyUI page; the node's `box_prompt` rows through *Flux 3 Image*
(`docs/PLAN_NODE_BOXES.md` §8 step 4); the `huge` gate (30k) was skipped at 0.1.48, no run is recorded since.

**Where the records are**
- Plans with an "as built" per session: `docs/PLAN_WASM_BUILD.md` (the kernels, all sessions done; K2 and K35 decided
  without code), `PLAN_SPLIT.md` (item 56), `PLAN_SURFACE_PAINT.md` (Deep paint), `PLAN_0_1_57.md`,
  `PLAN_HELPERS_PROCESS.md`, `PLAN_LORAS.md`, `PLAN_CORRIDORKEY.md`, `PLAN_COMFY_SDK.md`, `PLAN_0_1_50.md`,
  `PLAN_0_1_48.md`, `PLAN_NODE_BOXES.md`, `PLAN_RELIGHT_FIXES.md`, `PLAN_VARIANTS.md` (item 60, not built).
- Reviews: `docs/research/review_fable_2026-11-16/` (138 confirmed; what is left is item 73),
  `review_full_2026-11-12/` (54 confirmed, all fixed), `review_full_2026-11-07/` (its six musts fixed; its shoulds were
  not tracked after that: check each against today's code before working on it), `review_external_2026-11-07/`.
- Measurements: `docs/measurements/<step>_<date>/`. A dated snapshot of open items: `docs/OPEN_2026-10-13.md` (not
  kept up to date; `docs/BUGS.md` and this file are the living lists).
- A second agent account built parts of 0.1.53 and 0.1.54 under the protocol in `.claude/coord/` (untracked: README,
  `rules.md`, a folder per task, `tools/`); those agents are stopped.

**The videos:** parts one to four are on YouTube and the website (part four: https://www.youtube.com/watch?v=ZisUgWl_FO0;
`docs/TUTORIAL.md` §7). Waiting for the user: the tally "about $1.20" against the Black Forest Labs dashboard; the
commit of the material (`docs/images/video/`, `docs/images/tutorial/`) only on the user's word. A re-cut of parts one
to four is not possible from `dist/video` (the intermediates went to the holding folder on 2026-10-13).

**Flathub** (flathub/flathub#10589): closed 2026-10-10 by a reviewer for a wrong AI disclosure. Flathub's policy
forbids AI-written manifests, PR texts and replies, so Claude helps with the facts and the Linux test, never with the
submission itself (memory `flathub-ai-policy`).

**The B-Side agent (2026-10-11):** the user registered "Claude in Scumble" on The AI Art Magazine's agent platform
(space.art-magazine.ai; the key in `dist/live-keys/bside_claude.txt`, pasted in chat once, to be rotated after the
submission); the profile is complete through the API (role, architecture, autonomy 3, the Scumble icon as the
picture, the repo as the website). `/open-call` says no call for agents yet: when it opens, the work (category
Image, made in Scumble over MCP in a document of its own) and the texts go up, and the close happens only after the
user's yes in chat. The A-side open call (humans, no theme, no fee, deadline 2026-11-01) is the user's own choice.

**Still open from 0.1.43 to 0.1.46** (their hand-over blocks, and the relight build's first review, moved to
`docs/HISTORY.md` on 2026-10-13; the rest of them is done):
- **P3's live run** (`bash tools/run_gates.sh rel42-portable --exe dist/win-unpacked/Scumble.exe portable`) once the
  user's Scumble is closed; `dist/win-unpacked` is the Store layout now, so `npm run dist` first.
- Tell the user (open since 0.1.42): their DLSS5 Fit Input Size node allows 33 MP outputs, above Scumble's 27.9 MP.
- A live run of Nano Banana 2.1 (about $0.05 at 2K with the user's key) settles v1 / v1beta and the thinking level's
  spelling (`docs/PLAN_0_1_43.md` §5); the ComfyUI window's layout was never seen in a real ComfyUI page.
- R2-S15c: the 15k `exportperf` of lens blur (on the GPU since 0.1.46) before the aperture-cap decision.
- winget-pkgs#450107: after the merge, `winget show scumble` against the Store app (the short name may be ambiguous).
- The GitHub MCP registry: onboarding requested in github/github-mcp-server#1257 (2026-10-10), no answer on 2026-10-13.
  Smithery is out (HTTP servers only, `docs/PLAN_MCP_LISTINGS.md`).

Older hand-overs, the full text of the list and of the open threads are in `docs/HISTORY.md` (newest first,
verbatim). Check `gh release list` before believing any release state written down anywhere.

**Still asked, waiting for the user's word:**
- **The user asked earlier** whether a GitHub community setup makes sense (Discussions with Showcase / Ideas / Q&A /
  Workflow recipes, a Now / Next / Later / Won't do roadmap, 3-5 good first issues, CONTRIBUTING / issue templates /
  SECURITY, a pinned "Share your workflow" thread). Answered: yes to Discussions, the templates, CONTRIBUTING and
  SECURITY, a small roadmap as one pinned issue or discussion without other products' names, kept with each release;
  good first issues only if outside PRs are wanted; the pinned thread once Discussions are on and seeded. **Nothing
  done, waiting for the user's pick** (outward-facing; its own section after a commit).
- **Asked earlier, still waiting for the user's word:** the README for reach (the GIF, the badges and the "Get Scumble"
  table are in since, `README.md` near 17-37; open: a comparison table, Discussions), how to post on Show HN (the
  comparison table names other products, the user's rule of 2026-09-29).

**One section per session, then `/clear` (the user, 2026-09-30: "immer clear nach abschnitten"; before: at most two
build steps, 2026-09-28):** one numbered step of the plan, its commit and the hand-over, then stop. the context rose to 85 % in
one session of eight steps (its own tool output and patch scripts, not this file); commit, write the hand-over, stop.
Read maps and code with grep and offsets, edit with Edit rather than long patch scripts, keep gate output to a summary.

**How the work goes (the user, 2026-09-26):** tests by risk (Working rules); few agents - the main loop builds, one or
two background agents take separate files (a gate, tests against a stated API, docs), one package at a time, a local
commit per step; check the 5-hour window (`mcp__ccd_session_mgmt__get_usage`) and stop at a committed state around 70
to 80 %. A release only on the user's word; everything before it (CHANGELOG, `npm run dist`, exe gates) may be
prepared locally.

**Background agents (the user, 2026-11-06 / 07: more parallel agents again).** Each in its own worktree
(`isolation: "worktree"`, a `node_modules` junction, which goes with `cmd //c rmdir` before the worktree is removed),
its own DevTools port, `--offline`, the busy lock for timed and GPU runs, DenRakEiw commits without a trailer, no push,
no edits to `CHANGELOG.md` or `CLAUDE.md` (the CHANGELOG line goes into its report). The main loop reads or reviews
each diff (a review workflow only for what writes files or pixels; reviews are the real cost), merges one branch at a
time and runs the merged state's gates on both backends. A `/clear` ends running background agents.

## Open threads

The full text is in `docs/HISTORY.md` ("Open threads", moved there on 2026-09-27 night).
- **The Store listing is live** (the user, 2026-09-30: https://apps.microsoft.com/detail/9NDBTNNMXF2R, signed by
  Microsoft; identity `DenRakEiw.Scumble`). The README links it (Install (Windows): Store or GitHub), the website hub too since 0.1.38
  (2026-10-03, with the post). Submission 1 (2026-09-30) held the first Store version; **0.1.41 was submitted
  2026-10-04 (submission 2, the user in Partner Center: the MSIX built here, the What's new text, the trailer
  "Scumble explained" with `dist/store-listing/hero-1920x1080.png` as its thumbnail); 0.1.42 followed and is the
  live Store version (the listing, read 2026-10-07).**
  **A Store update with every release, clicked through in the user's Chrome** (the user, 2026-10-04: first "nur nach
  essenziellen änderungen", then "wenn du es in chrome machen kannst dann doch jedes mal"; the submission API needs a
  company account, the user's is not one): `npm run dist:store`, a What's new text, then Claude in Chrome in Partner
  Center (the user logged in; the upload of the ~190 MB MSIX through the extension never tried yet; *Submit for
  certification* only after the user's yes in chat each time). If the upload does not work: essential changes only,
  the user's three steps by hand (`docs/RELEASING.md`).
- **The GitHub Pages site** (2026-10-10, a Discord comment asked for a github.io page): https://denrakeiw.github.io/scumble/,
  one `index.html` on the branch `gh-pages` (downloads, what it does, links to the hub, manual, videos, blog, MCP docs;
  canonical to the hub, which stays the one source). Update: edit `index.html` on `gh-pages` and push; Pages rebuilds
  in a minute. A `scumble.github.io` would need a GitHub organisation named scumble (not made).
- **Not started:** B3, the macOS build (`docs/PLAN_0_1_24.md`); Comfy Router
  live runs beyond GPT Image 2, Nano Banana 2 (2026-09-23) and FLUX 3 Image (2026-10-03; the key in `dist/live-keys`); Linux built by CI, never run; types stage 3 (`docs/PLAN_TYPES.md`);
  the manual's empty assistant and log screenshots and a missing colour-match figure (`docs/MANUAL.md` is the one
  source, the website copies it via `tools/manual_sync.js`); the node repo is behind (build it only when a node version
  ships; `nodecopy` tests it); the assistant's A10 / A11 only on the user's word.
- **Material:** *Settings > API providers* shows the last four characters of stored keys: mask them in any screenshot
  for the web. The tutorial material (`docs/TUTORIAL.md`, `docs/images/tutorial/`, `docs/images/video/`) stays
  uncommitted until the user says so.
- **Standing:** the user's ComfyUI (8188) is a production machine (no `smoke` and no forwarding gate unless the user
  says it is free; gates run `--offline`). Tune for 15k, not 30k. One-channel masks on ice; the long files are split as
  item 56 says (the user, 2026-11-07); the object tool's change A parked; tiles are the default, the canvas
  backend the escape hatch. A parked idea, not a plan: a mobile companion.
- **Unverified:** ToAPIs beyond GPT Image 2's `standard` / `vip` channels (those ran live through this adapter in
  ToAPIs' own run of 2026-10-13, issue #5: a new image and whole-picture reference edits; channel `official` with the
  mask and the canvas round trip not; `docs/RECIPES.md`) and ModelArk live; OpenRouter beyond GPT Image 2.5 Flare / Sunburst and FLUX 3 Image (live 2026-10-03); Magnific beyond the two
  upscalers and Oxen (docs only); the five generative relight routes (built from docs, tested against mocks only); a real SAM2 / RMBG model
  on the slice 6 code; the user's own 15k file. Deferred from 3f: the source's EXIF / XMP in exports, an ICC profile in
  PSD and TIFF. Not checked: a double click in Explorer on an installed build, TIFFs written by other image editors.

## What comes next (the list)

The numbered list the user adds to (the numbers are cited elsewhere). This is the short form. **The full text and
research of every item is in `docs/HISTORY.md`**: "What comes next (the list), the full text as CLAUDE.md held it on
2026-11-19" for everything below, and the older full copies there for items 1-27. Read an item's full text before
planning it. A new item gets its number and a few lines here; its research goes into a plan under `docs/`.

**Open, parked or on hold**
- 5: the object tool's change A (the image-size label map, `dist/c6map/c/objects.md` §7-§9). Parked.
- 14: upscaling beyond the API upscalers. RTX VSR (local and Comfy Cloud) and the whole picture for local upscale
  recipes shipped in 0.1.42; the in-app ONNX upscaler (U3) and Topaz direct / CLI (U4) are parked.
- 15: Qwen Image Edit 2.1: the local recipes ran live (0.1.45, the Turbo one 0.1.46); the API side is open.
- 16: Oxen.ai: built from the docs, never run (no key).
- 19: 3D layers from AI models (Meshy / Hunyuan 3D / TRELLIS into glb layers). Only listed.
- 21: lens flares (an optional plugin, 7-9 days). No place in the order yet.
- 22: the filter suite (`docs/PLAN_NIK9.md`, `docs/PLAN_NIK9_BUILD.md`): releases 1 to 4 shipped in 0.1.44 to 0.1.46;
  whether the plan's optional sessions were built is not checked against the code.
- 27: groups with their own opacity and blend mode (isolated groups, 7-9 days). Parked, someday maybe.
- 30: Ideogram 4 as an update of its own: Ideogram's own API as a direct adapter, a local recipe on the open weights.
  Not researched in depth.
- 36: the portable zip ships since 0.1.42; **P3, the `portable` gate on the exe, is open** (on the user's word).
- 37: the Realism Pass shipped in 0.1.42. The open reimplementations of the network are **parked until there is a
  cleaner way** (`docs/PLAN_RTX_VSR.md` last sections, read again 2026-11-19).
- 38: new MCP commands: 12 of the 28 candidates shipped in 0.1.42; the other 16 wait (`docs/PLAN_MCP_COMMANDS.md`).
- 43: relight shipped in 0.1.47, on the surface maps since 0.1.56. Open (phase 2): a perspective camera, horizon AO,
  gobos from a layer's mask, N3's 15k numbers with lights on; the five generative routes never ran live.
- 44: grow the Rust kernels, no rewrite: the kernel update shipped in 0.1.54 (`docs/PLAN_WASM_BUILD.md`). New kernels
  by the same rules: measure first, the JS kernel stays the reference and fallback, one kernel per session.
- 48: Canva Craft as an image model: text to image only, behind OAuth and a preview endpoint that public integrations
  may not use. Not planned.
- 49: CorridorKey 2.0: the route through the user's ComfyUI shipped in 0.1.52. **The in-app route** failed its spike
  (DirectML refuses stage 1, WebGPU misses parity) and is a later update on the user's word
  (`docs/PLAN_CORRIDORKEY.md` §5 "Stop A"). Corridor's word (2026-10-24): free software may implement it; a commercial
  version needs an agreement with them first.
- 52: P-H3-Image shipped in 0.1.52; its live run is on the user's word. The MiniMax H3 Community License excludes the
  EU, the UK, South Korea and the US; the user knows and went ahead, the recipe and the docs carry one plain line.
- 53: Mirage (Cactus Compute) beside SAM2 / SAM3: the spike of 2026-11-16 found only its OCR line boxes useful
  (`docs/research/mirage_spike_2026-11-16/`). **On hold**, stays on this list.
- 55: the ONNX helpers off the main process: U0 and U1 shipped in 0.1.53. Open: U2 and `warmObjects`
  (`docs/PLAN_HELPERS_PROCESS.md` §4, the questions of its §6).
- 60: variants on a result layer, and compare against what lies below: planned, not built (`docs/PLAN_VARIANTS.md`,
  sessions V0-V6, about 7.5-10 days inferred, 21 questions in its §10; re-read its anchors at V0, the files were split
  since).
- 64: a harmonization model against colour match: PCT-Net tested, not clearly better
  (`docs/research/harmonize_2026-11-16/`). **On hold**, stays on this list.
- 70: `fitEdges` in Rust (K35). Parked, someday maybe: 15-25 ms to win on a standalone *Match edges*.
- 71: Split into layers shipped in 0.1.54 (`split_layers`, the recipe's chosen provider since 0.1.55), never run live.
  Known limit in `docs/BUGS.md`: the answer is lost when the window goes away during the run.
- 72: Deep paint shipped in 0.1.56 (`docs/PLAN_SURFACE_PAINT.md`), Stay on surface in 0.1.58. Its limits are in
  `docs/BUGS.md` ("Deep paint: small points"; the border as coarse as the 768 px map; only connected parts of a
  surface).
- 73: the rest of the whole-code review of 2026-11-16 (`docs/research/review_fable_2026-11-16/verified.json`): the 3
  musts and the shoulds on data, money and security shipped in 0.1.57, a small package in `electron/**` and
  `recipes/**` in 0.1.58. Left: the shoulds under `renderer/`, the larger ones, the 58 nice. Verify each against the
  code first.
- 74: an automated tile upscaler / refiner (the user, 2026-11-18, as the answer to issue #14): the picture split into
  overlapping tiles small enough for the model to render at full detail, each refined on its own and put back
  together, one general prompt or one a vision model writes per tile. Pieces that exist: *Each area* (item 54),
  Florence-2's `describe` (item 62), edge fit and colour match per result. Not planned. hwatik's answer
  (2026-11-18): he wants the single click, a brush with a radius, one click on a spot (an eye), redrawn in about 2 s
  with Flux.2 Klein. The user is not keen on that as a tool of its own (2026-11-19): a selection, a prompt and
  Generate do it in three steps today. The reply on #14 is not written yet.
- 75: auto-approve for the assistant, as an option (the user, 2026-11-20: "der agent fragt zu viel ... automatisch
  alles approved als option"; for the next update). Today `electron/main/assistant/policy.js` `decide` answers
  auto / ask / refuse per call and `index.js` waits for the card's answer on every ask. The asks are of five kinds:
  paid or queued runs, changes Ctrl+Z takes back (a layer the user made, the whole picture), changes it does not
  (`load_image`, `new_canvas`, `generate_new`, `close_document`, `delete_snapshot`, `cancel_run`), the disk (reading a
  file, an export, `save_document`) and global settings that are saved. Proposed, not decided: a setting with levels
  (ask as today / approve what can be undone / approve everything), "Allow for this chat" on a card, a cap on paid
  runs per turn, the refusals untouched, every auto-approved call still shown as a card with its reason. The risk to
  say plainly: the model reads layer names, file names and text in the picture, so with everything approved such
  text can make it spend money or overwrite a file. Not planned in detail, not built.
- Not numbered: **B3, the macOS build** (`docs/PLAN_0_1_24.md`; the user tests on their MacBook, a friend signs and
  releases, memory `scumble-macos-friend`; the public texts say "coming soon"). Linux is built by CI and was never
  run. Types stage 3 (`docs/PLAN_TYPES.md`). A parked idea, not a plan: a mobile companion.

**Shipped** (the release in brackets; what stayed open of an item is in the list above)
- 1-13, 17 (the side panel's width), 18 (the logo; open: the mascot's other poses, the About dialog, the website), 20
  (skins; later on the user's word: a theme editor, light / dark after the OS, density, icon sets), 23, 24 (the
  canvas-only view), 25 (the app's own dialogs, 0.1.36), 26 (`@img1` reference tokens, 0.1.34), FLUX 3 Image (not
  numbered, 0.1.36).
- 28 (boxes in the prompt for FLUX 3 and Ideogram 4, 0.1.37 and 0.1.39), 29 (FLUX 3 on Comfy Router, OpenRouter, fal,
  Oxen, WaveSpeed, 0.1.38 and 0.1.39), 31 (Ideogram 4.5, 0.1.37, never run live), 32 (the update dialog, 0.1.38), 33
  (a colour per box, describing a box on the canvas, 0.1.38), 34 (Generate new with presets and boxes, 0.1.46), 35
  (ComfyUI in a window of Scumble, 0.1.41).
- 39 (the tidier Settings dialog), 40 (the star and share links), 41 (Nano Banana 2.1; its live run is open), all
  0.1.43; 42 (Match edges, built 2026-10-08); 45 (red error lines) and 46 (the logo in Brainfuck), 0.1.48; 47 (MOSS-Image with
  boxes, 0.1.50).
- 50 (LoRAs on the user's ComfyUI and Comfy Cloud, MOSS Image Edit) and 51 (GPT Image 2.6), 0.1.52; 54 (Each area,
  0.1.53; not in the ComfyUI node); 56 (the long files split, 0.1.55; `docs/PLAN_SPLIT.md`).
- 57 (filter sizes follow a resize), 58 (the eyedropper's Size), 59 (smart guides to other layers) and 69
  (`Scumble --run`), 0.1.53; each has unanswered questions for the user.
- 61 (the contact shadow), 62 (Florence-2: layer names and `describe`), 63 (Generate the new border after an extend),
  65 (the scope and the clipping warning on Alt+J), 66 (a node's input as a recipe row from the ComfyUI window), 67
  (the mannequin in the glb plugin), 68 (a frame from a video), all 0.1.57.

## Gate runner and flakes

`bash tools/run_gates.sh <label> [--strict] [--copy] [--tiles on|off] [--offline] [--exe PATH] <gates...>` starts a fresh instance on
port 9555 with its own profile (with `test_base.png`), runs each gate with a timeout, and writes logs and `summary.txt` under
`dist/gates/gates/<label>/` (or `$SCUMBLE_GATES`). **Never give the runner port 9576** (the `cloudjobs` gate takes it
for its own instances), and no run on 9555 while a hand-test instance of the user's is open there (it closes it). Quick
rounds: `PX_ONLY` for `tools/px_test.js`, `tools/mutation_round.py` (`docs/TESTING.md` "Faster runs without less
coverage"). `tools/close_app.py` closes an instance by its DevTools port
(`SCUMBLE_CDP_PORT`). Gates: `pixels editor composite commands shape brush film glb ailabel size transparent generate log
mcp nodecopy toapis openrouter ark recipes assistant llm export pxjobs upscale layered platform lint types help skins
magnific oxen quit document docux metadata tiff canvasonly clip groups comfyview portable selection limit maps depth maskview edges depthfx grading masks effects mcpb blendmodes relight cloudjobs loras key areas cli helpers deeppaint wrap`, plus `docperf:<W>x<H>` (a .scumble save and open at size), `smoke` (a real Flux run; check `/queue` first, and not while the user needs
ComfyUI), `perf:<W>x<H>`, `exportperf:<W>x<H>[,--filter=film.look]`, `tiffperf:<W>x<H>` (a TIFF export and open at size) and `huge:<W>x<H>` (the 30k gate; it refuses to run
against a connected instance). `quit` and `quit:<W>x<H>` start and close their own instances (port +17): a test that
closes the app must send WM_CLOSE, since a page's `window.close()` skips the window's close event. **`--offline` starts the instance with `--no-comfy`**: it does not connect, so no upload is
forwarded to the user's server. A fresh gate profile otherwise connects to `127.0.0.1:8188`, the user's ComfyUI, and
forwards every upload of every gate to its input folder; use `--offline` for everything but `smoke`. Run a change on both backends (`--tiles on` and `--tiles off`); a release also runs against
`dist/win-unpacked/Scumble.exe` with `--exe`, each run on its own profile. **Both backends side by side:**
`bash tools/run_gates_both.sh <label> [--ports T,C,...] [--lock PATH] [--shards N] --offline <gates>`; `--shards 2` with
four ports runs the `editor` gate as consecutive groups on separate instances (203 -> 130 s for both backends, every step
exactly once, `tools/editor_shards.py`; since 2026-11-08): for iterating only, **the full sequential run before a merge
or a release** (a sharded run misses cumulative effects: memory growth, Chromium's acceleration latch, late caps;
`docs/TESTING.md` "The editor gate in shards").

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
- A `contenteditable="plaintext-only"` element gets no `getTargetRanges()` for deletes (Backspace: `[]`, measured
  2026-09-29): the prompt field computes every delete from its own string. `innerText` breaks lines around flex items and
  absolutely positioned elements (both are blockified): a chip that `innerText` must read as `@img1` is `inline-block`
  with `inline-block` children.
- A popup that opens under a resting pointer gets `pointerenter` / `pointermove` from Chromium's move of no distance
  after the layout (measured 2026-09-29, the @ picker's rows): hover-select on `pointermove` with a non-zero
  `movementX` / `movementY`, or the row under the mouse steals Enter.
- `texSubImage2D` and `readPixels` take a view on a `SharedArrayBuffer` here (Electron's Chromium): no copy between the
  workers' buffer and the GPU (B item 7 part 2). 572 MB go up in 0.1 s and come back in 0.2 s, on the main thread.

**Electron and Windows**
- `session.webRequest` headers reach a page's websocket handshake only when the URL filter names the `ws://` /
  `wss://` origin beside the `http(s)://` one (measured 2026-10-03, Electron 44.2.0; a `login` answer covers the
  websocket by itself). `Menu.setApplicationMenu` puts the menu on every window on Windows and Linux, a `BaseWindow`
  included: a window that must not fire Scumble's accelerators drops it again after every `buildMenu` and sets
  `setIgnoreMenuShortcuts(true)` on its views (`comfyview.js`).
- An occluded window (a gate behind other windows) reports `visibilityState` "hidden" and drops keys sent with
  CDP `Input.dispatchKeyEvent` unless `Emulation.setFocusEmulationEnabled` is on; a key into the editor's page
  reaches no menu accelerator while another Scumble window has the focus.
- electron-updater installs a downloaded update on every normal quit (`autoInstallOnAppQuit`, on by default) and adds
  that quit handler only when a download ends with the switch on: a Skip has to turn it off in main, and a Skip taken
  back has to add the handler (`updater.js` `_applySkip`, 6.8.9).
- Claude Desktop runs a `node` extension server in an Electron UtilityProcess whose `nodeHost.js` replaces
  `process.stdout.write` and `process.stdin` by MessagePort messages and loads the entry with `import()`: a child
  spawned with `stdio: "inherit"` answers nobody, and `require.main === module` is never true (the `.mcpb` starter,
  `docs/PLAN_MCPB.md` §1; measured 2026-10-09).
- In the main process `process.stdin` never emits `data` from a pipe (read fd 0 with `fs.createReadStream`); Electron prints
  a CR LF to stdout before any JS runs (hence the MCP launcher); a window created hidden stays hidden after `show()`,
  `restore()` brings it up.
- Electron has no `window.prompt`; the editor has its own `ask()` modal.
- Only one instance runs per data folder (single-instance lock and named pipe), including headless `--mcp`
  instances; a portable copy has its own data folder, so it runs beside an installed one.
- `npm run dist:store` rewrites `dist/win-unpacked` without `resources\app-update.yml` (`npm run dist` writes it):
  `npm run dist:portable` goes between the two, and refuses a `win-unpacked` without the feed. Git Bash's `tar` is
  GNU tar and writes no zip; `%SystemRoot%\System32\tar.exe -a -c -f x.zip` (bsdtar) does, and Explorer's zip
  handler unpacks it (measured 2026-10-05).
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

**Comfy SDK (`@comfyorg/sdk`, `docs/PLAN_COMFY_SDK.md` section 6)**
- It is ESM-only and main loads it through `require(esm)`: a release with top-level await breaks that. Pin it exactly
  and check after every upgrade that the packaged exe requires it from inside `app.asar` (S0's check).
- The class client takes its base URL only from `COMFY_BASE_URL`, and its key falls back to `COMFY_API_KEY` (read
  2026-10-18): a shell's value would send the user's key elsewhere. `main.js` clears them at start (`clearEnv`);
  never put a key into `process.env`.
- `comfy.config` (the Router's key and host) is process-global, read per request, and the Router code calls the bare
  global `fetch`: `routerSetup` before every run; tests swap `globalThis.fetch` (restored in `finally`).
- Cloud v2 refuses a reused idempotency key (422 `idempotency_key_reuse`), it never replays: after a lost submit answer
  that 422 means the job exists and its id is lost (stop, never a fresh key). The Router replays the key instead.
- undici drops `Authorization` on a cross-origin redirect (the v2 download's 302 to signed storage, measured S1,
  2026-10-18) and the SDK's bearer goes to its own origin only: a test mock links relative or to
  `https://cloud.comfy.org`.
- After a Cancel `ctx.fetch` refuses every request: the stop needs its own transport (`comfysdk.cancelJob`).
  `job.wait()` throws on any failed status read; asset handles live only in `LoadImage.image`, and a JSON round trip of
  the graph loses them.

**Tooling, shell, git**
- The Bash tool's heredoc breaks on an apostrophe in its text even with a quoted delimiter (`unexpected EOF while looking
  for matching`), and turns `\u0080` in Python source into the character. Write scripts and JS with the Write tool; a
  patch script imports a small `patch(path, [(old, new)])` helper and asserts each `old` occurs once.
- A patch script's `open(p, "w").write(s)` truncates first: when the heredoc turned `\ud800` into a lone surrogate, the
  write failed and left an empty file (an untracked test, 2026-09-29; recovered from a review agent's full Read in its
  transcript). Encode first (`b = s.encode("utf-8")`, then write the bytes), or use the Edit tool.
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
- `tools/manual_sync.js` has no `--help`: any call copies `docs/MANUAL.md` into `F:\portfolio_web` at once (2026-11-13 it
  copied an unreleased chapter; restored with `git -C F:/portfolio_web checkout -- content/scumble/MANUAL.md`). Run it
  only at a release.
- `git add a b c` stages nothing when one path matches no file (the source of a `git mv`, already staged as the
  rename): the commit then holds only what was staged before (B3's renames without their edits, 2026-10-14). Never
  hide `git add`'s errors (`2>/dev/null`); check `git diff --cached --name-status` before every commit.
- A comment edit in `crates/px/src/*.rs` changes the wasm bytes (panic locations carry line numbers): rebuild with
  `python tools/build_px.py` after any `.rs` edit, then `--check`.
- `editor_test.py`'s steps are Python strings that are not raw: `\\n` in their JS, or `String.fromCharCode(10)`; a
  plain `\n` becomes a newline inside a JS string literal.
- The node's publish action runs on a push only when `pyproject.toml` changes; otherwise
  `gh workflow run publish_action.yml --repo DenRakEiw/ComfyUI-InpaintCanvas --ref master`.
- The Comfy Registry's scan flags a node version for single tokens: 0.4.0 for `.listen(` in `js/prompt_field.js`
  (read as a network socket; the method is `bindEvents()` since). For a flagged version read the reason at
  `https://api.comfy.org/nodes/comfyui-inpaintcanvas/versions?include_status_reason=true` and rename the token.
- A release body with a bare `@img1` makes GitHub list the user `img1` as a contributor: `tools/release_notes.py`
  refuses a section with a bare @token, put it in backticks.
- `tools/run_gates.sh` and the mutation helpers restore only the files they saved; check `git diff --stat` after a mutation
  round.
- A background `grep` loop meant to stop a workflow after a phase does not fire in time; read its journal by hand or give it
  a phase switch in `args`.
- TaskStop on a background `run_gates.sh` chain stops the outer shell only: the runner's `bash.exe`, its `timeout.exe`
  and the gate's `python.exe` go on and keep 9555 busy, and a second run then fails at random (2026-10-14). Stop them by
  command line (`Get-CimInstance Win32_Process` matching `run_gates|_test\.py`), then close the instance.

**Testing and benchmarking**
- References taken with `--update` go stale with every later fix to the same path: run the gate on both backends again
  before the commit. A backend that is off by the same bytes as the other points at the references, not at itself (the
  linear light column, 2026-09-28).
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
- Twin cases built from bytes (a mask's multiples of 1/255, premultiplied RGBA) cannot tell one rounding order or
  `/ n` against `* (1 / n)` from another: their f64 sums are exact. Add floats over many decades and alphas near a
  threshold (K4 / K26's mutation rounds, 2026-11-07).
- A WeakRef garbage probe: `deref()` keeps its target alive to the end of the job it runs in, so `gc()` in the same job
  never frees it; await a timer between `gc()` and the next `deref()` (`tools/kernels_release_test.js`).
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
  editor calls one that either host lacks. Never edit the node's generated `js/` files. Since 0.1.56 the node's
  editor is built in a clone and pushed from there; the user's live node folder moves only on the user's word (a write
  there reloads the node in the running ComfyUI).
- **The long files are split since 0.1.55 (item 56, `docs/PLAN_SPLIT.md`).** `inpaint_canvas.js` (about 1,600 lines) keeps
  the class and installs 38 leaves and part classes `inpaint_*.js` / `inpaint_ed_*.js` through one `installParts` list
  (`inpaint_parts.js`); `host.js` (about 300) spreads `host_util.js` and 13 part objects `host_*.js` into `host`;
  `renderer/commands.js` (about 150) spreads `commands_util.js` and seven command groups into `COMMANDS` in key order;
  `electron/main/recipes.js` (about 320) has three CommonJS leaves; `renderer/shell.js` (about 1,800) keeps its state in
  `shellState` and has four section modules that import it back. A split-out module's name starts with its file's
  prefix; a move is proved by `tools/split_check.js` (`--object`, `--back-imports`), a rename by
  `tools/rename_check.js`; tests that read source text find it through `tools/srcfind.js`. Older notes that name a
  line in `inpaint_canvas.js` or `host.js` are stale: grep for the function.
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
  `electron/main/onnx/index.js` (main's checks) → `helpers.js` `HelperProcess` → the utility process
  `helpers_process.js` → `engine.js` → `sam2.js` / `matting.js` / depth on the `Runtime` (since U1, 2026-11-07; the
  same `engine.js` on main's thread is the fallback) → label map / alpha back, scaled to the image in the renderer.
  LaMa keeps its own process (`lama.js`). Models and folder in `docs/HELPERS.md`.
- Agents: MCP client → `Scumble --mcp` (`electron/main/mcp/server.js`) → `AgentBackend` in
  `main.js` → the running instance over `electron/main/local.js` (named pipe) or the app
  started headless in the same process → `electron/main/bridge.js` (IPC `commands:request` /
  `commands:reply`) → `commands.call` in `renderer/shell.js`. `docs/MCP.md`.
- The assistant: the panel (`renderer/assistant.js`) -> IPC `assistant:*` ->
  `electron/main/assistant/` (the loop, the policy, the four adapters) -> an in-process MCP client
  over `InMemoryTransport` -> the same `createServer` external agents get -> `bridge.js` with
  `meta` (the user-activity wait, the busy check, the turn and its undo step) -> `commands.call`.
  Chats under `<userData>/assistant/`, `docs/ASSISTANT.md`, the plan in `docs/PLAN_ASSISTANT.md`.
- The ComfyUI window (item 35, `docs/PLAN_COMFY_VIEW.md`): `electron/main/comfyview.js` (a `BaseWindow` made at the
  first open: the bar `scumble://app/comfybar.html` with `electron/comfybar_preload.js`, whose `comfyview:*` calls
  main answers for the bar alone, over the page, a `WebContentsView` in `persist:comfyui` with no preload). The
  auth of *Settings › ComfyUI* goes on as headers for the target's origin only; `--no-comfy` shows the start page
  unless a test passes a stub's URL. `tools/cdp.py` skips the bar's target.
- Documents (`.scumble`): `host.saveDocument` / `openDocument` (`renderer/editor/host.js`: `flushEditor` uploads the
  edited layers first, `documentDirty` / `settleKey` keep the "*", `rememberClosed` / `reopenClosed` the closed tabs)
  -> IPC `documents:*` -> `electron/main/documents.js` (a job per request, a lock per path, `idle()` for the quit) ->
  `electron/main/docfile.js` (the stored zip, temp file and rename, the mirror import). `docs/DOCUMENTS.md`.
- Network: `electron/main/curlfetch.js` `install()` (in `main.js` right after the SDK's `clearEnv`) puts a switch in
  place of `globalThis.fetch`: every main-process request that leaves the machine goes through the system's curl
  (`-K -` config on stdin, a body as a 0600 temp file, redirects followed in JS with key headers dropped on a change
  of origin) while `settings.network.curl` is not false and curl is found; loopback, and everything with the setting
  off, stays on Node's fetch. Not through it: the ComfyUI websocket (`ws`), electron-updater (Chromium's stack), the
  renderer. Why (the user, 2026-11-11): Omnicom's company MacBooks block Python requests and let curl through; a
  macOS build does not exist yet (B3), so the Mac side is unverified. Gates hit mocks on loopback: `SCUMBLE_CURL_ALL=1`
  sends those through curl too (`docs/TESTING.md`).
- Provider runs: `host.runProvider` (the recipe resolved to the chosen provider's variant by
  `shell.js`) → `renderer/editor/stitch.js` (crop) → IPC `provider:edit` →
  `electron/main/providers/index.js` picks the adapter and the key (`keys.js`), lays the pictures out with the
  adapter's `layout(req)` and resolves the prompt's markers `{@ref:i}` against it (`providers/refs.js`, item 26) →
  `stitch.js` (composite mask, colour match) → mirror upload → `addResults`. Recipe
  formats in `docs/RECIPES.md`. The prompt's `@img1` tokens follow the reference layers by id
  (`renderer/editor/reftokens.js`, `refsMutated` at every change of the shown references; `docs/PLAN_REFS.md` C2).
  Comfy Cloud and Comfy Router go through Comfy's SDK `@comfyorg/sdk` (0.5.0, pinned exactly), loaded only by
  `electron/main/providers/comfysdk.js` (`cloudClient` with `guarded`, `cancelJob`, `routerSetup`, `errorText`,
  `testBase` / `checkKey`, `clearEnv` at start in `main.js`; `docs/PLAN_COMFY_SDK.md`): `comfycloud.js` `runV2` /
  `finishV2` (the Comfy API v2 by default, `contextFor` sets `ctx.cloudApi`; the legacy `run` behind
  `settings.comfycloud.api` "legacy") and `recoverJobs`, `cloudjobs.js` (`<userData>/cloudjobs.json`, a job's note from
  submit to end), `comfyrouter.js` `send` / `collect` / `sync` on `comfy.models`. A run's live frames go back as IPC
  `provider:progress` (`index.js` `progressSender`, preload `providers.onProgress`, `host.js` `providerProgress` ->
  `RunProgress` `fraction`); a Cancel's words follow `ctx.jobSent` / `jobDone` / `jobEnded` / `cancelAsked`. The window
  asks `provider:recoverCloudJobs` (`shell.js` `recoverCloudResults`) once its documents are back, on
  `provider:cloudJobsChanged` (a run kept its note, a page went away during a run, the window was shown after a skipped
  ask) and every 90 s while jobs are kept; main (`main.js` `askCloudJobs`) reads one ask at a time, skips the jobs in
  flight (`cloudjobs.flying`) and the pictures handed to the page and not acked yet, and nothing while no window is
  shown; the window acks each picture it opened (`provider:ackCloudJob`).

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
- **No other product's name as the model for a feature** (the user, 2026-09-29: copyright and trademarks) in this file,
  in the blog posts, the CHANGELOG, the manual or the README: describe what the feature does, not whose it resembles.
  The providers and models Scumble runs through keep their names where a text is about running them. Plans and
  research notes under `docs/` may name them (the user: "bei Plan ist es nicht so schlimm, nur nicht auf der Webseite").
