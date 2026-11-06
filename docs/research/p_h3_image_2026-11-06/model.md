# model

## Summary

P-H3-Image is Pruna AI's open-weights image model, published 3 Nov 2026. It is a fine-tune ("finetune") of MiniMax H3, which is a 33B text/image-to-video+audio model. So "H3" in the user's custom-node names is the same family: those packs are for H3 video, and P-H3-Image derives from H3. It does text-to-image and instruction editing of Picture 1, with references as `<Picture 2>`..`<Picture N>`. The card says 1-8 images; the ComfyUI node takes 9 slots. There is no mask or inpainting input, so in Scumble it would be an edit-the-crop recipe like Klein or Qwen Edit, composited by Scumble's own mask.

Sampling is fixed: 8 steps on a set sigma grid, no CFG and no negative prompt, euler, ModelSamplingMiniMaxH3 at 1.0/1.0. It works best at 8 MP; edits want 4 or 8 MP, sides a multiple of 32. It comes with a Qwen3.5-9B prompt upsampler that is on by default.

Pruna changed four parts of H3:
- **Text encoder:** cut from 32B to 4B by distillation, plus a connector.
- **Transformer:** the adaLN branch was swapped out, taking it from 33B to 20B in the ComfyUI files.
- **Decoder:** a new decoder that turns one frame into one image.
- **Steps:** DMD distillation, from 50 steps to 8.

