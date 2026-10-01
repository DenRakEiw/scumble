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
  `python tools/mcp_attach_test.py` (run by the `mcp` gate after it) checks `--attach-only`, the switch of the repo's
  `.mcp.json`, on a profile of its own: `ping` alone and nothing started while no Scumble runs, the attach to an
  instance it starts (port 9573) with `tools/list_changed`, nothing started after that instance closes.
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
screen before stays so; it takes the test window full screen and back), `tools/clip_test.py` (gate `clip`, layers
clipped to the layer below, PLAN_0_1_31 §6 step 3: analytic on the flatten and the workers' export (coverage 0 = the
clipped layers hidden, 255 = their clip off), every path against the flatten, the GPU view against Canvas 2D at 1:1,
at a base of 60 %, over an emptied base and with the base off the view, a hidden base, a filter base, undo, getValue,
PSD both ways, the merges; run it on both backends), `tools/groups_test.py` (gate `groups`, groups as folders,
PLAN_0_1_31 §6 step 5: a hidden group against its layers hidden one by one on every path, byte for byte, the GPU view
against Canvas 2D, lock, solo, the clip's group edge, the steps and drops through the tree, undo, the panel's tree,
getValue / setValue with a damaged state repaired, PSD both writers, opened and dropped, ORA, the commands; both
backends: the PNG export and the stack box are the tiles' only). Every gate name `X` without a rule of its own
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
pictures by their place, with the Original too; a hidden reference's token and a literal `{@ref:` each refuse at once
with nothing sent; its step 5, a stubbed ComfyUI recipe, is 26e's since then, below), `refs_names` (an upscale writes
the cleaned layer name, the Upscale dialog's prefill too; since 26f the Generate new dialog's prefill keeps the
tokens) and `refs_agents` (labels in `list_layers` / `status`,
`status.references[].sent_as` with and without the Original, `set_prompt refs`); `tools/assistant_test.js` checks the state note's `ref @img1`. 26a2
adds `refs_layout_test.js` sections 8 (`refs.instruction`, `labelParts` and `checkPictures` against literals: 0 to 4
references, a mask picture or field, the Original, `Image {n}` and `<image{n}>`, style layouts, the exact drop notes
and cap messages, a cap that is no number above 0) and 9 (`index.js` with the loopback's `options.drops` and
`options.max_images`: the stripped request, `notes` in the answer and the log record, refusals before the adapter,
`layout(shape)`'s `names` and `over`), and its caps section moves to 26a2's caps (every reference or a refusal, no
partial drop); the adapter tests (`ark`, `openrouter`, `oxen`, `comfyrouter`, `magnific`, `toapis`, plain Node and
gates) take the new sentences. The `commands` steps `refs_declared_drop` (a loopback recipe with `options.drops` and
two visible references: the loopback gets none, the status says "not sent", `generate` returns one note) and
`refs_over_cap` (`options.max_images: 2`: refused with "at most 2 pictures; this run has 3", no loopback call) run
the path through the app. 26d1 adds `generate`'s `upsample_references` (a stub language model in `host.askLLM`
answering from a queue, two paint references: no token gives the instruction of before, the edit and fill cases name
only the reference the prompt names and carry the token rule, a hidden reference's token refuses with no call, an
answer that drops, adds and numbers gives the status note and `check`, and a swap of the references while the model
answers carries the answer and Revert's text to the new labels), `prompt_templates`' `{references}` checks, and
`reftokens_test.js` section 11 (`referenceName`, `referencesText`, `referencesRule`, `checkNote`). 26d2 adds
`node tools/llm_images_test.js` (plain Node, `llm.js` with `./keys` and `./settings` stubbed and a scripted fetch: each
builder's part sequence with the reference pictures, the bodies without them byte for byte, the cap of six, the
switch, `vision: false`, the compatible client's steps all -> crop -> text with their notes, which failures step down
and which do not, labels on one line), run by `llm_test.py`'s `node_test()` too; `llm_test.py` step 5c (two paint
references against `tools/llm_mock.py`: `mock-vision` gets 3 pictures in label order, the Settings switch off gives
1 and the instruction still names both, the new `mock-one` gets 3 then 1 with "crop only"); and in `generate`'s
`upsample_references` the stub's two pictures (labels, 512 px) and none with `host.llmRefPictures` off. Every
gate that touches references ends with `ed._refDrift` 0: a change of the shown references that no site remapped is
counted in `renderReferences`.

