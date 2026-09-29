# Item 26: reference images named in the prompt (Magnific style)

The user, 2026-09-28 (German, paraphrased): start with the Magnific-style prompter. As in Magnific, the visible
reference images (in Scumble: the reference layers) can be named inside the prompt. The prompt template `.md` files
must be changed so that they understand the reference images too. In the prompt the images must be named with the
designation under which they are actually sent over the API.

**Status (2026-09-29):** S1 (26a1, 26b1), S2 (26b2, 26a2), S3 (26c1, 26c2) and 26d1 built, see their "Built"
paragraphs; next 26d2, then S5 = 26e + 26f. The user's answers are in section 0. This plan comes before package 6 (layers pro) of `docs/PLAN_0_1_31.md`.

How this plan was made: a code map and a web survey (seven agents), a design review (three critics), the user's
answers, then one planner per step against the code and two cross-step critics (interfaces; facts and rules). **Where a
step section below disagrees with section 4 (the contracts) or with the "Read first" block at the top of that step,
section 4 and the block win.** The step texts are the planners' own, kept verbatim so their line anchors stay usable.

How to use it in a build session: read sections 0, 3, 4, 5 and 6, then only the step being built (grep its heading).

Contents:
- 0 The user's decisions
- 1 How Magnific does it
- 2 What Scumble has today
- 3 The design in short
- 4 Contracts (binding for every step)
- 5 Schedule
- 6 Tests, docs and the CHANGELOG notes
- 7 Defaults taken for the smaller questions
- 8 Later, not in this round
- Steps: 26a1, 26b (26b1 + 26b2), 26a2, 26c (26c1 + 26c2), 26d1, 26d2, 26e, 26f

## 0. The user's decisions (2026-09-29)

| | Question | Answer |
|---|---|---|
| A | What the chip says | `@img1` in the field; the backend renames it per selected API to the name that request carries the picture as |
| B | Hidden references | **Hiding renumbers the prompt**: labels count visible reference layers only |
| C | The inline chip | **A rich field exactly like Magnific's** (contenteditable, chip with thumbnail, label, chevron), a day more and more risk accepted |
| D | Reference pictures to the language model when upsampling | **On, with a setting** |
| E | Generate new with references | **In this round** (26f) |
| F | Magnific's categories (Characters, Styles, Elements, Locations) | Optional, a later update |

Then: "mache einen umsetzungsplan detailiert" (this document).

## 1. How Magnific does it (read 2026-09-28/29)

Read in the live web app (no login, nothing uploaded) and its public JS bundle, the help center and the API docs.
magnific.com answers 403 to plain fetches, so it was read in the browser pane.

- The prompt placeholder says "Describe your image, try @ for references or / for templates". Typing `@` opens a
  picker at the caret: a search field, SUGGESTIONS (the attached references, `img1`, `img2`), then the categories
  Characters, Styles, Elements, Locations, Color palettes, Effects, Camera. Footer: "↑↓ Navigate", "⏎ Insert".
- Uploaded references are labelled automatically: type prefix plus a running number (`img1`, `img2`; `char1`,
  `obj1`, `loc1` for the other types). **The next label is the highest number of that type plus one**, so adding a
  reference never renumbers the others. No rename.
- The prompt stays **plain text with `@img1` tokens**. The inline chip (round 16 px thumbnail, label, chevron to swap
  it for another item) is only a rendering of the token, in a contenteditable. When references are renumbered, the
  prompt is rewritten in two passes through unique sentinels, so a swap img1 <-> img2 cannot collide. Token match:
  `(?<![A-Za-z0-9_-])@img1(?![A-Za-z0-9_-])`.
- A chip whose target is gone is not deleted: it shows **broken** (strikethrough, error colour) or **inactive**
  (strikethrough, 70 % opacity) with the reason as its tooltip. Hovering a chip for 400 ms shows a larger preview.
- The request sends each reference with its label (`image_references: [{id, type, label}]`, cut to the model's
  `maxReferences`). The prompt goes out with its `@img1` tokens, and **Magnific's server** turns them into the
  model's wording; how is not public.
- Limits per model: "Maximum number of references reached with this model." when full, "Model not supported" when
  the model takes none, a "Refs" tag in the model picker.