ComfyUI supports it natively since v0.44.0 (PR #17506), and the user's ComfyUI is on that version. Pruna ships four official workflows; Comfy Cloud has the models and two templates.

On the user's RTX 5090 (32 GB), the smallest set fits: about 20 GB download, about 21 GB VRAM peak at 8 MP. There is also a cheaper route. The user already has `minimax_h3_fl2va_pruned_int8_convrot.safetensors`, and Comfy Cloud's own templates run that file with a 2 GB P-H3-Image LoRA. That route still needs the P-H3-Image text encoder, VAE and upsampler.

**Licence: this is the blocker.** It is the MiniMax H3 Community License. It excludes the EU, UK, South Korea and the US, and forbids use, distribution or display of the model or its outputs there without a separate licence from MiniMax. The user is in Germany. Commercial use is allowed only inside the permitted territory, with written permission needed above $20M revenue. A commercial UI must show "MiniMax H3". The repos are not gated. I found no hosted API on Replicate, fal, WaveSpeed or Pruna's own site.

## Report

# P-H3-Image (PrunaAI): the model, for a Scumble recipe

Everything was read 2026-11-06. Scratch copies of the cards, licence, configs, workflows, Cloud templates and blog text are in `C:/Users/SCHOEN~1/AppData/Local/Temp/claude/F--canvas/543d44fb-4d2d-4818-8804-974916d10a44/scratchpad/ph3_model/` (helper scripts in `.../scratchpad/ph3_scripts/`). Nothing was written in F:\canvas or the ComfyUI folder. No weights were downloaded; for two safetensors files I read only the JSON header with a range request.

## 1. What it is, and how "H3" fits

- **Base model.** P-H3-Image is "image generation and editing based on MiniMax-H3". Its HF metadata says `base_model: MiniMaxAI/MiniMax-H3` and `base_model_relation: finetune`; the ComfyUI repo says `quantized` from `PrunaAI/p-h3-image`. Sources: https://huggingface.co/api/models/PrunaAI/P-H3-Image and .../P-H3-Image-Comfy (read).
- **What MiniMax H3 is.** An omni-modal video model with native stereo audio, up to 2K and 15 s. It ships as two checkpoints, H3-Base-FL2VA and H3-Base-Ref2VA. Source: https://huggingface.co/MiniMaxAI/MiniMax-H3 README (read). The licence itself defines "MiniMax H3" as "the video generation model" (LICENSE line 11, read).
- **Related to the user's packs.** The packs `Comfyui_Minimax_h3_latent_Upscaler`, `TE-Speed-MiniMaxH3-OSS`, `Comfyui-MMH3-UltimateUpscale` and `comfyui-minimax-h3-audio-T8` are all for H3 video, according to their READMEs under `custom_nodes/` (read). None of their `.py` files mention p-h3 (grep, read). They are the same model family but not needed for P-H3-Image.
- **The user already has H3 files.** These include `models/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors` at 20,970,379,616 bytes, which is byte-for-byte the size of the Comfy-Org/MiniMax-H3 file (that it is the same file is inferred). There are also two H3 video VAEs and `models/clip/qwen3vl_32b_minimax_h3_nvfp4_awq (1).safetensors` (directory listing, read).

## 2. Tasks

| Topic | Finding | Source / confidence |
|---|---|---|
| Text to image | Yes. Default size 2912 x 2912. | README lines 79-82, 140 (read) |
| Editing | Picture 1 is edited; the rest are references named `<Picture 2>`, `<Picture 3>`... The card says 1-8 images. | README 79, 125-127, 235-236 (read) |
| Image count | The ComfyUI node `PH3ImageConditioning` takes `image_1`..`image_9`; the blog intro says "up to 9 input images" and later "combine up to 8 references". | `comfy_extras/nodes_minimax_h3.py:700-701` (read); https://www.pruna.ai/blog/oss-p-h3-image-launch (read) |
| Mask / inpainting | None. The node's inputs are clip, vae, prompt, width, height, images; the diffusers doc describes instruction edits only. A Scumble recipe would therefore be "edit the crop, Scumble composites with its own mask". | `nodes_minimax_h3.py:691-702` (read); diffusers `docs/source/en/api/pipelines/p_h3_image.md:53` (read); Scumble consequence inferred |
| Video / audio | "Single images only." The ComfyUI latent is a still with two audio latents (`_av_latent(w,h,1,2)`). | README 311; `nodes_minimax_h3.py:730-731` (read) |
| Edit-prompt prefix | With images the node prepends `Edit <Picture 1>. `, unless the prompt already starts with `Edit <Picture N>` or `subject_definitions:` (the upsampler's brief). | `nodes_minimax_h3.py:40-42, 724` (read) |
| Hand-written edit form | `Edit <Picture 1>. <change as finished result>. Keep <...> exactly as it is.` | README 260-262 (read) |
| Without the upsampler | Short edit requests "often redraw the whole scene". | README 243-245 (read) |

## 3. Architecture and files

**Transformer**
- Class `MiniMaxH3Transformer3DModel`: 50 layers, hidden 5376, 56 heads x 128, ffn 14336, 24 input channels, patch [1,2,2], text_dim 5120, 2 refiner layers, `audio_in_channels` 32. Source: `transformer/config.json` (read).
- **Diffusers transformer:** 33.1B parameters in bf16, total_size 66,280,430,080 bytes in 7 shards. Source: transformer index json and HF `safetensors` field (read).
- **ComfyUI bf16 file:** 20.150B parameters (20.066B BF16 + 0.084B F32). Its `blocks.N.adaln_proj.linear.weight` is [96768, 16] in F32, against [96768, 2688] in diffusers, and it adds an `adaln_t_table`. Source: header of each file (read).
- The blog says the timestep block was replaced: "33B to 20B parameters". The H3 card says "~13B parameters residing in AdaLN-related branches ... can be precomputed". (read; that the header difference is exactly this replacement is inferred)

**Text encoder**
- Qwen3-VL-4B (hidden 2560, 36 layers). The hidden states [13,19,25,31,36] go through a `PH3ImageTextConnector` (262 MB) to 5120. Sources: `text_encoder/config.json`, `text_connector/config.json`; ComfyUI `comfy/text_encoders/minimax.py:38-40` (read).
- The blog says it was "reduced ... to 4B with distillation" from H3's 32B encoder: 9 GB instead of 67 GB. (read)
- In ComfyUI it loads with `CLIPLoader` type `minimax` and is detected by the key `text_connector.proj.weight`. Source: `comfy/sd.py:2070-2073` (read).

**VAE**
- H3's encoder (f16 spatial, 24 latent channels) with a new single-frame ViT decoder (36 layers). Sources: `vae/config.json`; `comfy/ldm/minimax/vae.py:1014-1032` (read).
- It "decodes single-frame image latents only", so H3's video VAE cannot replace it. Source: vae.py:1032 (read); "cannot replace" is inferred.
- ComfyUI detects it by `decoder.proj_out.weight` shape 768. Source: `comfy/sd.py:1054-1057` (read).

**Prompt upsampler**
- `Qwen3_5ForConditionalGeneration` (Qwen3.5-9B, 32 layers, vision tower), Apache-2.0. Sources: `prompt_upsampler/config.json`, NOTICE (read).

**Diffusers repo:** 99.85 GB in all. Transformer 66.28, upsampler 18.82, text encoder 8.88, VAE 5.56, connector 0.26 GB (sum of the tree API, read).

**ComfyUI repo** (https://huggingface.co/PrunaAI/P-H3-Image-Comfy, tree API, read):

| File | Bytes |
|---|---|
| diffusion_models/p-h3-image_bf16 | 40,468,411,160 |
| …_int8_convrot | 21,213,068,840 |
| …_w4a8 | 13,362,068,864 |
| text_encoders/p-h3-image_text_encoder_bf16 / int8_convrot / w4a8 | 9,138,027,824 / 5,120,870,504 / 3,575,536,021 |
| text_encoders/p-h3-image_prompt_upsampler_bf16 / int8_convrot / w4a8 | 19,306,305,552 / 9,748,117,724 / 6,724,096,116 |
| vae/p-h3-image_vae_bf16 / int8_convrot | 5,559,036,680 / 3,146,996,440 |
| loras/p-h3-image_lora_bf16 (for H3's FL2VA) | 1,956,195,360 |

The tree also gives the sha256 of every file: `.../scratchpad/ph3_model/comfy/tree.json`.

**Quantisation.** int8_convrot means Hadamard-rotated INT8 weights with per-row scales; w4a8 means 4-bit codebook weights with FP8 scales and INT8 activations. Both run on comfy-kitchen kernels, "NVIDIA Ampere or newer and AMD RDNA3/4". Source: Comfy README 139-145 (read).

## 4. Resolution and sampling

- **Sizes.** Best at 8 MP; 2-4 MP shows more artefacts. Sides are multiples of 32. Sources: README 139-144; `CANVAS_MULTIPLE = 32` at nodes_minimax_h3.py:31 (read). The blog says "renders images from 2 to 16 megapixels" (read).
- **8 MP sizes:** 1:1 2912x2912, 4:3 3360x2496, 3:4 2496x3360, 3:2 3552x2368, 2:3 2368x3552, 16:9 3872x2176, 9:16 2176x3872.
- **4 MP edit sizes:** 2048², 2368x1760, 1760x2368, 2496x1664, 1664x2496, 2720x1536, 1536x2720. Source: README 146-154 (read).
- **Edit canvas in diffusers.** The edit is made at Picture 1's size, scaled up to at least 4 MP (`canvas_min_pixels` 4,194,304). References are kept between 1 and 8 MP. The text encoder sees each image at about 1 MP. Sources: `modular_model_index.json`; diffusers doc line 53 (read).
- **Edit canvas in ComfyUI.** The node only scales down, to width x height or 2912², so a small crop stays small. Pruna's edit workflow therefore scales `image_1` to 4 MP first (`ImageScaleToTotalPixels` lanczos, 4, 32). Sources: nodes_minimax_h3.py:668-671, 714-729; `workflows/p-h3-image_edit.json` (read). For Scumble this means: scale the crop to 4 MP or more before the node (inferred).
- **Steps.** 8, `ManualSigmas` "1.0, 0.984753, 0.967905, 0.951688, 0.925372, 0.881923, 0.810083, 0.528718, 0.0", from DMD distillation of H3's 50 steps. Sources: `modular_model_index.json` `sample_sigmas`; workflows; blog (read).
- **CFG.** None. The model is guidance-distilled: no negative prompt, `BasicGuider`. Source: diffusers doc line 89; README 298-299 (read).
- **Sampler.** `euler` with `SamplerCustomAdvanced` in Pruna's workflows (read). Comfy Cloud's templates use `er_sde` (read).
- **Model sampling.** `MiniMaxH3SigmaShift` (display name "ModelSamplingMiniMaxH3") must be 1.0/1.0. Its defaults are 12/3, so a recipe has to set it. Source: nodes_minimax_h3.py:378-397, 690 (read).

## 5. Prompt upsampler (as Pruna wires it in ComfyUI)

- **Loader.** A second `CLIPLoader` type `minimax` with the upsampler file, feeding `TextGenerate`. That node is marked deprecated in v0.44.0 (`nodes_textgen.py:115-118`); `TextGenerateV2` replaces it and is what Comfy Cloud's templates use (read).
- **Text to image.** `StringFormat` builds `"Aspect ratio: 1:1\nRequest: {a}"`. TextGenerate runs with max_length 2048, sampling "off" (greedy), thinking true, default template on, mtp "auto". The aspect line must match `ResolutionSelector` (8 MP, multiple 32). Source: `workflows/p-h3-image_text_to_image.json` (read).
- **Edit.** A raw chat template with one `<Picture N>: <|vision_start|><|image_pad|><|vision_end|>` block per image, then `Edit <Picture 1>. {a}`, ending in `<think>\n`. max_length is 3072. The images go in through BatchImages: image_1 at 1 MP, references padded white to its size with `ResizeAndPadImage`. Source: `workflows/p-h3-image_edit.json` (read).
- **Switch.** `ComfySwitchNode` "Use prompt upsampler"; false sends the request as typed. Source: workflows (read).
- **Cost.** Upsampler bf16 is about 21 GB peak and about 7 s per prompt on an L40S; int8 12 GB / 13 s; w4a8 9 GB / 11 s. "The w4a8 prompts differ most." Source: Comfy README 202-208 (read).
- **Prompting rules.** Say what the image is; one scene; quote every text string and end with "no other text"; no hype words. Source: README 203-214 (read).

## 6. Speed and hardware (Pruna's numbers; nothing measured here)

- **Diffusers bf16.** About 101 GB GPU memory at 8 MP with the upsampler, 83 GB without. Auto offload fits one 80 GB GPU (about 76 GB peak). B200: about 9 s at 8 MP, and the upsampler adds 6-11 s. Source: README 82-84, 272-296 (read).
- **Blog, B200 bf16:** 4 MP 2.6 s (H3: 12.4 s); 8 MP 5.8 s (H3: 30.6 s). **L40S, 4 MP:** 6.3 s with the 4-bit set, 19 s bf16 offloaded (read).
- **ComfyUI sets at 8 MP:**

  | Set | Download | Peak VRAM |
  |---|---|---|
  | bf16 | 55 GB | 56 GB |
  | int8 | 30 GB | 31 GB |
  | w4a8 + int8 VAE | 20 GB | 21 GB |

  All "plus the prompt upsampler", which ComfyUI moves out of VRAM before the image model runs. Source: Comfy README 116-120, 199 (read).
- **This machine.** NVIDIA GeForce RTX 5090, 32,607 MiB, compute 12.0 (`nvidia-smi`, read). The w4a8 set fits (inferred). The int8 set's 31 GB peak is tight beside the 5 GB already in use (inferred, unmeasured). No timings for an RTX 5090 exist (unverified).

## 7. How Pruna says to run it

- **Diffusers.** A Modular Diffusers pipeline, `ModularPipeline.from_pretrained("PrunaAI/P-H3-Image")`, which needs diffusers from git. README 91-131 (read). diffusers PR #15171 "Add P-H3-Image" landed 2026-11-03 as commit c55ec2794 (`gh api`, read).
- **ComfyUI.** Native, "no custom nodes needed". ComfyUI PR #17506 "feat: Support PH3Image (CORE-697)" by kijai was merged 2026-11-03T15:38Z; v0.44.0 was published 2026-11-04T01:12Z (`gh`, read).
- **The user's ComfyUI** reports `comfyui_version.py` 0.44.0 and has `PH3ImageConditioning`, `MiniMaxH3SigmaShift`, `ResolutionSelector`, `TextGenerate`/`TextGenerateV2`, `ComfySwitchNode`, `StringFormat`, `BatchImagesNode`, `ResizeAndPadImage`, `LoraLoaderBypassModelOnly`, `ManualSigmas` (grep of `comfy_extras`, read). `comfy/ldm/minimax/model.py` does not carry the TE-Speed patch (grep for `_run_blocks`, read).
- **Official workflows** in https://huggingface.co/PrunaAI/P-H3-Image-Comfy `workflows/`: `p-h3-image_text_to_image.json`, `p-h3-image_edit.json`, `p-h3-image_lora_text_to_image.json`, `p-h3-image_lora_edit.json` (read).
  - Node chain: UNETLoader -> MiniMaxH3SigmaShift(1,1); CLIPLoader(minimax) x2; VAELoader; PH3ImageConditioning(clip, vae, images.image_N, prompt, width, height) -> positive + LATENT; BasicGuider, RandomNoise, KSamplerSelect(euler), ManualSigmas, SamplerCustomAdvanced, VAEDecode.
  - The LoRA workflows load `minimax_h3_fl2va_bf16.safetensors` with `LoraLoaderBypassModelOnly` at 1.0, plus the p-h3-image text encoder and VAE.
- **LoRA route.** "The pruned and quantized FL2VA files work too." Source: Comfy README 224-229 (read). That it gives the full P-H3-Image quality is Pruna's claim, not verified.
- **Comfy Cloud** (MCP lookups, read):
  - The catalog lists all 12 p-h3-image files. Its "recommended" fields (25 steps, cfg 7) are generic placeholders, not P-H3-Image's settings.
  - The live catalog has `PH3ImageConditioning` and `MiniMaxH3SigmaShift`.
  - Two templates, both dated 2026-11-03: `image_p_h3_t2i` and `image_p_h3_image_edit` (https://cloud.comfy.org/templates/image_p_h3_image_edit.json).
  - Both templates run **`minimax_h3_fl2va_pruned_int8_convrot` + `LoraLoaderModelOnly` p-h3-image_lora_bf16 at 1.0**, with the text encoder int8, VAE int8, upsampler w4a8, `TextGenerateV2` (max 1536, greedy, thinking on), `er_sde`.
  - The Cloud edit template uses the "Aspect ratio / Request" form for edits too.
- **Hosted API.** None found. Replicate, fal, WaveSpeed and pruna.ai URL guesses return 404, and searches had no hits (absence only, unverified). There is a demo Space, https://huggingface.co/spaces/PrunaAI/P-H3-Image (gradio, ZeroGPU, created 2026-11-03; read). The cards point to Pruna's paid P-Image models, not to a P-H3-Image API (read).

## 8. Licence (read in full; the three LICENSE files are byte-identical by sha256)

- **Name.** "MiniMax H3 Community License Agreement", licence date August 2, 2026. Licensor Nanonoble Pte. Ltd.; Hong Kong law and courts (LICENSE lines 1-2, 15, 57-58). The Qwen3-VL-4B parts and the upsampler are Apache-2.0 (NOTICE). The blog says "The ComfyUI nodes are MIT-licensed" (read; unclear, since the nodes live in GPL-3.0 ComfyUI core).
- **Territory.**
  - "Applicable Territory" is worldwide **excluding the European Union, the United Kingdom, the Republic of Korea and the United States** (lines 3, 8, 10).
  - V.4: "You may not use, reproduce, modify, distribute, or display the MiniMax H3 Works or any of their Outputs or results outside the Applicable Territory" (line 42). AUP item 1 repeats it (line 65).
  - P-H3-Image is a "Model Derivative" (line 16), so all of this applies to it; Pruna says so too.
  - **The user is in Germany, so without MiniMax's separate licence there is no grant to run it or show its outputs** (read).
  - MiniMax's application form for EU/UK/US/KR is https://platform.minimax.io/h3-license. Their Q&A calls the limit "not yet, not ever" (MiniMax-H3 `docs/QA-about-License.md`, read).
  - The same restriction covers the H3 files already on the user's machine (inferred from the definitions).
- **Commercial use.** Allowed within the territory. Above US $20M yearly revenue, written authorisation is needed (IV.1). A commercial product's UI must "prominently display 'MiniMax H3'" (IV.2).
- **"Powered by MiniMax H3".** In the licence this is only "encouraged" (III.3.a), as are an AI-generation identifier and a blog post. Pruna's cards and blog say products "must show" it, which is stronger than III.3 (read; the difference is mine to point out).
- **Distribution conditions.** Give a copy of the agreement, mark modified files, and ship the NOTICE text "MiniMax H3 is licensed under ... Copyright © 2026 MiniMax. All Rights Reserved." (III.1-4).
- **Obligations on products.**
  - Before giving access to a product incorporating the Works, bind every user to terms at least as protective as section V and the AUP (V.2).
  - No use of outputs to improve other models (V.3).
  - A product that lets third parties generate outputs needs safeguards, a reporting mechanism and takedown (V.5).
  - Whether a Scumble recipe that names the files but ships no weights counts as "providing access" is a legal question (inferred, unresolved).
- **AUP highlights.** Disclose machine-generated content posted publicly (12); no military use (19); "violates ... standards of other countries or regions" (15, vague).
- **Gating.** `gated: false` on both repos and on MiniMax-H3 (HF API, read).

## 9. Dates

| Event | Date | Source |
|---|---|---|
| MiniMax-H3 repo created | 2026-07-28 | HF API |
| MiniMax-H3 licence date | 2026-08-02 | LICENSE |
| P-H3-Image repos created | 2026-10-27 / 2026-10-28 | HF API |
| Blog, diffusers merge, ComfyUI merge, Space, Cloud templates | 2026-11-03 | sources above |
| ComfyUI v0.44.0 | 2026-11-04 | `gh` |

Downloads: Comfy repo 218,534, diffusers repo 444 (all read).

## 10. What this means for a Scumble recipe (inferred, for the recipe designers)

- **Type.** A local ComfyUI recipe with an Inpaint Canvas node. Picture 1 is the crop, scaled to 4 MP or more, sides a multiple of 32. Reference layers map to `images.image_2..` and are written as `<Picture N>`. The result is composited by Scumble's mask, since the model has no mask.
- **Generate new.** Width and height from the 8 MP table.
- **Fixed values.** Shift 1/1, the 8-sigma grid, euler, no negative prompt.
- **Upsampler.** Optional, wired like the Klein upsampler (`comfyprompt.wireUpsampler`, CLAUDE.md). Use `TextGenerateV2`, with the "Aspect ratio:/Request:" text and image blocks.
- **Two file sets** to offer:
  - (a) Full w4a8 set: about 20 GB download plus the upsampler.
  - (b) LoRA on the user's existing H3 FL2VA int8: LoRA 1.96 + text encoder 3.6-5.1 + VAE 3.1 + upsampler 6.7-19.3 GB. This is the route Comfy Cloud's own templates use.

## Facts

- [read] P-H3-Image is a fine-tune of MiniMaxAI/MiniMax-H3 (base_model_relation finetune), pipeline text-to-image, library diffusers (Modular Diffusers), not gated (https://huggingface.co/api/models/PrunaAI/P-H3-Image (2026-11-06))
- [read] MiniMax H3 is an omni-modal text/image/video/audio-to-video+stereo-audio model (FL2VA and Ref2VA checkpoints); the licence defines it as 'the video generation model' (https://huggingface.co/MiniMaxAI/MiniMax-H3 README and LICENSE line 11 (2026-11-06))
- [read] The user's custom node packs Comfyui_Minimax_h3_latent_Upscaler, TE-Speed-MiniMaxH3-OSS, Comfyui-MMH3-UltimateUpscale, comfyui-minimax-h3-audio-T8 are MiniMax H3 video tools; none mention p-h3 (F:/Comfyui/.../custom_nodes/<pack>/README.md and grep of their .py files (2026-11-06))
- [read] Tasks: text-to-image and instruction editing with 1-8 images (card); Picture 1 is edited, others are references named <Picture 2>...; the ComfyUI node accepts image_1..image_9; the blog says up to 9 (P-H3-Image README lines 79,125-127; comfy_extras/nodes_minimax_h3.py:700-701; pruna.ai/blog/oss-p-h3-image-launch)
- [read] No mask or inpainting input exists; PH3ImageConditioning takes only clip, vae, prompt, width, height, images (comfy_extras/nodes_minimax_h3.py:691-702; diffusers docs/source/en/api/pipelines/p_h3_image.md:53)
- [read] With images the node prepends 'Edit <Picture 1>. ' unless the prompt starts with 'Edit <Picture N>' or 'subject_definitions:' (comfy_extras/nodes_minimax_h3.py:40-42,724)
- [read] Sampling: 8 steps on sigmas 1.0,0.984753,0.967905,0.951688,0.925372,0.881923,0.810083,0.528718,0.0; no CFG or negative prompt (guidance-distilled); euler in Pruna's workflows, er_sde in Comfy Cloud's templates; ModelSamplingMiniMaxH3 at 1.0/1.0 (node defaults 12/3) (modular_model_index.json; workflows/p-h3-image_text_to_image.json; cloud.comfy.org/templates/image_p_h3_image_edit.json; nodes_minimax_h3.py:378-397,690)
- [read] Best at 8 MP (default 2912x2912); 8 MP sizes 3360x2496, 2496x3360, 3552x2368, 2368x3552, 3872x2176, 2176x3872; edits best at 4 or 8 MP; sides multiples of 32 (P-H3-Image README 139-154; nodes_minimax_h3.py:31)
- [read] The diffusers pipeline scales Picture 1 up to at least 4 MP (canvas_min_pixels 4194304); the ComfyUI node only scales down, so Pruna's ComfyUI edit workflow scales image_1 to 4 MP with ImageScaleToTotalPixels first (modular_model_index.json; nodes_minimax_h3.py:668-671,714-729; workflows/p-h3-image_edit.json)
- [read] Transformer MiniMaxH3Transformer3DModel: 50 layers, hidden 5376, 56x128 heads, ffn 14336, 24 latent channels, patch 1x2x2, text_dim 5120; 33.1B params / 66.28 GB in diffusers bf16 (transformer/config.json and transformer index json of PrunaAI/P-H3-Image)
- [read] The ComfyUI bf16 diffusion file holds 20.15B params; its adaln_proj weights are [96768,16] F32 plus an adaln_t_table instead of [96768,2688] (safetensors headers of p-h3-image_bf16.safetensors and diffusers shard 1 (range read, 2026-11-06))
- [inferred] That header difference is the timestep-block replacement Pruna describes (33B to 20B), matching H3's ~13B precomputable AdaLN parameters (pruna.ai blog; MiniMax-H3 README line 142)
- [read] Text encoder is Qwen3-VL-4B distilled from H3's Qwen3-VL-32B encoder, with a text connector (hidden states 13,19,25,31,36 -> 5120); ComfyUI loads it via CLIPLoader type minimax (text_encoder/config.json, text_connector/config.json; pruna.ai blog; comfy/sd.py:2070-2073; comfy/text_encoders/minimax.py:38-40)
- [read] VAE is H3's encoder with a new single-frame ViT decoder; it decodes single-frame latents only, so H3's video VAE is not a substitute (vae/config.json; comfy/ldm/minimax/vae.py:1014-1032; comfy/sd.py:1054-1057)
- [read] Prompt upsampler is a Qwen3.5-9B fine-tune under Apache-2.0, on by default; ComfyUI runs it with CLIPLoader(minimax) + Generate Text, greedy, thinking on for text-to-image (prompt_upsampler/config.json; NOTICE; workflows/p-h3-image_text_to_image.json)
- [read] ComfyUI file sizes: diffusion bf16 40,468,411,160 / int8_convrot 21,213,068,840 / w4a8 13,362,068,864; text encoder 9.14/5.12/3.58 GB; upsampler 19.31/9.75/6.72 GB; VAE 5.56/3.15 GB; LoRA 1.96 GB (https://huggingface.co/api/models/PrunaAI/P-H3-Image-Comfy/tree/main (2026-11-06))
- [read] Peak VRAM at 8 MP: bf16 set 56 GB, int8 set 31 GB, w4a8 + int8 VAE set 21 GB (20 GB download), each plus the upsampler, which ComfyUI moves out before sampling (P-H3-Image-Comfy README 116-120,199)
- [read] Speed claims: B200 bf16 2.6 s at 4 MP and 5.8 s at 8 MP; L40S 4-bit 6.3 s at 4 MP; diffusers bf16 about 9 s at 8 MP plus 6-11 s for the upsampler, about 101 GB with it (pruna.ai/blog/oss-p-h3-image-launch; P-H3-Image README 289-296)
- [read] This machine has an RTX 5090 with 32,607 MiB (compute 12.0) (nvidia-smi query (2026-11-06))
- [read] The user's ComfyUI is 0.44.0 and has PH3ImageConditioning, MiniMaxH3SigmaShift and every helper node the official workflows use; ComfyUI support came in PR #17506 (merged 2026-11-03), v0.44.0 published 2026-11-04 (comfyui_version.py; comfy_extras grep; gh pr view 17506 / gh release view v0.44.0 --repo Comfy-Org/ComfyUI)
- [read] The user already has minimax_h3_fl2va_pruned_int8_convrot.safetensors (20,970,379,616 bytes, the same size as Comfy-Org's file), which Comfy Cloud's own P-H3-Image templates run with the 2 GB p-h3-image LoRA via LoraLoaderModelOnly (models/diffusion_models listing; Comfy-Org/MiniMax-H3 tree API; cloud.comfy.org/templates/image_p_h3_t2i.json and image_p_h3_image_edit.json)
- [read] Comfy Cloud lists all 12 p-h3-image model files and the templates image_p_h3_t2i and image_p_h3_image_edit (dated 2026-11-03) (Comfy Cloud MCP search_models / search_templates / get_node (2026-11-06))
- [unverified] No hosted P-H3-Image API was found on Replicate, fal, WaveSpeed or pruna.ai (WebSearch 2026-11-06 and HTTP probes returning 404)
- [read] Licence: the MiniMax H3 Community License Agreement (dated Aug 2, 2026) excludes the EU, UK, Republic of Korea and USA; V.4 forbids use, distribution or display of the Works or their Outputs outside the Applicable Territory; a separate licence can be applied for at platform.minimax.io/h3-license (PrunaAI/P-H3-Image LICENSE lines 2,8,10,22-23,42 (identical sha256 to MiniMax-H3 LICENSE); MiniMax-H3 docs/QA-about-License.md)
- [read] Commercial use is permitted inside the territory; above US$20M revenue needs written authorisation; a commercial product's UI must display 'MiniMax H3'; 'Powered by MiniMax H3' is only 'encouraged' in III.3.a, though Pruna's cards say 'must' (LICENSE lines 28-29,36-37; P-H3-Image README 313-317)
- [read] Products must bind users to the section V / AUP restrictions and keep misuse safeguards and a reporting mechanism; outputs may not be used to improve other models; Hong Kong law (LICENSE lines 40-43,57-58)
- [read] Release: blog dated Nov 3, 2026; diffusers PR #15171 merged 2026-11-03; HF repos created 2026-10-27/28; the Space created 2026-11-03 (pruna.ai blog; gh api huggingface/diffusers commits; HF API)

## Open questions

- The licence excludes the EU and the user is in Germany: does the user want to apply to MiniMax (platform.minimax.io/h3-license) before any live run or before shipping a recipe? The same applies to the MiniMax H3 files already on the machine.
- Does shipping a recipe that only names P-H3-Image files, in a GPL app distributed in the EU (GitHub, Store), count as 'distributing' or 'providing access' under III and V.2/V.5? That is a lawyer question.
- Which file set should the recipe target: the full w4a8 set (about 20 GB download) or the LoRA on the user's existing minimax_h3_fl2va_pruned_int8_convrot, the route Comfy Cloud's templates use? Is the LoRA route really equal in quality (Pruna's claim, unverified)?
- Does the int8 set (31 GB peak at 8 MP) fit the 32 GB RTX 5090 beside the desktop's use, and what are the real times on it? No numbers exist.
- Edit quality on Scumble crops: how much of a crop outside the requested change the model redraws without the upsampler, and whether small crops must be upscaled to 4 MP (the ComfyUI node does not do it).
- Image count: the card says 1-8 images, while the ComfyUI node and the blog intro say 9; which limit should the recipe layout use?
- Comfy Cloud as a route: the catalog has the files and templates, but the licence's Hosted Services and territory terms apply there too.