26c1, the prompt field (`renderer/editor/prompt_field.js`): `node tools/prompt_field_test.js` covers its pure helpers
in plain Node (`sanitize`, `atWordStart`, `unitBefore` / `unitAfter` over chips, emoji and surrogates, with and without
`Intl.Segmenter`, `EditHistory`'s merging, word steps, `map` and cap, `chipState`, `renderPlan` with an open token);
the import itself proves nothing touches the DOM at load. The editor gate's five `prompt_field_*` steps
(`tools/prompt_field_steps.py`, each on a document of its own with two references) drive the field with real CDP input:
`is_the_textarea_for_every_reader` (value, selection kept while blurred and put back by `focus()`, placeholder,
disabled, the hidden "@" of zero width with `innerText` reading the token, live / inactive / broken chips),
`types_deletes_and_moves_over_chips` (Backspace and Delete take a chip whole, the arrows step over it, Enter, a typed
token turns into a chip at the space, the automatic space against a chip and the typed space stepping over it, a caret
on both sides of a chip between two others, `ed.undo` untouched), `undo_redo_paste_and_copy` (word steps with the
caret, Ctrl+Y and Ctrl+Shift+Z, a paste with CR LF and U+200B, a copy over a chip, an undo after a remap gives the
remapped older text, `"reset"`), `leaves_a_composition_alone` (`Input.imeSetComposition`: the chip nodes are not drawn
anew, an Enter while composing adds no line, a remap during a composition lands on the composed text) and
`keeps_the_editor_keys` (Ctrl+Enter and Ctrl+U reach `generate` / `upsamplePrompt`, Escape hands the focus to the
editor, Backspace / Delete / Ctrl+Z / the AltGr probe run no editor shortcut, a click on a chip's chevron keeps the
focus). While iterating: `SCUMBLE_EDITOR_ONLY=prompt_field_is_the_textarea_for_every_reader,... bash tools/run_gates.sh
26c-it --offline --tiles on editor`.

26c2, the @ picker, the reference bar, the hover card, the swap menu and the chip drag: `node tools/prompt_field_test.js`
section 8 covers `pickerRows`, `barCount`, `cardLine`, the `over` and `none` chip states and `imageFiles`. The editor
gate's steps in `tools/ref_picker_steps.py` (the same document and helpers as the 26c1 steps): `ref_picker_opens_on_at_and_inserts`
(an @ at a word start opens one picker and after "mail" none, the query filters, the first Escape closes it and keeps
text and focus, the second leaves the field, the arrows wrap, Enter and Tab insert as one field-undo step, the AltGr
probe opens it once, a hidden reference is left out with a note, `ed.undo` untouched), `ref_picker_adds_a_reference_in_place`
(`addReferences` in a session puts the token where the @ was, without one at the kept caret; a pasted and a dropped
picture become references named where they came in; pasted text stays text; `_refDrift` 0),
`ref_bar_hover_and_swap` (with the host's `refLayout` stubbed and put back: cap 1 gives an over chip and "2 of 1 for
this recipe", none strikes every chip; a bar click inserts at the kept caret; the hover card is absent at 250 ms and
there within 1.5 s with "sent as image 2", gone after the pointer leaves; the chevron's menu swaps a token as one undo
step, "Show jacket" brings a hidden reference and its token back, "Remove from prompt" takes the token and a space),
`ref_picker_keeps_what_stood_there` (the review's findings: an @ typed before a word or a chip is replaced alone, Enter
with nothing listed is a new line, a chip or word moved in front of a chip keeps a space, a swap menu under a remap
removes its own chip, an edit of an unfocused field reports one change) and
`prompt_field_drags_a_chip` (a press without a move only places the caret, a press moved to the end of the text moves
the chip there with a drop caret on the way, one undo puts it back). `prompt_field_keeps_the_editor_keys` now expects
the chevron click to open the swap menu and the first Escape to close it. While iterating:
`SCUMBLE_EDITOR_ONLY=ref_picker_opens_on_at_and_inserts,ref_picker_adds_a_reference_in_place,ref_bar_hover_and_swap,prompt_field_drags_a_chip
bash tools/run_gates.sh 26c-it --offline --tiles on editor`. The hover and drag steps call `Page.bringToFront` first:
synthetic pointer events are unreliable while a real mouse is over the window (see the flakes below).

FLUX 3 Image (`electron/main/providers/flux3.js`, `recipes/flux3.json`, `docs/PLAN_FLUX3.md`): `node tools/flux3_test.js`
(plain Node, a scripted api.bfl.ai, 96 checks) pins the recipe as `recipes.js` serves it, the body against the released
schema (only prompt, images, aspect_ratio, resolution, safety_tolerance, grounding; every body sent is checked at the
end), the aspect preset within 3 % or auto, the tiers by area, the 256 px / 16 MP / 20 MB rules (the crop refused, a
reference scaled through `ctx.resizePng`, the JPEG fallback), the parameter coercion (safety 0 to 4, grounding from an
agent's words), the poll (Reasoning, 503 / 422 status bodies, dropped connections and gateway pages retried, the
download tried three times, the regional polling_url allowlist), the answer's info (cost, megapixels, expanded prompt,
no seed) and that FLUX.2 through the same adapter is unchanged. Light tier: written from the docs; a live call is the
user's (`docs/PLAN_FLUX3.md`).

