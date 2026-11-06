# providers_scumble

## Summary

I checked eight API hosts on 2026-11-06. P-H3-Image runs only on WaveSpeedAI; Comfy Cloud also has it as files and templates. Replicate, fal, Pruna's own API, OpenRouter, Comfy Router, Oxen.ai, ToAPIs and Hugging Face's inference providers do not list it. WaveSpeed has four routes; Scumble needs two of them: `wavespeed-ai/p-h3-image/edit` (1 to 9 image URLs, the first one is edited; `aspect_ratio`, `resolution` 1k to 4k, `output_format`, `seed`; $0.03 to $0.18, plus $0.005 for each extra image) and `.../text-to-image` ($0.02 to $0.12).

"H3" is MiniMax H3. P-H3-Image is Pruna's 8-step image fine-tune of MiniMaxAI/MiniMax-H3, the video model the user's H3 node packs are built for. Pruna's 2 GB LoRA runs it on the `minimax_h3_fl2va_pruned_int8_convrot` file the user already has, and Comfy Cloud's two templates do exactly that. ComfyUI 0.44.0 (2026-11-04) is the first release with the node `PH3ImageConditioning`; 0.43.0 lacks it.

**Licence: risky for the user.** The MiniMax H3 Community License leaves out the EU, the UK, South Korea and the USA. The user is in Germany, so using the model there, hosted APIs included, is not covered without a separate licence from MiniMax.

Scumble side: the closest template is `recipes/flux3_klein_local.json`, an edit recipe with reference pictures, an upsampler on Generate Text and SamplerCustomAdvanced. For text-to-image only, MOSS's "the crop gives only the size" shape fits. Three code gaps:
- `comfyrefs.js` does not know `PH3ImageConditioning` yet. Without it, `@img` names are guessed and unused inputs are not trimmed.
- `wireUpsampler` and `localUpsampler` are built around BFL's upsampler: TextGenerate only, BFL's request text, ordinal names that would turn `<Picture 2>` into "the second image", and only the `t2i`/`source` keys are kept.
- Generate new never drops the crop (`trimSlots` keeps batch 0), so one recipe would edit a white picture rather than make a real text-to-image run.

The WaveSpeed variant needs no adapter change; the Nano Banana 2.1 variant is the template. The report has both checklists with file:line anchors and the tests to update.

## Report

## 1. What P-H3-Image is, and how "H3" relates

- `PrunaAI/P-H3-Image` is listed with `base_model: MiniMaxAI/MiniMax-H3` and `base_model_relation: finetune`. It was created 2026-10-27 and is not gated; the pipeline is diffusers ModularPipeline (HF API `https://huggingface.co/api/models/PrunaAI/P-H3-Image`, read 2026-11-06).
- What it does (model card README.md:67-84, read 2026-11-06):
  - text-to-image and edits with 1 to 8 input images (picture 1 is edited, the others are references named "Picture 2", "Picture 3" and so on);
  - 8 steps, no CFG or negative prompt; best at 8 MP for text-to-image, 4 or 8 MP for edits;
  - a prompt upsampler based on Qwen3.5-9B, on by default;
  - 33.1B transformer plus a 4B text encoder.
