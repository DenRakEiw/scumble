# Recipes

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
  "settings": [ { "index": 1, "node": "unet", "input": "unet_name", "label": "Model",
                  "spec": [["file.safetensors"], {}] } ],   // spec optional: /object_info wins when connected
  "models": { "diffusion_models": ["..."] },                // informational
  "prompt": { "<id>": { "class_type": "...", "inputs": { ... } }, ... }
}
```

`settings[]` are the editor's Settings-panel controls: `index` is the slot (1–8, the
node's `setting_n` outputs), `node`/`input` where the value goes. The control's type
comes from the server's `/object_info` when connected, else from `spec` (ComfyUI's
input spec format: `["INT", {default, min, max}]`, `[["a", "b"], {}]` for a combo).

### Presets

The Settings section starts with a **Preset** row when the recipe has two or more file
combos (inputs named `*_name` whose options are files: `unet_name`, `ckpt_name`,
`clip_name`, `vae_name`, `lora_name`). Save stores the current combination under a name
(`settings.recipePresets[recipeId] = [{ name, values: { "node:input": file } }]`),
picking a preset writes the files back into the controls, the select shows `(custom)`
while the current files match no preset. A file that is not on the server is skipped
with a note in the status line. Presets are per recipe id and shared by all documents.

### The local / api select

The recipe select in the top bar lists the recipes of one mode: ComfyUI recipes on the
`result_local` chain under *local*, provider recipes (and ComfyUI recipes with `mode:
"api"`) under *api*. The editor's local / api select next to Generate switches between
the two groups and picks the recipe last used in that mode (`settings.recipeByMode`).

### Import

Settings › Recipes › Import workflow (or File › Import Workflow as Recipe) reads

- a workflow saved from the ComfyUI UI (`nodes` / `links`, subgraphs included):
  needs a connected ComfyUI for the widget order of every node type. Subgraphs are
  flattened the way ComfyUI executes them (inner ids `instance:inner`), reroutes and
  primitives are followed, muted nodes dropped, bypassed nodes passed through.
- an API-format prompt (Export (API) in ComfyUI, or a prompt the node queued): the
  `result_source[_local]` inputs of the canvas node give the result wiring, inputs
  linked to `setting_n` outputs become settings.
- a Scumble recipe file.

The result input that is wired decides the mode (`result_local` wins when both are).
Setting outputs keep the value the target widget had. The import goes to the user
folder and is selected right away; Remove deletes it, Use selects it.

## Provider recipes (`kind: "provider"`)

One call to an API provider; crop and stitch happen in the app
(`renderer/editor/stitch.js`, a port of the node's `run` / `stitch`), no ComfyUI needed.
A provider recipe is **one model** with one variant per provider that hosts it; the user
picks the provider in Settings › Recipes (a select per row, remembered in
`settings.recipeProviders`) or through `select_recipe(id, provider)`. The home provider
(`default`) is the model's own API: Google for the Nano Banana family, OpenAI for GPT
Image, Black Forest Labs for FLUX; fal.ai, Replicate, WaveSpeedAI and Comfy Cloud carry most
models as well.

```
{
  "id": "flux2_max", "kind": "provider", "name": "FLUX.2 [max]", "family": "Black Forest Labs",
  "description": "...", "default": "bfl",
  "providers": {
    "bfl":        { "model": "flux-2-max", "input": "edit", "settings": [ ... ] },
    "fal":        { "model": "fal-ai/flux-2-max/edit", "input": "edit", "settings": [ ... ] },
    "replicate":  { "model": "black-forest-labs/flux-2-max", "input": "edit", "fields": { "images": "input_images" }, "fixed": { "output_format": "png" } },
    "wavespeed":  { "model": "wavespeed-ai/flux-2-max/edit", "input": "edit" },
    "comfycloud": { "model": "Flux.2 [max]", "input": "edit", "options": { "node": "Flux2ImageNode" } }
  }
}
```

Variant fields: `model` (endpoint / model id), `input` (`fill`: crop + mask; `edit`:
instruction on the crop plus references), `settings` (Settings-panel controls, `key` is
the parameter the adapter sends), `fixed` (parameters sent as they are), `fields`
(input names: Replicate and fal, `{ image, images, mask }`; fal takes `"mask": false` for
an image-to-image endpoint that has no mask, such as Ideogram 4), `options` (adapter
switches: fal `sizing: "none"` for endpoints without a free `image_size`, fal
`omit: ["output_format", ...]` for an endpoint that refuses the fields the other models
take), `limits` (the size ceiling, below), `edit: false` (the variant makes images from
the prompt alone and the Generate button says so), `note` (shown as the tooltip). `family`
groups the top-bar list. A recipe with a top-level `provider` instead of `providers` (the
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
for both). Without either, the conservative
`{ min: 256, max: 2048, step: 16, pixels: 0, minPixels: 0 }` applies - raise one with a
source, not with a guess. Today: **FLUX.2 and FLUX.1 Fill 1440** (2048 answers with an
error), **GPT Image 2.5 Flare and Sunburst 3840 with an 8,294,400 px budget and a 655,360 px
floor** (the model's own size rules: both edges a multiple of 16, at most 3840 an edge, a
ratio no steeper than 3:1), **GPT Image 2 2048 with the same budget** (the size rules of the
OpenAI partner node), **Seedream 5 on fal 4096 with a 4 MP budget for pro and a 16 MP one
for lite** (its `image_size` is a free size with an area range, not a side limit),
**Seedream on Comfy Cloud 2496 / 4992** (what the partner node fits it into), everything
else the conservative default.

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

Other providers are not wired for it: fal, WaveSpeed and Comfy Cloud may or may not pass
`background` through to the same models, and none of that is verified. Add the row to a
variant when you have a source. `tools/transparent_test.py` is the gate.

### Generating without an image (`text`)

"Generate new" makes the base image from the prompt alone. Every variant therefore also has
a `text` shape, filled in by `normalize()` in `electron/main/recipes.js`: the model id is
the editing one with a trailing `/edit`, `/inpaint` or `/fill` removed (fal and WaveSpeed
put the editing model under such a path, the others use the same id without the image
field). A variant overrides it with `"text": { "model": "...", "sizes": [...], "fixed": {} }`
or switches it off with `"text": false`. Providers that can do it at all: OpenAI, Gemini,
BFL, fal, Replicate, WaveSpeed. Comfy Cloud builds a graph around a partner node and has
none. The other way round exists too: a variant with `"edit": false` has **only** the text
shape (Krea 2, Recraft V4 and Z-Image base are text-to-image endpoints), and the Generate
button answers that the recipe belongs in "Generate new".

The run goes through `host.runGenerate()` with `kind: "text"`: no crop, no mask, no
references, only prompt, size, aspect and seed. The adapter's `generate()` picks the right
call (OpenAI switches from `images/edits` to `images/generations`, the others send the same
body without the image field). The answer replaces the document's base image through
`editor.setBaseFromCanvas()`. **The size is a request**: a model answers with the shape it
supports, and the document takes whatever comes back.

For a ComfyUI recipe there is nothing to declare. The local path renders a flat canvas of
the wanted size through the recipe and flattens the result into the base, which is what
`generate_new` does; a chain that starts its sampler from an empty latent (the Flux.2 Klein
recipe does) then ignores the flat input entirely.

Adapters (`electron/main/providers/`): **fal** (queue API, settings passed by name),
**bfl** (`steps`, `guidance`, `safety_tolerance`, `prompt_upsampling`; the variant's
`model` is the endpoint), **openai** (`quality`, `size`, `background`,
`output_format`, `output_compression`, `moderation`, and `input_fidelity` on 1.5 and 1
only - gpt-image-2 always works at high fidelity and the docs say to omit it; `sizeFor()`
holds a free size inside each model's own rules), **gemini** (`aspect_ratio`,
`image_size`; no mask input, the mask goes along as an image and the prompt names the
white area), **replicate** (settings by name, `model` is `owner/name` or
`owner/name:version`, files over 256 kB through the Files API), **wavespeed** (`POST
/api/v3/<model>`, poll `predictions/<id>/result`; inputs are URLs only, so crop, mask and
references go through the media upload first; `options.aspect_ratios` picks the preset
closest to the crop, `options.size = "star"` sends `W*H` for the fill models; the key link
carries the WaveSpeed referral code), **comfycloud** (Comfy Cloud API with `X-API-Key`:
the adapter builds a workflow from LoadImage, one Partner Node named in `options.node`
(`OpenAIGPTImageNodeV2`, `GeminiNanoBanana2V2`, `GeminiImage2Node`, `GeminiImageNode`,
`ByteDanceSeedreamNodeV3`, `Flux2ImageNode`, `FluxProFillNode`, `QwenImageEditApi`) and
SaveImage, submits it to `/api/prompt`, polls `/api/job/<id>/status`, reads the image from
`/api/history/<id>` and `/api/view`; settings keys are the node's full input keys, dotted
for the model combos such as `model.quality`; needs a paid plan). Every adapter is written from the provider's documentation and
has not run against the live API yet; the recipe descriptions say so.
The key of the provider comes from the credential store (Settings › API providers).

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
