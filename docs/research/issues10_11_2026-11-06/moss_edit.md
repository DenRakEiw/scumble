# moss_edit

## Summary

There is no official OpenMOSS edit model. OpenMOSS-Team has published only MOSS-Image-Base and MOSS-Image-SFT (both text-to-image, Apache-2.0, 2026-10-16). In their HF thread (2026-10-17) they said they are "actively exploring reference-related features" and gave no date. "MOSS Image Edit" in issue #11 is a community LoRA, chinoll/Moss-Image-Edit (rank 64, 297 MB, released 2026-10-22/23, no licence stated for the weights, project code GPL-3.0). ComfyUI made it official on its side. Kijai's PRs #17296 and #17320 were merged 2026-10-22 and 2026-10-23. ComfyUI v0.43.0 (2026-10-27) ships the core node `TextEncodeMOSSImageEdit` and reference latents in the MOSS model. Comfy rehosted the LoRA as `Comfy-Org/MOSS-Image/loras/moss_image_edit_lora_rank_64_bf16.safetensors` and added the template `image_moss_image_edit` ("MOSS-Image: Image Edit LoRA", 2026-10-26, minComfyUIVersion 0.43.0). The issue came in five days later, so that template is almost certainly what the author means.

What decides the design:
1. **The user's ComfyUI is v0.42.4.** It has no edit node, and its MOSS model ignores reference latents. A local edit recipe needs ComfyUI 0.43 or newer, and updating the production machine is the user's call. The user already has the SFT bf16 model, qwen3.5_9b_int8_convrot and flux2-vae_small, so only the LoRA (297 MB) is missing.
2. **The graph is all core nodes**, so the template maps onto Scumble's shape: UNETLoader, then LoraLoaderModelOnly, then SkipLayerGuidanceDiTSimple (layer 22, 0 to 1). Two TextEncodeMOSSImageEdit nodes, positive and negative, both see the same pictures, with `edit_format` "Moss-Image-Edit" and autogrow inputs `images.image_0`... (max 10). Then KSampler (30 steps, CFG 4, euler/normal), EmptyFlux2LatentImage at 1 MP and VAEDecode.
3. **Scumble-side changes:** a `TextEncodeMOSSImageEdit` entry in `comfyrefs.js` ENCODERS, and a way to keep `edit_format` the same on both encoders. Open is how the model names pictures 2-4 in the prompt (no text markers in the Moss-Image-Edit format; "Picture N" in the ai-toolkit formats).
4. **No hosted edit API exists.** fal and WaveSpeed serve MOSS-Image text-to-image only (with LoRA variants). Comfy Cloud has the node, the LoRA and the template, so a `cloud_moss_image_edit` built from Comfy's template is possible.
5. **Many MOSS LoRAs exist** (style, distillation, de-banding, edit, character reference). The user's 0.42.4 already loads plain MOSS LoRAs through LoraLoaderModelOnly (`comfy/lora.py:359`).

## Report

## Answer for issue #11: what "MOSS Image Edit" is

### 1. Is there an official OpenMOSS edit model? No.