- The ComfyUI files are in `PrunaAI/P-H3-Image-Comfy` (not gated): bf16, `int8_convrot` and `w4a8` of every part. The w4a8 set is 20 GB and peaks at 21 GB of VRAM at 8 MP; the int8 set is 30 GB and peaks at 31 GB (README "Pick your files", read).
- There is also `loras/p-h3-image_lora_bf16.safetensors` (2 GB) "for MiniMax-H3". It runs P-H3 on MiniMax-H3's FL2VA transformer ("the pruned and quantized FL2VA files work too"), still with P-H3's own text encoder and VAE (README "Already have MiniMax-H3?" and `workflows/p-h3-image_lora_text_to_image.json` loaders, read).
- The user's ComfyUI has `models/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors` (read, directory listing). Comfy Cloud's templates use exactly that file plus the LoRA (MCP `get_template_schema image_p_h3_t2i` / `image_p_h3_image_edit`, read).
- The user's H3 packs (Comfyui_Minimax_h3_latent_Upscaler, TE-Speed-MiniMaxH3-OSS, MMH3-UltimateUpscale, minimax-h3-audio) are MiniMax H3 video tools. None of them mentions P-H3 (grep over custom_nodes, read).
- **ComfyUI support:** core node `PH3ImageConditioning` and `MiniMaxH3SigmaShift` (display name "ModelSamplingMiniMaxH3") are in `comfy_extras/nodes_minimax_h3.py:378-400, 681-731` (read).
  - It is in the v0.44.0 tag and not in v0.43.0 (`gh api repos/Comfy-Org/ComfyUI/contents/...?ref=`, read). v0.44.0 was published 2026-11-04.
  - The user's install is 0.44.0 (`comfyui_version.py`, read). No P-H3 files are on it yet (read).
- **Node inputs** (`nodes_minimax_h3.py:691-703`, read):
  - `clip`, optional `vae` (needed with images), `prompt`;
  - `width` / `height` (0 = image_1's size, or 2912 without images; step 32);
  - Autogrow `images.image_1` to `images.image_9`;
  - outputs `positive` and `LATENT`.
- **What the node does with them:**
  - With images it prefixes the prompt with "Edit <Picture 1>. " unless the prompt already starts with "Edit <Picture" (:695, :724).
  - It only scales down (`_size_within_area`, :668-671).
  - The text-encoder images go in at 1 MP (`PH3_IMAGE_VISION_PIXELS`, :39).
- **Pruna's workflows** (`workflows/p-h3-image_text_to_image.json`, `p-h3-image_edit.json`, read):
  - Model chain: `UNETLoader`, then `MiniMaxH3SigmaShift` 1/1, `CLIPLoader` type `minimax`, `VAELoader`.
  - Sampling: `ManualSigmas` "1.0, 0.984753, 0.967905, 0.951688, 0.925372, 0.881923, 0.810083, 0.528718, 0.0", `BasicGuider`, `KSamplerSelect` euler, `RandomNoise`, `SamplerCustomAdvanced`, `VAEDecode`.
  - Upsampler: `TextGenerate` with `ComfySwitchNode`.
  - Text-to-image upsampler input: "Aspect ratio: 1:1\nRequest: {a}" with thinking on, max_length 2048, greedy decoding.
  - Edit upsampler input: a raw chat-template string with one `<Picture N>: <|vision_start|><|image_pad|><|vision_end|>` block per image, then "Edit <Picture 1>. {a}", max_length 3072, thinking off.
  - The widget order comes from `comfy_extras/nodes_replacements.py:101-103` (read). Reading the thinking flags from it is inferred.
- **Comfy Cloud's edit template** differs: it uses `TextGenerateV2` with "Aspect ratio: 1:1\nRequest: ...", thinking true, max_length 1536, sampler `er_sde`, and `LoraLoaderModelOnly` (MCP, read).

## 2. The licence (decisive for this user)

From `LICENSE` (MiniMax H3 Community License, 2026-08-02), read 2026-11-06:
- I.3 and I.5: the "Applicable Territory" is worldwide minus the **European Union, the United Kingdom, the Republic of Korea and the USA**.
- II grants rights "solely within the Applicable Territory". Excluded parties may "contact us about obtaining a license".
- By the preamble, use through **Hosted Services** also counts as acceptance. V.4 forbids using the works or their outputs outside the territory, and Exhibit A item 1 says the same.
- III.3.a: a "Powered by MiniMax H3" notice is *encouraged*.
- IV.2: a *commercial* product must "prominently display 'MiniMax H3'" in its user interface. The model card says "must show", which overstates III.3.a.
- The upsampler and the Qwen3-VL parts are Apache-2.0 (`NOTICE`, read).

Inferred: the user, working in Germany, has no licence for local or API use without MiniMax's separate licence. A shipped recipe would invite EU and US users into the same position. Scumble ships no weights (the same pattern as Klein's licence note).

