# Recipes

> Output resolution rows (`resolution`, `image_size`) default to **2K** since 0.1.9 wherever
> the provider offers it (decided 2026-09-12); the crop the app sends is already 2K-class on
> most providers (see "How big the crop goes out"), so 1K threw resolution away.


A recipe is what the Generate button runs. Two kinds, one JSON file each, shipped in
`recipes/` or imported into `%APPDATA%/Scumble/recipes/` (Settings › Recipes).

## ComfyUI recipes (`kind: "comfy"`)

An API-format prompt with one Inpaint Canvas node. The app fills the canvas node with
the editor state (`canvas_state`), the node params (padding, target_size, feather,
multiple_of) and `result_source[_local]`, writes the Settings-panel values into the
listed nodes and queues the prompt with its own client id. The result comes back over
the websocket as `inpaint_result` (the node's stitch writes the patch) and lands as a
layer, exactly like in the ComfyUI node.

```
{
  "id": "flux2_klein_local", "name": "...", "description": "...",
  "mode": "local" | "api",          // which result input the chain feeds
  "canvas": "canvas",               // prompt id of the InpaintCanvas node
  "result": "decode:0",             // "node id:output slot" wired back into the canvas
  "needs": ["InpaintCanvas", ...],  // class types the server must know
  "refs": { "name": "image {n}", "slots": 4 },   // optional: what the model calls picture n, and how many
                                                  // pictures the graph reads, the crop included (1-16); see
                                                  // "Reference images named in the prompt (local)"
  "settings": [ { "index": 1, "node": "unet", "input": "unet_name", "label": "Model",
                  "spec": [["file.safetensors"], {}] } ],   // spec optional: /object_info wins when connected
  "presets": [ { "name": "L", "values": { "rp_settings:dlss_model_preset": "L" } } ],   // optional, see "Presets"
  "task": "edit" | "upscale" | "pass",                      // optional, edit when left out; see below
  "models": { "diffusion_models": ["..."] },                // informational
  "prompt": { "<id>": { "class_type": "...", "inputs": { ... } }, ... }
}
```

`settings[]` are the editor's Settings-panel controls: `index` is the slot (1–8, the
node's `setting_n` outputs), `node`/`input` where the value goes. The control's type
comes from the server's `/object_info` when connected, else from `spec` (ComfyUI's
input spec format: `["INT", {default, min, max}]`, `[["a", "b"], {}]` for a combo).

`task` says what a ComfyUI recipe does with the selection: `edit` (the default) renders into it, `upscale` is an
upscale model (see "Upscale recipes"), and `pass` is the Realism Pass (`realism_pass` below): the selection's box goes
out like an upscale's (at its own size, `target_size` 0, no fill, no Original, no reference layers, no refine pass,
`multiple_of` 2: DLSS needs even sides only, and a larger multiple would shrink a whole-picture crop and leave a border
without the pass) and comes back at the same size. A `pass` recipe has no *Cloud copy* (`detach` refuses it:
the pass runs on the user's own ComfyUI only), is not offered by Generate new, and `list_recipes` reports it with
`task: "pass"`, mode `local`. The *Upscale* dialog lists a `pass` recipe as its Realism Pass entry (`docs/PLAN_0_1_42.md`
R3b): that entry does not run the recipe's graph and selects no recipe, it runs the `realism_pass` command
(`host.realismWhole`: the whole visible picture at 1x, or at 1.5x to 3x with the document resized by the factor,
through a prompt of its own, `realism.passPrompt`, which takes the recipe's `DLSS5Settings` inputs with the mode's
`upscaling_mode`, and a new layer above the picture). Any other task is read as `edit`.

### The shipped ComfyUI recipes

- `flux2_klein_local`, **Flux.2 Klein 4B / 9B**: reads up to **4 pictures** of the crop batch, `refs: { "name":
  "image {n}", "slots": 4 }`. Each picture goes `ImageFromBatch` (`img0` to `img3`, batch index 0 to 3) ->
  `ImageScaleToTotalPixels` -> `VAEEncode` -> a `ReferenceLatent` on the positive chain and one on the negative chain
  (`ref_pos0..3`, `ref_neg0..3`, each conditioning the next). The crop (`scale0`) follows the Megapixels setting; the
  other three (the Original copy with a fill mode, then the reference layers) stay at a fixed 1 MP each. A token is
  written as `image 3`. The inputs past the batch a run sends are left out of the queued prompt, so no picture
  repeats ("Reference images named in the prompt (local)" below). The negative is a fixed empty `CLIPTextEncode`: a
  token there is resolved but not read. 20 steps, CFG 5. Until step 26e (2026-09-29) the graph read batch pictures 0
  and 1 only: with Original on no reference layer reached the model, with Original off only the first one did, and
  with the crop alone `ImageFromBatch`'s clamp repeated it into the second slot. **The widened graph has not run**
  (three more 1 MP reference latents cost memory and time).
- `qwen_image_edit_2_1_local`, **Qwen Image Edit 2.1** (added for 0.1.23): ComfyUI's own template
  `image_qwen_image_2_1_image_edit.json` with its subgraph flattened and its save and compare nodes left out (they
  would write every run into the server's output folder). `TextEncodeQwenImage21` takes **one picture per input**
  (`image[:1]`, `comfy_extras/nodes_qwen.py`), so the crop batch is split with `ImageFromBatch`: the crop is
  `images.image_1` (`<image1>` in the prompt), batch pictures 1 to 9 (the Original copy with a fill mode, then the
  reference layers; `img1` to `img9`) are `images.image_2` to `images.image_10`. So it reads up to **10 pictures**,
  `refs: { "name": "<image{n}>", "slots": 10 }` (the autogrow input takes up to 16). A token is written as
  `<image3>`. The encoder numbers the pictures that are present by rank, so the inputs past the batch a run sends are
  left out of the queued prompt and none repeats; until step 26e (2026-09-29) it had three inputs, and with fewer
  pictures `ImageFromBatch`'s clamp repeated the last one into them. The negative prompt comes from the canvas node
  (`["canvas", 12]`), so a token there is resolved too. `resolution` 0 keeps the crop's size (the crop already
  comes at `target_size`, a multiple of 64), the sampler's latent is the encoder's own (`latent_image` from the
  encode's third output, so the output keeps `<image1>`'s size), 25 steps, CFG 1 (the negative prompt counts only
  above 1). Settings: Model, Text encoder, VAE, Steps, CFG, Resolution. An autogrow input is a flat dotted key in
  an API prompt (`"images.image_1"`), which is how ComfyUI's `build_nested_inputs` reads it. Needs a ComfyUI with
  `TextEncodeQwenImage21` and `QwenImage21Cache` and the three model files the recipe's `models` names. Checked
  against the user's `/object_info` on 2026-09-21 (every class, input and link, with three inputs); **not run** (the
  model files were not on that server yet), and the ten-input graph has not run either.