26e, @img tokens on local ComfyUI recipes (`renderer/editor/comfyrefs.js`, `docs/RECIPES.md` "Reference images named
in the prompt (local)"): `node tools/comfyrefs_test.js` (plain Node, run by `recipes_test.py`'s node step after
`recipes_test.js`) covers the shipped specs (Qwen 2.1 `<image{n}>` with 10 slots, Klein `image {n}` with 4, both
identity traces), the layout matrix (selection × fill × Original × refine × 0 / 1 / 3 / 12 references: each picture's
number, `kept`, the drops), the trim (only the inputs past the batch, never the crop's, Klein's conditioning chain
intact), the marker vectors of `tools/refs_cases.json` against both resolvers (`comfyrefs.js` and
`providers/refs.js`), and imported graphs through `recipes.fromPrompt` (Edit Plus, Qwen 2.1, a `ReferenceLatent`
chain, the whole batch into one node, an input on another batch index: the wording, the slots, a guess and no trim
where the trace is no identity; `normalize` dropping a bad `refs`). The `recipes` gate's step
`local_recipes_name_the_batch_pictures_and_trim_the_unused_slots` stubs `host.connected`, `objectInfo`,
`ensureOnServer` and `api.queuePrompt` (nothing is queued on a server; all four are put back) and runs both shipped
recipes through `host.queueGenerate`: no reference (the prompt unchanged, no `named_refs`, only the crop's input
left), a reference with the Original, the same on a refine pass, three references with a negative, Klein past its
slots (a named reference refused with nothing queued, an unnamed one left out with "not sent"), a hidden reference,
the Info panel's References row and the prompt field's context. `commands`' `refs_send` step 5 now checks a ComfyUI
recipe whose graph cannot be traced (the tokens named by batch position, "wording guessed from the graph" in the
status, `named_refs` and `hasSelection` in the state, the document's prompt unchanged) and a refusal past declared
`slots`; `prompt_field_test.js` section 8 adds the bar's count and the card's name for a traced local recipe. The
run: `node tools/comfyrefs_test.js`, then `bash tools/run_gates.sh <label> --offline --tiles on recipes upscale
nodecopy lint types` (`upscale` for the ComfyUI upscale path through `queueGenerate`, `nodecopy` for the shared
`serializeForPrompt` and Info panel edits). No `smoke`: it runs `flux2_klein_local` on the user's ComfyUI.

26f, Generate new with reference layers (`docs/RECIPES.md` "Generating without an image"): nothing of it has run
against a live API. Plain Node: `node tools/refs_layout_test.js` sections 6 to 9 are rewritten for text runs that send
references (every adapter exports `textLayout` beside `generate`, a text run with two references sends them and no
crop, the text markers resolve from 1, `checkPictures` refuses past the cap in the words for a new image), and its new
section 12 sends every shipped variant with `text.refs` through a fake fetch (the route, the picture order against
`textLayout`, no "Edit" sentence, the asked size or aspect, the reference sentence where the adapter writes one, 0
references byte for byte, one past the cap refused with no fetch); `node tools/recipes_test.js` gets a section
"text.refs" (every shipped variant against the expected route and cap, the list of those that take none, `true`,
`false` and a bad value); `node tools/reftokens_test.js` covers the text-run markers (`@img2` with 3 shown references
becomes `{@ref:1}`, a hidden or parked token refused). The adapter tests take new text-run cases, each with 0
references pinned to the old body: `toapis_test.js` section 2c (`textLayout`, the uploads and `image_urls` in order,
the size and tier, the per-channel caps, the ratio and 10 MB rules on references) and section 7 (a text run with two
references on every variant and channel, the text cap equal to the edit cap); `openrouter_test.js` section 3 (two
references in `input_references` with their sentence, one reference, `refName`, the cap, ratio and size refusals) and
section 10's sweep; `ark_test.js` sections 1, 4 and 6 (the same for `image`, eleven references on 5.0 pro refused and
ten sent, and `index.edit` with markers and `refsMax`); `comfyrouter_test.js` section 12 (every dialect, the drops of
xai / ideogram / krea and FLUX.1 Fill, Gemini's closest ratio for a free size, `text.refs` on exactly the variants
that take references) and text-run cases in sections 8 (`index.js`) and 10 (HY Image through the Partner API);
`magnific_test.js` section 4b (the FLUX.2 routes and the `-edit` routes, never `auto` for GPT Image, Seedream's 256 px
floor) and checks in sections 11 and 12; `oxen_test.js` section 8b (`/images/edit`, the fields, the Grok edit id
without an aspect, the name pattern, the count and size refusals) and section 9 (`index.layout` for the dialog), with
the schema sweep sending reference runs where `text.refs` is set.
Run: `bash tools/run_gates.sh <label> --offline --tiles on toapis openrouter ark comfyrouter oxen magnific recipes`.

