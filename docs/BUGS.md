# Bug list

Reported and not yet fixed. One section per bug: what was seen, what is already known
about it, and what has to be measured before anyone writes code. A bug leaves this file
when it is fixed (with the release it went out in) or when it turns out not to be one.

Fixed bugs are not kept here - `CHANGELOG.md` has them per release, `docs/PERFORMANCE.md`
the ones that were performance work.

---

## Fixed, waiting for its release

### `cutout_layer` after an in-app cutout; filter params as a JSON string - fixed for 0.1.43 (B1 of docs/PLAN_0_1_43.md, 2026-10-07)

- **`cutout_layer` answered a failure after a successful in-app cutout** (seen 2026-10-07 by the trailer's setup agent:
  `ok: false` with the success text as its error). The in-app path finishes inside `cutoutLayer`, so the command's
  "nothing pending" check took success for "never started". `cutoutLayer` now answers `"started"` (a ComfyUI run that
  `applyCutoutFile` finishes), `"done"` (the in-app mask applied) or `false` (nothing started or the in-app run failed,
  the status says why); the command throws only on `false` and waits only on `"started"`.
- **Filter params sent as a JSON string were refused** (Claude Sonnet 5 through OpenRouter sent
  `"{\"color\": \"#ff2d2d\"}"` and retried until the assistant's step cap). `checkParams` parses a string that holds
  a JSON object; any other string is refused as before. The MCP schema declares `params` as an object already.
- Test: `commands` step `cutout_and_string_params` (a stub in-app model: done, failing, none; `add_filter` /
  `set_filter` with string params, three refused strings, nothing added). It fails on the old code with the reported
  symptom. Tiles backend.

### The six the user picked for 0.1.42 - fixed for 0.1.42 (F1 of docs/PLAN_0_1_42.md, 2026-10-05)

**Picked** 2026-10-04 ("alle sechs"). Five were found by reading while planning the in-app assistant (2026-09-19), the
film look's grain by the gap review of 2026-09-26; none had been reported or run.

- **`flip_layer` axis x flipped vertically.** The command passed `"x"` / `"y"`, and `flipLayer` mirrors horizontally
  only for `"h"`. Now x is `"h"` (left to right), y `"v"` (top to bottom), and the description says so; an agent that
  compensated gets the other flip (the CHANGELOG says so). Test: `commands` step `layer_flip_and_refusals` (a probe
  layer's bytes against its mirror by x, by y, by the default axis; the three undo steps' labels).
- **`remove_layer` reported success on a locked layer**, and `flip_layer` / `center_layer` were silent no-ops on a
  locked or a filter layer. The commands refuse before the editor is called (`refuseLayer` in `renderer/commands.js`):
  "layer <name> is locked: unlock it first (set_layer locked false)", "... locked by its group: unlock the group first
  (set_group locked false)", "layer <name> is a filter layer: it cannot be flipped / centred". The ailabel and glb
  plugins get the refusal as an error (ailabel's Add no longer adds a second label beside a locked one). Test: the
  same step (each command on a locked layer, a group's lock, a filter layer; nothing changes).
- **The compat key went to any URL `llm:models` was given.** `compatModels` sends the key only when the URL makes the
  same base (`compatBase`) as the saved `settings.llm.compat.url`; any other URL, or any URL without a saved one, is
  asked without it. The Test button saves the URL before it asks. Test: `tools/llm_images_test.js` section 9 (plain
  Node, a stub fetch; the `llm` gate runs it).
- **Ctrl+Enter started a second provider run while one was running.** `generate()` (shared with the node) refuses a
  run that needs the document's slot (the app host's `resultInputState` now says `provider: true` for a provider
  recipe) while `providerPending` is set, before the seed is rolled or the button is freed under the first run: "A run
  is still going: wait for it, or Cancel." A recipe on the user's ComfyUI takes no slot and keeps queueing, also while
  a pass or an upscale holds it; the node's host says no `provider` and has no slot. (Since R2a `runProvider` itself
  refused a second run, but only after `generate()` had rolled the seed and re-enabled the button.) Test: `editor` step
  `ctrl_enter_waits_for_the_api_run` (a stub run that never answers; the editor's keys and the prompt field; the
  ComfyUI recipe queueing while the slot is held; the API recipe again after the run).
- **The film look "None (adjustments only)" added grain** (`plugins/film/filters.js` fell back to `amount: 25`
  without a stock): the fallback is `amount: 0`. Test: the `film` gate's `look_commands` step (None's Grain slider at
  0, default and 200 % gives the same bytes on the CPU and the GPU path).
- **The MCP annotations were incomplete.** The command definitions carry `readOnly` / `destructive`
  (`renderer/commands.js`, the plugins through `commands.register`), `describe()` hands them on (null for a plugin
  command that sets none) and `electron/main/mcp/server.js` reads them; a plugin command without flags is judged by
  its name after the plugin id (read-only for `list...`, `get_...`, `info`, `status`; never destructive). The plan's
  names plus `save_document`, `delete_snapshot`, `straighten_canvas` and `ailabel.remove` (destructive) and
  `boxes.list` (read-only), which the 2026-09-19 reading predates or missed. Test: `mcp_test.py`'s tool list checks the
  hints by name and the fallback through `toTool`; `docs/MCP.md` "Hints", `docs/COMMANDS.md` shows them.

### A headless MCP instance of the dev tree took the user's profile - fixed for 0.1.36

**Reported** 2026-09-16 ("wieso kann ich die app nicht starten?"), during a Claude Code session in `F:\canvas`.

**Seen:** starting Scumble showed no window at all. Two processes were running, both started by that session's MCP
registration (`.mcp.json`: `electron.exe electron/main/mcp/launch.js --mcp`, i.e. the dev app from `F:\canvas`):
the launcher and `electron.exe F:\canvas --mcp`. No Scumble was running when the session began, so the MCP server had
started the app **headless** (`AgentBackend` in `electron/main/main.js`), on the default profile `%APPDATA%\Scumble`.
It held that profile's single-instance lock since the start of the session. After both were stopped, the packaged app
started normally.

**Known:** both instances use the same `userData`, so a second start is meant to hand over to the running one:
`app.on("second-instance", () => showWindow())` (`main.js` 573 for the headless agent path, 626 for the normal start),
and `showWindow()` creates the window or restores a hidden one. `docs/MCP.md` and CLAUDE.md say "a second start of
Scumble shows it". Here nothing appeared.

**Not known, to measure first:**
- Which binary the user started (the installed 0.1.14 in `%LOCALAPPDATA%\Programs`, or `dist\win-unpacked\Scumble.exe`),
  and whether a second start of the **same** build as the headless one shows the window (dev headless + dev start,
  exe headless + exe start). A dev and a packaged Electron may not share the lock or the hand-over.
- Whether `second-instance` fires in the headless instance at all (log it), and whether `showWindow()` then creates a
  window that stays hidden or off screen.
- Whether the headless instance's renderer was ready (`bridge` ready) when the second start arrived.

