# P-H3-Image: a local recipe, Comfy Cloud and WaveSpeed (for 0.1.52, branch `ph3` off `corridorkey`)

**The design in fifteen lines.** P-H3-Image is Pruna AI's 8-step image fine-tune of MiniMax H3 (2026-11-03), run by
ComfyUI 0.44 on its own nodes. (1) `recipes/p_h3_image_local.json` is Comfy's templates' LoRA route: the user's
`minimax_h3_fl2va_pruned_int8_convrot` -> `LoraLoaderModelOnly` P-H3-Image LoRA 1.0 -> `MiniMaxH3SigmaShift` 1/1 ->
`BasicGuider`, `PH3ImageConditioning` (crop as `images.image_1` at the Megapixels row, 4 MP; Original and references as
`image_2..8`; width / height linked to the scaled crop) -> `SamplerCustomAdvanced` on Pruna's 8 `ManualSigmas`, `euler`.
(2) `comfyrefs.js` learns `PH3ImageConditioning` (slots numbered by rank, `<Picture {n}>`), so tokens are named and
unused slots trimmed. (3) The upsampler is generalised, not forked: `upsampler.run` may be a `TextGenerateV2`, and
`upsampler.request` (edit / picture / t2i / aspects) replaces BFL's text and its ordinals; Klein declares none and goes
exactly as before. Pruna's own requests are used (its edit's raw chat block with one `<Picture N>` per picture, its
t2i "Aspect ratio / Request"), since those are what the upsampler was trained on. (4) Generate new is real text to
image through one declared field, `newImage: { drop: ["cond|images.image_1"] }`, applied only when no picture goes
after the crop (the upsampler's own t2i condition); with the size linked to the scaled white crop, the node then makes
a latent of the canvas's aspect. No other recipe declares it. (5) `recipes/p_h3_image.json` (WaveSpeed, written from
its schema) and `recipes/cloud_p_h3_image.json` (Comfy's two templates through `tools/cloud_recipes.js`) are the API
side; neither is run. Each recipe carries the MiniMax H3 licence line and "Powered by MiniMax H3".

## 0. The record

- **The user, 2026-11-06:** a P-H3-Image recipe. On the research's licence finding (the MiniMax H3 Community License
  excludes the EU, the UK, South Korea and the US): "Die Lizenz ist ein Hindernis... nein achte nicht auf die license
  [...] bin ja auch noch in asien ;)" (an emoji left out). So the recipes ship with one plain line, in the recipe
  descriptions, `docs/RECIPES.md` and the manual: "P-H3-Image is under the MiniMax H3 Community License, which does not
  cover use in the EU, the UK, South Korea or the US without a separate licence from MiniMax
  (platform.minimax.io/h3-license)." "Powered by MiniMax H3" (III.3.a: encouraged, not required) and the licence's
  NOTICE sentence go in the descriptions too; Scumble ships no weights, so III.4's NOTICE file is not Scumble's to ship.