The app: `tools/generate_test.py` gets eight steps, all against the loopback. `refs_in_an_empty_tab`
(`add_image_layer role:"reference"` in a new tab gives a white 1024 × 1024 base with one reference, `refContext`'s
`canAdd`, `role:"none"` still refused with "no image loaded"); `text_with_references` (two references and a paint
layer, `generate_new` at 16:9: `info.references` 2, `prompt_sent` "the jacket of image 2 on the person of image 1",
`references` with `sentAs`, `kept` 2 and `dropped` 1, the paint layer gone, the references' ids, order, pixel objects
and a sample unchanged and inside 1024 × 576, the tab's prompt unchanged, the status line's "@img2 → image 2" and
"The reference layers stay, 1 other layer was replaced", `_refDrift` 0); `hidden_reference_not_sent`
(`info.references` 1, the hidden reference kept hidden); `refuses` (`text.refs.max: 1` with two references gives
"takes at most 1 reference picture for a new image; this run has 2: hide reference layers", a token on a text shape
without `refs` gives "makes new images from the prompt alone", neither changes the tab; without a token that shape
runs, sends none and keeps both); `local_keeps_refs` (`newCanvas("512x512", {keepRefs: true})` keeps and places the
references; the live ComfyUI run is left out, 8188 is a production machine); `dialog_field_and_bar` (a fake recipe in
the dialog's list: `#gen-prompt` is the prompt field and keeps the tokens, two chips, `sentAs` "image 1" / "image 2",
two bar chips, a text shape without `refs` shows "sends no reference images"); `dialog_escape_closes_the_picker_first`,
a Python step with real keys (`run_all` now takes callable steps beside JS strings): a typed @ opens the picker, the
first Escape closes only the picker, the second the dialog; and `dialog_upsample_refs` (`host.upsampleBackends` and
`host.askLLM` stubbed, the pictures switched off: the instruction names both references and carries the token rule,
an answer that drops `@img2` gives "dropped @img2" in the note, Revert puts the old text back). `commands`'
`refs_names` now expects the Generate new prefill to keep the tokens. The run: `bash tools/run_gates.sh <label>
--offline --tiles on generate commands lint types nodecopy`, then `generate` again with `--tiles off` (the reference
layers now live across a base swap).

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
- The 0.1.34 exe gates on tiles (2026-09-29, one full run of 31 gates) failed two steps once, and both passed at once
  when `export film` ran again on a fresh instance: `export_test.py` `a_run_reads_its_box_and_a_window_of_the_selection`
  ("the run's patch differs between the window and the whole selection", one byte, one level; `stitch.js`'s
  `finishResult` was not touched since 0.1.33, only the reference reads) and `film_test` `panel_thumbnails` ("0 of 5
  rendered" 4 s into the gate; `plugins/` unchanged since 0.1.33). Neither had failed in an earlier recorded run; not
  looked into further.