## 3. Providers (all read 2026-11-06 unless marked)

| Host | Listed? | Id / route | Task | Request fields | Price | Source |
|---|---|---|---|---|---|---|
| **WaveSpeedAI** | **yes** | `wavespeed-ai/p-h3-image/text-to-image` | t2i | `prompt` (required), `aspect_ratio` (default 1:1; 1:1, 1:2, 2:1, 1:3, 3:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 9:21, 21:9), `resolution` 1k / 1.5k / 2k / 3k / 4k (about 1 / 2.4 / 4 / 9.4 / 16.8 MP, default 1k), `output_format` jpeg / png / webp (default jpeg), `seed` (-1 random); `additionalProperties: false` | base $0.02 × (1, 1.5, 2, 4, 6) by tier = $0.02 to $0.12 | https://wavespeed.ai/models/wavespeed-ai/p-h3-image/text-to-image (embedded `request_schema` and `formula`) |
| WaveSpeedAI | yes | `wavespeed-ai/p-h3-image/edit` | edit + refs | `prompt`, `images` (1 to 9 URLs, the first is edited, required), `aspect_ratio` (optional, follows image 1), `resolution`, `output_format`, `seed`; the prompt names `<Picture 1>`, `<Picture 2>` | $0.03 × tier factor + $0.005 per image after the first ($0.03 to $0.18 + refs) | https://wavespeed.ai/models/wavespeed-ai/p-h3-image/edit |
| WaveSpeedAI | yes | `.../text-to-image-lora`, `.../edit-lora` (`loras` up to 3, `{path, scale 0-4}`) | – | – | edit-lora +$0.015 | sitemap https://wavespeed.ai/model-sitemap.xml |
| Replicate | no | not on https://replicate.com/prunaai (65 models, p-image* only); 404 on 5 guessed slugs; `minimax/h3*` are video | – | – | – | read; another owner's upload unverified |
| fal | no | `api.fal.ai/v1/models?q=p-h3` and `fal.ai/api/models?keywords=p-h3 / pruna`: 0; only `minimax/h3*` video | – | – | – | read |
| Pruna API (api.pruna.ai) | no | https://docs.api.pruna.ai/guides/models lists p-image*, p-video*; H3 only as p-video-2-pro (video) | – | – | – | read |
| OpenRouter | no | 66 image-output models, no Pruna or H3 | – | – | – | `openrouter.ai/api/v1/models?output_modalities=image`, read |
| Comfy Router | no | `docs.comfy.org/llms.txt` router-schemas: pruna/p-video-2, minimax/minimax-h3, fal/h3-max* (video) | – | – | – | read |
| Comfy partner nodes | no | `search_models source:partner q:h3`: only `minimax/hailuo-03-t2v` | – | – | – | MCP, read |
| Oxen.ai | no | `hub.oxen.ai/api/ai/models`: minimax-h3 video only | – | – | – | read |
| ToAPIs | no | market page and docs: MiniMax-H3 video only | – | – | – | `toapis.com/market`, `docs.toapis.com/llms.txt`, read |
| HF Inference Providers | no | `inferenceProviderMapping: {}`; the Gradio Space `PrunaAI/P-H3-Image` exists | – | – | – | HF API, read |
| **Comfy Cloud (graph)** | **yes** | 12 files (`p-h3-image_*` bf16 / int8 / w4a8, LoRA, VAE, upsampler); templates `image_p_h3_t2i` and `image_p_h3_image_edit` | both | graph | Cloud credits (unverified) | MCP `search_models` / `search_templates`, read |

Unverified: whether WaveSpeed runs Pruna's prompt upsampler on its side. Its schema has no such field, and its pages do not mention one.

## 4. Scumble: closest templates and format rules

- **`recipes/flux3_klein_local.json`** is the closest. It has the same shape:
  - an edit with references, `refs` at :8, `needs` without the upsampler classes at :10, 8 Settings rows at :11-20;
  - an upsampler as `up_clip` / `up_pics` / `up_run` (TextGenerate) / `up_show` / `up_switch` (:73-77), declared under `upsampler` at :79-86;
  - SamplerCustomAdvanced and RandomNoise from `["canvas", 10]`.