- **Decided by the main session:** the LoRA route on the user's FL2VA int8 file (the four P-H3 files were being
  downloaded from `PrunaAI/P-H3-Image-Comfy` into the user's models folder); `loras.model` at the embedded LoRA node;
  core nodes only, per the official graphs; `euler` (Pruna's) with Comfy's `er_sde` as a preset; 4 MP edits with a
  Megapixels row; the three code gaps of `docs/research/p_h3_image_2026-11-06/providers_scumble.md`; a WaveSpeed
  variant on the Nano Banana 2.1 pattern; a Comfy Cloud variant from `image_p_h3_image_edit` / `image_p_h3_t2i`; no
  live run in this workflow (the user's ComfyUI is stopped and a production machine).
- Research: `docs/research/p_h3_image_2026-11-06/` (model, ComfyUI, providers and Scumble's gaps; read 2026-11-06).

## 1. What the user gets

- **P-H3-Image (ComfyUI)**: an instruction edit of the selection with up to seven more pictures, each named `<Picture
  N>` (an `@img` token is written so), at 4 MP (8 with the preset, more memory); *Generate new* without reference layers
  is a text-to-image run at the canvas's aspect. Pruna's prompt upsampler (row 7, on by default) writes the prompt out
  first; without its file the prompt goes as typed and the node puts "Edit <Picture 1>." in front. A missing model,
  LoRA, text encoder or VAE refuses the run with its download link. The user's own LoRA rows go after the P-H3 LoRA.
- **P-H3-Image (Comfy Cloud)**: Comfy's two templates unchanged, on the Comfy Cloud key; the edit takes the crop alone,
  *Generate new* goes up to 2912 px a side.
- **P-H3-Image** (API, WaveSpeedAI): edits with up to eight more pictures and new pictures, 1k to 4k (2k by default).

## 2. The design

### 2.1 The local graph

Pruna's and Comfy's graphs (research `comfy.md` §3) agree on everything but the sampler and the base: the user's FL2VA
int8 file plus the 2 GB LoRA is the route Comfy Cloud's templates take, and the cheapest download (about 17 GB with
the upsampler). Pruna's ComfyUI node only scales down, and Pruna advises 4 MP edits; the Inpaint Canvas node's crop
size is the user's global Settings › ComfyUI value (`nodeParams.target_size`, 1024 by default, which overrides the
recipe's), so the graph scales the crop to the Megapixels row (`scale0`, lanczos, steps of 32) and the stitch fits the
answer back. The other pictures go unscaled (the crop's size): the node scales them down to the area only. Linking
`width` / `height` to `GetImageSize(scale0)` changes nothing for an edit (0 means image_1's size) and gives Generate
new the canvas's aspect at the same area.

### 2.2 Generate new

The fresh canvas is a white crop (`generate_new`'s local path); `trimSlots` never removes batch 0, so without a change
P-H3 would get "Edit <Picture 1>." on a white picture. A second, `edit: false` recipe would double the Settings rows,
the LoRA rows and the downloads; a declared drop keeps one recipe and touches nothing else: `newImage.drop` names
`cond|images.image_1`, `host.queueGenerate` applies it after `trimSlots` when `fresh` and no Original or reference
goes. With reference layers the crop stays Picture 1 (the numbering of the others stays as `comfyLayout` writes it).

### 2.3 The upsampler

`wireUpsampler` keeps BFL's branch byte for byte; a declared `request` takes a branch of its own: the prompt as written
(no `ordinalNames`), the edit text with `{pictures}` (count `1 + original + kept`, passed by the host as `pictures`),
the t2i text with `{aspect}` snapped to `request.aspects`, the run's picture inputs removed on t2i (`image` or
`images.imageN`). `request.verbatim` (`match`, `drop`) copies the node's own check: a prompt that already starts "Edit
<Picture N>" (or is an upsampler brief, `subject_definitions:`) gets the edit text without the request's "Edit <Picture
1>. " lead. `localUpsampler` accepts `TextGenerateV2` and checks the request. The class check names the run's own
class. `TextGenerate` is deprecated in 0.44 (still registered); Comfy's own P-H3 templates use `TextGenerateV2`.

### 2.4 The API side

WaveSpeed: `wavespeed-ai/p-h3-image/edit` (images 1-9) and `/text-to-image`; `accepts` without `aspect_ratio` on an
edit (it follows the first picture), `text_accepts` with it; the schema's `additionalProperties: false` means the
allowlist must also drop the negative. Comfy Cloud: the templates through `tools/cloud_recipes.js`; the prompt role
needed `detectRoles` to read a `...Conditioning` node's `prompt` input (no other shipped Cloud recipe changed:
`--check`).

## 3. As built (2026-11-06)

**Built:** `recipes/p_h3_image_local.json`, `recipes/p_h3_image.json` (WaveSpeed), `recipes/cloud_p_h3_image.json`
(generated; the exports `tools/refs/comfy_cloud/edit/image_p_h3_image_edit.json` and `t2i/image_p_h3_t2i.json`, the
research's copies of `cloud.comfy.org/templates/<name>.json`, MIT); `tools/refs/comfy_templates/object_info.json` gains
`PH3ImageConditioning`, `MiniMaxH3SigmaShift`, `ManualSigmas`, `TextGenerateV2` (written from the V3 schemas of the
user's ComfyUI 0.44.0 on disk, matching Comfy Cloud's `get_node` record; 97 classes).
`renderer/editor/comfyrefs.js`: `byRank`, `PH3ImageConditioning`. `renderer/editor/comfyprompt.js`:
`upsamplerRequest`, `nearestListedAspect`, the request branch of `wireUpsampler` (`o.pictures`), `dropForNewImage`.
`renderer/editor/host.js` `queueGenerate`: `refsGo` once, the drop after `trimSlots`, `pictures` to the upsampler.
`electron/main/recipes.js`: `localUpsampler` (TextGenerateV2, `request`), `localNewImage`, `normalize`, `GRAPH_KEEPS`
`newImage`, the typedefs, `detectRoles` (a `...Conditioning` node with a `prompt`). `tools/cloud_recipes.js`: the row.
Docs: `docs/RECIPES.md` (`request`, `newImage`, the shipped entry, the Cloud list, the caps and text tables),
`docs/MANUAL.md`, `README.md`, `docs/TESTING.md`, the CHANGELOG's Unreleased line. Tests: `tools/ph3_test.js` (new),
`tools/generate_test.py` (a step), `comfyrefs_test.js`, `comfyprompt_test.js`, `recipes_test.js`, `loras_test.js`.

**Deviations, each by the code:**
1. **No `loras` on the Cloud variant**: the template's LoRA is `19` in the edit graph and `29:19` in the text graph, so
   one declaration warns on the other route; the generic rule finds the `UNETLoader` in both (the `cloud_anima_base`
   precedent), and the user's rows go before the template's LoRA there (LoRA deltas add, the order does not matter).
2. **The upsampler's edit request is Pruna's raw chat block**, not the Cloud template's "Aspect ratio / Request" for
   edits: it labels each picture `<Picture N>`, which the default template of `TextGenerateV2` does not, so a prompt
   naming `<Picture 2>` reaches the upsampler with the picture it names. `thinking` is on in the graph (Pruna's t2i;
   ignored for the raw edit text, which opens `<think>` itself), `max_length` 3072 for both.
3. **References go unscaled** (the research's sketch scaled each): the node scales them down to the edit's area.
4. **`detectRoles`** reads a `...Conditioning` node's `prompt` (the Cloud edit template had no prompt role otherwise:
   `PH3ImageConditioning` matched neither `Encode` nor `Text`).

**Tests (all green):** `node tools/comfyrefs_test.js` 104 of 104 (the P-H3 spec, rank, trim, `<Picture 3>` after the
Original, the upsampler not counted); `node tools/comfyprompt_test.js` 101 of 101 (Klein's branch unchanged with a
picture count; P-H3's edit block with three pictures, `<Picture N>` kept, t2i with 1.85:1 snapped to 16:9 and no
picture input, the row off, the file and `TextGenerateV2` missing; `dropForNewImage`); `node tools/recipes_test.js`
278 of 278 (refs names, text.refs 112, detach row, fourteen Cloud recipes, the upsampler and `newImage` kept, eleven bad
declarations dropped, Save to recipe); `node tools/loras_test.js` 59 of 59 (the declared `lora` source before `shift`,
the Cloud routes by the rule); `node tools/ph3_test.js` 17 of 17 (new: the WaveSpeed bodies against the schema's
fields); `node tools/cloud_recipes.js --check` ok, 14; unchanged and green: openrouter, comfyrouter, toapis, settings
migration, cloudgraph, comfycloud v2, genpresets, refs layout, ideogram45, nanobanana21, wavespeed text, boxes, flux3,
easteregg. `npx eslint .` 0 errors (the 21 warnings as before), `npx tsc --noEmit -p tsconfig.check.json` clean.
Gates on tiles (`--offline`, port 9573, the worktree's `dist/gates`): `ph3-a` generate (the new step
`p_h3_generate_new_is_text_to_image`), recipes, loras: ALL PASS; `ph3-b` boxes, metadata, lint, types: ALL PASS. No
mutation round, no canvas backend (Normal tier, no pixel path changed). No app instance on the user's ComfyUI.

**The review's findings (a reviewer agent, 2026-11-06), as finished:**
1. *should*, **fixed**: nothing checked the local graph's input names or model values against the node specs.
   `tools/ph3_test.js` §3 now does (`specProblems`: every class but InpaintCanvas has its spec in
   `tools/refs/comfy_templates/object_info.json`; required inputs there; every input one its class declares, a growing
   input by its template's names, a dynamic combo by its options' keys; combos other than model files in their options;
   numbers in range; links to nodes of the graph), on the recipe as `normalize()` serves it and on two queued shapes
   (Generate new with the upsampler: no `images.image_1`, no picture on the run; an edit with the upsampler off). It pins
   Pruna AI's values (shift 1 / 1 after the LoRA, the eight sigmas exactly, `strength_model` 1, both `CLIPLoader`s type
   `minimax`, `euler`, `run.latent_image` = `["cond", 1]`, `guider.model` = `["shift", 0]`, `scale0` 4 MP in steps of
   32, width / height from the scaled crop) and proves itself on a broken copy (`shift_video` and `latent_image`
   renamed, `type` "minimax_h3", 40 MP, `images.image_10`, a link to no node: each caught).
2. *nice*, **fixed, differently**: Comfy Cloud's Generate new was capped at a 2048 px long side. The manifest row now
   has `sizes: [1024, 1536, 2048, 2560, 2912]`: up to the node's own text-to-image size (2912 a side, 8.5 MP; a 16:9 at
   2912 x 1632 is 4.8 MP). Not the suggested 3360, which gives 11.3 MP on a square, above Pruna AI's best 8 MP and the
   node's own default. `node tools/cloud_recipes.js` rewrote only `cloud_p_h3_image.json`; `--check` ok, 14.
3. *nice*, **fixed**: the manual and the CHANGELOG gave one picture count for all three routes; now per route (seven
   more on the user's ComfyUI, eight on WaveSpeedAI, the crop alone on Comfy Cloud).
4. *nice*, **not built, kept for the live run**: Generate new with reference layers sends the white canvas as
   `<Picture 1>` and the upsampler "Edit <Picture 1>.". Whether a blank first picture composes worse is a question of the
   model's output, which only the live run answers; renumbering the references from 1 shifts the tokens, the
   upsampler's blocks and the slots together (`comfyLayout`, `trimSlots`, the request) and is built only if the run
   shows it is needed (section 4). **The live run answered it (2026-11-06): not needed**, the blank first picture
   composes well (section 4).
5. *nice*, **fixed**: a prompt that already starts "Edit <Picture N>" got the lead twice in the upsampler's request.
   `upsampler.request.verbatim` (`{ match, drop }`, checked by `localUpsampler`: the pattern compiles, `edit` holds
   `drop`) copies the node's `PH3_IMAGE_EDIT_VERBATIM` (`^\s*(Edit <Picture \d+>|subject_definitions:)`, read in
   `comfy_extras/nodes_minimax_h3.py` of ComfyUI 0.44.0 on disk): such a prompt goes without "Edit <Picture 1>. ",
   trimmed, as the node does. Klein declares no request and is unchanged.

**Tests after the finish (all green):** `ph3_test.js` 23 of 23, `comfyprompt_test.js` 102 of 102 (the verbatim case),
`recipes_test.js` 280 of 280 (the verbatim kept, two bad verbatim declarations dropped), `comfyrefs_test.js` 104 of 104,
`loras_test.js` 59 of 59, `cloud_recipes.js --check` ok 14; openrouter, comfyrouter, toapis, settings migration,
cloudgraph, comfycloud v2, genpresets, refs layout, ideogram45, nanobanana21, wavespeed text, boxes, flux3, easteregg
green; eslint 0 errors (21 warnings as before), tsc clean. Gates on tiles (`--offline`, port 9573): `ph3-c` generate,
recipes, loras, boxes, metadata, lint, types: ALL PASS.

## 4. The live run (2026-11-06) and the open points

**Run live 2026-11-06** on the user's ComfyUI 0.44.0 (RTX 5090; the user's yes in chat; started for the run and stopped
after, the queue empty before and after), from this branch at `b4acf69` in a connected dev instance driven over CDP;
the numbers, the queued graphs and the pictures in `docs/measurements/ph3_live_2026-11-06/` (`summary.txt`). No fix
was needed: the recipe and the code ran as built.
- **Passed: the edit with the upsampler** (the default): "make the sky a warm sunset" on a rect over the sky gave an
  orange sunset sky and kept the building, the tree and the car (1.4 levels mean difference in the crop's lower 40 %);
  the stitch fitted the 4 MP answer back with no shift (the node's align "no gain"). 24.2 s warm (sampling 11 s).
- **Passed: `<Picture 2>` references**: `@img1` went as `<Picture 2>` (`prompt_sent`), the conditioning got
  `images.image_1` and `images.image_2` only, the upsampler's request two picture blocks; the bag of the reference
  landed on the sill, the facade kept (4.5 levels), the app's edge fit aligned it by under a pixel. 35.8 s (two
  pictures double the step time). The model has no mask and put the bag across the selection's edge, where the
  feather cut it: a selection with room is the user's part (the description says the stitch keeps the selection).
  Not run: `<Picture 3>` with the Original on.
- **Passed: Generate new**: without references a real text-to-image run at 16:9 (no picture in the conditioning or the
  upsampler, the request "Aspect ratio: 16:9"), 20.3 s. **Review finding 4 answered**: with a reference layer the
  white canvas goes as `<Picture 1>`, the upsampler calls it a blank canvas and the picture is the reference's bag on
  the asked table, nothing white left: no renumbering needed. 46.9 s against 20.3 s (the second picture's tokens).
- **Passed: `verbatim`**: a prompt starting "Edit <Picture 1>:" went without a second lead.
- **Passed: 8 MP** (the preset): 52.1 s (sampling 32 s, 4.1 s/it), no out-of-memory. **VRAM**: ComfyUI 0.44 stages
  every model "for dynamic VRAM loading" (MiniMaxH3 20.0 GB, the text encoder 4.9, the VAE 2.7, the upsampler 6.4) and
  fills the card to 31.5-31.8 GB in every run, 4 MP or 8 MP, swapping models in and out: the card's peak is not what
  the model needs, and none of the runs ran out.
- **The seconds**: cold (ComfyUI fresh, every model from disk, the files probably still in the OS cache) 22.2 s; warm
  16.9 s without the upsampler, 24.2 s with it; the first upsampler run 26.7 s.
- **Upsampler off: not an edit.** "make the sky a warm sunset" with the row off gave a new picture (a sunset over a
  city, nothing of the building; 63 levels mean difference): the prompt went as typed and the node put "Edit
  <Picture 1>. " in front. Pruna AI's card says short requests without the upsampler often redraw the scene; here the
  first try did. The description, RECIPES.md and the manual already say so; the row stays as built (on by default).
- **An empty prompt goes** (the driver's own slip, `set_prompt` with `prompt` for `text`, on two runs): without the
  upsampler the model redraws the crop; with it, the upsampler invents an edit (it replaced the car by a red sports
  car). Open: whether a P-H3 edit with an empty prompt should be refused (other recipes take one too; the user's call).
- Not checked live: the upsampler's file missing (the note and the plain run), the er_sde preset, a cold start with
  the files out of the OS cache, whether the LoRA route matches Pruna AI's own model files in quality (Pruna AI's
  claim, unverified).
- The Comfy Cloud recipe's upsampler gets the prompt without the template's "Aspect ratio" / "Request" frame (the
  prompt control held both), and edits at the crop's own size (about 1 MP); a Cloud-specific request would need the
  graph changed, which the tool does not do ("Comfy's template, unchanged"). Never run.
- Pruna AI's full model files (`p-h3-image_int8_convrot`, `_w4a8`) need the LoRA node out of the graph: a second recipe
  or a preset that cannot remove a node; not built.
- The Comfy Cloud copy of the local recipe (*Cloud copy*) does not carry `newImage`, so its Generate new sends the white
  canvas.
- The WaveSpeed variant has no upsampler on WaveSpeed's side that its schema shows; whether it expands short prompts
  is unknown (research `providers_scumble.md`). Never run.
