# openai

## Summary

OpenAI released GPT-Image-2.6 Sunburst and GPT-Image-2.6 Flare on 4 November 2026, not today. The English and German announcement pages and the API changelog's "Nov 4" entry give that date. The ids entered OpenAI's OpenAPI spec on 2026-11-05 01:32 UTC (commit 5882fdd9).

API ids are `gpt-image-2.6-sunburst` and `gpt-image-2.6-flare`. Each has only that alias as a snapshot, with no dated snapshot.

- **Endpoints:** both run on `v1/images/generations` and `v1/images/edits`. The model pages list the Responses API and Batch as not supported, though the spec's image tool enum already lists the 2.6 ids (2.5 does have Batch).
- **Price:** the token rates are the same as GPT Image 2.5: $5 text input, $8 image input, $30 image output per 1M tokens.
- **Token use:** OpenAI's own calculator gives 2.6 4.2x 2.5's output tokens at quality low and 3.3x at medium; high, xhigh and max cost the same as 2.5. At 1024x1024 that is about $0.025 against $0.006 at low, $0.044 against $0.013 at medium, and $0.053 at high for both.
- **Same as 2.5:** quality auto to max, transparent backgrounds, custom sizes in multiples of 16 with ratios from 1:3 to 3:1, and `input_fidelity` left out.
- **New in 2.6:** a `complexity` setting (low, medium or high; default high; no fee; OpenAI suggests low for most edits), animated GIF output (generations and edits) and SVG output (generations only, n=1). `markup` is new as well, but it works on 2.5 too.
- **Unchanged inputs:** up to 16 images and the alpha mask.

**One code finding for Scumble:** `electron/main/providers/openai.js:36-37` decides the size rules with the regex `/gpt-image-2\.5/`. A 2.6 id would fall through to the GPT Image 2 branch (max 2048, no pixel floor, no ratio cap), so that regex has to match 2.6 as well.

**Open points:**
- Is the mask (inpainting) confirmed for 2.6? The 2.6 model page drops 2.5's "inpainting" feature line, but OpenAI's 2.6 prompting guide points masked edits to the mask section.
- Does the 3840 px / 8.29 MP ceiling apply to 2.6? Only the official calculator says so; no text does.
- Does the Responses API image tool accept 2.6?
- What are the GIF size limits?

## Report

## GPT-Image-2.6 Sunburst and Flare: OpenAI's own facts