- `upscale_model_local`, **Upscale model (ComfyUI)** (added for 0.1.25, session U2): `InpaintCanvas` ->
  `ImageFromBatch` (the crop only) -> `UpscaleModelLoader` (`model_name` as *Model*, slot 1, the server's
  `models/upscale_models` list from `/object_info`; default `4x-UltraSharp.pth`) -> `ImageUpscaleWithModel` ->
  `result_local`. `"task": "upscale"` on a ComfyUI recipe (see "Upscale recipes" below): the *Upscale* dialog lists
  it; on the selection the node's stitch fits the model's larger answer back into the box (`nodes.py`
  `InpaintCanvasStitch`, `_resize_image(src, w, h)`), so it is a sharper detail pass at the document's resolution; on
  the whole picture (0.1.42 U2) the base goes through the same graph and the answer becomes the new base. `limits`
  `{ "picture": 2048 }` (0.1.42 Q14: on the whole picture a 4x model answers at most 8192 px; `picture` caps the whole
  picture alone, so the selection's box keeps no cap, as before). Checked
  against the user's `/object_info` on 2026-09-22 (both classes, their inputs and outputs); run live 2026-10-04 on the
  whole picture (4x-UltraSharp, 1920 × 1080 to 7680 × 4320, 6.5 s on the server, `docs/PLAN_0_1_42.md` U2).
- `rtx_vsr_local`, **RTX Video Super Resolution (ComfyUI)** (0.1.42, `docs/PLAN_0_1_42.md` U1): `InpaintCanvas` ->
  `ImageFromBatch` (the crop only) -> `RTXVideoSuperResolution` (`resize_type` "scale by multiplier", its
  `resize_type.scale` the factor, `quality` LOW / MEDIUM / HIGH / ULTRA as the *Quality* row, ULTRA by default) ->
  `result_local`, task `upscale`. NVIDIA's RTX Video Super Resolution from the node pack Nvidia_RTX_Nodes_ComfyUI
  (Comfy-Org, with its `nvidia-vfx` package), which the user installs on an RTX machine. 1 to 4 times (`factor.input`
  `rtx|resize_type.scale`), `limits` 64 / 4096 / 8192 (the node's target mode takes 64 to 8192 a side; its output sides
  are `int(w × scale)` rounded to a multiple of 8, which the stitch fits back anyway; on the whole picture, U2, the
  answer is stretched to the document's aspect). The selection or the whole picture (the whole picture not at 1×: its
  answer would be the picture's own size, refused before anything is sent). Checked against the user's
  `/object_info` on 2026-10-04 (inputs, combo, ranges); run live the same day on a selection and on the whole picture
  (U1 / U2's live look).
- `realism_pass`, **Realism Pass (Windows only, RTX only)** (0.1.42, `docs/PLAN_0_1_42.md` R1; the name is the
  user's, held by `renderer/editor/realism.js` `LABEL` and pinned by `tools/recipes_test.js`): `InpaintCanvas` ->
  `ImageFromBatch` (the crop only) -> `DLSS5Settings` -> `DLSS5EnhanceImages` -> `result_local`, task `pass`. DLSS 5
  Neural Rendering from the community node pack ComfyUI-DLSS5-Enhancer, which the user installs on their ComfyUI with
  its runtime; Scumble ships none of it. The prompt holds the user's own template (1x DLAA, model preset L, the pack's
  other defaults pinned), the one Settings row is *DLSS model preset* (with its `spec`, so it shows unconnected) with
  the shipped presets L and M. Style and Strength come from `settings.realism` (app-wide; the Upscale dialog's Realism
  Pass row, which also holds the whole-picture pass's own model preset), written into every `DLSS5Settings` node. Before anything is uploaded the run checks the server
  (`/system_stats` os and devices, `/object_info`): no Windows, CUDA devices none of which is an RTX 30 / 40 / 50 by
  the pack's name rule, or the pack's nodes missing refuse with the reason (a server that reports no os or no CUDA
  device is left to the pack's own check); an RTX 30 runs with a note (the pack needs its experimental Ampere runtime
  pair there); a crop (the selection with its context, as the node cuts it) under 64 px a side or past 7680 × 4320 or
  27.9 megapixels (`realism.MAX_AREA`: answers near 30 megapixels sometimes came back with broken colours when
  measured, 2026-10-04, so the cap keeps a margin) is refused. *Save as new recipe* from it keeps the presets only for rows the new graph has, and the task only while
  the graph holds `DLSS5Settings`. The pack's own errors come back as
  sentences (`realism.hint`, fixtures in `tools/refs/dlss5/messages.json`), several of them pointing to the manual's
  chapter *Realism Pass (Windows only, RTX only)* (`docs/MANUAL.md`, slug `realism-pass`): what the pass needs, the
  pack's install steps with the runtime installer's `--url` workaround and the Defender exclusion (as the pack's README
  had them on 2026-10-04), and what each message means. No Comfy Cloud alternative (the user's decision). **Run live on 2026-10-04** on the
  user's RTX 5090 (ComfyUI 0.38.0, pack 1.1.0, runtime v3.0): a box of 1022 × 1022 in about 12 s; the whole-picture
  pass on 5456 × 3072 in about 8 s on the server, +4.6 GB of graphics memory, and on a transparent 1024 × 1024 picture
  with its alpha back exactly.

### Presets

The Settings section starts with a **Preset** row when the recipe has two or more file
combos (inputs named `*_name` whose options are files: `unet_name`, `ckpt_name`,
`clip_name`, `vae_name`, `lora_name`). Save stores the current combination under a name
(`settings.recipePresets[recipeId] = [{ name, values: { "node:input": file } }]`),
picking a preset writes the files back into the controls, the select shows `(custom)`
while the current files match no preset. A file that is not on the server is skipped
with a note in the status line. Presets are per recipe id and shared by all documents.

A recipe file may also **ship presets** (`"presets": [{ "name", "values": { "<node>:<input>": value } }]`, for any
Settings row, not only file combos; ComfyUI recipes): the row then shows them first, then the user's own, and Save
stores the rows the shipped presets name plus the file combos. A shipped preset cannot be deleted; a user preset of
the same name replaces it in the list, and one with a shipped one's values is shown as the user's (so it can be
deleted). `recipes.js` drops a malformed entry (no name, a duplicate name, values that
are not plain strings, numbers or booleans, keys without `node:input`; the node id may hold colons, as a flattened
subgraph's `57:12` does). The Realism Pass ships L and M.

### The local / api / comfy cloud select

The recipe select in the top bar lists the recipes of one mode: ComfyUI recipes on the
`result_local` chain under *local*, provider recipes (and ComfyUI recipes with `mode:
"api"`) under *api*, Comfy Cloud recipes (below) under *comfy cloud* (`cloud`). The
editor's mode select next to Generate switches between the groups and picks the recipe
last used in that mode (`settings.recipeByMode`). The third mode is the app's: the node
build of the editor offers api and local only.

### Import

Settings › Recipes › Import workflow (or File › Import Workflow as Recipe) reads

- a workflow saved from the ComfyUI UI (`nodes` / `links`, subgraphs included):
  needs a connected ComfyUI for the widget order of every node type. Subgraphs are
  flattened the way ComfyUI executes them (inner ids `instance:inner`), reroutes and
  primitives are followed, muted nodes dropped, bypassed nodes passed through.
- an API-format prompt (Export (API) in ComfyUI, or a prompt the node queued): the
  `result_source[_local]` inputs of the canvas node give the result wiring, inputs
  linked to `setting_n` outputs become settings.
- a Scumble recipe file: a ComfyUI recipe, or a provider recipe in either shape - the
  `providers` map every shipped one has, or the old single `provider`. So a shipped
  recipe can be copied out of `recipes/`, given a variant of its own (a model id the app
  does not ship, for one) and imported; a `kind: "provider"` file that names no provider
  at all is refused with a message saying so.

The result input that is wired decides the mode (`result_local` wins when both are).
Setting outputs keep the value the target widget had. The import goes to the user
folder and is selected right away; Remove deletes it, Use selects it. An imported recipe
that keeps a shipped recipe's id shadows it in the list, as a copy placed in
`%APPDATA%/Scumble/recipes/` by hand does.

Every settings row of a recipe needs a slot (`index`) of its own, 1 to 8: the editor
stores one value per slot, so two rows on one slot send that one value under both keys
(`node tools/recipes_test.js` checks every shipped recipe for it).

### Comfy Cloud recipes

Comfy Cloud runs no custom nodes, so the Inpaint Canvas node is not there. A recipe for it is the graph without the
node: Scumble crops and stitches itself, as for every provider, and the graph takes Scumble's pictures and values
through core nodes. Such a recipe is a provider recipe with one variant, `comfycloud`, whose `options.graph` holds the
graph (docs/PLAN_COMFY_VIEW.md §3 "V5a / V5b / V5c as built"); it runs on the Comfy Cloud key and is listed under
*comfy cloud* in the editor's mode select, not under *api* (list_recipes gives it `mode: "cloud"`). Three ways to one:

- **Cloud copy** (Settings › Recipes, on a ComfyUI recipe): the recipe without its node, saved as `<id>_cloud`. Each
  `ImageFromBatch` pick of `crop_image` becomes a `LoadImage` of that picture, `crop_mask` a `LoadImage` and an
  `ImageToMask`, the prompt, negative, seed and crop size values the run writes, the result a `SaveImage`. A recipe
  that reads `image`, `mask`, `stitch_info` or `control_image` of the node is refused by name.
- **Import** a workflow exported from Comfy Cloud (Settings › Recipes › Import; API format, or the UI format read with
  Comfy Cloud's node list on the stored key, else a connected ComfyUI's).
- **Save as new recipe** in the ComfyUI window: a graph without the node becomes a Comfy Cloud recipe (Save to recipe
  overwrites a Comfy Cloud recipe the window opened).

An imported or saved graph needs **no titles**: Scumble reads the roles from it (`recipes.detectRoles`). The LoadImage
nodes in the order their consumers number them (`image_1`, `image1` or `image` before `image_2` ...) are the crop and
the next pictures; a LoadImage whose MASK output is read is where the selection goes (Scumble's mask comes in as a
picture of its own through `ImageToMask`); the prompt, the negative and the seed come from the subgraph controls of
that name (a template's own controls), else from the encoders' text inputs (positive or negative by the first hop that
reaches a "positive" or "negative" input; a text that comes in by link is followed to the text node at its end) and the
`seed` / `noise_seed` inputs; the one SaveImage or SaveImageAdvanced is the result (of several, the one a sampler made).
Muted and bypassed subgraphs add none of their nodes. The window's bar and the recipe's note say what was read; all 26
image-edit templates of Comfy's template package read this way but one, which has two results
(`tools/recipes_test.js` section 9 on `tools/refs/comfy_templates/`, MIT, made by `tools/template_fixtures.py`).

Titles **correct** a wrong reading. When any node carries one, the graph is read by its titles alone (any case;
spaces, `:`, `_` or `-` between words):

| Title | On | What Scumble does |
|---|---|---|
| `Scumble crop` | a LoadImage | the crop (picture 0); required |
| `Scumble picture 1`, `2`, ... | a LoadImage | the next pictures in the node's batch order: 1 is the Original when it goes, else the first reference; then the references. A picture past the run's last gets the last one |
| `Scumble mask` | a LoadImage | the selection, white where to repaint; a link from its MASK output is turned into `ImageToMask` (red), since the picture has no alpha |
| `Scumble prompt`, `Scumble negative` | any node | the prompt / negative prompt into its `text` (or `prompt`) input |
| `Scumble seed` | any node | the seed into its `seed` (or `noise_seed`) input |
| `Scumble result` | a SaveImage | the picture Scumble reads; needed only when the graph has more than one SaveImage |

A control is read by its name or by the label it shows (Qwen Image Edit 2509's `prompt_1` shows `negative_prompt`); a
label that names a prompt role decides alone (a control named `text` and labelled `negative_prompt` is the negative).
When the controls name the prompt but no negative, the negative comes from the encoder whose conditioning reaches a
`negative` input (never the prompt's own encoder: Flux.1 Kontext zeroes it for its negative), else from a
`negative_prompt` field of the encoder the prompt goes into (Mage Flow, Boogu). A prompt that reaches its encoder through
a switch, a preview or a prompt enhancer is followed along the switch's live branch to the text the user writes (Krea 2).
An empty negative in the editor keeps the graph's own (a template's default such as "worst quality, ..."); a set one
replaces it.

A UI export's widget values are read by name where it names them (Comfy Cloud's exports carry `widgets_values_named`):
that covers a node the node list does not know (Ideogram 4's) and the widgets of a dynamic combo (SaveImageAdvanced's
`format`, `format.bit_depth`); without names a dynamic combo's chosen option is read in place. Only what leads to the
result stays in the recipe's graph: a preview, a before / after compare and what fed only them go, while every node
Scumble writes into stays.

**New images (Generate new).** A graph that takes no picture is a text-to-image graph: the prompt, the negative and the
seed are read as above, and the size goes where its `width` and `height` controls point (by name or label), else into
its Empty...Latent... node; a control fed by a resolution node means every input that node feeds, and the resolution
node goes. Such a recipe is `edit: false` with `text: { model, sizes }` (Generate new alone); an edit recipe of the same
model can carry one as its text route, `text: { model, options, sizes }` (`options` the text graph). `comfycloud.js`
`generate()` runs only such a graph (a partner-node recipe makes no new image on Comfy Cloud): nothing is uploaded, the
size goes in steps of 16. Generate new has a *Comfy Cloud* choice beside local and API.

**Shipped:** thirteen of Comfy's templates as Comfy Cloud exports them, picked by the user (MIT,
`tools/refs/comfy_cloud/edit/` and `t2i/`). Edits: `cloud_boogu_image_edit`, `cloud_flux2_klein_9b` (with the Flux.2
Klein 9B text-to-image template as its text route), `cloud_flux2_klein_9b_multi` (the same template with its two-picture
subgraph live), `cloud_flux2_dev` (Comfy's Flux.2 dev image-edit template, filed under text to image by the user),
`cloud_mage_flow_edit_turbo`, `cloud_qwen_image_2_1_edit` (with its text-to-image template; its pictures named
`<image{n}>`, sizes in steps of 32) and `cloud_qwen_image_edit_2509`. New images alone: `cloud_anima_base`,
`cloud_anima_preview`, `cloud_ideogram_4`, `cloud_krea_2_turbo`, `cloud_mage_flow`, `cloud_z_image_turbo`.
`node tools/cloud_recipes.js` writes them from the exports (the widget values by name, the node list of
`tools/refs/comfy_templates/object_info.json` for the rest), `--check` says whether a file still matches; each keeps
the template's layout for the ComfyUI window. They have not run on Comfy Cloud from Scumble yet. Every model file they
name is in Comfy Cloud's model catalog (looked up through Comfy Cloud's own MCP server on 2026-10-03).

Before a run Scumble checks every node of the graph against Comfy Cloud's node list (kept ten minutes per key) and
names a missing one instead of uploading anything; a run with more pictures than the graph takes is refused before
that. The model files are read against the same list, but a file the list lacks does **not** stop the run: Comfy
Cloud also resolves a loader's value through the account's own models (imported LoRAs and checkpoints), which its node
list does not name. A run that fails names each file the list lacked, with the nearest one it has when one is close
(the same file in another folder, else a name a few letters off), and the next run reads the list again. Counted are
values ending in a model file's extension (`.safetensors`, `.sft`, `.ckpt`, `.pt`, `.pth`, `.bin`, `.gguf`, `.onnx`,
`.pkl`), a Settings row's value over the graph's own, in nodes that lead to an output; `sampler_name`, `scheduler` and
the like are combos too but no files, and an input the list gives no names for is not read. A value that differs from
a listed file only in its path separators (a recipe saved on Windows) goes out in the cloud's spelling. The crop goes out at most 2048 px on a side in steps of 16 (a cloud
copy keeps the node's target size and multiple).

## Provider recipes (`kind: "provider"`)

One call to an API provider; crop and stitch happen in the app
(`renderer/editor/stitch.js`, a port of the node's `run` / `stitch`), no ComfyUI needed.
A provider recipe is **one model** with one variant per provider that hosts it; the user
picks the provider in Settings › Recipes (a select per row, remembered in
`settings.recipeProviders`) or through `select_recipe(id, provider)`. The home provider
(`default`) is the model's own API: Google for the Nano Banana family, OpenAI for GPT
Image, Black Forest Labs for FLUX; ToAPIs, fal.ai, Replicate, WaveSpeedAI, Comfy Cloud,
OpenRouter and Oxen.ai carry most models as well. Seedream is the exception: its own API, BytePlus ModelArk, came
later, and the two Seedream recipes keep fal as their `default` (see "BytePlus ModelArk" below). The order
of a recipe's `providers` is the order of its provider select, of Generate new and of `list_recipes`;
ToAPIs comes first wherever it serves the model (see "ToAPIs" below), ModelArk right after it in the two
Seedream recipes, OpenRouter after the older hosts (see "OpenRouter" below), then Comfy Router, Oxen.ai and
**Magnific last** where they serve the model (see "Magnific" below), and `default` stays the home provider.

```
{
  "id": "flux2_max", "kind": "provider", "name": "FLUX.2 [max]", "family": "Black Forest Labs",
  "description": "...", "default": "bfl",
  "providers": {
    "bfl":        { "model": "flux-2-max", "input": "edit", "settings": [ ... ] },
    "fal":        { "model": "fal-ai/flux-2-max/edit", "input": "edit", "settings": [ ... ] },
    "replicate":  { "model": "black-forest-labs/flux-2-max", "input": "edit", "fields": { "images": "input_images" }, "fixed": { "output_format": "png" } },
    "wavespeed":  { "model": "wavespeed-ai/flux-2-max/edit", "input": "edit" },
    "comfycloud": { "model": "Flux.2 [max]", "input": "edit", "options": { "node": "Flux2ImageNode" } },
    "openrouter": { "model": "black-forest-labs/flux.2-max", "input": "edit", "fixed": { "output_format": "png" },
                    "options": { "accepts": ["aspect_ratio", "output_format", "seed", "n"], "ratios": [ ... ], "max_images": 8 } }
  }
}
```

Variant fields: `model` (endpoint / model id), `input` (`fill`: crop + mask; `edit`:
instruction on the crop plus references), `settings` (Settings-panel controls, `key` is
the parameter the adapter sends), `fixed` (parameters sent as they are), `fields`
(input names: Replicate and fal, `{ image, images, mask }`; fal takes `"mask": false` for
an image-to-image endpoint that has no mask, such as Ideogram 4), `options` (adapter
switches: fal `sizing: "none"` for endpoints without a free `image_size`, fal `sizing: "flux3"` with `min_side` /
`max_pixels` for FLUX 3 ("FLUX 3 Image" below), fal
`omit: ["output_format", ...]` for an endpoint that refuses the fields the other models
take; ToAPIs' channels, sizes and tiers, below; OpenRouter's accepted parameters, presets, tiers and
picture limits, below; ModelArk's pixel range, picture count, PNG switch and regions, below; Oxen.ai's accepted
parameters, picture field, mask convention, aspect rule, tiers and presets, with `sizing: "flux3"`, `prompt:
"as_written"` and `min_side` / `max_pixels` for FLUX 3, below; Replicate's `mask: "black"`,
`seed_max`, `negative: false`, `sizes` and `text_values` for Ideogram 4.5, with `fields.references` for a fill's
unnumbered references and `max_ratio` / `max_bytes` checks, "Ideogram 4.5" below; WaveSpeed's `mask: "black"`,
`negative: false`, `accepts` / `text_accepts` (the allowlist of optional keys per route), `tiers`, `text_values`,
`fields.references`, `max_ratio` / `max_bytes` for the same model, `sizing: "flux3"` with `min_side` / `max_pixels`
for FLUX 3 ("FLUX 3 Image" below); Comfy Router's `seed_max`, `resolutions` (Ideogram's
1K / 2K presets) and `text_values` for it, beside the `max_images`, `max_ratio` and `max_bytes` every Router variant
may set (its ideogram dialect knows the mask and the references itself); Magnific takes none, its route table knows each route's rules),
`limits` (the size ceiling, below), `edit: false` (the variant makes images from
the prompt alone and the Generate button says so), `text` (the Generate new shape, below; **required on every
`magnific` variant**, as `{ "model": "<text route>", ... }` or `false`, because Magnific's edit routes end in `-edit`
and `normalize()` would otherwise hand an edit route to Generate new; its `refs` says whether the reference layers
go along, below), `refs` (`{ "name": "Image {n}" }`, the name
a reference picture has in the prompt the model gets; on the recipe for every variant or on one variant, below),
`note` (shown as the tooltip). `family` groups the top-bar list. A recipe with a top-level `provider` instead of `providers` (the
old shape, the smoke test's loopback) is read as a one-provider recipe.

### How big the crop goes out (`limits`)

The app is for quality, so an API run does **not** use the node's `target_size`: it emits
the crop at the size the chosen provider actually takes. `limits` says what that is, on the
recipe (for every variant) or on a single variant:

```
"limits": { "max": 1440, "step": 32, "min": 256, "pixels": 0, "minPixels": 0 }
```

`max` is the long side, `step` the multiple both sides are rounded to, `min` the smallest
side the endpoint accepts, `pixels` an area cap and `minPixels` an area *floor* (0 = none
for both), and `ratio` the steepest crop the model takes (3 = at most 3:1, 0 = any): a crop
steeper than that gets more context on its short side, so a thin selection is not refused
(Seedream on ToAPIs, whose pages say [1/3, 3]; Seedream on ModelArk and OpenRouter 16, ModelArk's
[1/16, 16]). `aspects` lists the only shapes a model renders, as `"W:H"` (Seedream and GPT Image 2 on
Magnific, whose edit routes take an `aspect_ratio` preset and no free size, and FLUX 3 Image, whose 15 presets are
the only shapes it takes besides `auto`): `planCrop` widens the crop's context
to the nearest preset the picture can give (on the short side, as for `ratio`, sets `info.aspect`), so the answer
comes back in the crop's own shape and the adapter tells the stitch to stretch it (`info.fit`, "Magnific" below);
a preset the picture cannot give (the whole picture at another shape) leaves the crop as it is, and the answer is
centre-cropped as before. `[]`, the default, is any shape. Without either, the conservative
`{ min: 256, max: 2048, step: 16, pixels: 0, minPixels: 0, ratio: 0 }` applies - raise one with a
source, not with a guess. Today: **FLUX.2 and FLUX.1 Fill 1440** (2048 answers with an
error), **FLUX 3 Image 2048 in 16 px steps with its 15 aspect presets as `aspects` and a `min` of 608** (the model
refuses a picture under 256 px a side, and `min` holds the long side: 608 keeps the short side at 256 even at 21:9;
2048 keeps an edit at the 2k tier, "FLUX 3 Image" below), **GPT Image 2.5 Flare and Sunburst 3840 with an 8,294,400 px budget and a 655,360 px
floor** (the model's own size rules: both edges a multiple of 16, at most 3840 an edge, a
ratio no steeper than 3:1), **GPT Image 2 2048 with the same budget** (the size rules of the
OpenAI partner node), **Seedream 5 on fal 4096 with a 4 MP budget for pro and a 16 MP one
for lite** (its `image_size` is a free size with an area range, not a side limit),
**Seedream on Comfy Cloud 2496 / 4992** (what the partner node fits it into), **Seedream on
ModelArk 4096 in 16 px steps with the model's own pixel range as budget and floor** (pro 921,600 to
4,624,220 px, lite 3,686,400 to 16,777,216; see "BytePlus ModelArk" below), **the OpenRouter
variants of the three GPT recipes 2048 with neither budget nor floor** (OpenRouter takes no pixel
size; see "OpenRouter" below), everything else the conservative default.

fal answers two URLs without a key, and they are the fastest way to a real number:
`https://fal.ai/api/models?keywords=<x>` lists endpoint ids, and
`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>` gives the input schema with
the size range in it.

The **Highres fix** select in the editor's Generate section (`host.apiSize`, app-only, stored
in `settings.apiSize`) picks how the ceiling is used: *Maximum* (the default) emits at
`max`, *2x crop* and *4x crop* give the crop twice or four times its own resolution, still
held under `max`, *Target size* keeps the node's number and *Off (crop size)* sends the crop
as it is. All five are clamped by `min`, `max` and `pixels`, and
`finishResult()` scales the answer back to the region either way. A ComfyUI recipe gets no
limits at all (`host.cropLimits()` returns null) and keeps using `target_size`, because
there the node does the cropping. `tools/size_test.py` is the gate.

### Reference pictures: order, names, caps and drops (`refs`)

Item 26 (`docs/PLAN_REFS.md`) lets the prompt name a reference layer as `@img1`, `@img2`: the shown reference layers,
top of the list first. A model does not know that name. What it knows is the place of the picture among the pictures
of the request, and each family has its own word for it (the vendors' prompting guides, `docs/PLAN_REFS.md` §1):
"image 3" (FLUX.2, FLUX 3 Image, Nano Banana, Grok, Reve), "Image 3" (GPT Image, Seedream, Qwen Image Edit, HY Image), `<image3>`
(Qwen Image 2.1). So the name is written in the main process, at send time, for the route the run really takes.

- **`refs.name`** is that word as a pattern: `{n}` is the picture's 1-based place, `{n0}` the 0-based one (Reve's
  `<frame>{n0}</frame>`). 1 to 40 characters, at least one `{n}` or `{n0}`, no `@` and no other brace. The recipe's
  `refs` applies to every variant, a variant's own wins; `normalize()` gives every provider variant one (the default
  `image {n}`), and an invalid pattern takes the default with a warning. `resolveRecipe` carries it as `r.refs`, and
  `runProvider` sends it as `request.refName`. ComfyUI recipes keep their own `refs` (`name` and `slots`, resolved in
  the renderer: "Reference images named in the prompt (local)" below).
- **The order** is each adapter's own: `layout(req)` beside `edit` (`electron/main/providers/refs.js`) declares where
  each picture goes: `{ pictures: [{ role, ref?, field, n }], max, drops, style }`. Role `crop`, `mask`, `original` (the
  crop before the fill, `request.references[0]` when `request.original` is 1) or `reference`; `ref` the index in
  `request.references`; `field` the provider's own input (`image_urls[2]`, `contents[0].parts[3]`, `input_image_3`);
  `n` the place among the pictures the model numbers, **null** for a picture in a field of its own (a mask field,
  Magnific Ideogram's style references). The crop is always picture 1, then what the builder sends next: the mask
  where it goes as a picture (Gemini, OpenRouter, Oxen without a mask field, Comfy Router's Gemini), the Original,
  the reference layers in list order. Worked example, GPT Image 2 as a fill with the Original and one reference:
  OpenAI direct names the reference `Image 3` (the mask has its own field), OpenRouter `Image 4`.
- **A new image** (Generate new, step 26f) has no crop, no mask and no Original: its pictures are the shown reference
  layers alone, numbered from 1 in list order, so `@img1` goes out as `image 1` (in the text shape's `text.refs.name`
  when it has one, else the variant's `refs.name`). Each adapter's `textLayout(req)` declares where they go; the rest
  is in "Generating without an image" below.
- **The markers.** The renderer writes a named reference as `{@ref:i}` (i = its index in `request.references`, from
  step 26b2 on); `providers/index.js` computes the layout on every run, turns each marker into `nameOf(refName, n)`,
  and refuses, before anything is sent, a marker past the last picture, a reference the route leaves out (the route's
  `drops` sentence), one without a number (style references), and an Original flag without a reference. Then a
  safety net refuses any `@img` token or `{@ref:` that is still in the prompt or the negative, so no raw token ever
  reaches a model. The answer carries the prompt as sent and `refs: [{ ref, name }]`; the log's success record holds
  the first 500 characters of that prompt.
- **`max`** is the most pictures the route takes, as `countOf` counts them: the crop, the mask where it goes as a
  picture, the Original and the reference layers; a mask in a field of its own (fal's `mask_url`, OpenAI's `mask`) is
  in `pictures` with `n` null and does not count, Magnific Ideogram's style references do. Null where neither the
  variant nor the adapter names a number (the undocumented list below). A variant sets it as `options.max_images`,
  read as a number above 0 everywhere (`"0"`, `-2` or `"many"` is no cap, never a refusal of every run): fal,
  Replicate, WaveSpeed and Gemini take it as it is, OpenRouter defaults to 16, ModelArk to 10, Oxen to 16 (1 with
  `single`), Comfy Router to 1 (its Gemini dialect counts the mask picture inside `max_images`), HY to 5, and on
  ToAPIs the Channel row's own `max_images` wins over the variant's (`capOf(channelOf(req))`, the one reading the
  layout and the builder share, so the cap follows a channel switch). The adapter's own number: BFL by endpoint
  (FLUX.2 klein 4, pro / flex / max 8; FLUX 3 Image 10 through the variant's `options.max_images`, which is also
  `flux3.js`'s default), Comfy Cloud by partner node (`NODE_PICTURES`, read in the local ComfyUI's
  `comfy_api_nodes` on 2026-09-29: GPT Image 16, Nano Banana 2 14, Seedream 10 and lite 14, FLUX.2 8, Qwen 3; the
  one-picture nodes 1), Magnific by route (`maxImages`). The three OpenAI variants carry `max_images: 16`, which
  `openai.js` reads like the others and refuses past.
- **Refused or declared, never silent** (step 26a2). `refs.checkPictures(lay, req, who)` runs in `providers/index.js`
  right after the layout, before the markers are resolved, for fills, edits and new images (an upscale sends the
  picture alone and is laid out in `index.js`):
  - More pictures than `max`: refused before any upload or request, with the parts named: "WaveSpeedAI
    wavespeed-ai/flux-2-pro/edit takes at most 3 pictures; this run has 4 (the crop, the Original, 2 reference
    layers): hide reference layers or turn Original off." A new image names the references only: "Black Forest
    Labs flux-2-pro takes at most 8 reference pictures for a new image; this run has 9: hide reference layers."
  - A route that declares **`drops`** gets no Original and no reference at all: `drops` is all or nothing, so no
    route sends some references and leaves out the rest, and past the cap is always a refusal. The adapter never
    sees them (nothing unwired is uploaded), the layout is computed again for the stripped request, and the answer's
    `notes` say what was left out: "Black Forest Labs flux-pro-1.0-fill: FLUX.1 Fill takes no reference images; the
    Original and 2 reference layers not sent." `host.runProvider` appends the notes to the status line after the
    answered line and returns them, and `generate` over MCP returns them as `notes`. A drop with no reference given
    notes nothing. A prompt that names a reference on such a route is refused ("…, so the prompt cannot name a
    reference image. Take the name out or pick a recipe that sends references."), and so is a marker for a style
    reference or another unnumbered one (Ideogram 4.5's). `provider:layout` answers a dropping route's `names` all null.
  - The routes that declare a drop: the fills without an image list (fal FLUX.1 Fill, Qwen inpaint and Z-Image turbo,
    "This endpoint takes the crop and the mask only"; fal Ideogram 4, "This endpoint takes one picture"; BFL, Comfy
    Cloud and Comfy Router FLUX.1 Fill, "FLUX.1 Fill takes no reference images"; the Replicate and WaveSpeed fills
    without `fields.references`),
    Replicate's one-image edit (Qwen Image Edit, "This endpoint takes one picture"), Comfy Cloud's one-picture nodes
    (the two Gemini image nodes and the upscaler nodes, "this node takes one picture"), In-app LaMa ("LaMa fills from
    the picture alone") and Magnific Image Expand ("Image Expand takes the picture alone").
  - Routes that make pictures from the prompt alone (Comfy Router's xai / ideogram-v4 / krea, Magnific's Z-Image and
    Mystic) and routes that need a mask refuse an edit run in their layout with the builder's own words. The adapters
    that count their own pictures keep that check with their own wording (a direct call, from a test, is refused
    before any request); in the app the central check runs first.
- **One instruction.** The adapters that tell the model what its pictures are build that text with one helper,
  `refs.instruction(req, lay, text)`, numbered by the same layout and named by the same `refs.name`, so the sentence
  and a resolved marker name the same picture: Gemini, OpenRouter, Oxen (with its own layout), ModelArk, Comfy
  Router's vertexai, byteplus and qwen dialects, Comfy Partner (HY) and Magnific's FLUX.2, Seedream and GPT Image
  routes. The others send the prompt as it is written. The text is the head, the user's prompt (trimmed), then one
  sentence for the Original and one per run of consecutive references (the old "The remaining image is reference
  material." is gone):
  - no mask picture, two references: `Edit image 1 and keep its size and framing. a red door Images 2 and 3 are
    reference images.`
  - a mask picture, the Original and two references (a Nano Banana fill on OpenRouter): `Edit image 1. Image 2 is a
    mask: change only the white area of the mask, keep everything else exactly as it is, and keep the image size and
    framing. a red door Image 3 is image 1 before the selected area was filled. Images 4 and 5 are reference images.`
    The clause after "is a mask:" is word for word the one that ran live on OpenRouter.
  - `Image {n}` (HY Image): `Edit Image 1 and keep its size and framing. put Image 2 on the table Image 2 is a
    reference image.`
  - Range words (`Images 2 to 5 are reference images.`) only for a pattern that is one word and the number; any other
    pattern lists the names: `<image2>, <image3> and <image4> are reference images.` A name at the start of a
    sentence gets a capital only when it begins with a lower-case letter.
  - Style references (Magnific Ideogram) and Ideogram 4.5's unnumbered references get no reference sentence; upscale
    runs send the prompt unchanged.
  - A new image with references has no head: the prompt, then the reference sentence (`a lighthouse at dusk Images 1
    and 2 are reference images.`); without references its prompt goes unchanged.
- **Label parts.** Gemini direct and Comfy Router's vertexai dialect send text and pictures as parts; with more than
  one picture each picture gets a text part before it (`refs.labelParts(lay, refName)`), so a fill with the Original
  and one reference goes as `[text, "Image 1:", crop, "Image 2:", mask, "Image 3:", Original, "Image 4:", reference]`
  and picture n sits at `contents[0].parts[2n]`. One picture alone goes as `[text, crop]`, as before.
- **The caps set in step 26a2** (`options.max_images`, the crop included; the pages read on 2026-09-29):

  | Recipe · variant | Cap | Source |
  |---|---|---|
  | `flux2_pro`, `_flex`, `_max` · fal | 8 | BFL's own limit, https://docs.bfl.ai/flux_2/flux2_image_editing (the fal pages name no number) |
  | `flux2_pro`, `_max` · Replicate | 8 | https://replicate.com/black-forest-labs/flux-2-pro ("up to eight reference images at once on the API"), `/flux-2-max` |
  | `flux2_flex` · Replicate | 10 | https://replicate.com/black-forest-labs/flux-2-flex ("up to ten reference photos (14 MB total)") |
  | `flux2_pro`, `_flex`, `_max` · WaveSpeed | 3 | https://wavespeed.ai/docs/docs-api/wavespeed-ai/flux-2-pro-edit (`images` "0 ~ 3 items") |
  | `flux2_klein` · fal | 4 | https://fal.ai/models/fal-ai/flux-2/klein/9b/edit/api |
  | `flux2_klein` · WaveSpeed | 3 | https://wavespeed.ai/docs/docs-api/wavespeed-ai/flux-2-klein-9b-edit |
  | `seedream_5_lite`, `_pro` · fal | 10 | https://fal.ai/models/fal-ai/bytedance/seedream/v5/lite/edit/api, https://fal.ai/models/bytedance/seedream/v5/pro/edit/api ("only the last 10 are used", which would drop the crop) |
  | `seedream_5_lite` · Replicate | 14 | https://replicate.com/bytedance/seedream-5-lite ("Combine up to 14 reference images") |
  | `seedream_5_lite`, `_pro` · WaveSpeed | 10 | https://wavespeed.ai/docs/docs-api/bytedance/bytedance-seedream-v5.0-lite-edit, `…-v5.0-pro-edit` ("0 ~ 10 items") |
  | `qwen_image_edit` · WaveSpeed | 3 | https://wavespeed.ai/docs/docs-api/wavespeed-ai/qwen-image-edit-plus |
  | `ideogram_4_5` · Replicate | 4 | https://replicate.com/ideogram-ai/ideogram-4-5-precise-edit (`reference_images` up to 4, 3 with a mask; read 2026-10-02) |
  | `ideogram_4_5` · WaveSpeed | 4 | https://wavespeed.ai/docs/docs-api/ideogram-ai/ideogram-ai-ideogram-v4.5-edit (`reference_images` up to 4, 3 with `mask_url`; read 2026-10-02) |
  | `ideogram_4_5` · Comfy Router | 4 | https://docs.comfy.org/router-schemas/ideogram/ideogram-4-5.json (`reference_images` up to 4, 3 with a mask; read 2026-10-02, saved in `tools/refs/comfyrouter/`) |
  | `gpt_image_2` · fal | 16 | https://fal.ai/models/openai/gpt-image-2/edit/api |
  | `gpt_image_2`, `_2_5_flare`, `_2_5_sunburst` · WaveSpeed | 16 | https://wavespeed.ai/docs/docs-api/openai/openai-gpt-image-2-edit, `…-2.5-flare-edit`, `…-2.5-sunburst-edit` ("0 ~ 16 items") |
  | `gpt_image_2`, `_2_5_flare`, `_2_5_sunburst` · OpenAI | 16 | OpenAI's `image[]` (not read at a URL in this step; not read by `openai.js` yet, above) |
  | `nano_banana_2`, `_2_lite`, `_pro` · Gemini | 14 | Google's limit (not read at a URL in this step) |
  | `nano_banana_2_1` · Replicate, WaveSpeed, OpenRouter, Comfy Router | 14 | https://replicate.com/google/nano-banana-2.1/llms.txt ("supports up to 14 images"), https://wavespeed.ai/docs/docs-api/google/google-nano-banana-2.1-edit ("max: 14"), the Router's schema; OpenRouter as its Nano Banana 2 (read 2026-10-07) |
  | `nano_banana_2_1` · Comfy Cloud | 14 | the node `GeminiNanoBanana2V2` (`image_1` .. `image_14`, the live catalog 2026-10-07) |
  | `nano_banana_2_1` · ToAPIs | 6 (standard), 14 (vip) | no page for the model: the numbers of ToAPIs' Gemini 3.1 Flash Image pages (https://docs.toapis.com/llms.txt, 2026-10-07) |
  | `nano_banana_2_1` · Gemini | 14 | https://ai.google.dev/gemini-api/docs/models (Nano Banana 2.1: up to 14 reference pictures, 4 characters and 10 objects; read 2026-10-07) |
  | `nano_banana_2`, `_pro` · Replicate | 14 | https://replicate.com/google/nano-banana-2 ("Use up to 14 reference images."), https://replicate.com/google/nano-banana-pro ("combine up to 14 images") |
  | `nano_banana_2`, `_pro` · WaveSpeed | 14 | https://wavespeed.ai/docs/docs-api/google/google-nano-banana-2-edit, `…-pro-edit` ("0 ~ 14 items") |
  | `grok_imagine` · fal | 5 | https://fal.ai/models/xai/grok-imagine-image/v2.0/edit/api ("A maximum of 5 images are supported.") |
  | `flux3` · bfl | 10 | https://docs.bfl.ai/flux_3/flux3_image_overview (`images`: 1 to 10, the crop included; read on 2026-10-01) |

  The Replicate pages that say "reference images" are read as the length of the `image_input` list, which carries
  the crop too (the lower of the two readings). The caps that were there before (OpenRouter, ModelArk, Oxen, Comfy
  Router, ToAPIs, Magnific, HY) are in their providers' sections below.
- **Undocumented** (no cap set: such a variant may still lose pictures on the host's side without a word; the sweep
  of `tools/refs_layout_test.js` keeps the same list):
  - `nano_banana_2`, `nano_banana_2_1`, `nano_banana_pro` · fal: neither the page nor the OpenAPI schema names a number
    (`image_urls` has no `maxItems`).
  - `gpt_image_2` · Replicate: the page says "pass multiple images" and names no number; its schema page did not
    render.
  - `nano_banana_2_lite` · WaveSpeed: the `images` row has no range.
  - `reve` · WaveSpeed: no docs page found (the edit pages answered 404). A search summary says the endpoint takes a
    single input image, unconfirmed; if that holds, the recipe's "crop plus the reference layers" is wrong and the
    route should declare a drop.
  - `gpt_image_2_5_flare`, `_sunburst` · ToAPIs, channels official, VIP and standard: none of the pages (English and
    Chinese) names a maximum.
  - `flux2_klein` · Oxen: the hub schema's `input_image` list has no `maxItems`, so the adapter's default of 16
    stands, not a documented number (BFL's own klein takes 4). The same schema names the pictures "@Image1,
    @Image2" while the recipe's `refs.name` is `image {n}`; a live key settles both.
- **`provider:layout(shape)`** (`window.scumble.providers.layout`) answers the same for a request of a shape, for the
  previews of the steps to come: shape `{ provider, model, kind, fields, options, params, original, count, refName,
  refsMax }` (`count` includes the Original; the mask follows from `kind`; kind `text` numbers the references from 1
  and `refsMax` lowers its cap), answer the layout plus `names` (per reference index, null when left out), `sent` and
  `over`.
- `tools/refs_layout_test.js` pins every layout against the request the real builder sends, for every shipped
  variant (every ToAPIs channel) with 0, 1 and 3 references and the Original on and off, holds the caps (at `max`
  the request goes out, one more is refused before any request), the instruction, the label parts and
  `checkPictures` to literals, and runs the drop and the cap through `index.js` with the loopback's test hooks
  (`options.drops`, `options.max_images`); `tools/refs_cases.json` holds the token grammar main and the renderer
  share.

### Reference images named in the prompt (local)

Step 26e (`docs/PLAN_REFS.md`). On a ComfyUI recipe the renderer writes each `@imgN` as the name the recipe's model
reads for that picture (`renderer/editor/comfyrefs.js`, called from `host.queueGenerate`); main is not involved, and
the node resolves no token. Upscale recipes are left out: there a token goes as its layer's name, as on every upscale.

- **The batch** is the node's (`nodes.py` `InpaintCanvas.run`): picture 1 is the crop; picture 2 is the Original copy
  of the crop when there is a selection, a fill other than none, Original on and no refine pass in local mode; then
  the shown reference layers of `canvas_state.references`, top of the list first. Reference k (0-based) is picture
  **n = 2 + Original + k** (`comfyLayout`). In the shipped graphs the encoder numbers the pictures in batch order.
- **`refs`** on a ComfyUI recipe: `name` is the pattern the model reads picture n by, with the rules of the provider
  `refs.name` above (`{n}` 1-based, `{n0}` 0-based, 1 to 40 characters, no `@` and no other brace); `slots` is how
  many pictures the graph reads, the crop included, an integer from 1 to 16 (the most `TextEncodeQwenImage21` takes).
  `normalize()` (`electron/main/recipes.js` `comfyRefs`) drops a `refs` that is no object or has a bad name, with a
  warning, and the names then come from the graph; a bad `slots` becomes null, with a warning. A recipe needs no
  `refs`: the wording is worked out from the graph in the renderer, so a workflow imported before 26e gets it too.
- **Traced from the graph** (`comfyRefSpec`): each encoder input (`TextEncodeQwenImage21` `images.image_k`,
  `TextEncodeQwenImageEditPlus` `image1` to `image3`, a `ReferenceLatent`'s `latent`) is followed back through the
  single linked `pixels` / `image` / `samples` input of each node on the way (a scale, a VAE encode; 8 steps at most)
  to an `ImageFromBatch` of the canvas node's `crop_image` (output 0) with a literal `batch_index` and `length` 1. The
  trace is an **identity** when the batch indices are exactly 0 to k-1, one encoder class reads them all, each
  input's number is its batch index + 1 (Qwen Image 2.1 numbers the `images.image_k` that are present by rank, Edit
  Plus by input, a `ReferenceLatent` by its place in the conditioning chain), and no other node reads the whole batch.
  Then:
  - the wording is the class's: `<image{n}>` (Qwen Image 2.1), `Picture {n}` (Qwen Image Edit Plus), `image {n}` (a
    `ReferenceLatent` chain, FLUX.2); a declared `name` wins;
  - `slots` is k, and a declared `slots` can only lower it;
  - the inputs a run does not fill are trimmed (below).
- **Otherwise the wording is a guess** (the whole batch into one node such as an API node, a linked `batch_index`,
  another order, two encoder classes, no encoder the trace knows): the names go by batch position as `image {n}` (or
  the declared `name`, which is then no guess), nothing is trimmed, and there is no slot limit unless `refs.slots`
  declares one. The status line adds "(wording guessed from the graph)" when a token was named, and the Info panel
  says so too. A graph that picks fixed batch indices then still gets the last picture repeated into its unused
  inputs (`ImageFromBatch` clamps the index), as every graph did before 26e.
- **Trimming** (`trimSlots`, identity traces only): the encoder inputs whose batch index is past the batch the run
  sends (1 + Original + the references kept) are deleted from the queued prompt. A `ReferenceLatent` without its
  `latent` passes the conditioning on, an absent Qwen 2.1 image is not numbered, and Edit Plus's `image2` / `image3`
  are optional. The crop's input (batch 0) is never removed. The nodes that fed a removed input are then read by
  nothing and do not run: the canvas node expands only what its result source reaches. **Behaviour change:** until
  26e Klein repeated the crop into its second input and Qwen 2.1 into its second and third when fewer pictures were
  sent, so the same seed now gives another result.
- **Refused or left out.** A run checks the tokens twice: against the editor before anything is uploaded, then
  against the canvas state it built, and the state decides (a selection, the fill or Original changed during the
  uploads; a refusal there comes after the mirror uploads only). A token of a hidden or deleted reference, or a
  number no reference has, refuses as on API recipes. A token for a reference past the recipe's slots refuses before
  anything is queued: "@img3 cannot be named: Flux.2 Klein 4B / 9B (ComfyUI) reads 4 pictures (the crop, the
  Original, img1 and img2). Hide a reference, turn Original off, or take @img3 out." (without the Original: "Hide a
  reference, or take @img3 out."). A reference past the slots that no token names is left out and not uploaded, and
  the status line says so: "img3 is not sent: Flux.2 Klein 4B / 9B (ComfyUI) reads 4 pictures."
- **What goes out.** Only `canvas_state`'s `prompt` and `negative` carry the names (`<image3>`, `image 3`); the
  editor's prompt keeps the token, and so do the history and the PNG metadata. A literal `<image3>` typed by the user
  goes as it is. After queueing, the status line adds "Named in the prompt: @img1 → <image3>." and the notes, and the
  app log gets an info entry "local run <id>: prompt as sent" with the resolved prompt. `generate` over MCP returns
  that prompt as `prompt_sent` and the notes as `notes`, for local runs too. `canvas_state` gains `hasSelection`
  (whether the mask holds a selection, read in the same tick as the mask) and `named_refs: true` when the prompt named
  a reference; the node ignores both until its next release.
- **Before the run.** `host.refLayout` answers a local recipe at once, from the same layout. The Info panel's
  References row reads `img1 → <image3>, img2 → <image4> (pad)` (the reference fit), plus `· img3 not sent` and
  `· wording guessed from the graph` where they apply, and its batch count no longer counts the Original on a refine
  pass. The prompt field's bar shows "2 of 8 for this recipe" (the pictures the graph reads minus the crop and the
  Original; a guessed graph without `slots` shows "2 in crop_image"), and a chip's card "img1 · sent as <image3>". A
  graph that reads the crop alone (`slots` 1) sends no reference, and every chip is struck through.
- **Known limit.** The node skips a reference file it cannot read and moves the later ones up (`nodes.py`, "reference
  skipped", a print only); the names would then point one picture off. `ensureOnServer` only makes sure each file is
  on the server, not that it can be read. Since 26e the app sends `named_refs: true`, so that the next node release
  can raise instead when it is set (`docs/BUGS.md` "Reference layers dropped without a word").

### Transparent results (`background`)

An OpenAI image model can return a **cut-out**: a subject on a fully transparent ground
instead of a background. The variant declares it as an ordinary settings row with the key
`background` and the options `auto` / `opaque` / `transparent`, which is what the three
gpt-image recipes carry; the row is the switch, the app needs nothing else to offer it.

What the app does with it:

- `host.runProvider()` reads the parameters before the run and sets `info.keepAlpha`. In
  `finishResult()` (`renderer/editor/stitch.js`) the answer's **own alpha channel is kept**
  and the selection's composite mask only multiplies it, instead of replacing it. A clean
  cut-out therefore keeps its edges, and a model that ignored the request still blends in
  exactly as before. Colour match is skipped for such a run: its statistics would read the
  transparent pixels' black, and the asset was never meant to sit on that backdrop.
- The status line says whether the answer really carried transparency
  (`transparentPixels()` samples the patch), so a model that returned an opaque picture is
  not silently passed off as a cut-out.
- "Generate new" has a **transparent background** checkbox, shown only for a variant that
  declares the row, and the `generate_new` command takes `background` for the same thing.
  The new base image then has an alpha channel and the checkerboard shows through it.
- The adapter refuses to lose the alpha: `background: "transparent"` with `output_format:
  "jpeg"` is sent as PNG, because only PNG and WebP carry one.

Say it in the prompt as well - the model follows the words, not only the parameter. The
built-in prompt template **Transparent asset** (`prompts/transparent-asset.md`) writes that
part for you and is offered for the OpenAI recipes.

The ToAPIs variants of the three GPT recipes carry the row too (on GPT Image 2's standard channel and
on every GPT Image 2.5 channel only `transparent` is sent, as their pages ask); none of that has run
live. On OpenRouter only the two GPT Image 2.5 variants (Flare, Sunburst) carry it, because
`GET /api/v1/images/models` lists `auto`, `transparent` and `opaque` for them and only `auto` and
`opaque` for GPT Image 2 (2026-09-19); GPT Image 2 on OpenRouter therefore has neither the row nor
the Generate-new checkbox. OpenRouter lists no `output_format` for the OpenAI models, so the format
of a transparent answer is the host's default (not verified). Other providers are not wired for it: fal, WaveSpeed and Comfy Cloud may or may not pass
`background` through to the same models, and none of that is verified. ModelArk documents a
`background` for Seedream 5.0 pro, but "only for image-to-image generation with exactly one input image
that has an alpha channel", which an inpaint crop is not; its variant does not carry the row. Add the row to a
variant when you have a source. `tools/transparent_test.py` is the gate.

### Generating without an image (`text`)

"Generate new" makes the base image from the prompt, and from the reference layers where the
model takes them (below), never from the document's picture. Every variant therefore also has
a `text` shape, filled in by `normalize()` in `electron/main/recipes.js`: the model id is
the editing one with a trailing `/edit`, `/inpaint` or `/fill` removed (fal and WaveSpeed
put the editing model under such a path, the others use the same id without the image
field). A variant overrides it with `"text": { "model": "...", "sizes": [...], "fixed": {} }`
or switches it off with `"text": false`. Providers that can do it at all: ToAPIs, OpenAI, Gemini,
BFL, fal, Replicate, WaveSpeed, OpenRouter, ModelArk, Comfy Router, the Comfy Partner API, Oxen.ai, Magnific (`TEXT_PROVIDERS`; Magnific's variants name their
text route, see "Magnific" below; Oxen.ai posts the same id to `/images/generate`, Grok Imagine's variant names its
text model; without reference layers OpenRouter uses the same model id and
leaves out `input_references`, ModelArk the same id without `image`, Comfy Router the same model without a picture). Comfy Cloud builds a graph around a
partner node and has none. The other way round exists too: a variant with `"edit": false` has **only** the text
shape (Krea 2, Recraft V4 and Z-Image base are text-to-image endpoints on fal; the OpenRouter variants of Krea 2
and Recraft V4 are text-only by choice, since OpenRouter lists one input picture for each but not whether it is edited
or used as a style reference, see "OpenRouter" below), and the Generate button answers that the recipe belongs in
"Generate new".

The run goes through `host.runGenerate()` with `kind: "text"`: no crop, no mask and no
Original, only prompt, size, aspect, seed and, where the text shape takes them, the reference
layers. Without references the adapter's `generate()` sends what it sent before step 26f
(OpenAI `images/generations` instead of `images/edits`, the others the same body without the
image field), byte for byte. The answer replaces the document's base image through
`editor.setBaseFromCanvas(c, { keepRefs: true })`. **The size is a request**: a model answers
with the shape it supports, and the document takes whatever comes back.

**Reference layers for a new image (`text.refs`, step 26f).** A text shape with `refs` sends the
shown reference layers along; one without makes pictures from the prompt alone.

- **The field** (`textRefsOf` in `electron/main/recipes.js`): `"refs": true`, or an object with any of
  - `max`: a whole number above 0 that lowers the route's own cap (Oxen.ai FLUX.2 [klein]: 4, where Oxen's
    default is 16);
  - `model`: the route a run **with** references goes to, where the text route takes no pictures (fal's and
    WaveSpeed's `/edit` routes, Magnific's `-edit` routes, Oxen.ai's Grok edit id); a run without references keeps
    `text.model`;
  - `options`: merged over the variant's `options` for such a run (fal Seedream: `{ "sizing": "image_size" }`, so
    the edit route gets the asked size). Two keys only fal reads: `pixels` [min, max] fits the asked size into the
    route's area range, multiples of 16 (Seedream 5 pro 1 to 4 MP, lite 3.7 to 16.8 MP, as fal's schema gives them),
    and `aspect_ratios` lists the presets a route takes, the closest of which goes out for a free size (Nano Banana 2
    and Pro: Gemini's ten ratios);
  - `name`: the naming pattern where it differs from the variant's `refs.name` (the same rules);
  - `field`: read and checked, but nothing uses it yet: each text layout writes the field its edit branch writes.

  Absent, `false` or `null`: the prompt alone. Anything else warns and counts as absent; a bad field warns and is
  left out. `true` is the same as `{}`.
- **What goes.** The shown reference layers, top of the list first, numbered from 1: there is no crop before them,
  so `@img1` goes out as `image 1` (`Image 1`, `<image1>`, as the pattern says). Hidden references stay in the tab
  and are neither sent nor counted. References the prompt does not name go along too, as on Generate. The pixels
  are read when the run starts (`referenceBytes` in `renderer/editor/stitch.js`).
- **Where they go.** Each adapter's `textLayout(req)` puts them in the picture field its edit branch uses, with the
  edit's cap (the crop's slot becomes a reference's), lowered by `max`. OpenAI switches to the multipart
  `/v1/images/edits` (`image[]`, no mask, `size` from `sizeFor`), Oxen.ai to `/images/edit`; the others keep their
  endpoint or go to `text.refs.model`. The adapters that write an instruction for an edit ("One instruction" above)
  append the reference sentence after the prompt, without the "Edit image 1" head: `Image 1 is a reference image.`,
  `Images 1 to 3 are reference images.` Gemini direct and Comfy Router's Gemini put a label part before each picture
  when more than one goes. With 0 references nothing changes.
- **Which shipped variants take them** (`recipes/*.json`; the route with references in brackets where it is not the
  text model):

  | Recipe | Takes references for a new image | The prompt alone |
  |---|---|---|
  | FLUX.2 [pro], [flex], [max] | BFL, Replicate, OpenRouter, ToAPIs (pro, flex), Comfy Router (pro, max), Oxen.ai (pro, flex), Magnific (pro, flex); fal and WaveSpeed (the `/edit` route) | - |
  | FLUX.2 [klein] | BFL, Oxen.ai (`max: 4`); fal and WaveSpeed (`/edit`) | - |
  | FLUX 3 Image | BFL, OpenRouter, Comfy Router, Oxen.ai; fal (`edit-image`), WaveSpeed (`image-edit`) | - |
  | GPT Image 2 | OpenAI (`/v1/images/edits`), ToAPIs, Replicate, OpenRouter, Comfy Router, Oxen.ai; fal and WaveSpeed (`/edit`), Magnific (`gpt-image-2-edit`) | - |
  | GPT Image 2.5 Flare, Sunburst | OpenAI, ToAPIs, OpenRouter, Comfy Router, Oxen.ai; WaveSpeed (`/edit`), Magnific (`gpt-image-2-5-edit`) | - |
  | Nano Banana 2.1 | Gemini, ToAPIs, OpenRouter, Comfy Router, Replicate; fal and WaveSpeed (`/edit`) | - |
  | Nano Banana 2, Pro, 2 Lite | Gemini, ToAPIs, OpenRouter, Comfy Router, Oxen.ai, Replicate (2, Pro); fal (2, Pro) and WaveSpeed (`/edit`) | - |
  | Seedream 5 lite, 5 pro | ModelArk, ToAPIs, OpenRouter, Comfy Router, Replicate (lite), Oxen.ai (pro); fal (`/edit`, `options: { sizing: "image_size" }`), WaveSpeed (`/edit`), Magnific (the `-edit` route) | - |
  | Seedream 4.5 | Magnific (`seedream-v4-5-edit`) | - |
  | Qwen Image Edit | ToAPIs, WaveSpeed (`qwen-image/edit-plus`, already its text model), Comfy Router, Oxen.ai | fal (an inpaint route), Replicate (one image field) |
  | Qwen Image 2.1 | Oxen.ai | - |
  | HY Image 3.5 | Comfy Partner API | - |
  | Grok Imagine | OpenRouter; fal (`/edit`), Oxen.ai (`xai-grok-imagine-image-edit`) | Comfy Router |
  | FLUX.1 Fill, Ideogram 4, Ideogram 4.5, Krea 2, Recraft V4, Z-Image, Z-Image Turbo, Mystic, Reve | - | every variant with a text shape |

  Comfy Cloud has no text shape, nor do Oxen.ai's Seedream 5 lite and the expand, inpaint and LaMa recipes (`text:
  false`). The caps for a new image: FLUX.2 8 (Replicate flex 10, Comfy Router 9, WaveSpeed 3, Magnific 4), klein 4
  (WaveSpeed 3), FLUX 3 Image 10, GPT Image 16, Nano Banana 14, Seedream 5 pro 10, 5 lite 14 on ModelArk, Replicate, OpenRouter and
  Comfy Router and 10 on ToAPIs, fal and WaveSpeed, Magnific's Seedream 4.5 and 5 lite 5, Qwen Image Edit 3, Qwen
  2.1 10, HY 5, Grok 5 on fal, 3 on OpenRouter, 1 on Oxen.ai; on ToAPIs the channel's own cap wins (GPT Image 2 and
  Nano Banana standard 6). The routes the "Undocumented" list above names stay uncapped here too, except Oxen.ai's
  FLUX.2 [klein] (`max: 4`).
- **Refused before anything is paid for:**
  - a live `@img` token on a text shape without `refs`, in the renderer: "Reve 2.1 on WaveSpeedAI makes new images
    from the prompt alone: take the @img tokens out, or pick a model that takes reference images for a new image
    (FLUX.2, GPT Image, Nano Banana, Seedream)." Without a token such a model runs and the references stay;
  - a token of a hidden or deleted reference, on every variant, as on Generate;
  - more references than the cap (`refs.checkPictures`): "Black Forest Labs flux-2-pro takes at most 8 reference
    pictures for a new image; this run has 9: hide reference layers." Nothing is cut silently;
  - a request that marks an Original on a new image (`providers/index.js`).

  A route that takes no pictures (a text route whose variant names no `text.refs.model`, an adapter without
  `textLayout`) declares a drop, as an edit route does: the references are stripped with a note, and a token that
  names one is refused.
- **What stays.** The answer replaces the base and every layer but the reference layers (hidden ones included),
  which keep their ids, order, visibility, masks and pixels; on a size change they are placed again the way a new
  reference is (a third of the canvas, cascaded from the top left, `referenceBox`). The undo history is cleared as
  before; the labels do not change, so the prompt is not rewritten. The status line names what went out and what
  stayed ("Named in the prompt: @img2 → image 2. The reference layers stay, 1 other layer was replaced."), and
  `generate_new` returns the same (`docs/MCP.md`).
- **Not run live.** None of this has run against a live API; the adapters are checked with fake fetches and the app
  with the loopback. The edit routes used to make a new image from references alone (fal, WaveSpeed, Oxen.ai,
  Magnific's `-edit`) may want a main picture or cost more than the text route, fal Seedream's `image_size` there is
  untested, and Oxen.ai's model list names `/images/generate` for every model, so `/images/edit` is a reading of its
  docs. Where the route takes no size (WaveSpeed's FLUX.2, Seedream 5 lite and Qwen edit-plus, Oxen.ai's Grok edit,
  and fal's GPT Image and Grok with a free size), the answer may take a reference's shape.

For a ComfyUI recipe there is nothing to declare. The local path renders a flat canvas of
the wanted size through the recipe and flattens the result into the base, which is what
`generate_new` does; a chain that starts its sampler from an empty latent (the Flux.2 Klein
recipe does) then ignores the flat input entirely. The reference layers stay on the new
canvas (`newCanvas(size, { keepRefs: true })`) and go along in the node's batch after the white
crop, named as "Reference images named in the prompt (local)" says: `@img1` is picture 2 there
(3 when a fill other than none and Original on send the Original copy first), and the flatten
keeps them.

Adapters (`electron/main/providers/`): **toapis** (uploads, a task and polling; channels,
sizes and tiers from `options`; see "ToAPIs" below), **fal** (queue API, settings passed by name),
**bfl** (`steps`, `guidance`, `safety_tolerance`, `prompt_upsampling`; the variant's
`model` is the endpoint; FLUX 3 Image has a body of its own, "FLUX 3 Image" below), **openai** (`quality`, `size`, `background`,
`output_format`, `output_compression`, `moderation`, and `input_fidelity` on 1.5 and 1
only - gpt-image-2 always works at high fidelity and the docs say to omit it; `sizeFor()`
holds a free size inside each model's own rules), **gemini** (`aspect_ratio`,
`image_size` (1K / 2K / 4K, and `"512"` without a K on 3.1 Flash Image only, Google's spelling), `thinking_level`
(Nano Banana 2.1 only: minimal / medium / high, sent as `thinkingConfig.thinkingLevel` "Minimal" / "Medium" / "High"
as Google's REST example spells it; a variant without the setting sends no `thinkingConfig`); `options.ratios` the
aspect presets a model takes beyond Gemini's ten (2.1: 1:4, 4:1, 1:8, 8:1), the closest of which goes for a free-size
text run with references; the answer is the last picture part not marked `thought` (a thinking model's interim
pictures come before it); no mask input, the mask goes along as an image and the prompt names the
white area), **replicate** (settings by name, `model` is `owner/name` or
`owner/name:version`, files over 256 kB through the Files API; Ideogram 4.5's inverted mask, seed cap and preset
sizes from `options`, "Ideogram 4.5" below), **wavespeed** (`POST
/api/v3/<model>`, poll `predictions/<id>/result`; inputs are URLs only, so crop, mask and
references go through the media upload first; `options.aspect_ratios` picks the preset
closest to the crop (never on a fill), `options.size = "star"` sends `W*H` for the fill models; `options.accepts`
(`text_accepts` for a text run) lists the optional keys a route takes and keeps every other key but the prompt and
the pictures home, seed and `output_format` included (a variant without the list sends what it always sent);
Ideogram 4.5's inverted mask, unnumbered references and text tiers from `options`, "Ideogram 4.5" below; FLUX 3's
shape, picture rules and blank-prompt refusal from `options.sizing: "flux3"`, "FLUX 3 Image" below; the key link
carries the WaveSpeed referral code), **comfycloud** (Comfy Cloud API with `X-API-Key`:
the adapter builds a workflow from LoadImage, one Partner Node named in `options.node`
(`OpenAIGPTImageNodeV2`, `GeminiNanoBanana2V2`, `GeminiImage2Node`, `GeminiImageNode`,
`ByteDanceSeedreamNodeV3`, `Flux2ImageNode`, `FluxProFillNode`, `QwenImageEditApi`) and
SaveImage (only the pictures the node wires are uploaded; how many each node takes is in "Reference pictures"
above), submits it to `/api/prompt`, polls `/api/job/<id>/status`, reads the image from
`/api/jobs/<id>` (its `outputs`; Comfy Cloud stopped serving `/api/history` by 2026-10-03) and `/api/view`; settings keys are the node's full input keys, dotted
for the model combos such as `model.quality`, and override what the node's wiring sets (Nano Banana 2.1:
`model` "Gemini Nano Banana 2.1" on `GeminiNanoBanana2V2`, `model.thinking_level` MINIMAL / MEDIUM / HIGH over the
wiring's MINIMAL); needs a paid plan), **openrouter** (`POST
/api/v1/images`, one synchronous request with the pictures inline as data URLs and the image back
as base64; no mask input, so a `fill` variant sends the mask as a second picture as the Gemini
adapter does; only the parameters `options.accepts` names; tiers and aspect presets from
`options`; `provider.ignore` with the hosts in China; see "OpenRouter" below), **ark** (BytePlus ModelArk,
ByteDance's own API for Seedream: `POST /api/v3/images/generations` on the host of the *Region* row, one
synchronous request with the pictures inline as data URLs and the image back as base64; always a pixel `size`
in the crop's shape, `watermark: false`; no mask input; see "BytePlus ModelArk" below), **oxen** (Oxen.ai: `POST
/api/ai/images/edit` or `/images/generate`, one synchronous request built to each model's own schema, the pictures
inline as data URLs and the image back as base64; GPT Image's selection as `mask_url`, Nano Banana's as a second
picture; see "Oxen.ai" below), **magnific** (an
asynchronous task per run on `api.magnific.com`, one dialect per route: Ideogram's mask inpainting with the mask
inverted, Image Expand from the mask's geometry, instruction edits with aspect presets, Mystic and Z-Image text
only; see "Magnific" below). Every adapter is written
from the provider's documentation and has not run against the live API yet; the recipe descriptions say so
(OpenRouter with GPT Image 2.5 and BFL's FLUX 3 Image, one edit and one new image on 2026-10-01, are the exceptions).
The key of the provider comes from the credential store (Settings › API providers).

**FLUX 3 Image** (`recipes/flux3.json`; the body in `electron/main/providers/flux3.js`, which `bfl.js` sends and
polls). Written from docs.bfl.ai/flux_3 and `https://api.bfl.ai/openapi.json` as read on 2026-10-01, the day it
was released; **not run against the live API yet** (`docs/PLAN_FLUX3.md`). One endpoint and no tiers:
`POST https://api.bfl.ai/v1/flux-3-image` with the `x-key` header, the same Black Forest Labs key row as FLUX.2. A
`bfl` variant is FLUX 3 when its `options.schema` is `"flux3"` (or its `model` starts with `flux-3`); `bfl.js` then
takes body, `layout` and `textLayout` from `flux3.js` and keeps its own submit and poll. The `comfyrouter` variant
(`bfl/flux-3-image`, docs/PLAN_0_1_38.md B1) sends the same body: the Router takes BFL's own schema
(`tools/refs/comfyrouter/bfl_flux-3-image.json`, additionalProperties false; its `version` field is left at
`latest`), so `comfyrouter.js`'s `bfl` dialect calls `flux3.body`, `layout` and `textLayout` for that model, reads
`result.sample`, and reports the seed the answer names or none (null, never the request's); the box rows ride in
the prompt as on BFL's API. Not run against the live Router either.

The **`fal` variant** (docs/PLAN_0_1_38.md B4, docs/PLAN_FLUX3.md "fal") goes through `fal.js`'s queue under BFL's own
namespace there: `blackforestlabs/flux-3/edit-image` for an edit and for a new image with references (`text.refs.model`;
`textLayout` takes `/edit-image` as an edit route), `blackforestlabs/flux-3/text-to-image` for a new image from the
prompt alone (`text.model`, named since `textModelOf` strips only `/edit`). fal's schema (`tools/refs/fal/`, fetched
2026-10-03) differs from BFL's: `image_urls` as data URIs, 14 presets (no 9:21), each picture 256 px a side to 4 MP,
`enable_prompt_expansion` (default false there) instead of an expansion that always runs, no grounding, `output_format`
(png). `options.sizing: "flux3"` sends the shape by `flux3.shapeOf` over the variant's `aspect_ratios` (the same tier
and 3 % rules, `info.fit` too); `min_side` 256 / `max_pixels` 4,000,000 scale a reference layer or the Original
(`ctx.resizePng`) and refuse the crop, which the variant's `limits` (`pixels` 4,000,000, `aspects` the 14) already hold
there (a 2048 × 2048 crop goes at 2000 × 2000, still 2k); `omit` keeps `num_images`, `seed` and `negative_prompt`
home, and the seed reported is none. The rows: Safety tolerance (a whole number 0 to 4) and Prompt expansion (on by
default, as BFL's API always expands; a JSON boolean, "on" / "off" from an agent too). Boxes go in the prompt as on
BFL's API. Not run against the live API yet.

The **`oxen` variant** (docs/PLAN_0_1_38.md B5, docs/PLAN_FLUX3.md "Oxen.ai") is the last provider, as in every
recipe Oxen.ai serves. One id, `flux-3-image`, for all three runs: an edit and a new image with references go to
`/images/edit` with the pictures in `input_image` (data URLs, the crop first), a new image from the prompt alone to
`/images/generate`. Oxen's schema (`tools/refs/oxen/flux-3-image.json`, fetched 2026-10-03) is BFL's but for the
envelope: the 15 presets plus "auto", `resolution` 768sq / 1k / 2k / 4k, `safety_tolerance` 0 to 4, `grounding` (default
false there), ten pictures, no seed, no negative prompt. `options.sizing: "flux3"` sends the shape by `flux3.shapeOf`
over the variant's `ratios` (the same tier and 3 % rules, `info.fit` too; an edit near no preset sends "auto"),
`prompt: "as_written"` the prompt without Oxen's usual instruction around it, so the box rows stay at its end, and
`min_side` 256 / `max_pixels` 16,000,000 (BFL's; Oxen states none) scale a reference layer or the Original and refuse
the crop (`openrouter.sizeRules`). The rows: Safety tolerance and Grounding, on by default as on BFL's API (the row
always sends it, so Oxen's own default never applies). The seed reported is none. Not run against the live API yet.

The **`wavespeed` variant** (docs/PLAN_0_1_38.md B6, docs/PLAN_FLUX3.md "WaveSpeed") sits after `fal`, before
OpenRouter. WaveSpeed renamed its edit route after the research: `black-forest-labs/flux-3/image-edit` (the old
`.../edit` answers "Model not found" since 2026-10-03; `EDIT_ROUTE` takes the new name as an edit route), for an edit
and a new image with references (`text.refs.model`); `black-forest-labs/flux-3/text-to-image` for the prompt alone
(`text.model`). The schemas (`tools/refs/wavespeed/`, fetched 2026-10-03) are strict (`additionalProperties: false`):
`images` as URLs (the adapter's upload), 14 presets with **neither 9:21 nor "auto"** (left out, an edit follows image
1; a new image defaults to 1:1), `resolution` 1k / 2k / 4k, each picture 256 px a side to 4 MP, `enable_prompt_expansion`
(default false there), `output_format`; no seed, safety tolerance or grounding. `options.sizing: "flux3"` sends the
shape by `flux3.shapeOf` over the variant's `aspect_ratios` (an edit near no preset sends none, `info.fit` where one
goes) instead of the closest preset; `min_side` 256 / `max_pixels` 4,000,000 scale a reference layer or the Original
(`openrouter.sizeRules`) and refuse the crop before the first upload, which the variant's `limits` (`pixels` 4,000,000,
`aspects` the 14) already hold; a blank prompt is refused (the schemas' `minLength` 1). `accepts` (`aspect_ratio`,
`resolution`, `output_format`, `enable_prompt_expansion`) keeps the seed and the negative prompt home, and the seed
reported is none. The row: Prompt expansion, on by default as on fal (a JSON boolean). Boxes go in the prompt as on
BFL's API. Price $0.05 / $0.12 / $0.65 at 1k / 2k / 4k (2026-10-03). Not run against the live API yet.

- **The body** is `{ prompt, images, aspect_ratio, resolution, safety_tolerance, grounding }` and nothing else. The
  schema is strict (an unknown field answers 422), so no `seed`, mask, `width` / `height`, `mode`, negative prompt or
  `output_format` goes, whatever `accepts` says. A blank prompt is refused before anything is sent. `images` is a list
  of plain base64 strings: on an edit (and a fill, which sends no mask here; the stitch keeps the selection) the crop
  first, then the Original and the reference layers; on Generate new the reference layers alone, and no `images` field
  without them. The model names them `image 1`, `image 2` .. in that order, so `refs.name` is `image {n}` and an
  `@img1` goes out as `image 2` on an edit (`image 3` with the Original) and as `image 1` on a new image. The prompt
  goes as written, with no instruction sentence added. The model expands it itself before it renders; there is no
  switch for that.
- **Sizing.** No pixel size: `aspect_ratio` is one of 15 presets (21:9, 2:1, 16:9, 3:2, 7:5, 4:3, 5:4, 1:1, 4:5,
  3:4, 5:7, 2:3, 9:16, 1:2, 9:21) or `auto`, `resolution` a tier by pixel area. An edit sends the preset nearest the
  emitted crop when it is within 3 % (`|ln(crop / preset)| <= 0.03`; the usual case, since `limits.aspects` widened
  the crop to a preset) and `auto` otherwise, which follows image 1, the crop. A new image always sends the nearest
  preset (to the asked aspect where it reads `W:H`, else to the size), never `auto`. The tier is the smallest whose
  area holds the emitted size with 15 % slack: `1k` (about 1 MP) up to 1,205,862 px, `2k` (about 4 MP) up to
  4,823,449 px, else `4k` (about 16 MP). So an edit at the Highres fix's *Maximum* (2048) goes at 2k, a small crop
  at *Off (crop size)* can go at 1k, and `text.sizes` `[1024, 2048, 4096]` give a new image 1k, 2k or 4k. `768sq`
  and the `1.5k` that only the live schema lists are never sent. `resolution` as a Settings row would override the
  tier where `accepts` names it; none ships.
- **`info.fit`.** The answer's `info` carries `{ aspect, resolution, fit }` from `flux3.infoOf`. `fit` is `"stretch"`
  when a preset went out within the 3 %; `host.runProvider` copies it into the stitch's `info`, which stretches the
  answer onto the crop. After `auto` it is null, and the stitch's own 1 % check stretches or centre-crops.
- **Checks before sending.** Each picture at least 256 px a side and at most 16,000,000 px (read from its PNG
  header), and at most 20,000,000 characters of base64: the stricter readings of the docs' "16 MP" and "20 MB". An
  opaque picture past the 20 MB goes as JPEG (quality 92); one with transparent pixels is refused. Each message
  names the picture (the crop, the Original, reference picture n), says what to do and ends "Nothing was sent". More
  than `max_images` pictures (10, the crop included; 10 references for a new image) is refused by the central check
  first.
- **The answer.** The submit answers `{ id, polling_url, cost, input_mp, output_mp }`; the poll passes Pending,
  Reasoning and Generating to Ready, and Error, Request Moderated (the prompt or an input picture was blocked; the
  same request fails again), Content Moderated (the result was blocked) and Task not found end the run with their
  details. `info` also carries `cost` (credits; the settled cost where the poll carries one, else the submit's),
  `input_mp`, `output_mp`, `expanded_prompt` (`result.prompt`, the prompt as the model expanded it, at most 2000
  characters) and `duration`; the log's success record and `generate` over MCP return it. A FLUX 3 run reports no
  seed unless the answer names one: two runs of the same prompt differ. The poll is `bfl.js`'s for every BFL
  endpoint, FLUX.2 included: a `polling_url` is followed only when it is https on a `bfl.ai` host (the key goes with
  every poll), else `get_result` on the submit host; a 4xx with a status body (422 `Error`) ends the run with its
  details; a 429 or 5xx without one is retried up to five times, since the job is already paid for; the POST is never
  repeated; the cost lands in `info` where BFL reports one.
- **Options** (the variant's `options`): `schema: "flux3"`; `accepts`, the optional fields that may go (default and
  shipped `["safety_tolerance", "grounding"]`; `resolution` is the only other one `flux3.js` knows); `max_images`
  (default 10); `images_field` (default `images`); `boxes: "flux3"`, the row format the route takes for boxes in
  the prompt (below; the other format is `"ideogram4"`, "Ideogram 4" below). The Settings rows: *Safety tolerance* 0 to 4 (default 2; 5 answers 422), *Grounding (web and
  image search)*, a BOOLEAN row on by default as in the API: the model may research the prompt with web and image
  search before it renders; off keeps the prompt from going to search. `body()` copies only the keys `accepts` names,
  so a stray key from the app side never reaches the request. Boxes are not a Settings row: the Boxes switch under
  the prompt field turns them on (below).
- **Boxes in the prompt** (item 28 S1-S3d, `docs/PLAN_BOXES.md`; the docs' bounding-box rows; the built-in Boxes plugin
  of S3a, `plugins/boxes`, keeps a document's boxes and sends them through the plugin hook, `docs/PLUGINS.md`
  "Generate" and "Built-in plugins"). **The Boxes switch** (S3d) is a checkbox in a row of its own under the prompt
  field, shown while the selected recipe takes boxes (`host.boxSwitch(editor).takes`: the variant's `options.boxes`,
  or a text route's `text.refs.options.boxes`); its label counts the document's boxes ("Boxes · 3", the sum of the
  generate sources' `count(doc)`). Its state is the document's `genSettings.boxes` (default off, saved with the `gen`
  key; `set_generation` `boxes`), and `host.runProvider` and `host.runGenerate` read it before they ask any source. Off,
  no source is asked and no box goes; a run of a document that holds boxes adds the note "The document's N boxes did
  not go: the Boxes switch under the prompt is off." The first box the Boxes plugin adds to a document turns it on.
  On, Generate and Generate new send the boxes of every `scumble.generate` source; when the sources hold no box for
  the document (`count` 0) and none answered one, an edit sends the selection as one box (S1): `host.runProvider`
  measures the selection's bounds in the crop (`renderer/editor/boxes.js`: fractions of the frame, clamped to it;
  nothing when it lies outside) and puts
  `request.boxes: [{ id: "red_door_1", kind: "new", rect, src: null, ref: null, desc: <the prompt> }]` into the request
  (the id from the prompt's first two telling words, `edit_1` when it has none);
  with an `@img` token in the prompt the box is `kind: "from"` with that reference's index and `src: [0, 0, 1, 1]`
  (the whole reference picture goes into the selection). A box the crop leaves out still counts as held, so the
  selection does not go in its place; Generate new has no selection and sends only the sources' boxes. Main's
  `electron/main/providers/boxes.js` writes the rows
  after `resolveNames` and before `body()`, where the pictures' final names are known: the prompt, then one sentence
  per box the prompt does not name by `<id>` with its description and its place by thirds of the frame ("In
  <ref_image_0>, place a red door <red_door_1> at the top left." / "Place a lamp <lamp_1> from <ref_image_2> on the
  right." / "Move the sofa <sofa_1> up and to the left, larger."; S3e), on an edit whose prompt is empty or one
  box's own description closed by "Leave the rest of the picture as it is.", a space and the JSON rows, each
  `[top, left, bottom, right]` on the docs' 0 to 1000
  grid of the crop (`ref_image_k` = the k-th picture sent, the crop 0). The rows know every kind the docs list (new,
  keep, move, remove, from; on a text run `{ id, bbox, desc }`, new only); the Boxes plugin's boxes and a plugin's
  own source go the same way. `prompt_sent`, `editor.lastSentPrompt` and the log carry the prompt as
  sent, the log's record `boxes: n`, the status line "Sent with 1 box."; a box that places something (the selection's,
  a plugin's New, From or Move target) under 48 px a side at the emitted size adds a note (the docs: a 40 x 25 px
  element "often did not appear"), and a New box without a description another. A recipe without
  `options.boxes` never gets a box from the renderer, and main drops boxes it is handed anyway with a note. Built
  from the docs; whether the box steers the model better than the green-fill tip is the user's live check
  (`docs/PLAN_BOXES.md` §6).
- **Price** (BFL's pricing page): per image by tier, 1k $0.048, 2k $0.10, 4k $0.607 (`768sq` $0.041, not sent).
  Whether references, input megapixels or Grounding change it is not stated, hence the cost in `info`. The docs say
  4k "can take several minutes"; the poll waits up to 15 minutes.
- **Not built:** Keep rows from the in-app objects (`docs/PLAN_BOXES.md` S4), the regional hosts (the docs name only
  `api.bfl.ai` for this endpoint), and any aggregator variant (item 29, `docs/PLAN_FLUX3.md`).

**Ideogram 4** (`recipes/ideogram_4.json`). On fal (`ideogram/v4/image-to-image`, text `ideogram/v4`) image to image
without a mask: the crop goes in whole at *Strength* and the stitch keeps the selection. **Boxes** (item 28 S5,
`options.boxes: "ideogram4"`, `docs/PLAN_BOXES.md` §3): Ideogram 4 reads a structured caption, a JSON object that is
the whole prompt, keys in this order: `{ "high_level_description": <the prompt>, "compositional_deconstruction": {
"background", "elements": [...] } }` (the background empty on an edit, the prompt on a new image), an element `{ "type": "obj", "bbox", "desc" }` or `{ "type": "text", "bbox",
"text", "desc" }`, `bbox` `[ymin, xmin, ymax, xmax]` on the 0 to 1000 grid of the crop (FLUX 3's grid). Main's
`boxes.js` (`captionIdeogram4`) writes it after `resolveNames`: New boxes as objects, Text boxes as text elements (the
words, their desc beside them), Keep boxes on an edit as objects where they stand; Move, Remove and From boxes have
no counterpart in a caption that describes a picture and stay out with one note naming them ("Boxes ox_1 (Move) ...
were not sent"), as Keep on a new image. With the switch on and no box held, the selection goes as one object (desc
= the prompt). No element left: the prompt goes as written. While the caption goes, *Prompt expansion*
(`expansion_model`) goes as None with a note when the row says otherwise (an expansion rewrites the prompt, the
caption with it); no `style_description` (Kijai's caption builder writes one only when a style is chosen). **Live
2026-10-03** (`docs/PLAN_BOXES.md` §6.4, the user's fal key, `dist/live_ideogram4.py`, pictures in `dist/live-out/`):
fal passes the caption to the model as written and none of the JSON is rendered. An edit with one box put a black cat
in the grass of the selection (109 s, background empty). New images, an apple box and a Text box "SAUNA": with a
written background the sign sat in its box and the apple at the top left, an unasked panel of made-up text filling the
empty top right; with the background empty the model painted a transparency checkerboard over the free half (hence
the prompt as the background of a new image, and a note when the prompt is empty); with the prompt as the background
the picture was one meadow, the sign in its box, the apple box at the top left ignored for an apple on the ground;
the shipped path (the Boxes plugin, `captionIdeogram4`, expansion set to Medium and sent as None with the note) with
the apple box on the ground put both where their boxes were (21 s). Comfy Router and Oxen send the prompt alone (text
only) and take no boxes.

**Ideogram 4.5** (`recipes/ideogram_4_5.json`; `docs/PLAN_IDEOGRAM45.md`). Ideogram's precise edit model: a real
mask edit whose answer has the picture's own size and copies the pixels the edit does not touch. Written from the
hosts' documentation as read on 2026-10-02 and **not run against the live API** (the user's word: from the docs, no
live test). Ideogram has no adapter of its own in Scumble; the variants run on Replicate (the default, built in step
I1), WaveSpeedAI (I2) and Comfy Router (I3).

- **Generate** is Ideogram's *Precise Edit* (Replicate `ideogram-ai/ideogram-4-5-precise-edit`, WaveSpeed
  `ideogram-ai/ideogram-v4.5/edit`, Comfy Router `ideogram/ideogram-4-5` with `image` in the body, whose presence
  selects Precise Edit there; all `input: "fill"`): the crop as `image`, the selection as `mask` (WaveSpeed:
  `mask_url`) and the reference layers (the Original first when it is on) as
  `reference_images`; Replicate and WaveSpeed take the pictures as uploads, the Router as data URIs in the body.
  **The mask is inverted** (Replicate and WaveSpeed `options.mask: "black"`, the Router's ideogram dialect by the
  model id; `util.js` `ideogramMask`): Ideogram edits where
  its mask is black and keeps the white, the reverse of Scumble's; channel 0 at 128 or more becomes black. Ideogram
  refuses a mask without both colours, so a selection over the whole crop sends **no** mask (the whole crop is edited,
  the stitch keeps the selection, `info.mask` says so), and a selection with no pixel at half strength is refused
  before anything is sent. `options.max_images` 4 counts the crop and the references (Precise Edit takes 3 references
  beside a mask). The references go **unnumbered** (the layout's `style`, as Magnific's Ideogram): no host documents how
  a prompt names one, so an `@img` token is refused ("without a number"). No negative prompt (`options.negative:
  false`), no size and no aspect: the answer follows the crop. WaveSpeed's edit also takes *Edit precision* (a Settings
  row, regular / high, default **high** here, WaveSpeed's own default regular): high "restores unchanged pixels" in
  WaveSpeed's words; whether high is Ideogram's Precise Edit and regular its generate operation is not documented.
- **Generate new** is the text route, the prompt alone (a picture there would be the one edited, so `text.refs` stays
  off). Replicate (`ideogram-ai/ideogram-4-5`): `size` the closest of the seven presets in `options.sizes`
  (1024x1024, 1280x896, 896x1280, 1344x768, 768x1344, 1536x640, 640x1536) to the asked aspect or size, no
  `aspect_ratio`. WaveSpeed (`ideogram-ai/ideogram-v4.5`): `aspect_ratio` the closest of seven presets
  (`options.aspect_ratios`: 1:1, 4:3, 3:4, 3:2, 2:3, 16:9, 9:16) and `resolution` 1k / 2k by the asked long side
  (`options.tiers`, `util.js` `tierFor`: up to 1024 px 1k, above 2k; the pixels of each are not documented),
  `enable_prompt_expansion: false` from `text.fixed`, so the prompt goes as written (WaveSpeed's default would expand
  it). Comfy Router (the same id, no picture field, so Ideogram's generate operation): `size` the preset of
  `options.resolutions` closest to the asked aspect (or size) within the tier the asked size bills as, 1K up to 1024 x
  1024 pixels, else 2K, and `magic_prompt: "off"` from `text.fixed` (the Router's default auto would rewrite the
  prompt). The 36 presets (15 1K, 21 2K): the 4.5 generate
  page says a new image takes only "the supported 1K/2K presets", names three of them and holds every exact size to
  sides that are multiples of 32, at most 2048 x 2048 pixels and 6:1; so the list is Ideogram's 38 sizes of its 4.0
  page without the six that break the 32 rule (1280x720, 720x1280, 1440x720, 720x1440, 1296x3168, 3168x1296), plus
  Replicate's 4.5 shapes 1344x768, 768x1344, 1536x640 and 640x1536. Which presets 4.5 really takes is a live check.
  The text routes have no *Very low*, so `options.text_values`
  sends it as *Low* on all three.
- **Seed** under Ideogram's cap on Replicate and Comfy Router: `options.seed_max` 2147483647, the editor's seed modulo
  2^31 (`util.js` `seedOf`); Replicate reports the seed only in its logs, so the answer reports the one sent; the
  Router's answer names the seed Ideogram used. WaveSpeed's two routes take **no seed** (two runs differ), and the
  answer reports none.
- **Comfy Router's answer** is `{ data: [{ url, seed, resolution, is_image_safe }], generation_id, seed }`: the picture
  is downloaded from `url`, `info` keeps `generation_id` and the `resolution` answered, and a picture the answer marks
  `is_image_safe: false` is not used ("Only use images where this is true"; the run fails when no other is safe). The
  same holds for Ideogram 4.0's text-only Router variant, whose answer has the same shape.
- **Only the keys the routes name** (WaveSpeed; both schemas say `additionalProperties: false`, whether the server
  enforces it is not stated): `options.accepts` `quality`, `edit_precision` for the edit and `options.text_accepts`
  `quality`, `aspect_ratio`, `resolution`, `enable_prompt_expansion` for a new image. Everything else the adapter
  would add (seed, `output_format`, a negative prompt) and a Settings row the route lacks stays home: a new image gets
  the edit's Settings rows (`host.providerParams`), so *Edit precision* reaches the text run and is dropped there.
  The list is the allowlist `docs/PLAN_FLUX3.md` F4 needs for FLUX 3 on WaveSpeed (used there since B6).
- **Settings:** *Quality* very_low / low / medium / high (default medium), also the billed rate; Replicate `fixed`
  `num_images: 1`, the Router's dialect sends `num_images: 1` in every body (WaveSpeed has no such field). **Price**
  (2026-10-02): an edit $0.008 / $0.03 / $0.06 / $0.22 per image on Replicate and WaveSpeed; a new image $0.03 / $0.06
  / $0.10 on Replicate, $0.03 / $0.06 / $0.22 on WaveSpeed (Low / Medium / High, 1k and 2k the same); Comfy had not
  published its price.
- **Checks before sending** (Ideogram's Precise Edit page, on all three hosts; on the Router `picturesFor` holds the
  crop and the references, the dialect the mask): the recipe's `limits.ratio` 6 widens a crop steeper than
  6:1 wherever the picture allows, and `options.max_ratio` 6 refuses one that stays steeper (a picture narrower than
  that); `options.max_bytes` 25,000,000 holds the crop, the mask and each reference to Ideogram's 25 MB (an opaque
  picture over it goes as JPEG, one with transparency is refused; Replicate's and WaveSpeed's refusals end "Nothing
  was sent", the Router's have their own words and hold each reference layer to the 6:1 shape too). Otherwise the conservative 2048
  default size until a live run says how large a crop the hosts take.

What a provider run does: `prepareCrop` builds the crop like the node (selection bbox
plus context, fill mode, scaling to the size the variant's `limits` allow, the grown and feathered
denoise mask, "with original" and reference layers as extra images), the main process
(`electron/main/providers/<provider>.js`) makes the request, `finishResult` resizes the
answer to the region (center-crop when the aspect differs), builds the composite mask
(selection with soft edge, or the whole rectangle for Paste = crop), colour-matches
against the ring the composite keeps, and stores the RGBA patch in the file mirror as
`output/inpaint_canvas/n<id>_result_<stamp>.png`; the editor adds it as a result layer
and history entry like a result from the node. Not ported: the ECC alignment of the
result to its surroundings (the node's Align option), Lanczos resizing (the browser's
resampler is used), the Navier-Stokes "border" fill (behaves like "blur").

A hidden `loopback` provider returns the crop unchanged (no key); `tools/smoke_test.py`
uses it to check the crop / stitch path.

### Upscale recipes (`task: "upscale"`)

An upscale recipe is a provider recipe with `"task": "upscale"` (the default task is `edit`). It runs through the
*Upscale* button next to *Generate new* (a dialog: model, provider, the selection or the whole picture, the
factor), the `upscale` command (`docs/COMMANDS.md`; the assistant asks before it, as for `generate`), or *Generate*
while the recipe is selected (then on the selection). The recipe select lists these recipes in the family
*Upscale*. `normalize()` gives every variant of such a recipe:

- `factor: { default, min, max, steps, fixed }` from the recipe's or the variant's `factor` block (without one:
  2, 1 to 4). `steps` lists the only factors a model takes (Magnific Creative and both Magnific nodes on Comfy
  Cloud: 2, 4, 8, 16); `fixed: true` marks a model that picks its own (Recraft's upscalers), and no factor is sent.
  The host refuses a factor outside what the variant offers before anything is sent.
- `usesPrompt`: only then does a prompt go along, as guidance (Clarity, Magnific Creative): the Upscale dialog shows a
  Prompt field for such a recipe, filled with the tab's prompt and sent as the `upscale` command's `prompt` (the
  tab's own prompt stays as it was); without that argument (Generate with an upscale recipe, an agent that leaves it
  out) the tab's prompt goes. The negative prompt is always the tab's. `list_recipes` says `usesPrompt` per upscale
  recipe. Every other upscaler gets no prompt.
- `text: null` (an upscaler has no *Generate new* shape) and its `limits` as any variant. The shipped recipes set
  `limits: { min: 32, max: 4096, step: 1 }`: the crop goes out at its own size (the size mode `crop`, whatever the
  *Highres fix* select says), never pushed up to the model's maximum and never rounded to a multiple. An upscaler
  whose answer has a cap sets `limits.out`, the answer's long side (`rtx_vsr_cloud`: 64 / 4096 / step 1, `out`
  8192; `editLimits` keeps it as a whole positive number, else drops it): the sent long side times the factor may not
  pass it, checked before anything is sent by `host.upscaleOutRefusal` (the last rule of `upscaleSizeRefusal`) on the
  whole picture and on the selection's box as it goes out (held to `limits.max` first, so a 4400 px box goes out at
  4096 and is checked at that size), and by the Upscale dialog, which greys *Upscale* with the same words.

The two modes (`host.runUpscale(editor, { scope, factor })` in `renderer/editor/host.js`):

- **The selection** (a detail pass): `prepareCropAsync` makes the crop as for any provider run but with no fill
  and without the reference layers; the request is `kind: "upscale"` with `factor`; the answer, N times larger,
  goes through `finishResultAsync`, which fits any answer back into the crop box (stretched when the aspect
  matches), and lands as a result layer. The selection comes back sharper at the document's resolution; nothing
  gets bigger.
- **The whole picture**: the base image alone goes out (the layers stay layers). The answer becomes the new base
  at its own size (stretched to the document's aspect if the model rounded a side), and every layer, filter mask
  and the selection are scaled by the same factor through `resizeImage(nw, nh, { base })`, the path of *Resize*,
  as one `canvas` undo step. A picture whose long side is above the variant's `limits.max` is refused with its size
  in the message (the dialog greys *Upscale* out); a banded upscale of a larger picture is session U3's
  (`docs/PLAN_0_1_24.md`).

**On the user's ComfyUI** (`kind: "comfy"` with `"task": "upscale"`, e.g. `upscale_model_local`): `normalize()`
gives the recipe `factor: { ..., fixed: true }` (the model picks its factor, the dialog shows none) and turns any
other `task` into `edit`. A recipe that names the input its factor goes into, `"factor": { "default", "min", "max",
"input": "<node>|<input>" }` with the node in its graph (`rtx_vsr_local`: `"rtx|resize_type.scale"`, the dotted key of
the node's dynamic combo, a flat key in the API prompt), keeps an unfixed factor: the dialog lists its whole steps, the
`upscale` command's `factor` is checked against it, and `queueGenerate` writes it there (the factor rides on the
editor as `_comfyUpscaleFactor`, read once, since `editor.generate()` takes no arguments). `"limits": { "min", "max",
"out" }` (the input's short side, its long side, the answer's long side) are checked on the crop the node cuts before
anything is uploaded (`host.upscaleSizeRefusal`); `*Save to recipe*` keeps `factor` and `limits`, and a *Cloud copy*
runs at the factor its graph holds (its factor fixed, with a note). Both modes:

- **The selection**: the node's stitch resizes every answer to the crop box. `host.queueGenerate` runs it like any
  ComfyUI recipe with three differences: it refuses without a selection, the canvas state it sends is
  `host.upscaleState(...)` (crop `fill: "none"` and `withOriginal: false`, `references: []`, no refine pass; the
  document's own crop settings are untouched), and the canvas node gets `target_size: 0`, so the node grows the box to
  `multiple_of` instead of scaling the crop before the model sees it. The `upscale` command runs it through the
  `generate` command's path (queue, wait for the result layer).
- **The whole picture** (0.1.42 U2, `host.runComfyUpscale`): the base alone is drawn at its size, stored in the mirror
  and on the server (`uploadInput`), and the recipe's own graph runs on it through `comfyPictureRun` (queued behind the
  user's jobs, a helper prompt): `renderer/editor/comfyprompt.js` `wholePicturePrompt(r, ref, factor, settings)` keeps
  the canvas node's id and makes it `InpaintCanvasLoadRef { ref }` (its output 0 is an IMAGE like the canvas node's
  slot 0, so the links that read `[canvas, 0]` read the picture), writes the Settings rows and the factor, and adds a
  `PreviewImage` named `scumble_out` on the recipe's `result` (temp files, nothing in the user's output folder). The
  answer lands through `landWholePicture`, the API upscalers' tail: the new base at its own width, every layer, mask
  and the selection scaled along through `resizeImage(nw, nh, { base })`, one `canvas` undo step. The loader gives
  RGB, so a cut-out picture comes back opaque (the dialog says so). Refused before anything is drawn or sent: a graph
  that reads anything but slot 0 of the canvas node (its mask, its prompt, a Settings slot: "... reads more than the
  picture from the canvas node (its crop_mask); it cannot upscale the whole picture."), no connection, a node type of
  that prompt the server lacks (`InpaintCanvasLoadRef` and `PreviewImage` instead of `InpaintCanvas`), a document that
  is busy (`turnBlocked`), and `upscaleSizeRefusal(r, W, H, factor, "picture")` (the long side past `limits.max`, the
  answer past `limits.out` at the factor; not checked for a fixed factor). The document is busy like a run meanwhile
  (`providerPending` holds a `{ provider: "comfyui", label }` token: the title row's timer and its *Cancel*, which takes
  the job off the server; Generate and a turn refuse); closing the tab ends it and lands nothing.

The dialog offers both scopes, hides the factor for a fixed one and the provider row, says for the whole picture what
goes out and comes back with the transparency line, and disables *Upscale* without a selection (the selection's
mode), without a server connection, when the server lacks a node type of the chosen route (named in the note), or for
a refusal of the size or the graph.

**The Realism Pass entry** (a `pass` recipe, `realism_pass` above) is listed in the same dialog but is no upscale:
its factors are *1× (refine)*, *1.5×*, *1.7×*, *2×* and *3×* (`realism.MODES`, the pack's upscaling modes; 1.7× is
its 1.724x Balanced), its scope is always the whole picture, and *Upscale* runs the `realism_pass` command (the whole
visible picture through `realism.passPrompt` at the mode, a new layer above it; above 1× the document resized by the
factor first, one undo step) instead of the recipe's graph. The dialog greys *Upscale* with `realism.serverSupport`'s
reason or the size refusal (`realism.wholeRefusal` at 1×, `realism.fitPlan` above, which scales a picture past the
output cap down instead and says to what).

The adapters: `upscale(req, ctx)` beside `edit` / `generate`; `providers/index.js` sends `kind: "upscale"` there
and refuses a provider without one by name. **fal** (`fal.js`): `{ image_url, upscale_factor, output_format:
"png", the variant's settings }` to the variant's `model` through the queue, waiting up to 30 minutes (Topaz takes
minutes on a large picture; the recipe description and the status line say so). `fields.factor` renames the
factor (or `false` leaves it out, Recraft), `options.omit` drops fields a strict endpoint refuses (Clarity and
Recraft take no `output_format`), `options.seed` sends the seed (Clarity, SeedVR2), `options.numbers` names rows
whose choices are numbers written as a list, and a row set to `auto` is left out so the model's own default holds
(Topaz: Sharpen, Denoise, Fix compression; its defaults differ per model). **Magnific** (`magnific.js`, below).
**Comfy Cloud** (`comfycloud.js`): LoadImage -> one of `MagnificImageUpscalerPreciseV2Node`,
`MagnificImageUpscalerCreativeNode`, `RecraftCrispUpscaleNode`, `RecraftCreativeUpscaleNode` -> SaveImage, the
Magnific factor as `"4x"` and `auto_downscale: false` (Scumble refuses an oversized picture itself), the settings by
input key; their inputs were read from a ComfyUI's `/object_info` on 2026-09-22. `RTXVideoSuperResolution`
(`rtx_vsr_cloud`, 0.1.42 U3; no Partner Node but a node Comfy Cloud runs on its own GPUs, its inputs read with Comfy
Cloud's `get_node` on 2026-10-04) takes the picture as `images`, `resize_type: "scale by multiplier"` with the factor as
`"resize_type.scale"` (the dotted key of the dynamic combo, 1 to 4, a float) and `quality` (LOW / MEDIUM / HIGH /
ULTRA, the Quality row by its key); its answer may be at most 8192 px on the long side, which `buildGraph` checks before
any upload (`BEFORE_UPLOAD`, the size from the request or the PNG's header) and the SHAPE again, with the renderer's
words, so a direct call is refused before the prompt is sent too. The hidden **loopback** answers the
picture resampled by the factor (2 when the model picks) with a 4 px magenta frame, which is what
`tools/upscale_test.py` looks for.

**The checkpoint, 2026-09-22** (the user's fal and Magnific keys, a scratch profile, a 1907 x 1073 photo, one call
each, factor 2): *Topaz Precision* on fal, a 538 x 512 selection box in 25 s and the whole picture to 3814 x 2146 in
24 s, and once at **4 times** (the one run above 2: 3814 wide became 7628 x 4292, 33 MP, in 34 s, the answer
read and taken as the new base without trouble); *Magnific Precision* (V2) on Magnific, the same box in **311 s**; *Magnific Creative* on Magnific, the same box in
13 s. Every answer came back aligned with its box (checked by eye against the original), the whole picture became the
base at twice the size. The request bodies, the fal queue and the Magnific task poll are right as written. Not run (the user, 2026-09-22: the users will try them):
the other fal upscalers, both routes on Comfy Cloud, factors above 2 except that one 4x, and the size limits (`limits.max` 4096 stays
until a larger picture is tried). The fal answer's size is not read back (`info` carries no width), which the status
line would show.

The shipped recipes (written from the providers' schemas; the three named above and `rtx_vsr_cloud` have run live):

| Recipe | Providers (default first) | Factor | Rows |
| --- | --- | --- | --- |
| `topaz_precision` Topaz Precision | fal `topaz/upscale/image/precision` | 1 to 4 | Model (Standard V2, High Fidelity V3 / V2, Low Resolution V2, CGI, Text Refine, Faces), Face enhancement, Sharpen, Denoise, Fix compression |
| `topaz_creative` Topaz Bloom | fal `topaz/upscale/image/creative` | 1 to 4 | Model (Bloom 2, Bloom, Bloom Realism), Creativity 1 to 9 (Bloom 2) |
| `topaz_generative` Topaz Wonder / Redefine | fal `topaz/upscale/image/generative` | 1 to 4 | Model (Wonder 3.5 ... Recovery), Face enhancement |
| `clarity_upscaler` Clarity | fal `fal-ai/clarity-upscaler` | 1 to 4 | Creativity, Resemblance, Steps, Guidance; prompt, negative and seed go along |
| `seedvr2` SeedVR2 | fal `fal-ai/seedvr/upscale/image` (factor mode) | 1 to 8 | Noise; the seed goes along |
| `recraft_crisp` Recraft Crisp | fal `fal-ai/recraft/upscale/crisp`, Comfy Cloud | the model's | none |
| `recraft_creative` Recraft Creative | fal `fal-ai/recraft/upscale/creative`, Comfy Cloud | the model's | none |
| `magnific_precision` Magnific Precision | Magnific `image-upscaler-precision-v2`, Comfy Cloud, Comfy Router `freepik/ai-image-upscaler-precision-v2` | 2 to 16 (Comfy Cloud 2, 4, 8, 16) | Flavor, Sharpen, Smart grain, Ultra detail |
| `magnific_creative` Magnific Creative | Magnific `image-upscaler`, Comfy Cloud | 2, 4, 8, 16 (at most 25.3 MP out) | Optimized for, Engine, Creativity, HDR, Resemblance, Fractality; the prompt goes along |
| `rtx_vsr_cloud` RTX Video Super Resolution (Comfy Cloud) | Comfy Cloud `RTXVideoSuperResolution` (run live 2026-10-04: 1024 to 2048 px in 21 s) | 1 to 4 (at most 8192 px out; the whole picture not at 1×) | Quality (ULTRA by default) |

**Who else serves an upscaler** (the survey of 2026-09-22; only lists that answer without a key could be read, and
**no key but BFL's is stored in this install**, so Replicate, WaveSpeed and ToAPIs stay open): OpenRouter's
`GET /api/v1/images/models` lists no upscaler. Oxen.ai's `/models` lists `topazlabs-image-upscale`,
`topazlabs-bloom-image`, `topazlabs-bloom-2-image`, `topazlabs-wonder-3-image`, `topazlabs-wonder-3-5-image` and
`flux-image-upscaler` (session O1 decides their variants). The ComfyUI Partner Nodes (a ComfyUI's `/object_info`)
have, besides the four above, `TopazImageEnhanceV2` (Reimagine, Bloom 2, Wonder 3.5, a dynamic combo with many
required sub-inputs and an output size instead of a factor: not wired yet) and `WavespeedImageUpscaleNode`
(SeedVR2 or Ultimate to a 2K / 4K / 8K target, no factor: not wired). Replicate's `collections/super-resolution`
and WaveSpeed's model list answered 401 without a key.

What only a real key can verify: that each endpoint takes a data URI (fal) or base64 (Magnific) of the crop's size,
that the answer comes back at the factor (Recraft's is unknown), fal's Topaz limits at 4x on a 4 MP input (they
decide `limits.max`), Magnific's task routes and status names as read, and the Comfy Cloud nodes' inputs on the
cloud's own node versions.

### ToAPIs (`toapis`)

[ToAPIs](https://toapis.com) is a reseller on a New API gateway: one key for GPT Image 2 and 2.5,
Nano Banana 2 / 2 Lite / Pro, FLUX.2 pro and flex, Seedream 5 lite and pro, and Qwen Image 3.0.
The adapter `electron/main/providers/toapis.js` is written from the English docs
(`docs.toapis.com/docs/en/...`, read 2026-09-15) and **has not run against the live API**; every
ToAPIs variant's note says so, and says that crop, mask and references are uploaded to public
`files.toapis.com` URLs. The key link (Settings › API providers) carries the author's referral code.

**Where it shows up.** First in every provider list: the key rows (first in `PROVIDERS`), each served
recipe's provider select, the Generate-new select and `list_recipes` (`toapis` is the first key of
`providers` in the eleven recipe files), and in `TEXT_PROVIDERS`. **No recipe's `default` changed and
nothing switches to ToAPIs on its own** (the user's decision of 2026-09-15): a recipe runs on ToAPIs
when you pick it in the recipe's select, in Generate new or with `select_recipe(id, "toapis")`. With a
key stored, the row's *check balance* asks `GET /v1/balance` (free, IPC `provider:balance`) and shows
the USD left (credits / 200).

**The protocol.** Everything is a task and nothing takes base64:

1. `POST /v1/uploads/images` (multipart `file`, at most four at a time) for the crop (first), the
   references and, where the channel has one, the mask; each answer's `data.url` goes into the request.
2. `POST /v1/images/generations` with `{ model, prompt, n: 1, size, resolution | metadata.resolution,
   image_urls, mask_url, ... }`; the task id is `id` (or `task_id`). A 429 or 503 here means the task
   was not accepted, so it is sent once more after `Retry-After`; a network error is never retried (a
   lost answer could be a second paid task).
3. `GET /v1/images/generations/<id>`: first after 4 s, then every 5 s plus up to a second of jitter,
   15 minutes at most; `pending`, `queued`, `submitted` and `in_progress` keep it polling, a 429 or
   503 waits `Retry-After`. A status query costs nothing and the task is paid for once submitted, so
   a query lost to the network or answered 500 / 502 / 504 is polled past, five in a row at most
   (the wait grows with each), and the error then names the task and the ToAPIs console. `failed`
   arrives as HTTP 200 and is thrown as `ToAPIs <model> (task <id>): <error.message>`, which is what
   the status line and the log show.
4. `completed`: `result.data[0].url`, else a top-level `url`, downloaded at once (it lives 24 h) and
   **without** the key, three tries 2 and 4 s apart; a download that keeps failing names the model
   and the task and says the image stays in the ToAPIs console for 24 hours.

Failed HTTP answers get a plain prefix before the server's own message, which may be Chinese: 401
"key refused", 402 "balance too low, top up at toapis.com", 403 "key not allowed for this model", 422
"refused by the content policy", 429 "rate limited". The key is taken out of every message. The run's
`info` (model, channel, task, size, resolution, `billing.cost_usd` and `credits` when present) goes to
the log. No `callback_url` (ToAPIs refuses loopback webhooks) and no `output_compression` (its page
describes the scale backwards).

**The host** is `https://toapis.com` unless `settings.toapis.base` names one of
`https://toapis.com`, `https://api.toapis.com`, `https://toapis.cn`, `https://api.toapis.cn` or
`http://127.0.0.1:<port>` (the test mock); anything else, a path included, is ignored. It never comes
from a recipe, because an imported recipe could otherwise send the key anywhere. There is no UI for it.

**Channels.** Normal, VIP and official are different model ids with different rules. The variant's
`model` is the default channel's id, and `options.channels` maps each value of the *Channel* settings
row to its overrides (`model`, `mask`, `size`, `ratios`, `tiers`, `tier_key`, `urls`, `drop`,
`transparent_only`, `max_images`), for edit and text runs alike; the cap is the chosen channel's own `max_images`,
else the variant's (`capOf(channelOf(req))`, read by the layout and the builder alike, so `provider:layout` and the
send follow the Channel row; the GPT Image 2.5 channels name none, "Reference pictures" above). The default is the official channel
wherever one exists: the vendor's own cloud (Azure for GPT, Vertex AI for Gemini), the only mask
endpoint, plain string URLs. The docs never name the upstream of the normal and VIP channels; their
prices, far below the vendor's, suggest third-party backends.

| Recipe | Default model | Channel row | Input, size | Resolution |
|---|---|---|---|---|
| `gpt_image_2` | `gpt-image-2-official` | official, vip (`gpt-image-2-vip`, no mask), standard (`gpt-image-2`, no mask, presets, no quality) | **fill**: `mask_url` from the alpha mask; the crop's own ratio | `resolution` 1k / 2k / 4k |
| `gpt_image_2_5_flare`, `_sunburst` | `gpt-image-2.5-<name>-official` | official, vip (`-vip`), standard (plain id: presets, a 1K / 2K / 4K tier, no quality) | edit; `WxH` in 16 px steps, 655,360 to 8,294,400 px, at most 3:1 | none (pixels) |
| `nano_banana_2` | `gemini-3.1-flash-image-official` | official, vip (`-preview-vip`), standard (`-preview`); both with `{url}` objects | edit; the closest of the channel's presets | `metadata.resolution` 1K / 2K / 4K |
| `nano_banana_2_lite` | `gemini-3.1-flash-lite-image-official` | none | as 3.1 Flash official | as 3.1 Flash |
| `nano_banana_2_1` | `gemini-nano-banana-2.1` (standard; no official channel) | standard, vip (`-vip`); both with `{url}` objects, the shape of the 3.1 Flash channels (no page for 2.1, not verified) | edit; the closest of the channel's presets | `metadata.resolution` 1K / 2K / 4K |
| `nano_banana_pro` | `gemini-3-pro-image-official` (the id of ToAPIs' price list) | official, vip, standard (`gemini-3-pro-image-preview[-vip]`, objects) | edit; presets | `metadata.resolution` 1K / 2K / 4K |
| `flux2_pro`, `flux2_flex` | `flux-2-pro`, `flux-2-flex` | none | edit, 8 images; 7 presets | `metadata.resolution` 1K / 2K |
| `seedream_5_lite` | `doubao-seedream-5-0` | none | edit, 10 images; 9 presets; inputs at most 3:1 | `metadata.resolution` **2K / 3K** |
| `seedream_5_pro` | `doubao-seedream-5-0-pro` | none | edit; 9 presets; inputs at most 3:1 | `metadata.resolution` 1K / 2K |
| `qwen_image_edit` | `qwen-image-3.0` | standard, pro (`qwen-image-3.0-pro`) | edit, 3 images; `WxH` (512² to 2048², at most 8:1), `metadata.seed`, `metadata.negative_prompt`, fixed `metadata.prompt_extend: false` | none (pixels) |

A variant's `options` describe the rest: `mask` (a `fill` run uploads `req.maskAlpha`, alpha 0 =
repaint, as `mask_url`; only `gpt-image-2-official` has one, every other channel leaves the mask out
and the stitch keeps the selection), `size` (`ratio`: the crop's reduced `W:H`, clamped to 3:1;
`preset`: the closest of `ratios`, or a text run's own aspect when it is one of them; `pixels`: `WxH`
under `pixels` rules), `tiers` with `tier_key` and `tier_sizes` (a *Resolution* row left on auto takes the
smallest tier whose output covers both edges of the emitted crop; the output per tier comes from the model
page's table for the size sent, `{ "16:9": { "1K": "1820x1024", ... } }`, carried for GPT Image 2, the
standard channel of GPT Image 2.5, FLUX.2 and Seedream 5 lite, and a tier the table lacks is judged by its
base against the long side, as every tier of the Nano Banana models is. A tier's base is not its long edge:
FLUX 1K 16:9 is 1820 × 1024 and GPT Image 2 1k 2:1 is 2048 × 1024, so the base alone bought the dearer 2K
for every non-square FLUX crop), `urls: "objects"` (`image_urls` as `[{ url }]`), `images`
(another image field), `drop` (parameters a channel does not take), `transparent_only`, `max_images`
(the pictures of the chosen channel, crop included, read as a number above 0; more are refused before any upload,
in the app by the central check first), `max_ratio` (the steepest input the model takes: Seedream's 3;
the variant's `limits.ratio` widens the crop to it, and a reference layer steeper than that, or an image
too narrow to widen, is refused before any upload), `seed` and `negative` (where a model takes them).
Settings pass through by key and **dotted keys nest** (`metadata.resolution` becomes
`{ metadata: { resolution } }`); `channel`, `random_seed`, empty values and `auto` are not sent.
Crops of another shape than a model's presets come back re-framed and are centre-cropped by
`finishResult`, as with WaveSpeed.

**The 10 MB upload limit.** Measured on 2026-09-15 with `canvasBytes` (Chromium's PNG encoder) on
crops cut at full resolution from four photographs: 2048 × 2048 came to 5.9 to 9.5 MB, 3840 × 2160 to
11.9 to 18.7 MB, and random noise (the worst case) to 14.4 and 28.5 MB; as JPEG at quality 0.92 the
same crops were 0.7 to 1.7 MB, 1.3 to 3.1 MB and 3.7 / 7.3 MB. So every size check happens before any
request, against **10,000,000 bytes** (the page says "10MB" with no byte count; the smaller reading means a
file between it and 10 MiB takes the fallback instead of the server's refusal): a **crop** over it is
re-encoded as JPEG (quality 92, Electron's `nativeImage`, `ctx.toJpeg` from `providers/index.js`; a
transparent crop loses its alpha there), and one still over it is refused with "set Highres fix lower". A
**reference** over it is re-encoded the same way when it has no transparent pixel (`ctx.opaque`: the PNG
header, else the decoded alpha), which the *Original* copy of the crop never has; a reference with
transparency keeps its PNG (a JPEG would flatten the cut-out) and is refused with "set Highres fix lower,
turn Original off, or use a smaller reference layer". A **mask** over it is refused (its alpha is the
mask). The limits stay at 2048 (FLUX at BFL's 1440, GPT Image 2.5 and Qwen with a 4,194,304 px budget).

**Privacy.** Crop, mask and references become public `files.toapis.com` URLs (the generation API
takes URLs only); the docs do not say how long an upload lives. Results are there for 24 hours. The
mainland China hosts (`toapis.cn`) are allowed only through the setting.

**Only a real key can verify** (written defensively, and listed here until a live run):

- `image_urls` as strings or `{url}` objects on the Gemini standard and VIP channels (the pages
  contradict each other; strings go to official, objects to the other two);
- that a PNG with alpha survives the upload unchanged, and the mask's polarity on `gpt-image-2-official`;
- the real output size for a custom ratio, and for `auto`;
- the ids `gemini-3.1-flash-lite-image-official` (no page of its own) and `gemini-3-pro-image-official`
  (the English page says `gemini-3-pro-image-preview-official`);
- whether `metadata.prompt_extend: false` is honoured on Qwen, and whether FLUX takes a crop over 1440;
- `billing.cost_usd` per tier, the real durations, which result shape arrives, and the language of the
  error messages;
- whether uploads are accepted as `image/jpeg` for the crop and reference fallback on every model
  (Seedream takes JPEG and PNG only, which both are);
- which "10MB" the upload endpoint counts (the adapter holds files to 10,000,000 bytes);
- the output sizes per tier on the Nano Banana channels and Seedream 5 pro (their pages give none, so
  auto picks by the long side there), and whether the tables on the other pages are what really comes back;
- how the gateway answers a status query during an outage (5xx polled past), and whether Seedream's 3:1
  input limit is checked on the crop only or on every reference too.

**Tests.** `node tools/toapis_test.js` runs the adapter in plain Node against a scripted fetch (the
official fill with its alpha mask, the other channels, objects and nesting, text runs, a new image with
reference layers (uploaded alone into the channel's image field, the channel's cap), pixel sizes,
polling with a 429 and both result shapes, failures, the 10 MB guard, the key on every API call and
never on the download or in a message, the balance, the host allowlist, and every shipped variant on
every channel). Gate `toapis` (`tools/toapis_test.py`) runs that first, then drives the app against
`tools/toapis_mock.py` with a test key (refusing a profile that holds a real one): the list order and
the kept defaults, *check balance*, the shipped `gpt_image_2` variant on the official channel (crop and
alpha mask uploaded, the crop's ratio and tier) and on the standard channel (no mask), Generate new
without an upload, a failed task in the status line and in the log without the key, and a 429 at
submit sent again. Each counter-proof was red: the luminance mask for `maskAlpha`, no `Retry-After`
wait, the key sent to the file host, no metadata nesting, no JPEG fallback, a base outside the
allowlist, the mask on every channel, and ToAPIs last in `PROVIDERS`.

**The review of 2026-09-15** found, and the tests now cover (each fix red when undone):
- the editor kept a provider setting whenever its target was unchanged, and every provider recipe's
  targets were `provider:<key>`, so a *Channel* of "standard" chosen on Qwen via ToAPIs carried over to GPT
  Image 2 via ToAPIs and ran it on its maskless channel (and GPT Image 2.5's "xhigh" quality fell to
  "low" on GPT Image 2). The target now names the recipe and its provider (`host.settingTargets`), so a
  switch starts from that recipe's own defaults and setting the same recipe again keeps a choice
  (`toapis_test.py` `a_recipe_switch_starts_from_that_recipes_own_settings`);
- Generate new sent the rounded pixel size, so a ratio channel got "64:43" for 3:2 at 1024; the dialog
  sends the aspect and the long side now (`generate_new_dialog_on_toapis` drives the dialog itself);
- one 5xx on a status query or on the download threw a paid task away; the tier by the base bought 2K for
  FLUX crops 1K covers; references never got the JPEG fallback; Seedream's 3:1 input limit was not
  checked; the upsample rows retried any 4xx without the crop and lost the "text only" note; the 10 MB
  guard counted MiB (`node tools/toapis_test.js` sections 3, 1, 5, 5b and 8,
  `a_thin_selection_on_seedream_gets_context_up_to_3_to_1`).

### OpenRouter (`openrouter`)

[OpenRouter](https://openrouter.ai) is an aggregator: one key for most hosted models, each request routed to
a host that serves the model. Scumble uses its unified Image API for 15 recipes (GPT Image 2 and 2.5 Flare /
Sunburst, Nano Banana 2 / 2 Lite / Pro, FLUX 3 Image, FLUX.2 max / pro / flex, Seedream 5 lite and pro, Grok Imagine 2.0,
and in Generate new only Krea 2 and Recraft V4) and its Chat Completions for prompt upsampling (docs/HELPERS.md
"Through the OpenRouter key"). The adapter `electron/main/providers/openrouter.js` is written from OpenRouter's
docs (the `.md` twins of `openrouter.ai/docs/...`, `openapi.json`, the per-model guides at
`openrouter.ai/<id>/llms.txt`) and its public lists (`GET /api/v1/images/models`, `.../<id>/endpoints`,
`GET /api/v1/providers`), all read on 2026-09-19. **It has run against the live API since 2026-09-21** with
GPT Image 2.5 Flare and Sunburst (the user's log up to 2026-09-23: about 44 and 112 edits that came back, one
host error that charged nothing, one refusal by OpenAI's safety system); no other model has run through it yet.
Every OpenRouter variant's note says which of the two it is and names the company the pictures go on to.

**What the live runs showed.** GPT Image 2.5 edits the picture in `input_references`, it does not merely take it
as a reference: the four brand marks of the tutorial picture were removed in the app this way (docs/TUTORIAL.md).
**A crop whose context reaches bare skin can be refused** by OpenAI's safety system through OpenRouter
(`safety_violations=[sexual]` for a crop of a handbag that took in the legs around it); the same selection with
a tighter context (*Context* manual in the Crop panel with a small padding; for an agent `set_crop { context: "manual" }`
and `set_node_params { padding: 24 }`) went through. The refusal
reaches the user as the provider's own sentence.

**Where it shows up.** The key row comes after Comfy Cloud in Settings › API providers (`PROVIDERS` in
`providers/index.js`, before Anthropic's key-only row), with the hint `sk-or-v1-...`, *get a key*
(`openrouter.ai/settings/keys`, no referral code) and, with a key stored, *check balance*. In the 14 recipe
files `openrouter` is the **last** key of `providers`, so it is last in each recipe's provider select, in
Generate new and in `list_recipes`; ToAPIs stays first. **No recipe's `default` changed and nothing switches
to OpenRouter on its own**: a recipe runs there when you pick it in the recipe's select, in Generate new or
with `select_recipe(id, "openrouter")`. `openrouter` is in `TEXT_PROVIDERS`, and a text run uses the edit
variant's model id (the Image API takes `input_references` as optional). The descriptions of the 15 recipes
say "Also on OpenRouter." FLUX 3 Image's variant (docs/PLAN_0_1_38.md B3) sets the options that make it
BFL's request: `prompt: "as_written"` (no instruction around the prompt, so the box rows stay at its end; a blank
prompt is refused), `edit_aspect: "preset_or_auto"` (an edit sends the preset the crop was widened to, or the one
within 3 % of it, with `info.fit: "stretch"`; else "auto"), `tier_unit: "area"` (the tier by area with 15 % slack,
not the long side), `passthrough: { "black-forest-labs": ["safety_tolerance"] }` (the row goes as
`provider.options`, a whole number 0 to 4; only keys `openrouter.js` knows pass), `min_side` 256 / `max_pixels`
16,000,000 (a reference layer is scaled into them, the crop refused). Grounding cannot be set on OpenRouter. A model
whose endpoints take no seed reports none (null) since then, GPT Image's too.

*check balance* asks `GET /api/v1/key` with the key (15 s timeout). That answer describes the key's own
spending limit (`limit`, `limit_remaining`, `limit_reset`) and what the key has used, **not the account's
credits**, which only `GET /api/v1/credits` reports and which needs a management key (and "Management keys
cannot be used to make API calls to OpenRouter's completion endpoints"). So a key with a limit reads "$12.50
left (of this key's $20.00 limit, $7.50 used; the account's credits are on openrouter.ai/credits)", a key
without one "no spending limit on this key, $7.50 used in all; ...". A limit that resets daily, weekly or
monthly names its period and what was used in it (`usage_daily` / `_weekly` / `_monthly`, plus the BYOK
spending of the period when the key counts it, `include_byok_in_limit`): "of this key's $100.00 monthly limit,
$25.50 used this month", never the all-time `usage` beside it; a reset the adapter does not know gets no
"used" figure. Whether the call is free is not stated.

**The protocol.** One synchronous request per image; nothing is uploaded anywhere else and nothing is polled:

1. `POST /api/v1/images` with `Authorization: Bearer <key>` and the JSON body `{ model, prompt,
   input_references, resolution, aspect_ratio, quality, background, output_format, seed, n: 1, provider:
   { ignore } }`, of which only the fields the model takes go out (below). The pictures go inline as data
   URLs, `{ type: "image_url", image_url: { url: "data:image/png;base64,..." } }`, in this order: the crop,
   the mask (fill only), then the references (*Original* first, then the reference layers). An edit's
   prompt is `refs.instruction` numbered by this layout ("Reference pictures" above): it starts with what the
   first picture is ("Edit image 1 and keep its size and framing.", or the mask sentence below), then the
   user's text, then what the Original and the references are ("Image 3 is image 1 before the selected area
   was filled. Images 4 and 5 are reference images.", in the recipe's `refs.name`); a text run sends the
   prompt as it is and no `input_references`, unless it carries reference layers (26f): then `input_references`
   holds them alone and the prompt ends with their sentence ("Generating without an image" above). `promptFor(req, lay)` is exported for Oxen, which passes its own
   layout.
2. The answer is `{ created, data: [{ b64_json, media_type }], usage: { cost, ... } }`: the first `data`
   entry with `b64_json` is the image (PNG unless `media_type` says otherwise). The run's `info` (model,
   `resolution`, `aspect_ratio`, each picture and whether it went as PNG or JPEG, and `usage.cost` in USD)
   goes to the log. An `error` object inside an HTTP 200 fails the run like an error status.

Billing is **all or nothing** (the image guide, "Billing and Cancellation"): "When a generation does not
complete, the request returns a `502 Bad Gateway` rather than a partial result, and no charge is recorded."
Streaming exists for OpenAI's models only and is not used.

**Fill and edit.** The Image API has **no mask field**: neither the request schema nor any model's
`supported_parameters` lists one, and OpenAI's passthrough allowlist (`provider.options`) is `moderation`
alone. So the variants split three ways:

- **GPT Image 2 / 2.5 and Nano Banana** (`input: "fill"`): the mask (`req.mask`, white = repaint) goes along
  as the **second picture**, and the prompt begins "Edit image 1. Image 2 is a mask: change only the white
  area of the mask, keep everything else exactly as it is, and keep the image size and framing." ("Edit Image
  1. …" under GPT Image's `refs.name`, `Image {n}`), as the Gemini adapter does; the clause after the colon is
  the one that ran live here before step 26a2 renamed the pictures. Both families read several pictures and take instructions about
  them; whether they keep to the mask is not verified, and the stitch keeps only the selection either way.
  The mask is never re-encoded.
- **FLUX.2, Seedream 5 and Grok Imagine** (`input: "edit"`): an instruction edit of the crop plus the
  references, no mask, as on every other provider of these models; the stitch keeps the selection. For
  area-directed edits set Fill to green and Original on, and say "fill the green area": the Original's own
  sentence tells the model which picture is the one before the fill.
- **Krea 2 and Recraft V4** (`edit: false`): text to image, in Generate new only. Each lists one
  `input_references` slot, and neither page says whether that picture is edited or used as a style
  reference, so the variants offer no edit.

**Sizes.** No model lists `size`, so **no pixel size goes out** ("An absent key means the parameter is
unsupported by that endpoint", the image guide):

- `resolution`, where the model lists it (Nano Banana, Seedream, Grok, Krea): the *Resolution* row's value,
  or on **auto** (the rows' default) the smallest tier of `options.tiers` whose base (512, 1024, 2048,
  4096) covers the long side of the emitted crop, or of the asked size for a text run, else the largest.
  With Highres fix on *Maximum* the crop goes out at 2048 (these variants carry the conservative default
  limits), so auto picks 2K wherever the model has it, the 2K of the note at the top of this file; a lower
  Highres fix picks a lower tier. Nano Banana 2 Lite and Krea 2 have 1K only, which is always sent. A
  tier's pixel size is "derived per-provider" and stated for no model.
- `aspect_ratio`: **an edit sends none**, so the host keeps the crop's shape as its own edit endpoint does
  (not verified; `auto` is not in Gemini's or Krea's list, so leaving the field out is the one form every
  model takes). A **text run** sends the Generate-new aspect when it is one of the model's presets
  (`options.ratios`), else the closest preset.
- GPT Image and FLUX.2 list no `resolution`: the host picks the output size itself. OpenRouter's one
  example is a text request to GPT Image 2 at 16:9 and high quality: "`1536×864` PNG"; what an edit
  without an aspect comes back at is not stated.
- An answer of another shape than the crop is centre-cropped by `finishResult` (stretched when its aspect
  is within 0.01 of the crop's), as with WaveSpeed.

The crop goes out under the conservative default limits (2048, 16 px steps) except for FLUX (the recipe's
1440 / 32) and the three GPT variants, which set `{ max: 2048, step: 16, pixels: 0, minPixels: 0 }`: no area
budget and no floor, since OpenRouter takes no pixel size. Seedream's `limits.ratio: 16` widens a crop
thinner than 16:1, the input range ByteDance's ModelArk documents ("Aspect ratio (width / height): [1/16,
16]", its Image generation API page, 2026-09-10; OpenRouter's Seed host links BytePlus' terms, and nothing
says the range holds through OpenRouter), not ToAPIs' 3:1. The resolution rows default to *auto*, as on
ToAPIs, not to a fixed 2K.

**Options.** A variant's `options` describe the model:

- `accepts`: which of the parameters the model's endpoints list in `GET /api/v1/images/models`
  (`supported_parameters`, read 2026-09-19) the adapter may send; **nothing else is sent**, because the
  per-model guides say "an unlisted value is rejected, and a listed one can still be refused by whichever
  provider serves the call". So `seed` goes to FLUX.2, Seedream and Krea only, `n: 1` to every model but
  Krea (which lists no `n`), `output_format` to FLUX.2 only (fixed `png`), `quality` to GPT and Grok,
  `background` to GPT Image 2.5 only; `output_compression`, which the OpenAI models list, is in no
  variant's `accepts`, and neither is GPT Image 2's `background` (only `auto` / `opaque`);
- `ratios`: the model's `aspect_ratio` presets without `auto` (text runs only);
- `tiers`: `{ "1K": 1024, ... }`, the model's `resolution` values with the long side each stands for;
- `max_images`: the model's `input_references` maximum, or the host's own documented limit where it is lower
  (Seedream 5.0 pro: 10, which ModelArk documents, against OpenRouter's 14), 16 when unset; a run with more
  pictures (crop, mask picture, *Original* and reference layers together) is refused **before any request**,
  in the app by the central check ("Reference pictures" above), in a direct call by the adapter's own, with the
  count and "turn Original off or hide reference layers";
- `max_ratio`: the steepest picture the model takes (Seedream: 16, ModelArk's documented range); a steeper
  crop or reference is refused before any request;
- `only_for`: `{ <resolution>: [host slugs] }`, a tier only some of the model's hosts serve, sent with
  `provider.only` set to them. Nano Banana Pro's 4K: of its two endpoints only Google AI Studio lists 4K
  (Vertex AI stops at 2K), so a 4K run, picked in the row or chosen by *auto* for a 4096 Generate new, goes
  to AI Studio alone (which keeps prompts 55 days). A base slug matches every endpoint of that host ("it
  matches **all** endpoints for that provider, including any variants or regions", the provider-selection
  page).

Settings rows pass through by key when `accepts` names the key (`resolution`, `aspect_ratio`, `quality`,
`background`, `output_format`, `output_compression`); `auto`, empty values and `random_seed` are not sent,
and `fixed` passes the same way. `background: "transparent"` with a JPEG `output_format` goes as PNG; no
variant sends both today.

**The 18 MB inline budget.** OpenRouter states no body limit: `POST /images` "now returns `413`" (changelog,
2026-07-07) without a number, and probes without a key on 2026-09-19 got 4, 12 and 30 MB bodies through to
the key check. The adapter holds the base64 of one request's pictures to **18,000,000 bytes**, under the
tightest upstream limit it knows of (Gemini: 20 MB for a request with inline images). Over it, the opaque
pictures (the crop and references without a transparent pixel, `ctx.opaque`) are re-encoded as JPEG at
quality 92 (`ctx.toJpeg`, Electron's `nativeImage`), largest first, until the total fits; a JPEG that comes
out larger is not used, and neither the mask nor a picture with transparency is ever re-encoded. Still over
it, the run is refused before any request with "Set Highres fix lower, turn Original off, or use fewer or
smaller reference layers". For scale (the ToAPIs measurements above): a 2048² PNG crop of a photograph is
5.9 to 9.5 MB, 7.9 to 12.7 MB as base64, so a crop with its *Original* copy can pass 18 MB on its own.

**Errors** are read in both shapes OpenRouter answers with: the documented `{ error: { code, message,
metadata } }` and the schema check's `{ success: false, error: { name: "ZodError", message: "<JSON list of
issues>" } }` (seen on 2026-09-19 for a bad body without a key; the issues are joined as `path: message`).
Plain words go in front of the server's message: 400 "request refused", 401 "key refused", 402 "credits too
low, top up at openrouter.ai/credits" (with `metadata.limit_source: "openrouter_key_limit"`: "this key's
spending limit is reached (raise it at openrouter.ai/settings/keys, or wait for it to reset)"; with
`"openrouter_in_flight_budget"`, which the limits page says is "not your balance": "recent paid requests are
still settling on this account; wait a moment and try again (more credits raise this budget)"), 403 "refused
(the content policy, a guardrail or the key's permissions)", the errors page's three causes of a 403, and
"refused by the content policy" with the moderation `reasons` when there are any or when `error_type` is
`content_policy_violation` or `refusal`, 404 "no host serves this model with these settings", 408 and 524
"timed out", 413 "request too large (set Highres fix lower or use fewer reference layers)", 429 "rate
limited", 502 "the model's host failed; nothing was charged", 503 "no host is available right now, or none
meets the routing rules (Scumble leaves out hosts in China)" (the errors page uses 503 both for "no available
model provider that meets your routing requirements" and, typed `provider_overloaded`, for "The upstream
provider is temporarily overloaded"; the latter reads "the model's hosts are overloaded; try again
shortly"), 529 "the host is overloaded". The key is taken out of every message; the error reaches the status
line and the log (`source: "openrouter"`).

**Sent once more**, one retry and **never before the time the server set** (the errors page: "honor it
before retrying"): a **429**, a **529**, a **503 with `Retry-After`** (an overloaded host), and a **402**
whose `metadata.limit_source` is `openrouter_in_flight_budget` and that carries a `Retry-After` (the errors
page: "A 402 … without the header is not a wait-and-retry case"). The wait is the header's, 5 s for a 429 or
529 without one; a header over **60 s** (the errors page's own example is 60) is not waited for: the run fails
at once and its message ends "try again in N s". There is no third request: a second refusal that names a
wait (any wait) ends the run with the same "try again in N s". The in-flight 402 is refused "before it reaches a provider"
(the limits page), so nothing was generated or charged; the adapter reads a 429, a 529 and an overloaded 503
the same way, which OpenRouter does not state. Nothing else is retried, and **never a network error**: an
answer lost on the way may be a paid image, and a second request a second one.

**The host** is `https://openrouter.ai` unless `settings.openrouter.base` is `https://openrouter.ai` or
`http://127.0.0.1:<port>` (the test mock); anything else is ignored: a path (`/api/v1` included), a query,
user info, `http://openrouter.ai`, `localhost`, and the regional `eu.` / `us.openrouter.ai`, whose in-region
routing "is only enabled for enterprise customers by request". It never comes from a recipe, and there is no
UI for it. **The key rule** on top: a key that starts with `test-` goes only to the loopback mock, and any
other key never goes there; both mismatches are refused before any request, for the image runs, *check
balance* and the upsampling rows alike. So a real key cannot reach a local listener a setting points at, and
a test key never reaches openrouter.ai.

**Privacy.**

- **What leaves the machine:** the crop, the mask (fill), the references and the prompt, inline in the
  request to `openrouter.ai`, which passes them to a host that serves the model (the table below). Nothing
  goes to a file host, and the result comes back in the answer.
- **No attribution headers:** no `HTTP-Referer`, `X-Title`, `X-OpenRouter-Title`, `X-OpenRouter-Categories`
  or `X-OpenRouter-App-Visibility` goes out. OpenRouter's app-attribution page: `HTTP-Referer` "is required
  for app attribution. Without it, no app page will be created"; with it, and without
  `X-OpenRouter-App-Visibility: hidden`, the app page is public. Scumble's name must not appear in public
  before the trademark check (CLAUDE.md), so none is sent.
- **The hosts in China:** every image request (and every upsampling request) carries `provider.ignore`
  with the hosts OpenRouter lists with their headquarters or a datacentre in China (`GET /api/v1/providers`,
  public, no key, countries as "ISO 3166-1 Alpha-2 country codes"). The list is read once per session, at the
  first image run or upsampling on OpenRouter (10 s timeout), and merged with the list of 2026-09-19: `alibaba`, `baidu`,
  `deepseek`, `nex-agi`, `streamlake`, `tencent`, `xiaomi`. When the read fails, the dated list alone goes
  out, the log says so, and the next request asks again. OpenRouter merges `ignore` with the account's own
  ignored providers. Of the image hosts only `alibaba` is on the list.
- **No `data_collection` or `zdr` on images:** the Image API's `provider` object has only `allow_fallbacks`,
  `ignore`, `only`, `options`, `order` and `sort` (the request schema; the image guide names the same
  routing fields). The chat route's `data_collection` and `zdr` are not in it, whether `/images` would honour
  them is not stated, and the first validation stage accepts unknown keys, so a probe without a key cannot
  tell. Neither is sent. An account-wide ZDR setting at openrouter.ai "only applies to provider routing for
  inference requests"; whether that covers `/images` is not stated either.
- **OpenRouter itself:** "OpenRouter does not store your prompts or responses, *unless* you opt in"
  (Input & Output Logging, off by default, whose data "is retained for a minimum of 3 months" once it is
  on; the Data Collection page and the logging page), and "OpenRouter itself has a ZDR
  policy; your prompts are not retained unless you specifically opt in to prompt logging" (the ZDR page).
  Its privacy policy (last updated 2026-08-31; read through a fetch tool, not as raw text): "We do not
  persist image, audio or video files beyond the duration necessary to route the request, except as
  required for abuse detection, security, billing, or legal compliance." How long a generated image is kept
  is not stated.
- **The hosts** as of 2026-09-19: which host serves a model from `GET /api/v1/images/models/<id>/endpoints`,
  headquarters and datacentres from `GET /api/v1/providers`, and training and retention from
  `GET /api/frontend/v1/all-providers`, an **undocumented** list (the Provider Logging page renders its
  table from it) that can change without notice. Every host below has `training: false` there.

| Host (slug) | Serves here | Headquarters / datacentres | Keeps prompts |
|---|---|---|---|
| OpenAI (`openai`) | GPT Image 2, 2.5 Flare, 2.5 Sunburst | US / none listed | yes, for a period not given |
| Google AI Studio (`google-ai-studio`) | Nano Banana 2, 2 Lite, Pro | US / none listed | 55 days |
| Google Vertex (`google-vertex`) | the same three (Pro up to 2K) | US / none listed | no (on `GET /api/v1/endpoints/zdr`) |
| Black Forest Labs (`black-forest-labs`) | FLUX.2 max, pro, flex | not listed | 30 days |
| Seed (`seed`, ByteDance) | Seedream 5 lite, pro | SG / none listed | no (on `/endpoints/zdr`) |
| xAI (`xai`, listed as "SpaceXAI") | Grok Imagine 2.0 | US / none listed | 30 days |
| Krea (`krea`) | Krea 2 large | US / none listed | no (on `/endpoints/zdr`) |
| Recraft (`recraft`) | Recraft V4 | not listed | yes, for a period not given |
| Alibaba Cloud Int. (`alibaba`) | Qwen Image 3 and 3 Pro, **not offered** | SG / SG, **CN** | yes, for a period not given |

Where a model has two hosts (the Nano Banana models: AI Studio, which keeps prompts 55 days, and Vertex AI,
which keeps none), OpenRouter picks one per request and Scumble pins neither, except Nano Banana Pro's 4K,
which only AI Studio lists and which goes there alone (`only_for`, above). **Qwen Image 3 is left out:** its only host on OpenRouter is Alibaba Cloud International,
which lists a datacentre in China, so the ignore list would leave it no host; `qwen_image_edit` has no
OpenRouter variant.

**The recipes** (model ids and parameters from `GET /api/v1/images/models`, 2026-09-19; "pictures" counts the
crop, the mask, *Original* and the reference layers together):

| Recipe | OpenRouter model | Input | Settings rows | `resolution` tiers | Pictures | Generate new |
|---|---|---|---|---|---|---|
| `gpt_image_2` | `openai/gpt-image-2` | fill (mask as 2nd picture) | Quality (auto, low, medium, high) | none: the host picks the size | 16 | 1536 |
| `gpt_image_2_5_flare`, `_sunburst` | `openai/gpt-image-2.5-flare`, `-sunburst` | fill | Quality (auto to max), Background (auto, opaque, transparent) | none | 16 | 1536 |
| `nano_banana_2` | `google/gemini-3.1-flash-image` | fill | Resolution | 512, 1K, 2K, 4K | 14 | 1024, 2048, 4096 |
| `nano_banana_2_lite` | `google/gemini-3.1-flash-lite-image` | fill | none | 1K, always sent | 14 | 1024 |
| `nano_banana_2_1` | `google/gemini-nano-banana-2.1` (`/api/v1/models`, 2026-10-07) | fill | Resolution (no Thinking: how OpenRouter's `reasoning` maps to it is not documented) | 1K, 2K, 4K | 14 | 1024, 2048, 4096 |
| `nano_banana_pro` | `google/gemini-3-pro-image` | fill | Resolution | 1K, 2K, 4K (4K on AI Studio only) | 14 | 1024, 2048, 4096 |
| `flux2_max`, `flux2_pro`, `flux2_flex` | `black-forest-labs/flux.2-max`, `-pro`, `-flex` | edit, `seed`, fixed `output_format: png` | none | none | 8 | 1024 |
| `seedream_5_lite` | `bytedance-seed/seedream-5-0-lite` | edit, `seed` | Resolution | 2K, 4K | 14, none steeper than 16:1 | 2048, 4096 |
| `seedream_5_pro` | `bytedance-seed/seedream-5-0-pro` | edit, `seed` | Resolution | 1K, 2K | 10 (OpenRouter lists 14), none steeper than 16:1 | 1024, 2048 |
| `grok_imagine` | `x-ai/grok-imagine-image-2.0` | edit | Resolution, Quality (low, medium) | 1K, 2K | 3 | 1024, 2048 |
| `krea_2` | `krea/krea-2-large` | text only (`edit: false`), `seed` | none | 1K, always sent | none | 1024 |
| `recraft_v4` | `recraft/recraft-v4` | text only (`edit: false`) | none | none | none | 1024 |

"Generate new" is the variant's `text.sizes` (the long sides the dialog offers). Every model's
`aspect_ratio` presets are in its variant's `options.ratios`. `recraft/recraft-v4-pro` is the pro tier of the
same model, not wired; nor are `recraft/recraft-v4.1` and `-v4.1-pro`, which the same list carried.

**Only a real key can verify** (written defensively, and listed here until a live run):

- per model, whether a picture in `input_references` is edited or only referenced (the docs call them
  "reference images" for "image-to-image"; OpenRouter's GPT Image 2 guide has an "Edit Image" example), and
  whether GPT Image and Nano Banana keep to the mask picture;
- whether an edit without `aspect_ratio` keeps the crop's shape on every model;
- the output size per tier and model ("derived per-provider"), and what GPT Image and FLUX.2 answer without
  a tier;
- the body limit behind the 413, and the timeouts: OpenRouter states none, and the request has no timeout of
  its own, so a generation that has not sent its answer's headers within Node's (undici's) default 300 s fails
  as a network error and is not sent again (OpenRouter's one data point: GPT Image 2, "Generation time:
  94s");
- whether a parameter a model does not list is rejected with a 400 or dropped (the adapter sends none, so
  this matters for a hand-edited variant only);
- where `error_type` appears on `/images` errors (documented for chat, messages and responses only), and
  whether the moderation `reasons` and `limit_source` arrive there as documented for chat;
- Krea 2's price (its endpoint's `pricing` list was empty on 2026-09-19);
- that `provider.ignore` is honoured on `/images` (the image guide lists it; nothing without a key can show
  it), and that the host list keeps the shape the adapter reads;
- whether a transparent GPT Image 2.5 answer keeps its alpha without an `output_format` ("If omitted, the
  provider's default applies");
- whether a JPEG data URL is taken by every model (the chat image guide lists PNG, JPEG, WebP and GIF; the
  Image API states no formats);
- whether `GET /api/v1/key` is free;
- whether a 4K run of Nano Banana Pro with `provider.only: ["google-ai-studio"]` reaches AI Studio (the base
  slug of its `google-ai-studio/global` endpoint), and what a 4K request would do on Vertex without it;
- whether Seed takes 11 to 14 pictures for Seedream 5.0 pro through OpenRouter (it lists 14, ModelArk
  documents 10), and whether ModelArk's [1/16, 16] input range is the one that holds there;
- whether the Retry-After values OpenRouter really sends stay under 60 s.

**Tests.** `tools/openrouter_mock.py` is the loopback stand-in (the pattern of `toapis_mock.py`): `GET
/api/v1/providers` with four made-up hosts (one with its headquarters in CN, one with a datacentre there),
`POST /api/v1/images` (401 without a Bearer key; an edit echoes its first picture with that picture's media
type, a text request gets a PNG of its `aspect_ratio` at its tier's long side, `usage.cost` 0.04; the model
`mock-402` answers the documented "Insufficient credits" 402, `mock-429` a 429 with `Retry-After: 1` once
and then an image, `mock-502` a 502), `GET /api/v1/key` (a $20 limit with $12.50 left and $7.50 used, or no
limit) and `POST /api/v1/chat/completions` for the four upsampling ids (`llm_mock.py`'s answer, 404 for any
other model). It records every header of every request, so a test can check that no attribution header went
out on any call, and keeps the decoded pictures of each image request.

`node tools/openrouter_test.js` runs the adapter and the OpenRouter rows of `llm.js` in plain Node, without
Electron and without a key, against a scripted fetch that plays openrouter.ai; `ctx.sleep` records its waits
instead of waiting. Twelve sections, the first eleven: an edit (one `POST /api/v1/images` whose headers are `Authorization`
and `Content-Type` and nothing else, the crop and then the references as data URLs, the prompt's sentences,
no `aspect_ratio`, the tier rule and a *Resolution* row winning over it, `seed` and `n` only where `accepts`
has them, `provider` as `ignore` alone, the answer's bytes, `media_type` and `usage.cost`); a fill (the
luminance mask, not the alpha one, as the second picture, the mask sentence, no mask field; an edit never
sends the mask); text runs (without references the body pinned key for key; with two, the references alone in
`input_references` with their sentence, then one reference, the cap, the ratio and size refusals; the asked or the
closest preset, the tier of the asked size, an empty prompt refused); the parameter filter (`size`, `moderation`, `channel`,
`style` and `random_seed` never sent, `auto` and empty values left out, a transparent JPEG sent as PNG,
FLUX's fixed `png`); the guards before any call (`max_images` with the counts in the message, `max_ratio` on
the crop and on a reference, the 18 MB budget with the JPEG fallback largest first, never the mask or a
picture with transparency, and a refusal when it still does not fit); every error word, both error shapes
and the key taken out of the messages, the retries (a 429, a 529 and an overloaded 503 once more, the
in-flight 402 only with `Retry-After`, never before the header's time and not at all past 60 s, with "try
again in N s"; a plain 402, a 502 and a network error sent once) and an error object inside a 200; the host list (read once per session and base, without the key, the dated list when it fails, asked
again after a failure); *check balance* with and without a limit, with a monthly and a daily limit (the
period's use, BYOK counted when the key includes it) and with a reset it does not know; the base allowlist and the key rule on
edit, generate and balance; every shipped recipe normalised by `recipes.js` (fifteen with an `openrouter`
variant, none with a Qwen model, `openrouter` last, the `default` kept, ToAPIs first where present, the
settings rows within `accepts`, the notes and descriptions, each building an edit and a text request of
accepted keys only); the four upsampling rows (after every other row, no `reasoning` in `llm.list()`, the
body with the reasoning switch and `provider: { data_collection: "deny", ignore }`, the strict retry rule,
the errors inside a 200, the key rule). The last check: no call of the whole run carried `HTTP-Referer`,
`Referer`, `X-Title` or an `X-OpenRouter-*` header. A twelfth section sends an error that echoes the key
from every upsampling provider (OpenAI, Gemini, Anthropic, ToAPIs with a failed status and inside a 200, the
local endpoint) through `llm.ask()` and finds the key taken out, and a local server's placeholder key
("ollama") left in its own words. A mutation round on 2026-09-19 on the final code (95 mutations of
`openrouter.js`, `llm.js`, `recipes.js` and the recipe variants, one at a time on a copy of the tree, with
`toapis_test.js` run too since it shares `askCompatible`) turned a test red for every one of them, among them
an attribution header on either path, every 402, a 502 or a network error retried, a `Retry-After` cut
short, clamped or read wrongly as an HTTP date, a third request after a second refusal, an `aspect_ratio` on
an edit, the mask sent on an edit or converted to JPEG, an async encoder not awaited, the budget counted in raw
bytes, the host list read with the key, without a timeout or not read again after a failure, a CN datacentre
not counted, `localhost` or a path allowed as the base, a test key sent to openrouter.ai, the error words of
the in-flight and key-limit 402, a 403 and an overloaded 503 lost, the chat path without the error metadata,
the key left in any provider's upsampling error, a refusal or an error inside a 200 taken as the prompt, the
balance counting the all-time use for a limit that resets, `only_for` ignored or applied to every tier,
Seedream's limits back at ToAPIs' 3:1 and 14 pictures, and `openrouter` missing from `TEXT_PROVIDERS`.

Gate `openrouter` (`tools/openrouter_test.py`; start the instance with `--offline`, since a result lands in
the mirror and would be forwarded to a connected ComfyUI) runs that first, then drives the app over CDP with
`settings.openrouter.base` on the mock and a `test-` key, refusing a profile that already holds an OpenRouter
key: the lists before the key (ToAPIs first in Settings › API providers, the OpenRouter row with *get a key*
and no *check balance*, OpenRouter last and reading "OpenRouter (no key)" in every served recipe's select,
the defaults kept, no OpenRouter upsampling row); *check balance* with a limit and without one; an inpaint
on the shipped Nano Banana 2 variant (one request, the crop at the emitted size first, the mask second and
white in the selection, the tier the adapter's rule gives, no `aspect_ratio`, no seed, `provider` with
`ignore` alone, holding the dated list and the mock's two hosts in China and not its other two); an edit on
FLUX.2 [pro] (one picture fewer than the fill, `output_format: png`, a seed); Generate new at 16:9 (no
picture, `1K`, a 1024 × 576 base); an upsampling on the Gemini row (the image, the reasoning switch, the
routing object); a 402 in the status line and in the log without the key, sent once; a 429 sent again after
its `Retry-After`; a 502 that says nothing was charged; a real-looking key refused at the test address on
Generate, *check balance* and upsampling with nothing reaching the mock; and no attribution header on any
request of the whole gate. The clean-up clears the key and puts `settings.openrouter`, the remembered
providers and the selected recipe back.

### BytePlus ModelArk (`ark`)

BytePlus ModelArk is ByteDance's own API for its Seed models, Seedream among them. Scumble uses its Image
generation API for two recipes, Seedream 5.0 pro and Seedream 5.0 lite. The adapter
`electron/main/providers/ark.js` is written from the English pages under `docs.byteplus.com/en/docs/ModelArk/`,
all read on 2026-09-19: the Image generation API reference (`1541523`, updated 2026-09-10), the error codes
(`1299023`), the model list (`1330310`), region availability (`2191806`), pricing (`1544106`), the data processing
page, the content filter overview and the country availability page. The pages are rendered by script; their text
was read from the Markdown the served HTML carries. The adapter **has not run against the live API**, and both
ModelArk variants' notes say so. Four probes without a valid key (both hosts, once without a key and once with an
invalid one) showed the error shape.

**Where it shows up.**

- **The key row.** "BytePlus ModelArk (Seedream)" comes after OpenRouter in Settings › API providers
  (`PROVIDERS` in `providers/index.js`, before Anthropic's key-only row). Its hint is "API key from the ModelArk
  console (it belongs to the region it was made in)". Its *get a key* link opens
  `ai.byteplus.com/ark/region:ap-southeast-1/apiKey`, the Johor console, with no referral code. There is no
  *check balance*, because the docs name no balance call.
- **The recipes.** In `seedream_5_pro` and `seedream_5_lite`, `ark` comes **right after `toapis`** in
  `providers`. It is therefore second in their provider select, in Generate new and in `list_recipes`, and
  OpenRouter stays last. **The `default` stays fal**, although ModelArk is the model's own API. Nothing switches
  to ModelArk on its own. A recipe runs there when you pick it in the recipe's select, in Generate new or with
  `select_recipe(id, "ark")`. The two recipes' descriptions say "Also on BytePlus ModelArk (ByteDance's own API)."
- **Generate new.** `ark` is in `TEXT_PROVIDERS`. A text run uses the edit variant's model id and sends no
  `image`, unless it carries reference layers (26f): then `image` holds them alone, the prompt ends with their
  sentence, and the text `size` stays.
- **Not wired:** Seedream 4.5 (`seedream-4-5-251128`) and 4.0 (`seedream-4-0-250828`). ModelArk serves both,
  but Scumble has no recipe for either.

A model has to be **activated** in the ModelArk console before its first run. The reference says: "Activate the
model on the Model activation page, and then find its Model ID". A model that is not activated gets 404
`ModelNotOpen`.

**The protocol.** One synchronous request per image. Nothing is uploaded anywhere else and nothing is polled.

1. `POST <host>/api/v3/images/generations`. The headers are `Authorization: Bearer <key>` and `Content-Type:
   application/json`; the reference names one method: "This API only supports API Key authentication". The body is
   `{ model, prompt, image, size, watermark: false, response_format: "b64_json", output_format: "png" }`:
   - `model`: the variant's id. Pro is `dola-seedream-5-0-pro-260628`. Lite is `seedream-5-0-260128`, the model
     list's id, which "also supports" `seedream-5-0-lite-260128`, the id on the pricing page.
   - `prompt`: an edit's prompt is `refs.instruction` ("Reference pictures" above), in Seedream's `refs.name`
     `Image {n}`: "Edit Image 1 and keep its size and framing.", the user's text, then with the Original and one
     reference "Image 2 is Image 1 before the selected area was filled. Image 3 is a reference image." A text run
     sends the prompt as it is (with reference layers, 26f, followed by their sentence), and an empty one is refused
     before any request. The reference recommends "no more
     than 300 Chinese characters or 600 English words"; that is advice, and Scumble does not cut. No negative
     prompt goes out, because the API has none.
   - `image`: the pictures as data URLs, `data:image/png;base64,...` (the reference: "`<image format>` must be in
     lowercase"). The crop comes first, then *Original* and the reference layers. A text run sends none, or its reference layers
     alone (26f).
   - `size`: always pixels, `"WxH"` (see "Sizes" below).
   - `watermark: false`, because the default is `true`: "Adds an "AI-generated" watermark to the lower-right
     corner of the image".
   - `response_format: "b64_json"`, because the default `url` returns "a download URL for the image. The URL is
     valid for 24 hours after the image is generated". With base64 the image comes back in the answer, and no
     second host is involved.
   - `output_format: "png"`, sent where the variant's `options.png` is set (both variants). The default is
     `jpeg`. The reference names 5.0 pro and 5.0 lite as the models that take the field. For 4.5 and 4.0 the
     tutorial says the format "defaults to `jpeg` and does not support custom settings".

   **Not sent:**
   - `seed`: the reference does not name it. The SDK's generated request type has it, which proves nothing for
     Seedream.
   - `n`: there is no such field.
   - `sequential_image_generation`, `stream`, `optimize_prompt_options` and `layer_decomposition`.
   - 5.0 pro's `background` (see "Transparent results" above).
2. The answer is `{ model, created, data: [{ b64_json, size }], usage: { generated_images, output_tokens, ... } }`.
   - The image is the first `data` entry with `b64_json`. If the service ignored `response_format` and sent a
     `url`, that URL is downloaded at once, without the key.
   - Whether the image is PNG or JPEG is read from its first bytes, because only 5.0 pro answers
     `data[].output_format`.
   - The run's `info` goes to the log: the model, the region, the size sent, the size answered (`data[].size`),
     each picture with PNG or JPEG, and `usage.generated_images`.
   - These fail the run like an error status: an `error` object inside an HTTP 200, and a `data` entry that
     carries only an `error`.

Billing: "Billing is based only on successfully generated images" (the reference, `usage.generated_images`).
The pricing page adds: "Images that are not successfully output due to reasons such as content moderation are
not billed."

**Fill and edit.** The reference has **no mask field**, so both variants are `input: "edit"`: an instruction
edit of the crop plus the references, as on every other provider of Seedream. The stitch keeps the selection. The
image generation tutorial (`1824121`) describes the case as "Image-to-image (single-image input, single-image
output). Edit an existing image using text instructions ...". For area-directed edits set Fill to green and
Original on, and say "fill the green area". Which picture of the `image` array the model reads as "Image 1" is
not stated.

Seedream 5.0 pro's interactive editing guide (`2582775`) takes an edit area as coordinates in the prompt:
`<bbox>x1 y1 x2 y2</bbox>`, normalised to [0, 999]. Scumble does not send one. It is an idea whose effect is not
verified.

**Sizes.** The reference offers two ways to give `size`, "but they cannot be used at the same time":

- a tier (pro `1K`, `1.5K`, `2K`; lite `2K`, `3K`, `4K`) with the shape described in the prompt: "The model
  determines the final image size";
- pixels, `widthxheight`, inside a total-pixel range and an aspect range.

With a tier the model picks the shape from the prompt, and the reference does not say whether an edit with a tier
follows the input picture's shape. So **Scumble always sends pixels**:

| Model | "Total pixels range" (method 2) | Aspect range |
|---|---|---|
| 5.0 pro | [`1280x720` (921,600), `2048x2048x1.1025` (4,624,220)] | [1/16, 16] |
| 5.0 lite | [`2560x1440` (3,686,400), `4096x4096` (16,777,216)] | [1/16, 16] |

"The total pixel limit applies to the product of the single image's width and height, rather than to either
dimension individually." The reference states no step and no edge limit. The adapter's own choice is **16 px
steps**, with the ratio held at 16:1 (`fitPixels` in `util.js`, with a 16,384 px edge, which is 16:1 at lite's
ceiling). The variant's `options.pixels` carries the range.

- **An edit** asks for the emitted crop's own shape at a size inside the range. The app emits the crop inside
  the range already (see "The crop's `limits`" below), so the size sent is the crop's own. Given a smaller crop,
  the adapter would ask for it larger: 512 × 512 at 960 × 960 on pro and at 1920 × 1920 on lite. A size off the
  16 px steps is rounded to them, which can move the shape by a pixel or so. `finishResult` scales the answer back
  to the region either way.
- **A text run** (Generate new) sends **exactly the dialog's aspect**, at the size on 16 px steps whose long side
  is nearest the dialog's and whose area lies in the range: pro at 1280 and 16:9 is 1280 × 720, 3:2 is 1296 × 864
  (not the dialog's rounded 1280 × 848), 21:9 is 1568 × 672 (grown to the 0.92 MP floor); lite at 2560 and 16:9 is
  2560 × 1440. Only a free size, or an aspect with no such size in the range, is fitted the way an edit is.

These numbers come from running the adapter's `sizeFor`, not from a live answer.

**The crop's `limits`.** The variants hold the crop the app emits to the same rules: `{ max, step: 16, pixels,
minPixels, ratio: 16 }`, with the model's range as `pixels` and `minPixels`; `max` is 4096 on pro and **7680 on
lite**, the side a 16:1 crop needs to reach lite's 3.7 MP floor (sqrt(16 × 3,686,400); ByteDance states no side
limit, and the 16.8 MP cap still holds a square crop to 4096 × 4096). With a 4096 edge, a lite crop steeper than
about 4.55:1 went out under the floor and was asked for at another size and a slightly different shape, which
`finishResult` then centre-cropped. So with Highres fix on *Maximum* a pro crop goes out at up to 4.6 MP, which
is the dearer price (see "Prices" below), and a lite crop at up to 16.8 MP (a 2:1 crop at 5792 × 2896, a 5:1 one
at 7680 × 1536); a lite crop that large can pass 30 MB and then goes as JPEG. Every Highres fix setting pushes a
smaller crop up to the floor (0.92 MP on pro, 3.7 MP on lite). `ratio: 16` widens a crop thinner than 16:1 with more context, as on OpenRouter. The
Generate-new sizes (`text.sizes`) are 1280, 1536 and 2048 for pro and 2560, 3072 and 4096 for lite, all inside
each range.

**The Region row.** "Platform-level resources, such as API keys and model activation status, are isolated by
region" (`2191806`). ModelArk has two regions: Johor, Malaysia (`ap-southeast-1`) and Dublin, Ireland
(`eu-west-1`). The variant's `options.regions` lists the regions the model may run in, the first being the
default. A *Region* row in the editor's Settings panel (key `region`, values `ap-southeast` / `eu-west`) picks
one:

- **5.0 lite** has the row, defaulting to `ap-southeast`; `eu-west` goes to Dublin. The docs disagree on whether
  Dublin serves this model. The model list says "The seed-2-0 and seedream-5-0-lite models are also supported in
  the `eu-west-1` region". The region page (updated 2026-09-10) says "The EU region currently supports the
  following models: `seed-2-0-lite`", while it lists the Image generation API among the "APIs supported in the EU
  region".
- **5.0 pro** has no row and runs in Johor only. The model list says all its models are supported in
  `ap-southeast-1`, and neither page lists pro for Dublin.

The region is not stored with the key. A key made in Dublin needs *Region* on `eu-west` for lite, and it cannot
run pro. Either host may also hand a request to the other region: "some requests may be routed to inference
resources in other regions". The region page's table says "Inference prefers EU, but may spill over to AP if
needed", and the same the other way round.

**Pictures.** Every picture is checked against the reference's input rules **before any request** (its shape and
area from its PNG header):

- **Count.** "Seedream 5.0 pro supports up to 10 reference images. Seedream 5.0 lite, 4.5, and 4.0 support up to
  14 reference images." `options.max_images` is 10 for pro and 14 for lite. The crop, *Original* and the reference
  layers count together. A run with more is refused with the count and "turn Original off or hide reference
  layers".
- **Shape.** "Aspect ratio (width / height): [1/16, 16]" and "Width and height (px): > 14". A picture steeper than
  16:1, or 14 px or less on a side, is refused. A thin crop is widened by `limits.ratio` first, so this catches
  reference layers, or a document that is itself steeper than 16:1.
- **Area.** "Total pixels: [196, `6000×6000` (36,000,000)]". A picture over 36 MP is refused.
- **Bytes.** The reference says "Size: Up to 30 MB". The adapter reads that as **30,000,000 bytes** (the smaller
  reading) of the PNG itself, not of its base64.
  - A picture over it with no transparent pixel (`ctx.opaque`) goes as JPEG at quality 92 (`ctx.toJpeg`,
    Electron's `nativeImage`, `data:image/jpeg;base64,...`).
  - A picture with transparency, or one still over 30 MB as JPEG, is refused with "Set Highres fix lower or use a
    smaller reference layer".
  - For scale, the ToAPIs measurements above found 3840 × 2160 PNG crops of photographs at 11.9 to 18.7 MB. A lite
    crop at 4096 × 4096 has twice those pixels, so it can pass 30 MB and then goes as JPEG.

The formats the reference lists are "jpeg, png, webp, bmp, tiff, gif, heic, or heif"; Scumble sends PNG, and JPEG
for the fallback. The reference states no limit for the whole request body. Fourteen pictures of up to 30 MB
would come to about 560 MB of base64.

**Errors.** A failed answer is `{ error: { code, message, param, type } }`, as the reference documents. The same
shape came back from both hosts on 2026-09-19 for a request without a key:

```
401 {"error":{"code":"AuthenticationError","message":"the API key or AK/SK in the request is missing or invalid. request id: ...","param":"","type":"Unauthorized"}}
```

An invalid key got "The API key format is incorrect" instead. The adapter puts plain words in front of `code:
message`. It chooses them by the code of the error-code page (`1299023`) first and by the status second:

| Code (status on the error-code page) | Words |
|---|---|
| `InvalidAccountStatus` (401) | the BytePlus account's status blocks the call: see the ModelArk console or BytePlus support |
| `AuthenticationError` (401), or a 401 without a code | on lite (a *Region* row): key refused by the Johor / Dublin host (a key works only in the region it was made in: check the Region row); on pro: key refused (this model runs in Johor only, and a key works only in the region it was made in) |
| any other 401 | refused |
| `AccountOverdueError` (403) | the BytePlus account is overdue: top it up in the console |
| `OperationDenied.ServiceNotOpen` (403) | ModelArk is not activated on this account |
| `ModelNotOpen` (404) | the model is not activated: activate it under Model activation in the ModelArk console |
| `InvalidEndpointOrModel.ModelIDAccessDisabled` (404) | this account must call the model through an endpoint id, which Scumble does not support yet |
| any other `InvalidEndpointOrModel...` (404) | no such model in this region |
| `InputImageSensitiveContentDetected.PrivacyInformation` (400) | refused: the picture may show a real person |
| any other `...SensitiveContentDetected...` (400) | refused by the content filter |
| `ModelAccountIpmRateLimitExceeded` (429) | rate limited (images per minute) |
| `SetLimitExceeded` (429) | paused by the account's Safe Experience Mode limit (the console's model settings) |
| `QuotaExceeded` (429) | a quota is used up, or too many tasks are queued (the free quota, a period's quota or the queue: the server's words say which) |
| `ServerOverloaded` (429) | the service is overloaded |
| `InvalidImageURL...` (400) | a picture was not accepted |
| `InvalidParameter`, `MissingParameter`, any other 400 | request refused |
| any other 404 / 429 / 5xx | not found / rate limited / the service failed |

The error-code page gives `QuotaExceeded` three meanings: a used-up free trial, "The number of tasks in the queued
state for the current account has exceeded the limit", and a 5-hour, weekly or monthly quota. The words name all
three, and the server's own message after them says which it was.

A message reads `ModelArk <model>: <words> - <code>: <message>`, and ends with "; try again in N s" when a wait is
known. The key is taken out of every message. The error reaches the status line and the log (`source: "ark"`).

**Sent once more.** One retry, and **never before the time the server set**. It applies to a 429, 500 or 503
whose code is one of two:

- `ModelAccountIpmRateLimitExceeded`: "IPM (Images Per Minute) limit of the model is exceeded". The model list
  gives 500 images a minute for each Seedream model, and calls its limits "theoretical maximum values which are
  not guaranteed".
- `ServerOverloaded`: "Please retry later".

The adapter's reasoning: nothing was generated then, and only generated images are billed. The docs do not say
in so many words that such a refusal generated nothing.

- **The wait** is the `Retry-After` header's, in seconds or as an HTTP date, and 5 s without one.
- **A wait over 60 s** is not taken: the run fails at once and its message ends "try again in N s".
- **A second refusal** that carries a `Retry-After` ends the run with the same "try again in N s". There is no
  third request.
- **Never retried:** `QuotaExceeded`, `SetLimitExceeded`, every other code, and a network error. An answer lost on
  the way may be a paid image, and a second request could be a second one.

Whether ModelArk sends `Retry-After` at all is not stated.

**The host and the key rule.** The host is one of the two regional hosts, picked by the *Region* row:
`https://ark.ap-southeast.bytepluses.com` (Johor) or `https://ark.eu-west.bytepluses.com` (Dublin). It never comes
from a recipe:

- a recipe's `options.regions` names regions, not hosts, and only these two exist;
- an unknown region is refused before any request;
- so is a region the variant's `regions` do not list.

`settings.ark.base` may name only the loopback mock, `http://127.0.0.1:<port>`, with no path, query or user info
(and not `localhost`); anything else is ignored. There is no UI for it. **The key rule** applies on top: a key
that starts with `test-` goes only to that mock, and any other key never goes there. Both mismatches are refused
before any request. So a real key cannot reach a local listener a setting points at, and a test key never
reaches BytePlus.

**Privacy.**

- **What leaves the machine:** the crop, *Original*, the reference layers and the prompt, inline in the request to
  the host of the *Region* row. Nothing goes to a file host. The image comes back in the answer (`b64_json`), so no
  result URL is asked for. (Such a URL "will expire within 24 hours", the reference; "Image URL is retained for 24
  hours and will be automatically cleared after expiration", the tutorial.) How long BytePlus keeps a generated
  image when no URL is asked for is not stated.
- **Where:** the host's region, which may pass a request to the other one (see "The Region row" above). The data
  processing page (updated 2026-09-10) says: "BytePlus ModelArk may use data centers, including those located in
  Malaysia, Indonesia, and/or the EU/EEA, for model deployment and Customer Data processing". It also says its
  load balancing "is currently deployed in Malaysia, Indonesia, and/or EU/EEA".
- **Training:** "Without the customer's prior authorization, BytePlus ModelArk will neither interfere with the
  data processing nor use Customer Data for its own model training."
- **Retention:**
  - The data processing page: "input and output triggered by the filter are retained for 180 days in Malaysia".
  - The content filter page says the filter's logs and the filtered content are "stored on servers in Malaysia
    or Singapore belonging to BytePlus or its affiliates". It adds that "even if you disable this feature, our
    services still maintain baseline content safety policies".
  - The filter switch is described for inference endpoints. Whether it applies to calls by model id, which is how
    Scumble calls, is not stated.
  - How long unfiltered inputs are kept is not stated.
  - The contracting entity and the data processing terms were not read.
- **Availability:** the country availability page (updated 2026-04-21) says the service is available, "with the
  exception of Restricted Models", in a list of countries. The list has every EU member state and the United
  Kingdom. It does not have the United States or mainland China. Whether Seedream is a "Restricted Model" is not
  stated.

**Prices** (the pricing page, updated 2026-09-17, USD per image):

- **5.0 pro, output:** "≤ 2.61 million pixels (1.5K or lower): 0.045" and "> 2.61 million pixels (higher than
  1.5K): 0.09".
  - With Highres fix on *Maximum* a pro crop goes out at up to 4.6 MP and costs $0.09. The variant's note says
    so, and says to set Highres fix lower for the cheaper size. Whether a lower setting brings a given crop under
    2.61 MP depends on the crop; the log's `size` shows what was asked for.
  - In Generate new, 1536 and below always stay under 2.61 MP. At 2048, a square (4.2 MP) is over it and 16:9
    (2048 × 1152, 2.4 MP) is under.
- **5.0 pro, input pictures:** "First image: Free", "From the 2nd image: 0.003". So *Original* and each reference
  layer add $0.003.
- **5.0 lite:** $0.035 an image, input pictures free. Its floor is 3.7 MP, so every size asked for has at least
  that many pixels.

The docs state no free quota for images. The free-quota pages speak of tokens ("500k free tokens").

**The recipes** ("pictures" counts the crop, *Original* and the reference layers together):

| Recipe | ModelArk model | Input | Settings rows | Output pixels | Pictures | Generate new | Price |
|---|---|---|---|---|---|---|---|
| `seedream_5_pro` | `dola-seedream-5-0-pro-260628` | edit | none (Johor only) | 921,600 to 4,624,220 | 10, none steeper than 16:1 | 1280, 1536, 2048 | $0.045 up to 2.61 MP, $0.09 above; $0.003 a picture after the first |
| `seedream_5_lite` | `seedream-5-0-260128` | edit | Region (`ap-southeast`, `eu-west`) | 3,686,400 to 16,777,216 | 14, none steeper than 16:1 | 2560, 3072, 4096 | $0.035 |

A variant's `options` describe the model:

- `pixels`: `[min, max]`, the output's total-pixel range;
- `max_images`: the picture count above;
- `png`: send `output_format: "png"`;
- `regions`: the *Region* values the model may use, the first being the default.

Both variants carry `limits` of `{ max, step: 16, pixels, minPixels, ratio: 16 }` (`max` 4096 on pro, 7680 on
lite) and a `note` that names where the pictures go.

**Only a real key can verify** (written defensively, and listed here until a live run):

- that a new account can activate the two models and call them by model id. Some accounts must use an endpoint id
  instead (404 `InvalidEndpointOrModel.ModelIDAccessDisabled`, "Accessing the model via Model ID is not allowed
  for your account. Please use a custom endpoint ID instead"), which the adapter does not support yet;
- whether a `WxH` is answered exactly on an edit (the log's `answered`), which steps it takes (the 16 is the
  adapter's own choice), whether an edge has a limit, and whether the edit keeps the crop's framing;
- whether Dublin serves 5.0 lite (the two pages above disagree), and whether a key made there reaches it;
- whether `seed` would be accepted, ignored or refused (it is not sent; the reference does not name it);
- the real latency. The docs state none, and the SDK's default timeout is 600 s. The request has no timeout of its
  own, so a generation whose answer headers take longer than Node's (undici's) default of 300 s fails as a
  network error and is not sent again;
- whether the "real person" refusal (`InputImageSensitiveContentDetected.PrivacyInformation`, "the input image may
  contain real person") hits ordinary photographs, which would rule out retouching portraits here;
- the free quota for images, which the docs do not give;
- whether the 30 MB counts the decoded bytes or the base64 text, and the limit for the whole request body;
- whether Seedream is a "Restricted Model" in the user's country;
- whether `output_format: "png"` is honoured on 5.0 lite (the adapter reads the format from the bytes either way);
- the shape of real errors on `/images/generations` beyond the 401 seen, and whether a 429 carries `Retry-After`;
- whether an answer ever carries `data[].url` despite `b64_json` (the fallback download).

**Tests.** `tools/ark_mock.py` is the loopback stand-in (the pattern of `openrouter_mock.py`). It answers
`POST /api/v3/images/generations`:

- without a Bearer key, 401 with the body the live hosts answered;
- an edit echoes its first picture as `data[0].b64_json`;
- a text request gets a plain PNG of exactly the requested `WxH`;
- `data[0].size` is the requested size, `output_format` the requested one (`jpeg` without one), and `usage`
  counts one generated image.

The mock refuses what the docs say the live API refuses:

- a missing model or prompt (400 `MissingParameter`);
- a size that is not `WxH` (400 `InvalidParameter`);
- a picture that is not a base64 data URL with a lowercase type (400 `InvalidImageURL.InvalidFormat`);
- an unknown model id (404 `InvalidEndpointOrModel.NotFound`). It knows the four Seedream ids of the model list
  and the lite alias.

It has three synthetic models:

- `mock-quota` answers 429 `QuotaExceeded`;
- `mock-ipm` answers 429 `ModelAccountIpmRateLimitExceeded` with `Retry-After: 1` once, then an image;
- `mock-notopen` answers 404 `ModelNotOpen`.

The mock records every header of every request and keeps the decoded pictures of each image request.

`node tools/ark_test.js` runs the adapter, its two recipe variants and its wiring in `providers/index.js` and
`recipes.js` in plain Node, without Electron and without a key. A scripted fetch plays both ModelArk hosts, the
loopback mock and a result host for a `url` answer, and `ctx.sleep` records its waits instead of waiting. It has
seven sections of checks:

1. **An edit.** One POST whose headers are exactly `Authorization` and `Content-Type`, and a body of exactly the
   seven fields. The prompt's sentences for none, one and several references. The pictures decode to the crop
   first, then the references in order, and neither mask goes out, not even for kind `fill`. The answer's format is
   read from its bytes (PNG, JPEG, or the asked format for anything else). A text run without references sends no `image`. An empty
   prompt, a missing crop or a missing model id is refused before any call.
2. **Sizes.** Checks that a small crop grows into the range, a big one shrinks, a crop inside the range goes as it
   is, and one steeper than 16:1 goes at 16:1. A sweep of 512 crop shapes has to stay inside the range, on 16 px
   steps, in the crop's shape. Generate new is checked with the dialog's own aspects (`GEN_ASPECTS` in `shell.js`)
   at each variant's text sizes, for the exact aspect wherever a size of it on 16 px steps lies in the range.
3. **Regions and hosts.** Checks that the Region param reaches Johor and Dublin, with a real key and with the mock,
   and that these are refused before any call: pro in `eu-west`, an unknown region value, and region names like
   `constructor` or `__proto__`. `settings.ark.base` is checked against the loopback rule.
4. **Pictures, before any call.** 10 and 14 pictures pass and 11 and 15 are refused, with the counts in the
   message. The 30,000,000-byte limit is tested at its edge, with the JPEG fallback (an asynchronous encoder
   awaited), a transparent picture refused, and a JPEG still too large refused. A shape rule is checked before any
   encode.
5. **Errors.** The live 401 shape with the key scrubbed. Every code's words, each with one call and no wait. The
   IPM limit and `ServerOverloaded` are sent once more after `Retry-After` (3 s, 60 s in full, the 5 s default, an
   HTTP date). A wait past 60 s is not taken, and there is no third request. `QuotaExceeded`, `SetLimitExceeded`,
   a 500 and a network error are sent once. An error inside a 200 fails the run. A `url` answer is downloaded with
   no header at all.
6. **The recipes** as `recipes.js` lists them. Only the two Seedream recipes carry `ark`, right after `toapis`
   with fal kept as the default. Each variant's model, `options`, `limits`, Region row, text sizes, note and
   description are checked. Each variant builds an edit and a text request, and each of its regions reaches that
   region's host. `index.js` gets the key row after OpenRouter, the text provider, the stored key, `settings.ark.base`
   and the app's `toJpeg` / `opaque`.
7. **The whole run.** No call carried a header beyond `Authorization` and `Content-Type`. The test key went only
   to the mock and the real key only to the two BytePlus hosts. Neither key appears in any error.

Gate `ark` (`tools/ark_test.py`) needs the instance started with `--offline`, since a result lands in the mirror
and would be forwarded to a connected ComfyUI. It runs `tools/ark_test.js` first. Then it drives the app over CDP,
with `settings.ark.base` on the mock and a `test-` key, and refuses a profile that already holds a ModelArk key.
The steps:

- **The lists before the key.** ToAPIs comes first in Settings › API providers. The ModelArk row has *get a key*
  and its key link, and no *check balance*; `providers.balance("ark")` is refused. Only the two Seedream recipes
  list `ark`, each right after `toapis`, with fal still their default. Their select reads "BytePlus ModelArk
  (Seedream) (no key)".
- **The key stored.** The row and the select option change accordingly.
- **An inpaint on Seedream 5.0 Lite.** One POST. The crop at the emitted size is `image[0]`, a PNG data URL.
  `size` is in 16 px steps, inside [3,686,400, 16,777,216] and within 2 % of the crop's shape. The body has
  `watermark: false`, `response_format: "b64_json"` and `output_format: "png"`, and no field beyond the seven the
  adapter sends. The prompt starts with the edit sentence, the key goes as a Bearer, and the log line's region is
  `ap-southeast`.
- **The Region row.** Set to `eu-west` through `set_settings`, it reaches the adapter: the log says `eu-west`, and
  the request still goes to the mock. It is then set back.
- **An inpaint on Seedream 5.0 Pro.** Its own model id, no settings rows, and a size inside [921,600, 4,624,220].
- **Generate new** at 16:9 and 2560: `2560x1440`, no picture, and a 2560 × 1440 base.
- **The failures.**
  - `QuotaExceeded` appears in the error, the status line and the log without the key, and is sent once.
  - `ModelAccountIpmRateLimitExceeded` is sent once more after its `Retry-After`.
  - `ModelNotOpen` says the model is not activated.
  - A real-looking key is refused at the test address on Generate and on Generate new, and nothing reaches the
    mock.

The clean-up clears the key and puts `settings.ark`, the remembered providers and the selected recipe back.

A mutation round on 2026-09-19 on the final code (117 mutations of `ark.js`, the wiring in `providers/index.js`
and `recipes.js`, and the two recipe variants, one at a time on a copy of the tree) turned `tools/ark_test.js` red
for every one of them, among them `watermark` left on, `response_format: "url"`, a tier for `size`, the pixel range
or 16:1 not held, the dialog's rounded size sent for Generate new, the 30 MB guard off or a transparent picture sent
as JPEG, the mask sent, a region that is no region or a host from a recipe, the test-key rule off either way, a
retry for `QuotaExceeded`, before `Retry-After` or a third time, the key left in a message or its head left at the
300-character cut, the error words of every code, lite's `limits.max` back at 4096, and a variant's default,
model id or place in the list.

### Comfy Router (`comfyrouter`)

Comfy Router is Comfy's direct model API: `api.comfy.org` runs a partner model from its **own native request
body** and answers with the model's own native output. It is not the Comfy Cloud route above, which builds a
ComfyUI workflow around a Partner Node on `cloud.comfy.org`. Both take the same `comfyui-...` key from
platform.comfy.org and bill the same Comfy credits, but **the Router needs no paid Comfy Cloud plan**. The adapter
`electron/main/providers/comfyrouter.js` is written from docs.comfy.org read on 2026-09-23: the Router's
quickstart, queue, providers and API reference pages (as Markdown, `<page>.md`), the live OpenAPI document at
`api.comfy.org/openapi` for the field names of the queue and error bodies, and **the published input schema of
every model it sends to** (`docs.comfy.org/router-schemas/<provider>/<model>.json`, copied into
`tools/refs/comfyrouter/`). **Run against the live API on 2026-09-23** with the user's key, on a scratch profile:
GPT Image 2 (an inpaint with the mask at Quality low, 23.6 s) and Nano Banana 2 (at Size 1K, 15.8 s), each a result
layer in the selection; the queue, the shared key and the OpenAI and Gemini bodies held. The other variants have
not run; their notes say so. **The balance's unit:** `GET /customers/balance` answers `amount_micros`, and it fell by
exactly 3.432 for an HY Image run whose price ComfyUI's node states as $0.03432, so the field counts **cents**,
whatever its name says (GPT Image 2 low at 2048 x 2048 cost 2.9, Nano Banana 2 at 1K 8.2). **The queue's result read
carries no `X-Comfy-Credits-Used`** (the reference lists it on the synchronous route only), so `info.credits` is null
on a queued run.

**Where it shows up.**

- **No key row of its own.** The adapter says `keyName: "comfycloud"`; `providers/index.js` reads the key under that
  name (`keyNameOf`), `describeAll()` lists Comfy Router with `sharesKey: "comfycloud"` and the Comfy Cloud key's
  state, and Settings › API providers skips it. The Comfy Cloud row's hint says the Router runs on the same key with
  credits only. There is no *check balance* (`GET /customers/balance` exists in the API document; not wired).
- **The recipes.** Nineteen recipes carry a `comfyrouter` variant (FLUX 3 Image since B1), always **last**, and no default changed. Their
  descriptions say "Also on Comfy Router." `comfyrouter` is in `TEXT_PROVIDERS`: Generate new sends the same model
  id without a picture, or with the reference layers alone where the variant has `text.refs` (26f; the openai dialect
  in `image`, the vertexai one with label parts, bfl in `input_image..`, byteplus in `image`, qwen before the text).

| Recipe | Router model | Kind | What goes in |
|---|---|---|---|
| `gpt_image_2`, `gpt_image_2_5_flare`, `_sunburst` | `openai/gpt-image-2`, `-2.5-flare`, `-2.5-sunburst` | fill | OpenAI's body: `image` (data URLs, crop first, at most 16), `mask` (the RGBA mask, at most 4 MB), `size`, `n: 1`, the OpenAI variant's settings (`openai._common`) |
| `nano_banana_2_1` | `vertexai/gemini-nano-banana-2.1` | fill | as the row below, plus Thinking as `generationConfig.thinkingConfig.thinkingLevel` in the schema's upper case (`MINIMAL` / `MEDIUM` / `HIGH`; only a variant with the row sends it) and `options.ratios` (the 14) for a free-size text run with references (schema saved as `tools/refs/comfyrouter/vertexai_gemini-nano-banana-2.1.json`, 2026-10-07) |
| `nano_banana_2`, `_lite`, `nano_banana_pro` | `vertexai/gemini-3.1-flash-image`, `-3.1-flash-lite-image`, `gemini-3-pro-image` | fill | Gemini's `generateContent`: the instruction (`refs.instruction`), then the crop, the mask as a second picture, the Original and the references, each with a label part before it ("Image 1:", ... `refs.labelParts`) when more than one picture goes, all as camelCase `inlineData` (the schema's spelling); the mask picture counts against `max_images`; `responseModalities: ["IMAGE"]`, `imageConfig` (1K / 2K / 4K; no 0.5K in the schema) |
| `flux2_pro`, `flux2_max` | `bfl/flux-2-pro`, `bfl/flux-2-max` | edit | `input_image` .. `input_image_9` (plain base64), `width` / `height` held to 256..2048 in 16 px steps, the seed, `output_format: "png"`, *Prompt upsampling* off (the Router's default is on), Max's *Safety tolerance* 0..5 |
| `flux1_fill` | `bfl/flux-pro-1.0-fill` | fill | `image`, `mask` (white = repaint), steps, guidance, safety tolerance; no text shape. The layout declares the drop "FLUX.1 Fill takes no reference images": a run with reference layers or the Original goes out with the crop and the mask, and the status line says what was not sent (until step 26a2 it was refused) |
| `seedream_5_lite`, `seedream_5_pro` | `byteplus/seedream-5-0-260128`, `-5-0-pro-260628` | edit | ModelArk's body (`ark._size`): `image` data URLs, `size` "WxH" in the crop's shape, `watermark: false`, `response_format: "b64_json"`, `output_format: "png"`, the seed. **The Router's schema gives other pixel ranges than ModelArk's docs**: lite 3,686,400 to ~9,437,184 (ModelArk: to 16.8 MP), pro 1,048,576 to 4,194,304; lite takes pictures of at most 10 MB |
| `qwen_image_edit` | `qwen/qwen-image-3.0` | edit | `input.messages[0].content`: the pictures (at most three) then the text; `parameters`: `size` "W*H" (0.26 to 6.55 MP, no steeper than 8:1), `prompt_extend: false`, `watermark: false`, seed, negative prompt |
| `magnific_precision` | `freepik/ai-image-upscaler-precision-v2` | upscale | `image` (plain base64), `scale_factor` 2..16, the four Magnific settings |
| `ideogram_4_5` | `ideogram/ideogram-4-5` | fill | Ideogram's Precise Edit, selected by `image`: the crop in `image`, the selection inverted to Ideogram's black = edit in `mask` (none for a selection over the whole crop), up to three references unnumbered in `reference_images`, all data URIs; `quality`, the seed modulo 2^31, `num_images: 1`; no `size` or `magic_prompt`. Generate new: the prompt alone, `size` the closest 1K / 2K preset, `magic_prompt: "off"` ("Ideogram 4.5" above). The ideogram dialect's `edit` is a function of the model part: 4.5 edits, 4.0 does not |
| `grok_imagine`, `ideogram_4`, `krea_2` | `xai/grok-imagine-image-2.0`, `ideogram/ideogram-v4`, `krea/krea-2-large` | text only (`edit: false`) | The Router's schemas for these take **no input picture**, so the variants work in Generate new only: the closest preset aspect (Grok's 13, Krea's 8), Ideogram's closest of its 21 2K sizes, Grok's tier 1k / 2k |

The Seedream, Qwen and Gemini bodies carry `refs.instruction`, numbered by the dialect's layout, as the ModelArk
and OpenRouter adapters do ("Reference pictures" above): Seedream and Qwen "Edit Image 1 and keep its size and
framing. …", Gemini the mask sentence; the OpenAI, FLUX and Ideogram 4.5 bodies send the prompt as written. `model`
is never in a body: the Router splices in the model the path names. A dialect's `body()` gets the run's context as a
fifth argument (Ideogram 4.5 decodes the mask with it). A model's own byte limit in whole decimal megabytes
(`options.max_bytes` 25,000,000 or 10,000,000) is named in those in a refusal, the Router's 25 MiB in MiB.

**Not wired, and why:** Recraft V4 (`recraft/recraftv4`: text only, and its schema documents no size list), SeedVR2
(`wavespeed/seedvr2`: its `image` is a URL and its size a target resolution, not a factor), FLUX.2 [flex] and
[klein] (the Router lists `bfl/flux-2-pro` and `-max` only), the Topaz and Recraft upscalers (not served), and every
video, 3D and audio model.

**The protocol: the queue.**

1. `POST https://api.comfy.org/v2/models/{provider}/{model}/requests` with `X-API-Key`, `Content-Type:
   application/json` and an `Idempotency-Key` (one UUID per run). The answer is `201 { request_id, status:
   "IN_QUEUE", queue_position, status_url, response_url, cancel_url }`. The adapter **composes the three URLs
   itself** from the host, the model id and the request id (a UUID, checked), never from the answer.
2. `GET .../requests/{id}/status` until `status` is `COMPLETED`, waiting the `Retry-After` each answer names
   (2 s without one, at least 1 s, at most 15 s: the docs call it a hint). Up to four failed reads in a row (a 5xx,
   a 429, a dropped connection) are outlasted; the fifth ends the run.
3. `GET .../requests/{id}`: `200` is the model's native output; `202` means not collectable yet and goes back to
   polling; an error is the run's failure (a run that `COMPLETED` with an `error_type` answers its error here).
4. After 15 minutes (30 for an upscale) the run is given up and `PUT .../cancel` is sent. The docs: a partner run
   that completes anyway is billed.

**Resends.** A submit answered `409 concurrency_limit_exceeded`, `429` or `503`, or lost on the way, is sent again
**under the same Idempotency-Key** after its `Retry-After`, three submits in all; the docs say the same key returns
the first run instead of queueing and billing a second. A `Retry-After` over 60 s is not waited out ("try again in
N s"). `402 insufficient_credits` and `409 invalid_input` are never sent again.

**The synchronous route as fallback.** The queue answers `403 not_enabled` for "a key with no workspace behind it
(legacy keys that predate workspaces)". The adapter then sends the same body once to `POST
/v2/models/{provider}/{model}` under a new Idempotency-Key (the docs: a key reused on another path is
`invalid_input`). That route holds the connection up to 660 s; Node's fetch gives up on headers after 300 s, so a
very slow model can fail there.

**The answers.** OpenAI and Seedream come back as `b64_json`; Gemini as `inlineData` (the last part that is not a
`thought`: a thinking model sends drafts); FLUX as a `result.sample` link on Comfy's storage (24 hours); Qwen,
Freepik, Grok, Ideogram and Krea as links on the partner's storage. **A link is fetched without the key** and only
when it is `https://` (or the test mock's own host). A native answer without a picture says why where it can: the
Seedream error code, Gemini's finish or block reason, Grok's `block_reason`, the text Qwen sent instead. The log's
`info` carries the Router's request id, `X-Comfy-Credits-Used` and `X-Comfy-Router-Dropped-Params`.

**Errors.** The body is `{ detail, error_type, upstream_detail }` (a 422: `{ detail: [{ loc, msg, type, ctx, input
}] }`), the bucket also in `X-Comfy-Error-Type`. Each of the eighteen documented buckets reads as words
(`insufficient_credits`: "the Comfy account has no credits left: add credits at platform.comfy.org";
`not_enabled`: "make a key in a workspace"), then the server's detail, a 422's fields by name, and
`upstream_detail` as "the provider said". An unknown bucket reads as `internal_error` with its name (the reference
says the set will grow). The key is taken out of every message.

**Pictures before any call.** Every picture at most 25 MB and all of them 64 MB (the Router's media caps), the
whole body at most 100 MB; per variant `options.max_images`, `max_bytes` (Seedream lite 10 MB, pro 25 MB) and
`max_ratio`. An opaque picture over its limit goes as JPEG; one with transparency is refused. `max_images` counts
every picture the model sees, the Gemini fill's mask picture too (`picturesFor` counts no mask, so the vertexai
body checks it before any call): Nano Banana with the crop, the mask and 13 references was let through before step
26a2 and is refused now.

**Hosts and keys.** The host is `api.comfy.org`, never a URL from a recipe. `settings.comfyrouter.base` may name a
loopback mock (`http://127.0.0.1:<port>`), and then only a key starting `test-` goes there, while such a key never
goes to Comfy.

**Where the pictures go.** To Comfy, which passes them to the model's own provider: OpenAI, Google's Vertex AI,
Black Forest Labs, ByteDance's BytePlus ModelArk, Alibaba Cloud (Qwen; the docs name no region), Magnific / Freepik,
xAI, Ideogram, Krea. FLUX and Grok answers are copied onto Comfy's storage for 24 hours; Comfy keeps a finished
queued request 24 hours. Comfy's own retention and training terms were not read.

**Only a real key can verify:** that the queue takes the user's key (or answers `not_enabled`), every body against
the live validation (the schemas are what the server enforces, the docs say, but only for fields it knows), whether
the OpenAI mask and the Gemini mask-as-picture reach the model as an edit, the output sizes, `Retry-After` in
practice, what a content-policy refusal costs per model (`GET /v2/models/{id}` has `billing.charges_on_policy_rejection`),
and the prices (`X-Comfy-Credits-Used`).

### Comfy Partner API (`comfypartner`)

Some models Comfy serves only as **Partner Nodes**, not through the Router. ComfyUI's Partner Nodes call proxy
routes on `api.comfy.org`, and Scumble calls the same routes with the same Comfy key. **These routes are not a
documented public API**: they are what ComfyUI itself sends, and Comfy can change them with a ComfyUI release. The
recipe's note says so, and a 404 reads "Comfy no longer serves this route". One model uses them today:

- **HY Image 3.5 Preview** (Tencent), recipe `hy_image_3_5`. The adapter `electron/main/providers/comfypartner.js`
  is written from ComfyUI's `comfy_api_nodes/nodes_hunyuan_image.py` (nodes `HunyuanImageEditApi` and
  `HunyuanImageTextToImageApi`, added 2026-09-22 in ComfyUI PR #16462) and ComfyUI's API client (`util/client.py`,
  `upload_helpers.py`, `_helpers.py`), read on 2026-09-23. The user's ComfyUI 0.37.0 does not have these nodes yet.
  The Router's catalog (240 models on 2026-09-23) has no HY Image. **Run against the live API on 2026-09-23:** an
  edit of one picture at 2048 x 2048 in 27.9 s, the balance down by $0.03432, the price the node states.

**Where it shows up.** Like Comfy Router, it has no key row: `keyName: "comfycloud"`, `sharesKey` in
`describeAll()`. It is the recipe's only provider and its default. `comfypartner` is in `TEXT_PROVIDERS`: Generate
new runs the same model without pictures, or with the reference layers after the text (up to 5, 26f). The loopback mock is the one of Comfy Router (`settings.comfyrouter.base`,
`tools/comfyrouter_mock.py`), because both talk to `api.comfy.org`.

**The protocol.**

1. For every picture of an edit (the crop first, then *Original* and the reference layers, at most five):
   `POST /customers/storage { file_name, content_type }` with `X-API-Key` answers `{ upload_url, download_url }`.
   The bytes go by `PUT <upload_url>` with only `Content-Type`, never the key (a signed URL). Both URLs must be
   `https://` (or the mock's own host). A picture with transparency goes as JPEG, because the node sends no alpha.
2. `POST /proxy/tencent/v1/wand/hunyuan-image/v35-generation` with `X-API-Key`, `Content-Type` and an
   `Idempotency-Key`: `{ model: "hy-image-v3.5-preview", messages: [{ role: "user", content: [{ type: "text", text },
   { type: "image_url", image_url: { url: <download_url> } } ...] }], size: "WxH", seed, logo_add: 0,
   resize_max_pixels }`. `size` is the crop's own size, both sides in 16 px steps, at most 4096 x 4096 in area.
   `resize_max_pixels` is *Detail* (standard 1,048,576, high 4,194,304: how much of each picture the model sees);
   a text run sends none, or its reference layers alone (26f). The text of an edit is `refs.instruction` in the recipe's `refs.name`, `Image {n}` ("Reference
   pictures" above): "Edit Image 1 and keep its size and framing. put Image 2 on the table Image 2 is a reference
   image.", and with Original on "Image 2 is Image 1 before the selected area was filled." first. The legacy
   `@Image2` in the user's prompt still becomes "Image 2", as the node does (with Original on that is the
   Original), and a number past the pictures sent is refused before any call; the layout's `max` is the five
   pictures (`HY_MAX_IMAGES`).
3. The answer is `{ choices: [{ delta: { image: { url, width, height } } }], error, request_id }` in the same
   request, nothing is polled. The picture is fetched from its link without the key. An `error` in the answer reads
   as its text after `msg:`. "download image failed" (the service could not fetch an uploaded picture yet) is sent
   again twice under a new key each time, as the node does.

**Sizes and prices.** The recipe holds a crop to 2048 px a side and 4,194,304 pixels: the 2K class the model renders
itself, $0.034 an image by ComfyUI's price badge. Generate new may ask up to 4096 x 4096, which the model renders at
2K and upscales ($0.046). No mask input: an instruction edit, and the stitch keeps the selection.

**Where the pictures go.** Into Comfy's storage (signed URLs), from where Tencent fetches them. Where Tencent runs
the model and what it keeps was not read.

### In-app (`inapp`)

A provider without a key or a network: `electron/main/providers/inapp.js` hands the crop to a helper model inside the
app (`electron/main/onnx`, docs/HELPERS.md). One recipe, `recipes/lama_remove.json` ("LaMa remove (in-app)", family
"In-app", package 5 step 3 of docs/PLAN_0_1_31.md): `model: "lama"`, `input: "fill"`, `text: false`, and the limits
`{ min: 512, max: 512, step: 512, aspects: ["1:1"] }`, so the crop is widened to a square where the picture allows and
goes out at LaMa's fixed 512 x 512 (a larger crop is scaled down and the answer scaled back up by the stitch). The hole
is the soft repaint mask above half (the selection grown and feathered, which also takes the rim), else the selection's
alpha; the answer holds the input outside it, and the stitch blends and colour-matches it as any provider's. No
prompt goes anywhere. The adapter is hidden from Settings › API providers (`describeAll`), `providerKeyState` in
`renderer/shell.js` reports the model instead of a key ("the LaMa model is not downloaded yet"), and a missing model
fails the run with the Helpers message. The recipe is listed under the api mode, since a provider recipe is: making it
a local recipe would free the helper models (LaMa among them) before its own run (`freeHelperModels`).

**Where the pictures go.** Nowhere: LaMa's own process on this machine. An empty hole (nothing selected) fails the
run with "nothing to fill" before the model runs.

### Magnific (`magnific`)

[Magnific](https://www.magnific.com) (Freepik) sells its upscalers and, through the same key, most of the image
models Scumble offers, its own Mystic, Ideogram's mask inpainting and Image Expand (outpainting). Sources, read on
2026-09-22 (the upscalers) and 2026-09-26 (the rest): the reference at https://docs.magnific.com (the same pages as
docs.freepik.com; each page also as Markdown at `https://docs.magnific.com/api-reference/<path>.md`; the
magnific.com pages answer 403 to a script), the whole OpenAPI document
(https://storage.googleapis.com/fc-freepik-pro-rev1-eu-api-specs/magnific-api-v1-openapi.yaml, linked from
https://docs.magnific.com/authentication; its only server is `https://api.magnific.com`), the prices at
https://www.magnific.com/api/pricing (EUR, read in a browser) and the terms at
https://www.magnific.com/legal/terms-of-use. `electron/main/providers/magnific.js` is the adapter; the request
schemas of every route it uses are copied, resolved, into `tools/refs/magnific/`. **Only the two upscalers have run
against the live API** (2026-09-22, "Upscale recipes" above); everything else is written from the docs and tested
against a mock.

**Where it shows up.** A `magnific` variant, **last** in the recipe's providers and no default changed, in:

| Recipe | Edit route (`model`) | Generate new route (`text.model`) | Pictures |
|---|---|---|---|
| `flux2_pro` | `text-to-image/flux-2-pro` | the same | 4 (`input_image`, `input_image_2..4`), 256 to 1440 px a side |
| `flux2_flex` | `text-to-image/flux-2-flex` | the same | 4, 256 to 1920 px a side |
| `gpt_image_2` | `text-to-image/gpt-image-2-edit` | `text-to-image/gpt-image-2` | 16, 20 MiB each, 64 MiB together |
| `gpt_image_2_5_flare` / `_sunburst` | `text-to-image/gpt-image-2-5-edit` (`variant` fixed) | `text-to-image/gpt-image-2-5` | 16, as above |
| `seedream_5_pro` | `text-to-image/seedream-v5-pro-edit` | `text-to-image/seedream-v5-pro` | 10, each 256 × 256 to 10 MB |
| `seedream_5_lite` | `text-to-image/seedream-v5-lite-edit` | `text-to-image/seedream-v5-lite` | 5, as above |
| `z_image_turbo` | none (`edit: false`: Magnific has no Z-Image edit) | `text-to-image/z-image` | – |

and six recipes of its own, `default: "magnific"`: **`mystic`** (family *Magnific*, Generate new only),
**`seedream_4_5`** (family *ByteDance*, `…/seedream-v4-5-edit` and `…/seedream-v4-5`, 5 pictures),
**`ideogram_inpaint`** (family *Ideogram*, `ideogram-image-edit`, `input: "fill"`, `text: false`) and the three
**Outpaint** recipes `expand_flux_pro`, `expand_ideogram`, `expand_seedream_4_5` (`image-expand/flux-pro`,
`…/ideogram`, `…/seedream-v4-5`, `input: "fill"`, `text: false`). The upscalers `magnific_precision` and
`magnific_creative` keep Magnific as their home. `magnific` is in `TEXT_PROVIDERS`, and every variant names its
`text` shape (the model id of a text route, or `false`): the edit routes end in `-edit` and differ in more than the
name, and `tools/magnific_test.js` holds every variant to it.

**The protocol.** `POST https://api.magnific.com/v1/ai/<route>` with the header `x-magnific-api-key` and the
route's own JSON body answers `{ data: { task_id, status: "CREATED", generated: [] } }`; `GET <route>/<task_id>` is
read every 3 s until `COMPLETED` (`FAILED` ends the run; the spec confirms a status route for every route used) and
the picture is downloaded from the first URL in `generated`, **without the key**, only when it is https, a `data:`
picture or the test mock's own host. The status URL is composed from the host, the route and the task id, never
taken from an answer, and a task id that is not `[A-Za-z0-9-]{1,80}` is never put into a URL. No webhook: the app
has no public address. `webhook_url` and `filter_nsfw` are never sent, `num_images` is always 1. An edit waits at
most 15 minutes, an upscale 30. A route is looked up in the adapter's own table (`ROUTES`, an own-property lookup,
after `/v1/ai/` and slashes are taken off), and a settings key reaches the body **only when the route's `accepts`
names it**: the table is the allowlist, and the settings rows and `fixed` of every shipped variant are checked
against it.

**Per route.**

- **Ideogram Inpaint** (`ideogram-image-edit`, the only mask inpainting on Magnific): `{ prompt, image, mask, seed,
  rendering_speed, magic_prompt, style_type, style_reference_images }`. Scumble's mask is white where to repaint;
  Ideogram's is "a black and white image of the same size as the image being edited. Black regions indicate where
  to edit", so the adapter inverts it in the main process (channel 0 at 128 or above becomes black, the rest white,
  always PNG, through Electron's `nativeImage`) and refuses a mask of another size. The prompt goes as written
  (*Magic prompt* defaults to OFF: the spec gives no default), reference layers go as `style_reference_images` (10 MB
  together, the docs' limit), the picture at most 10 MB (an opaque one as JPEG), the seed held to 2^31 − 1. Turn
  *Original* off: it would go as a style reference. The layout says `style: true` and `max` 11 (the crop and the
  style references; the mask has its own field): style references have no number, so the prompt gets no reference
  sentence and a prompt that names one is refused. The docs name no Ideogram version (the fields are version 3's).
- **Instruction edits** (FLUX.2, Seedream, GPT Image): the crop first, then Original and the reference layers, as
  plain base64 (no `data:` prefix), and the prompt is `refs.instruction`, the text the other instruction-edit
  adapters send ("Reference pictures" above; Seedream with two references: "Edit Image 1 and keep its size and
  framing. a red door Images 2 and 3 are reference images."). The layout's `max` is the route's `maxImages`, so a
  FLUX.2 run with five pictures is refused before anything is sent. No mask field:
  the stitch keeps the selection. FLUX.2 takes `width` / `height` (the emitted size, 256 to 1440 px on [pro] and 1920
  on [flex], in 16s) and answers that size. **Seedream and GPT Image 2 take only an `aspect_ratio` preset** (eight
  and ten shapes): their variants carry the presets as `limits.aspects`, `planCrop` widens the crop's context to the
  nearest one the picture can give ("How big the crop goes out" above), the adapter sends the preset closest to the
  emitted size, and when that is within 3 % of the crop (`|ln(w/h) − ln(preset)| ≤ 0.03`) the answer is stretched
  onto the crop (`info.fit = "stretch"`, copied by `host.runProvider` into the stitch's `info`); beyond that it is
  centre-cropped as before. **GPT Image 2.5** takes `aspect_ratio: "auto"`, which keeps the reference's shape, but
  "only `1k` leaves the size to the model; `2k` and `4k` render a square", so an edit always sends `auto` at `1k`
  and is stretched only when the crop is its only picture (with Original or reference layers on, whose shape wins
  is not documented). GPT Image 2 has no transparent background (`opaque` / `auto` only), so its variant has no
  *Background* row; 2.5's does, and a transparent answer lands as a cut-out.
- **Text runs** (Generate new): the preset closest to the asked aspect (the dialog's `aspect`, else the size) and
  the tier covering the asked long side (`resolution` 1k / 2k / 4k, Seedream 5.0 Pro 1.5k / 2k), not the edit's
  *Resolution* row. With reference layers (26f, the routes with `refs: true` in `ROUTES`) FLUX.2 [pro] and [flex]
  take them on their own route in `input_image`, `input_image_2..4`, and Seedream and GPT Image go to the `-edit`
  route (`text.refs.model`) with `reference_images`, at the same preset and tier (never the edit's `auto` at 1k);
  every other route leaves them out. **Mystic** (`mystic`): `{ prompt, resolution, aspect_ratio, model, engine, creative_detailing,
  fixed_generation }`; the *fluid* model takes five shapes only (1:1, 9:16, 16:9, 3:4, 4:3, the field's
  description), the others twelve (the spec's thirteenth, `social_post_4_5'`, carries a stray quote and waits for a
  live check); no seed (*Fixed generation* repeats a result); its NSFW filter cannot be switched off, and an answer
  it flags (`has_nsfw[0]`) is still used, with a log line and `info.nsfw`. **Z-Image** (`text-to-image/z-image`):
  one of six `image_size` presets (512 × 512 only for a square of 512 or less, else the nearest of 1024 × 1024,
  768 × 1024, 576 × 1024, 1024 × 768, 1024 × 576), steps, the safety checker, PNG.

**Image Expand as outpainting.** No editor change: *Image › Extend canvas* bakes the picture into a larger canvas and
selects the new frame (over MCP: `extend_canvas`, `select_recipe expand_flux_pro magnific`, `generate`), and the run is
an ordinary `fill` run. The adapter reads the geometry from the mask: the pixels outside the selection (channel 0
under 128) are the kept part, their bounding box is sent as `image` (cut out of the crop with `nativeImage.crop`),
and the distance from that box to each edge of the crop is `left`, `right`, `top` and `bottom`, at the emitted size.
**All four edges always go out**: FLUX Pro puts 512 / 512 / 256 / 256 on an edge that is left out. Refused before
anything is sent, with the rule in the words ("Image Expand extends a picture outward: select only the new border
around it (Image › Extend canvas selects it for you); for other selections use an edit recipe."): a crop with
nothing kept, a selection that covers more than 2 % of the kept box (a blob, a notch, a hole; a pixel counts when it
is selected above 3/4, because *Feather* on auto rounds the kept box's inner corners up to 3/4 - 2.7 % of the box at
128 and over after *Extend canvas*, none above 190), a selection that reaches no edge; FLUX Pro also a kept part
under 256 px a side or over 20 MP, every route a margin over 2048 px at the size it is sent; Seedream 4.5 sends a
kept part over 10 MB as JPEG when it is opaque. The prompt goes only when there is one (Ideogram and Seedream then
write their own), the seed on Ideogram and Seedream, reference layers and the Original not at all: the layout declares
the drop "Image Expand takes the picture alone", so the adapter never gets them and the status line says what was
not sent (before step 26a2 a log line said so), and a prompt that names a reference is refused. The answer
is the whole canvas at the model's own size (the docs: FLUX Pro "capped at
roughly 1.6 megapixels", sides in 16s; Ideogram "approximately 1 megapixel", sides in 32s, only the aspect kept;
Seedream 4.5 "between 3,686,400 and 16,777,216 pixels"), so the recipes' `limits` send the crop at that size and
the answer is always stretched onto the crop (`fit`): the docs' own Ideogram examples drift up to about 2 % in
aspect, which the stitch's 1 % rule would otherwise centre-crop. The stitch then blends only the selection. With
*Feather* on auto the mask that goes out is the grown one (as for every fill run), so the kept part loses the
grow band (about 52 px on a 768 × 608 canvas) and the model redraws it too; *Feather* manual sends the old picture
exactly.

**Two renderer changes, both app-only** (`stitch.js` and `host.js` are not built into the node): `limits.aspects`
in `planCrop` (the widening, `info.aspect`) and `info.fit === "stretch"` in `finishPixels`, which `host.runProvider`
copies from the adapter's answer. **Trap:** `nativeImage.crop()` goes through Skia's premultiplied pixels, so a
half-transparent pixel of the kept part may move by a level; only Scumble's own PNGs (the crop, the mask) are
decoded in the main process, never an answer (which may be WebP).

**Sizes and limits**, as the variants carry them: FLUX.2 [pro] 1440 (the recipe's own), [flex] 1920 (the spec's
range), Seedream and GPT Image 2 the recipe's 2048 with their presets as `aspects`, GPT Image 2.5 the recipe's 2048,
Ideogram Inpaint the default 2048 (the docs give only the 10 MB), `expand_flux_pro` 2048 in 16s with 1,600,000 px,
`expand_ideogram` 2048 in 32s with 1,048,576 px, `expand_seedream_4_5` 4096 in 16s with 3,686,400 to 16,777,216 px.

**Errors and retries.** 401 reads "key refused", 402 "no credits left on the Magnific account", 403 "access
refused", 404 "Magnific does not know this route or task (the API may have changed; an update of Scumble may be
needed)", 400 names the invalid parameters from `problem.invalid_params` (the spec's `application/problem+json`) or
the `message`, 5xx "the service failed"; the prefix is `Magnific <route>: ` and the key is taken out of every
message. **No AI route documents 402 or 429** (429 appears only on the stock downloads), so those words are
assumptions until a live run. A 429 or 503 on the POST is sent once more after its `Retry-After` (5 s without one),
not at all when that is more than a minute ("try again in N s"); a network error on the POST is never sent again
(the task may exist and be billed). Up to five failed status reads in a row (a 5xx, a dropped line) are waited
through, the count starting again after a good read; a 4xx on a status read ends the run. `FAILED` names no reason
("a safety filter, a picture it could not read, or a fault on its side"). A download that fails on the server's
side or the line is tried three times (the task is paid for by then); a 403 there reads "the result link was
refused (expired?)".

**Host and key.** The host is `api.magnific.com`, never a URL from a recipe; `settings.magnific.base` may name a
loopback mock for the tests (`http://127.0.0.1:<port>`, nothing else), and then only a key starting `test-` goes
there, while such a key never goes to Magnific. There is **no balance**: Magnific has no credits route for normal
plans (`POST /v1/analytics/team-credit-usage` is for Business and Enterprise), so the key row has no *check
balance*.

**Privacy and terms.** The pictures go inline (base64) to Magnific / Freepik (Freepik Company S.L., Málaga, Spain),
which hosts inputs and outputs "on platforms managed by Magnific or its providers", uses them "for security
purposes and to improve Magnific products", and "will not use Inputs … or Outputs to train its own AI models"; the
docs do not say where a model runs (FLUX, Seedream, GPT Image and Ideogram are other companies' models). For the
user to settle before a release: the terms' section "API Services" says the customer "should never request that
End Users register and provide their own API Keys", which is how Scumble works; it applies to the upscalers shipped
in 0.1.24 as well.

**Prices** (EUR per image, Magnific's price list read 2026-09-26; the page is partly stale, it still lists the
removed Imagen models): FLUX.2 [pro] 0.03, Seedream 5.0 Lite and 4.5 0.034, Z-Image 0.017, Mystic 0.058 / 0.10 /
0.32 at 1k / 2k / 4k, Ideogram Inpaint 0.025 / 0.05 / 0.076 (Turbo / Default / Quality), FLUX Pro Expand 0.07,
Ideogram Expand 0.025, Seedream 4.5 Expand 0.034; not listed: FLUX.2 [flex], Seedream 5.0 Pro, GPT Image 2 and 2.5
(GPT Image 2 is billed by quality and, for a text run, resolution; an edit by quality alone). Every API call costs
credits, whatever the web plan says ("Unlimited" allowances cover the web app only).

**Not built, and why.**

| Route | Why |
|---|---|
| Nano Banana Pro and Pro Flash (Nano Banana 2) on Magnific (the M1b step) | Their references are URLs only, so the pictures would go through Magnific's uploads API first: a file stays on Magnific's Google Cloud storage for about seven days, anyone with its token URL can fetch it for about a day, and the API has **no delete route**. Nano Banana runs on the other providers of its recipes without that. |
| FLUX.2 Klein | The docs name neither 4B nor 9B, and `recipes/flux2_klein.json` is the 9B |
| FLUX Kontext Pro and Max | URL input only, and Scumble has no Kontext recipe |
| FLUX.2 Turbo, Runway Gen4, HyperFlux, FLUX Pro 1.1, FLUX Dev, "Classic fast" | Text only, and Scumble has no recipe for them |
| Mystic's structure / style references and LoRA styling | Generate new sends no pictures |
| Relight, style transfer, change camera, skin enhancer, remove background, reimagine, improve-prompt | Out of scope |
| A balance query | No route for normal plans (above) |

**Only a real key can verify** (each costs credits; waits for the user's word): one task per route with a base64 PNG
where the schema says base64; the real 402 and 429 answers; what a FAILED task and a safety block look like (a
black picture, `has_nsfw`?); Ideogram's mask polarity, how it treats a grey feather, its output size and version;
Image Expand's output sizes against the docs' tables and the seam of the kept part; that Seedream and GPT Image 2
keep the framing of a crop sent at a preset shape; GPT Image 2's edit output sizes per tier; GPT Image 2.5's `auto`
with several pictures (whose shape wins); how long result URLs stay valid; Mystic's `social_post_4_5`; the prices
of Flex, Seedream 5.0 Pro and GPT Image 2 / 2.5; whether a JPEG answer (the docs' examples are `.jpg`) stitches
without trouble.

**Tests.** `node tools/magnific_test.js` (plain Node, a scripted fetch and a fake codec: the route table, every
body of every shipped variant against its route's schema in `tools/refs/magnific/`, the instruction edits and their
presets, the text runs and tiers, the inverted mask byte for byte, `keptRect` on built masks and the Image Expand
geometry, the task client, the error words, the host and key rule, the recipes, the wiring in `index.js`, and that
the key went only to `/v1/ai/`). The gate `magnific` (`tools/magnific_test.py` against `tools/magnific_mock.py`,
which checks every body against the same schemas) runs it first, then the app: the lists and the key row, an
instruction edit widened to a preset, Ideogram's inverted mask, Image Expand after *Extend canvas* (an answer
1.024 times wider is stretched, not centre-cropped), a selection that is no border refused before anything is
sent, Generate new through Mystic and Z-Image, and a real key never reaching the mock. `tools/size_test.py` has two
steps for `aspects`; `tools/upscale_test.js` and `.py` still cover the upscalers unchanged.

### Oxen.ai (`oxen`)

[Oxen.ai](https://www.oxen.ai) runs many image and chat models behind one key. Sources, read on 2026-09-26: the docs
index https://docs.oxen.ai/llms.txt and the pages it lists (inference overview, image editing, image generation,
chat completions, async queue, model references), and the model list `GET https://hub.oxen.ai/api/ai/models`, which
answers without a key and carries each model's `request_schema` and price; the schemas of the 22 models Scumble uses
are copied into `tools/refs/oxen/` (`{ id, endpoint, pricing, request_schema }`; FLUX 3 Image's on 2026-10-03). `electron/main/providers/oxen.js`
is the adapter. **Nothing here has run against the live API**: there is no Oxen key (the user, 2026-09-26), so every
variant is written from the docs and the model list and tested against a mock.

**Where it shows up.** An `oxen` variant in twenty-one recipes (FLUX 3 Image since B5), **after Comfy Router and before Magnific** (Magnific
stays last), no default changed and "Also on Oxen.ai." in each description; one key row in Settings › API providers
(between ModelArk and Magnific, no *check balance*); three prompt-upsampling rows and three assistant models on the
same key (below). One recipe is new and runs on Oxen alone: **Qwen Image 2.1** (`recipes/qwen_image_2_1.json`,
`default: "oxen"`), Alibaba's 2.1 as an API model. Oxen runs it on fal (its schema names fal's endpoint,
`fal-ai/qwen-image-2.1/edit`, and says the pixel size is "sent to fal"), so a fal variant can follow once fal's own
schema for it has been read. It answers the API side of CLAUDE.md's item 15 ("Qwen Image Edit 2.1 has no API"):
Oxen serves `qwen-image-2-1`. Whether it is the same 2.1 as the local recipe's open weights is for a live key to say.

| Recipe | Oxen model | Input | Aspect of an edit | Tiers (`options.tiers`) | Pictures | List price (2026-09-26) |
|---|---|---|---|---|---|---|
| `gpt_image_2` | `gpt-image-2` | fill, `mask_url` white = repaint | `auto` | 1K / 2K / 4K (1024 / 2048 / 3840) | 16 | $0.004 to $1.13 by quality and resolution |
| `gpt_image_2_5_flare`, `_sunburst` | `gpt-image-2-5-flare`, `-sunburst` | fill, `mask_url` RGBA, transparent = repaint | `auto` | as above | 16 | $0.0517 at 2K high ($0.0041 to $0.5203) |
| `nano_banana_2` | `nano-banana-2` | fill, the mask as a second picture | `auto` | 512 / 1K / 2K / 4K | 14 | $0.0585 (512) to $0.1963 (4K) |
| `nano_banana_2_lite` | `nano-banana-2-lite` | edit | `auto` | 1K only | 14 (not stated) | $0.0442 |
| `nano_banana_pro` | `google-nano-banana-pro` | fill, the mask as a second picture | `auto` | 1K / 2K / 4K | 14 | $0.15 |
| `seedream_5_pro` | `bytedance-seedream-5-pro` | edit | the closest of 8 presets (no `auto`) | `size` 1K / 2K | 10, none steeper than 16:1 | $0.045 |
| `seedream_5_lite` | `bytedance-seedream-5-lite` | edit | none (no aspect field) | `size` 2K / 3K / 4K | 14, 16:1 | $0.04 |
| `flux2_pro` | `flux-2-pro` | edit | `match_input_image` | 0.5 / 1 / 2 MP by area | 8 (BFL's number) | $0.10 |
| `flux2_flex` | `flux-2-flex` | edit, steps and guidance | `match_input_image` | as above | 8 | $0.12 |
| `flux3` | `flux-3-image` | edit, the prompt as written, Safety tolerance and Grounding rows | the crop's preset (or one within 3 %), else `auto`; 15 presets | 1k / 2k / 4k by area (`sizing: "flux3"`) | 10, 256 px a side to 16 MP (BFL's) | $0.0624 at 1k, $0.13 at 2k, $0.7891 at 4k (2026-10-03) |
| `flux2_klein` | `black-forest-labs-flux-2-klein-9b` | edit, steps, output quality | the closest of 5 presets | none | not stated (the schema's list has no `maxItems`; the adapter's default 16 holds, BFL's own klein takes 4; "Undocumented" above) | $0.02 |
| `qwen_image_edit` | `qwen-image-3` (Qwen Image 3.0) | edit, `input_images`, negative prompt | `auto` with the crop alone, else the closest preset | 1K / 2K | 3 | $0.039 |
| `qwen_image_2_1` | `qwen-image-2-1` | edit, `input_images`, negative prompt | the closest of 7 presets | 1K / 2K | 10 | $0.109 |
| `grok_imagine` | `xai-grok-imagine-image-edit`; Generate new `xai-grok-imagine-image` | edit, one picture only | none | Generate new 1k / 2k | 1 | $0.022 edit, $0.02 text |
| `krea_2` | `krea-v2-large-text-to-image` | Generate new only | - | - | - | $0.06 |
| `ideogram_4` | `ideogram-v4` | Generate new only, `image_size` preset | - | - | - | $0.06 |
| `z_image_turbo` | `z-image-turbo` | Generate new only, no size field | - | - | - | $0.01 |
| `topaz_precision` | `topazlabs-image-upscale` | upscale 2x / 4x | - | - | 1 | $0.05 |
| `topaz_creative` | `topazlabs-bloom-2-image` (Bloom 2) | upscale, the model's own factor, the prompt as guidance | - | - | 1 | per Topaz credit ($0.08), credits per image not stated |
| `topaz_generative` | `topazlabs-wonder-3-5-image` (Wonder 3.5) | upscale 1x / 2x / 4x / 6x | - | - | 1 | per Topaz credit |

**The protocol.** Two synchronous routes on `https://hub.oxen.ai/api/ai`, a Bearer key:

```
POST /images/edit      { model, prompt, input_image | input_images, mask_url?, <model params>, response_format: "b64_json" }
POST /images/generate  { model, prompt, <model params>, response_format: "b64_json" }
  -> { model, created, images: [{ b64_json } | { url }] }
errors: { error: { type, title, detail }, status: "error", status_message } | { error: { message } }
```

Every run that carries a picture (edit, fill, upscale, and since 26f Generate new with reference layers) goes to
`/images/edit`, Generate new without them to `/images/generate`.
The model list names `/images/generate` as every image model's endpoint, including the editors and the upscalers; the
image-editing reference names `/images/edit` for a run with a picture, which is what Scumble follows (a live key
settles it). The request is built to each model's own `request_schema`, not to the hub OpenAPI's OpenAI-shaped
`ImageEditRequest` and not to the example page's `image_url` field, both of which are older than the schemas.
`response_format` is always `b64_json`; an answer that carries only a `url` is downloaded (without the key first; on
a 401 or 403 from the API's own origin once more with it, never to another host; a 5xx or a lost connection is tried
three times, the run is paid by then). **Not built:** the async queue (it stores every job's request parameters,
the crop's data URL included, answers result URLs only and checks the parameters only when the job runs), and a
balance: the hub API has no credits route, so the key row has no *check balance*.

**Pictures go inline as data URLs.** The image-editing reference says "Data URIs (`data:image/...;base64,...`) work
as an alternative but aren't recommended for production" (https://docs.oxen.ai/inference-api/reference/image_editing.md),
and every schema types `input_image`, `input_images` and `mask_url` as `format: uri`, which a data URL is. The
pictures of one request (mask included) stay under 18 MB of base64: Oxen states no limit for images, its chat
reference caps an inline audio part at 20 MB, and Gemini (behind the Nano Banana models) an inline request at 20 MB.
Over it the opaque pictures go as JPEG, largest first; a mask or a transparent crop never; still over it the run is
refused before anything is sent. **The upload route is not built**: a picture must be reachable by the model, so it
would go into a *public* Oxen repository, and a deletion there is only a commit, so every crop would stay in the
repository's history until the whole repository is deleted. **If a live key shows that data URLs are refused**
(the adapter puts "Oxen could not read the picture" in front of Oxen's "Client Error ... for url"), the edit and
upscale variants go and the Generate-new-only variants and the chat rows stay; an upload route needs the user's word.

**Fill and edit.** GPT Image 2 takes the selection as `mask_url` with white = repaint (`options.mask: "white"`,
`req.mask`); GPT Image 2.5 as an RGBA mask whose transparent pixels are repainted (`"alpha"`, `req.maskAlpha`); the
2.5 schema says the mask must match the first picture's size, which the crop's mask always does. Nano Banana 2 and
Pro have no mask field: a `fill` variant without `options.mask` sends the mask as the second picture and the prompt
says what it means. Every other variant is an instruction edit of the crop plus the reference layers; the stitch
keeps the selection either way. The prompt of every edit and fill is `refs.instruction` through
`openrouter.promptFor(req, lay)` with Oxen's own layout ("Reference pictures" above): the mask is a numbered picture
only where it goes as one, so on a `mask_url` fill the Original is picture 2 and the mask is not named.

**Sizes.** No model takes a pixel size: a Resolution (or Size) row left on *auto* takes the smallest tier that covers
the crop's long side (FLUX: its area, "0.5 MP" / "1 MP" / "2 MP"), else the largest. The aspect of an edit follows
`options.edit_aspect`: `auto` (GPT Image, Nano Banana), `match_input_image` (FLUX.2 pro and flex), the closest preset
(Seedream 5.0 Pro and Qwen 2.1 take no `auto`, Klein no "match"), or `auto-single` for Qwen Image 3.0, whose `auto`
keeps "the aspect ratio of the last image" (with references the closest preset goes out instead). None of these is
verified to keep the crop's shape; an answer of another shape is centre-cropped by the stitch. Seedream 5.0 Lite has
no aspect field at all, so its variant has no Generate new (`text: false`); Z-Image's schema has no size field, so
the host picks the size and Generate new takes the answer's size. Ideogram's size is a named preset
(`image_size`: square_hd, portrait / landscape 4:3 and 16:9), the one closest to the dialog's aspect.

**The option keys** (`options` of an `oxen` variant; each checked against `tools/refs/oxen/` by `tools/oxen_test.js`):
`accepts` (the parameters sent; a settings row or a `fixed` value outside it never goes out, nor does `random_seed`,
an empty value or an "auto" not in `keep_auto`), `image_field` (`input_image`, or `input_images` for Qwen), `single`
(the picture field is one string: Grok's edit, the upscalers; one picture only), `mask` (`white` / `alpha`),
`edit_aspect`, `ratios`, `tiers` / `tier_key` (default `resolution`; Seedream's is `size`) / `tier_unit` (`area`),
`presets` / `preset_key` (Ideogram), `keep_auto` (Moderation's "auto" is a real value), `numbers` (Bloom's
creativity goes as a number), `max_images` (crop, mask picture, Original and references, 16 when unset; more are
refused before sending),
`max_ratio` (Seedream: 16), `factor_key` / `factor_form` (`upscale_factor: "4x"`, `scale: "6x"`), `prompt_max`
(Bloom: 1024 characters, cut with a log line), and `text` (options that replace these for Generate new: Grok's text
model takes `aspect_ratio` and `resolution`, its edit model neither; a Generate new with reference layers goes to the
edit model and keeps the edit's options, 26f). FLUX 3 Image's variant adds three (B5): `sizing: "flux3"` (the tier
by area and the preset by FLUX 3's rules over `ratios`, instead of `tiers` and `edit_aspect`; Safety tolerance as a
whole number 0 to 4, Grounding as a JSON boolean), `prompt: "as_written"` (no instruction around the prompt; a blank
one is refused) and `min_side` / `max_pixels` (a reference layer or the Original scaled into them, the crop refused). A `seed` goes out where the schema takes one,
reduced to 0..2147483647 (Qwen's range), and the seed reported is the one sent: none where `accepts` has no seed
(since B5; before, such a run reported the editor's); `negative_prompt` where it takes one and it is not empty. Never sent:
`target_namespace`, `n`, `num_generations`, attribution headers.

**Errors and retries.** Oxen's envelope is read for `detail` (else `title`, else `message`) and its `type`, and the
words go in front: "Oxen could not read the picture ..." for a "Client Error ... for url" (the data-URL case),
"not enough Oxen credits" for a 402 or a message about credits, "Oxen does not serve this model (any more)" for a
404 or "Model not found", then by status (401 key refused, 400 request refused, 403 refused, 408 / 504 / 524 timed
out, 413 request too large, 429 rate limited, 500 the service failed, 502 the model's host failed, 503 the service
is busy). The key is taken out of every message. A 429 or 503 is sent once more, never before `Retry-After`
(seconds or a date, 5 s without one), and not at all past 60 s ("try again in N s"); a 502, any other 5xx and a lost
connection are never retried, because the image may be billed already. Node's own limit of 300 s before an answer's
headers ends a run that takes longer with "no answer within 5 minutes; the run may still be billed and saved in your
Oxen account" (GPT Image at xhigh / max and 4K, or Topaz on a large picture, may come close; a live key will tell).

**Host and key.** The host is `https://hub.oxen.ai`, never a URL from a recipe; `settings.oxen.base` may name a
loopback mock (`http://127.0.0.1:<port>`, nothing else), and then only a key that starts with `test-` goes there,
while such a key never goes to hub.oxen.ai. The same rule holds for the upsampling rows.

**Privacy.** The pictures go inline to Oxen.ai, which runs the model or passes it on (some schemas name fal as the
host behind it). **Oxen keeps every generated image in the user's Oxen account** (results "automatically get saved to
a dataset", https://docs.oxen.ai/examples/inference/image_editing.md). Its terms and privacy policy could not be read
(www.oxen.ai/legal/* answered a bot check), so how long it keeps what is sent is not stated; every variant's note says
so.

**Chat on the Oxen key.** Oxen's Chat Completions are OpenAI-compatible at `/api/ai/chat/completions`, **with no
`/v1`** (`llm.js` takes the base as it is, the `exact` switch of `askCompatible`). Prompt upsampling has three rows
(`llm.js` `MODELS`, per million tokens in / out on 2026-09-26): Gemini 3.8 Flash ($0.75 / $3.75), GPT-5.6 Luna
($1 / $6), Gemma 4 31B ($0.14 / $0.40); the crop goes as a data URL, as Oxen's vision example sends it (the chat
reference's "must be publicly accessible" contradicts that page; a live key settles it). A row the user adds under
Settings › Language models with the provider Oxen.ai goes through the same client. The assistant has an `oxen` entry
(`assistant/providers.js`, after WaveSpeedAI): Claude Sonnet 5, GPT-5.6 Terra and Gemini 3.8 Flash, without
`stream_options` (Oxen documents none; leaving it out only loses the cost line) and with the 402 read as final.

**Offered by Oxen and not wired:** flux-2-dev, flux-kontext-dev, flux-2-klein-4b; qwen-image-edit, -2511, -plus,
-max, qwen-image-2, -2-pro, -3-pro; bytedance-seedream-4, -4-5; muse-image-1-0; topazlabs-bloom-image,
-wonder-3-image; flux-image-upscaler (not Clarity); sam-3-image (a candidate backend for *select by text*); qwen-image,
-2512, flux-1-dev, xai-grok-imagine-image as an edit. No Oxen equivalent exists for FLUX.2 [max], FLUX.1 Fill, Reve,
Recraft, HY Image 3.5, the Magnific upscalers, SeedVR2, Clarity or Z-Image base.

**Only a real key can verify:** that `input_image` takes a data URL for a 1 to 4 MP crop on `/images/edit`, and at
what size a request fails; that `mask_url` takes one, and the mask conventions (white for GPT Image 2, transparent for
2.5); that `b64_json` works on both routes (else whether a result URL needs the key and how long it lives); that the
editors and upscalers take `/images/edit` (the model list says `/images/generate` for all); whether `auto` and
`match_input_image` keep the crop's shape, what shape Seedream 5.0 Lite answers, Qwen 3.0's "last image" rule; the
output sizes per tier, Bloom 2's factor, Wonder at 1x and 6x; the status and shape of the credits error, 401 and 429,
the rate limits; whether failed runs are billed and the charged prices against the list; where results and inputs are
kept in the account and how to delete them; whether a run goes past 300 s; in chat, data URLs, tool-call deltas, usage
in the stream, reasoning fields and which models take tools; the picture counts of Nano Banana 2 Lite and FLUX.2
klein; the key's format; whether `qwen-image-2-1` is the local recipe's model.

**Tests.** `node tools/oxen_test.js` (plain Node, a scripted fetch: the host and key rule, golden bodies of every
kind of variant, **every body of every shipped variant against its model's schema** in `tools/refs/oxen/` (every
enum value of every setting, 0 to the most references, seed on and off), the picture count, steepness and inline cap,
both mask conventions, tiers and aspects, answers by `b64_json` and by URL, the error words and the scrubbed key,
retries and the 5-minute limit, the upscalers, the wiring in `index.js`, the recipes, the upsampling rows through
`llm.js` and the assistant entry, and over the whole run that the key went only in `Authorization` toward the API).
The gate `oxen` (`tools/oxen_test.py` against `tools/oxen_mock.py`, which checks every body against the same schemas
and refuses a picture that is not a PNG or JPEG data URL) runs it first, then the app: the lists and the key row, an
instruction edit with the crop as a data URL, an alpha mask on GPT Image 2.5 Flare, Generate new on Nano Banana 2, an
upsampling row, and a real key never reaching the mock.
