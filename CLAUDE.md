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
  *Settings › ComfyUI* Test); it installs nothing itself, there is no Manager install in the code. Node 0.3.4 is
  Active on the Comfy Registry since 2026-10-07 (0.3.3 and older stay flagged; checked 2026-10-13), so the Manager can
  install it; public texts still give the `git clone` line (README, manual), which also works.
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

## Where things stand (2026-10-14: 0.1.48 released and in the MCP Registry; the Store update open)

- **Edit-box prompting in the Inpaint Canvas node: built in the night 2026-10-14/15 (B0-B6 of
  `docs/PLAN_NODE_BOXES.md`), pushed and live on 2026-10-15** (the user: "kannst das update pushen und in meinem
  comfyui aktualisieren"): Scumble main pushed (`779e357..99c2cfd`); the live node folder fast-forwarded to `6a0ad1e`
  (the night's branch, deleted after the merge) and pushed (`beef9dd..6a0ad1e`), **no pyproject bump, so no registry
  publish** (the registry stays 0.3.4; 0.3.5 or 0.4.0 is still the user's pick, D12). ComfyUI hot-reloaded it:
  `/object_info/InpaintCanvas` lists 23 outputs ending `box_prompt`, `elements` (`/system_stats` 200); the browser tab
  needs a reload for the new JS. `build_node.py --check` and node_test against the live folder: ok / PASS again. Open:
  the paid live run with *Flux 3 Image* (the plan's §8 step 4), the node's untracked CLAUDE.md
  (`dist/node_boxes_CLAUDE_update.md`), the clone `dist/node_boxes` can go. Before: the user: "lass uns ein update der
  inpaint canvas node machen mit Edit-Box-Prompting", then the night build without pauses. Scumble main `ae97224` ..
  `b717107`; the node's commits `15c192a` .. `6a0ad1e`. What it does: tool X
  and a Boxes section in the node's editor (`renderer/editor/inpaint_boxes.js`, active where the host member
  `boxesInEditor` is true: the node), the boxes in the workflow, and two tail outputs `box_prompt` (FLUX 3's caption
  and edit rows, written by the node's `boxes_rows.py`, a port of `electron/main/providers/boxes.js` held to
  `tools/boxes_vectors.json`) and `elements` (core's bounding-box shape). The app's Boxes plugin now imports the shared
  `renderer/editor/boxes_tool.js`, `boxes_model.js`, `boxes_format.js`; its behaviour is unchanged (gates). The B6
  review (a workflow of 8 agents) found 11 points, all fixed, among them one in the app: a recipe import read the
  node's new tail outputs as setting slots (`electron/main/recipes.js` `tailOutputs`). The live node now holds the
  boxes, so builds from main go into the live folder again as before. Unverified live: the edit rows through the Comfy proxy
  of *Flux 3 Image*, `aspect_ratio` auto on a non-preset crop, the tail remap for a canvas inside a subgraph, the
  example workflow. The proposed sections for the node's untracked CLAUDE.md: `dist/node_boxes_CLAUDE_update.md`.
- **The open items, collected 2026-10-13** (a workflow of 11 agents over BUGS.md, the plans, the list, the outward
  threads and GitHub, each doubtful status checked in the code): `docs/OPEN_2026-10-13.md`, a dated snapshot (not
  kept up to date; BUGS.md and this file are the living lists).
- **0.1.48 is "status and feedback"** (the user chose it 2026-10-13 by answering its first question): (1) item 45, the
  error line five blinks then steady red, warnings count; (2) a progress bar while generating (node issue
  DenRakEiw/ComfyUI-InpaintCanvas#1, ask 1: ComfyUI's progress events reach the renderer and nobody reads them;
  elapsed seconds on API runs); (3) copy / reuse a prompt from the result history (#1, ask 4, like the seed's click);
  (4) a whole-picture upscale refused against the document ceiling *before* it is paid for, and Resize / Extend
  checking the target size (both in `docs/BUGS.md` "Size limits"); (5) riding along: item 46 (`7d735b2`) and the
  Help fix of the branch `claude/vigorous-nobel-c9571c` (`bddbf74`, `*em*` in the manual as italics; cherry-picked
  into main 2026-10-13, the branch deleted). About five sessions, normal test tier. **The user's
  answers (2026-10-13):** the progress as a thin bar in the status row; no node 0.3.5 yet (the node stays 64 commits
  past 0.3.4 on the registry). Open: the replies to node issues #1 and #2 (drafts on request).
  **The plan is `docs/PLAN_0_1_48.md`** (2026-10-13, six sessions S1-S6, anchors from a workflow of six readers; it
  corrects the open-items list: the app's title row already has a progress bar from `progress` events and the API
  seconds, the editor and the node have none). **S1 done 2026-10-13** ("S1 as built": `setStatus(text, kind)`,
  `statusKind`, the classes `ipc-status-error` / `ipc-status-blink`, reduced motion, `set_status` `kind`; the `log`
  gate's two new steps; reviewed by a workflow, its three findings fixed). **S2 done 2026-10-13** (the user, the
  same day: "context ist noch nicht so voll, baue weiter"; the answers: state refusals and "a run is still going"
  plain, degraded-but-landed and limit refusals red; "S2 as built": `renderer/editor/inpaint_status.js` with
  `failKind` / `refusal`, 155 sites marked by a script from a classification of all 620 status writes, the
  helpers and the plugin API by hand, the PSD / ORA `lossy`; a review workflow's two musts (a local `refusal`
  hiding the import in `host.js`) and the rest fixed; 14 gates green on tiles). **S3 done 2026-10-13** (the user's
  answer: both bars stay; "S3 as built": `renderer/editor/inpaint_progress.js`, the bar beside the status line, the
  host's tracking and event routing, the BUGS.md routing fix; a review workflow's 14 findings fixed; 9 gates green).
  The node side of the bar (its own `js/inpaint_node.js` wrapper) is not built: the bar's DOM ships in the node build
  and stays hidden there. **S4 done 2026-10-13** ("S4 as built": a result keeps the click's prompt, negative, refs and
  seed; a click on the prompt in the history puts it back, Ctrl+click copies; a review workflow's 8 findings fixed).
  **S5 done 2026-10-13** (the user's answers: an answer too large after it was paid lands scaled down to fit, red;
  Resize and Extend refuse; "S5 as built": `renderer/editor/inpaint_sizelimit.js`, the refusal before a paid
  whole-picture upscale names the largest factor that fits; a review workflow's 9 findings fixed). **S6's cherry-pick
  done the same day** (the Help fix of `bddbf74` in main, its branch deleted). **Prepared 2026-10-14** (the user:
  "release vorbereiten"): a release review (two workflows, 10 agents; `docs/PLAN_0_1_48.md` "The release review")
  found 7 + 8 "should" defects in the new features, all fixed (`38897a4`, `dc7d697`: the bar's routing, a lost socket,
  closed tabs' prompts and Reopen Closed Tab, extend_canvas, Magnific Precision whole factors, Magnific Creative's
  25.3 MP cap); the CHANGELOG section `## 0.1.48 - 2026-10-14`, `package.json` 0.1.48. Built from `dc7d697`: `dist/Scumble
  Setup 0.1.48.exe`, `dist/Scumble-0.1.48-portable-win-x64.zip` (layout checked; the start test skipped, the user's
  Scumble was open), `dist/scumble-0.1.48.mcpb` (114 tools), `dist/Scumble-0.1.48.msix` (0.1.48.0; `win-unpacked` is the
  Store layout since) and `dist/store-listing/whats-new-0.1.48.txt`. Exe gates: `rel48-exe-canvas` 28 of 28 PASS;
  `rel48-exe` (tiles, 49) PASS up to `boxes`, the instance went away in `comfyview` (TESTING.md flakes), and
  `rel48-exe-b` (comfyview and the 14 after it, a fresh instance) PASS but comfyview's known control step. The node
  built (`--check` ok, node_test PASS) and committed (`beef9dd`; `/system_stats` 200). **0.1.48 is out** (the user,
  2026-10-14: "ja, mache den rest"): tag v0.1.48 on `476b15b`, published 2026-10-14T09:14:21Z, title "status and
  feedback"; the tag build green, the eight assets checked (the zip's layout, the `.mcpb` 0.1.48 with 114 tools,
  `latest.yml`; the zip's start test skipped, the user's Scumble was open); the post `v0-1-48` live with the manual sync
  and the `em` branch of `scumble-inline.tsx` (`Portfolio_vercel` `fd4f6f3`, Vercel success), hub 0.1.48; the node repo
  pushed (`beef9dd`, no new node version); `server.json` 0.1.48 committed (`0530a69`) and published to the MCP Registry (the user's device code; 0.1.48 latest). **Open:** the Store update (Claude in Chrome's site permissions block partner.microsoft.com: the user allows it, or uploads `dist/Scumble-0.1.48.msix` with `dist/store-listing/whats-new-0.1.48.txt` by hand). Not run in 0.1.48:
  the `huge` gate (30k), the node side of the bar.
- **Done 2026-10-13 on the user's word:** the awesome-alternative-uis-for-comfyui entry (PR #120) moved to the bottom
  of Category 4 as the reviewer asked (the fork's `add-scumble` rebuilt on upstream `babe4fd` and force-pushed; no
  reply comment posted). Video 4 is on YouTube (the user). CLAUDE.md brought up to date with the code.
- **Flathub** (flathub/flathub#10589): closed 2026-10-10 by a reviewer for a wrong AI disclosure (the PR said "None
  in application code"); three test builds had failed before. The user (2026-10-13) wants to submit again with an
  exact disclosure. Flathub's policy forbids AI-written manifests, PR texts and replies, so Claude helps with the
  facts (what was AI-written) and the Linux test, never with the submission itself (memory `flathub-ai-policy`).
- **Clean-up 2026-10-13 (the user: "ja, aufräumen", finals and thumbnails of the videos kept):** nothing is deleted
  by Claude; what goes is moved to `F:\_scumble_aufraeumen_2026-10-13` for the user to delete (about 66 GiB: the test
  profiles 0.1.45 / 0.1.46, `dist/portable-test`, nine old MSIX files, and 63 GiB of `dist/video`: recordings, takes,
  scene renders and frames, stems, the Resolve copies `v4/resolve_r2`, check frames, the recording profile's mirror,
  part four's first-pass Resolve render; sorted by a workflow of eight agents, every move checked by a second one).
  **Kept in `dist/video`:** every master, web copy, poster, thumbnail, SRT, chapters and timeline of parts one to four,
  part three's Discord and X cuts and the cursed cut, `show_poster.png`, the paid 4x upscale `v2/big/scene_4x.jpg`,
  `fun/`, and **all of `dist/video/trailer`** (until the challenge entry is in). Moved on the user's second word the
  same day: the final takes `v4/takes/n6b.scumble` / `close2.scumble`, the whole rejected big-cat pass `v3_bigcat`
  (master, web copy, posters) and part one's two LinkedIn copies (68 GiB in the holding folder in all). A re-cut or a Resolve rebuild
  of parts one to four is no longer possible from `dist/video` (their scene clips and stems went; the Resolve
  timelines show them offline). Worktrees: all five stale ones removed (`hopeful-yonath`'s obsolete BUGS.md diff and
  `bisect`'s gate logs copied to the holding folder first; the merged `mcpb` worktree took its ignored `dist/` of
  2026-10-09 with it). Branches: `phase-e`, `phase-r`, `hotfix/0.1.33`, `mcpb` (merged) and `hotfix/0.1.40` (kept by
  its tag) deleted here and on origin, `claude/hopeful-yonath-8deb4d` and `worktree-agent-acb03e9b1db8eee85` (its
  commit is in main) here; `claude/vigorous-nobel-c9571c` kept then, its Help fix cherry-picked and the branch deleted the same evening (S6).

- **0.1.47 is out** (tag v0.1.47 on `debf8a9`, published 2026-10-13T08:30:10Z, title "relight with virtual lights"; the
  user's "ja, veröffentliche den release"): the tag build green, the eight assets checked (the zip's layout, the
  `.mcpb` 0.1.47, `latest.yml`; the zip's start test skipped, the user's Scumble was open); the post `v0-1-47` live
  (`Portfolio_vercel` `1da99c3`, Vercel success), the manual synced, hub 0.1.47; the node repo pushed (no new node
  version); `server.json` 0.1.47 committed and published to the MCP Registry (the user's device code; 0.1.47 latest).
  **The Store update is live** (the Store catalog lists `DenRakEiw.Scumble_0.1.47.0` since 2026-10-13T09:04Z with the
  0.1.47 notes; read the same day). The preparation, as it was: the user tested relight in
  the dev test instance ("ist super"), then "bereite den release vor": relight (item 43) with the fixes F1-F4 and the highlight shoulder (the user's answer the
  same day: a soft shoulder now, `6abb828`; the Brainfuck easter egg kept). Commits up to `4a7c20b` are local, not
  pushed; `package.json` 0.1.47, the CHANGELOG section `## 0.1.47 - 2026-10-13`. Built: `dist/Scumble Setup
  0.1.47.exe`, `dist/Scumble-0.1.47-portable-win-x64.zip` and the exe gates' `win-unpacked` from `f192ee0` (a comment
  apart from `4a7c20b`: build_node.py read `host.relightWhole` in a comment as a host member), `dist/scumble-0.1.47.mcpb`,
  `dist/Scumble-0.1.47.msix` (187,675,774 bytes, from `4a7c20b`; `win-unpacked` is the Store layout since, without
  `app-update.yml`) and `dist/store-listing/whats-new-0.1.47.txt`. Exe gates: `rel47-exe` (tiles, 49: 0.1.46's list plus
  relight selection limit maps; 48 PASS, comfyview's control step the known flake) and `rel47-exe-canvas` (28, all
  PASS). The node built (`build_node.py --check` ok, node_test PASS) and committed locally (`dec4806`; the node repo is
  9 ahead of origin with the other agent's syncs, not pushed); `/system_stats` 200 after every write there. README and
  MCP.md say 114 tools (95 core, 19 from the plugins). The test profile `dist/test-profile-0.1.46` went to the
  holding folder on 2026-10-13 (below). Discussion github/github-mcp-server#1257 (the
  github.com/mcp onboarding request of 2026-10-10): no answer yet on 2026-10-13, only other vendors' requests.

- **Relight (item 43, `docs/PLAN_RELIGHT_BUILD.md`): the fix plan `docs/PLAN_RELIGHT_FIXES.md` is done (F1-F4); next the
  user's test, then a release on the user's word.**
  The other agent built L0a-L6, N2 (presets, gloss, gobos, hide handles) and N3 (the 15k measurement) and two fix
  rounds (ec60f14 + 81178aa, then 77da63f). This account reviewed each round with a workflow (2026-10-12; round 3:
  55 agents, every finding verified by a second agent): each round fixed most of the list and brought new defects.
  At 77da63f six musts are open (the assistant refuses every relight above 27.9 MP; assistant_test.js loads an
  uncommitted file, the assistant gate is 37/38; historyStepNow resets gen, the editor gate is red; pickVis keys by
  version vs dataVersion; the fit cache ignores the picture below; default lora_strength 1.0 on a 0..100 scale).
  The user (2026-10-12): this account fixes them now, sessions F1-F4 of the plan, one per session with `/clear` in
  between; the other agent does not edit relight meanwhile. **F1 done 2026-10-12** (the assistant cap, the loader,
  historyStepNow built differently from the plan's formula, lora_strength; "F1 as built" in the plan). **F2 done
  2026-10-12** ("F2 as built": one map key for both sides, pickVis never gives a run the quick map, the quick map trails
  a drag, the fit keyed on the picture, `belowStats` on the picture below instead of compositeVersion, `relightIdle` in
  every async reader of a run's picture and in exports; reviewed by a workflow, the must it found fixed). **F3 done
  2026-10-12** ("F3 as built": nudge and wheel bursts on their own undo fields, no edit in progress in undo records or
  copies, close() closes the tip popover and drops a pending nudge, the relight command keeps the layer's route when
  none is given, Bria's light type "From the lights", only the user's picks stored as settings.relight, a relight id
  keeps the recipe in use, an undo cancels a shown preview first; reviewed by a workflow, its must and should fixed).
  **F4 done 2026-10-12** ("F4 as built": gate cases u and r no longer vacuous (each mutation that the old cases
  passed is red now), w2 new; the array-schema test loads every plugin through plugins.js; px_test checks the
  shadow_march routing and times it only with `PX_BENCH`, PERFORMANCE.md 15.2 rewritten; undo keeps Escape's "no
  light"; a sun on the centre at dist 0 is frontal on the CPU and in the march; the magnific gate (all 11 steps) and
  ideogram45_test.js green again; the manual's Kelvin list, the CHANGELOG's Unreleased section rewritten; the full gate
  list green on both backends, comfyview's control step the known flake). Relight gate: 270 in-app checks on tiles,
  269 on canvas (278 / 277 with the shoulder's cases sh and sh2); `RELIGHT_GATE_SKIP_NODE=1` runs the in-app checks
  alone for a mutation round. Both open questions answered 2026-10-13 (above).
  The other agent's `docs/REVIEW_RELIGHT_2026-10-12.md` is its own self-review.


**Video 4 is cut, second pass (2026-10-11 night; the user: "mache einen neuen tutorial, das die neuen features
zeigt ... stimmen wieder elevenlabs", then "mit tollem motion design ja? und cut in davinci resolve"):** "Scumble,
part four: the show is on Friday", the features of 0.1.44-0.1.46 in the dialogue style of parts one to three on seven
of the user's FLUX 3 pictures; plan, script, "Voices as made", "Takes as made" and **"The cut as made"** (both passes)
in `docs/TUTORIAL.md` §7. The 83 ElevenLabs lines (`voice/v4_eleven/`), the takes (`rec/scene4.py`; Note 06 and the
close are two scenes each, joined by a plain cut: the second take starts in the first take's exact state, `CUT_STATE`),
ten scene specs `motion/scenes/v4_*.json`, the engine (`build_scene.py` a scene file and engine page per scene;
`scene_engine.html` one wipe track per element, `cut: true`, the `wall` strip; `order4.py`; `title4.html`),
`build_final4.py` (the mix -14.0 LUFS / -1.8 dBTP, SRT, chapters, a 720p preview), the recorder's drawn cursor now
immune to the physical mouse (`recorder.py` `__recPos`). **An independent check** (`dist/video/v4/check/report.md`)
found the first master's half wipes (two WAAPI tracks on one property), five black frames at the title, the dev path
on screen and the build mismatch at the cuts: all fixed in the second pass. **Resolve hung in the second pass**
(`rec/resolve4_refresh.py` deleting pool clips; the DaVinci MCP then blocked 30 min per call, an outside
`scriptapp()` too, Resolve was killed and restarted): the second pass's **master `04_scumble_part_four.mp4` is an
ffmpeg assembly** of the same materials (the clips concatenated, the end card overlaid, `stem_mix.wav`; x264 CRF 16,
AAC 320k, 5:18.5), with `04_web.mp4` (1080p, CRF 25), the SRT (83 cues), `chapters.txt` (0:00 / 0:37 / 1:10 / 1:44 /
2:23 / 2:59 / 3:34 / 4:16), `poster.jpg`, `timeline.json`. The stems, the scene renders, `v4/resolve_r2/` and the
first pass's Resolve render `04_scumble_part_four_resolve.mp4` went to the holding folder on 2026-10-13 (the clean-up
above), so the Resolve rebuild TUTORIAL.md §7 describes is off; the Resolve project's timeline "04 Scumble part four"
shows its clips offline. The
YouTube text: `dist/video/youtube_descriptions.md` "Video 4". **On YouTube since 2026-10-13** (the user uploaded it:
https://www.youtube.com/watch?v=ZisUgWl_FO0). **Still waiting for the user:** the tally "about $1.20" against the Black
Forest Labs dashboard; the commit of the material (`docs/images/video/`, the TUTORIAL.md section) only on the user's
word. **On the website since 2026-10-12** (the
user's word): `04_web.mp4` as `public/scumble/videos/scumble-part-four.mp4` with the poster and the eight chapters,
"four parts" on the hub and the videos page (`Portfolio_vercel` `41f46f6`, Vercel success). Resolve is open at the Project Manager; the
recording instance on port 9571 is closed, the HEAD worktree removed.

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
  says it is free; gates run `--offline`). Tune for 15k, not 30k. One-channel masks on ice; `inpaint_canvas.js` is
  split only where a subject is reworked anyway; the object tool's change A parked; tiles are the default, the canvas
  backend the escape hatch. A parked idea, not a plan: a mobile companion.
- **Unverified:** ToAPIs beyond GPT Image 2's `standard` / `vip` channels (those ran live through this adapter in
  ToAPIs' own run of 2026-10-13, issue #5: a new image and whole-picture reference edits; channel `official` with the
  mask and the canvas round trip not; `docs/RECIPES.md`) and ModelArk live; OpenRouter beyond GPT Image 2.5 Flare / Sunburst and FLUX 3 Image (live 2026-10-03); Magnific beyond the two
  upscalers and Oxen (docs only); the five generative relight routes (built from docs, tested against mocks only); a real SAM2 / RMBG model
  on the slice 6 code; the user's own 15k file. Deferred from 3f: the source's EXIF / XMP in exports, an ICC profile in
  PSD and TIFF. Not checked: a double click in Explorer on an installed build, TIFFs written by other image editors.

## What comes next (the list)

The numbered list the user adds to (the numbers are cited elsewhere). The full text and research of every item is in
`docs/HISTORY.md` "What comes next" (the latest full copy): read it before planning one of them.
- Built: 1-13, 17 (the side panel's width), 18 (the logo; open: the mascot's other poses, the About dialog, the
  website), 20 (skins; later on the user's word: a theme editor, light / dark after the OS, density, icon sets), 23
  (23a in 0.1.31, 23b for 0.1.32), 24 (the canvas-only view).
- 5: the object tool's change A (the image-size label map, `dist/c6map/c/objects.md` §7-§9), parked.
- 14: upscaling beyond the API upscalers (ComfyUI, ONNX, a desktop upscaler by CLI / MCP). **RTX VSR local and on Comfy
  Cloud and the whole picture for local upscale recipes are built and released (0.1.42)**; the in-app ONNX upscaler (U3)
  and Topaz direct / CLI (U4) are parked.
  Added 2026-10-03 for a later update (the user asked for DLSS): DLSS itself needs a game renderer's motion vectors
  and depth and has no picture API; NVIDIA's RTX Video Super Resolution node is installed on the user's ComfyUI, so a
  local upscale recipe on it, then the whole picture for local upscale recipes: `docs/PLAN_RTX_VSR.md`. 2026-10-04: the
  user wants RTX VSR as a local **and** a Comfy Cloud upscaler (Comfy Cloud has the node; its API form is in the plan),
  and DLSS 5 Neural Rendering on pictures (the community pack `ComfyUI-DLSS5-Enhancer`, not installed yet: the user
  installs it; the design and the jury question in the plan's last section). **Decided the same day: RTX VSR (local
  and Comfy Cloud) goes into 0.1.42, and so does item 37.**
- 37: the **Realism Pass** (the user, 2026-10-04: "der ideale fix für das plastic skin problem von flux"; the name is
  the user's): DLSS 5 Neural Rendering through the community pack ComfyUI-DLSS5-Enhancer on the user's own ComfyUI,
  labelled **"Realism Pass (Windows only, RTX only)"**, no Comfy Cloud alternative, local only (the worker is Windows
  only; NVIDIA's SDK has no Neural Rendering, Linux or otherwise). **The next feature, release 0.1.42** with RTX VSR
  and the portable zip (item 36): `docs/PLAN_0_1_42.md`; research in `docs/PLAN_RTX_VSR.md`'s last section. **R1 (the
  recipe, the server check, the hints, shipped presets L and M) built 2026-10-04**, not run live; R2a and R2b the
  same day; **redesigned that evening as a refiner** (the whole picture at 1x as a new layer, never a Generate result:
  plan §1 "The Realism Pass is a refiner"); **R3a, R3b and R4 built the same night** (`host.realismWhole`; the Upscale entry, the Image menu, `realism_pass`; the assistant's row and readiness in `status` / `list_recipes`), R5 to P3 the next night; **released in 0.1.42 (2026-10-05)**, with the Realism Pass Upscale and the 27.9 MP cap found live.
  OpenDLSS-NR and the other open reimplementations of the network (checked 2026-10-05): **parked until there is a
  cleaner way** (the user; `docs/PLAN_RTX_VSR.md` last section: they all need NVIDIA's extracted weights; found there:
  the runtime's NR library is an unsigned, modified build; the RTX 40 / 30 question in `docs/BUGS.md`).
- 38: new commands for MCP agents (the user, 2026-10-04: "schau auch noch ob noch mehr commands in den mcp aufgenommen
  werden können"): 28 verified candidates in `docs/PLAN_MCP_COMMANDS.md`; **the user picked 12** (marked ✓) for 0.1.42,
  sessions F2a / F2b after the six fixes of F1 (all six picked from `docs/BUGS.md` the same day). The other 16 wait
  for a later update. **The 12 built (F2a, F2b), released in 0.1.42.**
- 39: a tidier Settings dialog (the user, 2026-10-05, with a screenshot of *Settings › Recipes*: "das einstellungs menü
  aufräumen. die model liste ist zu lang / auch die anbieterliste; kann man das aufklappbar machen?"): 60 recipe rows
  and 16 key rows in one flat list today. **Decided the same day:** recipes in three collapsible groups (ComfyUI /
  Comfy Cloud / API models, family sub-headings, count / ready / in use on each group's line, the active one open), no
  filter field, only the two long lists collapsible (recipes and API providers), the open state in `localStorage`.
  `docs/PLAN_SETTINGS.md` (what exists, the shape, the traps: the gates that read the rows, rebuilds that reset the
  DOM, the skins; both answered 2026-10-07: the providers one group as they are, Remove only on own recipes). **Built
  2026-10-07 for 0.1.43 (S1).**
- 40: a GitHub star link in the app (the user, 2026-10-05: "irgendwo in der app ... wo es nicht nervt", then the exact
  wording and places): **"⭐ Star on GitHub"** directly in the Help menu (beside *Scumble on GitHub*,
  `electron/main/main.js:695`) and in *Settings › About* (today one line with the repo link, `renderer/index.html:186`,
  `shell.js:2605`), and **after a successful update, once per version: "⭐ If Scumble is useful to you, consider
  starring the repo — it helps the project get discovered."** (the user's wording of 2026-10-07, replacing "Enjoying
  the new version? ⭐ Star us on GitHub"): on the first start of a new version (the last version seen kept in the settings), a quiet line that can
  be closed, never a modal and never again for that version; whether it shows in the Store copy (the Store updates
  it) and beside item 32's update dialog is a design question. Opens https://github.com/DenRakEiw/scumble through
  `shell.openExternal`. **Beside it "↗ Share the project"** (the user, the same evening): suggested, not yet confirmed,
  a small menu at the button (Windows has no share sheet for Electron): *Copy link* (text + link to the clipboard,
  "Link copied") and the platforms' own share pages in the browser (X intent, LinkedIn share-offsite, Bluesky intent,
  Reddit submit) with a prefilled line such as "Scumble: a free, open-source editor for AI inpainting"; the link the
  website hub https://www.denrakeiw.com/scumble (download, videos, manual), no UTM or tracking. In the same three
  places as the star. Small (a few hours together). **Built 2026-10-07 for 0.1.43 (S2): the shared link is the GitHub repo.**
- 41: **Nano Banana 2.1** as a new model (the user, 2026-10-07, with Google's page
  https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/nano-banana-2-1). Known so far (Gemini
  API model page, 2026-10-07; the Cloud page renders no body for a fetch): model id `gemini-nano-banana-2.1`, GA,
  released 2026-10-06; text, image, video and PDF in, image and text out; up to 14 reference pictures (4 characters,
  10 objects); 1K / 2K / 4K (default 1K), also 1:4, 4:1, 1:8, 8:1 at 2K and 4K; thinking (minimal / medium / high),
  search grounding (web and image search); news says better editing and subject consistency at half the price
  (unchecked). Scumble today: `recipes/nano_banana_2.json` (Gemini 3.1 Flash Image) with a direct `gemini` variant
  (`electron/main/providers/gemini.js` takes the model from the recipe) and variants on fal, Replicate, WaveSpeed,
  Comfy Cloud, ToAPIs, OpenRouter, Comfy Router and Oxen. Likely shape: a recipe `nano_banana_2_1.json` on the
  direct Gemini adapter first (model id, the size classes, the new ratios, the 14-picture limit in `layout`), the
  other hosts as they list it; open: whether its edit path differs from 2's, the thinking level as a setting.
  **Planned for 0.1.43 (2026-10-07): `docs/PLAN_0_1_43.md` N1 (Google direct) and N2 (fal, Replicate, WaveSpeed,
  OpenRouter, Comfy Cloud, Comfy Router, ToAPIs; Oxen does not list it), docs only, no live run.** **N1 and N2 built 2026-10-07** (`recipes/nano_banana_2_1.json` with eight hosts, `gemini.js` thought parts and Thinking).
- 42: **Match an inpaint layer's edges to the layer below** (the user, 2026-10-07: "manchmal kommt der inpaint leicht
  verschoben heraus, damit kann man es automatisch auf die ebene darunter matchen"): edit models re-render the whole
  crop and often shift or slightly scale it, so contours double where the selection border crosses an edge. Known:
  the node already does this at stitch time (`nodes.py` `_align_patch`: an affine ECC fit, OpenCV, on the ring where
  the base stays visible, at most 512 px; kept only within 8 % scale, 0.03 shear, 5 % shift and when the ring
  difference drops by 3 % or more; it reports aligned / reason / scale / shift); the app has the crop setting
  `align: true` but `renderer/editor/stitch.js` `finishResult` answers `{ aligned: false, reason: "not available in
  the app" }` (no OpenCV in the app; the manual says so). Two parts: (a) the same fit at result time in the app (an
  ECC / Lucas-Kanade fit in `crates/px` or a small JS one; OpenCV.js is Apache-2.0 but about 8 MB), so new results land
  aligned; (b) **after the fact** on any layer: a layer-menu entry, an MCP command and maybe a button on result
  layers, "Match edges to the layer below", fitting the layer's own edge ring (its alpha / mask border) against the
  composite under it, moving or warping the layer as one undo step, with the report in the status line and a manual
  nudge as the fallback. Tests: normal tier (a result shifted and scaled by known amounts comes back within a pixel;
  a flat area or a too-large fit refuses). **Built 2026-10-08** (affine Lucas-Kanade edge ring fit in `renderer/editor/edgefit.js`, `matchEdges` on `InpaintEditor`, context menu entry, MCP command `match_edges`, live result alignment in `renderer/editor/stitch.js`, `tools/edgefit_test.js` 9/9 passing).
- 15: Qwen Image Edit 2.1: the local recipe ran live 2026-10-09/10 (issue #4 fixed in 0.1.45); the API side is open. The Turbo
  checkpoint as its own local recipe for 0.1.46 (2026-10-11, run live).
- 43: **Relight: virtual lights on the picture** (the user, 2026-10-09, with a link to a commercial editor's beta of
  2026-09-28; **the update after the Nik 9 block**, releases 2 and 3). Up to a few lights dragged on the canvas, each
  with colour, intensity and diffusion, an Original light slider, a screen-only preview, the result as a new layer.
  Research and the plan: `docs/PLAN_RELIGHT.md` (the depth map carries placement, falloff and shadows; normals come
  first from its gradient, in phase 2 from MoGe-2 ViT-S normal, MIT, ONNX; routes: an in-app shader on the filter
  infrastructure, Magnific's relight endpoint taking Scumble's own light map, a local generative recipe only on a current model (no IC-Light SD 1.5, the user), fal's two
  direction-word endpoints as presets; the user's questions R-D1 to R-D5 in its §5; about 6-8 sessions plus 4-5).
  **The build plan is `docs/PLAN_RELIGHT_BUILD.md` (2026-10-11, anchors at `0d0be6b`)**: lights of three kinds (point,
  sun, spot) with Kelvin or custom colour, diffusion, Close/Far on an orthographic height field from the depth map; the
  in-app route a filter layer `relight` (a WebGL2 shader with a CPU twin; the normals and the per-light shadow maps as
  **Rust kernels** `height_normals` and `shadow_march` at map resolution, ABI 19, cached on the layer); the generative
  routes (Magnific's light map, the Qwen Image Edit 2509 relight LoRA local and on Comfy Cloud, fal iclight-v2, Bria)
  land a pixel layer with the model's light laid on the original's pixels by a ratio; sessions L0a-L6 by the other
  agent (about 10 days), the review after each and the release by this account; phase 2 N1-N3 (MoGe-2 normals and
  camera, AO, gloss, presets, the 15k measurement); the questions R-D1 to R-D9 in its §6 (the user, 2026-10-11:
  "der plan wird dann dem anderen agent zum umsetzen gegeben ... du machst am ende den release"). **Released in 0.1.47
  (2026-10-13)**: L0a-L6, N2 (presets, gloss, procedural gobos, hide handles), the fixes F1-F4, the highlight shoulder.
  Open (phase 2, not built): N1 (MoGe-2 normals and a perspective camera), horizon AO, gobos from a layer's mask; N3's
  15k numbers were taken on a layer without lights, which the filter skips (measure again with lights); the five
  generative routes never ran live.
- 44: **grow the Rust kernels, no rewrite** (the user, 2026-10-09, after asking whether Scumble should be rewritten in
  Rust: no, the shell stays Electron; "schreibe auf den plan wasm kernel wachsen lassen"): `docs/PLAN_WASM.md` ranks
  the CPU paths worth moving into `crates/px` (the edge snap and guided filter maps, histograms and the limit rows,
  the compositor's CPU band, the stroke kernels, a threads spike), with the rules (measure first, the JS kernel stays
  the reference and fallback, both wasm builds, one kernel per session). **Built so far:** `range_max` (ABI 18, 0.1.46)
  and relight's `height_normals` and `shadow_march` (ABI 19, 0.1.47); W0-W5 of the plan are open (`composite_tile`
  already covers every blend mode, so the plan's #3 is smaller than its table says).
- 45: **error lines in the status bar red and blinking** (the user, 2026-10-11, testing 0.1.46, with a screenshot of
  "Depth estimation needs Depth Anything V2 Small: download it in Settings > Helpers.": "fuer das naechste update: bei
  einer fehlermeldung ist der fehler text unten rot blinkend"). For the update after 0.1.46. Today `setStatus(text)`
  (`renderer/editor/inpaint_canvas.js`, 446 calls) has no kind, so an error looks like any other line: a kind
  (`setStatus(text, { error: true })` or a small `setError`) at the error sites, the line red, a short blink (a few
  pulses, then steady red until the next line; none under `prefers-reduced-motion`), in every skin.
  **The user's answers (2026-10-13): five blinks, then steady red until the next line; warnings such as "needs a
  download" count as errors.** The core of 0.1.48 (above). **The mechanism built 2026-10-13 (S1 of
  `docs/PLAN_0_1_48.md`):** `setStatus(text, kind)` (`"error"`, `"warn"`, `"info"` or `{ kind }`; without one the text
  decides: the log's old failure regex and the "download it in Settings" lines), red from `--sc-error`, five 0.6 s
  pulses. **The error sites marked the same day (S2)**: failures, missing models, limit refusals and partial
  results red; refusals of the user's state, a run going, cancels plain (the user's answers).
- 46: **the ASCII logo in Brainfuck** (the user, 2026-10-13: GitHub's language bar showed no Brainfuck although the
  easter egg of 4cc2f76 is in the code, "baue das mit dem asci logo im nächsten update"). Linguist counts by file
  extension and leaves out languages below about 0.1 % of the repository (the Dockerfile, 0.01 %, is not shown), so
  the two programs as strings in `renderer/easteregg.js` count as JavaScript. **Built 2026-10-13 for 0.1.48:**
  `renderer/easteregg/logo.bf` (20.5 KB, 0.17 % of 12 MB; the plain one-cell style on purpose, a multi-cell compiler
  writes 5 KB) prints the mascot from `build/icon.png` and a block-letter wordmark; built by `python tools/bf_logo.py`
  (`--check`, `--show`); `.gitattributes` `*.bf linguist-language=Brainfuck` (`.bf` is shared with other languages);
  the window prints it to the DevTools console at start (`getScumbleLogo`, `window.scumbleLogo()`); `easteregg_test.js`
  checks it. Whether GitHub shows it is seen only after a push (Linguist runs on the default branch).
- 16: Oxen.ai: built from the docs, never run (no key).
- 19: 3D layers from AI models (Meshy / Hunyuan 3D / TRELLIS into glb layers), only listed.
- 21: lens flares (an optional plugin, 7-9 days), no place in the order yet.
- 22: a filter-suite update (an update of its own; `docs/PLAN_NIK9.md`, 34-46 days plus two folded packages), suggested
  after B3. **The build plan (Umbauplan) is `docs/PLAN_NIK9_BUILD.md`** (the user, 2026-10-04: "nur den plan ... als
  eine art umbau plan .md", "detaillierter ... was später den umbau vereinfacht"; one workflow, 12 agents, anchors
  read at b6c5238): foundations F1-F12 first, then 57 core sessions (61 / 66 with the optional ones), 48.5-55 days
  inferred; release 4 (blend modes) and release 3 do not depend on release 1; the user's open questions in its §6.
  **Release 1 (masks) built 2026-10-08/09 by the other agent and released as 0.1.44 (2026-10-09)** after two reviews
  and the user's test; **releases 2 and 3 next, as one block with one release at the end** (the user, 2026-10-09),
  a review after every session; release 4 independent.
- 25: the app's own dialogs instead of the native boxes: built 2026-10-01 (`renderer/dialogs.js`, main's `askWindow`
  with the native box as the fallback), released in 0.1.36.
- FLUX 3 Image (not numbered; BFL's launch 2026-10-01): released in 0.1.36 the same night.
- 28: boxes in the prompt for FLUX 3 Image and Ideogram 4 (the user, 2026-10-01 night: the selection as a FLUX 3
  bounding box, then a plugin like Kijai's Ideogram 4 prompt builder): `docs/PLAN_BOXES.md` (BFL's documented rows
  on a 0-1000 grid; the design: the renderer sends box geometry as fractions of the crop, main's
  `providers/boxes.js` writes the rows after `resolveNames`, plugins supply boxes through
  `scumble.generate.register`; S1 the selection as a box behind a FLUX 3 row, S2 the hook, S3a-c the built-in
  "Boxes" plugin, S4 Keep rows from the SAM2 objects; §8-§12 the implementation plan per session, §6 the live
  checks after S1, §7 the open questions). **S1 built 2026-10-02** (the selection as a box; its Settings row went in S3d), **S2 the same day**
  (plugin API 3, `scumble.generate.register`, the sample's source behind `sample.box`) and **S3a the same night**
  (`plugins/boxes`: the data, the panel in the Generate pane, the six commands, the generate source), **S3b** the
  same night (the canvas tool X and the overlay), **S3c** the next session (the crop frame, the paste warning), **S3d**
  the session after (one Boxes switch under the prompt field, the first box turns it on), **S3e** the one after (the
  caption's place words, ids from the description, the warnings, the tool's hit order); none released, all under
  Unreleased. The live checks §6.1-6.3 ran on 2026-10-02 night, released in 0.1.37 the same night; S4 optional. **S5 (Ideogram 4)
  built 2026-10-03** after live check §6.4 (fal passes the caption), released in 0.1.39 the same day.
- 26: reference layers named in the prompt as `@img1`, written as each model's own name for the picture: built
  (S1-S5, 2026-09-29; `docs/PLAN_REFS.md`), released as 0.1.34 the same night.
- 27: groups with their own opacity and blend mode (isolated groups: the group composited first, then faded or blended
  as one, so overlapping layers inside do not show through each other; a nested composite in every path and the
  blend-atop ops in the kernel, 7 - 9 days; `docs/PLAN_0_1_31.md` §6 step 5). Parked, someday maybe (the user,
  2026-09-30: "nicht so wichtig"; merging the layers and setting that layer's opacity does it today).
- 29: FLUX 3 Image on the other providers (the user, 2026-10-02): fal (blackforestlabs/flux-3/edit-image and its text
  sibling), WaveSpeed (the user's link was image-to-video; whether it has FLUX 3 Image is part of the research),
  OpenRouter (black-forest-labs/flux-3-image) and Oxen.ai (flux-3-image), as variants of `recipes/flux3.json` on the
  existing adapters. Researched: `docs/PLAN_FLUX3.md` "FLUX 3 Image on other providers". **Comfy Router (B1) and OpenRouter
  (B3) built 2026-10-02 late night, run live and released in 0.1.38 (2026-10-03)**; **fal (B4), Oxen (B5) and WaveSpeed (B6) built 2026-10-03**,
  released in 0.1.39 (2026-10-03), not run live.
- 30: Ideogram 4 support as an update of its own (the user, 2026-10-02: "ein anderer release", not with item 28's
  boxes). Known so far (one web search, 2026-10-02): Ideogram 4.0 is Ideogram's first open-weight model (9.3B flow
  DiT, Qwen3-VL-8B text encoder, June 2026; weights non-commercial, 256-2048 px, aspects up to 6:1), structured JSON
  prompts with bounding boxes, Turbo / Default / Quality tiers on Ideogram's own API, a remote MCP server; on fal
  since September 2026. Scumble today: `recipes/ideogram_4.json` (fal `ideogram/v4/image-to-image`, Comfy Router and
  Oxen text only); fal ran live 2026-10-03 with the boxes as its JSON caption (B2, item 28 S5). Open: Ideogram's own API as a direct adapter (the tiers, edit / remix with a
  mask?), a local ComfyUI recipe on the open weights (the user has Ideogram 4 nodes), the JSON caption with the
  boxes (item 28 S5, built 2026-10-03 on fal). Not researched in depth, nothing planned.
- 31: Ideogram 4.5 (the user, 2026-10-02: "kannst du in diesem release noch ideogram 4.5 hinzufügen", then "nur über
  documentation hinzufügen, kein test nötig"): in the next release with item 28, built from the providers' docs only,
  no live run. Hosts: Replicate (`ideogram-ai/ideogram-4-5`), Comfy Router (the schema saved as
  `tools/refs/comfyrouter/ideogram_ideogram-4-5.json`), WaveSpeed (`ideogram-ai/ideogram-v4.5/edit` and siblings); the
  adapters exist. Research and the build plan: `docs/PLAN_IDEOGRAM45.md`. **I0 + I1 built 2026-10-02** (the shared
  helpers, `recipes/ideogram_4_5.json` with its Replicate variant, `tools/ideogram45_test.js`; Unreleased), **I2** the
  same day (the WaveSpeed variant, the `accepts` allowlist), **I3** the same day (the Comfy Router variant), **the README / MANUAL lines** the same day: built, under
  Unreleased. Released in 0.1.37 (2026-10-02 night), never run live.
- 32: a popup when a new version is out (the user, 2026-10-02 night: "Beim start der app nach updates suchen und mit pop
  up benachrichtigen wenn es eine neue version gibt"). **Half of it exists:** the installed app checks GitHub 8 s after
  the start (`main.js` `updater.check()`, unless *Settings > Updates* has it off; not headless, not in agent mode, not
  in the Store copy), downloads by itself (`autoDownload`) and then shows only a quiet `Update to <version>` button in
  the title row (`#shell-update`); the release notes sit in *Settings > Updates*. Missing: a dialog through item 25's
  `renderer/dialogs.js` once the update is downloaded, with the version and its CHANGELOG notes, *Restart and update* /
  *Later* (maybe *Skip this version*); once per version, not on every start; not while a document is busy or unsaved
  without asking first (the restart path `restartPlan` exists); none in the Store copy (the Store updates it) and none
  for Linux packages that cannot update themselves. Small (about half a day); planned as `docs/PLAN_0_1_38.md` A1. **Built 2026-10-02 late night** (c3872b7), with a real
  Skip (no install on quit), released in 0.1.38 (2026-10-03).
- 33: every box its own colour and a double click that describes a box on the canvas (the user, 2026-10-02 night,
  with a screenshot of six green boxes: "jede neu box soll eine andere farbe haben", then "mit doppelklick auf die box
  ... den prompt im canvas in die box schreiben"): built the same night (7de1423), released in 0.1.38 (2026-10-03).
- 34: Generate new with presets and boxes (the user, 2026-10-03: "wie können wir flux3 bbox prompting als 'generate
  new' nutzen? macht es sinn presets für 'new' zu nehmen ... aspect ratio und model auswahl ... 1k, 2k, 4k"): a New
  dialog with the model, its own aspect presets and its size classes makes the canvas the boxes are drawn on in the
  output's aspect; Generate new follows the document's aspect while boxes go. Today the dialog's aspect is its own
  (1:1 at first, then the last one), so boxes go stretched when it differs from the canvas (BFL: send the aspect the
  boxes were designed for); FLUX 3 takes only New boxes on a new image, and Generate new with boxes never ran live on
  FLUX 3. `docs/PLAN_NEW_PRESETS.md` (what exists, the trap, four steps, the user's answers of 2026-10-11, section 8 the
  build). **Built 2026-10-11 for 0.1.46** (`ee7194c`, review fixes `ab8e6b2`).
- 35: ComfyUI in Scumble (the user, 2026-10-03: "ist es möglich eine art browser in scumble zu öffnen in dem dann
  comfyui läuft?", the point being the connection to the recipes, "das ist erstmal das wichtigste update", and "auch
  die option testen comfy.cloud in scumble"): ComfyUI's own page in a window of its own (a `BaseWindow` with Scumble's
  bar on top), a recipe opened there as its graph and the graph saved back as a recipe; Comfy Cloud in the same window,
  and recipes without the Inpaint Canvas node (Comfy Cloud has none and takes no custom nodes) run there through
  `comfycloud.js`'s calls. The user's answers (2026-10-03): a window of its own, Comfy Cloud API access yes, *Save to
  recipe* overwrites, all five steps in **one update**, the *ComfyUI* button after *Help* and *Assistant*. Two rules for
  every step (the user, the same day): **Scumble keeps working without any ComfyUI installed**, and **no ComfyUI
  install path is assumed** (users' installs differ; everything through the URL and `/object_info`): §2.5.
  `docs/PLAN_COMFY_VIEW.md`: what exists, the design, V1-V5 (one session each), the traps. **Built (V1-V5) and
  released in 0.1.41** (`electron/main/comfyview.js`, `renderer/comfybar.html`).
- 36: a portable version as a `.zip`, from the release after 0.1.41 on (the user, 2026-10-03: "ab dem nächsten release
  auch als portable version, ja, als .zip"; asked first whether it is usual: yes in Scumble's field, ComfyUI itself
  ships as "windows portable", Blender / Krita / Inkscape offer zips). Agreed shape: the `win-unpacked` folder zipped
  (not electron-builder's one-file `portable` target, which unpacks to a temp folder on every start); a marker next to
  `Scumble.exe` puts every app-data path (settings, autosave, the file mirror, plugins, helper models, documents'
  temps) into a folder beside it (`app.setPath("userData", ...)` before anything reads it, the single-instance pipe
  follows the path); API keys stay bound to the Windows account (safeStorage / DPAPI), so another PC asks for them
  again (the manual says so); no self-update (electron-updater does not do zips): item 32's dialog shows *Download*
  with the release link instead of *Restart and update*; MCP registration names the exe's own path. CI: a zip asset in
  `.github/workflows/build.yml` beside the installer; the installer stays the recommended download (README, website).
  To test: the data folder (quit, document, autosave, settings gates on a portable layout), two portable copies side by
  side, the update notice. About half a day to a day. **P1 (the data folder, the update notice, stale keys) and P2
  (`npm run dist:portable` = `tools/portable_zip.js`, the CI upload to the draft, the docs) built 2026-10-05**
  (`docs/PLAN_0_1_42.md`); P3 (the `portable` gate on the exe, on the user's word) is open.

## Gate runner and flakes

`bash tools/run_gates.sh <label> [--strict] [--copy] [--tiles on|off] [--offline] [--exe PATH] <gates...>` starts a fresh instance on
port 9555 with its own profile (with `test_base.png`), runs each gate with a timeout, and writes logs and `summary.txt` under
`dist/gates/gates/<label>/` (or `$SCUMBLE_GATES`). `tools/close_app.py` closes an instance by its DevTools port
(`SCUMBLE_CDP_PORT`). Gates: `pixels editor composite commands shape brush film glb ailabel size transparent generate log
mcp nodecopy toapis openrouter ark recipes assistant llm export pxjobs upscale layered platform lint types help skins
magnific oxen quit document docux metadata tiff canvasonly clip groups comfyview portable selection limit maps depth maskview edges depthfx grading masks effects mcpb blendmodes relight`, plus `docperf:<W>x<H>` (a .scumble save and open at size), `smoke` (a real Flux run; check `/queue` first, and not while the user needs
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
- `git add a b c` stages nothing when one path matches no file (the source of a `git mv`, already staged as the
  rename): the commit then holds only what was staged before (B3's renames without their edits, 2026-10-14). Never
  hide `git add`'s errors (`2>/dev/null`); check `git diff --cached --name-status` before every commit.
- A comment edit in `crates/px/src/*.rs` changes the wasm bytes (panic locations carry line numbers): rebuild with
  `python tools/build_px.py` after any `.rs` edit, then `--check`.
- `editor_test.py`'s steps are Python strings that are not raw: `\\n` in their JS, or `String.fromCharCode(10)`; a
  plain `\n` becomes a newline inside a JS string literal.
- The node's publish action runs on a push only when `pyproject.toml` changes; otherwise
  `gh workflow run publish_action.yml --repo DenRakEiw/ComfyUI-InpaintCanvas --ref master`.
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
- The ComfyUI window (item 35, `docs/PLAN_COMFY_VIEW.md`): `electron/main/comfyview.js` (a `BaseWindow` made at the
  first open: the bar `scumble://app/comfybar.html` with `electron/comfybar_preload.js`, whose `comfyview:*` calls
  main answers for the bar alone, over the page, a `WebContentsView` in `persist:comfyui` with no preload). The
  auth of *Settings › ComfyUI* goes on as headers for the target's origin only; `--no-comfy` shows the start page
  unless a test passes a stub's URL. `tools/cdp.py` skips the bar's target.
- Documents (`.scumble`): `host.saveDocument` / `openDocument` (`renderer/editor/host.js`: `flushEditor` uploads the
  edited layers first, `documentDirty` / `settleKey` keep the "*", `rememberClosed` / `reopenClosed` the closed tabs)
  -> IPC `documents:*` -> `electron/main/documents.js` (a job per request, a lock per path, `idle()` for the quit) ->
  `electron/main/docfile.js` (the stored zip, temp file and rename, the mirror import). `docs/DOCUMENTS.md`.
- Provider runs: `host.runProvider` (the recipe resolved to the chosen provider's variant by
  `shell.js`) → `renderer/editor/stitch.js` (crop) → IPC `provider:edit` →
  `electron/main/providers/index.js` picks the adapter and the key (`keys.js`), lays the pictures out with the
  adapter's `layout(req)` and resolves the prompt's markers `{@ref:i}` against it (`providers/refs.js`, item 26) →
  `stitch.js` (composite mask, colour match) → mirror upload → `addResults`. Recipe
  formats in `docs/RECIPES.md`. The prompt's `@img1` tokens follow the reference layers by id
  (`renderer/editor/reftokens.js`, `refsMutated` at every change of the shown references; `docs/PLAN_REFS.md` C2).

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
