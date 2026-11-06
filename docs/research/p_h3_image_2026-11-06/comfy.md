# comfy

## Summary

P-H3-Image is Pruna AI's finetune of MiniMax-H3, MiniMax's video-and-audio model. The "H3" packs on the user's machine are tools for that video model, and P-H3 needs none of them. The user's ComfyUI v0.44.0 runs P-H3 on its own core nodes, with no custom pack: kijai's PR #17506 (merged 2026-11-03) is in v0.44.0. It adds `PH3ImageConditioning`, the P-H3 VAE and the P-H3 text encoder, and those files exist in the user's install.

**Graph:** UNETLoader → (LoRA) → MiniMaxH3SigmaShift with both shifts at 1.0 → BasicGuider. The text encoder loads with CLIPLoader type `minimax`, the VAE with VAELoader. `PH3ImageConditioning` takes the prompt and `images.image_1` (the picture being edited) plus up to 8 more slots, and gives the conditioning and the latent. The latent goes to SamplerCustomAdvanced with ManualSigmas (8 fixed steps), the `euler` sampler (Comfy's templates use `er_sde`) and RandomNoise, then to VAEDecode. There is no CFG, no negative prompt and no mask input. An optional prompt upsampler runs through TextGenerate and ComfySwitchNode.

**Two ways to get the weights:**
- **LoRA route** (Comfy's official templates): the user already has `minimax_h3_fl2va_pruned_int8_convrot.safetensors`. Missing are `p-h3-image_lora_bf16` (2.0 GB), `p-h3-image_text_encoder_int8_convrot` (5.1 GB), `p-h3-image_vae_int8_convrot` (3.1 GB) and the optional upsampler `p-h3-image_prompt_upsampler_w4a8` (6.7 GB). That is about 17 GB, or 10 GB without the upsampler.
- **Separate model route:** the P-H3 diffusion model as its own file, 13.4 GB (w4a8) or 21.2 GB (int8).

The user's own Qwen3-VL-4B files and MiniMax H3 VAEs cannot stand in for the P-H3 ones.

**Comfy Cloud** can run it: the node is in the live catalog, all 12 P-H3 files and the FL2VA base are in its model catalog, and there are two templates (`image_p_h3_t2i`, `image_p_h3_image_edit`). No API (partner) node serves P-H3.

**Fit for Scumble:** Pruna says edits work best at 4 or 8 MP, while Scumble's crops are about 1 MP today. The machine is an RTX 5090 with 32 GB. The int8 set peaks at about 31 GB at 8 MP; the w4a8 set at about 21 GB.

**Licence:** P-H3-Image and the MiniMax-H3 base both exclude the EU, UK, Korea and US from the licence. That needs the user's attention.

## Report

## P-H3-Image in ComfyUI: core support, the graph, files, Comfy Cloud

Tags: **read** = seen in a file or page; **inferred** = concluded from what was read; **unverified** = not checked. Today is 2026-11-06; all web reads are from today. Nothing was run, and no weights were downloaded. I fetched model cards, workflow JSONs and configs (under 100 KB) into `C:/Users/SCHOEN~1/AppData/Local/Temp/claude/F--canvas/543d44fb-4d2d-4818-8804-974916d10a44/scratchpad/ph3_comfy/hf/` and `.../ph3_comfy/tpl/`.

### 1. What P-H3-Image is, and whether "H3" is related
- **It is MiniMax-H3.** The HF API lists `base_model:MiniMaxAI/MiniMax-H3` with `base_model_relation: finetune`, `library_name: diffusers`, created 2026-10-27 (https://huggingface.co/api/models/PrunaAI/P-H3-Image). **read**
- The transformer config's `_class_name` is `MiniMaxH3Transformer3DModel` (hidden 5376, 50 layers, `text_dim` 5120, `in_channels` 24) (`hf/transformer_config.json`). The diffusers pipeline still has an `audio_scheduler` (`hf/modular_model_index.json`). **read**
- MiniMax-H3 itself is an image-text-to-video model (HF pipeline tag; created 2026-07-28). ComfyUI's H3 module docstring describes joint video and audio latents ("t2va / fl2va / ref2va") (`ComfyUI/comfy_extras/nodes_minimax_h3.py:1-9`). **read**
- **The user's H3 packs are video tools, and P-H3 needs none of them.** Read from their READMEs and pyproject files only:
  - `Comfyui-MMH3-UltimateUpscale` (bbaudio-2025, 0.0.5): a tiled AV-latent video upscaler.
  - `Comfyui_Minimax_h3_latent_Upscaler`: a video latent upscaler.
  - `comfyui-minimax-h3-audio-T8` (T8mars, 1.101.0): AV, lip sync and long-video nodes.
  - `TE-Speed-MiniMaxH3-OSS`: a step cache that asks for a patch to core `model.py`.

  None mentions PH3 (grep found nothing). **read**
- **The TE-Speed patch is not applied.** `comfy/ldm/minimax/model.py` contains no `_run_blocks` or `block_loop`, and there is no `.te_speed.bak` file. The core is stock. **read**
- **Two names that are not this model:**
  - `IdeogramPImage` ("Ideogram & Pruna P-Image") on Comfy Cloud is a different model.
  - Pruna's partner nodes in v0.44.0 (`comfy_api_nodes/apis/pruna.py`) are P-Video ones.

  **read**

### 2. Core support in the user's ComfyUI v0.44.0, without any custom pack
- The local version is 0.44.0 (`ComfyUI/comfyui_version.py`; log `user/comfyui.log` 2026-11-06 02:56: "ComfyUI version: 0.44.0", RTX 5090, 32,607 MB VRAM, 97 GB RAM, comfy_kitchen cuda backend available). **read**
- **The upstream change** is "feat: Support PH3Image (CORE-697)" by kijai, PR https://github.com/Comfy-Org/ComfyUI/pull/17506, merged 2026-11-03T15:38Z. **read**
  - It touched four files: `comfy/ldm/minimax/vae.py`, `comfy/sd.py`, `comfy/text_encoders/minimax.py` and `comfy_extras/nodes_minimax_h3.py` (`gh pr view`).
  - It is listed in the v0.44.0 notes; v0.44.0 was published 2026-11-04T01:12Z and is "Latest" (`gh release`).
  - No master commit has touched those files since.
  - The v0.44.1 backport PR #17550 was closed and carries no P-H3 changes.
- **What the user's local files hold:**
  - `PH3ImageConditioning`, display name "p-h3-image Conditioning" (`nodes_minimax_h3.py:681-738`). It is registered in the extension list (`:744`), and `nodes_minimax_h3.py` is in core's extras list (`nodes.py:2478`). **read**
  - The VAE `PH3ImageVAE`, described as "the H3 encoder with a single-frame decoder" (`comfy/ldm/minimax/vae.py:1014-1033`). It refuses latents with more than one frame. Encoding uses a fixed posterior seed of 42 (`vae.py:22,1026`). It is detected by `decoder.proj_out.weight` with shape[0] == 768 (`comfy/sd.py:1054-1057`). **read**
  - The text encoder: CLIP type `MINIMAX` plus a `text_connector.proj.weight` in the file means "Qwen3-VL-4B, 5-layer tap -> text connector -> 5120" (`sd.py:2070-2073`; `text_encoders/minimax.py:38-40,130-175,254`). **read**
  - The diffusion model is detected as `minimax_h3` (`model_detection.py:401-403`; `supported_models.py:986`), so it loads as the H3 DiT. **read**
  - `VAEDecode` takes the video part of the nested latent (`nodes.py:338-346`), so no audio VAE is needed. **read**
  - No custom-node import failure involves H3 or PH3 in today's log. **read**
- **Every node class in Pruna's and Comfy's P-H3 workflows exists in v0.44.0.** I grepped each `node_id`: TextGenerate / TextGenerateV2 (`nodes_textgen.py`), ResolutionSelector, ComfySwitchNode, BatchImagesNode, ResizeAndPadImage, ManualSigmas, PreviewAny, PrimitiveStringMultiline, StringFormat, GetImageSize, ImageScaleToTotalPixels, MiniMaxH3SigmaShift. `LoraLoaderModelOnly` is at `nodes.py:761`, `LoraLoaderBypassModelOnly` at `comfy_extras/nodes_lora_debug.py:57`. **read**
- **A stale line in Pruna's own card:** it says support "ships with the next release" and that Desktop and Cloud follow stable releases (Comfy card README lines 80-81). That release is v0.44.0, which is out. **read** for the card text, **inferred** for the conclusion.
- **`TextGenerate` (the node the Scumble Klein recipe uses) is deprecated but still registered.** Its display name is "Generate Text (DEPRECATED)" (`nodes_textgen.py:115-116`), and a frontend replacement maps it to `TextGenerateV2` (`nodes_replacements.py:96-111`). **read**

### 3. What a local recipe graph needs, node by node
Sources:
- Pruna's workflows `PrunaAI/P-H3-Image-Comfy/workflows/p-h3-image_{text_to_image,edit,lora_text_to_image,lora_edit}.json`. **read**
- Comfy-Org's templates `templates/image_p_h3_{t2i,image_edit}.json`: `minComfyUIVersion` 0.44.0, date 2026-11-03, repo `Comfy-Org/workflow_templates`, commit `c9700cbcc` "Template update 2026-11-03". **read**

A sketch of the edit graph in API form, never run, is at `C:/Users/SCHOEN~1/AppData/Local/Temp/claude/F--canvas/543d44fb-4d2d-4818-8804-974916d10a44/scratchpad/ph3_comfy/ph3_edit_api_sketch.json`.

**Model**
- Pruna's own route: `UNETLoader` with `p-h3-image_{bf16|int8_convrot|w4a8}.safetensors`.
- LoRA route: `UNETLoader` with `minimax_h3_fl2va_pruned_int8_convrot.safetensors`, then `LoraLoaderModelOnly` with `p-h3-image_lora_bf16.safetensors` at strength 1.0. This is Comfy's template; Pruna's LoRA workflows use `LoraLoaderBypassModelOnly`.
- Then `MiniMaxH3SigmaShift` with `shift_video` 1.0 and `shift_audio` 1.0. The node's defaults are 12 and 3 (`nodes_minimax_h3.py:396-397`), and PH3ImageConditioning's description says "The model needs ModelSamplingMiniMaxH3 at 1.0/1.0" (`:689`). **read**

**Text encoder**
- `CLIPLoader` with `p-h3-image_text_encoder_*.safetensors`, `type: "minimax"`. **read**
- **The user's Qwen3-VL-4B files cannot stand in.** `qwen3vl_4b_bf16`, `f3_qwen3vl_4b` and `qwen_3_4b` have no text connector, so `sd.py:2070` would not take the P-H3 branch. **inferred**

**VAE**
- `VAELoader` with `p-h3-image_vae_{bf16|int8_convrot}.safetensors`. **read**
- **The user's `minimax_h3_video_vae_*` files cannot stand in.** They would load as `MiniMaxH3VideoVAE` (`sd.py:1059`), not as the single-frame P-H3 VAE. **inferred**

**`PH3ImageConditioning`** (`nodes_minimax_h3.py:692-737`). **read**
- Inputs:
  - `clip`.
  - `vae`: optional, but required as soon as images are connected.
  - `prompt`.
  - `width` and `height`: step 32; 0 means image_1's size after scaling, or 2912 x 2912 with no images.
  - Autogrow slots `images.image_1` … `images.image_9`: separate top-level API entries, per the Comfy Cloud `get_node` hint.
- Outputs: `positive` CONDITIONING and a LATENT.
- Behaviour:
  - Only the first frame of each slot is used (`[:1]`), so every reference needs its own slot.
  - `image_1` is the picture being edited and the others are references.
  - Images are scaled down only, to fit the target area, on a 32 px grid.
  - The upsampler's view of each image is 1 MP (`PH3_IMAGE_VISION_PIXELS`, `:39`).
  - With images, the prompt gets `"Edit <Picture 1>. "` in front, unless it already starts with `Edit <Picture N>` or `subject_definitions:` (`:40-42,724`).
  - The latent is a nested video+audio still: `_av_latent(w, h, 1, 2)` (`:96-100,737`).
- **Consequences for a recipe:** use the conditioning's own LATENT output; SetLatentNoiseMask and EmptyLatent nodes do not fit, and there is no mask input. The model re-renders the whole crop, as Klein and Qwen edit do. **inferred**

**Sampling**
- `ManualSigmas` "1.0, 0.984753, 0.967905, 0.951688, 0.925372, 0.881923, 0.810083, 0.528718, 0.0": eight steps, the same grid as diffusers' `sample_sigmas`.
- `BasicGuider`: no CFG and no negative prompt.
- `KSamplerSelect`: `euler` in Pruna's workflows, `er_sde` in Comfy's templates.
- `RandomNoise`, `SamplerCustomAdvanced` (taking the conditioning's output 1 as `latent_image`), `VAEDecode`.

**read** for all of the above.

**Sizes**
- Text to image: 8 MP recommended (2912², 3360x2496, 3872x2176 …). Edits: 4 MP or 8 MP; Pruna's edit graphs scale image_1 to 4 MP with `ImageScaleToTotalPixels` (lanczos, 4, steps 32).
- Pruna: "At 2 and 4 MP, artifacts are more frequent, especially in faces, hands, and small details" (main card).
- Comfy's edit template keeps the source size: the scale node is bypassed, and `GetImageSize` feeds width and height.

**read**. Scumble crops at `target_size` 1024 (`F:/canvas/recipes/flux3_klein_local.json` canvas node), so a P-H3 recipe should scale `image_1` up or render a larger crop. **inferred**

**Prompt upsampler (optional)**
- `CLIPLoader` with `p-h3-image_prompt_upsampler_*`, type `minimax`. It loads through the generic Qwen3.5-9B branch (`sd.py:2040-2048`). **read**
- Generation: `TextGenerate`, greedy (`sampling_mode` "off"). **read**
  - Text to image: input `Aspect ratio: 1:1\nRequest: {a}`, `thinking` true, `max_length` 2048.
  - Pruna's edit: a raw chat block `<|im_start|>user\n<Picture 1>: <|vision_start|><|image_pad|><|vision_end|>…Edit <Picture 1>. {a}<|im_end|>\n<|im_start|>assistant\n<think>\n`, with `max_length` 3072. The images go in through `BatchImagesNode`: image_1 at 1 MP, the references padded to its size with `ResizeAndPadImage`.
  - Comfy's edit template: `TextGenerateV2` with `images.image1`, the prompt `Aspect ratio …\nRequest …`, `thinking` true, `max_length` 1536.
- A raw `<|im_start|>` prompt skips the template, and the `<|image_pad|>` tokens take the images in order (`comfy/text_encoders/qwen35.py:1208-1239`). `TextGenerate` splits the reasoning at `</think>` (`nodes_textgen.py:90-91`). **read**
- Then `ComfySwitchNode` ("Use prompt upsampler") and `PreviewAny`. **read**
- **Not the FLUX 3 upsampler.** The P-H3 upsampler is P-H3's own Qwen3.5-9B finetune ("The p-h3-image prompt upsampler, based on Qwen3.5-9B", `hf/NOTICE`). Its w4a8 file is 6,724,096,116 bytes; the user's `qwen3.5_9b_flux3_prompt_upsampler_w4a8.safetensors` is 6,724,090,780 bytes. **read** for both. Whether the weights are the same is **unverified**; they are probably different (**inferred**).

**Reference naming for Scumble:** P-H3 names pictures `<Picture N>`, 1-based, with image_1 being Picture 1. Scumble's `refs.name` allows `{n}` (1-based) (`F:/canvas/electron/main/providers/refs.js:31`), so `"<Picture {n}>"` fits. **inferred**

**Limits:**
- Up to 9 image slots on the node (`:700-701`), but Pruna documents "image_1 … followed by up to 7 references" (Comfy card). **read**
- Batch size 1 (**inferred** from `[:1]`).

### 4. The user's models folder (names and sizes only)
- `diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors`, 20,970,379,616 bytes. Its size is exactly that of `Comfy-Org/MiniMax-H3/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors` (HF tree), which is the base Comfy's P-H3 templates use. **read**
- Other H3 files on the machine:
  - `diffusion_models/minimax_h3_ref2va_pruned_int8_convrot`.
  - `clip/qwen3vl_32b_minimax_h3_nvfp4_awq (1)`.
  - `vae/minimax_h3_{video_vae_fp16,video_vae_int8_convrot,audio_vae_fp32}`.
  - `latent_upscale_models/minimax_h3_latent_upscaler_3d_bf16`.
  - `loras/h3/…fl2v_turbo_4step…` and `loras/minimax/…`.

  None of these is P-H3-specific. **read**
- **No `p-h3-image_*` file exists in any models folder** (diffusion_models, text_encoders, clip, vae, loras). **read**

**What the user would need to download (sizes from the HF tree, https://huggingface.co/api/models/PrunaAI/P-H3-Image-Comfy/tree/main):**
- **LoRA route** (Comfy's official templates). **read** for the files and sizes; the totals are **inferred**.
  - `loras/p-h3-image_lora_bf16.safetensors`: 1,956,195,360 bytes.
  - `text_encoders/p-h3-image_text_encoder_int8_convrot.safetensors`: 5,120,870,504 bytes.
  - `vae/p-h3-image_vae_int8_convrot.safetensors`: 3,146,996,440 bytes.
  - Optional `text_encoders/p-h3-image_prompt_upsampler_w4a8.safetensors`: 6,724,096,116 bytes.
  - About 16.9 GB in all, or 10.2 GB without the upsampler.
- **Pruna's separate-model route:**
  - `p-h3-image_int8_convrot` (21.2 GB) or `p-h3-image_w4a8` (13.4 GB), plus the same text encoder, VAE and upsampler.
  - Pruna's figures: int8 set 30 GB download, about 31 GB peak VRAM at 8 MP; w4a8 + int8 VAE 20 GB, about 21 GB peak. **read**
  - Pruna's bf16 Comfy diffusion file (40.5 GB) is about the size of `fl2va_pruned_bf16` (40.2 GB), so it is probably pruned too. **inferred**
- **On "the LoRA works on the pruned model":** Pruna's card says "the pruned and quantized FL2VA files work too" (Comfy card README 226-229). Comfy's templates use exactly pruned int8 + LoRA. **read**
- **Not established:** whether the LoRA route matches the separate model in quality or speed (LoRA patched onto int8_convrot weights). **unverified**
- **VRAM fit on the 32 GB RTX 5090:** about 31 GB peak for int8 at 8 MP is tight; edits at 4 MP should peak lower. **inferred**. ComfyUI swaps the upsampler out before the DiT runs (Comfy card README). **read**

### 5. Community packs and other files
- **No custom pack is needed.** Pruna's card: "ComfyUI supports the model natively and the workflows use only ComfyUI's own nodes". **read**
- **GitHub search ("p-h3-image")** finds only fresh small repos (`shisa84/ComfyUI-P-H3ImageLookSheets`, `HyperGAN/p-h3-image-particle-sliders`, `artvandelay18160/H3-image-prep`). None is needed. **read**, not inspected.
- **Optional extras:**
  - GGUF quants `vantagewithai/P-H3-Image-ComfyUI-GGUF` (Q3_K_M to Q6_K, 2026-11-04). These need ComfyUI-GGUF, which the user has installed.
  - A 4-step turbo LoRA `akhaliq/p-h3-image-turbo-lora` (2026-11-05).

  **read** for the file lists; **unverified** in use.

### 6. Comfy Cloud (read-only MCP lookups; server cloud.comfy.org, production, 0.83.1)
- **Nodes:** `PH3ImageConditioning`, `MiniMaxH3SigmaShift`, `TextGenerateV2` and `ManualSigmas` are in the live catalog (refreshed 2026-11-06T02:54Z, 3,871 nodes). Their specs match v0.44.0. **read**
- **Models:** the model catalog lists all 12 P-H3 files (bf16 / int8_convrot / w4a8 diffusion models, the LoRA, text encoders, VAEs, the upsampler in three precisions) and `minimax_h3_fl2va_pruned_int8_convrot.safetensors`, all `source: comfy-cloud`. **read**
  - The CLIPLoader combo returned by `get_node` does not list the P-H3 text encoder. Cloud combos are known to be incomplete (memory note `comfy-cloud-mcp-lookups`), so that is not proof the file is missing. **inferred**
- **Templates:** `image_p_h3_t2i` and `image_p_h3_image_edit` exist; the index says "up to 9 reference images". **read**
- **No partner/API node for P-H3:** Pruna's partner nodes are P-Video; IdeogramPImage is a different model. **read**
- **So Comfy Cloud can run a P-H3 graph made of core nodes only**, the shape Scumble's `comfycloud.js` sends for recipes without the Inpaint Canvas node. **inferred**; not run.

### 7. Licence (for the user, not legal advice)
- **The licence excludes the EU.** `LICENSE` of PrunaAI/P-H3-Image-Comfy, line 10: "Excluded Territories" means the European Union, the United Kingdom, the Republic of Korea and the United States of America. Line 42: no use "outside the Applicable Territory". **read**
- **Notice duties:** "Powered by MiniMax H3" for distributed works (line 29), and "MiniMax H3" on the UI of a commercial product (line 37). **read**
- **The base model has the same clause.** MiniMaxAI/MiniMax-H3's LICENSE has the identical Excluded-Territories line, so the H3 models the user already runs are under the same terms. **read**
- The Qwen parts (text encoder parts, upsampler) are Apache-2.0 (`hf/NOTICE`). **read**

## Facts

- [read] P-H3-Image is a finetune of MiniMaxAI/MiniMax-H3 (HF base_model_relation finetune), created 2026-10-27, transformer class MiniMaxH3Transformer3DModel (https://huggingface.co/api/models/PrunaAI/P-H3-Image (2026-11-06); hf/transformer_config.json in the scratch folder)
- [read] Native P-H3-Image support is kijai's PR #17506 'feat: Support PH3Image (CORE-697)', merged 2026-11-03T15:38Z, touching vae.py, sd.py, text_encoders/minimax.py, nodes_minimax_h3.py; it is in v0.44.0 (published 2026-11-04T01:12Z); no master commits on those files since (gh pr view 17506 / gh release view v0.44.0 --repo Comfy-Org/ComfyUI; gh api commits?path=... (2026-11-06))
- [read] The user's ComfyUI is 0.44.0 and contains PH3ImageConditioning (display 'p-h3-image Conditioning'), registered through nodes_minimax_h3.py in core's extras list (F:/Comfyui/ComfyUI_windows_portable_nvidia/ComfyUI/comfyui_version.py; comfy_extras/nodes_minimax_h3.py:681-746; nodes.py:2478)
- [read] PH3ImageConditioning inputs: clip, optional vae (required with images), prompt, width/height (step 32, 0 = image_1 size or 2912), Autogrow images.image_1..image_9; outputs positive CONDITIONING and a nested AV LATENT (1 video frame, 2 audio latents); only the first frame per slot is used; no mask input (comfy_extras/nodes_minimax_h3.py:692-737, 96-100)
- [read] With images, PH3ImageConditioning prefixes 'Edit <Picture 1>. ' unless the prompt starts with 'Edit <Picture N>' or 'subject_definitions:'; the vision copies are scaled to 1 MP (comfy_extras/nodes_minimax_h3.py:39-42, 719, 724)
- [read] The model must run with MiniMaxH3SigmaShift at shift_video 1.0 and shift_audio 1.0 (node defaults 12 and 3) (comfy_extras/nodes_minimax_h3.py:389-397, 689)
- [read] Sampling in the official graphs: ManualSigmas '1.0, 0.984753, 0.967905, 0.951688, 0.925372, 0.881923, 0.810083, 0.528718, 0.0' (8 steps), BasicGuider (no CFG or negative), SamplerCustomAdvanced; sampler euler in Pruna's workflows, er_sde in Comfy's templates (PrunaAI/P-H3-Image-Comfy workflows/*.json; Comfy-Org/workflow_templates templates/image_p_h3_*.json (2026-11-06))
- [read] The P-H3 text encoder is detected by CLIP type minimax plus text_connector.proj.weight (Qwen3-VL-4B, 5-layer tap -> 5120); the P-H3 VAE by decoder.proj_out.weight with 768 rows, loading PH3ImageVAE with a single-frame decoder (comfy/sd.py:2070-2073, 1054-1057; comfy/ldm/minimax/vae.py:1014-1033)
- [inferred] The user's plain Qwen3-VL-4B files and MiniMax H3 video VAEs cannot stand in for the P-H3 text encoder and VAE (comfy/sd.py:2070 (needs text_connector), sd.py:1057-1059 (different VAE classes))
- [read] Every node class used by Pruna's and Comfy's P-H3 workflows exists in v0.44.0 core; TextGenerate is deprecated (display 'Generate Text (DEPRECATED)') but still registered (grep of node_id in comfy_extras/*.py and nodes.py; nodes_textgen.py:115-116; nodes_replacements.py:96-111)
- [read] The user has minimax_h3_fl2va_pruned_int8_convrot.safetensors (20,970,379,616 bytes, same size as Comfy-Org/MiniMax-H3's file), which is the base model of Comfy's official P-H3 templates (LoRA route) (ls models/diffusion_models; https://huggingface.co/api/models/Comfy-Org/MiniMax-H3/tree/main; templates/image_p_h3_image_edit.json)
- [read] No p-h3-image_* file is in the user's models folders (ls of models/diffusion_models, text_encoders, clip, vae, loras (2026-11-06))
- [read] LoRA-route downloads: p-h3-image_lora_bf16 1,956,195,360 B; text_encoder_int8_convrot 5,120,870,504 B; vae_int8_convrot 3,146,996,440 B; optional prompt_upsampler_w4a8 6,724,096,116 B (about 16.9 GB, 10.2 GB without upsampler) (https://huggingface.co/api/models/PrunaAI/P-H3-Image-Comfy/tree/main (2026-11-06))
- [read] Pruna states the LoRA runs P-H3-Image on MiniMax-H3's FL2VA transformer and that pruned and quantized FL2VA files work too (PrunaAI/P-H3-Image-Comfy README.md lines 226-229 (2026-11-06))
- [read] Pruna recommends 8 MP for text to image and 4 or 8 MP for edits (image_1 scaled to 4 MP); 2 and 4 MP show more artifacts; sides are multiples of 32 (PrunaAI/P-H3-Image-Comfy README.md lines 168-181; PrunaAI/P-H3-Image model card)
- [read] VRAM per Pruna: int8 set about 31 GB peak at 8 MP, w4a8 + int8 VAE about 21 GB; the user's GPU is an RTX 5090 with 32,607 MB (PrunaAI/P-H3-Image-Comfy README; ComfyUI/user/comfyui.log 2026-11-06 02:56)
- [read] The P-H3 prompt upsampler is its own Qwen3.5-9B-based model; its w4a8 file (6,724,096,116 B) differs in size from the user's FLUX 3 upsampler w4a8 (6,724,090,780 B) (hf/NOTICE; HF tree; ls models/text_encoders)
- [read] A raw prompt starting with <|im_start|> skips the qwen35 chat template and the images fill <|image_pad|> tokens in order, so Pruna's edit upsampler format works (comfy/text_encoders/qwen35.py:1202-1239)
- [read] The user's H3 custom node packs (MMH3-UltimateUpscale, Minimax_h3_latent_Upscaler, minimax-h3-audio-T8, TE-Speed-MiniMaxH3-OSS) are MiniMax H3 video tools and do not mention P-H3; the TE-Speed core patch is not applied (custom_nodes/*/README.md and pyproject.toml; grep of comfy/ldm/minimax/model.py for _run_blocks/block_loop)
- [read] Comfy Cloud's live catalog has PH3ImageConditioning, MiniMaxH3SigmaShift, TextGenerateV2, ManualSigmas; its model catalog has all 12 p-h3-image files and minimax_h3_fl2va_pruned_int8_convrot; templates image_p_h3_t2i and image_p_h3_image_edit exist (minComfyUIVersion 0.44.0) (Comfy Cloud MCP get_node / search_models / search_templates (catalog refreshed 2026-11-06T02:54Z); workflow_templates index.json)
- [read] No Comfy partner (API) node serves P-H3-Image; Pruna's partner nodes are P-Video, IdeogramPImage is a different model (Comfy Cloud MCP search_nodes q=pruna (2026-11-06))
- [inferred] Comfy Cloud can run a P-H3 graph of core nodes as Scumble sends for recipes without the Inpaint Canvas node (node and model catalogs above; CLAUDE.md on comfycloud.js)
- [read] The MiniMax H3 Community License (P-H3-Image and the MiniMax-H3 base) excludes the EU, UK, Republic of Korea and US from the licensed territory and forbids use outside it; products must show 'Powered by MiniMax H3' (PrunaAI/P-H3-Image(-Comfy) LICENSE lines 10, 29, 37, 42; MiniMaxAI/MiniMax-H3 LICENSE line 10 (2026-11-06))
- [inferred] Scumble's refs.name accepts {n} (1-based), so '<Picture {n}>' matches P-H3's picture naming (F:/canvas/electron/main/providers/refs.js:31)
- [unverified] LoRA route vs Pruna's own P-H3 diffusion model are equal in quality and speed (not checked)

## Open questions

- Licence: the MiniMax H3 Community License (P-H3 and the H3 base the user already runs) excludes the EU, the UK, Korea and the US. Does the user want a P-H3 recipe in Scumble, which has users in those regions, and does the 'Powered by MiniMax H3' notice belong on the recipe or in the About dialog? That is the user's call, maybe a lawyer's.
- Which weights: the LoRA route on the user's minimax_h3_fl2va_pruned_int8_convrot (about 17 GB to download, or 10 GB without the upsampler; Comfy's choice) or Pruna's own int8 or w4a8 model (21.2 / 13.4 GB more)? Quality and speed of the LoRA patched onto int8_convrot weights are unverified.
- Edit size: Scumble crops at about 1 MP (target_size 1024), while Pruna recommends 4 MP edits and warns about artifacts at 2 to 4 MP. Should the recipe scale image_1 to 4 MP (ImageScaleToTotalPixels 4, step 32) and let the stitch scale the result back, or should Scumble render a larger crop?
- Sampler: euler (Pruna's workflows) or er_sde (Comfy's templates)?
- Upsampler edit format: Pruna's raw chat block with <Picture N> labels and an open <think>, or Comfy's 'Aspect ratio / Request' with TextGenerateV2 and thinking on? Should the switch default to on, as in Klein's recipe?
- Reference slots: should the recipe allow 8 pictures in all (Pruna: image_1 plus 7 references) or 9 (the node's slot count, Comfy's index text)?
- VRAM on the 32 GB RTX 5090: does the int8 LoRA route at 4 MP stay under 32 GB with the upsampler swapped out? This needs a live run on the user's word; the user's ComfyUI is a production machine.
- Downloads of the P-H3 files to the user's ComfyUI: only on the user's yes.