- **Smart prompt (the German UI's "KI-Prompt") switches itself off when references are used** ("Smart prompt is
  disabled when using references"). Scumble keeps its upsampler and protects the tokens instead (3.4).

Sources: magnific.com/app/ai-image-generator, magnific.com/ai/docs/your-first-ai-image, .../image-ai-models,
.../image-nodes, docs.magnific.com/api-reference (Nano Banana Pro Flash: `reference_images[].text`).

How the model families want several pictures named (vendors' docs first):

| Family | Wording the docs use | Source |
|---|---|---|
| FLUX.2 (pro, flex, max, klein) | "image 1", "image 2" by index and role ("subject from image 1, style from image 2") | docs.bfl.ai prompting guide FLUX.2, flux2_image_editing |
| OpenAI gpt-image | "Image 1: product photo ... Image 2: style reference", by index and description | OpenAI cookbook, image-gen 1.5 prompting guide |
| Gemini / Nano Banana | an index text part before each image ("image 1", "image 2"), then refer to it | cloud.google.com image-understanding; ai.google.dev image-generation |
| Seedream 4.x / 5 | "Replace the subject in Image 1 with the subject from Image 2" | BytePlus ModelArk prompt guide 1829186 |
| Qwen Image Edit API (2.0 / 3.0 / edit plus) | "Image 1", "Image 2" (array order) | alibabacloud.com model-studio qwen-image-edit-api |
| Qwen Image Edit 2509 / 2511 (TextEncodeQwenImageEditPlus) | the template writes "Picture 1: <vision> ..." | ComfyUI comfy_extras/nodes_qwen.py |
| Qwen Image 2.1 | `<image1>`, `<image2>` (the tokenizer writes them) | ComfyUI qwen_image21.py; docs.comfy.org qwen-image-2-1 |
| HY Image 3.5 | "Image N" (Scumble's `comfypartner.js` already turns `@ImageN` into it) | ComfyUI nodes_hunyuan_image.py |
| Grok Imagine | order only ("in the order they are sent"), no token | docs.x.ai multi-image-editing |
| Reve 2.1 | `<frame>0</frame>` = the first entry, 0-based; unverified on WaveSpeed's edit route | fal.ai reve/2.1/remix |

ComfyUI's own API nodes do what this plan does: one neutral token in the UI (`@Image1`), rewritten per model at send
time (`Image N`, `<IMAGE_{N-1}>`, `<<<image_N>>>`).

## 2. What Scumble has today

- **Reference layers exist.** `role === "reference"` (`inpaint_canvas.js:326`, `isReference` 3186). The reference list
  sits on the Image tab (`inpaint_modal.js:421-445`, `renderReferences` `inpaint_canvas.js:13824-13873`) with eye,
  thumbnail, name, a `ref N` badge, up / down, back to image, delete. The canvas draws a cyan frame with `ref N`
  (15764-15787). Added by the button, a drop on the list, Shift+drop on the canvas, MCP `add_image_layer role:
  reference` (`addImageLayers` 12024-12092; the name is the file stem).
- **Numbering is positional and counts only visible ones.** `referenceLayers()` (3190-3193) = visible references
  with pixels, reversed (top of the list = ref 1). Hiding (no undo step), reordering or deleting renumbers. A new
  layer is pushed to the top (`addLayer`, 13515), so **a new reference becomes ref 1** and moves all others down.
  Layer ids (`"L" + base36 + counter`, 13498-13504) survive save and restore and are the only stable key.
- **The prompt field is a plain `<textarea>`** (`inpaint_modal.js:757`, `ed.promptInput`, value in `ed.promptText`),
  on the Generate tab, not beside the reference list. No `@`, autocomplete, chip or contenteditable code exists in
  `renderer/`. `promptInput.value` is read in 8 places, `promptText` in 19. Seven programmatic writers set the value
  without an input event (`inpaint_canvas.js` 2598, 10009, 10018, 10863, 16373; `commands.js` 553, 645). The prompt
  is stored as the plain string `prompt` (getValue 16312). A turn snapshot (assistant turns, named snapshots) holds
  the prompt together with the layers (`turnSnapshot` 10480-10509, restored at 10858-10868).
- **The pictures go out in this order**, crop first on every route: the crop (`image`), then in `references` the
  **Original** copy of the crop (only when a selection, a fill mode other than none and "Original" are on,
  `stitch.js:457-463`), then the visible reference layers (`stitch.js:487, 726-733`). Some fill routes put the
  **mask as a picture** right after the crop (Gemini direct `gemini.js:27-37`, OpenRouter `openrouter.js:212-219`,
  Oxen without `mask_url`, Comfy Router vertexai). Reference layer k is picture `1 + mask + original + k`. Local
  ComfyUI: the `crop_image` batch holds the crop, then the Original (not in a refine pass), then the references
  (`nodes.py:644-687`).
- **The request carries the references as anonymous bytes** (`index.js:97-106`): no label, no layer id, and **no
  flag saying whether `references[0]` is the Original** (`withOriginal` never reaches `electron/main`). The prompt
  goes out raw (`host.js:1052`); six adapters prepend their own sentence ("Edit the first image ... The remaining
  images are reference material": gemini, openrouter / oxen, ark, comfyrouter, magnific, comfypartner). ToAPIs
  channels change the maximum and the mask per request (`toapis.js:126-137`).
- **One `@` syntax exists already:** `comfypartner.js:34-46` (HY Image) turns `@ImageN` into `Image N`, crop =
  Image 1, and refuses a number past the pictures sent (test `tools/comfyrouter_test.js:609-630`). `@img\d+` does not
  match `@image2`, and HY's pattern does not match `@img2`.
- **Templates** (`prompts/*.md`, `docs/PROMPTS.md`): placeholders `{prompt} {model} {aspect} {width} {height}
  {useCase} {region} {hint}`; `host.fillPromptTemplate` (`host.js:1337-1347`) leaves unknown ones as they are and
  appends the output rule. The editor's Upsample uses a template only when one is picked in Settings; otherwise
  `builtInUpsampleInstruction` (`inpaint_canvas.js:996-1016`): a shared `rules` string ("never mention the region or
  the image", "translate to English") for add / remove / outpaint / upscale, and **the default `edit` case with its
  own wording** ("Do not describe the picture", 1009-1010). **The language model sees one picture** (the crop with
  the selection marker, `promptContextCanvas` 9909); `llm.ask` takes a single `image` (`llm.js:16-19`), and the
  compatible client's retry after an image error drops it (257-268). `applyTextResult` (10000-10013) replaces the
  whole prompt; nothing checks tokens. Revert keeps `promptBackup` / `upsamplePending.previous`.
- **Runs that send no references:** Generate new (`host.js:1240`; the adapters clear them again for `kind: "text"`)
  and every upscale (`host.js:1144-1150`). Both dialogs **prefill their field from the editor prompt** (`shell.js:1088,
  1297`), and both runs fall back to `editor.promptText` (`host.js:1142, 1236`).
- **Agents** see `role` and `visible` in `list_layers` (`commands.js:58-75`) but no number; the assistant's state note
  does not print the role (`assistant/prompt.js:47-55`); `set_prompt` says only "Set the prompt".
- **Silent drops.** Several routes lose visible references without a word; they are filed in `docs/BUGS.md`
  ("Reference layers dropped without a word", 2026-09-29), among them `flux2_klein_local`, which with Original on
  sends no reference at all.

## 3. The design in short

- **Tokens.** The prompt stays plain text. `@img1`, `@img2` name the **visible** reference layers in list order (top =
  img1), the same order as today's `ref N` and the node's batch order. A reference with no label right now (hidden,
  deleted, or failed to load) has its tokens **parked** as `@img?<layer id>`: shown as an inactive or broken chip,
  refused by a run, and turned back into `@img<n>` when the layer gets a label again. No document field changes.
- **Numbers follow their picture.** Every change of the visible references (add, delete, reorder, hide or show, role
  change, merge, duplicate, solo, undo / redo of a layers step) rewrites the tokens by layer id at the site of the change
  (26b1). A new reference goes below the others, so it takes the next number and nothing is renumbered. Paths that bring
  the prompt back together with the layers (a turn snapshot, opening a document) only rebuild the map.
- **The API name is written at send time.** The renderer turns each token into a marker `{@ref:i}` (i = the picture's
  index in `request.references`). Main turns the marker into the name the route gives that picture, from the adapter's
  own `layout(req)` and the recipe's `refs.name` ("image 3", "Image 3", `<image3>`). A route that cannot name it
  refuses. The status line shows what went out ("@img1 -> image 3"); the chip's hover card and the bar show it before
  the click. Local ComfyUI recipes resolve in the renderer with the node's batch rule (26e).
- **Routes are made honest.** Every place that drops a reference without a word refuses or declares the drop; caps per
  variant and channel; one instruction sentence that numbers the pictures the same way the names do; label parts for
  Gemini (26a2).
- **The field.** A contenteditable that behaves like a textarea to the rest of the editor (`value`, selection, events)
  and draws each token as Magnific's chip: 16 px round thumbnail, label, chevron that swaps it. `@` opens a picker at
  the caret (from the `input` event, because `@` is AltGr+Q on the user's keyboard); a reference bar sits above the
  field; hover shows a larger preview and the name it is sent as (26c).
- **Upsampling.** Templates get `{references}` (tokens and layer names, never the API names); the app appends a token
  rule; the answer is checked and remapped (26d1). The language model also sees the named reference pictures, on by
  default with a setting (26d2).
- **Generate new** sends the visible references to the text routes that take pictures, and keeps the reference layers
  when its result replaces the base (26f).
- **The ComfyUI node** is untouched in behaviour: every new thing in the shared editor is gated by `host.refTokens`,
  which the node answers `false`.

## 4. Contracts (binding for every step)

These resolve the differences the two cross-step critics found between the step plans. Names, signatures and shapes
here win over the step texts.

### C1 Grammar, `renderer/editor/reftokens.js` (26b1)

- `TOKEN = (?<![\w-])@[Ii][Mm][Gg](?:([1-9]\d{0,2})|\?(L[0-9a-z]+))(?![\w-])`: live `@img1` .. `@img999`, parked
  `@img?<layer id>`. The prefix is case-insensitive by hand (no `/i`), the id case-sensitive. `@img0`, `@img01`,
  `@img1234`, `@img?labc` are plain text **everywhere**: `electron/main/providers/refs.js` uses exactly this `TOKEN`
  (26a1's `/i` version is replaced), so the renderer never shows as plain text what main would refuse.
- Labels: `labelMap(referenceLayers())`, visible references with pixels, top = 1 (decision B).
- Exports: `parse`, `hasTokens`, `normalize` (prefix only), `labelMap`, `sameLabels`, `remap` (one callback replace:
  no collision on a swap), `toMarkers(text, labels, sent)` (`sent` = `request.references` order with `null` for the
  Original; `null` = validate only; errors `{kind: literal|parked|unknown|unsent, token, n?, id?}`),
  `namesFor(text, names) -> {text, replaced, missing}`, `clean(name)` (strips `@ " { }` and line breaks, 60
  characters, `unnamed`; used by `namesFor` and by 26d1), `compare(req, ans, allowed) -> {dropped, invented,
  literals}` (literal patterns as in 26d1), `mapOffset(off, a, b)` (26c's caret mapping, moved here; 26b's
  `mapCaret` is dropped). 26d1 adds `referenceName`, `referencesText`, `referencesRule`, `checkNote`.
- `tools/refs_cases.json` (26a1 writes it to this grammar): `{text, tokens}` cases including `@img0`, `@img01`,
  `@img1234`, `@img?labc`, `@IMG?Labc`, `@image2`, `mail@img1.de`, `@img1-a`, plus marker-resolution vectors. Read by
  `refs_layout_test.js`, `reftokens_test.js` and 26e's `comfyrefs_test.js`.

### C2 Remap (26b1)

- `refsMutated({alias})` runs at the mutation sites **right after the list or flag change and before the site's first
  render** (else the drift counter counts it): `addLayer` for a reference, `removeLayer`, `moveLayer`, `reorderLayer`,
  `setLayerRole`, the reference eye, `soloLayer` (once, before 12234, covering both branches), `soloResult` (after
  the loop, before 14120), `mergeDownNow` (with `alias`), `duplicateLayer`, `set_layer visible`, flatten and extend
  (map refresh), `applySnapshot` kinds `layers` and `canvas`. Guarded by `host.refTokens` and `!this._loading`.
- Targets: `promptText` (through `setPromptText(text, {keepCaret: true, history: fn})`), `negativeText`,
  `promptBackup`, `upsamplePending.previous` (never `.request` / `.labels`), and registered targets
  `editor.addRemapTarget(field) -> dispose` (26f's dialog field), which get `field.setText(remap(field.value, b, a),
  {keepCaret: true, history: (t) => remap(t, b, a)})`.
- Rebuild only: `applySnapshot` kind `turn` (it restores prompt and negative with the layers) **after first remapping
  the targets the snapshot does not carry** (`promptBackup`, `upsamplePending.previous`, registered targets) from
  `this.refMap` to the restored labels; `setBasePixels` when the layers are cleared; 26f's `setBaseFromCanvas` /
  `newCanvas` with `keepRefs` (ids and order unchanged); `setValue` builds the saved map from `state.layers` and calls
  `refsMutated()`, so a reference that failed to load gets its tokens parked instead of shifting the others.
- The drift counter `ed._refDrift` (in `renderReferences`) must be 0 at the end of every gate that touches references.
- Placement changes are gated by `host.refTokens` (the splice in `addLayer`, the move on a role change, the duplicate's
  place). `moveReference` (the up / down fix, `docs/BUGS.md`) ships to both hosts.

### C3 The send path

- **The click snapshot:** `editor.refSnapshot() -> {prompt, negative, refIds, labels}` in `generate()` right after
  16211, before `heldEdit` / `freeHelperModels`. `host.queueGenerate(editor, opts = {})`, the snapshot in `opts.refs`
  (a direct caller passes nothing and the snapshot is taken inside). 26e uses `const snap = opts.refs ||
  editor.refSnapshot()`; its own positional signature and its sub-task 6 are dropped.
- `prepareCrop` / `prepareCropAsync` / `serializeForPrompt` take `opts.refIds` (`refLayersFor`); `serializeForPrompt`
  also `opts.prompt` / `opts.negative`.
- **The Original:** a send reads `planCrop`'s `info.original` (26a1; both crop paths return it); 26b's
  `prep.original` is dropped. Previews use one editor method, `editor.predictOriginal({local})` = selection and fill
  not none and Original on and not (local and refine) (26b2), for `status`, `refLayout`, the Info panel and
  `comfyLayout`'s pre-check.
- **One run helper** (26b2): `host.refPrompt(editor, snap, route, {prompt, negative, sent}) -> {prompt, negative,
  note, pairs: [{label, id, ref}]}`. Routes: `"edit"` (markers; provider edits, and from 26f text runs with `sent =
  refIds`, no Original), `"none"` (layer names through `namesFor`, **in the request text only, never written back
  through `setPromptText`**; upscale always, Generate new until 26f), `"local"` (26b2: refuses tokens on comfy
  recipes), replaced by `"comfy"` in 26e (markers resolved in the renderer with `comfyrefs.resolveMarkers` against
  `comfyLayout`). Caps and "takes references" belong to main (`checkPictures`), not to the helper. `generate_new`
  leaves `ed.promptText` untouched (26b's substitution at `commands.js:645` is dropped).
- **Request:** marker `{@ref:i}`, i = index into `request.references` (the Original at 0 when `original: 1`);
  `original: 0|1`; `refName` = the variant's `refs.name`, for text runs (26f) `(t.refs && t.refs.name) || (r.refs &&
  r.refs.name) || null`.
- **Main**, `electron/main/providers/refs.js` (26a1): `MARKER`, `MARKER_ANY`, `TOKEN`, `REF_NAME_DEFAULT`,
  `validRefName`, `nameOf`, `refRoles`, `layoutOf`, `countOf`, `checkLayout`, `resolveMarkers(text, pictures, pattern)
  -> {text, left, refs}` (exported; `index.js`'s `resolveNames` wraps it). 26a2 puts `instruction`, `labelParts`,
  `checkPictures` into **refs.js** too (not `util.js`; `util.refName` is not built, `nameOf` is the one).
- **`edit()` order**, computed on every run from 26a1 on (26a1's lazy clause and its "never called" test are
  dropped): `layoutFor` -> `checkPictures` (26a2) -> layout again when references were stripped -> `resolveNames` ->
  safety net (`TOKEN` or `MARKER_ANY` left: refuse) -> adapter. A throwing layout refuses before any fetch.
- **`layout(req)`** -> `{pictures: [{role: crop|mask|original|reference, ref?, field, n: number|null}], max, drops,
  style}`. `n: null` = a picture in a field of its own (a mask field, Ideogram's style references). `countOf(lay)`
  counts every picture but a mask in its own field; **every cap and every message uses `countOf`**; `labelParts` and
  `instruction` iterate the numbered pictures sorted by `n`. `drops` is all or nothing from 26a2 on (26a1's partial
  drops for BFL and Comfy Cloud Qwen are declared honestly and become caps in 26a2). Kind `text`: central in 26a1 (no
  pictures, "Generate new sends no reference images"), per adapter in 26f (no crop; `checkLayout` relaxed for kind
  text: numbered references 1..N).
- **`provider:edit` result:** `{bytes, mime, seed, info, seconds, prompt, negative, refs: [{ref, name}], notes}`
  (`notes` from 26a2). `runProvider` returns `info` and `notes`. The editor keeps `lastSentPrompt`, `lastRunNotes`
  and **`lastRunError`** (set in `generate()`'s catch, cleared at its start); `commands.generate` throws
  `lastRunError` right after `await ed.generate()` (no 30 s wait on a refusal) and returns `prompt_sent` and `notes`
  (26b2 builds `lastRunError`, 26a2 `lastRunNotes`).
- **`provider:layout(shape)`**: shape `{provider, model, kind, fields, options, params, original, count, refName}`
  (`count` = references including the Original; **no `fill`**: main derives the mask from `kind` as the builders do),
  built by one renderer helper `host.layoutShape(editor, over)` that `runProvider`'s request uses too (26b2). Answer
  `{pictures, max, drops, style, names, sent, over}`, `names` per reference index.
- **`host.refLayout(editor, over = {})`** (26b2) -> `{names: Map<layerId, string>, over: Set<layerId>, none:
  string|null, local: boolean}`. Layer k of `referenceLayers()` gets `names[original + k]`. Used by
  `status.references[].sent_as` (snake case, as the other agent fields), by 26c (cached as `ed.refLayoutInfo`,
  debounced, refreshed on recipe / provider / channel / Original / fill changes), by 26e (comfy branch, same shape,
  synchronous) and by 26f (`over = {kind: "text", provider, model, original: 0}`). 26b's `refSentAs` and 26c's own
  cap arithmetic are dropped.
- **Recipes:** provider variants always carry `refs: {name}` after `normalize` (default `image {n}`); comfy recipes
  `refs: {name, slots}` (`slots` = pictures including the crop; validated in 26e); text shapes `text.refs: {max?,
  field?, model?, options?, name?}` (26f; `name` checked with `validRefName`). 26a1 writes the `Recipe` typedef line
  once: `@property {{ name?: string, slots?: number | null } | null} [refs]`.

### C4 The field (26c)

- `new PromptField({placeholder, refs: () => RefContext, popupRoot, addReferences: (files) => Promise<layerIds>,
  preview: (id, canvas) => void})` and `new RefBar(field, {mount})`. Every popup is clamped to `popupRoot`. The
  chevron, the bar chips and "+" are `type="button"` (inside the Generate new dialog's `<form method="dialog">` a
  plain button would submit it). The hover card draws through `preview`, never through an editor it does not know.
- `RefContext = {refs: Descriptor[] (hidden ones with label null), cap, none, canAdd, reason(id)}`; `Descriptor =
  {id, label, name, visible, thumb, sentAs}`. `editor.refContext()` builds it on 26b2's `refDescriptors()` plus the
  thumbnails and `ed.refLayoutInfo`.
- `ed.promptInput = field.el`, the contenteditable, with `value`, `selectionStart`, `selectionEnd`,
  `setSelectionRange`, `placeholder`, `disabled`, and `input` / `change` like a textarea (tests call `.focus()`,
  `.closest()`, `document.activeElement === ed.promptInput`).
- `setPromptText(text, {keepCaret, history})`: `history` is `"push"` (default), `"reset"` (open, snapshot restore)
  or a text-to-text function (a remap, applied to the field's undo entries without a new step).

### C5 Upsampling

- 26d1 delivers the pure pieces (`referencesText`, `referencesRule`, `checkNote`, `ctx.references = [{id, n, name}]`
  of the tokens the prompt names) and the editor's upsample path. **26f owns every change in the Generate new dialog**
  (its upsample, pictures, check and Revert); 26d1's sub-task 7 and 26d2's sub-task 4 move there. The pictures and
  names cover the references the prompt **names**, not every visible one.
- 26d2: `llm.ask({..., images: [{png, label}]}) -> {..., pictures}`; `host.askLLM(backend, instruction, canvas,
  images = [])` (a positional array; 26f's options object is dropped); `host.llmPictures(editor, refs)`; the setting
  `llm.refPictures` (absent = on). The compatible client's non-strict retry predicate changes to retry only on
  400 / 413 / 415 / 422 or an error about images, so a wrong key costs one request, not three (a behaviour change for
  the local endpoint, in the CHANGELOG notes). The ComfyUI helper upsampler gets names only; the setting's label and
  the manual say "API and local-endpoint models".

### C6 The node

- `renderer/editor/` is the node's source. New shared modules go into `tools/build_node.py` `FILES`
  (`reftokens.js` in 26b1, `prompt_field.js` in 26c1); `comfyrefs.js` (26e) is app-only.
- **A `host.X` read by a `FILES` module ships with a stub commit in the node repo in the same step** (precedent
  79c345b): `refTokens: false` in 26b1, `async refLayout() { return null; }` in the first step whose shared editor code
  calls it (planned: 26c2's `refreshRefLayout`; `refDescriptors` in 26b2 reads the field `ed.refLayoutInfo`, not the
  host). App-only members (`refPrompt`, `layoutShape`, `refNames`, `llmPictures`, `llmRefPictures`) stay out of
  the node. New members go into the host typedef (the `types` gate).
- The criterion is the `nodecopy` gate plus `npm run types`; a bare `build_node.py --check` is red while the node is
  behind (32 files differ).

## 5. Schedule

At most two build steps per session (the user, 2026-09-28), a local commit per step, a hand-over at the end.

| Session | Steps | Depends on | Size |
|---|---|---|---|
| S1 | **26a1** positions (main) + **26b1** tokens, labels, remap (26b sub-tasks 1-10) | - | 1 d + 0.75 d |
| S2 | **26b2** snapshot, send path, run helper, agents (26b sub-tasks 11-17), then **26a2** routes | 26a1, 26b1 (26a2's sub-task 17 needs 26b2's helper) | 0.75 d + 1 d |
| S3 | **26c1** the field core, then (after the user has looked at it in the app) **26c2** picker, bar, hover, swap | 26b2 | 1-1.25 d + 1 d |
| S4 | **26d1** templates and the check + **26d2** pictures to the language model | 26b2 (26c for the field's undo) | 0.5-0.75 d + 0.5 d |
| S5 | **26e** local recipes + **26f** Generate new | everything above | 1 d + 1-1.5 d |

About 8.5 to 9.5 days in all. Between S1 and S2 a typed `@img1` is refused by main (the safety net) until 26b2 sends
markers; there is no release in between. After S5: the CHANGELOG section from the notes in section 6, the manual's
figures, exe gates, and a release (0.1.34 if the eraser hotfix of docs/BUGS.md goes out as 0.1.33) only on the
user's word.

## 6. Tests, docs and the CHANGELOG notes

**Tiers** (CLAUDE.md "Working rules"): normal for the editor parts (one gate step per feature on the tiles backend
plus the gates the change touches), light for providers, templates and docs. Two parts are higher:
- **26b1's `setValue` change is full tier**: it rewrites the stored prompt on every open and every autosave restore.
  `refs_restore` runs on both backends (`bash tools/run_gates.sh refs26b1-cv --offline --tiles off commands document`
  beside the tiles run), and two mutations on a fresh instance (skip the `setValue` `refsMutated`; drop the
  parked-on-missing branch) must each turn `refs_restore` red.
- **26f runs `generate` on the canvas backend too**: the reference layers now live across a base swap.

Every gate line runs `--offline` (a fresh gate profile otherwise forwards every upload, reference layers included, to
the user's ComfyUI). No `smoke`, no live model run, no mutation round beyond the one above, no screenshot gate; the
user judges looks. Gate steps that need a return value call `host.runProvider(ed)` or `host.queueGenerate(ed, {refs})`
directly; comfy steps stub `host.connected`, `objectInfo`, `ensureOnServer` and `api.queuePrompt` as
`tools/upscale_test.py:320-330` does (else `--offline` refuses with "Not connected" before any token check).

**Docs, who writes what:**
- Each step writes its own `docs/MANUAL.md` lines in its commit (light tier). 26d2 writes only the upsampling part of
  line 145; 26f owns the Generate new sentence there. Figures at the release.
- `docs/RECIPES.md` gets **one** subsection, "Reference pictures: order, names, caps and drops", created by 26a1
  before "Transparent results" (208) and extended by 26a2; 26e adds the local subsection, 26f "Generating without an
  image".
- `docs/TESTING.md`: each step lists its new tests. `docs/BUGS.md`: each step marks what it fixed (26b1 the up / down
  item, 26a2 the provider items, 26e the local, Info-panel and node-skip items).
- This plan: each step adds a short "built" paragraph under its heading; 26c rewrites nothing else.

**CHANGELOG notes** (every step appends here; the release's section is written from this list):
- 26a2: the instruction sentence changes on every route that had one ("Edit image 1 ... Images 3 and 4 are reference
  images"); the Original gets its own sentence; declared drops are reported in the status line; WaveSpeed FLUX.2
  takes 3 pictures (runs with the Original and two references are refused now); flux1_fill on Comfy Router runs
  again and leaves the references out, as its note says. Built: every route either sends every picture, refuses before
  anything is sent, or says in the status line what it left out; caps per variant (BFL klein 4 and FLUX.2 8 without
  the old silent cut at 7, Grok on fal 5, GPT Image 16 on OpenAI, Nano Banana 14, Seedream on fal 10, ...); Gemini
  direct and Comfy Router's Google route put a label ("Image 1:") before each picture when more than one goes; Comfy
  Cloud uploads only the pictures its node reads.
- 26b: reference badges read `img1`; hiding a reference renumbers the prompt; a new reference goes below the others;
  a role change to reference moves the layer there; up / down in the reference list steps past the next reference.
  26b1 also: a role change (the layer panel's kind and Role selects, the list's "back to image", `set_layer role`) is
  an undo step "Layer role"; Ctrl+] / Ctrl+[ on a reference steps past the next reference; a duplicated reference goes
  below the others ("added as @img3"). 26b2: `@img1` in the prompt goes to an API model as its own name for that
  picture, and the status line says which ("@img2 → image 3"); a run reads the prompt and the references at the click;
  a token for a hidden or deleted reference stops the run with the reason; Upscale and Generate new write a token as the
  layer's name (their dialogs' prefill too); ComfyUI recipes refuse tokens for now; Select by text reads a token as "the
  reference image"; agents get `label`, `status.references[].sent_as`, `set_prompt refs` and `generate`'s
  `prompt_sent`, and a refused `generate` returns at once.
- 26c: the prompt field shows reference chips; Upsample, Revert and an agent's `set_prompt` are steps of the field's
  own undo. 26c1 built: a token shows as a chip (round picture, label; a hidden reference's struck through with the
  layer's name, a deleted one's or an unknown number's struck through in red, the reason on the mouse); a chip is one
  character for the caret, Backspace and Delete; a token turns into a chip at the space after it; a word typed against
  a chip gets a space (a typed space steps over it), and the space between a chip and a word is stepped over by
  Backspace / Delete instead of gluing them; a press on a chip puts the caret beside it; Ctrl+Z / Ctrl+Y in the field
  are the field's own (word steps), and an undo there names the references as they are now; the field's line height
  is 22 px (the textarea's was 17.5). 26c2 built: @ at the start of a word opens a list of the shown references (picture,
  label, name, what the model gets it as), narrowed by what is typed after the @; arrows, Enter / Tab, Escape (first the
  list, then the field); "+ Add reference" in the list, and a picture pasted into or dropped on the prompt, becomes a
  reference layer named there; a bar above the prompt (a chip per reference, a hidden one dimmed, "+", "2 of 4 for this
  recipe"); a chip past the recipe's cap gets a warning edge, every chip is struck through when the recipe sends no
  reference pictures; a card after 400 ms on a chip (a larger picture, the name, "sent as image 3" or why not) replaces
  the chip's tooltip; the chip's arrow swaps it, shows a hidden reference again or takes it out; chips can be dragged in
  the text, a selection dragged inside the field moves (Ctrl copies).
- 26d1: upsampling keeps the @img tokens: the language model is told which reference each names and a rule to keep
  them; a token of a hidden or deleted reference (or a number no reference holds) stops the upsampling with the reason;
  a rewrite that drops, adds or numbers a token says so in the status line (agents: `upsample_prompt`'s `check`); a
  reference moved, hidden or merged while the model answers keeps its tokens in the answer; templates get
  `{references}` (the five shipped ones use it, a template of your own gets the names appended).
- 26d2: the named reference pictures go to the language model's provider when upsampling (a setting turns it off);
  the local endpoint no longer retries a 401 / 402 / 429.
- 26e: local Klein and Qwen 2.1 no longer repeat the crop into unused slots, so the same seed gives another result;
  Klein with Original on now sends the references at all.
- 26f: Generate new keeps the reference layers and sends them where the model takes pictures; Replicate text runs
  send the chosen aspect instead of `match_input_image`.

## 7. Defaults taken for the smaller questions

The planners raised these; each has a default the build follows unless the user says otherwise.

| Step | Question | Default |
|---|---|---|
| 26a2 | The Original gets its own sentence ("Image 2 is image 1 before the selected area was filled") | yes |
| 26b1 | A role change to reference moves the layer below the other references (so it takes the next number) | yes |
| 26b1 | Hiding stays without an undo step (the remap is lossless) | yes |
| 26c1 | Upsample, Revert and `set_prompt` become steps of the field's own undo | yes |
| 26c2 | An image pasted or dropped into the prompt becomes a reference plus its token (today it does nothing) | yes |
| 26c2 | Hidden references in the bar: dimmed, not insertable, the hover card says why | yes |
| 26c2 | The picker's search is the text typed after `@` (Magnific), no separate search box | yes |
| 26c2 | Chips can be dragged inside the text (cut first if time runs short) | in 26c2 |
| 26c | The negative prompt stays a textarea (its tokens are resolved but not drawn as chips) | yes |
| 26d2 | The ComfyUI helper upsampler gets names only, no pictures, until a node release | yes |
| 26e | Local Klein references stay at 1 MP each (VRAM grows with each) | 1 MP |
| 26f | A token on a model that takes no reference pictures is refused (not written as a layer name) | refuse |
| 26f | Adding a reference to an empty tab makes a white 1024 x 1024 canvas that Generate new then replaces | yes |
| 26f | Visible references the prompt does not name still go along (as in Generate) | yes |

## 8. Later, not in this round

- Magnific's categories (character, style, element, location) as a role per reference, fed into `{references}` and
  the instruction ("image 3 is a style reference"): a new layer field, so document format, full tier (decision F).
- Magnific's `/` template picker in the prompt.
- A library of saved references across documents (Magnific's trained characters).
- The ComfyUI node: chips, token resolution in `nodes.py`, a refusal instead of skipping an unreadable reference when
  the state says `named_refs: true`, and pictures for the ComfyUI helper upsampler (a node release).
- A token for the edited picture itself, aliases per reference, chips in the negative prompt.

---

# The steps

## 26a1: Positions (main side)

**Built (2026-09-29, S1).** `electron/main/providers/refs.js` (C1's `TOKEN`, `MARKER`, `nameOf`, `validRefName`,
`refRoles`, `layoutOf`, `countOf`, `checkLayout`, `resolveMarkers(text, pictures, pattern) -> {text, left: [{ref, why:
absent|unnumbered}], refs}`); `layout(req)` in every adapter with `edit` (fields are paths into the body sent:
Replicate's start with `input.`, OpenAI's form is `image[][k]`, Comfy Cloud's are the model node's input keys);
`index.js` computes the layout on every run (`layoutFor` -> `resolveNames` -> the safety net -> the adapter, all inside
the try, so each refusal has an error record) and exports `layout(shape)`; IPC `provider:layout`; the loopback's info
carries `prompt`, `negative`, `original`; `normalize` gives every provider variant `refs: {name}` (18 recipes set theirs);
`planCrop`'s `info.original`; `runProvider` sends `original` and `refName`. What the code showed against the table:
`drops` is route level (BFL's cap sentence and Comfy Cloud Qwen's stand on every request, also with nothing left out);
Comfy Router's xai / ideogram / krea and Magnific's Z-Image / Mystic refuse an edit run in their layout with the
builder's words (they make pictures from the prompt alone) instead of declaring `drops`; routes that need a mask
(Magnific Ideogram and Expand, Comfy Cloud FLUX.1 Fill) throw for kind edit; Comfy Router's FLUX.1 Fill refuses any
reference before its body drops them (`picturesFor` counts them; `tools/refs_layout_test.js` lists it in
`KNOWN_REFUSALS` until 26a2); a WaveSpeed fill with `fields.images` sends no mask (docs/BUGS.md). Tests:
`tools/refs_layout_test.js` (822 shapes, 264 checks), `recipes_test.js` section 3, `generate`'s
`provider_markers_over_ipc`. A review sweep ran every shipped variant at 8, 10, 16 and 17 references and custom
`fields` / `options` shapes against the builders with no mismatch; one thing for 26a2's caps: ToAPIs' builder refuses on
`ch.max_images` truthy while its layout reads `+ch.max_images || null`, so a value like `"0"` would refuse every run
with no cap declared (no shipped channel has it); 26a2 reads every cap as `+x > 0`.

### Read first: corrections from the review (they win over the text below)

- `TOKEN` in `refs.js` is C1's grammar exactly (no `/i`); `tools/refs_cases.json` follows C1 and adds `@img0`,
  `@img01`, `@img1234`, `@img?labc`, `@IMG?Labc`, plus a section of marker-resolution vectors.
- The layout is computed on **every** run (C3 order). Drop "computed lazily, only when a marker is present", the edge
  case "a layout bug cannot break today's runs" and §7's "no marker means a throwing layout stub is never called";
  test instead that a throwing layout refuses before any fetch.
- Export a pure `resolveMarkers(text, pictures, pattern) -> {text, left, refs}` from `refs.js`; `resolveNames` wraps
  it; 26e's test runs the same vectors against it.
- `provider:layout`'s shape has **no `fill`** (main derives the mask from `kind`); `count` includes the Original. The
  renderer builds it with `host.layoutShape` (26b2); this step's tests pass the shape directly.
- The `Recipe` typedef line is C3's final one (`{{ name?: string, slots?: number | null } | null} [refs]`).
- Gate line: drop `nodecopy` (`stitch.js` is app-only, `build_node.py:36-37`); it becomes needed from 26b1.
- `docs/RECIPES.md`: create the one subsection "Reference pictures: order, names, caps and drops" before
  "Transparent results" (208); 26a2 extends it.
- Later steps flip two of this step's assertions: §6 (text runs carry references from 26f) and the recipes_test line
  "a comfy recipe's refs is untouched" (26e validates it).

### Goal and done when

Main learns where every picture of a request sits and what the model calls it. Each adapter declares the order its builder really sends (`layout(req)`). `providers/index.js` turns the renderer's markers `{@ref:i}` into the route's own name, inside the one `provider:edit` call. It refuses what it cannot name, and a safety net refuses any `@img` token or marker that is left over. The live preview can ask for the same answer through `provider:layout`. Recipes carry `refs.name`.

Done when:
- every adapter with `edit` exports `layout`;
- `node tools/refs_layout_test.js` pins each layout against the captured request of every shipped variant (every channel for ToAPIs);
- index.js resolves markers, refuses leftovers, and returns and logs the resolved prompt;
- `window.scumble.providers.layout(shape)` answers;
- `normalize` gives every provider variant a valid `refs.name`;
- `resolveRecipe` carries it, and `runProvider` sends `original` and `refName`;
- the gate line in Tests is green.

Builders are not changed here: no fixes for silent drops, no caps, no preamble. The layouts declare today's behaviour.

### Sub-tasks in build order

1. **New `electron/main/providers/refs.js`** (CommonJS, no Electron, no I/O). It holds the helpers that the adapters, index.js and recipes.js share:
   ```js
   const MARKER = /\{@ref:(\d+)\}/g, MARKER_ANY = /\{@ref:/;
   const TOKEN = /(?<![\w-])@img(?:\d+|\?L[0-9a-z]+)(?![\w-])/i;      // = reftokens.js's grammar (C1)
   const REF_NAME_DEFAULT = "image {n}";
   const validRefName = (s) => typeof s === "string" && s.length > 0 && s.length <= 40
       && /\{n0?\}/.test(s) && /^(?:[^@{}]|\{n0?\})*$/.test(s);
   const nameOf = (pat, n) => (validRefName(pat) ? pat : REF_NAME_DEFAULT).replace(/\{n0\}/g, String(n - 1)).replace(/\{n\}/g, String(n));
   /** [role, index] of req.references in order; references[0] is the Original when req.original. */
   const refRoles = (req, cap = Infinity) => req.references.slice(0, cap).map((_, i) => [i < (req.original ? 1 : 0) ? "original" : "reference", i]);
   /** seq: numbered pictures [role, field, ref?]; own: pictures in a field of their own (n null). */
   function layoutOf({ seq = [], own = [], max = null, drops = null, style = false }) { ... n = place in seq, 1-based ... }
   const countOf = (l) => l.pictures.filter((p) => !(p.role === "mask" && p.n == null)).length;
   function checkLayout(l, req) { /* numbered n are 1..N without gaps, one crop, each ref < references.length and unique */ }
   ```

2. **New `tools/refs_cases.json`.** Grammar cases as `{ text, tokens }`: `@img1`, `@IMG2`, `@img12`, `@img?Lk3x9`, `x@img1`, `@img1-a`, `@image2`, `mail@img1.de`. This test reads it now; 26b's `reftokens_test.js` reads the same file, so the regex in main and the one in the renderer cannot drift apart.

3. **`layout(req)` for every adapter.** It is a pure, synchronous function that is exported beside `edit` and handles `kind` fill and edit only (text and upscale are central, sub-task 4). It must throw the same error its builder throws for an unknown channel, dialect, node or route. Fields name the provider's own input, with a 0-based index for list items. Here `F` stands for the list field named in that row. Sketch for fal:
   ```js
   layout(req) {
       const f = req.fields || {};
       const own = req.mask && req.kind !== "edit" && f.mask !== false ? [["mask", f.mask || "mask_url"]] : [];
       if (req.kind === "edit" || f.images) { const F = f.images || "image_urls";
           return layoutOf({ seq: [["crop", `${F}[0]`], ...refRoles(req).map(([r, i]) => [r, `${F}[${i + 1}]`, i])], own }); }
       return layoutOf({ seq: [["crop", f.image || "image_url"]], own, drops: "This endpoint takes the crop and the mask only: reference images are left out." });
   }
   ```

   | Adapter (builder) | Numbered sequence | Own field (n null) | max | drops |
   |---|---|---|---|---|
   | fal `inputFor` fal.js:25 | edit or `fields.images`: `F[0]` crop, then refs | `fields.mask`‖`mask_url` (kind≠edit, `fields.mask`≠false) | null | fill without `fields.images` |
   | bfl `bodyFor` bfl.js:14 | edit: `input_image`, `input_image_{i+2}` for refs 0..6 | fill: `mask` | null | edit: refs past the 7th; fill: all |
   | openai `edit` openai.js:100 | `image[][0]` crop, refs | `mask` (maskAlpha, kind≠edit) | null | null |
   | gemini `edit` gemini.js:19 | `contents[0].parts[1]` crop, `[2]` mask (kind≠edit), then refs | – | null | null |
   | replicate `inputFor` replicate.js:37 | edit: `F[k]` (`fields.images`‖`image_input`) | fill: `fields.mask`‖`mask` | null | edit with `fields.image` only (crop alone); fill |
   | wavespeed `inputFor` wavespeed.js:56 | edit or `fields.images`: `F[k]` (`images`) | fill: `fields.mask`‖`mask_image` | null | fill |
   | toapis `channelOf` :126, `prepareFiles` :225, `bodyFor` :287 | `ch.images`‖`image_urls[k]` crop, refs | fill and `ch.mask`: `mask_url` | `ch.max_images`‖null | null |
   | openrouter `picturesFor` :216 | `input_references[k]`: crop, mask (fill), refs | – | `o.max_images`‖16 | null |
   | ark `picturesFor` :159 | `image[k]`: crop, refs (no mask at all) | – | `o.max_images`‖10 | null |
   | oxen `picturesFor` :185, `bodyFor` :282 | `F[k]` (`o.image_field`‖`input_image`; bare `F` when `o.single`): crop, mask picture (fill without `o.mask`), refs | fill with `o.mask`: `mask_url` | `o.single` ? 1 : `o.max_images`‖16 | null |
   | comfyrouter `DIALECTS` :261, `picturesFor` :200 | openai `image[k]`; vertexai `contents[0].parts[1..]` crop, mask (fill), refs; bfl FLUX.2 `input_image`, `input_image_{i+2}`; byteplus `image[k]`; qwen `input.messages[0].content[k]` | openai `mask`; bfl fill `mask` | `o.max_images`‖1, plus 1 for vertexai's mask picture | bfl `flux-pro-1.0-fill`; xai / ideogram / krea: empty, "makes pictures from the prompt alone" |
   | comfycloud `SHAPES` :45, `buildGraph` :128 | by `options.node`: the OpenAI, NanoBanana2, Seedream and Flux2 nodes `model.images.image_{k+1}`; Qwen the same, first 3 only; GeminiImage2 / GeminiImage / FluxProFill `images` / `image` crop only | OpenAI node `model.mask` (fill, or edit with `options.mask`); FluxProFill `mask` | null | Qwen past 2 refs; the one-picture nodes and Fill |
   | comfypartner `run` :110 | `messages[0].content[k+1]` crop, refs | – | `options.max_images`‖5 | null |
   | magnific `ROUTES` :81, `DIALECTS` :288 | flux2 `input_image`, `input_image_{i+2}`; seedream / gpt `reference_images[k]`; ideogram `image`; expand `image` (the kept part) | ideogram `mask`, refs as `style_reference_images[k]` (`style: true`) | `R.maxImages` (null for expand) | expand; zimage / mystic: prompt alone |
   | inapp `edit` inapp.js:14 | `image` | `mask` | null | "LaMa takes no reference images" |
   | loopback `edit` loopback.js:96 | `image`, `references[k]` | – | null | null |

   Comfy Router and Magnific get a `layout` next to each dialect's `body`, and Comfy Cloud gets a `LAYOUTS` map beside `SHAPES`, so each declaration sits one screen from its builder.

4. **`providers/index.js`.**
   - `layoutFor(id, p, req)`:
     - `kind` `text`: `{pictures: [], max: null, drops: "Generate new sends no reference images.", style: false}` until 26f;
     - `upscale`: the crop alone (`image`, n 1) plus `drops`;
     - a provider without `edit` throws;
     - otherwise `p.layout(req)` (default: crop, then references), passed through `checkLayout`.
   - In `edit` (86-122), the request built at 97-106 gains:
     - `original: request.original ? 1 : 0`, refused inside the `try` when there are no references;
     - `refName`: the valid pattern, or the default.
   - Inside the `try` at 112, before the adapter call, `resolveNames(id, p, req)` runs:
     - It replaces `MARKER` in `prompt` and `negative`. The layout is computed lazily, only when a marker is present.
     - An index past `references.length` is refused.
     - A reference that is absent from `pictures` is refused with `${label} ${model}: ${drops}`.
     - A reference with `n == null` is refused ("style references have no number").
     - Otherwise the marker becomes `nameOf(refName, n)`.
     - Then the safety net runs: `TOKEN` or `MARKER_ANY` in either text means refuse, and nothing is sent.
     - It also refuses when `.filter(Boolean)` at 104 removed an entry and a marker is present, because the indices would have shifted.
   - The result at 121 gains `prompt`, `negative` (resolved) and `refs: [{ ref, name }]`.
   - The success record at 119 gains `prompt`. The prompt cut in `shape()` (110) and in the success record becomes one constant of 500 characters. `shape()` gains `original`.
   - New export `layout(shape)`:
     - validates `provider` with `hasOwnProperty`;
     - clamps `count` to 0..64;
     - builds a request that stands in for a real one (`Buffer.from([0])` placeholders, `mask` / `maskAlpha` when `shape.fill !== false`);
     - returns `{ ...layoutFor(...), names, sent: countOf(l), over: l.max != null && sent > l.max }`, where `names[i]` is the name or null.

5. **`electron/main/main.js:936`.** Add `ipcMain.handle("provider:layout", (_e, shape) => providers.layout(shape))`. **`electron/preload.js:119-123`**: add `layout: (shape) => ipcRenderer.invoke("provider:layout", shape)`.

6. **`electron/main/loopback.js:100`.** `info` gains `prompt: req.prompt || ""`, `negative`, `original`, so a gate can read what arrived.

7. **`electron/main/recipes.js`.**
   - Typedefs: `ProviderVariant` (71-86) gets `@property {{ name: string }} [refs]`; `Recipe` (88-126) gets `@property {{ name?: string, slots?: number }} [refs]`.
   - `normalize` (265-296): in the variant loop, `v.refs = refsOf(v.refs !== undefined ? v.refs : r.refs, \`${r.id}/${id}\`)`. The result is always `{ name }`; an invalid pattern gives `console.warn` and the default.
   - Comfy recipes stay untouched (26e).
   - The comment at 17-19 lists `refs` among the guarantees.

8. **`recipes/*.json`**, recipe level, following docs/PLAN_REFS.md 3.2:
   - `image {n}`: flux2_pro / flex / max / klein, nano_banana_2 / _lite / _pro, grok_imagine, reve;
   - `Image {n}`: gpt_image_2 / _2_5_flare / _2_5_sunburst, seedream_4_5 / _5_lite / _5_pro, qwen_image_edit, hy_image_3_5;
   - `<image{n}>`: qwen_image_2_1.

   Ideogram inpaint, the fill-only and text-only recipes, and the upscalers get none (their layouts say why).

9. **`renderer/shell.js:432` `resolveRecipe`.** Add `refs: v.refs || null`.

10. **`renderer/editor/stitch.js:435` `planCrop`.** `info.original = hasSelection && fillMode !== "none" && withOriginal ? 1 : 0` (the worker path returns the same `p.info`). **`renderer/editor/host.js:1060` `runProvider`**: the request gains `original: info.original ? 1 : 0` and `refName: (r.refs && r.refs.name) || null`. `runUpscale` and `runGenerate` are untouched until 26b's run helper.

### Interfaces this step defines or consumes

- `adapter.layout(req)` returns `{ pictures: [{ role, ref?, field, n }], max, drops, style }`, as detailed in Contract changes.
- `refs.js`: `MARKER`, `MARKER_ANY`, `TOKEN`, `REF_NAME_DEFAULT`, `validRefName`, `nameOf`, `refRoles`, `layoutOf`, `countOf`, `checkLayout`.
- `provider:edit(request)`:
  - the request gains `original: 0|1` and `refName`;
  - the result is `{ bytes, mime, seed, info, seconds, prompt, negative, refs: [{ ref, name }] }`.
- `provider:layout(shape)`:
  - shape: `{ provider, model, kind, fields, options, params, fill, original, count, refName }`;
  - answer: `{ pictures, max, drops, style, names, sent, over }`.
- Recipes: every provider variant has `refs: { name }`, and `resolveRecipe(r).refs` carries it.
- Crop plan: `info.original`.
- Consumers:
  - 26b: markers, `result.prompt` / `refs`, `layout().names`;
  - 26a2: `drops` / `max` become refusals and caps;
  - 26c: `names` / `sent` / `over` for the bar and the hover card;
  - 26e: `refs.slots` for comfy recipes.

Worked example, GPT Image 2 as a fill with Original on and one reference layer:
- OpenAI direct: `@img1` becomes `Image 3` (crop, Original, ref; the mask has its own field).
- OpenRouter: the same layer becomes `Image 4` (the mask is picture 2).

### Edge cases

- No marker in the text: the layout is not computed, so a layout bug cannot break today's runs. The token safety net still runs.
- A raw `@img1` or `@img?Lk3x` from a user or an agent is refused by main. `@image2` (HY's syntax) passes, and `comfypartner.resolveRefs` still handles it.
- The same marker twice gets the same name, and `refs` lists it once. A marker for the Original (index 0 with `original: 1`) resolves; no token produces one before 26b.
- A reference that is left out (BFL's 8th, Comfy Cloud Qwen's 3rd, every fill route) is refused with `drops`. Ideogram style references are refused ("no number").
- Over `max`: the resolution still names the pictures, and the adapter's own count refusal fires as today.
- `kind` text or upscale with a marker is refused (from 26b the renderer writes layer names there instead).
- An unknown ToAPIs channel, Comfy Router dialect, Comfy Cloud node or Magnific route: `layout` throws the builder's own message. The preview shows it.
- A resolution error happens inside the `try`, so it gets an error log record like any adapter failure.
- `refName` with `{n0}` is 0-based. `@`, `{@ref` and stray braces are refused by `validRefName`, in recipes and again in index.js, because IPC input is never trusted.
- `negative: null` stays null. `provider:layout` with `count` 0 still says whether the route takes references at all (drops or no reference role).
- A literal `{@ref:1}` typed in the prompt reaches main today and is resolved. From 26b, `toMarkers` must refuse a literal marker in the user's text (noted for 26b).

### Tests

Tier: **light** for the layouts and request shapes. **Normal** for index.js, because it is the shared path of every API run: one gate step plus the existing gates that call `index.edit`. No pixel path is involved, so no canvas-backend run and no mutation round.

**`tools/refs_layout_test.js`** (new, plain Node, the pattern of `tools/openrouter_test.js` §1-2, with `section` / `check` from there):

- §1 Grammar: `TOKEN` / `MARKER` against `tools/refs_cases.json`.
- §2 Helpers: `nameOf` (`{n}`, `{n0}`, both); `validRefName` accepts `image {n}`, `<image{n}>`, `<frame>{n0}</frame>` and rejects `""`, `image`, `@img{n}`, `{@ref:{n}}`, 41 characters, non-strings; `layoutOf` numbering; `refRoles` with `original`.
- §3 Coverage: every entry of `PROVIDERS` that has `edit` exports `layout`. The key-only rows (anthropic, deepseek, moonshot, zai, compat) are exempt.
- §4 The pin, for every shipped non-upscale provider recipe × variant (ToAPIs × every channel) × references {0, 1, 3} × original {0, 1}:
  - The adapter's real `edit` runs against a fake fetch that captures the request carrying the pictures and then throws a sentinel.
  - Transports: JSON bodies; OpenAI's FormData as `{ "image[]": [...] }`; WaveSpeed / ToAPIs / HY uploads mapped URL to bytes; Comfy Cloud links followed LoadImage to upload.
  - Fixtures: `pngOf(1024, 768, …, tag)` from openrouter_test.js:39, identified by bytes. Magnific ideogram and expand use the raw-PNG `codec` of tools/magnific_test.js:55-90 with a border mask. inapp gets `../onnx` stubbed through `Module._load`.
  - Asserts:
    - (a) each layout field resolves to its fixture;
    - (b) the set of fixtures found anywhere in the request equals the layout's set (an Ideogram mask, which is converted, is checked by its field);
    - (c) the numbered pictures sorted by their position in the request (the numbers in the path) are n = 1..N;
    - (d) references missing from `pictures` if and only if the request lacks them if and only if `drops` is set.
- §5 Caps: BFL with 9 refs; Comfy Cloud Qwen with 4; OpenRouter, ToAPIs standard (6), comfyrouter vertexai fill (`max_images`+1 passes, +2 refuses), Oxen `single`, each at `max` and `max`+1. `sent > max` if and only if the builder refuses before any fetch.
- §6 Central kinds: for every adapter with `generate`, a text run with 2 references carries no fixture, and `layoutFor` gives `pictures: []`.
- §7 index.js with `Module._load` stubs for electron / log / keys / settings (tools/magnific_test.js §12):
  - loopback: `{@ref:1}` with `original: 1` gives `image 3`, with `Image {n}` gives `Image 3`, with `{n0}` gives `2`;
  - `result.prompt`, `result.refs`, `info.prompt`, and the success record's `detail.prompt`;
  - every refusal (past the end, a dropped reference via a flux1_fill variant, ideogram style, a text run, `@img2`, `@img?Lk3`, `{@ref:x}`, `original` without references), each with 0 adapter calls and an error record;
  - no marker means a throwing `layout` stub is never called;
  - end to end: openrouter with `globalThis.fetch` faked, fill, Original plus one ref, `{@ref:1}` gives `body.prompt` containing `image 4`;
  - `layout(shape)`: `names`, `sent`, `over`, the `count` clamp, an unknown provider, a ToAPIs channel via `params`.

**`tools/recipes_test.js`:** through `_normalize`, a table of recipe id to expected `refs.name`; a variant override wins; an invalid pattern gives the default; a comfy recipe's `refs` is untouched.

**`tools/generate_test.py`:** new step `provider_markers_over_ipc` before `cleanup` (:108). No `\n` in the step's JS.
- Build a 64² PNG through `OffscreenCanvas.convertToBlob`.
- `window.scumble.providers.edit({provider: "loopback", kind: "edit", model: "loopback", prompt: "the coat from {@ref:1}", references: [png, png], original: 1, refName: "Image {n}", image: png, width: 64, height: 64, params: {}})` gives `info.prompt === "the coat from Image 3"`, and `res.refs[0].name === "Image 3"`.
- `prompt: "@img1"` rejects.
- `providers.layout({provider: "openrouter", model: "openai/gpt-image-2", kind: "fill", options: {max_images: 16}, count: 2, original: 1, refName: "Image {n}"})` gives `names` `["Image 3", "Image 4"]` and `sent` 4.

`runProvider`'s two new request fields are checked by 26b's `commands` step (a loopback run with a real reference layer).

Commands:
```
node tools/refs_layout_test.js
node tools/recipes_test.js
node tools/toapis_test.js && node tools/openrouter_test.js && node tools/ark_test.js && node tools/comfyrouter_test.js && node tools/oxen_test.js && node tools/magnific_test.js && node tools/upscale_test.js
bash tools/run_gates.sh refs26a1 --offline --tiles on generate transparent upscale recipes toapis openrouter ark comfyrouter oxen magnific nodecopy lint types
```
`nodecopy` is in the list because `stitch.js` is built into the node.

### Docs

- **docs/RECIPES.md:**
  - `refs` goes into the "Variant fields" paragraph (about 140-155);
  - a new subsection "Reference names and picture order (`refs`)" between "Transparent results" (208) and "Generating without an image" (248) covers: the pattern, `{n}` / `{n0}`, the default, validation, recipe versus variant level, how markers are resolved, `layout`'s meaning of `n`, `max` and `drops`, and the table from sub-task 3 in short form.
- **docs/TESTING.md**, "What each test tool covers": `tools/refs_layout_test.js` and `tools/refs_cases.json`.
- **docs/PLAN_REFS.md** §4: 26a1 built, plus the contract clarifications below.
- **docs/BUGS.md**: extend "Reference layers dropped without a word" with Comfy Cloud's one-picture nodes and Fill, which **upload** the references and wire none (`buildGraph` :135), if that is not listed yet.
- **CLAUDE.md**, "How the app is put together", Provider runs: one clause, "markers resolved by `index.js` against `adapter.layout()`".
- Write the session hand-over at the end.

### Risks and open points

- A layout is a second description of each builder. Drift is caught because §4 walks every shipped variant, and §3 fails for a new adapter without `layout`. 26a2 changes builders (the preamble helper, refusals instead of drops, caps), and its layouts and test rows move in the same commit.
- Most of the effort is the capture harness (five transports). If the day runs short, do the JSON routes first and the upload routes second, both still inside 26a1.
- `n` is the order sent. Whether a model reads "image 3" as the third picture is verified live only for GPT Image 2.5 (OpenRouter) and HY. The mapping from Comfy Cloud's autogrow `image_N` to batch order is assumed. Further checks only with a key and on the user's word.
- `max` is null where the code does not check (fal, Replicate, WaveSpeed, Comfy Cloud, BFL, OpenAI); 26a2 re-reads the pages. Whether vertexai's `max` should keep counting the mask picture is also for 26a2.
- Between the 26a1 and 26b commits, main refuses a typed `@img1`. Never ship 26a1 alone (both are in the same session).
- The loopback info and the success record now carry the prompt. The log is local, and error records already held 200 characters.
- Open for 26b / 26c: whether the renderer caches `provider:layout` per recipe, provider, channel, Original and fill mode (it is a cheap IPC call).

### Contract changes

1. `n: number | null`. Null marks a picture in a field of its own outside the numbered sequence: a mask sent as its own field, or Ideogram's style references.
2. `max` counts every picture except a mask in its own field (`countOf`). It is the adapter's refusal threshold today, and null where the code does not check.
3. `drops` is a sentence at route level whenever this route (for this `kind` / `fields` / `options` / channel) leaves out references it may be given. Which references are left out in a given request is read from `pictures`: an index without an entry.
4. `kind` text and upscale are laid out centrally in `index.js` (`layoutFor`), not per adapter, until 26f.
5. The `provider:layout` shape gains `refName`, needed to answer `names`. `fill` is read as "the request carries a mask" (default true for fill and edit), not as the fill mode, which reaches main only through `original`. The answer adds `names`, `sent` and `over`.
6. The `provider:edit` result also returns `negative` and `refs: [{ ref, name }]` beside the resolved `prompt`.
7. `original: 1` without any reference, and a request whose empty entry would shift the indices, are refused.
8. New module `electron/main/providers/refs.js` and the fixture `tools/refs_cases.json`, shared with 26b's `reftokens_test.js`.
9. `normalize` gives every provider variant `refs: { name }` (default `image {n}`), so `resolveRecipe(r).refs` is never missing.
10. `planCrop`'s `info` gains `original` (this is where `runProvider` reads it).

### Estimate and commit message

About 1 day:
- `refs.js` and 17 layouts: 3 h;
- index.js, IPC, loopback, recipes and the renderer lines: 2 h;
- `refs_layout_test.js`: 3-4 h;
- the gate step and docs: 1 h.

Commit as DenRakEiw, without a trailer, per CLAUDE.md:

```
Item 26 step 26a1: picture positions per adapter (layout), marker resolution and the safety net in providers/index.js, provider:layout, refs.name in the recipes
```

## 26b (26b1 = sub-tasks 1-10, 26b2 = sub-tasks 11-17): tokens, labels, remap, send-time resolution (renderer)

**26b1 built (2026-09-29, S1).** `renderer/editor/reftokens.js` whole (C1 plus `diffRange`; in the node's `FILES`);
`host.refTokens` (app true, the node's `js/host.js` false, committed there); the editor's `refLabels`, `refsMutated({alias,
restore})`, `refsRebuilt({carry})`, `addRemapTarget`, `setPromptText` / `setNegativeText` (every writer and reader of the
field goes through them or `promptText`), `setLayerRole` (an undo step), `moveReference`; img badges in both lists and on
the canvas; a new or duplicated reference and a role change to reference go below the others; `refsMutated` at every
C2 site **and at the layer panel's own eye** (it lists references too; the plan missed it); `setValue` remaps from the
saved map (`restore: true`, since `_loading` holds the other sites off); the turn restore carries Revert's text; the drift
counter. Tests: `tools/reftokens_test.js` (277 checks), the commands gate's `refs_labels`, `refs_remap`, `refs_restore`
(tiles and canvas), the two mutations of section 6 killed (skipping the `setValue` remap by `refs_restore`, no parking
by `refs_remap`, which runs first). `layerSummary`'s `label` and the agents' fields are 26b2. The plugin API's
`refresh()` (after raw layer changes) calls `refsMutated` too. A review (three critics, one skeptic per finding)
confirmed nothing; two edge cases it found are kept as designed: a redo of a reference merge parks tokens written for
the absorbed layer after the undo (`@img?<id>`, refused as deleted; the layers step carries no alias, and an undo
brings them back unchanged), and a caret between two tokens that both change goes to the end of the change (C4's
`mapOffset`).

**26b2 built (2026-09-29, S2).** The editor's `refSnapshot`, `refLayersFor`, `predictOriginal`, `refDescriptors`,
`lastSentPrompt` / `lastRunNotes` / `lastRunError`; `generate()` takes the snapshot before any await and passes it as
`host.queueGenerate(editor, {refs})`; `prepareCrop*` and `serializeForPrompt(opts)` send the snapshot's references (a
hidden one still goes, a deleted one refuses before the crop). In `host.js`: `refPrompt` (routes `edit`, `none`,
`local`; every refusal message of sub-task 14, plus one for a token of the negative), `refError`, `refNames` (the two
dialogs' prefill), `layoutShape` (`runProvider`'s request is built from it), `refLayout` (kept as
`editor.refLayoutInfo`). `runProvider` validates before the crop, sends markers with the Original first, and appends
"Named in the prompt: @img2 → image 3" and the route's notes to the status after `addResults`'s line; it returns
`prompt`, `refs`, `pairs`, `notes`, `info`. Upscale and Generate new write names into the request only; a ComfyUI
recipe refuses tokens before `connected` is checked, a ComfyUI upscale writes names, and `generate_new` on a local
recipe refuses before `newCanvas` wipes the picture. Agents: `label` in `list_layers`, `references` (with `sent_as` from
the `status` command), `set_prompt` / `generate_new` `refs` (answer `labels`, `parked`), `generate`'s `prompt_sent` and
`notes` and its fast throw of `lastRunError`; the assistant's state note prints `ref @img1`. Select by text gives the
language model "the reference image" for a token.

### Read first: corrections from the review (they win over the text below)

- **Split into 26b1 (sub-tasks 1-10) and 26b2 (sub-tasks 11-17).** S1 = 26a1 + 26b1, S2 = 26b2 + 26a2 (section 5).
  26b1 also holds the up / down fix, the placement changes, `setPromptText`, `addRemapTarget` and the node stub; 26b2
  the snapshot, the send path, the run helper, `lastRunError` and the agents. Gate steps: 26b1 `refs_labels`,
  `refs_remap`, `refs_restore`; 26b2 `refs_send`, `refs_names`, `refs_agents`. `reftokens_test.js` is written whole
  in 26b1.
- C1: drop `mapCaret`; `setPromptText`'s `keepCaret` uses `mapOffset` (moved into `reftokens.js` from 26c's plan).
  Add `clean()` and use it in `namesFor` (it strips `{` and `}` too); `refs_names` adds a layer named
  `@img2 {@ref:1} coat` whose upscale passes with the cleaned name.
- C2: call `refsMutated` **before** each site's first render (`soloLayer` once before 12234, `soloResult` after the
  loop and before 14120; check `addLayer` 13519, `duplicateLayer` 12265, the eye 13841, `mergeDownNow` 12348). Gate
  the `addLayer` splice, the role-change move and the duplicate's place by `host.refTokens`; `moveReference` ships to
  both hosts.
- Sub-task 9, the turn restore: before `refsRebuilt()`, remap `promptBackup`, `upsamplePending.previous` and the
  registered targets from `this.refMap` to the restored labels. `refs_restore` adds: upsample, take a snapshot, move a
  reference, restore the snapshot, Revert: the reverted text names the right picture.
- Sub-task 12: read the Original from `planCrop`'s `info.original` (26a1); `prepareCrop*` do not return `original`.
- Sub-task 14: C3's `refPrompt` returns `{prompt, negative, note, pairs}`. Route `"none"` writes names **in the
  request text only**. Sub-task 15: drop "In `generate_new` (`commands.js` 645), tokens are written as names": the
  substitution happens only inside `runGenerate` / `runUpscale`; the dialogs' prefill (their own fields) may use it.
- New in 26b2: `editor.lastRunError` (set in `generate()`'s catch, cleared at its start) and `commands.generate`
  throwing it right after `await ed.generate()`; the refusal gate steps assert a fast throw.
- New in 26b2: `host.layoutShape(editor, over)`, `host.refLayout(editor, over)` and `editor.predictOriginal({local})`
  (C3); they replace `host.refSentAs` / `this.refSentAs`. `refDescriptors()` reads `ed.refLayoutInfo`.
  `status.references[].sent_as` comes from `refLayout`; `refs_agents` adds a selection with fill green and Original on
  and expects `sent_as` "image 3" for img1.
- Contract change 3's request to 26a1 is answered: use `res.refs` (`[{ref, name}]`) for "@img1 -> image 3".
- `refs_send`'s stub comfy recipe needs the stubs of `tools/upscale_test.py:320-330` (`host.connected`,
  `objectInfo`, `ensureOnServer`, `api.queuePrompt`), else "Not connected to ComfyUI." fires first.
- The `setValue` part is **full tier** (section 6): `refs_restore` on both backends and two mutations.
- Docs: mark the up / down item of `docs/BUGS.md` fixed (26b1); add the CHANGELOG notes (section 6). The manual lines
  for labels and hiding go in with this step (section 6), not "at the release".

### Goal and done when
The app treats `@img1`, `@img2` … in the prompt and in the negative as names for the **visible** reference layers. The numbers follow list order (top = img1), the same order as `referenceLayers()` at `inpaint_canvas.js:3191`. Each token stays tied to its layer id through every change that renumbers the references. A token whose layer has no label turns into `@img?<id>` and turns back when the layer gets a label again. Provider runs send markers that main resolves (26a1). The prompt field is still the textarea; 26c swaps it.

Done when:
- `node tools/reftokens_test.js` passes.
- The six new `commands` gate steps pass on `--offline --tiles on`.
- `nodecopy`, `lint` and `types` are green.
- The drift counter `ed._refDrift` is 0 at the end of the gate.
- The node (`host.refTokens` false) still shows positional `ref N` and behaves as it does today.

### Sub-tasks in build order
1. **`renderer/editor/reftokens.js`** (new, pure ESM, no DOM).
   - `TOKEN = String.raw\`(?<![\w-])@[Ii][Mm][Gg](?:([1-9]\d{0,2})|\?(L[0-9a-z]+))(?![\w-])\``. The prefix is matched case by case by hand, not with `/i`, so the id stays case-sensitive. `@img0`, `@img01` and `@img1234` stay plain text. A fresh `new RegExp(TOKEN, "g")` is made per call.
   - Exports: `parse(text)` returns `[{type:"text",text}|{type:"token",text,n}|{type:"token",text,id}]`. The others are `hasTokens`, `normalize`, `labelMap(refLayers)` (`new Map(refLayers.map((l,i)=>[l.id,i+1]))`), `sameLabels(a,b)`, `remap`, `toMarkers`, `namesFor`, `compare` and `mapCaret`.
   ```js
   export function remap(text, before, after) {
       if (!text || !text.includes("@")) return text;
       const idOf = invert(before);                      // n -> id
       // one replace: every target comes from the ORIGINAL text, so img1 <-> img2 cannot collide
       return text.replace(re(), (tok, num, id) => {
           if (id) return after.has(id) ? `@img${after.get(id)}` : `@img?${id}`;
           const lid = idOf.get(+num);
           if (!lid) return `@img${num}`;                 // no layer had that label: kept, normalised
           return after.has(lid) ? `@img${after.get(lid)}` : `@img?${lid}`;
       });
   }
   export function toMarkers(text, labels, sent) {       // sent = request.references order, null for the Original
       const idOf = invert(labels), errors = [];
       if (/\{@ref:/i.test(text)) errors.push({ kind: "literal", token: "{@ref:" });
       const out = String(text || "").replace(re(), (tok, num, id) => {
           if (id) { errors.push({ kind: "parked", token: tok, id }); return tok; }
           const lid = idOf.get(+num);
           if (!lid) { errors.push({ kind: "unknown", token: tok, n: +num }); return tok; }
           const i = sent ? sent.indexOf(lid) : 0;
           if (i < 0) { errors.push({ kind: "unsent", token: tok, n: +num, id: lid }); return tok; }
           return `{@ref:${i}}`;
       });
       return { text: out, errors };
   }
   ```
   - `namesFor(text, names)`: `names(key)` gets `"img<n>"` or `"?<id>"` and returns a name or null. It returns `{text, replaced:[{token,name}], missing:[token]}`.
   - `compare(req, ans, allowed)` returns `{dropped, invented, literals}`. `literals` catches `image N`, `picture N`, `<imageN>` and `{@ref:N}` that are in the answer but not in the request. This is for 26d1 and is built and tested now.
   - `mapCaret(old, next, pos)`: segment k of `parse(old)` maps to segment k of `parse(next)`. A caret inside a token moves to the end of the new token.
2. **`tools/build_node.py:39`**: add `"reftokens.js"` to `FILES`.
   - **`renderer/editor/host.js`**: add `@property {boolean} refTokens` after `removeSupported` (line 207). Line 190 becomes `queueGenerate: (editor, opts?: { refs?: any }) => Promise<any>`. Add `refTokens: true` beside `removeSupported: true` (line 2000).
   - **Node repo `js/host.js:164`**: add `refTokens: false,` as a local commit there. `check_host` (`build_node.py:161`) fails `nodecopy` without it.
3. **Editor state** (`inpaint_canvas.js`):
   - Add `this.refMap = null; this.lastSentPrompt = null;` next to `promptBackup` (line 1763).
   - Import from `./reftokens.js`.
   - New methods, next to `referenceLayers` (line 3191):
   ```js
   refLabels() { return labelMap(this.referenceLayers()); }
   refsMutated({ alias = null } = {}) {                  // C2 mutation sites
       if (!host.refTokens) return;
       const after = this.refLabels(), before = this.refMap || after;
       const target = alias ? withAlias(after, alias) : after;   // merge: the absorbed id takes the survivor's label
       const r = (t) => (t ? remap(t, before, target) : t);
       const p = r(this.promptText); if (p !== this.promptText) this.setPromptText(p, { keepCaret: true });
       const n = r(this.negativeText); if (n !== this.negativeText) this.setNegativeText(n);
       if (this.promptBackup != null) this.promptBackup = r(this.promptBackup);
       if (this.upsamplePending) this.upsamplePending.previous = r(this.upsamplePending.previous);
       this.refMap = after;
   }
   refsRebuilt() { this.refMap = host.refTokens ? this.refLabels() : null; }
   ```
   - `setPromptText(text, {keepCaret})` writes `promptText` and then `promptInput.value`. When the field has focus, it keeps the caret with `selectionStart`, `selectionEnd`, `setSelectionRange` and `mapCaret`. These are only members that C4's PromptField defines, so 26c can swap the element without touching this code. `setNegativeText(text)` is the same for `negativeInput`.
   - Replace the seven writers:
     - `inpaint_canvas.js` 2598 (`open`), 10009 (`applyTextResult`), 10018 (`revertPrompt`), 10863 (turn restore), 16373 (`setValue`).
     - `commands.js` 553 (`set_prompt`) and 645 (`generate_new`).
   - Replace the negative writers: 10867, 16380, `commands.js` 554 and 646.
   - Readers of `promptInput.value` at 9816, 9831, 9836, 9971, 9976, 10002 and 10017 read `this.promptText` instead.
4. **Labels** (under `host.refTokens`):
   - List badge at 13852-13853: `idx >= 0 ? "img" + (idx + 1) : "hidden"`.
   - Canvas frame at 15777: `"img" + (i + 1)`.
   - The eye tooltip at 13838 adds: "hiding renumbers the others; its tokens wait as @img? until it is shown".
   - `addImageLayers`' status at 12090 lists the new labels ("added as @img3, @img4").
5. **New references get the next number.**
   - `addLayer` (13515): when `host.refTokens && layer.role === "reference"` and a reference exists, insert with `this.layers.splice(this.layers.findIndex(isReference), 0, layer)` instead of `push`. Then `refsMutated()`.
   - `addImageLayers` layered branch (12040): for `role === "reference"`, iterate `doc.layers` top-first so the file's stacking order survives.
   - `duplicateLayer` (12260): a reference copy goes below the lowest reference instead of `i + 1`. The status says "added as @imgN". Then `refsMutated()`.
6. **`setLayerRole(layer, role)`**, a new editor method used at 13671, 13753, 13861 and `commands.js:755`.
   - It pushes `{kind:"layers", label:"Layer role"}`, sets the role, clears `exportRef` and the two hashes.
   - On a change *to* reference it moves the layer below the lowest reference.
   - Then `refsMutated()` and a render.
7. **The up / down fix:** `moveReference(layer, dir)`.
   - It finds the next reference in `dir` among `this.layers.filter(isReference)` and calls `reorderLayer(layer.id, other.id, dir > 0)`, so the move steps past the next reference and not the next array element.
   - Used at 13854, 13857 and 2886 (Ctrl+] / Ctrl+[ when the active layer is a reference).
8. **`refsMutated()` at every other mutation site:**
   - `removeLayer` after 13543, `moveLayer` after 13560, `reorderLayer` after 12214.
   - The reference eye at 13839; `soloLayer` after 12230; `soloResult` after 14116 (a result-kind reference).
   - `mergeDownNow` after 12345, with `{alias: new Map([[layer.id, below.id]])}`.
   - `flattenNow` 15312 and the extend at 10281 keep references in order, but the call keeps `refMap` current.
   - `applySnapshot` `layers` (after 10820) and `canvas` (after 10895). These are the undo / redo paths that restore layers without the prompt.
   - `commands.js` `set_layer` after 744 when `a.visible != null`.
9. **Rebuild-only paths:**
   - `applySnapshot` `turn`: `refsRebuilt()` after 10867. This covers `restoreTurn` (10517: assistant undo), `restoreSnapshot` (10566) and the undo / redo of a turn step.
   - `setBasePixels` 13311 when the layers are cleared (`loadFile`, `newCanvas`, `setBaseFromCanvas`, Generate new).
   - `setValue` after the layer loop at 16459: the saved map is `labelMap(state.layers.filter(l => l.role === "reference" && l.visible !== false).reverse())`. Set `this.refMap = saved`, then call `refsMutated()`. This is identity when everything loaded; a reference that failed at 16457 gets its tokens parked.
10. **Drift check** in `renderReferences` (13825): when `host.refTokens && this.refMap && !this._loading && !sameLabels(this.refMap, this.refLabels())`, do `this._refDrift = (this._refDrift || 0) + 1` and `console.warn`. Nothing is remapped there.
11. **The click snapshot.**
    - `refSnapshot()` returns `{prompt, negative, refIds: referenceLayers().map(l => l.id), labels: refLabels()}`.
    - `refLayersFor(ids)`: no `ids` → `referenceLayers()`. Otherwise it returns the layers by id in that order and throws "A reference layer was deleted while the run was being prepared: press Generate again." when one is gone, is no reference any more, or has no pixels. A layer that was only hidden is still sent.
    - `generate()` takes `const refs = this.refSnapshot()` right after 16211, before `heldEdit` / `freeHelperModels`, and calls `host.queueGenerate(this, { refs })` (16222).
12. **`stitch.js`:**
    - `prepareCrop` 487 uses `editor.refLayersFor(opts.refIds)`.
    - `prepareCropAsync` 726 does the same. It is still read before the first await; the fallback at 743 inherits `opts`, which is what fixes the reread after awaits.
    - Both return `original`: `references.length` before the layers are pushed (486), and `made.references.length` (732).
13. **`serializeForPrompt(opts = {})`** (16514): references at 16550 come from `refLayersFor(opts.refIds)`. `prompt` and `negative` come from `opts.prompt ?? this.promptText`, same for the negative. The node calls it without arguments, so nothing changes there.
14. **The one run helper** in `host.js`: `refPrompt(editor, snap, route, { prompt, negative, sent })` returns `{prompt, negative, note}`.
    - Route `"edit"`: `toMarkers` on both texts. Errors are turned into messages (below). With `sent == null` it only validates.
    - Route `"none"`: `namesFor`. A label or a parked id whose layer exists gets its name; a deleted or unknown one is refused. The note reads: "Upscale sends no reference images: @img1 was written as its layer name "jacket"."
    - Route `"local"`: refuses when `hasTokens`.
    - Where it is called:
      - `runProvider`: `snap = opts.refs || editor.refSnapshot()`, which replaces the read at 1052. It pre-validates before the crop and calls `prepareCropAsync(…, { refIds: snap.refIds })`. Then `sent = [...Array(prep.original).fill(null), ...snap.refIds]`, markers, and the request gains `original: prep.original, refName: (r.refs && r.refs.name) || null`. Afterwards `editor.lastSentPrompt = res.prompt || request.prompt`, and the status gets the mapping appended.
      - `runUpscale`, 1142/1143: `"none"`.
      - `runGenerate`, 1236/1237: `"none"`.
      - `queueGenerate`, 1387: it passes `opts.refs` into `runProvider` and `runUpscale`. For comfy recipes, `"local"` runs before `serializeForPrompt`; a comfy upscale uses `"none"` and passes the named text through `serializeForPrompt({refIds, prompt, negative})`.
    - Messages:
      - unknown: "@img3 names no reference image: this document has @img1 to @img2." When there is none: "has none; add a reference layer first".
      - parked, hidden layer: "The prompt names "jacket" (@img?L…), a hidden reference: show it in the reference list, or take the token out."
      - parked, the layer is no reference any more: "…is no longer a reference layer: make it a reference again, or take the token out."
      - parked, the layer is gone: "The prompt names a deleted reference (@img?L…): undo the delete, or take the token out."
      - literal marker: "The prompt holds "{@ref:", which Scumble keeps for itself: reword it."
      - local recipe: "@img tokens name reference images on API recipes only for now; ‹recipe› runs on ComfyUI: take them out of the prompt (the reference layers still go along in the crop_image batch)."
    - A variant that drops references is refused by main (26a1's `layout.drops`).
15. **`shell.js`:** at 1088 and 1297 the dialogs are prefilled through `host.refNames(editor, text)` (the `"none"` route against a fresh snapshot). The note goes into `genState` after 1094 and into `upState` after 1296. In `generate_new` (`commands.js` 645), tokens are written as names *before* `newCanvas` / `runGenerate` wipe the layers.
16. **Select by text** (9816-9836): the language model gets `namesFor(promptText, () => "the reference image").text`.
17. **Agents.**
    - `layerSummary` (`commands.js:58`): `label: "img1"|null` for references.
    - `status(ed)` (189): `references: [{id, name, label, visible}]`. The `status` command (410) adds `sent_as` from `host.refSentAs(ed)`, which asks `window.scumble.providers.layout(shape)` once. The shape is `{provider, model, kind, fields, options, params, fill, original, count}`; `original` is predicted like `renderInfo` does at 13225. Comfy recipes give null.
    - `editor.refDescriptors()` returns C4's `{id, label, name, visible, thumb:null, sentAs}` from `this.refSentAs`, for 26c.
    - `set_prompt` (549) and `generate_new` (624) take `refs: {"img1":"<layer id>"}`. They check each key against `/^@?img([1-9]\d{0,2})$/i` and each id against `ed.layers`, apply `remap(text, agentMap, ed.refLabels())`, and return `labels` and `parked`.
    - `generate` (703) returns `prompt_sent: ed.lastSentPrompt`, reset to null before the run.
    - `electron/main/assistant/prompt.js` `layerLine` (47): `ref @img1`, or `reference, hidden`.
    - `mcp/server.js` INSTRUCTIONS (17): one sentence on the labels and `set_prompt refs`. Also update `set_prompt`'s description.
    - Then `python tools/commands_doc.py`.

### Interfaces this step defines or consumes
- **Defines:**
  - C1 in full (`reftokens.js`).
  - `host.refTokens`.
  - `editor.setPromptText`, `setNegativeText`, `refSnapshot`, `refLabels`, `refLayersFor`, `refsMutated`, `refsRebuilt`, `refDescriptors`, `setLayerRole`, `moveReference`, `lastSentPrompt`.
  - `prepareCrop*().original`; `serializeForPrompt(opts)`; `host.queueGenerate(editor, {refs})`; `host.refPrompt`, `refNames`, `refSentAs`.
  - The request fields `original` and `refName`; the agent fields `label`, `references[].sent_as`, `refs` and `prompt_sent`.
- **Consumes (from 26a1):**
  - `provider:edit` resolves `{@ref:i}` with `layout(req)` and `refName`, refuses leftovers, and returns `prompt`.
  - `window.scumble.providers.layout(shape)` returns the layout plus names per reference index.
  - The recipe or variant field `refs.name`.
  - The loopback's edit info gains `prompt`.
- **For 26c:** `setPromptText` and `refDescriptors`; `parse` / `mapCaret` for the chips.

### Edge cases
- **Swap img1 ↔ img2** (up / down, drag): one callback pass, no collision.
- **Hide / show** round-trips losslessly: the parked token carries the id. The same holds for delete + undo, and for solo on / off.
- **An undo of a `layers` step** also restores visibility flags set after it; the remap follows the ids.
- **Merge of two references:** the absorbed layer's tokens take the survivor's label. The undo of the merge does not split them again (documented). Merging into a *hidden* reference parks the absorbed tokens with the absorbed id, which then reads as "deleted".
- **Role change to reference** moves the layer. Turning it back into an image leaves it where the list had it; the "Layer role" undo step puts back both its place and its role.
- **`@img3` with two references** stays live, binds when a third arrives, and is refused by a run until then.
- **A wholesale replacement** (new image, Generate new) keeps the text as typed with an empty map. Tokens bind to the next references added, as in Magnific.
- **A pasted parked token from another document** stays parked and is refused as deleted.
- **Tokens in the negative** get the same treatment. A literal `{@ref:` is refused.
- **Hide after the click** still sends the snapshot's layer. **Delete** during the crop is refused.
- **`email@img1` and `@img1-2`** are not tokens. `@IMG?Labc` is normalised; `@img?labc` is plain text.
- **In 26b the textarea shows parked tokens raw**, and a programmatic rewrite clears the textarea's own Ctrl+Z history.
- **A comfy upscale** writes names rather than refusing.
- **The node** keeps positional `ref N`, pushes new references to the top, and does no remap (`refsMutated` returns at once).

### Tests
Tier: **normal**, plus the pure function with the most cases. No pixel path changes, so there is no canvas-backend run, no mutation round and no 15k row.

- **`tools/reftokens_test.js`** (new, `await import("../renderer/editor/reftokens.js")`):
  - grammar boundaries: `@image2`, `@img12`, `@img0`, `@img1234`, `x@img1`, `@img1,`, case, parked id case;
  - `parse`, `normalize`, `labelMap`;
  - remap: swap; hide / show; delete / undo; two deletes; merge alias; duplicate / add (text unchanged); unknown kept; parked unparked;
  - a rebuild rewrites nothing;
  - `toMarkers` with `sent` of `[null, a, b]` versus `[a, b]`; every error kind;
  - `namesFor` missing; `compare` with a literal `image 3`; `mapCaret` inside, before and after tokens.
- **`tools/assistant_test.js`:** `_layerLine` of a reference prints `ref @img1`, and `reference, hidden` when hidden.
- **`tools/commands_test.py`, new steps.** Visibility goes through `set_layer`, never through `layer.visible` by hand.
  - `refs_labels`: two `add_image_layer role:"reference"` → `list_layers` labels img1 / img2 in pick order; `duplicate_layer` → img3.
  - `refs_remap`: `set_prompt "jacket from @img2, style of @img1"`; hide A; show A; up / down; delete + undo; `set_layer role:"none"` then `"reference"`; merge → the expected texts; `ed._refDrift === 0`.
  - `refs_send`: `host.setRecipe({provider:"loopback", …, refs:{name:"image {n}"}})`.
    - `select_rect`; `generate` → `prompt_sent` holds `image 3`.
    - `set_crop fill:"green", withOriginal:true` → `image 4`.
    - A parked token → refused, no request sent.
    - A stub comfy recipe with a counting `api.queuePrompt` → refused, count 0.
  - `refs_restore`:
    - `save_document` / `open_document` → the prompt is byte-identical.
    - `setValue` of a state whose reference ref names a missing file → `@img?<id>` and the rest renumbered.
    - `take_snapshot`, hide, `restore_snapshot` → the snapshot's prompt, drift 0.
  - `refs_names`: a loopback upscaler with `usesPrompt` → `upscale {prompt:"crisp @img1"}` gives `info.prompt` with the layer name and the note; the `openGenerateNew` prefill holds names.
  - `refs_agents`: `set_prompt refs:{img1:B}` after a reorder → the token lands on B's current label; an unknown id → error; `status.references[].sent_as === "image 2"`.
- **Commands:**
  - `node tools/reftokens_test.js && node tools/assistant_test.js`
  - `bash tools/run_gates.sh refs26b --offline --tiles on commands document generate upscale editor assistant mcp nodecopy lint types`

### Docs
- `docs/PLAN_REFS.md`: 3.1 rewritten to decision B (visible only), 3.3 to C (26c); add a "26b built" paragraph.
- `docs/MCP.md` "Tools": labels, `set_prompt refs`, `status.references`, `prompt_sent`.
- `docs/COMMANDS.md`: regenerated.
- `docs/TESTING.md`: `reftokens_test.js` in the plain-Node list, the six gate steps, `_refDrift`.
- `docs/ASSISTANT.md`: the state-note line.
- The hand-over in `CLAUDE.md` / `docs/HISTORY.md`.
- The manual waits for the release.

### Risks and open points
- **A mutation site that was missed** makes the prompt drift. The sites were found by grepping `this.layers =`, `layers.splice/push`, `.visible =` and `.role =`, and the drift counter shows any gap in the gate.
- **26b is large for half a session.** If context runs high, split it after sub-task 11: (a) grammar, labels and remap; (b) the send path and agents.
- **Moving a layer on a role change** is new behaviour; the user judges it.
- **Hiding is still not an undo step.** The remap is lossless, so none is added.
- **IME composition during an agent's rewrite** is left to 26c's field.

### Contract changes
1. **C1 additions:**
   - `mapCaret`, `hasTokens`, `sameLabels`.
   - `toMarkers`' third argument is `request.references` order with `null` for the Original, so its index is the marker; `null` as the whole argument means validate only.
   - Error objects are `{kind: literal|parked|unknown|unsent, token, n?, id?}`.
   - `namesFor(text, names)` takes `names` as a function and returns `{text, replaced, missing}`.
2. **`remap` uses one callback replace.** It gives the same no-collision guarantee as sentinels; a test pins the swap.
3. **C3 additions:**
   - `serializeForPrompt` also takes `opts.prompt` and `opts.negative`.
   - `prepareCrop*` return `original`.
   - `host.queueGenerate(editor, {refs})`.
   - Asked of 26a1: `provider:edit`'s answer carries `refNames: {i: name}` for "@img1 → image 3". Without it, the status line quotes the resolved prompt.
4. **C4:** `setNegativeText` beside `setPromptText`.
5. **C6:** the node's `js/host.js` gets `refTokens: false` in 26b already, or `nodecopy` fails.
6. **Role changes become a `layers` undo step.** `generate` takes no `refs` because it has no prompt parameter. The layer summary field is named `label`, since `ref` is already the layer's file.

### Estimate and commit message
1.5 days (the remap sites 0.5, the send path 0.5, agents and tests 0.5).

`Item 26 step 26b: @img tokens (reftokens.js), img N labels, the remap at every mutation site, the click snapshot and one run helper`

## 26a2: Routes: drops, caps, one instruction, label parts

**Built (2026-09-29, S2).** `electron/main/providers/refs.js` gains `instruction(req, lay, text)` (the head with or
without the mask clause, the text trimmed, the Original's sentence, one sentence per run of references; range words
only for a one-word `{n}` pattern, else a list; nothing for `style`; text and upscale unchanged), `labelParts(lay,
pattern)` (by `n`, `[]` for one picture) and `checkPictures(lay, req, who)` (every count `countOf`, every cap read `+x >
0`; drops all or nothing with the note "`who`: `drops`; the Original and 2 reference layers not sent."; a marker on a
dropping route or a style marker refused; over `max` refused with the parts named). `index.js` `edit()`: `layoutFor`
-> `checkPictures` -> the layout again after a strip -> `resolveNames` -> the safety net -> the adapter; the answer and
the success record carry `notes` (the record also `pictures: countOf`), `layout(shape)` answers all `names` null for a
dropping route; `runProvider` (26b2) already shows and returns them. Per adapter: **BFL** `max` by endpoint (klein 4,
FLUX.2 pro / flex / max 8, else null), every reference as `input_image_2..N` with a guard in `bodyFor`, FLUX.1 Fill a
drop; **fal**, **Replicate**, **WaveSpeed** `max` from `options.max_images` with a guard before the first upload (Replicate
beyond the plan: its variants carry caps too), their drop sentences shortened because the note appends "; … not sent."
("This endpoint takes the crop and the mask only", "This endpoint takes one picture"), Replicate's one-image edit a
drop; **In-app** "LaMa fills from the picture alone"; **loopback** honours `options.drops` / `options.max_images`;
**Comfy Cloud** `NODE_PICTURES` as read in `comfy_api_nodes` (GPT Image 16, Nano Banana 2 14, Seedream 10 / lite 14,
FLUX.2 8, Qwen 3), the one-picture nodes `max` 1 and a drop, the Qwen slice gone, `buildGraph` refusing past the count
before any upload and uploading only the references and the mask the node wires (the unwired mask was not in the
plan); **Comfy Router** `editPrompt` (byteplus, qwen) and vertexai through `instruction`, vertexai's label parts (picture
n at `parts[2n]`), its mask picture counted inside `max_images` with a guard in the body (`picturesFor` counts no mask),
FLUX.1 Fill a drop, and `run()` strips the references of a dropping route for a direct call too; **Comfy Partner**
`editText` = `instruction` around the legacy `resolveRefs`; **Gemini** `instruction`, label parts, the mask a picture
only for `req.mask && kind !== "edit"`, `max` from `max_images`, a guard in `edit()`; **OpenRouter** `promptFor(req,
lay)`, **Oxen** through it with its own layout, **ModelArk** `promptFor` = `instruction`; **Magnific** `editPrompt` =
`instruction` (flux2, seedream, gpt), `maxOf(R)` as the picture cap and every layout's `max`, Image Expand a drop (the
log line gone), Ideogram `style` and 11; **ToAPIs** `capOf(ch)` shared by the layout and the guard, so `"0"` is no cap.
`grep "reference material" electron/main/providers` finds nothing. Recipes: the caps of the table plus the ones read at
build time (Grok on fal 5; Nano Banana 2 / Pro and Seedream lite on Replicate 14; Nano Banana 2 / Pro 14, GPT Image 2 /
2.5 16 and Seedream 5 10 on WaveSpeed), and three notes (Replicate Qwen Image Edit, Comfy Cloud Nano Banana Pro, Comfy
Router FLUX.1 Fill). **Not as planned:** `flux2_klein` on Oxen got no cap (Oxen's schema names none; the adapter's 16
holds, undocumented) instead of the table's 4; `openai.js`'s layout did not read `max_images`, so the sweep made it read
the cap and `edit()` refuse past it, as the other adapters do; undocumented as well: fal Nano Banana 2 / Pro, Replicate GPT Image 2, WaveSpeed Nano
Banana 2 Lite and Reve (no page found; a search summary says it takes one picture, unconfirmed), the ToAPIs GPT Image
2.5 channels; the WaveSpeed fill with `fields.images` still sends no mask (`docs/BUGS.md`). The Original's own sentence
is in (§7's default). Tests: `refs_layout_test.js` sections 8 and 9 and its caps rows moved to the new caps; `ark`,
`openrouter`, `oxen`, `comfyrouter`, `magnific`, `toapis` plain-Node tests green with the new sentences and caps (their
`.py` gates edited by reading, run in the main loop's gate line with the `commands` steps `refs_declared_drop` and
`refs_over_cap`). No live run.

### Read first: corrections from the review (they win over the text below)

- The helpers go into `electron/main/providers/refs.js`, not `util.js`. No `util.refName`: use `refs.nameOf`.
- Every count uses `refs.countOf(lay)` (C3): `checkPictures`, `partsOf`, the sweep ("the builder sends exactly
  `countOf(lay)` pictures"). An own-field mask **is** in `pictures` with `n: null`; replace this step's contract
  sentence with C3's. Style references count against `max` (Magnific ideogram, 11). `labelParts` and `instruction`
  iterate the numbered pictures sorted by `n`.
- The layout already runs on every run from 26a1 on (C3); nothing to flip here.
- Sub-task 17: `runProvider` sets `editor.lastRunNotes`; `commands.generate` returns `notes` (C3). `refs_declared_drop`
  reads `notes` from `commands.generate` or calls `host.runProvider(ed)` directly.
- Anchors: `openrouter.js` exports `promptFor` at 423; `ark.js` `promptFor` is 239-246.
- `docs/RECIPES.md`: extend 26a1's subsection; do not add a second one.
- Also fix the `nano_banana_pro` Comfy Cloud note: it advises Original on, which `GeminiImage2Node` cannot send.
- 26f extends `checkPictures` and `instruction` to kind text (the no-crop form); leave text and upscale alone here.

### Goal and done when

**Goal.** No provider route leaves a visible reference layer (or the Original) out without saying so. Each route either sends every picture, refuses before any request, or declares the drop so the status line reports it. Each variant declares how many pictures it takes. The six instruction sentences the adapters build for themselves become one helper, which numbers the pictures the way `layout(req)` does and so matches the names 26a1 resolves the markers to. Gemini direct and Comfy Router vertexai put a label part in front of each picture.

**Done when:**
- Every provider-side item of `docs/BUGS.md` "Reference layers dropped without a word" (lines 256-282) is fixed or moved on. That covers BFL's 7, Comfy Cloud's Qwen slice and its unwired Gemini/Fill nodes, the fill routes, klein on Oxen, fal's caps, and flux1_fill on Comfy Router. The local and node items move to 26e, and up/down moves to 26b.
- Every edit variant of `recipes/*.json` has `layout(req).max` set, or appears in the undocumented list in `docs/RECIPES.md`. A plain-Node sweep checks this.
- `grep -n "reference material" electron/main/providers` finds nothing, and every adapter preamble comes from `util.instruction`.
- The adapter tests (plain Node and gates) are green with the new sentences, run with `--offline --tiles on`.

### Sub-tasks in build order

1. **`electron/main/providers/util.js`: four pure helpers** (after `num`, lines 100-103; export line 105). The file needs no Electron, so plain Node can test it.
   - `refName(pattern = "image {n}", n)` gives the name for picture `n`: `{n}` is 1-based, `{n0}` is 0-based.
   - `instruction(req, lay, text)` returns `head + " " + text + " " + tail`, trimmed. For `kind: "text"` and `"upscale"` it returns `text` unchanged. The pattern is `req.refName || "image {n}"`.
     - head without a mask picture: `Edit image 1 and keep its size and framing.`
     - head with a mask picture: `Edit image 1. Image 2 is a mask: change only the white area of the mask, keep everything else exactly as it is, and keep the image size and framing.` The clause after the colon is kept word for word, because it ran live on OpenRouter.
     - Original (`role: "original"`): `Image 2 is image 1 before the selected area was filled.` The Original is the crop before `fillMasked` (`renderer/editor/stitch.js:458-462`).
     - references, in consecutive runs: `Image 3 is a reference image.` / `Images 3 and 4 are reference images.` / `Images 3 to 6 are reference images.` Range words are used only when the pattern matches `^[A-Za-z]+ \{n\}$`. Otherwise the names are listed: `<image3>, <image4> and <image5> are reference images.`
     - A name at the start of a sentence is capitalised only when it begins with a letter, so HY's `Image {n}` gives `Edit Image 1 …`.
     - `style: true` layouts get no reference sentence.
   - `labelParts(lay, refPattern)` returns `[{ text: "Image 1:" }, …]`, one per picture in `lay.pictures` order. It returns `[]` when only one picture goes.
   - `checkPictures(lay, req, who)` runs before the adapter and throws or strips. Sketch:
     ```js
     const refs = req.references.length;          // Original included (req.original = 1)
     if (!refs || req.kind === "text" || req.kind === "upscale") return { req, notes: [] };
     const marker = /\{@ref:\d+\}/.test(req.prompt + " " + (req.negative || ""));
     if (lay.drops) {
       if (marker) throw new Error(`${who}: ${lay.drops}, so the prompt cannot name a reference image. Take the name out or pick a recipe that sends references.`);
       return { req: { ...req, references: [], original: 0 }, notes: [`${who}: ${lay.drops}; ${countWords(req)} not sent.`] };
     }
     if (lay.style && marker) throw new Error(`${who} sends reference layers as style references, which have no number: take the name out of the prompt.`);
     if (lay.max != null && lay.pictures.length > lay.max)
       throw new Error(`${who} takes at most ${lay.max} picture${lay.max === 1 ? "" : "s"}; this run has ${lay.pictures.length} (${partsOf(lay)}): hide reference layers or turn Original off.`);
     return { req, notes: [] };
     ```
     `countWords` produces text like "the Original and 2 reference layers". `partsOf` lists "the crop, the mask, the Original, 3 reference layers".

2. **`electron/main/providers/index.js` `edit()`** (lines 86-122), after `req` is built (97-106) and after 26a1's layout call (called `lay` here):
   - `const chk = util.checkPictures(lay, req, p.label + " " + req.model)`.
   - When `chk.req !== req`, compute `lay` again from `chk.req`. Marker resolution (26a1) then runs against the stripped layout, so a marker for a dropped picture can never resolve.
   - Only `chk.req` is passed to the adapter. Pictures that are dropped are therefore never uploaded (Comfy Cloud uploaded unwired references before).
   - The success log (line 119) gets `pictures: lay.pictures.length, notes`. The return value (line 121) gets `notes: chk.notes`.
   - `kind: "text"` and `"upscale"` are skipped (26f extends this).

3. **`bfl.js`.** Add `layout()` (26a1 shape):
   - endpoint `flux-2-klein-*`: max **4**
   - `flux-2-pro|flex|max`: max **8**
   - `kind: "fill"` (flux-pro-1.0-fill): `drops: "FLUX.1 Fill takes no reference images"`
   - any other endpoint: max `null`

   In `bodyFor` (14-31), replace `slice(0, 7)` (line 23) with every picture, plus a guard that throws when the count is over `layout().max`. It can never trip after step 2, but it keeps the adapter safe when called directly.

4. **`fal.js` `inputFor`** (25-52): layout `drops` when `!(req.kind === "edit" || f.images)` (lines 34-40). This covers flux1_fill, Qwen inpaint, Z-Image turbo and Ideogram 4. `max` comes from `o.max_images`.

5. **`replicate.js` `inputFor`** (37-64): `drops` for `kind: "fill"` (54-57) and for `fields.image && !fields.images` (lines 47-53, Qwen Image Edit, crop only). In `recipes/qwen_image_edit.json`, `providers.replicate.note` currently says "crop plus the reference layers". Change it to say the reference layers are not sent.

6. **`wavespeed.js` `inputFor`** (56-81): `drops` for the fill branch (67-70). `max` comes from `o.max_images`.

7. **`comfycloud.js`.** Next to `SHAPES` (line 45), add `NODE_PICTURES`. Values are read from the local ComfyUI `comfy_api_nodes` source on 2026-09-29:
   - `Flux2ImageNode` 8 (nodes_bfl.py, "n_images > 8")
   - `GeminiNanoBanana2V2` 14
   - `OpenAIGPTImageNodeV2` 16 (`image_1..16`)
   - `ByteDanceSeedreamNodeV3` 10 for pro, 14 for lite (`max_ref_images`)
   - `QwenImageEditApi` 3
   - `GeminiImage2Node`, `GeminiImageNode`, `FluxProFillNode`: `drops` ("this node takes one picture" / "FLUX.1 Fill takes no reference images")

   Replace `.slice(0, 3)` (line 105) with a throwing guard. In `buildGraph` (134-135), upload only the references the shape wires. In `recipes/nano_banana_pro.json`, the `comfycloud` note contradicts itself ("the references are not sent" … "crop plus the reference layers"); drop the second half.

8. **`comfyrouter.js`.**
   - The layout of `bfl/flux-pro-1.0-fill` (dialect branch 332-338) declares `drops`. The strip in step 2 then makes `picturesFor` (200-232, default max 1 at 205) see the crop only. The run goes out, and the recipe note "The reference layers are not sent." becomes true. It does not refuse any more.
   - The vertexai layout counts the mask as a picture. `picturesFor` leaves it out (203-205), while the body sends it (303), so the old check allowed one picture too many.
   - `editPrompt` (237-244) becomes `util.instruction`.
   - vertexai `body` (290-314): the sentence (296-301) comes from `util.instruction`. The parts become `[{text}, …interleave(labelParts, [crop, mask?, …refs])]`.

9. **`gemini.js` `edit`** (19-64): the sentences (27-33) come from `util.instruction`. Parts (34-37) are text, then a label part and the picture for each one. The layout counts the mask picture only when `req.mask && req.kind !== "edit"`. `max` comes from `o.max_images` (set to 14 in step 14).

10. **`openrouter.js` `promptFor`** (273-282) becomes `util.instruction(req, module.exports.layout(req), text)`. `picturesFor` (216-250) keeps its own count check as a second line. The `promptFor` export (line 422) stays for Oxen.

11. **`oxen.js` `promptFor`** (276-279) calls `util.instruction` with Oxen's own layout. That layout has the mask picture only for a fill without `o.mask`, and `single` gives max 1.

12. **`ark.js` `promptFor`** (238-245) becomes `util.instruction`.

13. **`magnific.js`.**
    - `editPrompt` (177-184) becomes `util.instruction`; it is used in flux2 (360), seedream (383) and gpt (400).
    - Layout max comes from `ROUTES[r].maxImages` (81-102).
    - `expand` gets `drops: "Image Expand takes the picture alone"`, and the `ctx.log` line 341 goes.
    - `ideogram` gets `style: true` and max 11.

14. **`recipes/*.json` caps and notes.** Pictures include the crop. "Read" means read on 2026-09-29.

| Recipe / variant | `options.max_images` | Source |
|---|---|---|
| flux2_pro / flex / max · fal | 8 | fal pages name none; BFL API `input_image..input_image_8` (read) |
| flux2_pro / max · replicate | 8 | replicate.com model pages (read) |
| flux2_flex · replicate | 10 | replicate.com (read, "14 MB total") |
| flux2_pro / flex / max · wavespeed | **3** | WaveSpeed API docs, `images` "0 ~ 3 items" (read) |
| flux2_klein · fal | 4 | fal klein/9b/edit, "A maximum of 4" (read) |
| flux2_klein · wavespeed | 3 | WaveSpeed docs (read) |
| flux2_klein · oxen | 4 | BFL klein, `input_image_4` (read); Oxen's page answered 429, read it at build time |
| seedream_5_lite / pro · fal | 10 | fal: "only the last 10 are used" (read), which would drop the crop |
| qwen_image_edit · wavespeed | 3 | WaveSpeed docs (read) |
| gpt_image_2 · fal | 16 | fal page (read) |
| gpt_* · openai | 16 | OpenAI `image[]` |
| nano_banana_* · gemini | 14 | Google |

    Read at build time, and leave `null` plus a line in the undocumented list where a page names nothing: fal Nano Banana 2/Pro, fal Grok, Replicate Nano Banana/GPT/Seedream, WaveSpeed Nano Banana/GPT/Seedream/Reve, and the ToAPIs `gpt_image_2_5_flare/_sunburst` channels (they have no `max_images` at all; per channel through `channelOf`, `toapis.js:127-138`).

15. **`comfypartner.js` `editText`** (55-60) becomes `util.instruction` with `req.refName` from `hy_image_3_5.json` `refs.name: "Image {n}"`. `resolveRefs` (36-45, legacy `@ImageN`) stays, and so does `HY_MAX_IMAGES` (30) as the layout max.

16. **`inapp.js`** gets `drops: "LaMa fills from the picture alone"`. **`loopback.js`**'s layout honours `options.drops` and `options.max_images` (test hooks for the gate).

17. **`renderer/editor/host.js` `runProvider`** (1038-1085, or the run helper 26b puts there):
    - After the answered line (1079), append `res.notes.join(" ")`.
    - Add `notes: res.notes || []` to the return value (1084), so MCP `generate` reports it.
    - The "Sending … N references" line (1059) stays as it is; 26c's bar shows the drop before the click.

### Interfaces this step defines or consumes

**Consumes:**
- 26a1: `layout(req)` per adapter plus the index.js default, marker resolution, `req.original`, `req.refName`, `refs.name` in the recipes, and `tools/refs_layout_test.js` with its fake fetches.
- 26b: the run helper in host.js.

**Defines:**
- `util.refName`, `util.instruction`, `util.labelParts`, `util.checkPictures` (signatures above).
- The `provider:edit` result gains `notes: string[]`, and `runProvider`'s return gains `notes`.
- Clarified semantics of `layout.max`, `drops` and `style` (see "Contract changes").

### Edge cases

- **Original on, fill route.** The note counts it: "…; the Original and 2 reference layers not sent." The strip also sets `original: 0`, so the resolution never offsets by it.
- **Over the cap because of the Original.** The message ends "hide reference layers or turn Original off", as the adapters' messages do today.
- **ToAPIs channel switch.** The max follows the Channel row (`channelOf(req)`), both in `provider:layout` and at the send.
- **Comfy Router vertexai fill.** The mask now counts: Nano Banana with crop, mask and 13 references (15 pictures) was let through before and is refused now.
- **Gemini with one picture.** No label parts, so the request is shaped as today except for the wording.
- **HY with Original on.** Legacy `@Image2` still names the Original (as today). The sentence now says so ("Image 2 is Image 1 before …").
- **Empty user prompt.** `instruction` trims. A drop with no references visible produces no note.
- **Ideogram style references.** A marker is refused. Without markers they go as today, capped at 11.
- **Adapters called directly by tests.** Their own count checks (`ark.js:162`, `openrouter.js:220`, `oxen.js:202`, `toapis.js:264`, `comfyrouter.js:205`) stay and keep their wording. The central check runs first in the app.
- **Byte and pixel caps.** Replicate FLUX.2 pro allows 9 MP of input in total and flex 14 MB. They are not enforced (open point).

### Tests

**Tiers.** Light for the adapters (built against docs). Normal for the run path: one gate step on tiles, no canvas backend (no pixel path changes), no mutation round.

**Plain Node, `tools/refs_layout_test.js` (extends 26a1):**
- `refName` covers `{n}` and `{n0}`.
- `instruction` literals: 0-4 references; a mask picture; an Original; the HY pattern; `<image{n}>` (list form); `text` and `upscale` pass through; `style` gets no sentence.
- `labelParts` literals, and `[]` for one picture.
- `checkPictures`:
  - drops: the references are stripped, the note is exact, and a marker is refused;
  - over max: the message is exact and no fetch happens;
  - under max: the request is unchanged;
  - `style` with a marker is refused.
- Sweep over every provider edit variant of every recipe:
  - 0, 1 and 3 references, and max + 1;
  - either `drops` is set and the builder (fake fetch) sends crop (+ mask) only, or the builder sends exactly `lay.pictures.length` pictures, the same count and order;
  - max + 1 throws in `checkPictures`;
  - every variant has `max != null` or appears in the `UNDOCUMENTED` array the test keeps (mirrored in `docs/RECIPES.md`).
- BFL klein with 5 pictures is refused; BFL pro sends `input_image_8`.
- Comfy Cloud: `buildGraph` for `GeminiImage2Node` with references uploads one picture; for `QwenImageEditApi` with 4 pictures it throws.
- Gemini and vertexai parts orders (step 8/9 shapes).

**Adapter asserts to update** (new literals; the "2 references" cases become `Edit image 1 and keep its size and framing. a red door Images 2 and 3 are reference images.`):
- `tools/ark_test.js`: constants 43-45; checks 183, 197, 200.
- `tools/ark_test.py`: 51 (`EDIT_PREFIX`), 349, 351 (`"reference material"` becomes `"reference image"`).
- `tools/openrouter_test.js`: constants 33-36; checks 170, 185, 189, 232 (fill + 2 references becomes `… Images 3 and 4 are reference images.`), 236, 243.
- `tools/openrouter_test.py`: 398 (`startswith("Edit image 1. Image 2 is a mask")`), 428.
- `tools/oxen_test.js`: `FILL` / `EDIT` at 205-206, and their uses at 210, 212, 214, 216, 218, 220 (`+ " Image 2 is a reference image."`), 222, 226, 228, 244.
- `tools/oxen_test.py`: 334.
- `tools/comfyrouter_test.js`:
  - 519: vertexai fill with 1 reference; parts become text, `Image 1:`, CROP, `Image 2:`, MASK, `Image 3:`, REF1, and the regexes move to the new head and `Image 3 is a reference image`;
  - 530;
  - 537 (`c[2].text` regex);
  - 617 becomes `Edit Image 1 and keep its size and framing. put Image 2 on the table Image 2 is a reference image.`;
  - 622;
  - the sweep at 482 now also expects flux1_fill with one reference to go out (declared drop), not refuse.
- `tools/comfyrouter_test.py`: 551 (the prefix is unchanged, since HY with references keeps "Edit Image 1 …"; check the tail if it asserts it).
- `tools/magnific_test.js`: 328.
- `tools/magnific_test.py`: docstring 13 and check 403 (`startswith("Edit image 1")`).

**Gate step** in `commands` (`tools/commands_test.py`), with a loopback recipe through `host.setRecipe` (the `generate_test.py:21-40` pattern) and two visible reference layers:
- `refs_declared_drop`: `options.drops: "test drop"`. The loopback info's `references` is 0, the status holds "not sent", and the return value's `notes` has one entry.
- `refs_over_cap`: `options.max_images: 2`. Refused, the message holds "at most 2 pictures; this run has 3", and the loopback records no call.

**Commands:**
```
node tools/refs_layout_test.js && node tools/ark_test.js && node tools/openrouter_test.js && node tools/oxen_test.js && node tools/magnific_test.js && node tools/comfyrouter_test.js && node tools/toapis_test.js && node tools/recipes_test.js
bash tools/run_gates.sh refs-26a2 --offline --tiles on toapis openrouter ark comfyrouter oxen magnific recipes commands lint types
```
No `smoke`, and 8188 is not touched. `nodecopy` is not needed (no editor module changes; `host.js` is app-only).

### Docs

- **`docs/RECIPES.md`, new subsection** "### Reference pictures: order, caps and drops", between "How big the crop goes out" and "Transparent results" (line 208). It covers:
  - the layout;
  - `max_images` counting (crop, mask picture, Original, references; a mask field is not a picture);
  - refusal versus declared drop and the status note;
  - the one instruction with examples, and label parts;
  - the caps table with sources and dates;
  - the undocumented list.
- **`docs/RECIPES.md`, rewrites:**
  - ToAPIs: 483 and 511 (per-channel `max_images`, GPT 2.5);
  - OpenRouter: 630-636 (the sentences) and 702-705;
  - ModelArk: 983-988;
  - Comfy Router: the 1396 row (label parts), 1453 (flux1_fill declared drop, mask counted);
  - Comfy Partner: 1492-1502;
  - Magnific: 1588-1602, 1628 (Image Expand drop is declared, not a log line);
  - Oxen: 1793-1811 (klein 4).
- **`docs/BUGS.md`** 256-282: mark the provider items "fixed in 26a2 (date)". Leave the Klein-local, Info-panel and node-skip items for 26e and up/down for 26b.
- **`docs/TESTING.md`**: the new `refs_layout_test.js` sections and the two `commands` steps.

### Risks and open points

- **Wording change on a live-verified route.** OpenRouter GPT Image 2.5 ran live with the old sentences. The mask clause is kept verbatim, but "image 1 / Image 2 is a reference image" has not been run live, and no live check happens without the user's word.
- **The Original sentence is new model input.** It helps "fill the green area" edits. **Open for the user:** keep it (recommended) or keep calling the Original "reference material".
- **WaveSpeed FLUX.2 at 3 pictures.** Runs with Original plus 2 references are now refused where they went out before. That is correct by the docs, but the change needs a CHANGELOG line.
- **Caps are only as good as the pages.** fal's FLUX.2 pages name no cap (8 is BFL's own limit). Several variants stay undocumented and keep `max: null`: they can still drop silently on the host's side, and the undocumented list says so.
- **Byte and pixel totals** (Replicate 9 MP / 14 MB) are not enforced.
- **Dependency on 26a1's layout names and fake fetches.** If 26a1 put `max` reading elsewhere, steps 3-16 follow it.

### Contract changes

- **Addition to C3:** the `provider:edit` result and `runProvider`'s return carry `notes: string[]` (declared drops) for the status line and MCP.
- **Clarification of `layout`:**
  - `max` counts every picture the model sees: crop, mask sent as a picture, Original, references. A mask sent in its own field is not in `pictures`.
  - `drops` is all or nothing: no Original and no reference layer goes. A partial silent drop does not exist, and over the cap is always a refusal.
  - `style: true` lists style references with `role: "reference"` (counted against `max`), but no marker resolves to them.
- **Default `refName`** is `"image {n}"` when `req.refName` is missing.

### Estimate and commit message

About 1 day. Commit as DenRakEiw per CLAUDE.md, with no trailer:

`26a2 routes: every reference drop refused or declared, caps per variant and ToAPIs channel, one instruction numbered by layout, label parts for Gemini and vertexai`

Sources read 2026-09-29: [fal Seedream v5 lite edit](https://fal.ai/models/fal-ai/bytedance/seedream/v5/lite/edit/api), [fal Seedream v5 pro edit](https://fal.ai/models/bytedance/seedream/v5/pro/edit/api), [fal FLUX.2 klein 9b edit](https://fal.ai/models/fal-ai/flux-2/klein/9b/edit/api), [fal FLUX.2 pro edit](https://fal.ai/models/fal-ai/flux-2-pro/edit/api), [fal GPT Image 2 edit](https://fal.ai/models/openai/gpt-image-2/edit/api), [BFL FLUX.2 editing](https://docs.bfl.ai/flux_2/flux2_image_editing), [BFL FLUX.2 pro reference](https://docs.bfl.ai/api-reference/models/generate-or-edit-an-image-with-flux2-%5Bpro%5D), [BFL FLUX.2 flex reference](https://docs.bfl.ai/api-reference/models/generate-or-edit-an-image-with-flux2-%5Bflex%5D), [BFL klein 9B KV](https://docs.eu.bfl.ai/api-reference/models/generate-or-edit-an-image-with-flux2-%5Bklein-9b-kv%5D) (via search), [Replicate FLUX.2 pro](https://replicate.com/black-forest-labs/flux-2-pro), [Replicate FLUX.2 flex](https://replicate.com/black-forest-labs/flux-2-flex), [Replicate FLUX.2 max](https://replicate.com/black-forest-labs/flux-2-max), [WaveSpeed FLUX.2 pro edit](https://wavespeed.ai/docs/docs-api/wavespeed-ai/flux-2-pro-edit), [WaveSpeed klein 9b edit](https://wavespeed.ai/docs/docs-api/wavespeed-ai/flux-2-klein-9b-edit), [WaveSpeed Qwen edit plus](https://wavespeed.ai/docs/docs-api/wavespeed-ai/qwen-image-edit-plus), and the local ComfyUI `comfy_api_nodes` (nodes_bfl.py, nodes_gemini.py, nodes_bytedance.py, nodes_openai.py, nodes_qwen.py).

## 26c: The rich prompt field, the @ picker and the reference bar

**26c1 built (2026-09-29, S3).** `renderer/editor/prompt_field.js` (in the node's `FILES`): the pure helpers of sub-task
1 (`sanitize`, `atWordStart`, `unitBefore` / `unitAfter`, `EditHistory`, `chipState`, `renderPlan`; `mapOffset` /
`diffRange` re-exported from `reftokens.js`) and `PromptField` (sub-tasks 2-8: the chip DOM with guards and the trailing
`<br>`, a shape check so a native edit that typed into a run is not drawn anew, `domToOffset` / `offsetToDom`, the
textarea API on the element, the own undo, composition). The editor: `buildPrompt` builds it when `host.refTokens`;
`setPromptText(text, {keepCaret, history})`; `refContext()` and `refAvatar(layer)` (a 32 px data URL kept for the pixels
and live mask it was drawn from, through `WeakRef`s, and dropped in `markLayerChanged` / `markMaskChanged` /
`redrawThumbsOf`, which also calls `updateThumbs`); `renderReferences` ends with `refresh()`; `_docKey`, the root click
and the paste handler know a contenteditable; `close()` / `destroy()`. `assistant.js` `wants()` takes a contenteditable,
`assistant_turns.js` counts paste and drop. **What the code showed against the text above:** Chromium gives a
`plaintext-only` field no `getTargetRanges()` for deletes, so every delete is controlled (sub-task 4's native delete
path is gone; word and line deletes use the Windows rules on the string); `innerText` breaks lines around flex items, so
the chip is `inline-block`. **Decisions the plan did not have:** a word typed against a chip gets a space (C1 makes
`x@img1` plain text, and the chip would turn into text and back at every letter), a space typed there steps over it,
and the lone space between a chip and a word is stepped over by Backspace / Delete instead of deleted (a longer delete
leaves one space); a press on a chip puts the caret beside it (the browser left it in the chip's label, where no key
reaches the field); a chip has a `title` with its reason until 26c2's hover card; chips are not draggable yet (26c2);
`setText`'s `"reset"` and remap reach the field's undo even when the text stays the same, and `refsMutated` passes its
remap whenever the field exists; writes during a composition are replayed in order at its end (`pendingValue()` is what
`value` reads meanwhile). Node stub: none needed (no shared code calls `host.refLayout` yet; it comes with 26c2's
`refreshRefLayout`). Tests: `tools/prompt_field_test.js` (164 checks), the editor gate's five `prompt_field_*` steps
(`tools/prompt_field_steps.py`, real CDP input), gates `--offline --tiles on` green (editor, commands, assistant,
canvasonly, llm, document, lint, types, nodecopy). A review (three reviewers, a skeptic per finding) confirmed ten of
eleven findings, seven distinct, all fixed with a gate check each: a chip formed around the caret sent the DOM caret to the field's start (the
render now snaps the selection, to the chip's end after typing), a click on a chip left the caret in its label, the
undo missed remaps that left the text alone, writes during a composition, a delete gluing a word to a chip, the
thumbnail cache on mask changes and rotations, and a probe that asserted nothing; a mutation of the render snap turns
`prompt_field_types_deletes_and_moves_over_chips` red.

**26c2 built (2026-09-29, S3; the user's go: "baue weiter").** In `prompt_field.js`: the pure `pickerRows`, `barCount`,
`cardLine`, `imageFiles`, `chipState`'s states `over` (a descriptor past the cap, `--sc-warn` edge) and `none` (the recipe
sends no reference: struck through); `PromptField`'s picker session (`afterEdit` from the input event of either path, native
or controlled; `openPicker` / `followSession` / `endSession` / `pickItem`; the @word drawn as text through `open` while the
session runs), `replaceWith` / `removeToken` / `insertToken` (one field-undo step each, spaces so a token stays a token),
`chooseFiles` / `addReferences` (the session survives the file dialog and the load), the hover card (`hoverStart` /
`hoverEnd` / `showCard`, 400 ms, a 120 ms grace to reach the card), the swap menu (`openSwap`; it follows its chip through a
remap), the chip drag by the pointer (`chipDrag`, `pointOffset`, a drop caret, `moveRange`), HTML5 drops of selections
(move; Ctrl copies) and of pictures, image paste; classes `RefPicker` (no focus of its own: its keys come from the field's
keydown; closed by a press outside; placed below the line, above when under 200 px are free, clamped to the popup root)
and `RefBar` (mounted as `.ipc-prompt`'s first child; a signature so it redraws only on change). In the editor:
`refContext` gains `cap`, `none`, `local`, `refuse`, `show`; `refDescriptors` gains `over`; `showReference(id)` (the eye's
path), `refreshRefLayout()` (120 ms debounce and its own sequence; from `renderInfo`, `renderReferences`, `renderSettings`
and the settings row `commit`), `addReferencesForPrompt(files)` (never a base: "Load an image first"), `refPreview(id,
canvas)`; the Escape capture closes the field's popup first; CSS for `.ipc-refbar`, `.ipc-refpop`, `.ipc-refcard`, the drop
caret. `host.refLayout(editor, over, {keep})` returns `cap` (the route's `max` less the crop, a mask sent as a picture and
the Original) and `refuse` (a route of style references), and only a `keep` call (the editor's) writes `refLayoutInfo`,
by the last call made; `status` reads with `keep: false`. The node repo: the stub `async refLayout() { return null; }`
(commit "host.js: refLayout stub for the app's reference tokens").
**Decisions the plan did not have** (the user agreed to the first, the drag by the pointer and the bar wrapping onto a
second line in a narrow panel, 2026-09-29): on a ComfyUI recipe (until 26e) a chip stays live and the card and the bar's title
say the token refuses (`refuse`), rather than striking through pictures that do go in the batch; the same for a route of
style references; a pick replaces the @ and what the session typed, never a word or chip that stood after the @ when it was
typed (`tail`), and with no reference listed Enter and Tab do what they do without the list (the cursor starts on the
first reference, "+ Add reference" only by the arrows or the mouse); the mouse picks a row only when it really moves (a
list opening under a resting pointer keeps its first row); a chip is dragged by the pointer, not by the browser's drag and
drop (a press on a chip must stay cancelled to keep the caret out of its label); an edit made while the field has no
focus (a bar click, the swap menu, a drop) fires `change` at once, since no blur would report it; a paste of pictures,
a drop and "+" all go through `addReferences`, which takes the focus back only when nobody took it meanwhile. **C4 changes:** `RefContext` gains `local`, `refuse`, `show(id)`; `Descriptor` gains `over`;
`host.refLayout` gains `{keep}` and the answer `cap` and `refuse`. Tests: `tools/prompt_field_test.js` section 8 (192
checks in all), the editor gate's `tools/ref_picker_steps.py` (five steps) and the two 26c1 steps adjusted (the chip has no
`title`, its reason is `data-reason`; the chevron opens the swap menu, the first Escape closes it). A review (three
reviewers, a skeptic per finding) confirmed 14 of 17 findings (13 distinct), all fixed; `ref_picker_keeps_what_stood_there`
holds the ones a gate can show (an @ before a word or a chip, Enter with nothing listed, a move in front of a chip, a
swap menu under a remap, the change of an unfocused edit).

### Read first: corrections from the review (they win over the text below)

- Schedule: S3 = 26c1 + 26c2. **After 26c1 the user looks at the field in the app** (a screenshot of chips, caret and
  a hidden reference's inactive chip) and says go before 26c2 is built.
- API per C4: add `preview: (id, canvas) => void` (the hover card draws through it); `new RefBar(field, {mount})`;
  every popup clamped to `popupRoot`; the chevron, the bar chips and "+" are `type="button"`.
- Sub-task 15: `host.refLayout` is built in 26b2 (C3). This step caches it as `ed.refLayoutInfo` (debounce, sequence
  number, the refresh triggers listed) and reads `names` and `over` from it; drop the own `cap` arithmetic. The node
  stub `async refLayout() { return null; }` is committed to the node repo in 26c2, with `refreshRefLayout` (C6).
- `mapOffset` lives in `reftokens.js` (C1); `prompt_field.js` imports it.
- `canAdd` ("disabled without a base image") is flipped by 26f (true in an empty tab when `host.refTokens`).
- The open points of this step are decided by section 7's defaults; "the session order" is section 5.

### Goal and done when
When `host.refTokens` is on (26b), the editor prompt becomes a contenteditable built by `PromptField` (`renderer/editor/prompt_field.js`), made to work like Magnific's. The text is still a plain string with `@img<n>` / `@img?<id>` tokens (C1). Each token is drawn as an atomic chip: a 16 px round thumbnail, the label and a chevron. The node (`refTokens` false) keeps today's textarea (`inpaint_modal.js` `buildPrompt` 757-768). The negative prompt stays a textarea.

Done when:
- `ed.promptInput` is the contenteditable. It answers `value`, `selectionStart/End`, `setSelectionRange`, `placeholder`, `disabled`, `input` / `change` and focus like the textarea (C4). Every current user (sub-task 11) works, either unchanged or with the one-line fix named there.
- The following behave as listed in sub-tasks 4-7: typing, dead keys and IME, Enter, paste, copy and cut, Backspace / Delete, arrows, Ctrl+Z / Y, Ctrl+Enter, Ctrl+U and Escape. A chip is never split or partly deleted.
- Typing `@` at a word start opens the picker. Enter or Tab inserts. "+ Add reference" adds a picture and inserts its token. Esc closes the picker before anything else.
- Chips show the states live, inactive, broken and over. They have the 400 ms hover card ("img2 · sent as image 3") and the swap menu. The bar above the field shows the references, a "+" and the count against the recipe, taken from `provider:layout`.
- The gates under Tests are green.

**Split: yes.**
- **26c1** is the field core (sub-tasks 1-12).
- **26c2** is the picker, the bar, the hover card, the swap menu and the layout (13-20).
- Suggested sessions: 26a1+26b, **26c1+26c2**, 26a2+26d1, 26d2+26e, 26f. 26a2 does not touch the field, and the two halves of 26c share one context.
- If the given order must stay: 26a2+26c1, 26c2+26d1, 26d2+26e, 26f.

### Sub-tasks in build order

**26c1: the field core**

1. **Pure helpers in `prompt_field.js`.** Nothing touches `document` or `window` at import time, so `tools/prompt_field_test.js` can import the file in plain Node (the `liquify_test.js` pattern).
   - `sanitize(text)`: CRLF and CR become LF. U+200B is removed, because the field uses it for its caret guards. Then C1 `normalize`.
   - `diffRange(a, b) -> {start, endA, endB}` works by common prefix and suffix. `mapOffset(off, a, b)`: an offset before the change stays, one after it shifts, one inside it goes to `endB`. This is what `keepCaret` means. When a remap turns `@img2` into the longer `@img?L1k3`, the caret stays after the same word, not at the same number.
   - `atWordStart(text, i)`: true at i = 0 or after whitespace or one of `( [ { " ' „ “ ‚ «`. So `mail@x` never opens the picker.
   - `unitBefore(text, caret, segs)` / `unitAfter(...)` return the range that Backspace, Delete or an arrow crosses. That is a whole token where one ends or starts, otherwise one grapheme (`Intl.Segmenter`).
   - `class EditHistory` stores entries `{text, start, end}`, capped at 200.
     - `record(prev, next, kind)` merges consecutive typing of one kind within 1 s with no caret jump, and breaks at whitespace (word steps, like a textarea).
     - `undo(cur)`, `redo(cur)`, `reset(entry)`.
     - `map(fn)` rewrites every entry and maps its caret with `mapOffset`.
   - `chipState(seg, ctx) -> {state, label, reason, ref}`:
     - `@img<n>` that a descriptor holds → live, label `img<n>`.
     - `@img<n>` that no descriptor holds → broken, reason "no reference img<n>".
     - `@img?<id>` whose descriptor exists (a hidden reference) → inactive. The label is the layer name, cut to 14 characters. Reason: "hidden: show it under References to send it".
     - `@img?<id>` with no descriptor → broken, label `img?`, reason `ctx.reason(id)` ("deleted" / "no longer a reference").
   - `renderPlan(text, ctx, open)` runs C1 `parse(text)`. A token that overlaps the open range `open = [s, e]` stays text. The open range is the token being typed: the one the last native `insertText` extended and whose end is the caret. In 26c2 the picker session provides it. So typing `@img1` and then `2` gives `@img12`, not a chip followed by "2".

2. **DOM model (`PromptField` constructor, `render()`).** The structure is Magnific's, with our own attribute prefix (`fri` is Freepik's):
   ```html
   <div class="ipc-pf" contenteditable="plaintext-only" role="textbox" aria-multiline="true"
        spellcheck="false" autocorrect="off" autocapitalize="off" translate="no">
     "the jacket from "
     <span class="ipc-chip" contenteditable="false" draggable="true" data-sc-mention-key="L1k3"
           data-sc-trigger="@" data-sc-mention-type="img" data-sc-mention-avatar="data:image/png;…"
           data-token="@img2" data-state="live" aria-label="reference img2, jacket">
       <span class="ipc-chip-at">@</span><img class="ipc-chip-av" alt=""><span class="ipc-chip-label">img2</span><button class="ipc-chip-chev" tabindex="-1" aria-label="Swap">▾</button>
     </span>" on the model\n"<br data-trail>
   </div>
   ```
   - Line breaks are `\n` inside text nodes (`white-space: pre-wrap`), never `<div>` lines.
   - Where no text stands next to a chip (start of the content, after `\n`, between two chips, end of a line or the content), a text node holding one U+200B guards it, so Chromium can put the caret there.
   - `<br data-trail>` is added only when the text ends in `\n` or is empty.
   - `plaintext-only` is a safety net: Ctrl+B and Ctrl+I do nothing. The field still handles every structural edit itself (sub-task 4).
   - The "@" stays in the DOM but is visually hidden (clip, 0 width) rather than `display:none`, so `innerText`, CDP page text and screen readers read `@img2`.
   - The chevron is drawn in 26c1 and does nothing until 26c2.
   - `render()` rebuilds the children (short text, microseconds), records `runs = [{node, start, end, kind}]`, and puts the caret back when the field has the focus.

3. **Serialization and caret mapping.**
   - `serialize()` walks the children:
     - A text node gives its text without U+200B.
     - A chip gives its `data-token`.
     - `br[data-trail]` gives "". Any other `br` gives "\n".
     - Any other element, which only a native edit can leave behind, gives its children, with a `\n` before a `div`. It also sets `dirty`, so the next input re-renders.
   - `domToOffset(node, o)`:
     - In a text run: `start` plus the characters before `o` that are not U+200B.
     - `(root, i)`: the start of child i.
     - A point inside a chip: its start when `o` is 0, else its end.
   - `offsetToDom(off)` picks the text run that holds the offset. For an offset at a chip's end it prefers the guard after the chip.
   - `selectionStart/End` read `getSelection()` while the selection is inside the field. Otherwise they return the saved `this.sel`: a textarea also keeps its selection when blurred. A `selectionchange` listener, added on focus and removed on blur, keeps `this.sel` current.
   - `setSelectionRange(s, e)` stores the range and applies it to the DOM **only when the field has the focus**. Placing the document selection inside a contenteditable focuses it, which would take the focus from the assistant's chat during an MCP `set_prompt`.

4. **Input: native for plain typing, controlled for structure.**
   ```js
   onBeforeInput(e) {
     if (e.inputType === "insertCompositionText") return;          // not cancelable (6)
     const [s, t] = this.modelSel();
     if (e.inputType === "insertText" && s === t && this.inTextRun(s) && !this.dirty) return;   // native
     if (/^delete(Content|Word)/.test(e.inputType) && this.plainRange(e)) return;             // native
     e.preventDefault();
     // insertText / insertReplacementText: replace [s,t] with sanitize(e.data)
     // insertParagraph / insertLineBreak: "\n"
     // deleteContentBackward / Forward: unitBefore / unitAfter (a whole token)
     // deleteWord* / deleteSoftLine* / deleteHardLine*: getTargetRanges() mapped, widened to whole tokens
     // deleteByCut: cut; deleteByDrag: nothing (26c2 moves on drop); historyUndo / Redo: 5; format*: nothing
     this.apply(next, caret, kind);   // history.record, render, caret, dispatch new InputEvent("input", {bubbles, inputType, data})
   }
   onInput(e) {                       // after a native edit; also accepts a plain Event with no inputType (assistant_test 1348)
     if (e.isComposing) return;
     const next = this.serialize(); this.history.record(this.text, next, "type"); this.text = next;
     if (this.dirty || this.tokensDiffer(next)) this.render(); else this.rewalkRuns();
   }
   ```
   - `plainRange(e)` is true only when the range lies inside one text node, holds no U+200B, and `unitBefore` / `unitAfter` is not a token. Otherwise a Backspace right after a chip would only eat the invisible guard.
   - `paste` fires before any `beforeinput`: the field calls `preventDefault` + `stopPropagation`, inserts `sanitize(text/plain)` over the selection, and tokens in it become chips. Image files are ignored in 26c1, as the textarea ignores them (see 20).
   - `copy` / `cut` write `text.slice(s, e)` as `text/plain`, so a chip copies as `@img2` whatever the hidden "@" does.

5. **Own undo and redo.**
   - Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z are handled in the field's keydown (`preventDefault`), and `historyUndo` / `historyRedo` in `beforeinput`.
   - The native undo stack is never used: it does not survive `render()`.
   - An empty stack does nothing. Ctrl+Z in the field never reaches the editor's undo, as today.

6. **Composition.**
   - `compositionstart` sets `composing`. While composing there is no render, no normalisation and no picker.
   - A keydown with `isComposing` or keyCode 229 is left alone, so the Enter that commits a candidate inserts no line.
   - `compositionend`: `serialize`, record, render if needed, caret.
   - A `setText` that arrives mid-composition is queued until `compositionend`.
   - Dead keys (´ ` ^ on the German layout) may arrive as a composition. Both paths are tested.

7. **Keys.** The keydown handler from `inpaint_modal.js` 762-767 stays: `stopPropagation`; Escape blurs the field and focuses `ed.root`; Ctrl+Enter calls `generate`; Ctrl+U calls `upsamplePrompt`. Added:
   - Enter and Shift+Enter insert `\n` (controlled).
   - ArrowLeft / Right (with or without Shift) are moved by the field through `unitBefore` / `unitAfter` when the step crosses a chip or a guard.
   - Up, Down, Home, End and Ctrl+arrows stay native. `selectionchange` then snaps a caret that lands between a guard and its chip.
   - "Ctrl" is `(ctrlKey || metaKey) && !altKey`. AltGr+Q, which types `@` on the user's keyboard, arrives with Ctrl and Alt set and is typing, not a shortcut.
   - Tab stays native (it leaves the field).

8. **Element API** (`Object.defineProperties` on `el`, C4).
   - `value` get returns `this.text` (while composing, `serialize()`).
   - `value` set is `setText(v, {history: "push"})`. It is a no-op when the text is unchanged, because `open()` writes the same text at 2598 on every open.
   - `placeholder` becomes `data-placeholder`, shown by `.ipc-pf-empty::before`. `disabled` turns contenteditable off and sets `aria-disabled`.
   - `input` fires for every user edit: the native one is trusted, a controlled one is a synthetic `InputEvent`.
   - `change` fires on blur when the text differs from what it was at focus. A programmatic write fires neither, as with a textarea.
   - `setText(text, {keepCaret, history})`, where `history` is:
     - "push" (the default): Upsample, Revert and `set_prompt` each become one step of the field's undo.
     - "reset": document open and snapshot restore.
     - a text→text function: the 26b remap, applied through `history.map(fn)` without adding a step.

9. **CSS** goes into `STYLE` (`inpaint_canvas.js` 1239), next to `.ipc-prompt textarea` (1425-1428). It uses only `--sc-*` variables the skins already use.
   - `.ipc-pf` looks like the textarea (`--sc-field`, `--sc-fg`, `--sc-line`, `--sc-radius`, `--sc-font`) with `min-height:80px; resize:vertical; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; line-height:22px`, so a 20 px chip does not stretch its line. `:focus` gets the `--sc-active` border.
   - `.ipc-chip` is inline-flex and 20 px high, using `--sc-btn` and `--sc-line`, with `--sc-btn-hover` on hover.
   - `.ipc-chip-av` is 16 px with `border-radius:50%; object-fit:cover`. The label has a 14ch ellipsis.
   - States: `[data-state=inactive]` is struck through at opacity .7; `[data-state=broken]` is struck through in `--sc-error`; `[data-state=over]` has a `--sc-warn` border.
   - `.ipc-chip.ipc-in-sel` gets an `--sc-active` outline when the chip is inside the selection (set on `selectionchange` through `containsNode`), because `::selection` does not paint it.

10. **Editor wiring.**
    - `inpaint_modal.js` `buildPrompt`:
      ```js
      if (host.refTokens) {
          ed.promptField = new PromptField({
              placeholder: "Describe the change. Type @ to name a reference image.",
              refs: () => ed.refContext(), popupRoot: ed.root,
              addReferences: (f) => ed.addReferencesForPrompt(f),
          });
          ed.promptInput = ed.promptField.el;
      } else { /* the textarea, as today */ }
      ```
      Listeners 760-767 attach in both cases.
    - `inpaint_canvas.js`:
      - `refContext()` returns the descriptors (C4) for every reference layer in list order, hidden ones included. `label` comes from `labelMap(this.referenceLayers())` (26b).
      - `thumb` is `refAvatar(layer)`: a 32 px cover-cropped PNG data URL drawn through `drawLayerFitted` (12127) and cached as `layer._refAvatar`. The cache is cleared in `markLayerChanged` (11210) and in `redrawThumbsOf` (12156, where tile mips land); the latter also calls `promptField.updateThumbs([id])`, which swaps the `<img>` source without a render. A 32 px canvas stays in software, so this is no GPU readback.
      - `renderReferences` (13825) ends with `this.promptField && this.promptField.refresh()`, which re-renders only when a chip's state, label or thumbnail changed.
      - `setPromptText` (26b) calls `promptField.setText(text, opts)`. The remap sites pass `history: (t) => remap(t, before, after)`; `setValue` (16372) and `applySnapshot` (10861-10864) pass `"reset"`.
      - `_docKey` 2557: `inField` is also true for `t.isContentEditable`.
      - Root click 2652-2656: `!t.closest("input, select, textarea, [contenteditable]")`, so a click on the chevron does not pull the focus away.
      - Paste 2667: `this.promptInput && this.promptInput.contains(e.target)`.
      - `close()` (2611) calls `closePopups()`. `destroy()` (16754) calls `promptField.destroy()`, which drops the `selectionchange` listener and the timers.

11. **The other users of `ed.promptInput`:**
    - `inpaint_canvas.js` 2598, 9816 / 9831 / 9836 (select by text), 9971 / 9976 / 10002 / 10009 / 10017 / 10018 (upsample, revert), 10863 and 16373: work through `value`.
    - `commands.js` 553 and 645: work through the setter.
    - `assistant_wait.js` 51: works, because the focused element and the `input` target are both the editing host.
    - `assistant.js` 338-342 `wants()`: **add `node.isContentEditable`**. Without it the chat pulls the focus back from the prompt (`assistant_test.py` 842-844, `fieldKept`).
    - `assistant_turns.js` 129: add `"paste"` and `"drop"` to the trusted event types. A controlled paste cancels the native input, and a file dropped from Explorer brings no pointerdown inside the editor.
    - `shell.js` 2268 already skips contenteditable elements. `editorHasEscape` (2167) needs nothing, since a blur closes the popups.
    - `assistant_test.py`:
      - 386: a focusable element, it passes.
      - 842-845: passes once `wants()` is fixed.
      - 1337-1349: sets `value` and dispatches a plain `Event("input")`; `onInput` accepts it.
    - `canvasonly_test.py` 261-269: Tab is handled by shell 2268.
    - `smoke_test.py` 86, 155 and 160 use the setter and getter. `smoke` is not run, because 8188 is the production machine.

12. `tools/build_node.py` FILES (39-45): add `"prompt_field.js"` (26b adds `reftokens.js`).

**26c2: picker, bar, hover, swap**

13. **`RefPicker`** follows the TipPicker pattern (`inpaint_tippicker.js` 198-294): an absolute popover in `ed.root`; pointer, click and wheel events stopped; `mousedown` `preventDefault`; an outside `pointerdown` on the window closes it; `place()` clamped to the root. It is styled as `.ipc-refpop`, like `.ipc-tippop` (1349-1353).
    - Unlike the tip picker it has **no search input of its own.** The query is what is typed after the `@`, and the header shows it.
    - It opens from the field's `input` event when `inputType === "insertText"`, `data === "@"`, not composing and `atWordStart`. It never opens from keydown or a paste. The session is `{start}`.
    - Query = `text.slice(start + 1, caret)`. The session ends when the caret leaves that range, the `@` is deleted, whitespace is typed, or the field blurs.
    - Rows: the visible references (24 px avatar, `img2`, the layer name, `sentAs`, an "over" tag), filtered by every word of the query against `img<n>` and the name. Then "+ Add reference", disabled without a base image ("Load an image first"). A note "N hidden references are not listed" appears when there are any. Footer: "↑↓ Navigate · ⏎ Insert · Esc Close".
    - Keys, handled first in the field's keydown: ↑ / ↓ move with wrap; Enter and Tab insert.
    - Escape goes to the capture handler at 2558-2560. Before `t === this.promptInput`, add `if (this.promptField && this.promptField.popupOpen()) { e.stopImmediatePropagation(); e.preventDefault(); this.promptField.closePopups(); return; }`.
    - Inserting replaces `[start, caret)` with `@img<n>` and a space, unless whitespace already follows. It is one history step.
    - Anchor: `getClientRects()[0]` of a collapsed range at `start`, falling back to the field's rect. The picker opens below the line, or above when less than 200 px are free below.

14. **"+ Add reference"** calls `ed.addReferencesForPrompt(files)`, which follows the `commands.js` 451-454 pattern: collect the layer ids, `await addImageLayers(files, "reference")`, find the new reference ids, read their labels after 26b's remap of the add, and put their tokens in the session's range.
    - The picker's own hidden file input uses the same `accept` as `inpaint_modal.js` 396. It keeps the session open through the dialog; its `cancel` event closes the picker and leaves the `@`.
    - Gates call `addReferences(files)` directly (there is no OS dialog in a gate).

15. **Layout.** `host.refLayout(editor)` (app side, next to `runProvider`):
    - It builds `{provider, model, kind, fields, options, params: providerParams(editor), fill, original, count, refName}` with the same helper 26b's run helper uses for the request. If 26b did not already factor `requestShape()` out of `runProvider` (1060-1065), this step does.
    - `original` = there is a selection, fill is not none, and `withOriginal` is on (`stitch.js` 458-459). `count` = `original` + the visible references.
    - The answer is cached under the shape's JSON. `window.scumble.providers.layout(shape)` (26a1) → `{cap, none, names: Map<layerId, string>}`, where:
      - `cap` = `max` minus the pictures that are not references;
      - `none` = `drops`, or "This recipe sends no reference images" when `r.edit === false`.
    - A comfy recipe answers `{local: true}`; 26e adds its names.
    - `ed.refreshRefLayout()` is debounced by 120 ms; a sequence number drops stale answers. It is called from:
      - `renderInfo` (13211), which covers the recipe through `applyRecipe` (939), the selection and the crop settings (880-921);
      - `renderReferences`;
      - the settings row `commit` (16048), which covers a ToAPIs channel.
    - In the node: `async refLayout() { return null; }`, plus a typedef line in `host.js` 170-211.

16. **States and the hover card.**
    - `chipState` gains two more states:
      - over: the label is above `cap`; `--sc-warn`, reason "this recipe takes {cap} reference images".
      - none: inactive, with the recipe's reason.
    - The hover card `.ipc-refcard`:
      - `pointerenter` on a chip or a bar chip starts a 400 ms timer. Leaving for something that is neither the chip nor the card cancels or hides it. No card appears while a button is held or a popup is open.
      - It shows a 160 px thumbnail (`drawLayerThumb` 12096, drawn into a canvas at device pixel ratio), the layer name, and "img2 · sent as image 3" or the state's reason.
      - The card is the tooltip; there is no `title`, which would double it.

17. **Swap menu.** The chevron's `mousedown` calls `preventDefault` and its `click` calls `stopPropagation`. It opens a `RefPicker` in swap mode under the chip:
    - the other live references;
    - "Show <name>" for a hidden reference, which goes through the eye's path (`renderReferences` 13838), the 26b show site that un-parks the token;
    - "Remove from prompt".

    A pick replaces exactly that token, as one history step.

18. **`RefBar`** (`.ipc-refbar`) is the first child of `.ipc-prompt`.
    - One chip per reference in list order. Hidden references are dimmed, have the eye-off icon, cannot be inserted, and the hover card says why.
    - A "+" chip does the same as sub-task 14.
    - The count on the right: "2 of 4 for this recipe", "2 reference images" (no cap declared), "This recipe sends no reference images", or "2 in crop_image" (local recipe). Chips past the cap show the warning.
    - A click inserts at the saved caret (at the end if the field was never focused) and focuses the field. `mousedown` `preventDefault` and `click` `stopPropagation` keep root click 2655 out.
    - `refresh()` redraws it.

19. **Chip drag.** This is the last sub-task and the first to cut when short of time.
    - `dragstart` on a chip or a selection records the model range and sets `text/plain` and `application/x-scumble-range`.
    - `dragover` shows a drop caret (`caretPositionFromPoint`, with `caretRangeFromPoint` as fallback).
    - `drop` calls `preventDefault`. An internal range is moved as one step; text from outside is inserted.
    - `beforeinput` `deleteByDrag` is always cancelled, so the browser never deletes the source on its own.

20. **Images pasted or dropped into the field** (open point 1). Recommended: image files become references through sub-task 14, and their tokens land at the caret or drop point.

### Interfaces this step defines or consumes
**Defines:**
- `PromptField({placeholder, refs, popupRoot, addReferences})` with:
  - `.el`, `setText(text, {keepCaret, history})`, `refresh()`, `updateThumbs(ids)`;
  - `insertToken(n, {replace})`, `addReferences(files)`;
  - `popupOpen()`, `closePopups()`, `undo()`, `redo()`, `destroy()`.
- `RefBar(field)`.
- The helpers `sanitize`, `diffRange`, `mapOffset`, `atWordStart`, `unitBefore`, `unitAfter`, `EditHistory`, `chipState` and `renderPlan`.
- On the editor: `ed.promptField`, `ed.refContext()`, `ed.refAvatar(layer)`, `ed.refreshRefLayout()`, `ed.refLayoutInfo` and `ed.addReferencesForPrompt(files)`.
- `host.refLayout(editor)`.

`RefContext = {refs: Descriptor[] (C4, hidden ones included with label null), cap: number|null, none: string|null, canAdd: boolean, reason(id): string}`.

**Consumes:**
- C1 `parse`, `normalize` and `labelMap` (26b);
- `setPromptText` and `host.refTokens` (26b);
- `provider:layout` through `window.scumble.providers.layout` (26a1).

### Edge cases
- **Hidden reference:** its token is parked by 26b; the chip is inactive and shows the layer name. **Deleted reference:** broken, `img?`. After an undo of the delete, 26b un-parks the token and `refresh()` makes the chip live again.
- **A reference without pixels** is not in `labelMap` (`referenceLayers` 3191-3193), so it behaves like a hidden one.
- **A remap during a picker session** maps `session.start` through `mapOffset`. **A remap during a composition** is queued (sub-task 6).
- **Ctrl+Z after a remap** gives the mapped older text, never a stale `@img2` that now means another picture.
- **Selections across chips:** typing over a selection that includes chips is controlled and replaces it whole. So does Ctrl+A followed by typing.
- **Caret positions near chips:** a chip at the start of a line, two chips side by side, and a trailing `\n` all keep a reachable caret (guards and the trailing `br`).
- **Picker availability:** the Prompt `<details>` collapsed or the Generate tab hidden means no focus, so no picker. "+ Add reference" is disabled without a base image, because `addImageLayers` would otherwise turn the file into the base.
- **Narrow side panel:** chips do not wrap, labels get an ellipsis, and popovers are clamped inside `ed.root`.
- **Tab switch or tab close with a popup open:** the blur or `close()` closes it. `closed_tabs_are_collected` in the editor gate catches a listener that outlives its editor.
- **A 10k-character paste** is one render, a few milliseconds.
- **Case:** `@IMG2` typed or set becomes `@img2` (C1 `normalize`). `setPromptText` normalises before it sets `promptText`, so `promptText` and `value` never differ.
- **Negative prompt:** tokens there stay plain text.

### Tests
Tier **normal** (a feature on the tiles backend, and the existing gates it touches); the plain-Node helpers are **light**. There is no pixel path, so no canvas-backend run, no mutation round and no screenshot gate. The user judges the look by eye.

- `node tools/prompt_field_test.js` checks:
  - `sanitize` with CRLF and U+200B;
  - `mapOffset` for an offset before, inside and after a change;
  - `EditHistory` merging, undo / redo, `map` and `reset`;
  - `atWordStart` for start of text, after a newline, after `(` and after `mail`;
  - `unitBefore` / `unitAfter` over tokens and emoji;
  - `chipState` for each state;
  - `renderPlan` with an open range.

**Editor gate steps**, using real CDP input (`Input.insertText`, `Input.dispatchKeyEvent`, `Input.imeSetComposition`, `Input.dispatchMouseEvent`) and two references added through `__cmds` `add_image_layer`:

26c1:
- **`prompt_field_is_the_textarea_for_every_reader`**
  - `promptInput.isContentEditable`.
  - Setting `"a @img1 and @IMG2\nb"` reads back as `"a @img1 and @img2\nb"`, with two chips and their `data-token`s.
  - The `.ipc-chip-at` has zero width while `innerText` still contains `@img1`.
  - A parked hidden reference gives `inactive` with its layer name; `@img9` gives `broken`; empty text gives `ipc-pf-empty`.
  - After `.focus()`, `document.activeElement === ed.promptInput`.
- **`prompt_field_types_deletes_and_moves_over_chips`**
  - Inserting "x" at the end works.
  - Backspace twice removes the "x", then the whole token.
  - Delete in front of a chip removes the whole token.
  - ArrowLeft jumps over a whole token.
  - Enter inserts `\n`.
  - The caret can be placed between two adjacent chips.
  - `@img2` followed by a space becomes one chip.
  - `ed.undo.length` never changes.
- **`prompt_field_undo_redo_paste_and_copy`**
  - Ctrl+Z / Ctrl+Y restore both the text and the caret.
  - A synthetic `ClipboardEvent("paste")` with `"see @img1\r\nthere\u200b"` gives `"see @img1\nthere"` and one chip.
  - Copying a selection over a chip yields `@img1`.
  - `history: fn` followed by Ctrl+Z gives the mapped older text; `"reset"` empties the stack.
- **`prompt_field_leaves_a_composition_alone`**
  - The chip nodes carry a mark that survives `imeSetComposition("ä")` (no render).
  - The commit gives the right text.
  - An Enter during the composition inserts no `\n`.
- **`prompt_field_keeps_the_editor_keys`**
  - Instance stubs, deleted afterwards as the brush-key step does at 2517-2555.
  - Ctrl+Enter and Ctrl+U reach their methods.
  - Escape blurs and `activeElement === ed.root`.
  - Backspace and Delete keep `ed.layers.length`.
  - Ctrl+Alt with key "@" (the AltGr probe) runs no editor shortcut.

26c2:
- **`ref_picker_opens_on_at_and_inserts`**
  - Typing `@` at a word start opens one `.ipc-refpop`; after `mail` it does not.
  - "jac" filters the rows to "jacket".
  - ArrowDown + Enter leaves `@img2 ` and a chip.
  - The first Esc closes the picker, keeps the focus and keeps "@jac"; the second Esc blurs.
  - The Ctrl+Alt keydown opens the picker at most once.
- **`ref_picker_adds_a_reference_in_place`**: `addReferences([file])` during a session adds one reference, and its token takes the place of the `@`.
- **`ref_bar_hover_and_swap`**
  - With `host.refLayout` stubbed and restored afterwards: cap 1 gives `data-state=over` and "2 of 1 for this recipe"; "none" gives its note.
  - A bar click inserts at the saved caret.
  - Hovering shows no card at 250 ms and a card with "sent as image 3" at 550 ms.
  - Swapping through the chevron changes the token, and one Ctrl+Z undoes it.

**Commands:**
- 26c1: `bash tools/run_gates.sh 26c1 --offline --tiles on editor commands assistant canvasonly llm document lint types nodecopy`
- 26c2: `bash tools/run_gates.sh 26c2 --offline --tiles on editor assistant canvasonly lint types nodecopy`
- While iterating: `SCUMBLE_EDITOR_ONLY=<step,step> bash tools/run_gates.sh 26c-it --offline --tiles on editor`

### Docs
- `docs/PLAN_REFS.md` §3.3: replace the mirror design with the built contenteditable (native plus controlled input, guards, own history), and add the "built" paragraphs for 26c1 and 26c2 with their commits.
- `docs/TESTING.md`: `tools/prompt_field_test.js` and the new editor steps.
- `docs/MANUAL.md`, written now; figures at the release:
  - the Prompt section: chips, their states, the bar, the hover card, the swap menu;
  - "Keyboard shortcuts": `@`, ↑↓, Enter / Tab, Esc, Backspace removes a chip whole, Ctrl+Z inside the field is the field's own.
- `docs/ASSISTANT.md`: one line saying that a contenteditable counts as a field that wants the focus.
- CLAUDE.md "Traps": only traps actually met during the build, for example that a document selection placed inside a contenteditable focuses it.

### Risks and open points
**Risks:**
- **Caret placement around non-editable chips in Chromium is the main risk.** Mitigations: the guards, our own Left/Right, and gate steps with real input. Sub-tasks 2-4 are built first and looked at in the app. If the guards misbehave, the fallback is fully controlled input (cancel `insertText` too) behind the same API.
- **Dead keys and IME** need the composition path; both are tested.
- **Behaviour change:** Upsample, Revert and `set_prompt` become steps of the field's undo (open point 3).
- **nodecopy goes red if the node repo lacks the `refLayout` stub** (see Contract changes).

**Open points for the user** (the recommendation first):
1. Image paste or drop into the prompt: it becomes a reference plus its token, or it is ignored. Note: `inpaint_canvas.js` 2667 skips the prompt field, so **today an image pasted into the prompt does nothing**. The task text says it becomes a layer; the code does not do that.
2. Hidden references in the bar: dimmed and not insertable, or a click shows the reference and inserts it.
3. Upsample, Revert and `set_prompt` as field undo steps, or clearing the field's undo as the textarea does.
4. The picker's search: typed after the `@`, or a separate focused search box. Compare with Magnific in the browser pane before 26c2.
5. Chip drag: in 26c2 (cut first if time is short), or later.
6. The session order proposed under Goal.

### Contract changes
1. **C4 / C2:** `setPromptText(text, {keepCaret, history})`. `history` is "push" (default), "reset", or a text→text function. The field's undo entries become a remap target. The remap passes its function; `setValue` and snapshot restore pass "reset". `keepCaret` maps the caret through the change (`mapOffset`); it does not keep the same number.
2. **C3:** the `provider:layout` shape must also carry `refName`. Main cannot name the pictures without it (`provider:edit` gets it in the request).
3. **C4:** the field takes a context `{refs, cap, none, canAdd, reason(id)}` beside the unchanged descriptors, which also list hidden references (label null).
4. **C6:** nodecopy copies the real node repo. The stub `async refLayout() { return null; }` is therefore committed to the node repo's `js/host.js` in 26c2, as 79c345b did for Remove, not at the next node build. The same holds for 26b's `refTokens: false`.

### Estimate and commit message
- **26c1:** 1 to 1.25 days. `Item 26 step 26c1: the prompt as a contenteditable with reference chips (own undo, whole-chip delete, plain-text paste)`
- **26c2:** about 1 day (0.75 without chip drag). `Item 26 step 26c2: the @ picker, the reference bar, the hover card and the swap menu`
- **Node repo:** `host.js: refLayout stub for the app's reference tokens`

Both steps together take 2 to 2.25 days, against 1 to 1.5 days for the mirror design. Commits are made as DenRakEiw with no trailer (CLAUDE.md).

## 26d1: Templates, the token rule and the check after a rewrite

**26d1 built (2026-09-29, S4).** `reftokens.js` gains `referenceName`, `referencesText`, `referencesRule`, `checkNote`
(section 11 of `reftokens_test.js`); `host.fillPromptTemplate` fills `{references}` and appends the token rule after the
output rule, the names too when the body has no placeholder; `builtInUpsampleInstruction(..., refs)` adds every
sentence of sub-task 3 only with references (compared with HEAD for 84 combinations of use case, text, region and
hint: byte-identical without them); the five `prompts/*.md` bodies of sub-task 8; the help text in `index.html`;
`electron/main/prompts.js`'s format comment. `upsamplePrompt` reads `refSnapshot()`, first unparks a parked token
typed for a layer that has a label (`remap(labels, labels)`, as `refPrompt` does), refuses in the editor's own words
(`upsampleRefProblems`: `"jacket" is hidden`, `is empty`, `is no longer a reference`, `@img?L.. names a deleted
layer`, `@img5 names none`; `host.refError` is app-only and the node's host lacks it) after the backend check, and
passes `namedRefs` to both `upsampleInstruction` calls and to `host.upsampleInApp` (fourth argument, typedef).
`upsample_prompt` returns `check`, and `previous` is Revert's text (remapped when the references changed). Sub-task 7
stays with 26f. Decisions the plan did not have, from the review (three finders, a verifier each; 7 confirmed): the
answer is not remapped from the click's labels to now but carried through the **same chain of remaps** Revert's text
went through (`upsamplePending.carry`, composed in `remapOthers`), so a merge of one reference into another during the
wait sends the absorbed layer's tokens to the survivor as C2 says (a plain remap parked them); the check's `dropped` /
`invented` go through that chain too, so the note names tokens as they are now; the check runs only when the request
named references (no noise on a plain prompt, none on a stray ComfyUI text result); `LITERAL` ends at the end of a word
("picture 2x", "image 4k" are no numbers); PROMPTS.md says the templates' bodies changed (the plan's "exactly today's
text" holds for the built-in rules); `docs/COMMANDS.md` regenerated; the gate's "Revert lit" can fail now. Gate step
`upsample_references` (a)-(f) plus an unknown token in (d), (f2) a swap back with a dropped token, (g) a merge during the
wait. Gates `--offline --tiles on`: generate, llm, lint, types, nodecopy.

### Read first: corrections from the review (they win over the text below)

- **Sub-task 7 (the Generate new dialog) moves to 26f** (C5). This step delivers the pure pieces and
  `fillPromptTemplate`'s `ctx.references`, and the editor's own upsample path.
- `clean()` comes from `reftokens.js` (C1, 26b1) and also strips `{` and `}`. `compare` (built in 26b1) implements
  this step's literal patterns.
- Anchor: the ComfyUI helper's `upsampleInstruction` call is at `inpaint_canvas.js:9982` (9985 is `helperUsed`).

### Goal and done when
When the prompt names references (`@img1`), every upsample path tells the language model which tokens exist and what each one is, and it appends a rule that keeps the tokens. After every rewrite the app checks the answer and remaps it to the labels that hold now. Done when:
- a prompt with no token gives exactly today's instruction text (built-in rules, templates, Generate new);
- a prompt with a parked token (`@img?L…`) or an unknown one refuses to upsample;
- an answer that dropped a token, added one, or wrote "image 3" leaves a warning in the status line, with Revert lit;
- a reorder while the model is answering ends with the right tokens in the field;
- the ComfyUI helper path gets names only;
- the five templates carry `{references}`;
- gates `generate llm lint types nodecopy` pass.

### Sub-tasks in build order
1. **`renderer/editor/reftokens.js`** gets four pure additions (26b's module, see Contract changes). `refs` = `[{ id, n, name }]`, sorted by `n`.
   - `referenceName(r)` returns `@img${n} (the layer "${clean(name)}")`. `clean` strips `@`, `"` and line breaks, keeps at most 60 characters, and falls back to `unnamed`.
   - `referencesText(refs)` returns `""` when `refs` is empty. Otherwise it returns `` ` The request names ${one ? "this reference image" : "these reference images"} by token: ${refs.map(referenceName).join(", ")}.` `` (with a leading space, like `{hint}`).
   - `referencesRule(refs)` returns `""` when `refs` is empty. Otherwise: `Reference tokens: keep every token of the request (@img1, @img2) exactly as written, lower case, never translated, quoted or split, as often as the request uses it and next to the words it belongs to. Write no token the request does not use, never replace a token with a description of its picture, and never name a picture by a number such as "image 2".` The list in brackets is the actual tokens.
   - `checkNote(cmp)` returns `""` when all three lists are empty. Otherwise `Check the tokens: the rewrite dropped @img2; added @img3; wrote "image 3".` (only the parts that apply). **It never contains the word "failed"**, because `commands.js:620` treats "failed" in the status as an error.
2. **`host.fillPromptTemplate`** (`host.js:1338-1348`): add `references: referencesText(ctx.references || [])` to `values`. When references exist, append after the output rule:
   ```js
   const refs = ctx.references || [];
   const own = refs.length ? "\n\n" + (/\{references\}/.test(tpl.body) ? "" : referencesText(refs).trim() + " ") + referencesRule(refs) : "";
   return `${body}\n\nOutput only the prompt text: no preamble, no quotes, no headings, no explanation.${own}`;
   ```
   A user's own template without the placeholder therefore still gets the names and the rule.
3. **`upsampleInstruction`** (`inpaint_canvas.js:988-994`) becomes `(useCase, text, region, hint, refs = [])`. It passes `{ useCase, prompt: text, region, hint, references: refs }` to the host and `refs` on to `builtInUpsampleInstruction` (996-1016). In the built-in rules, `has = refs.length > 0`, and **every addition is conditional, so the text without references stays byte-identical**:
   - `look` (1001): starts with `Look at the picture being edited.` instead of `Look at the image.` when `has`, then the hint, then `referencesText(refs)`.
   - the shared `rules` string (1002): after `never mention it, the region or the image` insert ` (the @img tokens are not such mentions: keep them)`; before `Output only the prompt text.` insert ` ${referencesRule(refs)}`.
   - one sentence per use case, inserted as `${take} ${rules}` right after the case's description sentence:
     - add: ` Take from each named reference image only the object or material the request asks for, and write its token where the request puts it.`
     - remove: ` A named reference image only shows the surface or texture the uncovered area should continue: write its token where the request puts it and add nothing else from it.`
     - outpaint: ` Take from each named reference image only what the request asks for (a subject, a style, a setting), and write its token where the request puts it.`
     - upscale: ` A named reference image is guidance for style and detail only: write its token where the request puts it and never add its content.`
     - default (fill): ` Take from each named reference image only what the request asks for (a subject, a garment, a material, a style or a pose), never its background, and write its token where the request puts it.`
   - the **edit case** (1010), with `t0 = "@img" + refs[0].n`:
     - after `...and end with what must stay unchanged.` insert ` Where the request takes something from a reference image, name it by its token, as in "the jacket from ${t0}", and take from that picture only what the request asks for, never its background.`
     - after the second example insert ` Request "zieh ihr die Jacke aus ${t0} an" -> "Dress the woman in the jacket from ${t0}, keeping her face, hair, pose, the lighting and the background exactly as they are."`
     - before `Output only the instruction.` insert `${referencesRule(refs)} `.

     `Request again: ${req}` stays last, as the comment at 997-998 asks.
4. **`upsamplePrompt`** (9966-9998), gated by `host.refTokens`:
   - Take `const snap = this.refSnapshot()` (C3) synchronously. Read the text from `snap.prompt`.
   - **Refuse** when `parse(snap.prompt)` holds a parked token, or a number with no label in `snap.labels`. The status says: `Upsampling needs every @img token to name a shown reference: "jacket" is hidden, @img5 names none. Show the layer or take the token out.` Then return, as the no-backend branch does, so `commands.js:617` throws that status to agents.
   - I chose refusing over shielding: a parked token has no picture and no line in `{references}`, and a run refuses the same prompt anyway (C3).
   - Build `refs` from the live tokens of the prompt only (id from `snap.labels`, name from `this.layers`, sorted by `n`).
   - Set `this.upsamplePending = { previous, useCase, request: snap.prompt, labels: new Map(snap.labels), refs }` and `this.upsampleCheck = null`.
   - Pass `refs` to both `upsampleInstruction` calls (the inApp branch and the ComfyUI helper branch at 9985). The ComfyUI helper therefore gets the names and the rule, no pictures. `host.upsampleInApp(this, backend, instruction, refs)`: the fourth argument is ignored until 26d2.
   - With `host.refTokens` false (the node), `refs = []` and nothing else changes.
5. **`applyTextResult`** (10001-10013): the ComfyUI event (`host.js:2321`) and `upsampleInApp` both land here.
   ```js
   let text = (info.text || "").trim();  // after the empty check:
   if (host.refTokens) {
       text = normalize(text);
       const cmp = compare(pending.request || "", text, (pending.refs || []).map((r) => r.n));
       if (cmp.dropped.length || cmp.invented.length || cmp.literals.length) this.upsampleCheck = cmp;
       if (pending.labels) text = remap(text, pending.labels, labelMap(this.referenceLayers()));  // numbers of the start -> now
   }
   ```
   - Compare first, then remap: `request` and the answer are both in the start numbering. `previous` was already remapped by 26b's mutation sites, which must touch `.previous` only (Contract changes).
   - Write the field with `this.setPromptText(text)` in place of 10009-10010.
   - Status: `Prompt upsampled for "edit" (31 words).${note ? " " + note : ""} Revert puts the old one back.`
   - `revertPrompt` (10015-10023) stays as it is, apart from `setPromptText` (26b).
6. **`commands.js` `upsample_prompt`** (621): return `check: ed.upsampleCheck || undefined` beside `prompt`, `previous` and `status`, so an agent sees the lists.
7. **`shell.js genInstruction`** (1036-1042), prepared for 26f:
   - `genRefs(text)` returns `[]` unless `host.refTokens`, `genEditor` exists and the text holds live tokens. Before 26f, 26b's prefill writes layer names into the field, so it is normally empty.
   - The ctx gets `references`.
   - The built-in plain rewrite inserts `${referencesText(refs)}${refs.length ? " Take from each named reference image only what the request asks for. " + referencesRule(refs) : ""}` before ` Request: ${text}`.
   - `genUpsampleGo` (1113-1127) runs `compare` against `genRefs` and appends `checkNote` to `genUpsampleNote`.
8. **The five `prompts/*.md` files.** Front matter stays unchanged; the bodies in full:

   `edit-instruction.md`:
   > You write instructions for an image editing model.
   >
   > Rewrite the request as one English instruction of 15 to 35 words: start with a verb, name the subject as it appears in the picture (the woman, the red car, the wall), apply exactly the requested change with the exact colours, materials and objects the request names, and end with what must stay unchanged. Do not describe the picture, do not describe the current state, do not add mood or story. If the request takes something from a reference image, keep its token right next to what is taken and use nothing else of that picture.
   >
   > The area being worked on is {region}.{hint}{references}
   >
   > Request: {prompt}

   `transparent-asset.md`:
   > You write prompts for an image model that is being asked for a cut-out: the request already carries background="transparent", and the answer has to be a single subject on a fully transparent ground.
   >
   > Rewrite the request as one English prompt of 25 to 60 words. Name the subject and its material, colour and lighting as it should appear, framed straight on with generous padding and nothing cropped at the edge. If the request names the subject by a reference token, keep the token next to the subject and take only the subject from that picture. Then state the delivery plainly: fully transparent background, no backdrop, no ground plane, no drop shadow touching the edge, clean alpha edges around hair, glass and thin detail. Never ask for a checkerboard, a white card or any other stand-in for transparency, and do not describe a scene the subject sits in.
   >
   > The area being worked on is {region}.{hint}{references}
   >
   > Request: {prompt}

   `photographic.md`:
   > Write one image-generation prompt in English that a photo-realistic model can follow.
   >
   > One paragraph of 50 to 90 words in this order: the shot (subject and framing, e.g. a three-quarter portrait, a wide landscape), the subject's appearance and materials, the lighting setup (key direction, softness, colour temperature, any practicals), the depth of field and focal length character, and the surface qualities that make it read as a photograph (skin texture, fabric weave, specular highlights, grain). Keep every subject, colour, material and number the request names, and every reference token next to what it stands for. Describe only what is seen. No lists, no brand names, no negative prompt.{references}
   >
   > Request: {prompt}

   `rich-scene.md`:
   > Write one image-generation prompt in English for the request below.
   >
   > One paragraph of 60 to 110 words. Start with the main subject, then its materials, colours and surface, then the setting around it, then the light (direction, quality, colour) and finally the framing and lens character. Keep every subject, colour, material and number the request names, exactly as it names them; translate the request into English if it is not, but never a reference token. Describe only what is seen. No lists, no headings, no camera brand names, no negative prompt.{references}
   >
   > Request: {prompt}

   `tags.md`:
   > Write an image-generation prompt as a comma-separated list of tags in English, for a model that was trained on tags rather than sentences.
   >
   > Between 15 and 30 tags, most important first: subject, then its attributes, then the setting, then the lighting, then the style and quality words. Lower case, no sentences, no weights, no parentheses, no negative prompt. Keep every subject, colour and material the request names; a reference token is kept exactly as written, beside the tag it belongs to.{references}
   >
   > Request: {prompt}

   No template shows a literal `@img1` as an example: without references a small model would copy it.
9. **`renderer/index.html:100`**: the placeholder list becomes `{prompt}`, `{model}`, `{aspect}`, `{region}`, `{references}`, and the text adds "; with reference tokens in the prompt the app appends its token rule".

### Interfaces this step defines or consumes
- Consumes from 26b: `refSnapshot()`, `setPromptText`, `labelMap`, `remap`, `parse`, `normalize`, `compare`, and `host.refTokens`. I assume `compare` returns token strings in `dropped` / `invented` and literal strings in `literals`; `checkNote` formats whatever 26b returns.
- Defines:
  - `referenceName`, `referencesText`, `referencesRule`, `checkNote`;
  - the ctx field `references: [{ id, n, name }]` for `host.upsampleInstruction` and `fillPromptTemplate`;
  - `upsampleInstruction(..., refs)`;
  - `upsamplePending.{request, labels, refs}`;
  - `editor.upsampleCheck`;
  - `upsample_prompt`'s `check`.

### Edge cases
- No token in the prompt: no references line, no rule, no check noise, and the text is byte-identical to today (the node included).
- A reference that is shown but not named is not listed. The model cannot attach it, and in 26d2 its picture is not sent.
- During the answer, a reorder, hide or delete remaps the answer from the start map. A hidden or deleted reference's token parks (`@img?L…`), and a later show or undo brings it back (26b).
- `@IMG1` is normalised. `img1` without the `@`, `image 3`, `<image3>` and `<frame>2</frame>` count as literals, but only when the request does not hold them itself.
- A token written twice, or fewer times than the request uses it, is not flagged (the check compares sets).
- An edit to the prompt made during the wait is overwritten, as today.
- The negative prompt is not upsampled and not touched.

### Tests
Normal tier.
- The `generate` gate gets a new step `upsample_references` after `prompt_templates`:
  - Two reference layers (`add_paint_layer` "jacket" / "dress", then `set_layer role: reference`), the labels read from `list_layers`.
  - A stub LLM row: `host.llms` gets one keyed row; `ed.refreshSegmentBackends()`; the select set to it; `host.askLLM` replaced by a recorder that answers from a queue.
  - Assertions:
    - (a) with no token the instruction has no `@img` and no `Reference tokens:`;
    - (b) the edit case with `@img2` lists only `@img2 (the layer "dress")` and holds the rule before `Output only the instruction.`;
    - (c) fill holds the rule inside `Rules:`;
    - (d) a parked token refuses, the status names the layer, and no call is made;
    - (e) an answer `"... @img1 ... image 3"` to a request with `@img2` gives a status with `dropped @img2`, `added @img1` and `"image 3"`, and Revert is enabled;
    - (f) the stub holds its answer while `moveLayer` swaps the two references, then answers `"from @img2"`: the field reads `@img1`, and Revert brings back the remapped previous.
  - `prompt_templates` also asserts: every built-in body holds `{references}`; `fillPromptTemplate` with references holds the list and ends with the rule after the output rule; without references it ends with `no explanation.`; a body without the placeholder gets names and rule appended.
- Commands: `bash tools/run_gates.sh r26d1 --offline --tiles on generate llm lint types nodecopy` (`llm`: its 5b phrases prove the text without references is unchanged).

### Docs
- `docs/PROMPTS.md`: a `{references}` row in the placeholder table; a paragraph on the token rule (appended like the output rule, names added when the placeholder is missing); the check and Revert; `reftokens.js` in "How it is put together".
- `docs/BUILD_NODE.md`: the ctx's new field.
- `docs/TESTING.md`: the new step.

### Risks and open points
- A longer instruction lowers compliance on Qwen3-VL 2B (the ComfyUI helper). The check makes the damage visible, but warnings there will be common.
- Whether the model may add a shown reference the user did not name is a product call: I chose no (see Contract changes).

### Contract changes
- **C1** gains `referenceName`, `referencesText`, `referencesRule` and `checkNote`. `compare().literals` must cover `(?<![@\w])(image|picture|img|bild|reference|ref)[ _#-]?\d+`, `<image\s*\d+>` and `<frame>\d+</frame>`, counting only literals that the request does not hold itself.
- **C5 clarification:** "references exist" means the prompt names at least one shown reference; `allowedLabels` = the request's labels.
- **C2:** the remap of `upsamplePending` touches `.previous` only, never `.request` / `.labels`.

### Estimate and commit message
0.5 to 0.75 day. `Item 26 step 26d1: {references} in the templates and the built-in rules, the token rule, the check and remap after a rewrite`

## 26d2: The named reference pictures to the language model

### Read first: corrections from the review (they win over the text below)

- **Sub-task 4 (`genUpsampleGo`) moves to 26f** (C5).
- Change the compatible client's non-strict retry predicate (`llm.js:265`) to retry only on 400 / 413 / 415 / 422 or
  an error about images (C5). The edge case "a 401 is never retried by today's predicate" is false for the local
  endpoint today; with the change, `llm_images_test`'s "a 401 gives one call" holds. CHANGELOG note (section 6).
- The setting's label, tooltip and the manual say "API and local-endpoint models": the ComfyUI helper upsampler gets
  names only.
- Anchor: `tools/openrouter_test.js` §11 starts at 692, §12 at 808.

### Goal and done when
For an API or local-endpoint model, the upsample sends the pictures of the references the prompt names, each after a text label, in the order the instruction describes. This is on by default (decision D) and can be switched off in Settings. The compatible client retries in steps. Done when:
- the mock sees one crop plus N reference pictures;
- with the switch off it sees the crop only;
- a model that cannot take several pictures ends at "crop only", then "text only";
- a request with no references is byte-identical to today;
- gates `llm generate openrouter oxen toapis lint types` pass.

### Sub-tasks in build order
1. **`electron/main/llm.js`**:
   - Header comment (15-19): `ask({ id, instruction, image, images, maxTokens }) -> { text, seconds, model, note, pictures }`.
   - One neutral turn builder:
     ```js
     const MAX_REF_PICTURES = 6;
     function turn(instruction, image, images) {   // [{text}|{png}]
         if (!images.length) return [{ text: instruction }, ...(image ? [{ png: image }] : [])];   // exactly today's
         const out = [{ text: instruction + "\n\n" + (image
             ? "The first picture is the one being edited; the reference pictures follow it, each after a line that gives its token."
             : "The pictures are reference images, each after a line that gives its token.") }];
         if (image) out.push({ text: "The picture being edited:" }, { png: image });
         for (const r of images) out.push({ text: `Reference picture ${r.label}:` }, { png: r.png });
         return out;
     }
     ```
     The labels carry tokens, never numbers, so the model is not invited to write "picture 2".
   - The four builders map the turn:
     - `askOpenAI` (147-169): `input_text` / `input_image` with `detail: "auto"`;
     - `askGemini` (171-192): `{text}` / `inline_data`;
     - `askAnthropic` (194-214): the same parts with the first text part moved last, which gives today's `[image, text]` when there are no references;
     - `askCompatible`: `{type:"text"}` / `{type:"image_url"}`.
   - `askCompatible` (230-293): the stepped retry replaces 257-271. `steps = [images.length && "all", image && "crop", "text"].filter(Boolean)`, and `once(mode)` builds its content from `turn(instruction, image, mode === "all" ? images : [])`. The `"text"` step keeps today's plain string. On a failure, go to the next step only while the existing `aboutImage` / `strict` predicate (264-265) allows it.
   - It returns `{ text, textOnly, step }`:
     - note `"crop only"` when the answer came at `"crop"` and pictures were asked for;
     - note `"text only"` when it came at `"text"` and any picture was asked for;
     - `pictures` = `images.length` at `"all"`, else 0.

     The other three builders return `pictures = images.length`.
   - `ask()` (344-389) normalises `images`:
     - take at most 6, `toBuffer` each `png`, and keep the label on one line, cut to 120 characters;
     - drop them all when `(settings.get().llm || {}).refPictures === false`;
     - **honour `vision: false`**: `customModel` (392-400) returns `vision: row.vision !== false`, and the compat branch (354-366) looks up its row with `custom.find(custom.forUpsample(...), "compat", model)`. Either way `image` and `images` are set to nothing.

     This fixes a gap that is there today: the "Can see the picture" tooltip at `index.html:89` promises this, but `llm.ask` never reads the flag. The log line (387) gets the picture count.
2. **`renderer/editor/host.js`**:
   - A new member `llmRefPictures: true`. `configure` (247) takes `llmRefPictures`.
   - `askLLM(backend, instruction, canvas, images = [])` (1944) passes `images`.
   - `upsampleInApp(editor, backend, instruction, refs = [])` (1964) calls `this.llmPictures(editor, refs)` when `this.llmRefPictures && refs.length`. The status suffix gets `, 2 reference pictures` when `res.pictures` is non-zero.
   - `llmPictures(editor, refs)` covers at most 6 refs in label order. For each: find the layer by id and skip it when it has no `px`. Set `s = min(1, 512 / max(px.width, px.height))`, make a `document.createElement("canvas")` of the scaled size, draw with `editor.drawLayerFitted(ctx, layer, 0, 0, w, h)` (12127: mask applied; on tiles from `thumbnailCanvas`, so it never makes the full-size mirror), and add `toBlob` PNG bytes as `{ png, label: referenceName(r) }`.
   - Typedef (198, 200): `upsampleInApp: (editor, backend, instruction: string, refs?: any[]) => Promise<any>` and `askLLM: (backend, instruction: string, canvas: any, images?: {png: Uint8Array, label: string}[]) => Promise<any>`.
   - `llmPictures` and `llmRefPictures` are app-side only: the editor never calls them, so they stay out of the typedef and the node's `js/host.js`.
3. **The setting**:
   - `electron/main/settings.js` (24-28): a comment only. `llm.refPictures`: `false` keeps the reference pictures away from the upsampling model; **absent means on**. It is not a value in DEFAULTS, because `set()` writes the whole object and a stored default could no longer be told from the user's choice (the `embedRecipe` trap, 66-70). Both existing `llm` writers spread `set.llm` (`shell.js:695, 762`), so the key survives them.
   - `index.html`, after line 97: `<div class="shell-row"><label class="shell-check" title="The references the prompt names go to the language model's provider as pictures of at most 512 px."><input id="set-up-refpics" type="checkbox" checked> Upsampling shows the language model the reference images the prompt names</label></div>`.
   - `shell.js`:
     - `ui.upRefPics` (76);
     - at 105, `host.configure({ ..., llmRefPictures: (settings.llm || {}).refPictures !== false })`;
     - `openSettings` (1781) sets `.checked` from the same expression;
     - on change: `const set = await window.scumble.settings.get(); settings = await window.scumble.settings.set({ llm: { ...(set.llm || {}), refPictures: ui.upRefPics.checked } }); host.llmRefPictures = ui.upRefPics.checked;`.
   - The renderer skips building the pictures, and main enforces the setting where the request leaves.
4. **`shell.js genUpsampleGo`** (1121): pass `await host.llmPictures(genEditor, refs)` when there are refs and the switch is on (none until 26f).

### Interfaces this step defines or consumes
- Defines:
  - `llm.ask({..., images})` returning `pictures` and the notes `crop only` / `text only`;
  - `host.askLLM(..., images)` and `host.upsampleInApp(..., refs)`;
  - `host.llmRefPictures` and `host.llmPictures`;
  - the setting `llm.refPictures`.
- Consumes from 26d1: `refs`, `referenceName`, the instruction.

### Edge cases
- More than 6 named references: the first 6 go as pictures (label order), all go by name.
- A model without vision on an endpoint: all pictures, then the crop, then text only. A 401, 402 or 429 is never retried (today's predicate).
- A `vision: false` row gets no picture at all and no note, because the user set it that way.
- On tiles the source picture is 256 to 511 px on its long side, and it can be coarse while mips are still in the worker. That is accepted for recognition.
- Six 512 px PNGs are about 2-3 MB of base64, far below Anthropic's 5 MB per picture and Gemini's 20 MB per request.
- With no crop (Generate new, 26f) the order note says so.

### Tests
Normal tier for the renderer, light tier for the builders.
- **New `tools/llm_images_test.js`** (plain Node; the `Module._load` stubs for `./keys` and `./settings` plus the fake fetch of `openrouter_test.js` §11-12, 691-805):
  - per builder, the exact part sequence (instruction plus order note, then `The picture being edited:` / crop, then `Reference picture @img1 (the layer "a"):` / ref), with the bytes equal and Anthropic's text last;
  - with no references, the bodies equal today's;
  - 8 images in means 6 sent;
  - the setting off means one picture;
  - a `vision: false` custom row (and a compat row) means no picture;
  - compat retries: 400 "too many images" then 200 gives 2 calls with note `crop only`; 400, 400, 200 gives a string content with `text only`; a 401 gives one call;
  - a label with a newline arrives on one line.
- **`tools/llm_mock.py`**:
  - `images_of(body)` counts the `image_url` parts;
  - the answer adds `, images: N` and echoes the distinct `@img\d+` tokens of the instruction;
  - a new model `mock-one` refuses more than one picture (400 "only one image per request is supported") and echoes none.
- **`tools/llm_test.py`**:
  - `node_test()` (48-55) also runs `llm_images_test.js`;
  - a new step 5c before step 6 uses deltas (`before = len(mock.posts())`) so the absolute counts of steps 2-5 stay valid. With two paint references and `@img1` / `@img2` in the prompt:
    - `mock-vision`: 3 pictures, labels in order, status `2 reference pictures`, no `Check`;
    - the checkbox off: 1 picture, and the instruction still names both;
    - `mock-one`: 2 requests (3 then 1), status `crop only`, `dropped @img1`;
    - the settings are put back in the existing `finally`.
- The `generate` step from 26d1 asserts that the stub received 2 images with a long side ≤ 512, and 0 with `host.llmRefPictures = false`.
- Commands:
  - `node tools/llm_images_test.js`
  - `node tools/openrouter_test.js` (§11 must pass unchanged)
  - `bash tools/run_gates.sh r26d2 --offline --tiles on llm generate openrouter oxen toapis lint types`
- There is no canvas-backend run: `drawLayerFitted` is existing code.

### Docs
- `docs/HELPERS.md` §"Prompt upsampling through the provider keys" (8-23): the pictures and their labels, at most 6 at 512 px, the stepped retry and its notes, `vision: false`, the switch.
- `docs/PROMPTS.md`: one line on pictures.
- `docs/TESTING.md`: `llm_images_test.js`.
- `docs/MANUAL.md:145` gets the sentence: "When the prompt names reference images, upsampling shows them to the language model too, as small pictures of at most 512 pixels, so the rewrite knows what each token is; they then go to that model's provider as well. Settings › Prompt templates has the switch to keep them back."

### Risks and open points
- None of the four builders has sent several pictures live; they follow the vendors' docs. Checking them needs keys, on the user's word.
- Six pictures add roughly 1.5-2k input tokens, about a tenth of a cent at the prices in `llm.js` 30-32.
- PNG against JPEG for the pictures: PNG keeps the `dataUri` default; JPEG would halve the payload.

### Contract changes
- C5: `llm.ask` also returns `pictures`, and `vision: false` rows get no pictures.
- C4 / C6: `askLLM` and `upsampleInApp` gain an optional fourth argument.
- Otherwise none.

### Estimate and commit message
About 0.5 day. `Item 26 step 26d2: the named reference pictures to the language model (on by default, a setting), the stepped retry, vision: false honoured`

## 26e: local ComfyUI recipes

### Read first: corrections from the review (they win over the text below)

- `queueGenerate` keeps C3's signature: `async queueGenerate(editor, opts = {}) { const snap = opts.refs ||
  editor.refSnapshot(); ... }`. Drop sub-task 6 and contract change 2 (26b2 already takes the snapshot before
  `heldEdit`). Add a gate assert that goes through `ed.generate()`, not only `host.queueGenerate(ed)`.
- The run helper is C3's `refPrompt` with the route `"comfy"` (it replaces 26b2's `"local"`); `named_refs` is set when
  `pairs` is not empty.
- The shared vectors run against `refs.js`'s exported `resolveMarkers` (26a1), not an `index.js` `_resolveMarkers`.
- The comfy branch of `host.refLayout` returns C3's shape (`names` by layer id, `over`, `local: true`); the Info panel
  and the pre-check use `editor.predictOriginal({local: true})`.
- Anchor: `nodes.py:476-486, 599-601` are `_state_from_prompt` and the `result_source` choice, not the expansion.
  Re-read the expansion before relying on "orphaned slot nodes never run" (the first review checked it from
  `execution.py`: only what `result_source_local` reaches is expanded and validated).
- This step changes 26a1's `recipes_test` line for comfy `refs` (now validated).

### Goal and done when
A local recipe resolves `@img<n>` in the prompt and the negative into the wording its model reads (`<image3>` for Qwen Image 2.1, `image 3` for Klein, `Picture 3` for Qwen Edit Plus). It builds `n` with the node's own batch rule, taken from the state it sends. No picture repeats into an unused slot, and a token for a picture past the recipe's slots is refused. This step is done when:
- both shipped graphs are widened and carry `refs`;
- 26b's local guard is gone;
- the Info panel counts the refine pass and lists `img1 → <image3>`;
- `recipes` (new app step plus `tools/comfyrefs_test.js`), `upscale`, `nodecopy`, `lint` and `types` pass with `--offline --tiles on`;
- nothing has been queued on 8188.

### Sub-tasks in build order

1. **`recipes/qwen_image_edit_2_1_local.json`.** Add seven batch pickers after `img2` (line 26), with the same shape as `img0..img2`:
   `"img3": { "class_type": "ImageFromBatch", "inputs": { "image": ["canvas", 0], "batch_index": 3, "length": 1 } }`, and the same for `img4`…`img9` (`batch_index` 4…9).
   In `encode.inputs`, after `"images.image_3": ["img2", 0]`, add `"images.image_4": ["img3", 0]`, `"images.image_5": ["img4", 0]` … `"images.image_10": ["img9", 0]`.
   Add the top-level `"refs": { "name": "<image{n}>", "slots": 10 }` after `"result"`. Rewrite `description`: "the crop is <image1>, the next pictures of the crop batch (the Original copy with a fill mode, then the reference layers) are <image2> to <image10>; slots the batch does not fill are left out of the run; @img tokens are written as the <imageN> their picture has". `needs` is unchanged.
   Autogrow allows `image_1..image_16` with `min=0` (`comfy_extras/nodes_qwen.py:125-130`). The loop takes only the keys that are present (149-151), and the tokenizer numbers present pictures by rank (`comfy/text_encoders/qwen_image21.py:23`).

2. **`recipes/flux2_klein_local.json`.** Add these nodes:
   ```json
   "img2": { "class_type": "ImageFromBatch", "inputs": { "image": ["canvas", 0], "batch_index": 2, "length": 1 } },
   "img3": { "class_type": "ImageFromBatch", "inputs": { "image": ["canvas", 0], "batch_index": 3, "length": 1 } },
   "scale2": { "class_type": "ImageScaleToTotalPixels", "inputs": { "image": ["img2", 0], "upscale_method": "lanczos", "megapixels": 1, "resolution_steps": 1 } },
   "scale3": { "class_type": "ImageScaleToTotalPixels", "inputs": { "image": ["img3", 0], "upscale_method": "lanczos", "megapixels": 1, "resolution_steps": 1 } },
   "enc2": { "class_type": "VAEEncode", "inputs": { "pixels": ["scale2", 0], "vae": ["vae", 0] } },
   "enc3": { "class_type": "VAEEncode", "inputs": { "pixels": ["scale3", 0], "vae": ["vae", 0] } },
   "ref_pos2": { "class_type": "ReferenceLatent", "inputs": { "conditioning": ["ref_pos1", 0], "latent": ["enc2", 0] } },
   "ref_neg2": { "class_type": "ReferenceLatent", "inputs": { "conditioning": ["ref_neg1", 0], "latent": ["enc2", 0] } },
   "ref_pos3": { "class_type": "ReferenceLatent", "inputs": { "conditioning": ["ref_pos2", 0], "latent": ["enc3", 0] } },
   "ref_neg3": { "class_type": "ReferenceLatent", "inputs": { "conditioning": ["ref_neg2", 0], "latent": ["enc3", 0] } }
   ```
   Change `guider.inputs` to `"positive": ["ref_pos3", 0], "negative": ["ref_neg3", 0]`. Add `"refs": { "name": "image {n}", "slots": 4 }`. Rewrite `description`: "the crop plus up to three more pictures of the crop batch (the Original copy with a fill mode, then the reference layers) as reference latents at 1 MP each; unused ones are left out". The references stay at a fixed 1 MP, like `scale1`; the Megapixels setting (index 6) keeps driving `scale0` only.

3. **`electron/main/recipes.js` `normalize`, the comfy branch (266-272).** Before the `return r`, validate a declared `refs`:
   - `name` goes through the same check 26a1 added for provider `refs.name` (a string holding `{n}` or `{n0}`);
   - `slots` must be an integer from 1 to 16 (the most TextEncodeQwenImage21 takes) and is `null` otherwise;
   - an invalid `refs` is deleted with a `console.warn` naming the recipe, so the renderer falls back to derivation.

   Typedef `Recipe` (92-122): add `@property {{ name?: string, slots?: number | null } | null} [refs]`. `slots` counts **pictures, the crop included**. `importFile` (598) already keeps `refs` from a Scumble recipe file. `fromWorkflow` / `fromPrompt` stay unchanged: the wording is derived in the renderer (sub-task 4), so recipes imported before 26e get it too, and a single trace drives both the wording and the trimming.

4. **New `renderer/editor/comfyrefs.js`.** App-only pure ESM with `// @ts-check`, no DOM, imported by `host.js` alone. It is **not** in `build_node.py` `FILES` (same case as `stitch.js` / `redact.js`, build_node.py:37). Exports:
   ```js
   // an input's source traced back to ImageFromBatch(image = [canvas, 0], length 1, a literal batch_index >= 0)
   export function batchOf(prompt, canvasId, link, depth = 0)   // number | null; follows the single linked of pixels / image / samples, depth <= 8
   export function comfySlots(prompt, canvasId)   // [{ node, input, cls, batch }] for TextEncodeQwenImage21 /^images\.image_\d+$/,
                                                  // TextEncodeQwenImageEditPlus image1..3, ReferenceLatent latent
   export function comfyRefSpec(recipe)           // { name, slots, guess, trim }
   export function comfyLayout(spec, { hasSelection, fill, withOriginal, refine, count })
   export function trimSlots(prompt, spec, length) // removed "node.input" strings
   export function refName(pattern, n)             // {n} -> n, {n0} -> n - 1
   export function resolveMarkers(text, pictures, pattern)   // { text, left: string[] }, renderer twin of 26a1's index.js resolver
   ```
   `comfyRefSpec` works as follows:
   - The traced batches are *identity* when they are exactly `0..k-1`, one encoder class holds them all, and, for `ReferenceLatent`, each node's position in its `conditioning` chain equals its batch.
   - `name` = `refs.name` if declared, otherwise the class wording when identity (`<image{n}>`, `Picture {n}`, `image {n}`), otherwise `image {n}`.
   - `slots` = the declared value, otherwise `k` when identity, otherwise `null`.
   - `guess` = true when the name came from neither a declaration nor an identity trace.
   - `trim` = the slot entries when identity, otherwise `null`. Only these optional inputs are ever trimmed: `ReferenceLatent.latent` (a pass-through when absent, `nodes_edit_model.py:25`), `images.image_k`, and EditPlus `image2/3` (optional, `nodes_qwen.py:65-67`).

   `comfyLayout` mirrors `nodes.py` 594, 616-687:
   ```js
   const original = hasSelection && fill && fill !== "none" && withOriginal && !refine ? 1 : 0;
   const room = spec.slots == null ? Infinity : Math.max(0, spec.slots - 1 - original);
   const kept = Math.min(count, room);
   // pictures: crop n 1; original ref 0 n 2; reference k -> ref original + k, n 2 + original + k; field "node.input" of its slot or "crop_image[b]"
   return { pictures, max: spec.slots, drops: count > kept ? `${count - kept} reference(s) past the recipe's ${spec.slots} pictures are not sent` : null,
            style: false, guess: spec.guess, original, kept };
   ```
   `trimSlots` deletes `prompt[node].inputs[input]` for every `trim` entry whose `batch >= length`, and never touches batch 0. The orphaned `imgK` / `scaleK` / `encK` nodes are never executed: the canvas node expands only what `result_source_local` reaches (`nodes.py:476-486`, 599-601). `validate_prompt` only requires every `class_type` to exist (`execution.py:1130-1161`), which `needs` already ensures.

5. **`renderer/editor/inpaint_canvas.js` `serializeForPrompt` (16514).** Right before the mask block (16531), in the same tick as the `maskRef` read or `maskToCanvas()`, add `const hasSelection = !!this.getBounds();` and add `hasSelection` to the returned JSON (16560-16574). The key is informational and the node ignores it. It gives the app the selection the node receives, even when the user changes the selection during the reference uploads.

6. **Snapshot timing.** `generate()` awaits `heldEdit()` (16212) and `freeHelperModels()` (16220) before it calls `host.queueGenerate(this)` (16222). If 26b takes `refSnapshot()` after those awaits, move it to 16211 and pass it: `await host.queueGenerate(this, snap)`.

7. **`renderer/editor/host.js` `queueGenerate` (1387-1420).** New signature: `async queueGenerate(editor, snap = typeof editor.refSnapshot === "function" ? editor.refSnapshot() : null)`. Direct callers such as `upscale_test.py:313` keep working. The steps:
   1. Remove 26b's guard after 1392 ("reference tokens on local recipes come with step 26e").
   2. For a non-upscale recipe, `spec = comfyRefSpec(r)`, cached in a module `WeakMap` keyed by the recipe object.
   3. **Early check, before any upload:** build the layout from the live editor (`!!editor.getBounds()`, `cropSettings`, `genSettings.refine && genSettings.mode === "local"`, `snap.refIds.length`) and run 26b's run helper in its comfy branch. It throws on parked or unknown tokens and on a token past the slots.
   4. `raw = await editor.serializeForPrompt({ refIds: snap && snap.refIds })`, then `st = JSON.parse(raw)`.
   5. Rebuild the layout **from the state** (`st.hasSelection`, `st.crop.fill`, `st.crop.withOriginal`, `!!st.gen.refine && st.gen.mode === "local"`, `st.references.length`). Then `st.references = st.references.slice(0, lay.kept)`.
   6. Run the helper again (the state wins). It returns `{ prompt, negative, named, pairs }`:
      - C1 `toMarkers` over the kept ids (26b's Original-offset convention);
      - `resolveMarkers` with `lay.pictures` and `spec.name`;
      - the safety net: anything left matching `/@img/i` or `{@ref:` is refused, as in index.js.
   7. Set `st.prompt` and `st.negative`. Set `st.named_refs = true` when `named` is true. Then `state = JSON.stringify(st)`.
   8. `ensureOnServer(state)` (1399) now checks only the kept references.
   9. After the prompt clone (1400): `trimSlots(prompt, spec, 1 + lay.original + lay.kept)`.
   10. After `queuePrompt`:
       - status: `Queued crop … · @img1 → <image3>, @img2 → <image4>`, plus `lay.drops` and "(wording guessed from the graph)" when `spec.guess`;
       - log: `window.scumble.log.add({ level: "info", source: "comfy", message: "local run <id>: prompt as sent", detail: st.prompt })`.

   The upscale branch (`upscaleState`, 1427-1433) and 26b's no-reference text branch stay as they are. `r` is captured at the start, so a recipe switch during the await changes nothing. Typedef line 190 becomes `(editor: any, snap?: any) => Promise<any>`.

8. **`host.js`, the comfy branch of 26c's layout member.** In the host member behind the bar's count and the descriptors' `sentAs` (`host.refLayout(editor)` here), a comfy recipe answers synchronously with the step 3 layout and `names[i] = refName(spec.name, picture.n)`. There is no IPC for comfy recipes.

9. **`inpaint_canvas.js` `renderInfo` (13211-13246).**
   - 13225: `const refine = this.genSettings.mode === "local" && !!this.genSettings.refine;` and count the Original only when `!refine`. This fixes the node too.
   - With `host.refTokens`, the reference count is the number of descriptors with `sentAs !== null`, when the host knows a layout.
   - 13239-13240 (app only): `References: img1 → <image3>, img2 → <image4> (pad)`, plus `· img3 not sent` and `· wording guessed from the graph`. The node keeps its `in crop_image` row.
   - 13244: build `span` / `b` elements with `textContent` (`replaceChildren`) instead of `innerHTML`, because `<image3>` would be parsed as a tag. No test reads `infoEl`.

10. **Tests and docs** (below).

### Interfaces this step defines or consumes
- **Defines:**
  - `refs: { name, slots }` on comfy recipes (slots include the crop);
  - `renderer/editor/comfyrefs.js` (sub-task 4);
  - the comfy layout's extra fields `guess`, `original`, `kept`;
  - `queueGenerate(editor, snap?)`;
  - two new `canvas_state` keys: `hasSelection` and `named_refs`.
- **Consumes:**
  - C1 `parse`, `toMarkers`, `labelMap` (26b);
  - `editor.refSnapshot()` and `serializeForPrompt(opts.refIds)` (26b);
  - 26b's run helper and its refusal texts;
  - the marker grammar `{@ref:i}` and the resolver in `electron/main/providers/index.js` (26a1), exported as `_resolveMarkers` for the shared test vectors;
  - 26a1's `refs.name` validator in `normalize`;
  - `host.refTokens`, the C4 descriptors, and 26c's `host.refLayout` (whatever name 26c gave it).

### Edge cases
- **Original rule.** The Original is in the batch only with a selection, a fill other than none, and Original on, and never on a refine pass in local mode (`nodes.py:594, 628-632, 656-660`). A comfy recipe with `mode: "api"` never refines.
- **More references than slots:** unnamed ones are dropped with the status note, and a named one is refused before any upload. Example: Klein with Original on and 3 references keeps 2. Refusal text: "@img3 cannot be named: Flux.2 Klein … takes 4 pictures (the crop, the Original, img1, img2). Hide a reference, turn Original off, or take @img3 out."
- **No references:** every slot but the crop is trimmed. This is a **behaviour change**: until now Klein repeated the crop into slot 1, and Qwen repeated it into slots 1 and 2 (the `ImageFromBatch` clamp, `nodes_images.py:304`), so the same seed now gives a different result. Say so in the CHANGELOG.
- **Hidden or deleted reference:** its token is parked (decision B) and refused by 26b's text.
- **Original or selection toggled during `serializeForPrompt`:** the state decides. If the second check refuses, only mirror uploads have happened.
- **Imported graphs that cannot be traced** (the whole batch into an API node, a linked `batch_index`, non-identity order): no trim, no slot refusal, names by batch position, "guessed". The last picture then repeats as before; `docs/RECIPES.md` says so.
- **Numbering differences:** EditPlus numbers by input (`i + 1` over the fixed three, `nodes_qwen.py:102`), Qwen 2.1 by rank among present pictures. Trimming only the tail keeps both right.
- **Klein's negative** is a fixed `""` node (`neg`), so negative tokens are resolved but unused. Qwen reads the negative through `["canvas", 12]`.
- **Selection threshold:** the editor's bounds count a selection whose values are all ≤ 127, but the node does not (`mask > 0.5`). This is rare, and the Info panel already assumes the same.
- **The node skips an unreadable reference** and moves later ones up (`nodes.py:681-685`). `ensureOnServer` only checks that the file exists. Known limit; see Docs.
- **A literal `<image3>` typed by the user** passes through unchanged. The typed prompt stays in the editor, in the history and in the PNG metadata; only `canvas_state` carries the resolved text.

### Tests
Tier **normal**: no pixel path, no document format. The graphs can break a run but cannot lose data. There is no canvas-backend run and no mutation round.

- **Plain Node, `tools/comfyrefs_test.js`** (imports ESM via `pathToFileURL`, as `tools/stitch_test.js:105` does):
  1. `shipped_specs`: Qwen gives `<image{n}>` with 10 slots, identity 0..9, not a guess. Klein gives `image {n}` with 4 slots, identity, and pos + neg entries per batch.
  2. `layout_matrix`: selection × fill × Original × refine × count (0, 1, 3, 12). Assert `n`, `ref`, `kept` and `drops`.
  3. `trim`: Qwen with length 1 keeps only `images.image_1`; with length 3 keeps `image_1..3`. Klein with length 2 keeps the latents on `ref_*0..1` only, `ref_pos3.conditioning` still points at `["ref_pos2", 0]`, and batch 0 is never trimmed.
  4. `markers`: the same vectors against `resolveMarkers` and index.js `_resolveMarkers` (`{n}`, `{n0}`, leftovers).
  5. `imported`: `recipes.fromPrompt`, loaded with the Electron stub of `tools/recipes_test.js:37-42`, for four graphs:
     - EditPlus → `Picture {n}` with 3 slots;
     - Qwen 2.1 → `<image{n}>`;
     - a ReferenceLatent chain → `image {n}`;
     - the whole batch into one node → `slots` null, a guess, no trim.

     Plus an `image_2 ← batch 3` graph (a guess, no trim), and `normalize` dropping `refs: { name: "x", slots: 99 }`.

  `node_step` in `tools/recipes_test.py:41-47` runs this file after `recipes_test.js`.

- **App step in `tools/recipes_test.py`**, `local_recipes_name_the_batch_pictures_and_trim_the_unused_slots`, modelled on `upscale_test.py:313-395`:
  - Stubs: `host.connected`, `objectInfo` built from `needs`, `ensureOnServer`, and `api.queuePrompt` capturing `sent`. Restore them all in `finally`.
  - Setup: `new_canvas 512×384`, three paint layers set to `role: "reference"`, labels and ids read from `ed.refSnapshot()`, `select_rect`.
  - For each recipe, call `host.queueGenerate(ed)` and parse `canvas_state`:
    - 0 references, no tokens: `st.prompt` unchanged, no `named_refs`, Qwen `encode.inputs` has only `images.image_1`, Klein `ref_*1..3` have no `latent`.
    - 1 reference with `set_crop fill: "green", withOriginal: true` and prompt `@img1`: `<image3>` / `image 3`, keys `image_1..3`, `named_refs === true`, and `ed.promptText` still `@img1`.
    - Same with `set_generation refine: true`: `<image2>`, no Original key.
    - 3 references, Original off, `@img3 and @img1` plus a Qwen negative `@img2`: `<image4> and <image2>`, negative `<image3>`.
    - Klein with 3 references and Original on: `@img3` refused, `sent === null`. Without the token it queues with `st.references.length === 2`, and the status contains "not sent".
    - Hide the layer of `@img2`: refused, nothing queued.
    - The Info panel's `textContent` contains `img1 → <image3>`.
  - Cleanup: `set_crop fill: "none"`, `set_generation refine: false`, `set_prompt text: ""`, previous recipe reselected.
- **Commands:**
  ```
  node tools/comfyrefs_test.js
  bash tools/run_gates.sh s26e --offline --tiles on recipes upscale nodecopy lint types
  ```
  `upscale` is the regression for the comfy upscale path through `queueGenerate`; `nodecopy` covers the shared `serializeForPrompt` and `renderInfo` edits. **No `smoke` and no live run:** 8188 is production, Qwen 2.1's models are not downloaded, and `smoke` runs `flux2_klein_local`, the default recipe (`electron/main/settings.js:13`), only on the user's word.

### Docs
- **`docs/RECIPES.md`:**
  - schema block (19-31): add `refs`;
  - 41-56: rewrite both shipped bullets (4 / 10 slots, trimming instead of the "last one repeats" sentence, 1 MP references, the naming);
  - a new subsection "Reference images named in the prompt (local)": the batch rule, `n = 1 + Original + k`, `refs`, the derived wordings and when they are a guess, the trim rules, refusal versus drop, `hasSelection` and `named_refs`, and the known skip limit.
- **`docs/BUGS.md`, "Reference layers dropped without a word":** mark the Klein item and the Info-panel item fixed by 26e. On the node-skip item, note that the app sends `named_refs: true` since 26e and that the next node release should raise instead of print at `nodes.py:684-685` when it is set.
- **Other docs:** `docs/TESTING.md` gets the new file and the step. `docs/PLAN_REFS.md` §3.5 / §3.7 and the step table get the built state. The CLAUDE.md hand-over comes after 26f. The MANUAL (Recipes, around line 141) and the CHANGELOG line (the behaviour change) come before the release.

### Risks and open points
- Neither widened graph has run. Klein with three 1 MP reference latents (about 4k image tokens each) and Qwen with 10 pictures grow VRAM use and time. Whether the references should drop below 1 MP is for the user. The classes and inputs were checked against the local ComfyUI sources (read-only); an optional `GET /object_info` check queues nothing.
- Whether Klein follows "image 3" through ReferenceLatent is BFL's documented convention, not verified.
- The node's skip-and-shift stays until a node release.
- `commands.js:710-711` recognises only `/^Error|failed/`. A refusal reaches an agent only after the idle wait (about 35 s). If 26b did not fix this, a `lastGenerateError` on the editor would let the command throw at once.
- If 26b takes the snapshot inside `queueGenerate` after `generate()`'s awaits, "at the click" does not hold (sub-task 6).

### Contract changes
1. C3 layout: comfy layouts add the optional fields `guess`, `original` and `kept`; providers ignore them.
2. `host.queueGenerate(editor, snap?)`, with the snapshot taken in `generate()` before 16212 (the typedef at host.js:190).
3. `canvas_state` gains `hasSelection` (informational) and `named_refs`; the node ignores both until its next release.
4. 26a1's resolver is exported as `_resolveMarkers` for the shared test vectors (renderer twin in `comfyrefs.js`).
5. Clarification: comfy `refs.slots` counts pictures, the crop included.

### Estimate and commit message
About 1 day: graphs 1 h, `comfyrefs.js` 3 h, `queueGenerate` and host 2 h, Info panel 1 h, tests 2 h, docs 1 h. It shares a session with 26f. Commit as DenRakEiw (`git -c user.name=DenRakEiw -c user.email=89697885+DenRakEiw@users.noreply.github.com`), no trailer:

`Item 26 step 26e: local ComfyUI recipes resolve @img tokens to the picture's name in the batch (Qwen 2.1 <imageN>, 10 slots; Klein image N, 4 slots), trim unused slots, refuse past them, and the Info panel counts the refine pass`

## 26f: Generate new with references

### Read first: corrections from the review (they win over the text below)

- The run helper is C3's `host.refPrompt(editor, snap, "edit", {prompt, negative, sent: refIds})` (no `resolveRun`).
  Caps and drops come from main: this step extends `refs.checkPictures` to kind text (max and drops from the text
  layout, `original` must be 0) and `refs.instruction` with the no-crop form ("Image 1 is a reference image." /
  "Images 1 to 3 are reference images."), with literals in `refs_layout_test`.
- `runGenerate`'s route `"none"` becomes `"edit"` when the variant has `text.refs`, and a refusal of live tokens when
  it has none (section 7). Upscale keeps `"none"`. Remove 26b2's name substitution in the Generate new prefill
  (`shell.js:1088`).
- `refName`: `(t.refs && t.refs.name) || (r.refs && r.refs.name) || null`; `textVariant` checks `text.refs.name` with
  `validRefName`.
- The dialog's names come from `host.refLayout(genEditor, {kind: "text", provider, model, original: 0})` (C3), not a
  direct IPC call and no `fill`.
- PromptField per C4: `new PromptField({placeholder, refs: () => ({...genEditor.refContext(), names of the dialog's
  layout}), popupRoot: ui.gen, addReferences, preview})` and `new RefBar(field, {mount: document.getElementById
  ("gen-refbar")})`. Delete contract change 3.
- The remap target is `genEditor.addRemapTarget(field)` (C2). Delete contract change 2's `{get, set}`.
- Upsampling in the dialog (taken over from 26d1 sub-task 7 and 26d2 sub-task 4): `host.askLLM(backend, instr, null,
  await host.llmPictures(genEditor, refs))` with the **named** references (C5). Delete contract change 5.
- `generate_new` returns `info: out.info` (the test reads `out.info.references`).
- Flip 26a1's `refs_layout_test` §6 and 26c's `canAdd` (true in an empty tab when `host.refTokens`).
- `dialog_field_and_bar` adds: a click on a chip's chevron inside the dialog leaves `ui.gen.open` true.
- The Replicate `match_input_image` bug is filed in `docs/BUGS.md` (2026-09-29); mark it fixed here.

### Goal and done when

Generate new sends the visible reference layers along with the prompt whenever the chosen text variant takes pictures. There is no crop, so `@img1` becomes "image 1". The answer replaces the base, but the reference layers are no longer thrown away. The step is done when all of these hold:

- A loopback text run with two visible references sends exactly those two, in `referenceLayers()` order.
  - Its resolved prompt contains "image 1" and "image 2" and no `@img`.
  - Afterwards both reference layers are still there with the same ids, order, visibility and pixels. Every other layer is gone, as it is today.
- Every shipped variant either declares `text.refs` or is on the test's "takes none" list.
  - Each adapter's text branch sends the references only (no crop, no "Edit the first image") at the size that was asked for. A fake-fetch test pins this.
  - With 0 visible references, every request is byte for byte what it is today.
- The Generate new dialog uses 26c's PromptField and reference bar.
  - Each chip says what that reference is sent as, for the dialog's own model, provider and mode.
  - Upsampling in the dialog carries `{references}` and the token rule, and also the pictures while 26d2's setting is on.
- `generate_new` takes `refs` and keeps references on the local path too.
- `add_image_layer role:"reference"` works in an empty tab.

### Sub-tasks in build order

1. **`text.refs` in the recipes** (`electron/main/recipes.js`).
   - Add `refs` to the `TextShape` typedef (lines 62-68).
   - `textVariant()` (237-252) normalises `t.refs`:
     - absent or `false` gives null;
     - `true` gives `{}`;
     - an object gives `{ max: int>0|null, field: string|null, model: string|null, options: object|null, name: string|null }`;
     - anything else is logged and becomes null.
   - A patch script (Write tool, the `patch()` helper, `newline=chr(10)`) merges `"refs"` into each variant's `text` object according to the table below.
   - `max` is left out wherever the text route's cap equals the edit cap from 26a2, because the crop's slot becomes a reference slot.

| Recipes | Variants with `text.refs` (the route a text run with references goes to) |
|---|---|
| FLUX.2 pro, flex, max | bfl, replicate, toapis, openrouter, comfyrouter, magnific: same model. fal, wavespeed: `model` = the edit route (`fal-ai/flux-2-pro/edit` …), and fal also gets `options: {sizing: "image_size"}`. oxen: `model` = the edit id (the route becomes `/images/edit`) |
| FLUX.2 klein | bfl; fal and wavespeed on the edit route; oxen |
| GPT Image 2, 2.5 | openai (the adapter switches to `/images/edits`), toapis, replicate, openrouter, comfyrouter, oxen: same model. fal (gpt_image_2), wavespeed, magnific: `model` = the edit route |
| Nano Banana 2, Lite, Pro | gemini, toapis, replicate, openrouter, comfyrouter, oxen: same model. fal, wavespeed: the edit route |
| Seedream 4.5, 5 lite, 5 pro | ark, toapis, replicate, openrouter, comfyrouter, oxen (5 pro): same model. fal: edit route, `options: {sizing: "image_size"}`, `max: 10` (fal's page: "only the last 10 are used"). wavespeed and magnific: the `-edit` route |
| Qwen Image Edit | toapis, comfyrouter, oxen (3); wavespeed `edit-plus` |
| Qwen Image 2.1, HY Image 3.5, Grok Imagine | oxen (10); comfypartner (5); fal edit route, openrouter (3), oxen edit id (1) |
| None | flux1_fill, ideogram_4, ideogram_inpaint, krea_2, recraft_v4, z_image, z_image_turbo, mystic (its style / structure references come later, PLAN_REFS §6), expand_*, lama_remove, qwen_image_edit on fal (inpaint) and replicate (one image field), every comfycloud variant (no text shape), comfyrouter xai / ideogram / krea, reve (until WaveSpeed's edit-route cap has been read; then add it) |

   Why these routes: BFL's FLUX.2 endpoints take `input_image` .. `input_image_8` as optional fields next to `width` / `height`. OpenAI's `/images/edits` takes up to 16 `image[]` and a free `size`. OpenRouter's `/api/v1/images` takes `input_references` on any model whose endpoint lists them. Magnific's `seedream-v5-pro-edit` requires 1 to 10 `reference_images` and renders the asked `aspect_ratio` whatever shape the pictures have. fal's edit routes take `image_urls` with `image_size` or `aspect_ratio`, and their text-to-image routes take no pictures.

2. **Pictures of a text run.** In each helper below, a text run's pictures are its references, labelled `reference N`, checked by the same count, ratio and byte rules.
   - The helpers: `picturesFor` in comfyrouter.js (200; it is shared with magnific and comfypartner), openrouter.js (216), ark.js (159), oxen.js (185), and `prepareFiles` in toapis.js (225-227).
   - For a text run the refusal names references only: "… takes at most 8 reference pictures for a new image; this run has 9: hide reference layers."
   - Then remove the six clears for kind `"text"`: openrouter 355, ark 292, magnific 643, comfyrouter 609, comfypartner 119, oxen 458. The upscale clear at oxen 458 stays.

3. **Adapter text branches.** With 0 references each branch builds today's request.

   | Adapter | Change for a text run with references |
   |---|---|
   | `bfl.js` `bodyFor` (18) | `input_image`, `input_image_2..8` from the references |
   | `fal.js` `inputFor` (31) | `image_urls` (or `fields.images`), sized as `options.sizing` says |
   | `replicate.js` `inputFor` (42) | the references into `fields.images \|\| "image_input"` |
   | `wavespeed.js` `inputFor` (61) | uploads into `images` (the closest `aspect_ratios` preset already applies) |
   | `openai.js` `generate` (122) | switches to the multipart `/v1/images/edits` call: `image[]` = the references, no mask, `size` from `sizeFor(model, w, h)` |
   | `gemini.js` (24-38) | parts: text, then 26a2's label part and `inline_data` per reference |
   | `toapis.js` `run` (396) | uploads the references into the channel's image field |
   | `openrouter.js` `bodyFor` | `input_references` = the references; `aspect_ratio` stays (301) |
   | `ark.js` | `image` = the references; the text `sizeFor` stays |
   | `comfyrouter.js` dialects | openai (262): `image` = the references, no mask. vertexai (290): a text branch without the "Edit this image" sentence, with label parts. bfl (327): `input_image..`. byteplus (356): `image`. qwen (373): content images plus the text |
   | `comfypartner.js` `run` (110) | `pics` = the references; `resolveRefs(prompt, pics.length)`; `resize_max_pixels` set |
   | `oxen.js` `run` (445) | route `/images/edit` when there are pictures, `bodyFor` (282) writes them for text too, `aspectFor`'s text branch |
   | `magnific.js` | `refs: true` in `ROUTES` (81) on the flux2 routes and the seedream / gpt `-edit` routes; `run` (638) refuses kind text only when `!R.text && !(R.refs && req.references.length)`. flux2 (346): `input_image..`. seedream (368): `reference_images` with `preset(...textShape(req))`. gpt (390): `reference_images` with the preset from `textShape`, never `"auto"` for text |
   | `loopback.js` `generate` (128) | `info.references` (26a1 adds `prompt`) |

   - Replicate also has a bug found while reading `replicate.js` 42-60: for kind text it drops a fixed `aspect_ratio: "match_input_image"` in favour of `req.aspect`. Today every Replicate FLUX.2, Nano Banana and Seedream text run sends `match_input_image`, because `providerParams` includes `r.fixed` and the params loop overwrites `input.aspect_ratio`.
   - Every adapter that writes a sentence uses 26a2's one preamble helper in `util.js`, in its no-crop form ("Image 1 is a reference image." / "Images 1 to 3 are reference images."), appended after the prompt.

4. **`layout(req)` for kind `"text"`** (every adapter's `layout` from 26a1, and the default in `index.js`):
   - `pictures` = the references with `n = i + 1`, role `reference`, and the field of the text route.
   - `max` = `text.refs.max ?? the edit cap` (per ToAPIs channel through `channelOf`).
   - `drops` = "this model takes no reference images for a new image" when it has none.
   - `edit()` in `index.js` (87) refuses `original: 1` together with kind `"text"`.
   - `provider:layout` answers kind `"text"` for whatever model the caller names.

5. **The editor keeps references** (`renderer/editor/inpaint_canvas.js`).
   - Extract `referenceBox(px, k)` from `addImageLayers` 12066-12070: a third of the canvas, offset `16 + (k % 8) * 24`. `addImageLayers` behaves exactly as before.
   - `setBasePixels` (13300) gets the option `keep` (layers). In the branch at 13311, `this.layers = keep ? keep.slice() : []`, and each kept layer is placed again with `referenceBox(l.px, k)` in list order when the size changed. This happens before `scheduleDetachedRelease()` (13324), so the tile release sees the kept pixels as live.
   - `setBaseFromCanvas` (14133) becomes `{ keepLayers = false, keepRefs = false }`.
     - It passes `keep = this.layers.filter(isReference)` (hidden references included) and clears the rest as at 14139-14146.
     - It returns `{ width, height, kept, dropped }`.
     - Afterwards it calls 26b's map rebuild: the ids and the order are unchanged, so nothing is rewritten.
   - `newCanvas(size, { keepRefs = false } = {})` (14156) does the same at 14189-14196. Its confirm text (14158) says "reference layers stay".
   - `addImageLayers` (12025) gets the option `blank` (default `role === "reference" && host.refTokens`). When `!this.width`, it runs `await this.newCanvas("1024x1024")` instead of the `loadFile` at 12028, so a reference never becomes the picture.

6. **`stitch.js`: `referenceBytes(editor, ids)`.** It reads `editor.layerPixels(l)` for exactly those ids, synchronously, then runs `canvasBytes`. This is the pattern at 726-733; reuse 26b's `opts.refIds` helper if 26b extracted one.

7. **`host.runGenerate`** (`host.js` 1217-1259):
   ```js
   const snap = editor.refSnapshot();                      // C3, before any await
   const refIds = t.refs ? snap.refIds : [];
   const run = this.resolveRun(editor, { kind: "text", prompt, negative, snap, refIds, original: 0,
       takesRefs: !!t.refs, max: t.refs && t.refs.max });   // 26b's helper: markers or a refusal
   const references = refIds.length ? await referenceBytes(editor, refIds) : [];
   const withRefs = references.length > 0;
   request = { ..., model: withRefs && t.refs.model || t.model, kind: "text", prompt: run.prompt, negative: run.negative,
       references, original: 0, refName: (t.refs && t.refs.name) || r.refName,
       options: withRefs && t.refs.options ? { ...(r.options || {}), ...t.refs.options } : r.options || null };
   ...
   const kept = await editor.setBaseFromCanvas(c, { keepRefs: true });
   ```
   - First, refuse on `editor.turnBlocked()` and on `editor.providerPending`, as `runUpscale` does at 1123. Otherwise an edit run that lands later would fall onto the new geometry.
   - The status line gives the pictures sent, the arrows `@img1 -> image 1` taken from `res.prompt`, and "the reference layers stay, N other layers were replaced".
   - It returns `references`, `prompt`, `kept`, `dropped` and `info`.

8. **`renderer/commands.js`.**
   - `generate_new` (624-666):
     - New param `refs` (`{"img1": "<layer id>"}`, as 26b's `set_prompt`). It is remapped with `reftokens.remap(prompt, agentMap, labelMap)` before `setPromptText`, and unknown ids are refused.
     - The return adds `references: [{label, id, sentAs}]`, `prompt` (the resolved one), `kept` and `dropped`.
     - The local path (658) becomes `ed.newCanvas(\`${w}x${h}\`, { keepRefs: true })`. `flatten` keeps references already (15312).
     - The description changes to "…replaces the image and the layers except the reference layers; the visible ones go along where the model takes reference images".
   - `add_image_layer` (445): `needsImage: false`. Its `run` throws `requireImage`'s message when `role !== "reference"` and there is no base, and otherwise passes `blank: true`.
   - `list_recipes` (383): add `textRefs` (the max, or 0) for the chosen variant.

9. **The dialog** (`renderer/index.html` 201-235, `renderer/shell.js` 882-1160).
   - `index.html`:
     - 214: the textarea becomes `<div id="gen-refbar">` and `<div id="gen-prompt-host">`.
     - 204: the help text becomes "…replaces the image and its layers; reference layers stay and go along to a model that takes them".
   - `shell.js`, at module init (66): mount `new PromptField(host, { id: "gen-prompt", references: () => genRefs, onAdd: genAddReference, placeholder })` and 26c's bar on `#gen-refbar`, then set `ui.genPrompt = field.el`.
   - `genSyncRefs()` builds `genRefs` from `genEditor`'s descriptors, with `sentAs` from `window.scumble.providers.layout({ provider, model: v.text.refs?.model || v.text.model, kind: "text", fields, options, params: {}, fill: "none", original: 0, count })`.
     - In local mode it uses 26e's local names instead (the white canvas is picture 1).
     - It is called from `openGenerateNew` (1069), `genFillProviders` (946), the mode, recipe and provider listeners (1106-1108), and after an add.
     - A variant without `text.refs`: the chips turn inactive ("this model makes pictures from the prompt alone"), and the bar says "N reference layers stay in the tab; none go along".
     - Over the cap: the warning state from 26c.
   - `genAddReference`: a file input, then `genEditor.addImageLayers(files, "reference", { blank: true })`, then `genSyncRefs`.
   - The prefill (1088) keeps the tokens. 26b's layer-name substitution is taken out here; the upscale prefill (1297) keeps it.
   - While the dialog is open, its field is a remap target on `genEditor` (registered in `openGenerateNew`, disposed on the dialog's `close`), so a hide or a reorder coming from an agent renumbers it.
   - `ui.gen`'s `cancel` handler calls `preventDefault()` and closes the `@` picker first when it is open. The keydown at 1111 stays.
   - Upsample (1113-1130):
     - Record the label map, then call `genInstruction(text)` (1036). It passes `ctx.references` to `fillPromptTemplate`, and the built-in rewrite (1041) gets 26d1's references sentence and token rule.
     - Pictures: 26d2's `images` (the visible references, long side at most 512, at most 6) while the setting is on.
     - The answer is remapped, then checked with `reftokens.compare`. A dropped token, an invented one or a literal `image N` puts a note with a Revert button in `#gen-upsample-note`. The text before the rewrite is kept in `genPrevious`.
   - Go (1131-1160): `args.refs` = the dialog's label map at the click; refusals appear in `#gen-state`.

10. **The rest.**
    - `electron/main/assistant/policy.js` 116: "renders a new base image, replaces every layer but the reference layers and clears the undo history".
    - Re-read the `{references}` lines 26d1 wrote into `photographic.md`, `rich-scene.md` and `tags.md`. Adjust only a sentence that assumes an edited picture.
    - No new module and no new host member: `prompt_field.js` is already in `FILES` since 26c, and `host.refTokens` exists.

### Interfaces this step defines or consumes

- **Defines:**
  - `text.refs {max?, field?, model?, options?, name?}`;
  - `layout(req)` for kind `"text"`;
  - `setBasePixels(ref, px, {keepLayers, keep})`;
  - `setBaseFromCanvas(c, {keepLayers, keepRefs}) -> {width, height, kept, dropped}`;
  - `newCanvas(size, {keepRefs})`;
  - `addImageLayers(files, role, {place, at, blank})`;
  - `referenceBox(px, k)`;
  - `referenceBytes(editor, ids)`;
  - `generate_new {refs}` and its new return fields;
  - `list_recipes[].textRefs`;
  - `add_image_layer` in an empty tab.
- **Consumes:**
  - from 26b: `reftokens` (C1), `refSnapshot`, the run helper, `setPromptText`, the map rebuild;
  - from 26a1: markers, `provider:layout`, `refName`, the resolved prompt `res.prompt`;
  - from 26a2: the caps, the preamble helper, the label parts;
  - from 26c: PromptField and the bar;
  - from 26d1: `{references}` and the rule;
  - from 26d2: `images` (assumed as `host.askLLM(backend, instruction, canvas, { images })`);
  - from 26e: the local resolution and names.

### Edge cases

- **No visible references, or a variant without `text.refs`:** the old text model and body, unchanged. A live token on such a variant is refused ("this model makes pictures from the prompt alone: take @img1 out, or pick FLUX.2, GPT Image, Nano Banana, Seedream …"). A parked token is refused on every variant.
- **Hidden references:** kept, not sent, not counted (decision B).
- **Visible references the prompt does not name:** sent anyway, as Generate does. The bar shows the count before the click.
- **More than `max`:** refused before anything is paid for; nothing is cut silently.
- **Non-reference layers** (images, results, text, filter and control layers): replaced as today. The status line counts them.
- **A size change:** references are re-cascaded into the new canvas. Their masks, opacity and visibility stay.
- **Tiles:** the kept pixels are in `this.layers` before the detached-release microtask, so no atlas page is freed.
- **Undo:** cleared as today. The label map is the same, so the prompt is not touched.
- **Empty tab:** a reference gets a white 1024 × 1024 canvas that Generate new then replaces. `add_image_layer role:none` is still refused there.
- **Local path:**
  - The white canvas is image 1, so `@img1` resolves to image 2 (26e's rule, shown in the chips).
  - With Fill on and Original on, a white Original copy takes a slot; the chip names shift accordingly.
- **Magnific GPT 2.5 on the edit route:** never `"auto"`/1k for a text run.
- **Seedream on Magnific:** pictures under 256 × 256 are refused (the 169 check).
- **Replicate:** the aspect goes out as `req.aspect`.
- **A reorder or hide by an agent while the dialog is open:** the field is remapped. Go sends the click's `refs`, so a change after the click is refused rather than re-pointed.

### Tests

- **Light (plain Node):**
  - `node tools/refs_layout_test.js`, a new section "text runs". For every adapter and dialect in sub-task 3, a text request with 2 references through fake fetch. It asserts:
    - the endpoint (fal queue URL ends in `/edit`; OpenAI `/v1/images/edits` with two `image[]` and no `mask`; Oxen `/images/edit`; Magnific `-edit`);
    - the picture order equals the references and equals `layout(req).pictures`;
    - no "Edit the first image";
    - the asked aspect or size (Replicate ≠ `match_input_image`; Magnific gpt ≠ `auto`);
    - the preamble;
    - 0 references gives today's body;
    - `max + 1` gives a refusal with no fetch.
  - `node tools/recipes_test.js`, a new section "text.refs": every shipped variant against an expected table (route, max), the takes-none list, `true`, `false`, and a bad value.
  - `node tools/reftokens_test.js`: text markers (`@img2` with 3 visible → `{@ref:1}`, hidden and parked refused).
  - `node tools/assistant_test.js`.
  - Adapter gates, run in this order (each refuses a keyed profile):
    ```
    bash tools/run_gates.sh r26f-api --offline --tiles on toapis openrouter ark comfyrouter oxen magnific recipes
    ```
- **Normal:** `tools/generate_test.py` gets new steps.
  - `refs_in_an_empty_tab`: `new_document`, then `add_image_layer {filename: "test_base.png", subfolder: "inpaint_canvas", role: "reference"}` gives a 1024 × 1024 base with 1 reference. `role:"none"` in a fresh tab throws "no image loaded".
  - `text_with_references`:
    - Set up a paint layer and two references, and loopback `text: {model: "loopback", refs: {}}`, `refName: "image {n}"`.
    - Run `generate_new {prompt: "the jacket of @img2 on the person of @img1", aspect: "16:9"}`.
    - `out.info.references === 2`; `out.prompt` contains "image 2" and "image 1" and no "@img".
    - The reference ids and order are unchanged, the paint layer is gone, `ed.promptText` is unchanged, and the references' boxes lie inside 1024 × 576.
    - The reference pixels are the same (a `readRect` sample before and after).
  - `hidden_reference_not_sent`: `info.references === 1`.
  - `refuses`: `refs: {max: 1}` with 2 visible gives the cap message. `text` without `refs` plus a token gives "prompt alone". Without a token it runs, the references are kept, and `info.references === 0`.
  - `local_keeps_refs`: `ed.newCanvas("512x512", {keepRefs: true})` keeps the references and places them. The live ComfyUI run is left out (8188 is production).
  - `dialog_field_and_bar`:
    - `#gen-prompt` is contenteditable, and `.value` holds the tokens.
    - The bar has 2 chips with sentAs "image 1" / "image 2".
    - A variant without refs shows the inactive note.
    - `@` via `insertText` then `cancel` closes the picker, not the dialog.
  - `dialog_upsample_refs`:
    - Stub `host.upsampleBackends` and `host.askLLM`, then click `#gen-upsample-go`.
    - The instruction contains the `{references}` line and the rule.
    - An answer that drops `@img2` shows the Revert note.
  - The existing step `api_text_to_image` still passes (no layers).

  ```
  bash tools/run_gates.sh r26f --offline --tiles on generate commands lint types nodecopy
  bash tools/run_gates.sh r26f-cv --offline --tiles off generate
  ```
  The canvas-backend run covers layer lifetime across a base swap. After a dev instance, run `python tools/commands_doc.py`.

### Docs

- `docs/RECIPES.md` "Generating without an image" (248-265): `text.refs`, the table, the route switch, `false`.
- `docs/MANUAL.md` 145 and the Generate new passage: references stay and go along, the empty-tab canvas.
- `docs/COMMANDS.md` regenerated.
- `docs/MCP.md`: `generate_new`'s `refs`.
- `docs/TESTING.md`: the new steps.
- `docs/BUGS.md`: the Replicate `match_input_image` on text runs (found here, fixed in sub-task 3).
- `docs/PLAN_REFS.md` §4: 26f built.
- The CHANGELOG at release.

### Risks and open points

- **Not verified live:** edit routes used as generators from references only (fal, WaveSpeed, Oxen, Magnific `-edit`), and the fal Seedream `image_size`. They may refuse without their "main" picture, and they may cost more than the text route; the bar note says input pictures may be billed.
- **Open for the user:**
  1. A token on a model without references: refuse (recommended) or write the layer names?
  2. The white 1024 placeholder canvas in an empty tab.
  3. Sending visible but unnamed references.
- **Escape in the dialog:** Chromium's close watcher may make `cancel` not cancelable without user activation. The fallback is a keydown `preventDefault` while the picker is open.
- **26c's API:** if 26c binds PromptField to the editor and its recipe, the options source has to be added (see Contract changes).

### Contract changes

1. `text.refs` becomes `{max?, field?, model?, options?, name?}`. `model` and `options` are new, for routes whose text endpoint takes no pictures. `max` defaults to the 26a2 edit cap. `true` is accepted.
2. C2: the remap targets also cover registered extra targets: `editor.addRemapTarget({get, set}) -> dispose`, used by the dialog's field.
3. C4: PromptField takes `references: () => descriptors` and `onAdd` as options, so the dialog supplies `sentAs` for its own model.
4. C3, made precise: after 26f Generate new is no longer a run that writes layer names. A text variant without `text.refs` refuses a live token; upscale is unchanged.
5. If 26d2 did not add it: `host.askLLM(backend, instruction, canvas, { images })`.

### Estimate and commit message

1 to 1.5 days (the table patch and the adapters about half a day, the editor and commands about a quarter, the dialog and its tests the rest).

`Item 26 step 26f: Generate new with references (text.refs per variant, the reference layers kept on a new base, the dialog's field and bar)`
