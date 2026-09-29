# Testing: the tools and the known flakes

Moved out of `CLAUDE.md` on 2026-09-27, verbatim, so the file every session reads stays short. The rules (which tier a
change gets, `--offline`, both backends, the exe gates once per release) stay in `CLAUDE.md` "Working rules" and "Gate
runner"; this file is the reference behind them.

## What each test tool covers

Test with real runs: start `./node_modules/.bin/electron . --remote-debugging-port=9555`
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
  to stay visible on white, and copy / paste of a layer between tabs; since 0.1.31 also the Undo history (rows, jumps, snapshots, depth, the history commands).
  Its retouch steps check the kernel's bytes: `heal_blends_the_source_into_the_picture_at_the_release`,
  `remove_fills_the_hole_from_the_model_at_the_release` (a stand-in for LaMa) and
  `patch_blends_the_donor_into_the_selection_at_the_release` (the Patch tool: the landed RGB against `poissonBlend` of
  the selection's mask, Source, Destination, Blend, the worker, the clamp at the picture's edge, a feather, the
  refusals, no flatten while it drags) and `content_aware_move_fills_the_hole_and_blends_the_seam` (the LaMa stand-in:
  the model's input, the fill, the seam band against `distTransform` and `poissonBlend`, the core exact, an overlapping
  move reading the fill, Blend all, Extend, the worker, the held gesture, a failure, the refusals).
  Liquify has `liquify_bakes_each_stroke_from_the_session_source` (both backends: every landing equals the bake of the
  session's source through the whole field, pool and here, a forced small gather, Restore all exact, undo / redo with
  the field, the base's copy, the held bake and the tile guard, no flatten while it drags) and
  `liquify_brushes_move_the_picture_and_refuse` (the modes, Alt, the selection, the refusals, the keys) and
  `liquify_freeze_holds_what_it_covers` (a frozen band holds its bytes under a push, thaw, Restore all under a freeze,
  Invert, Clear, the veil, a flip and a new picture drop the freeze). `python tools/brush_perf.py '{}' liquify_perf.js`
  measures Liquify at 15000 x 10000 (docs/PERFORMANCE.md §15.1; a measurement, not a gate).
  `SCUMBLE_EDITOR_ONLY=name,name` runs just those steps. On the canvas backend `readRect` of a sub-rectangle of a
  canvas with pixels that are not opaque can differ by a level from a read of the whole canvas (measured 2026-09-28,
  286 of 108k bytes, only where alpha < 255; 0 on tiles): an expectation for such a picture is built from the reader
  the tool uses (`brushSource("all").bytes`), as the move step's case 15 does.
  `node tools/helpers_test.js` runs the ONNX modules without Electron (LaMa in its own process too); it needs the
  model files, a missing one is skipped. `node tools/remove_test.js` checks the Remove tool's crop and resampling
  (`renderer/editor/inpaint_remove.js`) without models. `node tools/liquify_test.js` holds Liquify's kernel
  (`renderer/editor/inpaint_liquify.js`) to 23b's resampler on constant fields, to a direct integer reference on random
  ones, the bounded gather's split to the unsplit bytes, and the brushes to their rules (advected, restore exact, no fold).
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

Since then: `tools/document_test.py` / `document_ux_test.py` / `document_perf.py` (gates `document`, `docux`,
`docperf:WxH`, `.scumble` documents), `tools/quit_test.py` (gate `quit`), `tools/metadata_test.py` (gate `metadata`,
what an exported picture says about itself; `node tools/secret_names_test.js` the names it leaves out of an embedded
recipe), `node tools/font_ref_test.js` (which file a text's font is loaded from), `node tools/pixel_memory_test.js`
(the tile store at the renderer's typed-array limit, the refusal stood in for), `tools/tiff_test.js` with `tools/tiff_fixtures.py` and
`tools/tiff_test.py` (gates `tiff`, `tiffperf:WxH`), `tools/canvasonly_test.py` (gate `canvasonly`, the canvas-only
view of item 24: real Tab and Escape presses over CDP; the chrome hidden, the view the window's size, full screen and a
fitted picture while on, the view / rulers / chrome / window put back after; Tab ignored in a text field, a dialog, the
editor's ask and with Shift; Escape cancels a pending transform or an open polygon first and never reaches the editor
when it leaves; a full-screen exit from outside, a tab switch and closing the tab end the view; a window that was full
screen before stays so; it takes the test window full screen and back). Every gate name `X` without a rule of its own
in `tools/run_gates.sh` runs `tools/X_test.py`.

Item 26 (`docs/PLAN_REFS.md`, @img tokens for reference layers): `node tools/refs_layout_test.js` pins every adapter's
`layout(req)` against the request its real builder sends (every shipped provider variant, every ToAPIs channel, 0 / 1 /
3 references, the Original on and off; a fake fetch captures the picture-carrying request), the caps, and
`providers/index.js`'s marker resolution, refusals and `layout(shape)` with Electron stubbed. `node
tools/reftokens_test.js` covers `renderer/editor/reftokens.js` (the grammar, remap, markers, names, the upsample check,
the caret mapping). Both read `tools/refs_cases.json`, the grammar main and the renderer share. `tools/recipes_test.js`
section 3 checks `refs.name`. Gate steps: `generate`'s `provider_markers_over_ipc` (a marker resolved and a raw token
refused over IPC, `provider:layout`); `commands`' `refs_labels` (img labels, a new reference and a copy take the next
number), `refs_remap` (hide / show, up / down, delete / undo, role changes, a merge: the prompt's tokens follow their
layers) and `refs_restore` (a `.scumble` round trip byte for byte, a reference whose file is missing parks its tokens
as `@img?<id>`, a named snapshot with Revert). 26b2 adds `refs_send` (a loopback edit run: `prompt_sent` names the
pictures by their place, with the Original too; a hidden reference's token, a literal `{@ref:` and a token on a stubbed
ComfyUI recipe each refuse at once with nothing sent), `refs_names` (an upscale writes the cleaned layer name, the
Generate new dialog's prefill too) and `refs_agents` (labels in `list_layers` / `status`, `status.references[].sent_as`
with and without the Original, `set_prompt refs`); `tools/assistant_test.js` checks the state note's `ref @img1`. 26a2
adds `refs_layout_test.js` sections 8 (`refs.instruction`, `labelParts` and `checkPictures` against literals: 0 to 4
references, a mask picture or field, the Original, `Image {n}` and `<image{n}>`, style layouts, the exact drop notes
and cap messages, a cap that is no number above 0) and 9 (`index.js` with the loopback's `options.drops` and
`options.max_images`: the stripped request, `notes` in the answer and the log record, refusals before the adapter,
`layout(shape)`'s `names` and `over`), and its caps section moves to 26a2's caps (every reference or a refusal, no
partial drop); the adapter tests (`ark`, `openrouter`, `oxen`, `comfyrouter`, `magnific`, `toapis`, plain Node and
gates) take the new sentences. The `commands` steps `refs_declared_drop` (a loopback recipe with `options.drops` and
two visible references: the loopback gets none, the status says "not sent", `generate` returns one note) and
`refs_over_cap` (`options.max_images: 2`: refused with "at most 2 pictures; this run has 3", no loopback call) run
the path through the app. Every
gate that touches references ends with `ed._refDrift` 0: a change of the shown references that no site remapped is
counted in `renderReferences`.

## Known flakes

Known flakes; **re-run before believing any of these**:
- (Fixed 2026-09-27: `editor_test.py` `pixel_backend_is_the_one_the_flag_chose` on the canvas backend, "the display
  took toCanvas() copies". Not the display: the tab the live stroke step closes flushes its 10000 x 5000 layers, and
  `rememberClosed`'s `saveAll` then encodes every open tab, this step's selection with `toCanvas()` among them, while
  the step counted every copy of the prototypes; with the heal and smudge rows of 0.1.32 it landed there every run.
  The step counts the copies its draws take now, and names their callers.)
- `commands_test.py` hangs after every step has printed `[ok]` (the runner's 420 s timeout, sometimes in
  `Page.captureScreenshot`).
- `editor_test.py` `closed_tabs_are_collected` fails with the last tabs still alive, or against an instance with 50+ tabs
  from repeated runs.
- The live stroke steps (`live_stroke_reaches_the_screen_before_the_release`, `live_stroke_preview_shows_what_the_commit_writes`)
  fail when a real mouse is over the test window (they drive synthetic pointer events), or right after a diagnostic
  instance was closed. 2026-09-28: `live_stroke_reaches_the_screen_before_the_release` failed once in a full editor run
  on the canvas backend (28 frames against 200: the window not in front) and passed alone at once.
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
