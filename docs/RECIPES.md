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
Image, Black Forest Labs for FLUX; fal.ai, Replicate and OpenRouter carry most models as
well, LetzAI has its own inpainting.

```
{
  "id": "flux2_max", "kind": "provider", "name": "FLUX.2 [max]", "family": "Black Forest Labs",
  "description": "...", "default": "bfl",
  "providers": {
    "bfl":        { "model": "flux-2-max", "input": "edit", "settings": [ ... ] },
    "fal":        { "model": "fal-ai/flux-2-max/edit", "input": "edit", "settings": [ ... ] },
    "replicate":  { "model": "black-forest-labs/flux-2-max", "input": "edit", "fields": { "images": "input_images" }, "fixed": { "output_format": "png" } },
    "openrouter": { "model": "black-forest-labs/flux.2-max", "input": "fill" }
  }
}
```

Variant fields: `model` (endpoint / model id), `input` (`fill`: crop + mask; `edit`:
instruction on the crop plus references), `settings` (Settings-panel controls, `key` is
the parameter the adapter sends), `fixed` (parameters sent as they are), `fields`
(input names: Replicate and fal, `{ image, images, mask }`), `options` (adapter switches:
fal `sizing: "none"` for endpoints without a free `image_size`), `note` (shown as the
tooltip). `family` groups the top-bar list. A recipe with a top-level `provider` instead
of `providers` (the old shape, the smoke test's loopback) is read as a one-provider recipe.

Adapters (`electron/main/providers/`): **fal** (queue API, settings passed by name),
**bfl** (`steps`, `guidance`, `safety_tolerance`, `prompt_upsampling`; the variant's
`model` is the endpoint), **openai** (`quality`, `size`, `input_fidelity` for 1.x / 2;
gpt-image-2 and 2.5 take any size in multiples of 16), **gemini** (`aspect_ratio`,
`image_size`; no mask input, the mask goes along as an image and the prompt names the
white area), **replicate** (settings by name, `model` is `owner/name` or
`owner/name:version`, files over 256 kB through the Files API), **openrouter** (unified
image API `/api/v1/images`, `resolution`, `quality`, `aspect_ratio`; no mask input, handled
like Gemini), **letz** (crop uploaded as a user asset, `/image-edits` mode `in` with the
mask, `resolution` 2k / 4k). Every adapter is written from the provider's documentation and
has not run against the live API yet; the recipe descriptions say so.
The key of the provider comes from the credential store (Settings › API providers).

What a provider run does: `prepareCrop` builds the crop like the node (selection bbox
plus context, fill mode, target_size scaling to the multiple, the grown and feathered
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
