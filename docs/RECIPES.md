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
Image, Black Forest Labs for FLUX; ToAPIs, fal.ai, Replicate, WaveSpeedAI and Comfy Cloud carry
most models as well. The order of a recipe's `providers` is the order of its provider select,
of Generate new and of `list_recipes`; ToAPIs comes first wherever it serves the model (see
"ToAPIs" below), and `default` stays the home provider.

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
take; ToAPIs' channels, sizes and tiers, below), `limits` (the size ceiling, below), `edit: false` (the variant makes images from
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

The ToAPIs variants of the three GPT recipes carry the row too (on GPT Image 2's standard channel and
on every GPT Image 2.5 channel only `transparent` is sent, as their pages ask); none of that has run
live. Other providers are not wired for it: fal, WaveSpeed and Comfy Cloud may or may not pass
`background` through to the same models, and none of that is verified. Add the row to a
variant when you have a source. `tools/transparent_test.py` is the gate.

### Generating without an image (`text`)

"Generate new" makes the base image from the prompt alone. Every variant therefore also has
a `text` shape, filled in by `normalize()` in `electron/main/recipes.js`: the model id is
the editing one with a trailing `/edit`, `/inpaint` or `/fill` removed (fal and WaveSpeed
put the editing model under such a path, the others use the same id without the image
field). A variant overrides it with `"text": { "model": "...", "sizes": [...], "fixed": {} }`
or switches it off with `"text": false`. Providers that can do it at all: ToAPIs, OpenAI, Gemini,
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

Adapters (`electron/main/providers/`): **toapis** (uploads, a task and polling; channels,
sizes and tiers from `options`; see "ToAPIs" below), **fal** (queue API, settings passed by name),
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
   503 waits `Retry-After`. `failed` arrives as HTTP 200 and is thrown as
   `ToAPIs <model> (task <id>): <error.message>`, which is what the status line and the log show.
4. `completed`: `result.data[0].url`, else a top-level `url`, downloaded at once (it lives 24 h) and
   **without** the key.

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
`transparent_only`, `max_images`), for edit and text runs alike. The default is the official channel
wherever one exists: the vendor's own cloud (Azure for GPT, Vertex AI for Gemini), the only mask
endpoint, plain string URLs. The docs never name the upstream of the normal and VIP channels; their
prices, far below the vendor's, suggest third-party backends.

| Recipe | Default model | Channel row | Input, size | Resolution |
|---|---|---|---|---|
| `gpt_image_2` | `gpt-image-2-official` | official, vip (`gpt-image-2-vip`, no mask), standard (`gpt-image-2`, no mask, presets, no quality) | **fill**: `mask_url` from the alpha mask; the crop's own ratio | `resolution` 1k / 2k / 4k |
| `gpt_image_2_5_flare`, `_sunburst` | `gpt-image-2.5-<name>-official` | official, vip (`-vip`), standard (plain id: presets, a 1K / 2K / 4K tier, no quality) | edit; `WxH` in 16 px steps, 655,360 to 8,294,400 px, at most 3:1 | none (pixels) |
| `nano_banana_2` | `gemini-3.1-flash-image-official` | official, vip (`-preview-vip`), standard (`-preview`); both with `{url}` objects | edit; the closest of the channel's presets | `metadata.resolution` 1K / 2K / 4K |
| `nano_banana_2_lite` | `gemini-3.1-flash-lite-image-official` | none | as 3.1 Flash official | as 3.1 Flash |
| `nano_banana_pro` | `gemini-3-pro-image-official` (the id of ToAPIs' price list) | official, vip, standard (`gemini-3-pro-image-preview[-vip]`, objects) | edit; presets | `metadata.resolution` 1K / 2K / 4K |
| `flux2_pro`, `flux2_flex` | `flux-2-pro`, `flux-2-flex` | none | edit, 8 images; 7 presets | `metadata.resolution` 1K / 2K |
| `seedream_5_lite` | `doubao-seedream-5-0` | none | edit, 10 images; 9 presets | `metadata.resolution` **2K / 3K** |
| `seedream_5_pro` | `doubao-seedream-5-0-pro` | none | edit; 9 presets | `metadata.resolution` 1K / 2K |
| `qwen_image_edit` | `qwen-image-3.0` | standard, pro (`qwen-image-3.0-pro`) | edit, 3 images; `WxH` (512² to 2048², at most 8:1), `metadata.seed`, `metadata.negative_prompt`, fixed `metadata.prompt_extend: false` | none (pixels) |

A variant's `options` describe the rest: `mask` (a `fill` run uploads `req.maskAlpha`, alpha 0 =
repaint, as `mask_url`; only `gpt-image-2-official` has one, every other channel leaves the mask out
and the stitch keeps the selection), `size` (`ratio`: the crop's reduced `W:H`, clamped to 3:1;
`preset`: the closest of `ratios`, or a text run's own aspect when it is one of them; `pixels`: `WxH`
under `pixels` rules), `tiers` with `tier_key` (a *Resolution* row left on auto takes the smallest tier
whose base covers the emitted long side), `urls: "objects"` (`image_urls` as `[{ url }]`), `images`
(another image field), `drop` (parameters a channel does not take), `transparent_only`, `max_images`
(more images are refused before any upload), `seed` and `negative` (where a model takes them).
Settings pass through by key and **dotted keys nest** (`metadata.resolution` becomes
`{ metadata: { resolution } }`); `channel`, `random_seed`, empty values and `auto` are not sent.
Crops of another shape than a model's presets come back re-framed and are centre-cropped by
`finishResult`, as with WaveSpeed.

**The 10 MB upload limit.** Measured on 2026-09-15 with `canvasBytes` (Chromium's PNG encoder) on
crops cut at full resolution from four photographs: 2048 × 2048 came to 5.9 to 9.5 MB, 3840 × 2160 to
11.9 to 18.7 MB, and random noise (the worst case) to 14.4 and 28.5 MB; as JPEG at quality 0.92 the
same crops were 0.7 to 1.7 MB, 1.3 to 3.1 MB and 3.7 / 7.3 MB. So every size check happens before any
request: a **crop** over 10 MB is re-encoded as JPEG (quality 92, Electron's `nativeImage`, `ctx.toJpeg`
from `providers/index.js`; a transparent crop loses its alpha there), and one still over it is refused
with "set Highres fix lower". A **reference** over 10 MB is refused (it may be a cut-out whose alpha a
JPEG would flatten), and so is a **mask** (its alpha is the mask). The limits stay at 2048 (FLUX at
BFL's 1440, GPT Image 2.5 and Qwen with a 4,194,304 px budget).

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
- whether uploads are accepted as `image/jpeg` for the crop fallback on every model (Seedream takes
  JPEG and PNG only, which both are).

**Tests.** `node tools/toapis_test.js` runs the adapter in plain Node against a scripted fetch (the
official fill with its alpha mask, the other channels, objects and nesting, text runs, pixel sizes,
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