- **`recipes/moss_image_local.json`** is the template for a text-to-image-only recipe: `edit: false` (:8); the crop only gives the size through `scale0` / `size` / `latent` (:42-44).
- **Provider template:** the WaveSpeed variant of `recipes/nano_banana_2_1.json` (model `.../edit`, `input: "edit"`, `max_images`, `aspect_ratios`, a resolution row, `text.model` plus `text.refs.model`).
- `cloud_z_image_turbo.json` is generated by `tools/cloud_recipes.js` (MANIFEST :33-66, `read()` :69-73).
- **Rules** (docs/RECIPES.md):
  - format :20-44; `settings` index 1-8 :41;
  - `upsampler` :104-122: it runs only when TextGenerate and PreviewAny are there and the upsampler file is listed; the Cloud copy runs without it;
  - `edit: false` = Generate new only :124-127;
  - local `refs` and trace rules :788-856: `{n}` is 1-based, slots 1-16, only known encoder classes are traced, unused inputs are trimmed but never the crop's;
  - provider format :516-575; `limits` default 2048 / 16 :597-599; the `text` shape :897-940 (the default text model strips `/edit`, so WaveSpeed's `/text-to-image` must be named);
  - missing-file links come from `models` rows "file (url)" (host.js:1584-1593), checked only for Settings-row files (host.js:1622-1627).

## 5. Checklist (a): a local ComfyUI recipe

**File `recipes/p_h3_image_local.json`** (new):
- `id`, `name` "P-H3-Image (ComfyUI)", `description`:
  - ComfyUI **0.44 or newer**; which files to get; 4 MP edits, 8 MP new pictures;
  - the licence and territory sentence, and "Powered by MiniMax H3".
- `mode` "local", `canvas` "canvas", `result` "decode:0".
- `refs: { "name": "<Picture {n}>", "slots": 8 }`. The node takes 9 (:700-701); Pruna's card says 1 to 8 (README:79).
- `needs`: InpaintCanvas, ImageFromBatch, UNETLoader, CLIPLoader, VAELoader, MiniMaxH3SigmaShift, ImageScaleToTotalPixels, PH3ImageConditioning, ManualSigmas, BasicGuider, KSamplerSelect, RandomNoise, SamplerCustomAdvanced, VAEDecode.
  - Add LoraLoaderModelOnly only for the LoRA route.
  - TextGenerate, PreviewAny and ComfySwitchNode stay out, as in Klein.
- **Graph:**
  - `img0`…`img7`: ImageFromBatch of `["canvas", 0]`.
  - `scale0`: ImageScaleToTotalPixels at 4 MP, `resolution_steps` 32 (`CANVAS_MULTIPLE` 32, nodes_minimax_h3.py:31).
  - `cond` (PH3ImageConditioning): `images.image_k` ← `scale(k-1)`, `vae` linked, width/height 0, `prompt` ← `["up_switch", 0]`.
  - `shift`: MiniMaxH3SigmaShift 1/1.
  - `guider`: BasicGuider(model ← shift, conditioning ← cond:0); `run.latent_image` ← `["cond", 1]`.
  - `sigmas`: ManualSigmas with the 8-step grid. `sampler`: KSamplerSelect euler (Pruna) or er_sde (Comfy Cloud).
  - `noise`: RandomNoise ← `["canvas", 10]`. No negative.
  - Upsampler nodes as in Klein, with `up_clip` type `minimax`.
- **`settings`** (8 at most): Model, Text encoder, VAE, Megapixels, Sampler, Prompt upsampler (switch), Upsampler model, and one more (the LoRA file, or free).
- **`models`**: rows "file (https://huggingface.co/PrunaAI/P-H3-Image-Comfy/resolve/main/<folder>/<file>)". sha256s are in the HF API (e.g. `p-h3-image_w4a8` `12ea30d6…`, `p-h3-image_int8_convrot` `b156fd4f…`).

**Code:**
1. `renderer/editor/comfyrefs.js:37-63` ENCODERS: add `PH3ImageConditioning` with name `<Picture {n}>`. Its inputs are the present `images.image_k`, numbered by rank, the way `TextEncodeQwenImage21` does it (:38-45): the node sorts by suffix and skips missing slots (:709-710).
   - Without it the trace is a guess: no trimming, and the last picture repeats into the unused slots (RECIPES.md:816-821).
2. `renderer/editor/comfyprompt.js:294-331` `wireUpsampler`: it hard-codes BFL's form.
   - `UPSAMPLE_EDIT_REQUEST` (:258); the t2i branch swaps `system_prompt` and sets `presence_penalty` 1.5 (:322-326).
   - `ordinalNames` (:321) would rewrite `<Picture 2>` to "the second image" whenever `refs.name` holds `{n}`.
   - The class check is `TextGenerate` only (:303).
   - It needs a per-recipe request format: P-H3's t2i "Aspect ratio: W:H\nRequest: …" (one of the 7 aspects), and the edit form with one `<Picture N>` block per picture sent (1 + Original + kept).
3. `electron/main/recipes.js:542-563` `localUpsampler`: accepts only `TextGenerate` (:548) and keeps only `t2i` / `source` (:560-561). It must keep the new format key, and accept `TextGenerateV2` if that is used. `GRAPH_KEEPS` (:1067) already keeps `upsampler`.
4. **Generate new as a real text-to-image run:**
   - `host.queueGenerate` runs a local edit recipe on a fresh white canvas (host.js:3945-3959, 4119-4128).
   - `trimSlots` never removes batch 0 (comfyrefs.js:209), so P-H3 would get "Edit <Picture 1>. …" on a white picture (inferred).
   - Either new code drops `images.image_1` and sets `width` / `height` (8 MP) on `fresh && !refsGo`, or the recipe is split in two (below).
5. **Split option:** `p_h3_image_local` (edit, 4 MP) plus `p_h3_image_t2i_local` (`edit: false`, MOSS-shaped: `cond` without images, width and height from `GetImageSize(scale0)` at 8 MP). Points 2 and 3 are still needed for the upsampler. Without the upsampler, short prompts give weak results (README:304-305).

**Tests:**
- `tools/comfyrefs_test.js` §1 `shipped_specs` (:99-135): the PH3 spec (name, slots, trim).
- `tools/comfyprompt_test.js` "the prompt upsampler" (:251-306): P-H3 t2i and edit requests; no ordinals.
- `tools/recipes_test.js` §7 detach `want` table (:586-589): add `p_h3_image_local: { pictures: 8, values: ["prompt","seed"] }` (no negative). §1 and §5 sweep it by themselves.
- `tools/recipes_test.py`: the local reference steps are optional.

**Docs:** RECIPES.md upsampler paragraph (:104-122) and a shipped entry after MOSS (:159-174); README.md:220-223; MANUAL.md:157, :216; the CHANGELOG section. `recipes/licenses/` only if Pruna's Apache text is copied.

## 6. Checklist (b): API variants

- **New `recipes/p_h3_image.json`:** `kind` "provider", `family` "Pruna AI", `refs: {"name": "<Picture {n}>"}` (§3 of recipes_test wants `refs.name` on every variant, :205-226), `default` "wavespeed", description with "not run against the live API yet" and the licence note.
- **`providers.wavespeed`:**
  - `model` "wavespeed-ai/p-h3-image/edit", `input` "edit".
  - `options.max_images` 9.
  - `options.aspect_ratios`: the 15 values. On an edit the adapter sends the nearest preset (wavespeed.js:191), as Nano Banana does.
  - `options.accepts` ["aspect_ratio", "resolution", "output_format", "seed"]. Without it a text run sends `negative_prompt` (wavespeed.js:203) into a schema with `additionalProperties: false`. Keep `output_format` in the list so the adapter's png (:204) is sent, not WaveSpeed's jpeg default.
  - `options.tiers` {"1k":1024, "1.5k":1536, "2k":2048, "3k":3072, "4k":4096} (`tierFor`, util.js:123-128; used at wavespeed.js:198-201).
  - `settings`: [{index 1, key "resolution", label "Resolution", spec [["1k","1.5k","2k","3k","4k"], {default "2k"}]}]. 2k is about 4 MP, the edit size Pruna recommends (RECIPES.md:3-5).
  - `text`: {model "wavespeed-ai/p-h3-image/text-to-image", refs {model "wavespeed-ai/p-h3-image/edit"}, sizes [1024, 1536, 2048, 3072, 4096]}.
  - `note` with the prices.
- **No adapter change:** the edit shape `images` [crop, refs…], uploads and the allowlist all exist (wavespeed.js:114-211, 239-245).
- **Tests:**
  - recipes_test.js §4: add the TEXT_REFS row `p_h3_image: { wavespeed: { model: "wavespeed-ai/p-h3-image/edit" } }` and change `withRefs === 111` to 112 (:250-304).
  - `tools/wavespeed_text_test.js` (:35-37): the route `<id>/text-to-image` passes.
  - `tools/genpresets_test.js` §1 and §2b (:54-140): check that the 1.5k and 3k labels are the tiers the adapter sends.
  - `tools/refs_layout_test.js` sweeps it on its own (it needs a max: 9).
- **If Replicate or fal list it later:**
  - Replicate: `model` "owner/name", or "owner/name:version" pinned (replicate.js:1-3); `fields.images` as the model names its input (:9-13); `max_images`, `sizes`, `text_values`.
  - fal: the endpoint id; `fields` (default `image_urls`); `options.sizing` "none" without `image_size`; `omit`; `text.refs.model` for the edit route (fal.js:5-26, EDIT_ROUTE :46); the schema at `fal.ai/api/openapi/queue/openapi.json?endpoint_id=` (RECIPES.md:613-616).
- **Comfy Cloud graph recipe:**
  - Export `image_p_h3_image_edit` and `image_p_h3_t2i` (`https://cloud.comfy.org/templates/<name>.json`) into `tools/refs/comfy_cloud/edit` and `/t2i`.
  - MANIFEST row `{file, id: "cloud_p_h3_image", name, text, refs: "<Picture {n}>", limits: {step: 32}, about}` in `tools/cloud_recipes.js`, then `node tools/cloud_recipes.js`.
  - recipes_test.js §10: the `want` table and the "thirteen" count (:805-836); §4 `TAKES_NONE` (:270-273).
  - Risk (inferred): the templates put "Aspect ratio: …\nRequest: …" inside the prompt primitive (29.value / 24.value), so writing the user's text there drops that frame; the t2i template is a subgraph with a ResolutionSelector that the reader has to remove (graphOk, :826-829).

## 7. Files in the scratch folder (inputs only)

`C:/Users/SCHOEN~1/AppData/Local/Temp/claude/F--canvas/543d44fb-4d2d-4818-8804-974916d10a44/scratchpad/ph3_providers_scumble/`: `hf_readme.md`, `hf_comfy_readme.md`, `hf_license.txt`, `wf_p-h3-image_text_to_image.json`, `wf_p-h3-image_edit.json`, `wf_lora_t2i.json`, `ws_ph3_*.html`, `ws_schema.py`, `up_chat_template.jinja`.

## Facts

- [read] P-H3-Image is a finetune of MiniMaxAI/MiniMax-H3 (base_model_relation finetune), created 2026-10-27, not gated, pipeline diffusers ModularPipeline (https://huggingface.co/api/models/PrunaAI/P-H3-Image (2026-11-06))
- [read] Pruna's card: text-to-image and edits with 1 to 8 input images, 8 steps, no CFG or negative prompt, best at 8 MP (t2i) and 4 or 8 MP (edits), prompt upsampler on Qwen3.5-9B on by default (PrunaAI/P-H3-Image README.md:67-84,139-155 (2026-11-06))
- [read] The MiniMax H3 Community License leaves out the EU, the UK, the Republic of Korea and the USA, also counts use through Hosted Services, and forbids using outputs outside the territory (PrunaAI/P-H3-Image LICENSE I.3, I.5, preamble, V.4, Exhibit A.1 (2026-11-06))
- [read] The licence only encourages the 'Powered by MiniMax H3' notice (III.3.a); commercial products must prominently display 'MiniMax H3' (IV.2); the model card's 'must show' overstates III.3.a (LICENSE III.3.a, IV.2; README.md:315-317)
- [inferred] The user, working in Germany, has no licence to use P-H3-Image locally or through an API without a separate licence from MiniMax (LICENSE II, I.5 together with the user's location (CLAUDE.md: German-speaking, de domains))
- [read] ComfyUI runs P-H3 natively: PH3ImageConditioning (inputs clip, optional vae, prompt, width, height, Autogrow images.image_1..9) and MiniMaxH3SigmaShift (ModelSamplingMiniMaxH3) at 1.0/1.0 (F:/Comfyui/.../comfy_extras/nodes_minimax_h3.py:378-400,681-731)
- [read] PH3ImageConditioning first ships in ComfyUI v0.44.0 (2026-11-04); v0.43.0 lacks it; the user's ComfyUI is 0.44.0 (gh api repos/Comfy-Org/ComfyUI contents at tags v0.43.0/v0.44.0; comfyui_version.py)
- [read] With images, the node prefixes the prompt with 'Edit <Picture 1>. ' unless it already starts with 'Edit <Picture'; it only scales images down (nodes_minimax_h3.py:40-42,668-671,695,724)
- [read] P-H3-Image-Comfy has bf16, int8_convrot and w4a8 files of each part plus a 2 GB LoRA for MiniMax-H3's FL2VA transformer; the w4a8 set is 20 GB and peaks at 21 GB of VRAM at 8 MP; the repo is not gated (https://huggingface.co/api/models/PrunaAI/P-H3-Image-Comfy and its README (2026-11-06))
- [read] The user has minimax_h3_fl2va_pruned_int8_convrot.safetensors in diffusion_models and no p-h3-image files (directory listing of F:/Comfyui/.../models (2026-11-06))
- [read] Comfy Cloud has all 12 p-h3-image files and the templates image_p_h3_t2i and image_p_h3_image_edit, which use minimax_h3_fl2va_pruned_int8_convrot plus the LoRA, an int8 text encoder and VAE, the w4a8 upsampler, TextGenerateV2 and er_sde (Comfy Cloud MCP search_models, search_templates, get_template_schema (2026-11-06))
- [read] Pruna's own workflows use TextGenerate (deprecated), StringFormat 'Aspect ratio: 1:1\nRequest: {a}' for t2i, and for edits a raw chat-template string with a <Picture N> vision block per image; sampler euler; ManualSigmas 8-step grid (P-H3-Image-Comfy workflows/p-h3-image_text_to_image.json, p-h3-image_edit.json (2026-11-06))
- [read] WaveSpeed hosts wavespeed-ai/p-h3-image/text-to-image and /edit (plus -lora routes) with fields prompt, images (1-9, edit), aspect_ratio (15 presets), resolution 1k/1.5k/2k/3k/4k, output_format, seed, additionalProperties false (https://wavespeed.ai/models/wavespeed-ai/p-h3-image/edit and /text-to-image embedded request_schema; model-sitemap.xml (2026-11-06))
- [read] WaveSpeed prices: t2i $0.02 base × 1/1.5/2/4/6 by tier; edit $0.03 base × the same + $0.005 per image after the first; edit-lora +$0.015 (WaveSpeed pages' embedded formula fields (2026-11-06))
- [read] Not listed on Replicate, fal, the Pruna API, OpenRouter, Comfy Router, Oxen.ai, ToAPIs or HF Inference Providers (replicate.com/prunaai; api.fal.ai/v1/models and fal.ai/api/models; docs.api.pruna.ai/guides/models; openrouter.ai/api/v1/models; docs.comfy.org/llms.txt; hub.oxen.ai/api/ai/models; toapis.com/market and docs.toapis.com/llms.txt; HF inferenceProviderMapping (2026-11-06))
- [unverified] No other Replicate owner hosts P-H3-Image (Replicate search page renders by JS; only prunaai and 5 guessed slugs checked)
- [unverified] Whether WaveSpeed runs Pruna's prompt upsampler on its side (WaveSpeed schema has no upsampler field and its pages do not mention one)
- [read] Scumble's reference trace knows only TextEncodeQwenImage21, TextEncodeQwenImageEditPlus and ReferenceLatent; a PH3ImageConditioning graph is a guess with no trimming (F:/canvas/renderer/editor/comfyrefs.js:37-63,150-171; docs/RECIPES.md:804-821)
- [read] wireUpsampler is built for BFL: checks only TextGenerate/PreviewAny, sends BFL's three-line edit request or swaps system_prompt for t2i, and rewrites refs.name tokens as ordinals ('the second image') (F:/canvas/renderer/editor/comfyprompt.js:258,267-274,294-331)
- [inferred] For a P-H3 recipe with refs.name '<Picture {n}>', ordinalNames would turn <Picture 2> into 'the second image' before the upsampler (comfyprompt.js:267-274,321)
- [read] localUpsampler accepts only a TextGenerate run node and keeps only the t2i and source keys (F:/canvas/electron/main/recipes.js:542-563)
- [read] trimSlots never removes the crop's input (batch 0), so Generate new on a local edit recipe sends the white fresh crop as image_1 (comfyrefs.js:206-216; host.js:3945-3959,4092,4119-4128)
- [inferred] Without the WaveSpeed accepts list, a text run would send negative_prompt, which the P-H3 schema refuses (additionalProperties false); the adapter sets output_format png unless the allowlist drops it (F:/canvas/electron/main/providers/wavespeed.js:174-177,203-209 with the WaveSpeed schema)
- [read] recipes_test.js pins: refs.name on every provider variant (§3), the TEXT_REFS table with withRefs === 111 (§4), the detach table of every shipped ComfyUI recipe (§7), and thirteen Comfy Cloud recipes (§10) (F:/canvas/tools/recipes_test.js:205-226,245-308,581-590,805-836)
- [read] wavespeed_text_test.js requires a WaveSpeed edit variant's text route to be <id>/text-to-image (F:/canvas/tools/wavespeed_text_test.js:20-41)

## Open questions

- Licence: given the MiniMax H3 licence's EU/UK/US/Korea exclusion, does the user want to ship a P-H3 recipe at all, or ask MiniMax (api@minimax.io) for a licence first? Does WaveSpeed hold a separate MiniMax licence for users in excluded territories?
- One local recipe with new code that makes Generate new a real text-to-image run (drop images.image_1, set width/height at 8 MP), or two recipes: an edit at 4 MP and an edit:false one at 8 MP shaped like MOSS?
- Which files should be the default: P-H3 int8 / w4a8 (20-30 GB new), or the LoRA route on the user's minimax_h3_fl2va_pruned_int8_convrot plus the LoRA, text encoder and VAE (about 10 GB plus the upsampler), as Comfy Cloud's templates do?
- Which upsampler edit request format: Pruna's raw chat-template string with <Picture N> vision blocks and thinking off, or Comfy Cloud's 'Aspect ratio/Request' two-line form with thinking on? TextGenerate (deprecated) or TextGenerateV2 (needs code changes in recipes.js and comfyprompt.js)?
- Sampler default: euler (Pruna's workflows) or er_sde (Comfy Cloud's templates)? refs slots 8 (Pruna's card) or 9 (the node and WaveSpeed)?
- Does WaveSpeed's P-H3 route expand short prompts itself? If not, should the WaveSpeed variant point users to Scumble's own prompt upsampling?
- Which branch and release take it: 0.1.52 is planned as the CorridorKey release on the corridorkey branch off main, and the current work is the wasm-kernels branch.
- Does normalize() keep a limits.aspects list on a kind comfy recipe, so the New dialog offers only P-H3's 7 aspects (genpresets.aspectsOf reads v.text.aspects / v.limits.aspects)?