- **OpenMOSS-Team on Hugging Face** lists only two MOSS-Image models: `OpenMOSS-Team/MOSS-Image-SFT` and `OpenMOSS-Team/MOSS-Image-Base`. Both are text-to-image, both created 2026-10-11 and announced 2026-10-16 (read: HF API `models?author=OpenMOSS-Team`; [README News](https://github.com/OpenMOSS/MOSS-Image)).
  - Licence: Apache-2.0 (read: HF cardData; GitHub licence).
  - Size: about 27.2 GB each in diffusers layout (transformer 3 shards plus text_encoder 4 shards plus VAE 0.25 GB; read: HF API `?blobs=true`).
- **The GitHub org OpenMOSS** has no edit repo. MOSS-Image's own commits run up to 2026-11-02 and none adds editing (read: `gh api repos/OpenMOSS/MOSS-Image/commits`).
- **USERGUIDE.md line ~105** says: "simple SFT can enable features such as GIF generation and reference-based generation in MOSS-Image-Base. Stay tuned." (read: [USERGUIDE.md](https://github.com/OpenMOSS/MOSS-Image/blob/main/USERGUIDE.md)).
- **HF discussion #1** "Suggestion: make an edit model based on MOSS Image" (arifqai, 2026-10-16). OpenMOSS's Phospheneser answered on 2026-10-17: "Currently, we are actively exploring reference-related features ... We'll keep you posted." No date was given (read: [discussion 1](https://huggingface.co/OpenMOSS-Team/MOSS-Image-SFT/discussions/1)).
- **HF discussion #17** (2026-10-28): the official diffusers custom pipeline blocks image inputs, so even LoRA editing does not run there (read: `api/models/.../discussions/17`).
- **Official serving**, all text-to-image (read: README News):
  - diffusers `MOSSImagePipeline` with trust_remote_code
  - SGLang and vLLM-Omni (day-0)
  - ComfyUI native (PR Comfy-Org/ComfyUI#17095)
  - the MOSI API Platform since 2026-10-20 (platform.mosi.cn, which redirects to platform.moss.cn). Whether it offers editing is unverified: the page is JS-rendered.

### 2. What the issue author most likely means: the community edit LoRA and Comfy's template

**chinoll/Moss-Image-Edit** (HF; the project is GitHub Chenkin-x/Moss-Image-Edit):
- The HF repo was created 2026-10-22; the release commit "Release MOSS Image Edit LoRA" is from 2026-10-23 (read: HF API).
- Files: `adapter_model.safetensors` 297,382,216 bytes plus `adapter_config.json`. The config gives format `moss-edit-lora`, edit contract `ref-prefix-only-t0__target-text-original-moss-v1`, 252 target linears (q/k/v/o/ffn of all 42 blocks), trained on SFT (read: adapter_config.json).
- Licence: the HF card names none for the weights. The project code is GPL-3.0 (read: `gh api repos/Chenkin-x/Moss-Image-Edit` license GPL-3.0). Training data includes ConceptEdit-12M, which is Apache-2.0 (read: HF dataset API).
- What it does (read: [card](https://huggingface.co/chinoll/Moss-Image-Edit); Chenkin-x README.en.md):
  - instruction editing (colours, outfits, lighting, seasons, style)
  - up to 4 reference images
  - no mask input
- How it works: tokens are ordered [text, ref, target], references sit at t=0 and attend only to each other, and their K/V are cached once per run (read: Chenkin-x README.en.md lines 59-73).
- **Relation to MOSS-Image:** it is the same 5B DiT, used unchanged. The LoRA adds edit behaviour on top of SFT (or Base), with the same Qwen3.5-9B text encoder and the same FLUX.2 VAE (read: card; adapter_config `model_config` dim 3072 / 42 layers / text_dim 4096, which matches `comfy/ldm/moss_image/model.py` defaults).
- Settings tips from a re-packager, PedroMarinhoDev (read: [card](https://huggingface.co/PedroMarinhoDev/Moss-Image-Edit-ComfyUI)):
  - LoRA strength 1.0
  - references the same size as the output
  - CFG 5, 30 steps
  - SFT works much better than Base
  - weak at pose changes and at replacing one subject with another

**Comfy's official adoption:**
- `Comfy-Org/MOSS-Image` added `loras/moss_image_edit_lora_rank_64_bf16.safetensors` on 2026-10-26 (commit "Add MOSS-Image edit LoRA (rank 64, bf16) (#11)"). The template says it has the "same bytes" as chinoll's file (read: HF commits API; template MarkdownNote).
- The same repo also holds `loras/moss_image_color_depth_control.safetensors` (darask0, Apache-2.0).
- The template `image_moss_image_edit`, "MOSS-Image: Image Edit LoRA", is dated 2026-10-26 with `minComfyUIVersion: "0.43.0"`, usage 1703 (read: [workflow_templates index.json](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/index.json)).
- Issue #11 was opened 2026-10-31, five days later (read: `gh issue view 11`). That this template is what the author means is inferred.

**Other community edit LoRAs:**
- `akhaliq/MOSS-Image-Edit-HQ` (Apache-2.0, armV2 to V7, ai-toolkit layout)
- `7err4/MOSS-Image-CharRef` v2 (Apache-2.0, a character reference on Base, trained with ai-toolkit `edit: true, kv_cache: true`)

(read: their HF cards). ai-toolkit trains MOSS edit LoRAs (`model_kwargs.edit`, `kv_cache`; read: ostris/ai-toolkit `extensions_built_in/diffusion_models/moss_image/moss_image.py:189-198`).

### 3. ComfyUI support

**The user's ComfyUI v0.42.4** (read: `comfyui_version.py`):
- `comfy_extras/nodes_moss_image.py` has only `MOSSImageLayoutPrompt` and `MOSSImageControl` (color/depth adapter loaded as a LoRA). It has no edit node (read: file, 103 lines).
- `MOSSImage._forward` takes no `ref_latents` (read: `comfy/ldm/moss_image/model.py`), and `model_base.MOSSImage` has only `concat_cond` for the control adapter (read: `comfy/model_base.py:2799-2826`). Reference latents are therefore ignored.
- `ReferenceLatent`'s method list there lacks the MOSS methods (read: `comfy_extras/nodes_flux.py:165`).
- No MOSS or ostris pack is in `custom_nodes` (read: a directory listing only).
- ComfyUI was not running at check time: `/system_stats` returned no answer, so `/object_info` was not readable.

**The ComfyUI changes:**
- PR #17296 "Support MOSS-Image edit LoRAs" (kijai, merged 2026-10-22):
  - MOSS accepts `reference_latents`
  - reference methods for ai-toolkit (kv_cache on/off) and chinoll
  - reference K/V computed once, 826 to 457 ms/step at 1024² with a 1 MP reference
  - bare `layers.N.proj.q` LoRA key aliases for Moss-Image-Edit files
  - the new node "Text Encode MOSS-Image Edit"
- PR #17320 (merged 2026-10-23) adds `image_strength` and `context_attention_bias`.

(read: `gh pr view`). Both are in the **v0.43.0 release (2026-10-27)** notes and in v0.44.0 (2026-11-04). **v0.42.5 does not have the node** (read: file at tag v0.42.5, 0 matches). The template note says: "The Core support (`Text Encode MOSS-Image Edit`) ships from ComfyUI 0.43.0" (read).

**v0.42.4 to v0.43.0 also changes requirements** (read: compare diff of requirements.txt):

| Package | v0.42.4 | v0.43.0 |
|---|---|---|
| comfy-kitchen | 0.2.39 | 0.2.40 |
| comfy-aimdo | 0.5.6 | 0.6.0 |
| frontend | 1.55.18 | 1.57.4 |
| templates | 0.11.89 | 0.11.97 |
| Pillow | no minimum | >=10.1.0 |

**Node `TextEncodeMOSSImageEdit`** (core, experimental, category `model/conditioning/moss_image`; read: master `comfy_extras/nodes_moss_image.py:95-149`, which is identical to v0.43.0; Comfy Cloud live catalog via get_node):

- **Inputs:**
  - `clip` (CLIP)
  - `prompt` (STRING)
  - `vae` (optional; without it the pictures go to the text encoder only)
  - `edit_format`, one of:
    - `ai-toolkit`, which maps to `index_timestep_zero_isolated` with vision on
    - `ai-toolkit (kv_cache off)`, which maps to `index_timestep_zero` with vision on
    - `Moss-Image-Edit`, which maps to `index_timestep_zero_text_start` with vision off
  - `images`: autogrow, prefix `image_`, min 1. API keys are `images.image_0`, `images.image_1`, ...; the Cloud catalog shows up to 10 (`image_0`..`image_9`).
  - `image_strength`: FLOAT, default 1, range 0-100, advanced
- **Output:** CONDITIONING carrying `reference_latents` and `reference_latents_method`.
- In the ai-toolkit formats (or with no VAE) the prompt is prefixed with `Picture N: <|vision_start|>...` for each picture, downscaled to at most 384x384. In the `Moss-Image-Edit` format no picture enters the text.
- References are used at the size they arrive, so they have to be scaled first.
- Note: docs.comfy.org says `image_1, image_2`, but the template and the Cloud catalog use `image_0` first (read both).

**The edit graph from the template** (read: `templates/image_moss_image_edit.json`; nodes and links):

```
LoadImage -> ImageScaleToTotalPixels(lanczos, 1 MP, 16) -> GetImageSize -> EmptyFlux2LatentImage
UNETLoader(moss_image_sft_int8_convrot) -> LoraLoaderModelOnly(moss_image_edit_lora_rank_64_bf16, 1)
  -> SkipLayerGuidanceDiTSimple("", "22", 0, 1) -> KSampler
CLIPLoader(qwen3.5_9b_w4a8_gptq, type moss_image), VAELoader(flux2-vae_small)
TextEncodeMOSSImageEdit pos (clip, images.image_0 = scaled source, vae, "Moss-Image-Edit", 1)
TextEncodeMOSSImageEdit neg ("nsfw, worst quality, bad anatomy, watermark, jpeg artifact", same image, same format)
KSampler(seed, 30 steps, cfg 4, euler, normal, denoise 1) -> VAEDecode -> SaveImage / ImageCompare
```

The template's notes (read):
- Both encoders must use the same `edit_format`.
- Recommended phrasing: "Change only the X to Y. Keep the character, face, hair, pose, background and composition unchanged."
- Up to four references.
- Lowering to about 0.26 MP makes the model re-frame instead of edit.
- Keep CFG at 4.
- The LoRA also runs on Base.

**Community packs for 0.42** (an alternative to updating, each a custom install on the production machine):
- `ostris/ComfyUI-MOSS-Image-Ostris-Edit` (MIT, 2026-10-17): `TextEncodeMOSSImageOstrisEdit` and `MOSSImageOstrisEditModelPatch`, for ai-toolkit LoRAs
- `PedroMarinhoDev/ComfyUI-Moss-Image-Edit-Native` (for chinoll and HQ)
- `Chenkin-x/ComfyUI-Moss-Image-Edit` (GPL-3.0; `ModelPatchLoader` and `ApplyMossImageEdit`, reference_max_edge 512)

(read: READMEs and workflow). Core 0.43 covers all three LoRA layouts, which makes these packs unnecessary; whether akhaliq HQ v5 (trained with 512 px vision) is exact on core's fixed 384² is unverified.

### 4. Hosted APIs

- **fal:** `fal-ai/moss-image` (text-to-image) and `fal-ai/moss-image/lora` (text-to-image, up to 3 LoRAs as `{path, scale}`). Neither takes an image (read: OpenAPI `MossImageInput` / `MossImageLoraInput`). `fal-ai/moss-image/edit`, `/image-to-image` and `fal-ai/moss-image-edit` return 404, and fal's catalog search finds only `fal-ai/moss-image` (read).
- **WaveSpeed:** `wavespeed-ai/moss-image/text-to-image` and `wavespeed-ai/moss-image/text-to-image-lora` (up to 3 LoRAs, scale 0-4; 1k / 1.5k / 2k). No image input; the page's FAQ says it does not edit (read: [wavespeed.ai/moss-image-api](https://wavespeed.ai/moss-image-api)).
- **Replicate:** none found. `replicate.com/openmoss/moss-image` returns 404 and the search page is JS-only (unverified).
- **Comfy Cloud:** the live catalog has `TextEncodeMOSSImageEdit`, `MOSSImageLayoutPrompt` and `MOSSImageControl`, all core, plus these models (read: Comfy Cloud MCP get_node / search_models / search_templates):
  - `moss_image_edit_lora_rank_64_bf16`, `moss_image_color_depth_control`
  - SFT and Base in bf16 and int8, an SFT turbo int8 and an SFT deband int8
  - qwen3.5_9b bf16, int8 and w4a8
  - flux2-vae_small
  - the template `image_moss_image_edit`

  So a Comfy Cloud edit route can be built.
- **Comfy Router / partner models:** none. The partner search for "moss" returns 0 (read). That the Router has none is inferred from that search.

### 5. Scumble's side today and what an edit recipe would reuse

**What exists:**
- `recipes/moss_image_local.json` is `edit: false`, with boxes `{schema: "moss", input: "pos|text", layout: "layout"}`. Its graph:
  - UNETLoader `moss_image_sft_bf16`
  - CLIPLoader `moss_image` with `qwen3.5_9b_int8_convrot`
  - VAELoader `flux2-vae_small`
  - ImageScaleToTotalPixels at 1 MP, steps of 16, then GetImageSize and EmptyFlux2LatentImage
  - SkipLayerGuidanceDiTSimple, layer 22, 0 to 0.5
  - MOSSImageLayoutPrompt
  - KSampler: 25 steps, CFG 2.5, er_sde
  - the canvas negative `["canvas", 12]`

  (read: the file). Its description says "takes no picture to edit".
- The `edit: false` gate:
  - `electron/main/recipes.js:600-602` (`r.edit = r.edit !== false || ...`)
  - the refusal in `renderer/editor/host.js:3957-3959`
  - the MOSS box filter, New and Text only: `renderer/editor/boxes_model.js:192-199`
  - wiring: `renderer/editor/comfyprompt.js:127-191`
  - validation: `electron/main/recipes.js:507-528`
- The docs: `docs/RECIPES.md:91-102` (schema), `:124` (`edit`) and `:187-200` (the recipe, run live 2026-10-22). CHANGELOG 0.1.50 line 17 says "It takes no picture to edit" (read).
- The user's models folder already has `moss_image_sft_bf16` (10.16 GB), `qwen3.5_9b_int8_convrot` and `flux2-vae_small`, but no MOSS LoRA (read: directory listing).

**Templates to copy from:**
- `qwen_image_edit_2_1_local.json`: ImageFromBatch img0..img9 into `TextEncodeQwenImage21` `images.image_1..10`, `refs {"name":"<image{n}>","slots":10}`, KSampler CFG 1.
- `flux2_klein_local.json` and `flux3_klein_local.json`: img0..3, ImageScaleToTotalPixels per picture at 1 MP, a VAEEncode plus ReferenceLatent chain on both positive and negative, CFGGuider and SamplerCustomAdvanced.
- `relight_qwen_local.json` shows the LoRA pattern: `LoraLoaderModelOnly` between UNETLoader and the sampler, a Settings row on `strength_model`, and `models.loras` download entries (read: files).

**A MOSS edit recipe, sketched for the planner** (inferred; to be checked against `/object_info` on 0.43 or newer):

```
canvas InpaintCanvas; img0..img3 ImageFromBatch(["canvas",0], i, 1); scale0..3 ImageScaleToTotalPixels(lanczos, 1, 16)
unet UNETLoader(moss_image_sft_bf16); lora LoraLoaderModelOnly(["unet",0], moss_image_edit_lora_rank_64_bf16.safetensors, 1)
slg SkipLayerGuidanceDiTSimple(["lora",0], "", "22", 0, 1); clip CLIPLoader(qwen3.5_9b_int8_convrot, moss_image); vae VAELoader(flux2-vae_small)
size GetImageSize(["scale0",0]); latent EmptyFlux2LatentImage(size)
pos TextEncodeMOSSImageEdit(clip, prompt ["canvas",7], vae, edit_format "Moss-Image-Edit", images.image_0..3 = scale0..3, image_strength 1)
neg TextEncodeMOSSImageEdit(same, prompt ["canvas",12])
ks KSampler(["slg",0], seed ["canvas",10], 30, 4, euler, normal, pos, neg, latent, 1); decode VAEDecode
needs: [..., "LoraLoaderModelOnly", "TextEncodeMOSSImageEdit"]   models.loras: Comfy-Org link
```

**Scumble changes it needs** (inferred from the code read):
1. `renderer/editor/comfyrefs.js:37` ENCODERS has only `TextEncodeQwenImage21`, `TextEncodeQwenImageEditPlus` and `ReferenceLatent`. A `TextEncodeMOSSImageEdit` entry is needed: keys `images.image_k`, 0-based, numbered by rank since the node sorts present keys (`nodes_moss_image.py:125`). Without it @img tokens and the slot trimming will not see the pictures.
2. `edit_format` sits on two nodes, but a Settings row writes one node input. Either fix it in the file or extend the settings mechanism (or use a linked primitive).
3. Picture naming in the prompt: the ai-toolkit formats see "Picture N:" markers, so `refs.name` "Picture {n}" fits. The Moss-Image-Edit format has no text markers; the model card only says "explain the role of each image". Open question.
4. A separate recipe id (for example `moss_image_edit_local`) keeps `moss_image_local`'s Generate new and boxes. A JSON layout as an edit instruction is untrained: the LoRA was trained on plain instructions (inferred).
5. The description, RECIPES.md, MANUAL and the "0.43 or newer" minimum.
6. A `cloud_moss_image_edit` from Comfy's template, as the other cloud recipes are made (`tools/refs/comfy_cloud/edit/`, RECIPES.md:396-402), with the MOSS text-to-image template as its text route (inferred).
7. Masks: the model takes none. Scumble's stitch composites the crop by the selection, as it does for the Qwen and Klein edits (inferred).

### 6. LoRAs for MOSS (published)

From the HF search "moss-image" / "moss_image", 2026-11-06 (read; names only):
- **Edit / reference:** chinoll/Moss-Image-Edit; akhaliq/MOSS-Image-Edit-HQ; 7err4/MOSS-Image-CharRef
- **Control:** darask0/MOSS-Image-color-depth-control (Apache-2.0)
- **Speed:** lodestones/MOSS-Image-SFT-8-steps-dmd (LoRA adapters for ComfyUI); darask0/MOSS-Image_4-step_adapter_lora
- **Fix:** MATLOWAI/MOSS-Image-SFT-DeBand (LoRAs against vertical banding)
- **Style:**
  - axiomofmind (anime, beauty, gouache, psychedelic, animated)
  - Kandoo Impressionism
  - aoleg Kodachrome V1 and V2
  - pmczip/MOSS_Image_LoRAs
  - genai-craft transparent
  - paralaif Alpha
- **NSFW:** many uncensored LoRAs (axiomofmind and copies), not for the shipped list.

Comfy Cloud also lists `moss_image_sft_lora_blocks_21_to_49_rank_512_bf16` (read; purpose unknown). Trainers: KohakuMossTrainer, DiffSynth-Studio, ai-toolkit (read: README Community projects; ai-toolkit code). On the user's 0.42.4 a plain MOSS LoRA loads through `LoraLoaderModelOnly`: `comfy/lora.py:359-366` maps q/k/v onto fused qkv, and `comfy/lora_convert.py:36-52` handles control adapters (read). The chinoll file's bare keys need 0.43 (PR #17296, read). Two hosts take MOSS LoRAs by URL, text-to-image only: fal `fal-ai/moss-image/lora` and WaveSpeed `text-to-image-lora`.

### 7. Plain answer for the planner

"MOSS Image Edit" is not an OpenMOSS product. It is chinoll's community edit LoRA, packaged by Comfy as a core node and template since ComfyUI 0.43.0. It can be added as a local recipe from core nodes alone once the user's ComfyUI is 0.43 or newer, and as a Comfy Cloud recipe. No hosted API edits with MOSS. The second ask in the issue ("edit with any other editing models with loras") is the same request as #10: a LoRA slot on the edit recipes.

## Facts

- [read] OpenMOSS-Team has only two MOSS-Image models on Hugging Face, MOSS-Image-SFT and MOSS-Image-Base, both text-to-image, Apache-2.0, about 27.2 GB each in diffusers layout; no official edit model. (https://huggingface.co/api/models?author=OpenMOSS-Team ; HF API ?blobs=true; https://github.com/OpenMOSS/MOSS-Image README News)
- [read] OpenMOSS (Phospheneser, 2026-10-17) answered the edit-model request with 'actively exploring reference-related features', with no date given. (https://huggingface.co/OpenMOSS-Team/MOSS-Image-SFT/discussions/1)
- [read] MOSS-Image USERGUIDE: simple SFT can enable reference-based generation in Base, 'Stay tuned'; recommended 1-2 MP, >=50 steps, CFG 3, shift 5, Euler, SLG layer 22. (https://github.com/OpenMOSS/MOSS-Image/blob/main/USERGUIDE.md lines 5-15, 105)
- [read] chinoll/Moss-Image-Edit is a rank-64 edit LoRA for MOSS-Image (297,382,216 bytes, released 2026-10-22/23, 252 target linears, trained on SFT, up to 4 references, references at t=0 with cached K/V); the HF repo names no weight licence; the project code (Chenkin-x/Moss-Image-Edit) is GPL-3.0. (https://huggingface.co/chinoll/Moss-Image-Edit (card, adapter_config.json, API); gh api repos/Chenkin-x/Moss-Image-Edit; Chenkin-x README.en.md 59-73)
- [read] Comfy-Org rehosted the edit LoRA as loras/moss_image_edit_lora_rank_64_bf16.safetensors on 2026-10-26 (same bytes as chinoll's per the template note); the repo also holds loras/moss_image_color_depth_control.safetensors. (https://huggingface.co/api/models/Comfy-Org/MOSS-Image/commits/main ; tree/main ; template image_moss_image_edit MarkdownNote)
- [read] Comfy's template image_moss_image_edit ('MOSS-Image: Image Edit LoRA') is dated 2026-10-26 with minComfyUIVersion 0.43.0. (https://github.com/Comfy-Org/workflow_templates/blob/main/templates/index.json)
- [read] The template graph: UNETLoader(moss_image_sft_int8_convrot) -> LoraLoaderModelOnly(edit LoRA, 1) -> SkipLayerGuidanceDiTSimple('', '22', 0, 1) -> KSampler(30 steps, cfg 4, euler, normal); CLIPLoader qwen3.5_9b_w4a8_gptq type moss_image; VAELoader flux2-vae_small; ImageScaleToTotalPixels 1 MP/16 -> GetImageSize -> EmptyFlux2LatentImage; two TextEncodeMOSSImageEdit (pos, neg) with images.image_0, vae, edit_format Moss-Image-Edit. (https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_moss_image_edit.json (nodes and links))
- [read] ComfyUI PR #17296 (kijai, merged 2026-10-22) adds reference_latents to MOSS, the reference methods for ai-toolkit and Moss-Image-Edit, cached reference K/V (826 to 457 ms/step at 1024² with a 1 MP reference), LoRA key aliases and the node Text Encode MOSS-Image Edit; PR #17320 (merged 2026-10-23) adds image_strength. (gh pr view 17296 / 17320 --repo Comfy-Org/ComfyUI)
- [read] TextEncodeMOSSImageEdit first ships in ComfyUI v0.43.0 (released 2026-10-27); v0.42.5 does not have it; v0.44.0 (2026-11-04) and master are identical to v0.43.0 in nodes_moss_image.py. (gh api releases; contents/comfy_extras/nodes_moss_image.py at v0.42.5, v0.43.0, v0.44.0, master; v0.43.0 release notes)
- [read] TextEncodeMOSSImageEdit inputs: clip, prompt, optional vae, edit_format (ai-toolkit -> index_timestep_zero_isolated; ai-toolkit (kv_cache off) -> index_timestep_zero; Moss-Image-Edit -> index_timestep_zero_text_start, no vision), autogrow images.image_0... (Comfy Cloud catalog: up to 10), image_strength 0-100 default 1; output CONDITIONING with reference_latents. (Comfy-Org/ComfyUI master comfy_extras/nodes_moss_image.py:95-149; Comfy Cloud get_node TextEncodeMOSSImageEdit)
- [read] The user's ComfyUI is v0.42.4: nodes_moss_image.py has only MOSSImageLayoutPrompt and MOSSImageControl, MOSSImage._forward takes no ref_latents, and ReferenceLatent's methods lack the MOSS ones, so MOSS editing cannot run there. (F:/Comfyui/ComfyUI_windows_portable_nvidia/ComfyUI/comfyui_version.py; comfy_extras/nodes_moss_image.py; comfy/ldm/moss_image/model.py; comfy/model_base.py:2799-2826; comfy_extras/nodes_flux.py:165)
- [read] The user's ComfyUI already has moss_image_sft_bf16 (10.16 GB), qwen3.5_9b_int8_convrot and flux2-vae_small, no MOSS LoRA and no MOSS/ostris custom pack; ComfyUI was not running at check time (no /system_stats answer). (directory listings of models/ and custom_nodes; curl http://127.0.0.1:8188/system_stats -> 000)
- [read] Updating to v0.43.0 also changes requirements: comfy-kitchen 0.2.40, comfy-aimdo 0.6.0, frontend 1.57.4, templates 0.11.97, Pillow>=10.1.0. (gh api repos/Comfy-Org/ComfyUI/compare/v0.42.4...v0.43.0 requirements.txt patch)
- [read] On v0.42.4 a plain MOSS LoRA loads through LoraLoaderModelOnly (fused qkv mapped for LoRAs) and control adapters are converted; the chinoll file's bare keys need the 0.43 aliases. (F:/Comfyui/.../comfy/lora.py:359-366; comfy/lora_convert.py:36-52; PR #17296 body)
- [read] Community packs that run MOSS edit LoRAs on 0.42: ostris/ComfyUI-MOSS-Image-Ostris-Edit (MIT, ai-toolkit LoRAs), PedroMarinhoDev/ComfyUI-Moss-Image-Edit-Native, Chenkin-x/ComfyUI-Moss-Image-Edit (GPL-3.0). (gh api repos (licence, dates); ostris README; PedroMarinhoDev HF card; Chenkin-x workflow)
- [read] Re-packager's test notes for the chinoll LoRA: strength 1.0, references the same size as the output (trained at 256 px), CFG 5, 30 steps, SFT much better than Base, weak at pose changes and subject replacement. (https://huggingface.co/PedroMarinhoDev/Moss-Image-Edit-ComfyUI)
- [read] fal serves MOSS-Image as fal-ai/moss-image and fal-ai/moss-image/lora (up to 3 LoRAs), both text-only inputs; fal-ai/moss-image/edit and /image-to-image return 404. (https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/moss-image(/lora); fal.ai/models/<id>/llms.txt probes; api.fal.ai/v1/models?q=moss)
- [read] WaveSpeed serves wavespeed-ai/moss-image/text-to-image and wavespeed-ai/moss-image/text-to-image-lora, no image input, no edit. (https://wavespeed.ai/moss-image-api)
- [unverified] No MOSS-Image model found on Replicate. (replicate.com/openmoss/moss-image 404; search page JS-rendered)
- [read] Comfy Cloud's live catalog has TextEncodeMOSSImageEdit, the edit LoRA, the color-depth LoRA, MOSS SFT/Base/turbo/deband diffusion models, qwen3.5_9b text encoders, flux2-vae_small and the template image_moss_image_edit; no MOSS partner model (Comfy Router) exists. (Comfy Cloud MCP get_node, search_models (q moss, qwen3.5_9b, flux2-vae, source partner), search_templates)
- [read] Scumble's moss_image_local recipe is edit:false (Generate new only, boxes as MOSS layout, 25 steps CFG 2.5 er_sde, SLG 0-0.5) and the gate is recipes.js:600-602 plus host.js:3957-3959. (F:/canvas/recipes/moss_image_local.json; electron/main/recipes.js:600-602; renderer/editor/host.js:3957-3959)
- [inferred] comfyrefs.js ENCODERS knows only TextEncodeQwenImage21, TextEncodeQwenImageEditPlus and ReferenceLatent; a MOSS edit recipe needs a TextEncodeMOSSImageEdit entry for @img tokens and slot trimming. (F:/canvas/renderer/editor/comfyrefs.js:37-62)
- [read] relight_qwen_local.json already shows the LoRA pattern a MOSS edit recipe would use (LoraLoaderModelOnly, a strength Settings row, models.loras download links). (F:/canvas/recipes/relight_qwen_local.json:25-47, 96-110)
- [inferred] Issue #11 (nadergits, 2026-10-31) most likely refers to Comfy's 'MOSS-Image: Image Edit LoRA' template (2026-10-26) on the chinoll LoRA. (gh issue view 11; template index date)
- [read] Published MOSS LoRAs include edit/reference (chinoll Moss-Image-Edit, akhaliq MOSS-Image-Edit-HQ, 7err4 CharRef), control (darask0 color-depth), speed (lodestones 8-step DMD, darask0 4-step adapter), de-banding (MATLOWAI) and many style LoRAs; trainers KohakuMossTrainer, DiffSynth-Studio, ai-toolkit (edit mode included). (HF API models?search=moss-image / moss_image; MOSS-Image README Community projects; ostris/ai-toolkit moss_image.py:189-198)

## Open questions

- Does the user update the production ComfyUI from 0.42.4 to 0.43.0 or newer (needed for TextEncodeMOSSImageEdit, with new comfy-kitchen/aimdo/frontend pins), or install a community pack instead?
- How does the Moss-Image-Edit LoRA expect pictures 2-4 to be named in the prompt (its text gets no 'Picture N' markers)? This decides the recipe's refs.name; the ai-toolkit formats would take 'Picture {n}'.
- Should edit_format (both encoders) and the LoRA file be Settings rows, so the recipe also runs akhaliq HQ and CharRef, which are ai-toolkit layout? Scumble's Settings rows write one node input each.
- Which defaults: the template's CFG 4 / 30 steps / euler normal / SLG 0-1 with the int8 SFT and w4a8 TE, or the re-packager's CFG 5 / simple? Not run live.
- Is akhaliq HQ v5 (trained with 512 px vision) correct on core's fixed 384x384 vision scaling?
- Licence of the edit LoRA weights: none stated on chinoll's repo (the project code is GPL-3.0; the Comfy-Org repo card says apache-2.0). Does the recipe's download link need a licence note?
- Does the MOSI API Platform (platform.mosi.cn -> platform.moss.cn) offer a MOSS edit endpoint? The page is JS-rendered and was not read.
- Does Scumble's comfyRefSpec identity trace accept two TextEncodeMOSSImageEdit nodes (positive and negative) reading the same ImageFromBatch slots, as it does for Klein's two ReferenceLatent chains?
- One local recipe or two? A separate moss_image_edit_local next to moss_image_local (Generate new + boxes) is suggested; boxes on an edit are untrained.