### 1. Release date and where the facts come from
- **Released 4 November 2026.** Sources: the English announcement (https://openai.com/en-US/index/introducing-images-2-6/ shows "November 4, 2026"; the bare /index/ URL returns 403 to fetchers, the locale URLs return 200) and the German one (https://openai.com/de-DE/index/introducing-images-2-6/, "4. November 2026"; both read 2026-11-06). The API changelog has a "Nov 4" entry: "Released GPT-Image-2.6 Sunburst and GPT-Image-2.6 Flare ... adjustable complexity, SVG generation, and animated GIF generation. Added markup-guided editing for supported GPT Image 2.5 and 2.6 models." (https://developers.openai.com/api/docs/changelog.md, read 2026-11-06). The user's "heute" is therefore two days late.
- **Spec history.** The 2.6 ids entered `openai/openai-openapi` in commit `5882fdd9` at 2026-11-05T01:32:39Z ("Add GIF and SVG support and new image parameters"). `3e288ba5` and `9752a7f1` (SVG, 2026-11-06T02:14Z) followed (gh api, read).
- **A third-party error.** kie.ai says the ids "first surfaced Oct 28" in the spec. That is wrong: the 28 October commit `aa880040` only added `markup`.
- **Fetching tip.** OpenAI's docs pages have Markdown twins (append `.md`). Everything below was read from those twins and from the spec saved in the scratch folder.

### 2. Model ids and what each is for
| | Sunburst | Flare |
|---|---|---|
| API id | `gpt-image-2.6-sunburst` | `gpt-image-2.6-flare` |
| Snapshots | the alias only; **no dated snapshot** (2.5 had `-2026-09-08`) | the alias only |
| OpenAI's line | "Image generation and editing for detailed visual work" | "Image generation and editing for fast iteration" |
| Prompting guide | "the base model for workflows that need more detail or precise edits" | "the smaller model for workflows where speed matters most" |
| Announcement | "higher-quality image generation and even greater image consistency across edits when quality is set to medium or high" | "When quality is set to low, Flare can generate images in as little as six seconds"; also "improves layout quality for posters, product imagery" |

Model-page sources (read): `developers.openai.com/api/docs/models/gpt-image-2.6-sunburst.md` and `...-flare.md`.

The announcement also says Images 2.6 "generates images 50% faster than before" (read).

OpenAI's migration advice (prompting guide, read):
- 2.5 Flare goes to 2.6 Flare, and 2.5 Sunburst goes to 2.6 Sunburst.
- A GPT Image 2 workflow that is good enough goes to Flare; one that falls short goes to Sunburst.

### 3. Endpoints
- **Image API: supported.** `v1/images/generations` and `v1/images/edits` (model pages, read).
- **Responses API: "Not supported"** on the 2.6 model pages, and the 2.6 changelog entry names only the two images endpoints. The 2.5 changelog entry also named `v1/responses`, and the 2.5 pages add "or as the model of the Responses API image generation tool". The Responses image-tool guide lists only 2.5, 2, 1.5 and 1-mini (`guides/tools-image-generation.md` line 5).
  - The spec's `ImageGenTool.model` enum does list both 2.6 ids (openapi.yaml ~55534).
  - Status: **unverified** whether the Responses tool accepts 2.6. Scumble uses only the Image API, so this does not block the integration.
- **Batch: "Not supported"** for 2.6 (read). 2.5 supports Batch at $15 per 1M output tokens.

### 4. Inputs
- **Reference images:** up to 16, png, webp or jpg, under 50 MB each. Source: the spec's `CreateImageEditRequest.image` with `maxItems: 16` (openapi.yaml ~48278) and the JSON body `images` with maxItems 16 (~51455).
  - The prose list of models there stops at 2.5; the JSON body says "For GPT image models". Applies to 2.6 by inference.
  - The model enum of `/edits` includes 2.6 (~48366, read).
- **Mask (inpainting):** the spec's `mask` field is generic: a PNG under 4 MB, the same size as the first image, alpha 0 = edit, "applied on the first image" (read).
  - The 2.6 prompting guide says "For local edits that require a mask, see editing with a mask" (`guides/image-prompting.md` line 556).
  - The 2.5 model pages list "Supported features: inpainting"; the 2.6 pages have no features section at all.
  - Status: supported by inference, not confirmed.
  - GIF output does not support masks (spec `frame_count`, read).
- **`markup` (new in the API):** a transparent PNG overlay on the first input image, used on `/edits` only.
  - It must have the first image's dimensions after orientation and must contain transparent pixels.
  - At most 16,777,216 px each for the first image and the overlay, and at most 50 MB for the overlay.
  - It cannot be combined with `mask` or `prompt_rewriter`. Further images act as references.
  - It works on GPT Image 2.5 too (spec `markup` schema ~88167: "Supports GPT Image 2.5 and 2.6"; image-generation guide lines 2560-2670; read).
  - In JSON form it is an object with exactly one of `image_url` or `file_id`.
- **`input_fidelity`:** "Omit `input_fidelity` on image edits." (prompting guide line 63, read). Also: "GPT Image 2.6 does not support `reasoning.summary`."
- **Prompt length:** 32,000 characters (spec, read).

### 5. Output
- **Sizes:**
  - Prompting guide: `auto`, or `WIDTHxHEIGHT` in multiples of 16 with an aspect ratio from 1:3 to 3:1; examples include 1536x864 (read).
  - The edge and pixel ceilings appear only in OpenAI's token calculator (`GptImageTokenCalculator.react.D6e1YylC.js`, read). It checks every model, 2.6 included, against an edge of at most 3840 px and 655,360 to 8,294,400 px in total.
  - The prose sentence with those numbers sits under the 2.5 heading, and the spec's `size` text still names only 2 and 2.5. So 2.6 sharing 2.5's limits is **inferred** from OpenAI's own calculator.
  - "Above 2560x1440 is experimental" is stated for 2.5 only.
- **Quality:** `auto, low, medium, high, xhigh, max` (prompting guide table line 52, read; the calculator offers all five for 2.6). The spec prose still names only 2.5 for xhigh and max.
- **`complexity` (new):**
  - Values `low | medium | high`; Sunburst and Flare both use `high` when it is omitted.
  - "Adjusting complexity has no separate fee."
  - It sets how much the model plans the image, independently of `quality`.
  - Announcement: "For most editing tasks, we recommend low complexity for faster edits"; medium or high suits scenes with many elements.
  - It is in the spec on generations, edits (multipart and JSON) and the Responses tool (read).
- **Background:** `auto | opaque | transparent`. "Both support image generation, editing, and transparent backgrounds" (prompting guide line 30, read). Use png or webp; SVG supports transparency too.
- **Formats:**
  - `png | jpeg | webp`.
  - **`gif`** on generations **and** edits: `frame_count` 2-16 (default 9), `frame_duration_ms` 20-2000 (default 200, rounded to 10 ms). No streaming, partial images, masks, `output_compression` or `prompt_rewriter`. It "Requires access to the GIF preview for the selected model" (spec, read). The per-model GIF size limits are not stated.
  - **`svg`** on **generations only**: n=1, no streaming, partials, compression or prompt_rewriter. The edit endpoint gives no SVG, and an SVG cannot be an edit input. The `svg {model, reasoning}` object picks the authoring model. "SVG output requires a supported image model and project access."
  - `output_compression` 0-100 for jpeg and webp. GPT image models always return `b64_json`.
- **Streaming:** `stream` plus `partial_images` 0-3; each partial costs 100 extra output tokens. This is documented for GPT image models in general, not stated for 2.6 specifically (inferred). Scumble does not stream (`openai.js:18`).
- **Moderation:** `auto | low` (spec, general, read).
- **n:** 1-10.

### 6. Price, rate limits, access
- **Token rates** (pricing.md, read): $5 text input / $1.25 cached, $8 image input / $2 cached, $30 image output per 1M tokens. These are identical to 2.5 and 2. There is no Batch row for 2.6.
- **Output tokens per image:** OpenAI's calculator multiplies 2.5's count for 2.6 by `{low: 4.2, medium: 3.3, high: 1, xhigh: 1, max: 1}`. Costs below come from a port of that formula (scratch `calc.js`):

| 1024x1024 | low | medium | high | xhigh | max |
|---|---|---|---|---|---|
| 2.5 | 196 tok, $0.0059 | 439, $0.0132 | 1756, $0.0527 | 3122, $0.0937 | 7024, $0.2107 |
| 2.6 | 823, $0.0247 | 1449, $0.0435 | 1756, $0.0527 | 3122, $0.0937 | 7024, $0.2107 |

  At 3840x2160 the 2.6 numbers are low $0.047, medium $0.086, high $0.100 and max $0.400. These are estimates of output tokens only; input image tokens come on top.

  **Takeaway for Scumble:** at low and medium, 2.6 costs about 3-4x what 2.5 does; at high and above it costs the same.
- **Rate limits:** "vary by usage tier and account", with no numbers given for 2.6. The 2.5 page lists Build 250,000 TPM / 20 IPM, Launch 3,000,000 / 150, Grow 8,000,000 / 250 (read).
- **Access:** GPT Image models may need API Organization Verification (image-generation guide lines 36-41, general, read). GIF and SVG may be gated by preview or project access (spec, read).
- **Deprecations:** `gpt-image-1-mini`, `gpt-image-1.5` and `chatgpt-image-latest` shut down on 1 December 2026, with 2.6 named as the replacement. 2.5 and 2 are not deprecated (deprecations.md lines 168-170, read).
- **Early-access customers named by OpenAI:** Picsart, fal, Sable, Higgsfield. Quotes from OpenArt and Figma Weave (announcement, read). That hints that fal already has it, but **unverified here; that is the provider agents' angle.**
- **SDK:** `openai-python` `src/openai/types/image_model.py` lists both 2.6 ids (gh api, read); its releases v3.46.0 and v3.47.0 date from 2026-11-05.

### 7. Changes from GPT Image 2.5 (what Scumble assumes for 2.5)
For 2.5 Scumble assumes 3840 px a side, 655,360-8,294,400 px, at most 3:1, transparency and the mask. Sources: `recipes/gpt_image_2_5_sunburst.json` (openai variant `limits`), `docs/RECIPES.md:602`, `openai.js:29-37`.
- **Same:** token rates, quality list including xhigh and max, transparency, size rules (inferred from OpenAI's calculator), 16 images, mask (inferred), `input_fidelity` left out, moderation.
- **New:** `complexity` (default high), GIF output (generations and edits), SVG output (generations), roughly 50% faster.
- **New but shared with 2.5:** `markup` (works on 2.5 as well).
- **Lost:** Batch support, a dated snapshot, a documented Responses-tool route.
- **More expensive at low and medium:** 4.2x and 3.3x the output tokens (calculator).

### 8. What this means in Scumble's code (read only, nothing edited)
- **`electron/main/providers/openai.js:36-37` needs a change.** `sizeRules` tests `/gpt-image-2\.5/` first and then `/gpt-image-2/`. `gpt-image-2.6-*` misses the first branch and gets GPT Image 2's rules (`max: 2048, minPixels: 0, maxRatio: 0`). For 2.5's 3840 / 655,360-8,294,400 / 3:1 rules the regex has to become e.g. `/gpt-image-2\.[56]/`, and the comments on lines 10-11 and 33 need the same update.
- **`openai.js:78`** sends `input_fidelity` only for `gpt-image-1*`, which already matches OpenAI's "omit on 2.6".
- **`common()` (openai.js:54-81)** passes quality, background, format, compression and moderation. A **Complexity** row (`low/medium/high`) would be new. OpenAI recommends `low` for targeted edits (which a Scumble inpaint is) and defaults to `high`.
- **Out of scope for a first pass:** `markup` (it conflicts with `mask`), and GIF/SVG (Scumble lands raster layers).
- **`comfycloud.js:71`** tests `/gpt-image-2/`, which also matches 2.6 ids, so Custom sizes apply there.
- **Tests that list recipe ids by hand** and must grow if new recipes are added: `tools/recipes_test.js:211,259-260`, `tools/openrouter_test.js:672`, `tools/oxen_test.py:45`, `tools/oxen_test.js:562`, `tools/magnific_test.js:676,718` / `.py:48,51`, `tools/comfyrouter_test.py:52` / `.js:300`.

### Files saved
All in `C:/Users/SCHOEN~1/AppData/Local/Temp/claude/F--canvas/543d44fb-4d2d-4818-8804-974916d10a44/scratchpad/gpt26_openai/`:
- `spec/openapi.yaml` (main at 9752a7f1) and `spec/diff_5882fdd9.diff` (the 2.6 commit)
- `pages/developers.openai.com_api_docs_guides_image-generation.md`, `pages/g_guides_image-prompting.md`, `pages/developers.openai.com_api_docs_pricing.md`, `pages/developers.openai.com_api_docs_changelog.md`, `pages/developers.openai.com_api_docs_models_gpt-image-2.6-*.md`, `pages/g_deprecations.md`
- `pages/announce_en.txt`, `pages/announce_de.txt`
- `pages/calc.js` (OpenAI's calculator) and `calc.js` (the port with the cost table)

## Facts

- [read] GPT-Image-2.6 Sunburst and Flare were announced and released on 4 November 2026 (ChatGPT, Codex, API), not on 2026-11-06 (https://openai.com/en-US/index/introducing-images-2-6/ and https://openai.com/de-DE/index/introducing-images-2-6/ (read 2026-11-06); https://developers.openai.com/api/docs/changelog.md 'Nov 4')
- [read] The 2.6 ids first appeared in openai/openai-openapi in commit 5882fdd9 at 2026-11-05T01:32:39Z; the Oct 28 commit aa880040 only added markup (gh api repos/openai/openai-openapi/commits (read 2026-11-06))
- [read] API model ids are gpt-image-2.6-sunburst and gpt-image-2.6-flare; each has only that alias as a snapshot, no dated snapshot (https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst.md and ...-flare.md (read 2026-11-06))
- [read] Sunburst: 'detailed visual work', the base model for detail and precise edits; Flare: 'fast iteration', the smaller model, as little as six seconds at quality low; Images 2.6 is 50% faster than before (model pages; guides/image-prompting.md line 30; announcement (read 2026-11-06))
- [read] Supported endpoints: v1/images/generations and v1/images/edits; Responses and Batch are listed as Not supported (2.5 supports Batch) (model pages .md for 2.6 and 2.5 (read 2026-11-06))
- [read] The spec's Responses image_generation tool enum already lists both 2.6 ids, contradicting the docs (openai-openapi openapi.yaml ImageGenTool.model (~line 55534), read 2026-11-06)
- [read] Token prices equal 2.5 and 2: $5 text in ($1.25 cached), $8 image in ($2 cached), $30 image out per 1M tokens (https://developers.openai.com/api/docs/pricing.md lines 386-389 (read 2026-11-06))
- [inferred] OpenAI's calculator gives 2.6 4.2x (low) and 3.3x (medium) the output tokens of 2.5 and the same at high, xhigh and max; 1024x1024 low about $0.025 vs $0.006, medium $0.044 vs $0.013, high $0.053 for both (developers.openai.com/_astro/GptImageTokenCalculator.react.D6e1YylC.js (read 2026-11-06), computed with scratch calc.js)
- [read] 2.6 quality values: auto, low, medium, high, xhigh, max (guides/image-prompting.md line 52 (read 2026-11-06))
- [read] New complexity parameter low/medium/high, default high on both models, no separate fee; OpenAI recommends low for most edits (guides/image-generation.md lines 47-53; announcement (read 2026-11-06))
- [read] Custom sizes for 2.6: multiples of 16, aspect ratio 1:3 to 3:1 (guides/image-prompting.md line 61 (read 2026-11-06))
- [inferred] 2.6 shares 2.5's 3840 px edge and 655,360-8,294,400 px limits (OpenAI calculator validation applies these constants to the gpt-image-2.6 option; the prose sentence is under 2.5 (read 2026-11-06))
- [read] Both 2.6 models support transparent backgrounds (png/webp; SVG too) (guides/image-prompting.md lines 30 and 55 (read 2026-11-06))
- [read] GIF output on generations and edits (frame_count 2-16 default 9, frame_duration_ms 20-2000 default 200; no streaming, partials, masks, compression; preview access needed); SVG output on generations only, n=1, project access needed (guides/image-generation.md lines 3296-3345; openapi.yaml frame_count/svg schemas (read 2026-11-06))
- [inferred] Up to 16 input images (png/webp/jpg, under 50 MB) on /images/edits (openapi.yaml CreateImageEditRequest.image maxItems 16 and EditImageBodyJsonParam.images (read 2026-11-06); the prose list stops at 2.5)
- [unverified] The mask (alpha-0 PNG under 4 MB, same size as the first image) works with 2.6; the 2.6 pages drop 2.5's 'inpainting' feature line, but the 2.6 prompting guide points masked edits to the mask section (openapi.yaml mask field; guides/image-prompting.md line 556; gpt-image-2.5-sunburst.md 'Supported features: inpainting' (read 2026-11-06))
- [read] markup: a transparent PNG on the first image, same dimensions, at most 16,777,216 px, at most 50 MB, not combinable with mask or prompt_rewriter, works on 2.5 and 2.6, /edits only (guides/image-generation.md lines 2560-2670; openapi.yaml markup schema ~88167 (read 2026-11-06))
- [read] Leave out input_fidelity on 2.6 edits; 2.6 does not support reasoning.summary (guides/image-prompting.md line 63 (read 2026-11-06))
- [read] No numeric rate limits are published for 2.6; 2.5 lists Build 250,000 TPM / 20 IPM, Launch 3,000,000 / 150, Grow 8,000,000 / 250 (model pages .md (read 2026-11-06))
- [read] gpt-image-1-mini, gpt-image-1.5 and chatgpt-image-latest shut down on 1 December 2026, with 2.6 as the replacement; 2.5 and 2 are not deprecated (https://developers.openai.com/api/docs/deprecations.md lines 168-170 (read 2026-11-06))
- [read] Early-access customers named: Picsart, fal, Sable, Higgsfield (announcement en-US (read 2026-11-06))
- [read] Scumble's openai.js sizeRules tests /gpt-image-2\.5/ then /gpt-image-2/, so a 2.6 id would get GPT Image 2's rules (max 2048, no floor, no ratio cap) (F:/canvas/electron/main/providers/openai.js:36-37)
- [read] Scumble's openai.js sends input_fidelity only to gpt-image-1*, already as OpenAI asks for 2.6 (F:/canvas/electron/main/providers/openai.js:78)
- [read] comfycloud.js matches /gpt-image-2/, which also covers 2.6 ids for Custom sizes (F:/canvas/electron/main/providers/comfycloud.js:71)
- [read] Test files list GPT recipe ids by hand and would need the new ids (F:/canvas/tools/recipes_test.js:259-260, tools/openrouter_test.js:672, tools/oxen_test.py:45, tools/magnific_test.js:676, tools/comfyrouter_test.py:52)
- [read] openai-python's ImageModel type already includes both 2.6 ids (gh api repos/openai/openai-python/contents/src/openai/types/image_model.py (read 2026-11-06))

## Open questions

- Does the Responses API image_generation tool accept gpt-image-2.6-*? The spec enum says yes; the model pages, changelog and tool guide say no or name only 2.5. It does not matter for Scumble, which uses the Image API.
- Is mask inpainting confirmed for 2.6? The model page drops 2.5's 'inpainting' feature line; only the prompting guide's pointer to the mask section suggests it works.
- Are 2.6's size limits exactly 2.5's (3840 px edge, 8,294,400 px, experimental above 2560x1440)? Only OpenAI's calculator says so; no prose does.
- Does billing follow the calculator's 4.2x / 3.3x output tokens at low and medium? Only the response's usage field in a real run would show it.
- What complexity default should Scumble send? OpenAI omits to high but recommends low for most edits, and an inpaint is a targeted edit.
- What are the GIF size limits per model, and is GIF/SVG access gated per project (preview)? Both are out of scope for raster layers anyway.
- The user said 'heute': the release was 2026-11-04. Should the CHANGELOG or post date this as Nov 4?
- Not read: the Images 2.6 system card (deploymentsafety.openai.com) and OpenAI's developer forum thread.