**Measured 2026-10-01 (0.1.35 code, a scratch profile, port 9571):** the dev launcher with `--mcp` and stdin held open
starts the app headless (no window in the process list); a second start on the same profile exits in 0.2 to 0.3 s and
the headless instance's window comes up ("Scumble - 1 agent connected"), both with the dev app (`electron.exe F:\canvas`)
and with the packaged `dist/win-unpacked/Scumble.exe` as the second start. The dev app's `productName` gives it the
installed app's `%APPDATA%\Scumble`, so the two share the lock. The hand-over works; "no window at all" did not come
back (the default profile itself was not tried: the user's app was running on it). `showWindow`'s `restore()` is in
since 0.1.0. What stays (`docs/HISTORY.md`, 0.1.28): a Start-menu Scumble hands over to the **dev tree** on the
user's own profile, so the user sees the dev window (its version, no updater) and dev code writes their autosave.

**Workaround:** start Scumble before Claude Code, so the MCP server drives the visible window; or stop the leftover
`electron.exe ... --mcp` processes. A fix belongs in the hand-over (the running headless instance shows its window on a
second start of any build), with a gate step in `tools/mcp_test.py`: start headless through the launcher, start the
app a second time, assert a visible window within a few seconds.

**Fixed** 2026-10-01 on the user's pick ("nur verbinden"): `--attach-only` (with `--mcp` / `--cmd`) drives a running
instance and never starts one; the repo's `.mcp.json` passes it. With no Scumble running the server lists `ping` alone
and answers "Scumble is not running"; the first call that reaches a started Scumble sends `tools/list_changed`.
`tools/mcp_attach_test.py` (in the `mcp` gate, a profile of its own, port 9573): ping alone and no renderer on the
profile, the attach (proxy mode, 89 tools, one list_changed), the instance closed and still nothing started. Without the
switch the server keeps its old behaviour (installed registrations, `Help > Copy MCP registration`).

### Switching between the local recipes kept the other recipe's model files - fixed for 0.1.36

**Found** by the review of item 26 step 26e (read, and reproduced in a plain-Node copy of the three functions; not run in
the app, not queued): Qwen Image Edit 2.1 and FLUX.2 Klein (both local) name their loaders `unet`, `clip` and `vae`
(settings rows 1-3). `host.settingTargets`' local branch sets the target's `node.id` to the bare node name, and
`settingsChanged` (`inpaint_canvas.js`) keeps a stored value while `${node.id}:${inputName}` stays the same, so after Qwen
then Klein the Klein chain is queued with `unet_name = qwen_image_2.1_int8_convrot.safetensors`, Qwen's text encoder
(with `CLIPLoader` type `flux2`) and Qwen's VAE; the other way round too. The combo fallback only changes a value missing
from the server's list, and both families' files can be installed. Older than 26e (the rows are the same before it). The
provider branch of `settingTargets` already has the fix for the same collision (the recipe id in the node id). Fix: a
target key with the recipe id (`${r.id}/${node}:${input}`) for the local rows, compared and stored by `settingsChanged`
(the node's editor has no such key and keeps its behaviour); a document saved before the fix then resets these rows once
to the recipe's defaults. Test: the recipes gate's 26e step queues Qwen then Klein; assert Klein's own `unet_name`,
`clip_name`, `vae_name`, and the reverse.

**Fixed** 2026-10-01: the local rows of `host.settingTargets` carry `key: ${r.id}/${node}:${input}`, and
`settingsChanged` stores and compares `t.key` when there is one (the node's graph targets have none and keep
`${node.id}:${input}`). `node.id` stays the bare node name, so saved presets (`recipePresets`, keyed by it) still match.
The recipes gate's 26e step queues Qwen, Klein, Qwen, Klein and asserts every settings row of each run is its own
recipe's default; without the key it fails on Klein with Qwen's three files. Tiles, offline; not queued on a server.

### Generate new on Gemini direct ignored the asked aspect while the Aspect row said "auto" - fixed for 0.1.36

**Found** by the adapter review of item 26 step 26f (read, not run live): `gemini.js` sets `imageConfig.aspectRatio =
req.aspect` on a text run only when the params hold no `aspect_ratio`, and the variants' Aspect row defaults to "auto",
which the later line skips; so a Generate new without reference layers sends no aspect at all and the model answers in its
own shape, whatever the dialog asked (16:9 comes back square). With reference layers 26f already sends the asked aspect
(or the closest of Gemini's ratios for a free size). Fix: treat "auto" like no row on a text run (`!p.aspect_ratio ||
p.aspect_ratio === "auto"`); it changes the 0-reference request, so `tools/refs_layout_test.js`'s byte-for-byte check of
Gemini's text body moves with it. The Router's vertexai dialect had the same gap with references and was fixed in 26f.

**Fixed** 2026-10-01: the line reads `(!p.aspect_ratio || p.aspect_ratio === "auto")`. `refs_layout_test.js` lets the
before-26f comparison take Gemini's new `aspectRatio` and checks each Gemini text variant at "auto" (16:9 goes) and at
3:2 (3:2 goes); the three checks fail on the old adapter. The Size row's "auto" stays the model's own size (Lite offers
only auto and 1K). Not run live.

---

## Open

### Generate new on WaveSpeed without references goes to model ids that may not exist (found 2026-10-07, read, not run)

**Found** while building Nano Banana 2.1's WaveSpeed variant (N2 of `docs/PLAN_0_1_43.md`). A WaveSpeed variant
without `text.model` sends a new image to its edit id with `/edit` cut off (`textModelOf`, `electron/main/recipes.js`):
`google/nano-banana-2`, `openai/gpt-image-2`, `wavespeed-ai/flux-2-pro` and so on. WaveSpeed's model pages for those
ids answer 404, and the same ids with `/text-to-image` answer 200 (checked 2026-10-07 on `wavespeed.ai/models/<id>`):
flux2_flex, flux2_klein (`flux-2-klein-9b`), flux2_max, flux2_pro, gpt_image_2, gpt_image_2_5_flare, `_sunburst`,
nano_banana_2, nano_banana_2_lite, nano_banana_pro. Reve's `reve/2.1/text-to-image` answers 404 too. With reference
layers the run goes to the `/edit` route (`text.refs.model`) and is not affected; the Seedream, Qwen, FLUX 3, Ideogram
4.5 and FLUX.1 Fill ids answer 200. A 404 page is no proof that the API refuses the id; one Generate new on WaveSpeed
with a key settles it. **The fix if it holds:** `text.model` `<id>/text-to-image` on each variant (as FLUX 3 and Nano
Banana 2.1 have), or `textModelOf` writing `/text-to-image` for WaveSpeed; check each text page's fields (aspect,
resolution) against what the edit's Settings rows send. Light tier.

### Size limits: gaps found reading the code (2026-10-07, read, not run)

Found while answering the user's question about the largest picture (a workflow of three readers and a checker,
every number checked at its file:line). The document ceiling itself holds: 65,535 px a side and 1,073,741,824 px on
the tile backend (`inpaint_canvas.js` `checkBaseSize`, refusals tested in `editor_test.py`).
- **A whole-picture upscale is not refused before it is paid for.** `docs/MANUAL.md` (the Upscale section) says a
  factor that would pass 65,535 px / about a gigapixel is refused "before it costs you anything"; the code checks only
  the recipe's `limits.out` before sending (`host.js` near 1707-1716). The answer lands through `resizeImage` ->
  the unchecked `makeCanvas` of `inpaint_canvas.js` (about 698-702), so a result above the canvas limit (Magnific
  Precision 4096 px x 16 = 65,536 px, SeedVR2 4096 x 4096 x 8) fails or comes out empty after the provider was paid.
- **Resize (the panel) and Extend check no target size.** Both use that unchecked `makeCanvas`; only the MCP
  `resize_image` checks (65,535 px, 268 MP). The panel's `max=16384` is an HTML attribute; typed values pass. Above
  268 MP Chromium's canvas draws and reads nothing, so an empty base is possible. Not measured.
- **JPEG / WebP above 268 MP are not refused** although a comment in `inpaint_canvas.js` (near 548) and
  `docs/PLAN_BCE.md` promise a refusal that names PNG; the file goes to `createImageBitmap` in a worker. Not measured.
- **PNG / TIFF export with a size or a frame** caps each side at 32,768 px silently and goes through one canvas: an
  output above 268 MP from a smaller document is not checked (`host.js` near 582-632).
- **The PSD fallback writer** (canvas backend, or no worker pool) checks neither the 30,000 px side nor the 4 GiB
  section limit that the banded writer checks (`inpaint_bands.js` near 289).
- **Files above 2 GiB fail to open from the dialog or a path** (`fsp.readFile` in `electron/main/main.js` near 760);
  drag and drop is not affected. Not documented.
- `docs/PERFORMANCE.md` (near 147) still says about 8 GB of pixels per renderer; 15.5 GB was measured later (§14).
- The `huge` gate (30k) last ran on 0.1.20 (2026-09-19); 0.1.21-0.1.42 were never checked at 30k, and nothing between
  600 MP and 1 GiP was ever opened.
**To do first:** run `huge:30000x20000` on the current exe; then one check per item above (each refusal before any
paid run or any canvas is made), and the manual's Upscale sentence corrected or made true.

### The node cannot be installed through the Manager: every registry version is flagged (found 2026-10-07, read)

Found by the promotion research (read-only, `https://api.comfy.org/nodes/comfyui-inpaintcanvas/versions?include_status_reason=true`):
every version of ComfyUI-InpaintCanvas on the Comfy Registry is `NodeVersionStatusFlagged`. 0.2.0-0.3.1 carry the
manual verdict "policy-v0.4: PATH_TRAVERSAL", 0.3.2 and 0.3.3 "policy-v0.5: path-traversal" (all by the same Comfy
reviewer; 0.3.3's verdict read again 2026-10-07 afternoon). The scanner's six info-level findings are all in
`DEVELOPMENT.md`, `docs/shots.py` and `mcp/inpaint_canvas_mcp.py`, none in `nodes.py`. With no active version the Manager has nothing
to install (registry downloads: 3), and the node is missing from ComfyUI-Manager's `custom-node-list.json` and
`extension-node-map.json` too. So the local route of Scumble fails for anyone without a git clone.
**Known (read, not verified against the reviewer):** the node's `_ref_path` (`nodes.py` near 64-77) checks
`commonpath` on `abspath`, not `realpath` (a symlink or junction inside the input folder can lead out), and the routes
`/inpaint_canvas/upload` and `/cleanup` take no authentication (`/command` answers loopback only). An earlier pack was accepted into the
Manager list after a realpath + commonpath fix (DenRakEiw_Nodes, 2026-09-23).
**Also:** `README.md` (near 124) and `docs/MANUAL.md` (near 55) say Scumble "offers to install it through the ComfyUI
Manager"; the code only prints "install ComfyUI-InpaintCanvas there (Manager or git clone)" (`renderer/shell.js` near
359, `renderer/editor/host.js` near 951). The node's `pyproject.toml` description still opens with another product's
name (changes with the next node publish).
**To do first:** ask the reviewer which path they mean (the registry issue), fix the path checks with realpath, decide
on the routes, publish a node version, then a PR to the Manager list; correct README and manual now.
**Texts corrected 2026-10-07 (local, not pushed):** README "What you need to render" and MANUAL "Where it renders"
now say Scumble only reports a missing pack and give the `cd ComfyUI/custom_nodes` + `git clone` lines (the Manager
once the pack is listed again), `CLAUDE.md`'s decision line too; the app's two messages still say "Manager or git clone".
**Node 0.3.4 prepared 2026-10-07 (local, not pushed):** the branch `registry-0.3.4` in the worktree `dist/node_wt`
(realpath + commonpath for every client-given path, safe file-name tokens in Mask Out / Object Map / Stitch, a
`.comfyignore` that keeps `docs/`, `mcp/`, `tests/`, `DEVELOPMENT.md` out of the package, the description without the
comparison, 23 path tests); the push, the registry note and the Manager PR in `dist/node_release/`, all on the user's word.

### Found while recording the trailer's takes (2026-10-07, run live, not fixed)

- **The ComfyUI window lays a shipped recipe out as one column.** `flux2_klein_local` opens about 7,400 graph units
  tall: `loadApiJson`'s `graph.arrange()` puts almost every node in one column (the node ids are strings such as
  `canvas`). A recipe saved from the window with a UI graph opens laid out.
- **The ComfyUI window's tab name drops everything before a "/"** in the recipe name: "Flux.2 Klein 4B / 9B (ComfyUI)"
  shows as "9B (ComfyUI)".
- **A recipe with a saved UI graph opens as "Unsaved Workflow (2)"**: `comfyview.js` passes `loadGraphData` no name.
- **The film-look thumbnails preview each stock over the active look** (`plugins/film/main.js` near 100: the previews
  are drawn over the whole composite, the active look included), so after a black-and-white look every thumbnail is
  grey, while a click replaces the look.
- **The assistant's privacy notice never clears.** Nothing in `renderer/` calls `assistant:noticed` (only the
  preload entry, `electron/preload.js` near 220, and the handler in `electron/main/main.js` near 1178), so each
  provider's notice stays in the panel header, while `docs/ASSISTANT.md` (near 151) says it shows until the first
  send.
- **The Film looks grid shows one column of 46**: the panel section computes `align-items: center`, so `.film-grid`
  (`renderer/shell.css` near 132, `auto-fill minmax(96px, 1fr)`) shrinks to about 103 px although the 304 px section
  fits three columns.
- **The assistant's privacy notice never goes away.** `docs/ASSISTANT.md` says the panel shows the one-line notice
  per provider the first time you send to it; `assistant:noticed` (preload `window.scumble.assistant.noticed`,
  handler `electron/main/main.js` near 1178) is what clears it, and nothing in `renderer/` calls it, so `state()`
  keeps answering `notice` for that provider after every send (read, and seen in the agent take's setup, which
  calls it off camera). **Fix to check:** call it after the first send to a provider (or on the notice's close).
- **A dead OpenRouter key shows only at the first send.** The assistant's model picker reads OpenRouter's live list,
  which needs no key, so the panel looks ready with a key OpenRouter no longer knows; the first send ends on the
  error card `HTTP 401: {"error":{"message":"User not found.","code":401}}` ($0). Seen with the trailer profile's
  key. A key check on save (OpenRouter's `GET /api/v1/key`) or a plainer error line would catch it.

### The main process grew to 29 GB while building the trailer's assets (seen 2026-10-07, dev instance; one step measured)

**Seen:** the trailer's recording instance (a dev instance of main at e7866f8, `--no-comfy`, profile
`dist/video/trailer/trailer_rec_profile`) held 28.6 GB private memory in its **main** process (the renderer 3 GB, the
GPU process 1.5 GB) after about an hour of scripted work: a 5456 x 3072 document with five layers built and saved
(101 MB .scumble), full-size `export_layer` PNGs (32-35 MB each) and composites, then six more 5456 x 3072 documents,
several `select_point` / `select_rect` selections and a few FLUX 3 Image runs on Black Forest Labs. The user's RAM
ran short. A restart frees it (the trailer workflow now restarts the instance between steps).
**Measured since** (the trailer's cutlooks step, a fresh instance, one step at a time): main held 0.08 GB after the
start, 0.10 GB after `load_image` and `add_image_layer`, **23.06 GB after one in-app `cutout_layer`** (BiRefNet lite
on 5456 x 3072, 8.6 s), and stayed there after the tab was closed; a cold SAM2 `select_point` gave 6.1 GB; 92 look
exports gave no growth. `electron/main/onnx/runtime.js` keeps one session per model file (`this.sessions`), so the
BiRefNet session (or its arena / the DirectML allocations behind it) is the main suspect. Not measured: whether a
second cutout grows it further, and how much of it is the session itself against tensors kept after the run.
**Not known before that measurement:** which of these holds the memory in main. Suspects, none checked: sharp / libvips caches of the exports,
the file mirror or the forward queue keeping upload buffers while not connected, `docfile.js` zip buffers per save,
the ONNX helper sessions' tensors per document, the provider path keeping request or response buffers.
**To measure first:** a fresh instance, one step at a time (a document load, a save, an export_layer at full size, a
select_point, a provider run), main's private bytes after each and after a forced GC (`--js-flags=--expose-gc`), and a
heap snapshot of main (CDP on the main process via `--inspect`) when it has grown: what retains the buffers.

### Generate new leaves the boxes behind when the model answers at another size (found 2026-10-05, run live)

**Found** in the video 3 test runs (`docs/TUTORIAL.md` section 5, "Test runs"): a 4096 x 2304 canvas, three New
boxes, Generate new on FLUX 3 Image (BFL). The request went out as 4096 x 2304, which `flux3.js` `tierOf` (by area)
sends as the 4k tier, and BFL's 4k tier at 16:9 is 5456 x 3072: the document became 5456 x 3072, the boxes kept their
4096 x 2304 rects (`boxes.list` after the run), so they sat about 25 % too far up and left of what they had placed.
The rows themselves were right: they are fractions of the frame (`[577,483,738,654]` on 0-1000), and the model put
everything where the boxes had been.

**Known (read):** the boxes follow the picture through the "geometry" event (`plugins/boxes/main.js:301`), which
`host.changed` emits for turn, crop, extend, resize and straighten (`inpaint_canvas.js:4559`, `:4669`, `:4870`).
`host.runGenerate` lands the answer with `editor.setBaseFromCanvas(c, { keepRefs: true })` at the model's size
(`renderer/editor/host.js` about 2080) and emits none. Any provider whose text route rounds or tiers the size does the
same (FLUX 3's tiers, presets elsewhere); a local Generate new (`newCanvas` at the asked size) does not.

**Possible fix:** after the landing, when `c.width x c.height` differs from the frame the boxes were measured in, emit a
geometry event with the scale `[c.width / frame.w, 0, 0, c.height / frame.h, 0, 0]` (kind "resize"), so every plugin
that keeps image coordinates follows; one undo step with the landing. Test: a plain-Node or editor step with a stub
provider that answers 1.33x larger, the boxes' rects scaled.

**Workaround (the video):** a canvas of the size the model answers with (5456 x 3072 for FLUX 3 4k at 16:9).

### A shown reference layer can take over an unrelated FLUX 3 edit (seen once 2026-10-05, run live)

**Seen** in the same test runs: after a From box had placed a cup from reference layer `@img1` (a kitchen photo), a
Remove box on a bin elsewhere (prompt "Take out the green bin.", no `@img1`) came back as the kitchen photo: the
result layer held the reference's scene instead of the street. The reference was still shown, so it went along as
image 2 (`ref_image_1`), as every shown reference does. FLUX 3's own expanded prompt (in the log) planned the removal
correctly ("Remove the green wheelie bin ... reconstructing the ... doorway, cream exterior wall, drainpipe ..."); the
picture it rendered was the other one. The crop was 5:7, the reference 3:4. With the layer hidden, the same edit
worked at once. One case, not repeated.

**To measure first:** whether it repeats (the same crop and reference, two or three runs, about $0.05 each) and
whether the near aspect matters (a 1:1 crop with the same reference did not do it).

**Possible fix, after the measurement:** for a variant whose model takes the references as free context (FLUX 3),
send only the references the prompt or a box names, or warn before a run that sends a shown reference nothing names
("@img1 goes along but nothing in the prompt uses it").

### The Realism Pass on RTX 40 and 30 is not proven to change pixels (found 2026-10-05, read, not run)

**Found** while checking OpenDLSS-NR for the user (`docs/PLAN_RTX_VSR.md` last section); no user reported it. The
Realism Pass ran live on the user's RTX 5090 only.

**Known (read, not run):**
- NVIDIA launched DLSS 5 Neural Rendering on 2026-09-03 for RTX 50 only; RTX 40 is announced for "later this fall",
  RTX 30 and 20 not at all (news, 2026-09-04).
- OpenDLSS-NR issue #3 (a third party, 2026-10-04): the signed `nvngx_dlssnr.dll` 310.8.0 holds only sm_120
  (Blackwell) kernels and no PTX; on an RTX 4080 Laptop "the bridge" (a ComfyUI one, not named) returned its input
  unchanged, without an error.
- The pack's runtime carries the modified build 310.8.SF.0 (unsigned, on the user's disk), which exists to run on RTX
  40 and 30; the pack's README claims RTX 30 / 40 / 50, RTX 30 as an experiment with a hash-checked pair of files.
- `verify_neural_rendering` (true in `recipes/realism_pass.json:25` and `renderer/editor/realism.js:464`) fails the run
  when the ReShade log shows no signed feature-18 execution: it reads a log line, not the pixels.
- `docs/MANUAL.md` (the Realism Pass's requirements) and the server check promise RTX 50, 40 and, as an experiment, 30.

**To measure first:** one Realism Pass on an RTX 40 card and one on an RTX 30 card (not the user's 5090), output
against input: the mean and largest difference per channel. A result that differs by noise only is a silent no-op.

**Possible fix, after the measurement:** if it is a no-op on a series, the server check refuses that series with the
reason (as it refuses RTX 20 today) and the manual says so; or Scumble compares the result with its input and warns
when they are nearly equal.

### The local Flux.2 Klein example fails in the sampler: "mat1 and mat2 shapes cannot be multiplied" (reported 2026-10-02)

**Reported** 2026-10-02 by a Reddit user, passed on by the user: "Yep, an error for me as well running the example
local workflow: RuntimeError: mat1 and mat2 shapes cannot be multiplied (1024x5120 and 12288x4096)". "As well" reads as
a second person with the same or a similar error in that thread (not seen).

**Seen:** the error text only; no log, no ComfyUI version, no model files.

**Known (read, not run):**
- "The example local workflow" is most likely the node's `examples/inpaint_canvas_flux2_klein_local.json`
  (ComfyUI-InpaintCanvas, commit 7e12b3f): a Flux.2 Klein 9B subgraph, `UNETLoader` `flux-2-klein-base-9b-fp8`,
  `CLIPLoader` `qwen_3_8b_fp8mixed` with type `flux2`, the Flux.2 VAE. The app's recipe "Flux.2 Klein local"
  (`recipes/flux2_klein_local.json`) is the same chain with `flux-2-klein-base-9b` / `qwen3_8b`; which of the two the
  reporter ran is not known.
- The shapes: the second matrix is a linear layer taking 12288 features to 4096, which fits Klein 9B's text input
  (three stacked hidden states of Qwen3 8B, 3 × 4096); the conditioning arrived as 1024 tokens of 5120 features. So the
  diffusion model is the 9B one and the text encoder is not the one it was trained with: a model of another size or
  family (5120 is the hidden size of Mistral Small 24B, Flux.2 dev's encoder, and of Qwen3 14B), or a ComfyUI that
  builds the wrong encoder for the file. Both readings are unverified. The error is raised inside ComfyUI's model
  forward, not in the node's code; the node's crop and stitch never see the conditioning.

**Not known, to measure first:**
- Which workflow, which file in the `CLIPLoader` (and its type), which diffusion model, which ComfyUI version (Klein's
  Qwen3 encoders need a ComfyUI from January 2026 or later). Ask on Reddit for the console log around the error.
- Reproduce on a free ComfyUI (not the user's production 8188 without their word): Klein 9B with `qwen_3_8b` (expected:
  runs), with Klein 4B's `qwen_3_4b`, and with Flux.2 dev's Mistral encoder, to see which one gives `1024x5120`.

**Possible fixes, after the measurement:** the example's note and the README name the exact text encoder per Klein
size (4B and 9B take different ones, and a mismatch fails only in the sampler); the app's local recipe check
(`/object_info`) could warn when the chosen text encoder file's name does not fit the diffusion model's size.

### Topaz Wonder's Redefine model may take a prompt (open since 0.1.27, needs a key)

Left over from the creative-upscaler fix of 0.1.27 (the Upscale dialog's Prompt field for recipes with `usesPrompt`):
Topaz Wonder's *Redefine* model takes a `prompt` on fal (its schema says so), Topaz Bloom only `autoprompt`; neither
recipe sends a prompt, because it is unknown whether the other Wonder models refuse one. Only a run with a key decides it.

### Smudge and the tone brushes still dab once per coalesced point (measured 2026-09-29, not a regression)

**Found** by the review of the eraser fix (0.1.33): `smudgeDab` (smudge, blur, sharpen, dodge / burn, sponge) is still
called once per coalesced point (`onPointerMove`, `finishStroke`), each at least one dab with its own read and write of
the layer box. Measured with `brush_perf.js` at 15000 x 10000: smudge 700 px 73.8 ms a move with 8 coalesced points against
27.8 with one (200 px: 7.0 against 8.4). Not a regression: 0.1.31's smudge took 0.6 to 2.3 s a move, and the tone brushes
are new in 0.1.32. The same treatment as `layerStroke` would fix it (the move's points in one walk, dabs evenly along the
path past the start, one `touchSourceRect` over the move's box), but the smudge's look depends on its dab count (the
carry is laid down and picked up per dab), so a pen's smudge would change: the user's eye first.

### Found in the .scumble review (2026-09-26, read, not run)

**Written** 2026-09-26 when `docs/DOCUMENTS.md` was written from the code (package 3b). The other findings of that
review are fixed (reserved Windows names, refs the document does not carry, `extra` in the ref walkers and the renames,
the temp registry after the rename, `summary.name`); these touch the shared editor code and wait (the user font renamed
on open is fixed for 0.1.32, above):

- **A layer of an unknown kind without a `ref` is dropped on open without a note** (`inpaint_canvas.js` `setValue`,
  `if (!l.ref) continue;`); the plan wanted a note. Only a document from a newer Scumble can hold one.
- **Canvas backend only: an undo back to the saved state leaves the tab's "*"** (measured by `docux`, 2026-09-26). The
  layer's upload name is a hash of its PNG, encoded through `createImageBitmap` of a GPU canvas; fully transparent
  pixels can come back with other colour bytes, so the same visible pixels (0 differ) get another name and the state
  another hash. Tiles (the default) is exact. A fix would hash the pixels with transparent colour zeroed, or zero it
  before the encode.

### Reference layers dropped without a word (found for item 26, 2026-09-29, read, not run)

**Written** 2026-09-29 while `docs/PLAN_REFS.md` was researched (code and vendor docs read, nothing run). A visible
reference layer can fail to reach the model without any message. Steps 26a2 and 26e of that plan fix these. The Klein
item could also be fixed on its own. **Step 26a2 (2026-09-29, plain-Node tests, not run live)** fixed the provider
items: every route now sends every picture, refuses before any request past its cap, or declares the drop, and then
sends no reference at all and says so in the status line (`docs/RECIPES.md` "Reference pictures"). The local, Info
panel and node items stay for step 26e. **Step 26e (2026-09-29, not run on ComfyUI)** fixed the local and Info panel
items (`docs/RECIPES.md` "Reference images named in the prompt (local)"); the node item waits for a node release.

- **`flux2_klein_local` reads only batch pictures 0 and 1**, the crop and the next one. With Original on, no reference
  layer reaches the model. With Original off, only ref 1 does, and ref 2+ are dropped. The recipe's description names
  only the Original case. `qwen_image_edit_2_1_local` reads 3 pictures, and `ImageFromBatch` clamps, so with fewer
  pictures the last one is repeated into the empty slots. **Fixed in 26e (2026-09-29):** Klein reads up to 4 pictures
  (the crop and three more as reference latents at 1 MP each), Qwen 2.1 up to 10; the encoder inputs past the batch a
  run sends are left out of the queued prompt, so nothing repeats (the same seed now gives another result). A
  reference past the recipe's slots is refused when the prompt names it and otherwise left out with "img3 is not
  sent" in the status line. Neither widened graph has run.
- **BFL keeps 7 references** (`bfl.js:23`, `slice(0, 7)`) and drops the rest silently. FLUX.2 klein on BFL takes only
  4 pictures in total, and nothing enforces that. **Fixed in 26a2 (2026-09-29):** every reference goes
  (`input_image_2` ..), the layout's `max` is 4 for klein and 8 for FLUX.2 pro / flex / max, and a run past it is
  refused before any request (the builder checks too, for a direct call).
- **Comfy Cloud cuts Qwen after 3 pictures** (`comfycloud.js:105`). `GeminiImage2Node`, `GeminiImageNode` and
  `FluxProFillNode` upload the references but never wire them; so do the four upscaler nodes when a recipe runs them
  as an edit, and an OpenAI node edit without `options.mask` uploads the mask and wires nothing (step 26a1's layout
  pin, 2026-09-29: every reference gets a LoadImage node, linked or not). **Fixed in 26a2 (2026-09-29):** a cap per
  node (`NODE_PICTURES`: Qwen 3, FLUX.2 8, GPT Image 16, Nano Banana 2 14, Seedream 10 / lite 14) refuses past it
  before any upload; the one-picture nodes and FLUX.1 Fill declare the drop; `buildGraph` uploads only the references
  and the mask the node wires. The `nano_banana_pro` Comfy Cloud note no longer contradicts itself or advises Original on.
- **Fill routes without an images field drop references**: flux1_fill on BFL / fal / Replicate / WaveSpeed, Qwen
  inpaint on fal, Z-Image turbo, Ideogram 4 on fal, and Replicate's Qwen Image Edit (`replicate.js:47-52`, crop only,
  although its note says "crop plus the reference layers"). **Fixed in 26a2 (2026-09-29):** each declares the drop,
  so no reference and no Original goes and the status line says what was not sent; Replicate's Qwen Image Edit note
  says the endpoint takes one picture.
- **FLUX.2 klein on Oxen has no `max_images`** and falls back to Oxen's default of 16. **Moved on in 26a2
  (2026-09-29):** Oxen's hub schema names no maximum either, so no cap was set; the variant is on the undocumented
  list in `docs/RECIPES.md` (BFL's own klein takes 4), until a live key shows what Oxen does past 4.
- **fal's caps are not checked**: Seedream edit on fal is said to keep the *last* pictures past its cap, which would
  drop the crop. Re-read the v5 lite / pro edit pages before relying on this. `flux-2/klein/9b/edit` uses only the first 4.
  **Fixed in 26a2 (2026-09-29):** fal's layout reads `options.max_images` and a run past it is refused before any
  request: Seedream 5 lite / pro 10, klein 4, FLUX.2 pro / flex / max 8, GPT Image 2 16, Grok Imagine 5 (sources in
  `docs/RECIPES.md`); fal's Nano Banana 2 and Pro name no number and are on the undocumented list.
- **flux1_fill on Comfy Router refuses any run with a visible reference** (`comfyrouter.js:205-209`, `max_images`
  defaults to 1), although its note says "The reference layers are not sent." `picturesFor` counts the references
  before the fill body drops them; step 26a1's layout declares the drop and `max` 1, and its pin expects the refusal.
  **Fixed in 26a2 (2026-09-29):** the declared drop strips the references before the adapter, so the run goes out
  with the crop and the mask and the status line says what was not sent; the recipe's note says so too.
- **A WaveSpeed fill whose variant sets `fields.images` sends no mask**: `inputFor` takes the image-list branch for
  it and never adds `mask_image` (found by step 26a1's layout check, 2026-09-29). No shipped variant does this.
  Still open after 26a2 (not a reference drop; the layout describes it as it is sent).
- **The Info panel's batch count ignores the refine pass**, which leaves the Original out (`inpaint_canvas.js:13225`).
  **Fixed in 26e (2026-09-29):** the count leaves the Original out on a refine pass in local mode (the node's copy
  with its next build), and on a local recipe of the app counts only the references the graph reads; the References
  row names each one (`img1 → <image3>`) and what is not sent.
- **The node skips a reference it cannot load** (`nodes.py` about 682, "reference skipped"), with only a print, and
  every later reference moves up one place. Still open after 26e, where it would make a local run's names point one
  picture off. Since 26e the app sends `named_refs: true` in `canvas_state` when the prompt named a reference; the
  next node release should raise instead of print at `nodes.py:684-685` when it is set.
- (The reference list's up / down: fixed by step 26b1, above under "Fixed".)

### Found while planning item 26 (2026-09-29, read, not run)

**Written** 2026-09-29 by the step planners of `docs/PLAN_REFS.md` (code read, nothing run). Each is fixed by the step
named.

- ~~**Replicate text runs send `aspect_ratio: "match_input_image"`**: `providerParams` includes `r.fixed`, and the
  params loop in `replicate.js` (about 42-60) overwrites the aspect the user asked for, so every Replicate FLUX.2, Nano
  Banana and Seedream Generate new sends it. Step 26f.~~ **Fixed in 26f (2026-09-29):** `replicate.js` holds a text run
  to its shape after the settings: the asked aspect wins, and without one (a free size, an agent's width and height) a
  fixed `match_input_image` becomes the preset closest to the asked size (1:1, 3:2, 2:3, 4:3, 3:4, 16:9, 9:16); a
  model that names no `aspect_ratio` (GPT Image 2) keeps its own default as before. Checked with a fake fetch against
  every shipped Replicate text shape (only the aspect changed); not run live.
- ~~**`llm.ask` never reads a language model row's `vision: false`**~~ **Fixed in 26d2 (2026-09-29):** a user row
  marked "Can see the picture: no" gets no picture at all, the crop included (the local endpoint's model too, looked up
  in every row of Settings › Language models); a built-in model id keeps winning over a user row of the same id, as
  everywhere. `tools/llm_images_test.js`.
- ~~**The local OpenAI-compatible endpoint retries any 4xx without the picture**~~ **Fixed in 26d2 (2026-09-29):** it
  steps down only on a 400 / 413 / 415 / 422 or a failure whose own text (the model id taken out) names images; a 401 /
  402 / 429, a 403 / 404 that names no image, or a server that cannot be reached costs one request.
  `tools/llm_images_test.js`.

### Linux: built, never run (B2, 2026-09-22)

**Written** 2026-09-22 with the Linux job of `.github/workflows/build.yml` (AppImage and .deb, `latest-linux.yml`).
This machine has no WSL and no Docker, so the Linux build has been **built by CI and run nowhere**: no gate, no
start, no helper, no update. What is known to need a look on a real Linux desktop:

- **Gates:** they are Python + CDP and `tools/run_gates.sh` is bash, so they should run; `--exe` takes the AppImage
  (`mcp_test.py` and `assistant_test.py` take `--exe` too). Not one has run.
- **The MCP registration** of an AppImage is `"$APPIMAGE" --mcp`, **without** the Node-mode launcher (a path inside
  the AppImage changes with every start). That assumes Electron writes nothing to stdout on Linux before our code
  runs (the stray CR LF the launcher exists for is Windows' console code). Unmeasured; `mcp_test.py --exe
  <AppImage> --direct` is the check. A .deb install keeps the launcher (its paths are stable).
- **The sandbox:** on Ubuntu 23.10+ AppArmor's user-namespace limit can keep an AppImage's Electron from starting
  (the README says so). No `--no-sandbox` is added by the app.
- **Keys:** `safeStorage` on a desktop without a keyring falls back to `basic_text`; *Settings › API providers*
  warns then (`keysNote` in `renderer/shell.js`, gate `platform`). Whether `isEncryptionAvailable()` answers true
  or false in that case decides which of the two warnings the user sees; both are covered, neither observed.
- **Helpers:** CPU only (no CUDA provider in the build, `docs/HELPERS.md`); the first session logs a failed `cuda`
  attempt before it falls back.
- **The single-instance lock and the named pipe** become a unix socket (`local.js`); never exercised.

### What phase N1 found on the way

**Written** 2026-09-17 with the measurement of phase N (`docs/PERFORMANCE.md` §14, `tools/native_test.py`,
`tools/native_limits.py`). Seen while measuring, not reports; none is fixed.

- **The whole-picture wand on a document above the canvas limit works for 4.6 s and then refuses** ("larger than any
  canvas", 30000 × 20000, `native_test.py 30000x20000 wand_whole_picture`). Why it gets
  that far before it refuses is not read yet. Either it says so at once, or it floods over tiles.
- (The renderer's 15.5 GB of typed arrays: fixed for 0.1.32, "Fixed, waiting for its release" above.)
- (The provider crop's block and the opening of a large JPEG, WebP or profiled PNG are fixed: "Fixed, waiting for its
  release" above.)

### What phase E left open on large documents

**Written** 2026-09-17 with phase E (`docs/PLAN_BCE.md` §3, the "as built" blocks). Not reports: gates of the plan that were
measured and not met, and what still needs a canvas of the picture. Each has a number to beat.

- **(Since B item 7, 2026-09-18, only for a document with a colour-matched layer above a filter layer, a scaled or
  fractional layer, or a filter mask that is not tiles: a plain stack, blend modes, filter layers and colour-matched
  layers (part 3, the statistics from point samples of the tiles) are composited by the workers, the
  filters run over their bytes, and the case below saves in 1.4 s with a block of 0.17 s, with the film look 5.0 s
  against 9.1 s; `docs/PLAN_BCE.md` §3b "B item 7, part 2 as built". The block is still above the plan's 50 ms.)**
  An export in bands is slower in wall
  time than the whole flatten was, while the window stays usable. 15000 × 10000,
  three full paint layers and a levels layer: 6.2 s in bands (longest block 0.7 s, the first band) against 3.4 s through
  one canvas (2.4 s blocked in one piece). With the film look on top 9.5 s against 8.2 s. The time is the region pass at
  full resolution: about 130 ms a band, most of it `putImageData` of every layer's tiles into a region canvas
  (`tools/export_test.py --perf 15000x10000`). The plan's gate was 3 s and 50 ms. The way down is the one the plan had:
  composite plain stacks in the pool's workers from the arena (`composite_tile`), and keep the region pass for bands
  with a filter, a colour match or a blend mode.
- **The film look's halation on a document above the canvas limit is very slow to export**: 67 s for 20000 × 14000 with
  blocks of 7.6 s a band, 146 s with blocks of 16 s at 30000 × 20000. Its blur is 1.2 % of the long side (240 px there), so a band carries 725 rows of margin on
  either side and the pass is 60 MP, above what the WebGL filters render in one piece.
- **Inverting the selection of a very large document blocks the window**: 0.5 s, and 1.2 s back, at 30000 × 20000, and
  the inverted mask is 2.4 GB of tiles (masks are RGBA tiles; one-channel masks were C5's plan and are not built).
- **The mip refresh after a whole change still blocks 45 to 90 ms** at 15k (the gate was 5 ms): the frame the landings
  cause builds the atlas slots on the main thread (`docs/PLAN_BCE.md` §3 "E1 as built").
- **Above 268 MP only the full-size PNG, PSD and ORA are written.** JPEG, WebP, the Size row and the frame need one canvas
  and are refused with a message; so are the canvas-sized edits (resize, extend, crop to selection, merge into the base
  through a canvas) wherever they still build a canvas of the picture. A PSD stops at 30,000 px a side and 4 GB a section
  (a 30000 × 20000 document with one paint layer was 3.7 GB), an ORA at 4 GB (no zip64).
- **A colour-matched layer above a filter layer keeps the whole flatten for exports up to 268 MP**, and so does a
  provider run's crop (`readBox`) and the flatten into the base of a plain matched stack. Since B item 7 part 3
  (2026-09-18, decision (b) of C6 (c) 7c made) every other matched document takes the worker path, its statistics
  point samples of the tiles. Above 268 MP the bands use the statistics the screen uses, the only ones there are.
  So do the JPEG and WebP exports (`host.exportCanvas`). The screen keeps 7c's box means: on a textured matched
  layer a PNG differs from a JPEG of the same document, and the wand's edge from what the screen shows, by the few
  levels the two statistics are apart (`docs/PLAN_BCE.md` §3b "B item 7, part 3 as built", the photo table).
- **Seen once, not reproduced**: `editor_test.py` `a_settled_read_builds_its_levels_in_the_worker_not_here` failed with
  `requested: 0` in one of some twenty runs since the mip chains go through the pool.

### A local run on a large document spends minutes in the node's stitch

**Found** 2026-09-19 by the first `smoke` against a real server since phase E: a local Flux.2 Klein run on a 6000 x
4000 document (a soft paint layer, a matched result layer, a levels layer; a 1000 x 800 selection) took 19 min 27 s,
of which 15 min were the node's stitch after the VAE decode, one CPU core busy, the GPU idle. The app's side was
right: the base went up in bands through the filter program (`n2_base_4682dc8486bc.png`, the hash of the composite
recomputed afterwards, the same 27,198,764 bytes) and the result landed at the crop box.

**Why:** ComfyUI-InpaintCanvas `nodes.py` builds the stitch's masks over the **whole picture** (`_composite_mask` on
the full-size selection) and dilates with a square `max_pool2d` of k = 2 x grow + 1 (137 for a 1000 x 800 selection),
k squared comparisons a pixel on the CPU: 35 s a megapixel at k = 137 (the ComfyUI's torch, one thread), so about 14
min at 24 MP and 90 min at 15000 x 10000. The run's own crop (`_denoise_mask` on the crop) costs about a minute the same
way (the 55 s between "got prompt" and the model load).

**The fix is committed and pushed in the node repo, not live yet** (`fba1fd8` on master of ComfyUI-InpaintCanvas, on
the user's word of 2026-09-19; the node folder is the user's live ComfyUI and its Python only loads after a restart): `_dilate_mask` as two separable `max_pool2d` passes (the same values: a square max is the max of the row
maxima), and the stitch's masks on a window around the region with the margin the app's `finishResult` uses. The
patch and its tests are in the session's scratchpad (`node_fix_patch.py`, `node_mask_test.py`,
`node_stitch_e2e.py`): the node's own `InpaintCanvasStitch.stitch`, today's `nodes.py` against the patched copy with
ComfyUI stubbed out, gives the same returned image and the same patch PNG, byte for byte, with auto feather, colour
match and alignment (71.5 s to 1.96 s at 2500 x 1800), with `paste` "crop" (43.1 to 0.61 s) and a plain feather; the
masks alone at 6000 x 4000 889.5 s to 4.4 s, equal on eight cases; run again against the committed file, the same.
**Next:** a ComfyUI restart when it suits the user, then one local run on a large document; the entry leaves this file
when that run is fast (a node release with a `pyproject.toml` version takes it to the registry).

### Selection undo and bounds lose isolated pixels above 1 MP (canvas backend)

**Found** 2026-09-14 by C2's final review (`docs/PLAN_BCE.md` §C2), present since phase A (0.1.10):
on the canvas backend, which is what the packaged app ran until 0.1.13 and still runs with Settings ›
Rendering › Tile engine switched off, a selection above 1 MP takes its extent
from the selection's 1/16 display level (`selectionExtent()` in `inpaint_canvas.js`). Four smoothed
halvings round an isolated pixel away (below about alpha 128 always, and at sizes that do not halve
evenly even alpha 255), so the selection's undo step does not copy it and its bounds scan does not
look for it. Measured: 2401 × 1601, a 400 × 300 rectangle plus 24 isolated pixels of alpha 120 or
255: the extent [270, 270, 2307, 1523] misses the opaque one at (1447, 1525), `getBounds()` comes back
as [300, 300, 2280, 1491] against the exact [300, 300, 2280, 1526] (a run's crop and the ants box leave
selected pixels out), and a `select_rect` elsewhere followed by an undo restores the selection without
that pixel. 3000 × 2000 loses two alpha-120
pixels the same way; 2048 × 1536 nothing. A wand's or a matte's speckle is where it shows.

**Not fixed, on purpose**: an extent that cannot drop a pixel needs a full-resolution readback of the
selection on this backend (seconds at 15k, the cost phase A took out), or a max-pooling level the 2D
canvas cannot build. The selection drag, which lost the same pixels, takes the whole image instead
since C2 (b)'s review. On tiles the extent is the tile set's exact bounds and nothing is lost; C5 makes
the selection mask tiles and C7 retires the canvas backend, which closes this.

### A very large PNG stays jerky to work on

**Reported** 2026-09-11 by DenRakEiw, on a PNG about 15,000 px on its long side. Panning
and painting stutter badly.

**The file format is ruled out.** The user saved the same picture as JPEG and it is not
smoother (2026-09-11), which is what the pipeline predicts: after decoding, base and layers
are RGBA canvases and the format cannot matter. So the heading is misleading and the bug is
about the *size*. It is the untiled full-resolution layers that are the suspect.

**Update 2026-09-15, for 0.1.13: the tile engine is on by default.** Most of what follows describes
the state before it (untiled layers, "layer tiles were deliberately not built"); it stays as the
record. Layers, masks and the selection are tiles now (`docs/PLAN_BCE.md` C2 to C6), and 0.1.13 runs
them in the installed app unless *Settings › Rendering › Tile engine* is unticked (or `--no-tiles`).
Measured on a 15000 × 10000 document with three full-size paint layers, a colour-matched result, a
film look and a levels layer (`mem_test.py`, one document open; `PLAN_BCE.md` §C7 "The default, as
built"): about 4.5 GB in the renderer and 1.6-2.3 GB in the GPU process on tiles, against 0.7 GB and
7.2-7.8 GB with the tile engine off. The entry stays open until the user reports on their own 15k
file. What to ask for: the file's size and layer count, whether panning and painting still stutter
with the tile engine on, the same with it off (after *Restart now*), and the card's and the GPU
process's numbers from Settings › Rendering while it stutters. What is known to be still slow on
tiles is the "Still slow" list under 0.1.13 in `CHANGELOG.md` (smudge, the whole-picture wand,
invert, the whole flatten behind renders and exports); with two 15k documents open at once a levels
tick took 49-58 ms on tiles and with three the pan took 65 ms, not broken down yet.

**Update 2026-09-16, after C4, C6 (c) 7b to 7d and C6 (d) (0.1.16, unreleased).** The numbers on the synthetic 15k
document are in `docs/PERFORMANCE.md` §11: pan 2.6 ms (0.2 ms on the GPU stack), a brush dab and its frame 1.2 ms, undo of a
stroke 26 ms, the first frame at 1:1 1.2 ms; a colour-matched full-size layer no longer makes 1.1 GB of copies, and a crop,
flatten or undo of them no longer decodes the picture again. Still whole-picture and slow: invert (0.9 s), the band wand
(1.8 s), a film point under a film look (2.2 s), renders and exports. The entry stays open until the user reports on
their own 15k file (what to ask for: the 2026-09-15 update above).

**What is already known**

- The GPU compositor still applies at that size: it refuses only above `MAX_TEXTURE_SIZE`,
  which is 16,384 on this machine (`inpaint_compositor.js`, the `w > this.maxTexture` guard),
  and 15,000 is under it. So this is not the documented fall-back to Canvas 2D.
- **Layer tiles were deliberately not built** (`docs/PERFORMANCE.md` §"what is left"). Every
  source canvas is one texture and one full-resolution pyramid level, so a 15,000 × 10,000
  document holds about 600 MB per layer in the GPU process before anything is drawn. The
  memory watch (`settings.memory.gpuLimitMB`, default 3072) then releases caches on a timer,
  which is itself visible as a stutter.
- Phase 6 measured that four 96 MP documents open at once really are 19 GB of live pixels
  and about 40 ms a frame. 150 MP in one document is the same territory.
- **Every discrete step snapshots the whole document.** `clearSelection()`, and every
  selection change, calls `pushUndo({ kind: "selection" })`, which copies the selection
  canvas: 150 million pixels per step. Phase 1 made *brush* undo a copy of the touched
  rectangle only, but the selection steps were not part of that. On a document this size
  that alone can be the stutter.
- **Releasing an erase stroke is its own stutter** (fixed on tiles 2026-09-19: "Fixed, waiting for its release"
  above; the text below is the record) (reported separately in the same session:
  the stroke itself follows, the hitch comes on mouse up). The `layerpaint` pointer-up runs
  `strokeRect`, `commitStroke` and `markLayerChanged(layer, box)`, which refreshes the display
  pyramid over the touched rectangle and re-uploads the layer's texture. With a big eraser
  over a big area that rectangle is most of the document, so the "only the touched rectangle"
  saving from phase 1 buys nothing here.

**Measured 2026-09-12** (dev instance on its own profile, the app freshly started, synthetic
15,000 × 10,000 document: base, three full-size paint layers, one 2048² result layer, a film
look; `tools/perf_test.py 15000x10000` plus a script that drove the real pointer handlers on
the screen canvas). The drawing itself is **not** slower than the screen: pan, an eraser
stroke with a 400 px tip and its release each take one 120 Hz frame (8.3 ms median, both at
fit zoom and at 1:1), slider ticks 8 ms, the release of an erase over 12,400 × 6,400 px
13 ms commit plus 1.5 ms pyramid refresh, the autosave upload of three changed layers holds
the main thread 19 ms at most (2 s wall, in the worker). What does stutter:

| Step, 150 MP | main thread held |
|---|---|
| first frame after a zoom to 1:1 (full-resolution textures) | 58 ms, once 320 ms in a real pan |
| selection change (`pushUndo` copies the selection canvas) | 62 ms |
| undo step | 99 ms |
| selection bounds scan | 83 ms, worst 754 ms |
| grow +16 / shrink / invert / feather | 321 / 180 / 70 / 135 ms |
| magic wand / bucket | 2076 / 1646 ms |
| PNG of the composite (undo of a whole layer, autosave, export) | 274 ms even with the worker |
| full composite (before a run or export) | 9 ms warm, 990 ms cold |

And the memory, which is the finding that matters: **one 15k document with three full layers
holds 4.3 GB in the GPU process** (`ed.memoryReport()`: layers 1.8 GB, display pyramids
1.0 GB, base canvas 0.6 GB, selection canvas 0.6 GB, compositor textures 0.2 GB at fit zoom
and 1.26 GB after a zoom to 1:1). The GPU process went from 8.1 GB (after the benchmark's own
15k document had been closed) to 14.9 GB with the document built and 17.4 GB after the
gestures. Every one of those canvases is a GPU texture in Chromium's GPU process, and it
competes for the card's 32 GB with ComfyUI (20 to 29 GB right after a local render, measured
on 2026-09-08), Photoshop (9.5 GB dedicated while it had a document open, WDDM counters
`\GPU Process Memory(*)\Dedicated Usage`) and Krita. When the card is over-committed Windows
pages GPU memory to system RAM and every frame that touches an evicted texture stalls: that
is a stutter no benchmark on an otherwise idle card shows, and it is the first thing to
verify on the user's machine (Task Manager › GPU › dedicated memory while it stutters, and
whether it is smooth right after a restart of ComfyUI). The user's real 15k file could not
be measured: it was not open (their autosave held a 2 MP document, their GPU process 774 MB).

**What to measure first** (before touching anything)

1. ~~The exact dimensions of both files, `ed.memoryReport()` and `app:metrics`~~ done above on
   a synthetic document of the reported size; the user's own file is still to be read the
   same way (Help › Console, `window.editor.memoryReport()`, `window.scumble.metrics()`).
2. ~~`perf_test.py 15000x10000` against 12000x8000~~ done: within a frame of the 96 MP numbers
   for every interactive row; the discrete rows are in the table above.
3. **Dedicated GPU memory of the whole card while it stutters** (Task Manager › Performance ›
   GPU, or the WDDM counters), and the same document right after ComfyUI has been restarted.
   If the stutter goes with the free VRAM, the fix is memory, not drawing.
4. A CDP heap snapshot if the memory climbs across gestures rather than sitting flat. The
   canvas census says *what* survived, only the retaining path says *why*.
5. Whether the stutter is periodic. `watchMemory` runs every 30 s but only touches background
   tabs; the autosave runs 15 s after the last change and was measured at 19 ms blocked.

**Phase A of `docs/PLAN_TILES.md` is built (2026-09-13)** and takes the discrete hitches out
of the table above: selection change 6 ms, bounds 6 ms warm, stroke undo 42 ms (the film
look's re-render; about 10 without a filter layer), grow / shrink / invert 112 / 131 / 54 ms,
the bucket and the wand on a bounded region a fraction of before, a stroke's buffers 19 MB
instead of 1.8 GB and the live preview refreshed inside the dab, the compositor's textures a
window of each source. `docs/PERFORMANCE.md` §9 has the table. What it does **not** change
is the memory per document (2.3 GB of layers, 0.95 GB of pyramids, 0.57 GB base, 0.57 GB
selection canvas in the GPU process for this document), and the ops that read the whole
selection keep their phase 4 cost. Whether the stutter the user sees is that memory is still
the open question 3 above; the memory watch now reads the card as a whole (Settings ›
Rendering shows it), which is the number to look at while it stutters.

**Likely fix, if the measurement confirms the memory reading**: layer tiles above a
threshold, which is the one piece of the performance plan that was left out on purpose, and
with them the pixels of layers that are not on screen kept out of the GPU process (in the
renderer as typed arrays, or in the mirror) instead of as one accelerated canvas each. That is
what Krita and Photoshop do (`docs/PERFORMANCE.md` §3: tiles in system RAM, a mipmapped
projection of the *merged* picture, the GPU holds only the visible tiles) and it is why they
do not fight ComfyUI for VRAM. A tiled layer also makes the whole-document steps in the table
(selection undo, bounds scan, wand, bucket) per-tile work. It is a large piece of work and
belongs to the user's decision, not to a quick patch. The plan for it is
`docs/PLAN_TILES.md` (written 2026-09-12): quick wins first, a Rust spike, then the tile engine.
