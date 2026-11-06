# lora_ecosystem

## Summary

ComfyUI on 8188 was not running on 2026-11-06 (connection refused), so I read the user's v0.42.4 source and LoRA folder directly.

What decides the design:

1. **Local LoRAs are a model-only chain.** Every LoRA for Qwen, Klein, FLUX 3, Z-Image and MOSS that I sampled (13 files, the user's and Hugging Face ones) changes the diffusion model only and has no text-encoder keys. Comfy's own templates use `LoraLoaderModelOnly`. SDXL is the exception: its LoRAs carry CLIP keys, so they need `LoraLoader` with `strength_clip`. Core also has `LoadLoraModel`, a stack of 1-20 rows; in API format each row is `loras.<i>.lora_name`, `loras.<i>.strength`, `loras.<i>.enabled`. Its docstring calls that row format "Internal, unstable".
2. **ComfyUI never refuses a wrong LoRA.** Keys it cannot map only log "lora key not loaded", and a wrong shape only logs "ERROR". The run then finishes as if no LoRA were loaded. A LoRA for Qwen Edit 2509/2511 does nothing on Qwen Image 2.1, which has a different block layout. A 9B LoRA does nothing on Klein 4B. So Scumble has to check compatibility itself, for example by reading the safetensors header.
3. **`lora_name` must match the server's list exactly.** Windows paths come back with backslashes. The list comes from `/models/loras` or `/object_info/LoraLoaderModelOnly`.
4. **MOSS-Image edit is a LoRA plus a new node.** It is `moss_image_edit_lora_rank_64_bf16` with `TextEncodeMOSSImageEdit`, and both need ComfyUI v0.43.0 or newer. The user runs v0.42.4, which lacks the node and cannot load that LoRA's bare key names. Comfy Cloud already has the node and the LoRA in its catalog.
5. **The API side is uniform on fal.** fal takes `loras:[{path, scale}]` with at most 3 LoRAs, scale 0-4, as sibling `/lora` endpoints. That covers Qwen Edit (original, 2509, 2511), Klein 4B/9B edit, FLUX.2 dev edit, Kontext, Z-Image (incl. inpaint) and MOSS text-to-image. fal has nothing for Qwen 2.1 or FLUX 3 Klein. Replicate uses a different field name per model. WaveSpeed allows 3 LoRAs on its Qwen and Klein edit endpoints. Comfy Cloud imports LoRAs only from a Civitai or Hugging Face URL, on the Creator plan or higher, and its node list does not show those imports.

## Report

# LoRAs for Scumble's model families: ComfyUI core, API providers, where LoRAs come from, and traps

Confidence marks: **read** = I saw it in the file, page or API answer; **inferred** = follows from what I read; **unverified** = from a secondary source or not checked. Dates are when I read them (2026-11-06) unless stated.

Issues: #10 hwatik, opened 2026-10-24T17:46Z; #11 nadergits, "add moss image edit", opened 2026-10-31T23:10Z. Both are open and the owner has answered each once (`gh issue view`, read).

ComfyUI on 127.0.0.1:8188 refused the connection (curl exit 7), so I made no `/object_info` or `/models/loras` read (**read**). Everything about the local server comes from its files under `F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI` (v0.42.4).

---

## 1. ComfyUI core LoRA nodes (v0.42.4)

| Node (class) | Display name | Inputs | Outputs | Source |
|---|---|---|---|---|
| `LoraLoader` | "Load LoRA (Model and CLIP)" | `model` MODEL, `clip` CLIP, `lora_name` combo, `strength_model` FLOAT and `strength_clip` FLOAT (default 1.0, min -100, max 100, step 0.01) | MODEL, CLIP | `nodes.py:714-759`, `:2156` (**read**) |
| `LoraLoaderModelOnly` | "Load LoRA" | `model`, `lora_name`, `strength_model` (same range) | MODEL | `nodes.py:761-774`, `:2157` (**read**) |
| `LoadLoraModel` | "Load LoRA (Model)" | `model` plus a dynamic group `loras` of 1-20 rows; each row has `lora_name`, `strength` (-100..100) and `enabled` | MODEL | `comfy_extras/nodes_lora_stack.py` (**read**); added 2026-10-09 in commit 926d828e3, PR #16309 (`gh api`, **read**) |
| `LoadLoraTextEncoder` | "Load LoRA (Text Encoder)" | `clip` plus the same `loras` group | CLIP | same file (**read**) |
| `LoraLoaderBypass` / `...ModelOnly` | "(For debugging)" | – | – | `comfy_extras/nodes_lora_debug.py:6,57,77` (**read**) |

- **Chaining is the normal way.** Both loader descriptions say "Multiple LoRA nodes can be linked together." (`nodes.py:737`, **read**). A LoRA whose strengths are both 0 is skipped (`nodes.py:741`, **read**).
- **How the stack node looks in an API prompt.** Fields go in as `<group>.<index>.<field>`, for example `loras.0.lora_name`, `loras.0.strength`, `loras.0.enabled`. The docstring calls this an "Internal, unstable widget template" (`comfy_api/latest/_io.py:1337-1354`, **read**). Scumble recipes already send dotted input names such as `images.image_1` to `TextEncodeQwenImage21` (`recipes/qwen_image_edit_2_1_local.json`, **read**). A plain chain of `LoraLoaderModelOnly` nodes is the stable choice (**inferred**).
- **How `lora_name` is listed.**
  - The list is `folder_paths.get_filename_list("loras")` (`nodes.py:726,765`). The folder is `models/loras` plus any `extra_model_paths` entries (`folder_paths.py:28`, **read**).
  - Files are found by walking every subfolder, following links, and keeping the path relative to the folder via `os.path.relpath` (`folder_paths.py:404-443`). Only model-file extensions are kept (`:445-446`, **read**).
  - On Windows those relative paths use backslashes, e.g. `qwen\Qwen-Edit-Relight.safetensors` (**inferred** from `os.path.relpath`).
  - Validation is an exact string match. A wrong value gives `value_not_in_list` (`execution.py:1060-1090`, **read**). Loading itself tolerates either separator (`folder_paths.py:459`, **read**), but validation runs first.
  - The list is cached and kept per folder modification time, so a newly added LoRA shows up without a restart (**inferred** from the `dirs` mtime map, `folder_paths.py:412-441`).
- **Endpoints.** `GET /models` lists the folder types and `GET /models/loras` returns the same list as the node's combo (`server.py:407-419`, **read**). `/object_info/LoraLoaderModelOnly` carries the same list as the `lora_name` combo (**inferred**).
- **The user's LoRA folder (names only).**
  - 1,201 `.safetensors` files, mostly SDXL and FLUX.1, in subfolders including `flux/`, `flux_2/`, `Flux_3/`, `klein/`, `kontext/`, `qwen/`, `z_image/`, `ideogram/`, `wan/` and `ltx/` (**read**).
  - Family folders: `qwen/` 27 files (including `Qwen-Edit-Relight`, `Qwen-Image-Edit-2509-Lightning-4/8steps-V1.0-fp32`, `Qwen-Image-Lightning-*`), `klein/` 25, `Flux_3/` 4 (the user's own, e.g. `Flux3_Targa`), `z_image/` 3, `flux_2/` 2, `ideogram/` 1 (**read**).
  - One Klein LoRA sits in `kontext/` (`lucma_flux_klein_9b`), so folder names are not a reliable way to tell the family (**read**).
- **A related finding about the shipped relight recipe.** `recipes/relight_qwen_local.json:95-110` hard-codes `lora_name` values at the folder root (`Qwen-Image-Edit-2509-Relight.safetensors`, `...Lightning-4steps-V1.0-bf16`). Only `strength_model` is a Settings row (`:30`, **read**). On this machine the matching files are named `qwen/Qwen-Edit-Relight.safetensors` and `...-fp32`, so the recipe would fail validation here unless the user renames or moves them (**inferred**).

## 2. Which LoRA key formats load, per family (`comfy/lora.py`, v0.42.4)

General path:

- `load_lora_for_models` builds a key map from the model (and from the CLIP model when one is given), runs `convert_lora`, then patches (`comfy/sd.py:108-140`, **read**).
- Accepted pair names (`weight_adapter/lora.py:160-196`, **read**):
  - `.lora_up/.lora_down` (kohya)
  - `_lora.up/down`
  - `.lora_B/.lora_A` (PEFT/diffusers)
  - `.lora.up/down`
  - bare `.lora_B/.lora_A` without `.weight`
  - `.lora_linear_layer.up/down`
  - `.lora_B.default.weight` (the ModelScope/DiffSynth "qwen default" format)
- Also accepted: LoHa, LoKr, GLoRA, OFT, BOFT (`weight_adapter/`), and `.diff`, `.diff_b`, `.set_weight` (`lora.py:64-92`, **read**).
- Generic names that work for any model: `diffusion_model.<module>`, `lora_unet_<module_with_underscores>`, and `text_encoders.<key>` on the CLIP side (`lora.py:200-207, 111`, **read**).

**Failures do not stop a run.**
- Keys nobody maps only log `lora key not loaded: ...` (`lora.py:99-102`, **read**).
- A patch that throws, such as a shape mismatch, logs `ERROR <adapter> <key> <exception>` and keeps the original weight (`weight_adapter/lora.py:284-285`, **read**).
- The prompt still completes. A LoRA for the wrong base model gives the plain model's picture, and only the ComfyUI console says why (**inferred**).

| Family | ComfyUI class | Extra key maps | Notes |
|---|---|---|---|
| Qwen Image / Edit (original, 2509, 2511) | `QwenImage` | bare `transformer_blocks.N...`, `transformer.` prefix, `lycoris_` (`lora.py:335-348`) | 2511 differs only by the marker key `__index_timestep_zero__` (`model_detection.py:1008-1010`, **read**). So 2509 LoRAs load on 2511; how well they work there is **unverified**. The user's `Qwen-Edit-Relight` is in the `lora_A.default` format with bare keys, and the Lightning LoRA uses `lora_down/up` + `alpha` (headers **read**). |
| Qwen Image 2.1 (Scumble's "Qwen Image Edit 2.1" recipes) | `QwenImage21` (subclass of `QwenImage`) | the same maps, plus `img_mlp.gate_up` split back into `gate_layer` / `proj` slices (`lora.py:340-342`) | **A different architecture**: single-stream attention `attn.to_q/to_k/to_v/to_out.0`, gated MLP, `txt_in.text_norm`, `modulation` (`ldm/qwen_image21/model.py:57-78`, `model_detection.py:985-1004`, **read**). 2509/2511 LoRAs, keyed `attn.add_k_proj` etc., match nothing here and silently do nothing (**inferred**). 2.1 LoRAs exist: lightx2v Lightning in `transformer.` + `lora.down/up` format, A20labs (ModelScope) in `lora_A.default` format, Comfy-Org's turbo LoRA in `diffusion_model.` + kohya + `diff` format (headers **read**). |
| FLUX.2 Klein 4B/9B, FLUX.2 dev | `Flux2` (subclass of `Flux`, `model_base.py:1091`) | diffusers `transformer.`, `lycoris_`, `lora_transformer_`, DiffSynth bare names, `linear1_qkv` slices (`lora.py:276-288`) | The user's Klein and FLUX.2 LoRAs are ai-toolkit `diffusion_model.double_blocks...` with `lora_A/B` and rank 32/48 (**read**). 4B and 9B differ in width, so a LoRA for one does not apply to the other (**inferred**). |
| FLUX 3 Image (Klein) | `Flux3` | separate `q_proj/k_proj/v_proj` mapped onto the fused `qkv` file (`lora.py:350-357`) | The user's `Flux3_Targa` is ai-toolkit 0.13.26, keyed `diffusion_model.content_mode_blocks.image.N.k_proj`, metadata `ss_base_model_version = flux3` (**read**). |
| MOSS-Image | `MOSSImage` | v0.42.4 maps only q/k/v slices onto the fused `proj.qkv`, plus the generic `diffusion_model.` and `lora_unet_` names (`lora.py:359-366`) | Upstream PR #17296 (60aade0bb, 2026-10-22) added **bare** module paths such as `layers.N.proj.q` (master `lora.py:359-369`, **read**). v0.42.4 has diverged from that commit and v0.43.0 (2026-10-27) contains it (`gh api compare`, **read**). Neither version maps a diffusers `transformer.` prefix (**inferred**). The axiomofmind MOSS LoRA's metadata says it was converted "transformer. -> diffusion_model." for ComfyUI (**read**). The kohya-style `lora_unet_layers_0_proj_q` (ACCC1380) loads in both (**inferred**). Control adapters go through `convert_moss_control_lora` (`lora_convert.py:36-52`, **read**). |
| Z-Image (Turbo / Base) | `Lumina2` | `z_image_to_diffusers`: `diffusion_model.`, `transformer.`, `lycoris_` and bare names (`lora.py:379-388`) | The user's Z-Image LoRAs are ai-toolkit `diffusion_model.layers.N.attention.to_k` with `lora_A/B` (**read**). |
| SDXL (inpaint) | `SDXL` | UNet-to-diffusers maps; CLIP via `lora_te1_*` / `lora_te2_*` (`lora.py:120-155, 209-222`) | Scumble ships no SDXL recipe (grep of `recipes/`, **read**). |

**Quantised models.** Scumble's local recipes use `*_int8_convrot` diffusion models (`recipes/*_local.json`, **read**). ComfyUI applies LoRA patches in the compute dtype when it casts a quantised weight (`comfy/ops.py:1493`, `want_requant=True` at `:911`, **read**). Comfy's own MOSS edit template runs `moss_image_sft_int8_convrot` with a LoRA (**read**, below), so LoRAs on int8_convrot work at least there (**inferred**).

## 3. Model-only or text-encoder strength?

- **DiT families (Qwen, Qwen 2.1, Klein, FLUX 3, Z-Image, MOSS): model-only is enough in practice.** All 13 DiT LoRAs I opened had 0 text-encoder keys: the user's 9 and Hugging Face's MOSS and Qwen 2.1 ones (headers via `st_header.py`, **read**). ComfyUI could map text-encoder keys (`text_encoders.<key>`, and kohya `lora_te_` for single-encoder models at `lora.py:111-115, 176-182`, **read**), but the trainers these files came from (ai-toolkit, SimpleTuner, DiffSynth/ModelScope, LoRA-Forge) wrote none. Comfy's templates use `LoraLoaderModelOnly` for these families: Scumble's own `relight.json`, `cloud_qwen_image_edit_2509.json`, `cloud_flux2_dev.json`, `cloud_krea_2_turbo.json`, and the MOSS edit template (**read**).
- **SDXL: the text-encoder part matters.** The user's `add-detail-xl` and `Bangerooo_Art_Style_SDXL` each have 792 of 2,958 keys on `lora_te1_*` (**read**). Under `LoraLoaderModelOnly` those keys go unused, so trigger words learned in the text encoder are weaker (**inferred**). An SDXL recipe needs `LoraLoader` with `strength_clip`.
- **Where to put the chain.** Between `UNETLoader` and the next MODEL consumer: `QwenImage21Cache` in the Qwen 2.1 recipes, `SkipLayerGuidanceDiTSimple` in MOSS, `ModelSamplingAuraFlow` in relight (**inferred** from the recipe graphs, **read**). `QwenImage21`'s prefix key/value cache is switched off only when hooks are present (`model_base.py:2717-2724`, **read**). A plain LoRA loader patches weights, not hooks, so the cache stays on (**inferred**).

## 4. MOSS-Image edit (issue #11)

- **What exists.**
  - Comfy-Org/MOSS-Image ships `loras/moss_image_edit_lora_rank_64_bf16.safetensors`, added 2026-10-26, from chinoll/Moss-Image-Edit. It also ships `loras/moss_image_color_depth_control.safetensors` (from darask0) (https://huggingface.co/Comfy-Org/MOSS-Image README and commits, **read**).
  - The edit LoRA has 504 keys, bare names `layers.N.proj.{q,k,v,o,ffn_up_gate,ffn_down}.lora_A/B`, metadata `format: moss-edit-lora` (header, **read**). It therefore needs the bare-path map from v0.43.0 (**inferred**).
- **The node.** `TextEncodeMOSSImageEdit` was added by 60aade0bb and extended by 9fe7ef764 on 2026-10-23 (`gh api`, **read**). Inputs:
  - `clip`, `prompt`
  - `vae`, optional (without it the images go only to the text encoder)
  - `edit_format`: `ai-toolkit`, `ai-toolkit (kv_cache off)` or `Moss-Image-Edit`
  - `images` autogrow: `images.image_0` … `images.image_9`, 1-10 slots
  - `image_strength`: 0-100, default 1
  - Output: CONDITIONING. Use it for the negative prompt too.
  - Source: Comfy Cloud's live node spec through `get_node`, catalog refreshed 2026-11-06T00:05Z (**read**).
  - **Not in v0.42.4**: the local `comfy_extras/nodes_moss_image.py` has only `MOSSImageLayoutPrompt` and `MOSSImageControl` (**read**). ComfyUI v0.43.0 (2026-10-27) and v0.44.0 (2026-11-04) are out (`gh api releases`, **read**).
- **Comfy's template** `image_moss_image_edit.json` (Comfy-Org/workflow_templates, **read**):
  - `UNETLoader moss_image_sft_int8_convrot` → `LoraLoaderModelOnly moss_image_edit_lora_rank_64_bf16` at strength 1 → `SkipLayerGuidanceDiTSimple` (single layer 22) → `KSampler` (30 steps, cfg 4, euler, normal).
  - `TextEncodeMOSSImageEdit` with `edit_format = Moss-Image-Edit` for both the positive and the negative prompt.
  - `ImageScaleToTotalPixels` 1 MP, `EmptyFlux2LatentImage`, `CLIPLoader qwen3.5_9b_w4a8_gptq` (type `moss_image`), `flux2-vae_small`.
- **Elsewhere.**
  - Comfy Cloud's catalog lists `moss_image_edit_lora_rank_64_bf16`, `moss_image_color_depth_control`, `moss_image_sft_lora_blocks_21_to_49_rank_512_bf16`, plus MOSS turbo and deband diffusion models (`search_models`, **read**).
  - But Cloud's live `LoraLoaderModelOnly.lora_name` combo did not list any `moss_*` LoRA on 2026-11-06 (`get_node`, **read**). Do not refuse a Cloud run because a name is missing from that combo; Scumble's `docs/RECIPES.md:417-420` already says so.
  - fal has `fal-ai/moss-image/lora`, text to image only, `loras` maxItems 3, scale 0-4; `fal-ai/moss-image/edit` is a 404 (fal OpenAPI, **read**).
  - fal also has `fal-ai/moss-image-trainer` (`model`: base or sft, steps 10-40,000) (**read**).

## 5. API providers that take LoRAs (exact fields)

### fal

All rows read from `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>` on 2026-11-06. Each LoRA entry is `{path: string (required), scale: number default 1, min 0, max 4}`.

| Endpoint | Images | LoRA limit (from the description) | `path` accepts |
|---|---|---|---|
| `fal-ai/qwen-image-edit-lora` (original Edit) | `image_url` (one) | "up to 3" | "URL or the path" |
| `fal-ai/qwen-image-edit-plus-lora` (2509) | `image_urls` | up to 3 | URL |
| `fal-ai/qwen-image-edit-2511/lora` | `image_urls` | up to 3 | URL |
| `fal-ai/flux-2/klein/{4b,9b}/edit/lora` (distilled, 4-8 steps), `.../{4b,9b}/base/edit/lora` (4-50 steps, cfg, negative prompt) | `image_urls` | "maximum 3" | "URL, HuggingFace repo ID (owner/repo), or local path" |
| `fal-ai/flux-2/klein/9b/lora`, `.../9b/base/lora` (text to image) | – | max 3 | same |
| `fal-ai/flux-2/lora/edit` (FLUX.2 dev) | `image_urls`, maxItems 4 | max 3 | same |
| `fal-ai/flux-kontext-lora` | `image_url` | "any number" | URL |
| `fal-ai/z-image/turbo/lora`, `/turbo/image-to-image/lora`, `/turbo/inpaint/lora` (`mask_image_url`), `fal-ai/z-image/base/lora` | per endpoint | max 3 | URL / HF |
| `fal-ai/moss-image/lora` (text to image) | – | maxItems 3 | URL |
| `fal-ai/flux-lora-fill`, `fal-ai/flux-lora/inpainting` (FLUX.1) | image + mask | any | URL |
| `fal-ai/fast-sdxl/inpainting` | image + mask | – | URL or HF name; **scale max 1**; also `embeddings` |
| `fal-ai/lora/inpaint` (any SD/SDXL `model_name`) | image + mask | – | URL |

No `loras` field: `fal-ai/qwen-image-2.1`, `fal-ai/qwen-image-2.1/edit` (up to 10 images), `fal-ai/qwen-image-edit-2511`, `fal-ai/qwen-image-edit/inpaint` (the endpoint Scumble's recipe uses, `recipes/qwen_image_edit.json:68`). No FLUX 3 Klein endpoint was found: all four ids I guessed were 404 (**read**). The Qwen and Klein LoRA endpoints have no mask input, so Scumble's own crop and composite step does the inpaint (**inferred**). fal's FLUX.2 trainer has an `output_lora_format` of `fal` or `comfy` (lora-atelier page, **unverified**).

### Replicate

Read from `https://replicate.com/<model>/api/schema` on 2026-11-06.

| Model | LoRA fields | Images |
|---|---|---|
| `qwen/qwen-image-edit-plus-lora` (2509) | `lora_weights`: string, an HF slug `owner/model` or a `.safetensors`/zip/tar URL; `lora_scale` 0-4, default 1 (one LoRA) | `image` array |
| `qwen/qwen-image-edit-2511` | same `lora_weights` / `lora_scale` (slug or `.safetensors` URL) | `image` array |
| `replicate/qwen-image-2.1-lora` | `lora` + `lora_scale` (-3..3), `lora_2` + `lora_2_scale`; "SimpleTuner LoRA safetensors URL" | `image` + `reference_images` (up to 10 total); `use_kv_cache` |
| `black-forest-labs/flux-2-klein-9b-base-lora` (and a 4B one) | `lora_weights`: array of URLs, "ComfyUI and native Flux Klein format … automatically converted"; `lora_scales`: array | `images` max 5 |
| `black-forest-labs/flux-kontext-dev-lora` | `lora_weights` string, `lora_strength` | `input_image` |
| `prunaai/z-image-turbo-lora` | `lora_weights` array (`.safetensors`/tar/zip URLs), `lora_scales` array | text only |

### WaveSpeed

Read from the docs pages on 2026-11-06. Base URL `https://api.wavespeed.ai/api/v3/`; LoRA entries are `loras[] {path, scale}`.

- `wavespeed-ai/qwen-image/edit-plus-lora`: `images` 0-3, `loras` 0-3, scale 0-4 default 1 (https://wavespeed.ai/docs/docs-api/wavespeed-ai/qwen-image-edit-plus-lora).
- `wavespeed-ai/qwen-image/edit-2511-lora`: images 3, loras 3; the scale table says 0-4 but the text on the same page says 0-2 (https://wavespeed.ai/docs/docs-api/qwen-image-edit-2511-lora).
- `wavespeed-ai/flux-2-klein-9b/edit-lora`: images 3, loras 3, scale 0-4, size 256-2048. There is also `flux-2-klein-base-9b/edit-lora` (https://wavespeed.ai/docs/docs-api/wavespeed-ai/flux-2-klein-9b-edit-lora).
- Path formats: an HF `owner/name` or a URL; Civitai only as a direct file URL; `.safetensors` only; "must match base model exactly" (https://wavespeed.ai/docs/lora-training-usage).

### Comfy Cloud

- **Imports.** Creator plan or higher; sources are **Civitai and Hugging Face only** (no local upload); `.safetensors` only; up to 100 GB; you pick the target folder (`loras`); private to the account; private repositories work with a token stored under Secrets (https://docs.comfy.org/cloud/import-models, **read**). The docs do not say whether imports appear in node dropdowns (**read**).
- **What Scumble already found.** Cloud resolves a loader's value through the account's own models, which its node list does not name (`docs/RECIPES.md:417-420`, **read**). The user's account has no imported LoRAs today (`search_models owned:true type:lora` → 0, **read**).
- **What Cloud already lists.** Core LoRA nodes plus `LoadLoraModel` and `TextEncodeMOSSImageEdit`. A large shared LoRA catalog (2,373 models in all) with many Qwen-Edit-2509/2511 LoRAs, including 2511 Lightning, AnyLight, Object-Remover, `Qwen-Image-Edit-2509-Relight`; Qwen 2.1 (`Qwen2.1_Anime_consistency`, `qwen-image-2.1-fix-1.0-comfy`); Klein 4B/9B; Z-Image (incl. `z_image_turbo_distill_patch_lora_bf16`); and MOSS (above) (`get_node` and `search_models`, **read**).

## 6. Where users get LoRAs, and the traps

- **Civitai base-model filter values that return results** (API `types=LORA&baseModels=`, **read**): `Qwen` (a single value covering Qwen Image and Edit 2509/2511; `Qwen Edit` and `Qwen 2511` return nothing), `Qwen 2.1`, `MOSS Image`, `Flux.2 Klein 9B`, `Flux.2 Klein 9B-base`, `Flux.2 Klein 4B`, `Flux.2 D`, `Flux.3`, `Flux.3 Klein`, `ZImageTurbo`, `ZImageBase`, `Flux.1 Kontext`, `SDXL 1.0`, `Pony`.
  - Download links have the form `https://civitai.com/api/download/models/<versionId>` and answer with a 307 to signed storage (**read**). Whether a provider follows that redirect or needs a token is **unverified**.
  - The 2.1 LoRAs I sampled list no trigger words (`trainedWords` empty, **read**).
- **Hugging Face.** Look for repos tagged `base_model:adapter:<base>`, e.g. `OpenMOSS-Team/MOSS-Image-Base` or `Qwen/Qwen-Image-2.1` (**read**). Comfy-Org repositories ship ComfyUI-ready LoRAs, e.g. Qwen-Image-2.1 `loras/` with a turbo LoRA and step LoRAs (**read**).
- **Traps:**
  1. **Wrong base model fails silently** (section 2). Qwen Edit 2509/2511 LoRAs do nothing on Qwen 2.1, and Klein 9B LoRAs do nothing on 4B (**inferred**). Distilled and base Klein share a transformer, and Black Forest Labs' blog says LoRAs trained on base usually work better on distilled (https://huggingface.co/blog/black-forest-labs/flux-2-klein-lora, **unverified**).
  2. **2509 vs 2511.** Same architecture, so they load (**inferred**). 2511 builds in popular community LoRA effects such as lighting (Gigazine, **unverified**). Lightning LoRAs are per version: Cloud lists separate 2509 and 2511 Lightning files (**read**).
  3. **Z-Image Turbo LoRAs.** Training directly on Turbo erodes its step distillation; ostris' training adapter is the fix, and DistillPatch is the inference-time fix (lilting.ch and RunComfy guides, **unverified**).
  4. **Trigger words** live in model cards or metadata; e.g. the relight LoRA needs `重新照明` (`recipes/relight_qwen_local.json:5`, **read**). Metadata cannot be trusted: the user's Qwen LoRA `anna_qwen` says `ss_base_model_version = sd_1.5` (ai-toolkit 0.4.0, **read**). Detecting the family from key names is more reliable (**inferred**).
  5. **MOSS formats.** The diffusers `transformer.` prefix does not load in ComfyUI; bare keys need v0.43.0 or newer (section 2). Edit LoRAs also need the matching `edit_format` (section 4).
  6. **Exact `lora_name` strings** with Windows backslashes (section 1).
  7. **Strength limits differ.** ComfyUI accepts -100..100; fal and WaveSpeed 0-4 (WaveSpeed's 2511 docs say 0-2 in one place); fal fast-sdxl 0-1; Replicate's Qwen 2.1 model -3..3 (**read**).

Scratch files (my own, no third-party code was run): `C:/Users/SCHOEN~1/AppData/Local/Temp/claude/F--canvas/543d44fb-4d2d-4818-8804-974916d10a44/scratchpad/iss_lora_ecosystem/` holds `fal/`, `fal2/` and `fal3/` (OpenAPI JSON), `rep/` (Replicate schema pages), `tpl/image_moss_image_edit.json`, `lora_master.py` (ComfyUI master `comfy/lora.py`), and `scripts/st_header.py`, `fal_schema.py`, `rep_schema.py`.

## Facts

- [read] ComfyUI on 127.0.0.1:8188 was not running on 2026-11-06 (curl connection refused), so no /object_info or /models/loras read was made. (curl http://127.0.0.1:8188/system_stats -> 000, exit 7)
- [read] LoraLoader takes model, clip, lora_name, strength_model and strength_clip (FLOAT, default 1.0, range -100..100, step 0.01) and returns MODEL and CLIP; LoraLoaderModelOnly takes model, lora_name, strength_model and returns MODEL; both descriptions say multiple LoRA nodes can be linked together. (F:/Comfyui/ComfyUI_windows_portable_nvidia/ComfyUI/nodes.py:714-774, 2156-2157)
- [read] v0.42.4 core has LoadLoraModel ('Load LoRA (Model)') and LoadLoraTextEncoder: a dynamic group 'loras' of 1-20 rows with lora_name, strength (-100..100) and enabled; in an API prompt the fields are '<group>.<index>.<field>', and the template is documented as internal and unstable. (ComfyUI/comfy_extras/nodes_lora_stack.py; comfy_api/latest/_io.py:1337-1354; commit 926d828e3 (2026-10-09, PR #16309))
- [inferred] lora_name options are folder_paths.get_filename_list('loras'): an os.walk of models/loras (and extra paths) with paths relative to the folder, so subfolders appear as 'sub<sep>file'; on Windows the separator is a backslash. (ComfyUI/folder_paths.py:28, 404-446; separator inferred from os.path.relpath)
- [read] Prompt validation of combo values is an exact string match (value_not_in_list). (ComfyUI/execution.py:1060-1090)
- [read] GET /models/{folder} returns get_filename_list(folder), e.g. /models/loras. (ComfyUI/server.py:407-419)
- [read] Unmapped LoRA keys only log 'lora key not loaded', and a failing patch logs 'ERROR ...' and keeps the original weight; the run is not refused. (ComfyUI/comfy/lora.py:99-102; comfy/weight_adapter/lora.py:284-285)
- [inferred] Qwen Image 2.1 is a different architecture from Qwen Image/Edit 2509/2511 (single-stream to_q/to_k/to_v/to_out, gated MLP, txt_in.text_norm, modulation), so 2509/2511 LoRAs keyed add_k_proj etc. do not apply to it. (ComfyUI/comfy/ldm/qwen_image21/model.py:57-78; comfy/model_detection.py:985-1010; LoRA headers of Qwen-Edit-Relight vs Qwen2.1_Anime_consistency)
- [inferred] 2511 differs from 2509 in ComfyUI's detection only by the marker key __index_timestep_zero__, so 2509 LoRAs load on 2511. (ComfyUI/comfy/model_detection.py:1006-1010)
- [read] Flux2 (Klein) is a subclass of Flux and uses the Flux diffusers/OneTrainer/DiffSynth LoRA maps; Flux3 maps separate q_proj/k_proj/v_proj onto the fused qkv; Z-Image (Lumina2) uses z_image_to_diffusers maps. (ComfyUI/comfy/model_base.py:1091; comfy/lora.py:276-288, 350-357, 379-388)
- [read] v0.42.4's MOSS LoRA map handles only diffusion_model./lora_unet_ names and q/k/v slices; bare module paths (layers.N.proj.q) came with PR #17296 (60aade0bb, 2026-10-22), which v0.43.0 contains and v0.42.4 does not; no version maps a 'transformer.' prefix for MOSS. (ComfyUI/comfy/lora.py:359-366 vs GitHub master lora.py:359-369; gh api compare 60aade0bb...v0.42.4 = diverged, ...v0.43.0 = ahead)
- [read] TextEncodeMOSSImageEdit (clip, prompt, optional vae, edit_format ai-toolkit / ai-toolkit (kv_cache off) / Moss-Image-Edit, images autogrow 1-10, image_strength 0-100) is not in the user's v0.42.4 and is on Comfy Cloud. (ComfyUI/comfy_extras/nodes_moss_image.py (local); commits 60aade0bb and 9fe7ef764; Comfy Cloud get_node 2026-11-06)
- [read] Comfy-Org/MOSS-Image ships loras/moss_image_edit_lora_rank_64_bf16.safetensors (added 2026-10-26, from chinoll/Moss-Image-Edit) with bare keys layers.N.proj.*.lora_A/B, and loras/moss_image_color_depth_control.safetensors. (https://huggingface.co/Comfy-Org/MOSS-Image (README, commits API, safetensors header))
- [read] Comfy's MOSS edit template: UNETLoader moss_image_sft_int8_convrot -> LoraLoaderModelOnly moss_image_edit_lora_rank_64_bf16 (strength 1) -> SkipLayerGuidanceDiTSimple (layer 22) -> KSampler 30 steps, cfg 4, euler/normal; TextEncodeMOSSImageEdit with edit_format Moss-Image-Edit for both prompts; CLIP qwen3.5_9b_w4a8_gptq; VAE flux2-vae_small. (https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/image_moss_image_edit.json)
- [read] ComfyUI v0.43.0 was published 2026-10-27 and v0.44.0 on 2026-11-04. (gh api repos/comfyanonymous/ComfyUI/releases)
- [read] All 13 DiT LoRAs sampled (the user's Qwen, Klein, FLUX.2, FLUX 3, Z-Image and Ideogram ones; Hugging Face MOSS and Qwen 2.1 ones) have 0 text-encoder keys; the user's SDXL LoRAs have 792 of 2,958 keys on lora_te1_*. (safetensors headers via scratchpad/iss_lora_ecosystem/scripts/st_header.py)
- [read] The user's LoRA folder has 1,201 .safetensors files; family subfolders are qwen/ 27, klein/ 25, Flux_3/ 4, z_image/ 3, flux_2/ 2, ideogram/ 1, and a Klein LoRA sits in kontext/. (find over ComfyUI/models/loras)
- [read] recipes/relight_qwen_local.json hard-codes root-level lora_name values (Qwen-Image-Edit-2509-Relight.safetensors, ...Lightning-4steps-V1.0-bf16) with only strength_model as a Settings row, while the user's files are qwen/Qwen-Edit-Relight.safetensors and ...-fp32. (F:/canvas/recipes/relight_qwen_local.json:30, 95-110; models/loras listing)
- [read] fal LoRA endpoints take loras: [{path, scale}] with scale default 1, range 0-4, and at most 3 LoRAs on the Qwen edit, Klein, FLUX.2, Z-Image and MOSS endpoints: fal-ai/qwen-image-edit-lora, -plus-lora, -2511/lora, flux-2/klein/{4b,9b}[/base]/edit/lora, flux-2/lora/edit, z-image/turbo[/image-to-image|/inpaint]/lora, z-image/base/lora, moss-image/lora; flux-kontext-lora and flux-lora-fill allow any number. (https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id> (2026-11-06))
- [read] fal has no loras field on qwen-image-2.1, qwen-image-2.1/edit, qwen-image-edit-2511 or qwen-image-edit/inpaint; no FLUX 3 Klein endpoint was found; fal-ai/moss-image/edit is a 404. (fal OpenAPI probes 2026-11-06)
- [read] fal's Klein, FLUX.2 and Z-Image LoRA path accepts 'URL, HuggingFace repo ID (owner/repo), or local path'; fast-sdxl/inpainting scale is 0-1. (fal OpenAPI schemas)
- [read] Replicate qwen/qwen-image-edit-plus-lora and qwen/qwen-image-edit-2511 take lora_weights (an HF slug or .safetensors URL) and lora_scale 0-4 (one LoRA); replicate/qwen-image-2.1-lora takes lora/lora_2 with scales -3..3 (SimpleTuner LoRA URL) and edits with image plus up to 10 references; black-forest-labs/flux-2-klein-9b-base-lora takes lora_weights[] and lora_scales[] with up to 5 images. (https://replicate.com/<model>/api/schema (2026-11-06))
- [read] WaveSpeed qwen-image/edit-plus-lora and flux-2-klein-9b/edit-lora: images up to 3, loras up to 3, {path, scale 0-4}; the edit-2511-lora page gives the scale as 0-4 in its table and 0-2 in its text. (https://wavespeed.ai/docs/docs-api/wavespeed-ai/qwen-image-edit-plus-lora ; .../flux-2-klein-9b-edit-lora ; https://wavespeed.ai/docs/docs-api/qwen-image-edit-2511-lora)
- [read] Comfy Cloud model import: Creator plan or higher, Civitai and Hugging Face only, .safetensors only, up to 100 GB, private to the user, tokens for private repos under Secrets. (https://docs.comfy.org/cloud/import-models (2026-11-06))
- [read] The user's Comfy Cloud account has no imported LoRAs; Cloud's live LoraLoaderModelOnly combo lists many shared Qwen 2509/2511, Qwen 2.1, Klein and Z-Image LoRAs but no moss_* LoRA, although the catalog has moss_image_edit_lora_rank_64_bf16. (Comfy Cloud MCP search_models(owned:true, type:lora) and get_node(LoraLoaderModelOnly), 2026-11-06)
- [read] Civitai base-model filter values that return LoRAs: Qwen, Qwen 2.1, MOSS Image, Flux.2 Klein 9B, Flux.2 Klein 9B-base, Flux.2 Klein 4B, Flux.2 D, Flux.3, Flux.3 Klein, ZImageTurbo, ZImageBase; there is no separate value for Qwen Edit 2509/2511. (https://civitai.com/api/v1/models?types=LORA&baseModels=... (2026-11-06))
- [read] The user's Qwen LoRA anna_qwen carries ss_base_model_version = sd_1.5 (ai-toolkit 0.4.0), so safetensors metadata cannot identify the family. (safetensors header of models/loras/qwen/anna_qwen_000003500.safetensors)
- [unverified] LoRAs trained on FLUX.2 Klein base load on the distilled model and often look better there. (https://huggingface.co/blog/black-forest-labs/flux-2-klein-lora (via search summary))
- [unverified] Z-Image Turbo LoRAs trained without ostris' training adapter erode Turbo's step distillation. (https://lilting.ch/en/articles/z-image-turbo-lora-dedistill-adapter (via search summary))
- [inferred] LoRA patches apply to int8_convrot quantised weights (cast in compute dtype); Comfy's MOSS edit template runs a LoRA on moss_image_sft_int8_convrot. (ComfyUI/comfy/ops.py:911, 1493; image_moss_image_edit.json)

## Open questions

- Should the user's ComfyUI be updated from v0.42.4 to v0.43.0 or v0.44.0 for MOSS-Image edit (TextEncodeMOSSImageEdit and bare-key MOSS LoRAs)? It is a production machine, so this is the user's call.
- Do Comfy Cloud runs accept an imported LoRA by its bare filename in lora_name, and do Cloud's moss_* catalog LoRAs run even though the live object_info combo omits them? Not run.
- Do fal, Replicate and WaveSpeed follow Civitai's /api/download/models/<id> 307 redirect, and do gated Civitai or Hugging Face files need a token on those providers?
- How well do 2509 LoRAs work on Qwen Edit 2511, and LoRAs trained on Klein base on the distilled Klein? Only community sources so far.
- Should Scumble check LoRA compatibility itself (reading the safetensors header key prefixes against the recipe's family), since ComfyUI never fails a run on an incompatible LoRA?
- Should recipes chain LoraLoaderModelOnly nodes (stable) or use the new LoadLoraModel stack (dotted 'loras.N.field' inputs, documented as internal and unstable)?
- WaveSpeed's edit-2511-lora scale range: 0-4 or 0-2 (the page says both)?
- The shipped relight_qwen_local recipe's root-level lora_name values do not match the files on the user's machine (qwen/ subfolder, other names): expose lora_name as a Settings row?
