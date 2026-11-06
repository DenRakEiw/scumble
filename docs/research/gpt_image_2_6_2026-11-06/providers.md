# providers

## Summary

OpenAI released GPT-Image-2.6 on 2026-11-04 (its announcement page carries that date), not today. The API ids are `gpt-image-2.6-flare` and `gpt-image-2.6-sunburst`. Each model page lists only that one snapshot. Both work on /v1/images/generations and /v1/images/edits, not on Responses or Batch. Token prices match 2.5: $5 text input, $8 image input, $30 image output per 1M. New in 2.6: a `complexity` field (low/medium/high, default high), markup-guided edits, and GIF and SVG output.

Six of Scumble's ten API hosts list it (all read 2026-11-06 around 02:50 UTC):
- **OpenAI direct:** yes.
- **fal:** `openai/gpt-image-2.6/{sunburst,flare}/{edit,text-to-image}`, with mask_url, up to 16 image_urls, and complexity under the name `reasoning_effort`.
- **Replicate:** `openai/gpt-image-2.6-{sunburst,flare}`, no mask, $0.05 to $0.50 per image by quality.
- **WaveSpeed:** `openai/gpt-image-2.6-{sunburst,flare}/{edit,text-to-image}`, with mask_image, markup_image, complexity and resolution 1k/2k/4k.
- **OpenRouter:** `openai/gpt-image-2.6-{sunburst,flare}` on /api/v1/images, no mask; complexity and moderation go through as passthrough parameters.
- **ToAPIs:** `gpt-image-2.6-{sunburst,flare}-official`, with mask_url. Sunburst is billed at 80% of OpenAI's price. Flare is marked "Pending pricing approval; disabled".

Four hosts do not list it yet:
- **Comfy Cloud:** the live node still offers only 2.5 options. ComfyUI PR #17558, which adds 2.6 with a `model.complexity` input, was merged at 01:46 UTC today; backport v0.44.1 is still open.
- **Comfy Router:** the 2.6 schema documents return 404.
- **Oxen.ai:** not in its public model list.
- **Magnific:** not in its OpenAPI spec (last modified 2026-11-05).

Scumble has no Azure adapter, and Azure's docs list only 2.5.

Two code points matter for integration:
- `openai.js` sizeRules: 2.6 currently falls into GPT Image 2's branch (max 2048, no ratio cap). Comfy Router reuses these rules.
- `common()` in `openai.js` and the Comfy Cloud node builder (SHAPES) do not pass `complexity`.

I also found three things out of date in the 2.5 recipes. WaveSpeed's 2.5 edit now takes mask_image, though the recipe's note says it has no mask input. fal and Replicate both host 2.5, but the 2.5 recipes have neither as a variant.

## Report

## GPT-Image-2.6 Sunburst / Flare: which API providers list it (read 2026-11-06, about 02:45-03:00 UTC)

### The release
- OpenAI's page "Introducing Images 2.6" (https://openai.com/index/introducing-images-2-6/, read with curl, since WebFetch got a 403) is dated **November 4, 2026**. It says: "GPT-Image-2.6 Sunburst and GPT-Image-2.6 Flare are available in the API". Flare generates images 50% faster and can take as little as six seconds at quality low; Sunburst gives higher quality and more consistency across edits at medium/high. New in the API are image markup, SVG export and a new `complexity` parameter. OpenAI's advice: "For most editing tasks, we recommend low complexity for faster edits" (read).
- OpenAI's spec repo openai/openai-openapi: commit `5882fdd9` (2026-11-05T01:32:39Z, "Add GIF and SVG support and new image parameters") added `gpt-image-2.6-sunburst` and `gpt-image-2.6-flare` to the model enums (read via `gh api`).
- Model pages https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst and https://developers.openai.com/api/docs/models/gpt-image-2.6-flare each list only that one snapshot. Supported: `v1/images/generations` and `v1/images/edits`. Not supported: Responses, Batch, Chat. Prices per 1M tokens: text input $5 (cached $1.25), image input $8 (cached $2), image output $30. No per-image price is given (read).

### Overview

| Scumble adapter | Listed? | Ids | Mask | References | Size | Quality / complexity | Price |
|---|---|---|---|---|---|---|---|
| openai (direct) | **yes** | `gpt-image-2.6-sunburst`, `gpt-image-2.6-flare` | `mask` field in the edit schema; not stated for 2.6 by name (inferred yes) | `image` up to 16 | WxH ×16 (inferred: 2.5's rules) | quality low..max/auto (xhigh/max inferred); `complexity` low/medium/high | $5 / $8 / $30 per 1M tokens |
| fal | **yes** | `openai/gpt-image-2.6/{sunburst,flare}/{edit,text-to-image}` | `mask_url`, white = edit | `image_urls` up to 16 | `image_size` preset / {w,h} / auto | quality auto..max (default high); `reasoning_effort` = complexity | tokens as OpenAI, text output $10/M |
| replicate | **yes** | `openai/gpt-image-2.6-sunburst`, `openai/gpt-image-2.6-flare` | **no** | `input_images` | `aspect_ratio` enum incl. fixed sizes | quality low..max/auto; `complexity` | $0.05 / 0.09 / 0.128 / 0.25 / 0.50 per image (low..max; auto $0.25) |
| wavespeed | **yes** | `openai/gpt-image-2.6-{sunburst,flare}/edit`, `/text-to-image` | `mask_image` (white = edit, or transparent = edit) | `images` up to 16 | `aspect_ratio` (15) + `resolution` 1k/2k/4k | quality low..max (default medium); `complexity` | e.g. medium 1k $0.05 + $0.015 per image (formula below) |
| openrouter | **yes** | `openai/gpt-image-2.6-sunburst`, `openai/gpt-image-2.6-flare` | **no** | `input_references` 0-16 | `aspect_ratio` (9 incl. auto) | quality auto..max; complexity passthrough | $5 text / $8 image input, $30 output per 1M |
| toapis | **yes, official channel only** | `gpt-image-2.6-sunburst-official`, `gpt-image-2.6-flare-official` | `mask_url` (PNG alpha) | `image_urls` up to 16 | ratio name or WxH + `resolution` | quality auto..max (default medium); `complexity` | Sunburst 80% of OpenAI's price; **Flare "disabled"** |
| comfycloud | **no, not yet** (PR merged) | will be `gpt-image-2.6-*` on `OpenAIGPTImageNodeV2` | `model.mask` | 16 | as 2.5 | + `model.complexity` | badges as 2.5 |
| comfyrouter | **no** | (inferred `openai/gpt-image-2.6-*`) | - | - | - | - | - |
| oxen | **no** | (unverified: `gpt-image-2-6-*`) | - | - | - | - | - |
| magnific | **no** | - | - | - | - | - | - |
| (Azure, no Scumble adapter) | not in the docs | - | - | - | - | - | - |

### Per provider

**OpenAI direct** (read: openapi.yaml at main `9752a7f1`, CreateImageEditRequest about lines 48270-48580, schemas about 88133-88270)
- Edit (multipart): `image` (string or array of at most 16), `prompt` (up to 32,000 chars) and `mask`. The mask is a PNG under 4 MB, its alpha-0 areas are edited, and on several images it applies to the first.
- `markup`: described in the edit field as "Supports GPT Image 2.5" and in the shared schema as "Supports GPT Image 2.5 and 2.6"; it cannot be combined with `mask`.
- Other fields: `complexity` (low/medium/high/null; "Uses the image model's configured default when omitted"), `quality` (low/medium/high/xhigh/max/auto), `background` (transparent/opaque/auto), `output_format` (png/webp/jpeg/gif/svg), `n` 1-10, `size`, `moderation`, `frame_count` / `frame_duration_ms` (GIF only).
- The spec's size and quality texts still name only 2.5 for free sizes and for xhigh/max (read).
- Size rules (inferred same as 2.5): the guide https://developers.openai.com/api/docs/guides/image-generation (offset 100000) states multiples of 16, edge ≤3840, 655,360-8,294,400 px, 1:3-3:1, "above 2560x1440 experimental", beside captions that name 2.6. fal and ToAPIs state the same rules for 2.6 explicitly. The guide says both models default to complexity `high` (read).
- OpenRouter's OpenAI endpoint lists xhigh/max for 2.6, so quality xhigh/max at OpenAI direct is inferred yes.

**fal** (read: `https://api.fal.ai/v1/models?q=gpt-image` and `?endpoint_id=...&expand=openapi-3.0`, no key needed)
- Four endpoints, all `status: active`; metadata date 2026-11-04T18:11Z, updated 2026-11-04T23:49Z to 2026-11-05T00:14Z.
- Edit input (GptImage26SunburstEditInput / GptImage26FlareEditInput): required `prompt` and `image_urls` (maxItems 16).
  - `mask_url`: "White marks regions to edit and black marks regions to keep", the same text as on `openai/gpt-image-2/edit`, which Scumble already uses with `fields {images: image_urls, mask: mask_url}`.
  - `markup_image_url`: not combinable with mask_url.
  - `image_size`: square_hd, square, portrait_4_3, portrait_16_9, landscape_4_3, landscape_16_9, auto or {width,height}; default auto = "infer from input images".
  - `quality`: auto/low/medium/high/xhigh/max, default high.
  - `reasoning_effort`: low/medium/high, default high, described as "(OpenAI `complexity`)".
  - Also `background`, `output_format` (jpeg/png/webp/gif), `output_compression`, `num_images` 1-10, `frame_count`, `frame_duration_ms`, `sync_mode`, `enable_safety_checker`.
- Text-to-image adds `svg` and `svg_model`. Its size rule: "multiples of 16, max edge 3840px, aspect ratio <= 3:1, total pixels between 655,360 and 8,294,400".
- Price (https://fal.ai/models/openai/gpt-image-2.6/sunburst/edit/llms.txt): text tokens $5 input / $1.25 cached / $10 output, image tokens $8 / $2 / $30 per 1M; "by default we use high".

**Replicate** (read: https://replicate.com/openai/gpt-image-2.6-sunburst/api/schema and the model pages; `openai/gpt-image-2.6` → 404)
- Official models. Sunburst version `b5a51b16…` was created 2026-11-05T22:26:28Z, Flare version `66b3a121…` 2026-11-05T20:46:00Z.
- Input fields: `prompt` (required), `openai_api_key` (optional; Replicate's proxy is used without it) and `input_images` (URIs, no maximum stated). No mask field.
  - `aspect_ratio`: 1:1, 3:2, 2:3, 4:3, 3:4, 16:9, 9:16, auto, 1024x1024, 1536x1024, 1024x1536, 1536x1152, 1152x1536, 2048x2048, 2048x1152, 1152x2048, 3840x2160, 2160x3840; default 1:1.
  - `number_of_images` 1-10, `quality` (low..max/auto, default auto), `complexity` (default high), `background`, `moderation`.
  - `output_format`: png/jpeg/webp/gif/svg, default **webp**.
  - Also `output_compression` (default 90), `frame_count`, `frame_duration_ms`, `svg_model`.
- Price per output image (billingConfig in the page): low $0.05, medium $0.09, high $0.128, xhigh $0.25, max $0.50, auto $0.25. GIF and SVG are billed by tokens.
- Scumble's `gpt_image_2` Replicate variant (`fields.images: input_images`, `fixed.output_format: png`, input "edit") has the same shape.

**WaveSpeed** (read: `https://wavespeed.ai/models/<id>/llms.txt` and the page JSON; `openai/gpt-image-2.6/edit` → 404)
- Edit: `prompt`, `images` (required, maxItems 16).
  - `mask_image`: "white marks the area to edit, black the area to keep (a PNG where transparent marks the area to edit is also accepted). It is resized to the first image."
  - `markup_image`: either mask or markup.
  - `aspect_ratio`: 1:1, 1:2, 2:1, 1:3, 3:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 9:21, 21:9; when omitted, taken from the input image.
  - `resolution` 1k/2k/4k (default 1k), `quality` low..max (default medium), `complexity` (default high, "does not change the price"), `output_format` png/jpeg/webp.
- Text-to-image: aspect default 1:1; output_format also takes gif and svg; plus frame_count and frame_duration_ms.
- Price formula, in units of 1e-6 USD (inferred unit), the same for Flare and Sunburst:

  | Quality | 1k | 2k | 4k |
  |---|---|---|---|
  | low | 0.03 | 0.06 | 0.10 |
  | medium | 0.05 | 0.10 | 0.18 |
  | high | 0.06 | 0.12 | 0.21 |
  | xhigh | 0.11 | 0.21 | 0.38 |
  | max | 0.25 | 0.47 | 0.85 |

  An edit adds $0.015 per input image, plus $0.015 if a mask or markup is sent. The page shows `discount_rate` 90 and "Base price $0.0585", which is medium 1k with one image at 90%.

**OpenRouter** (read: `https://openrouter.ai/api/v1/models?output_modalities=image`, `/api/v1/images/models`, `/api/v1/images/models/openai/gpt-image-2.6-sunburst/endpoints`, all without a key)
- `openai/gpt-image-2.6-sunburst` (canonical `-20261104`, created 2026-11-04T23:35:57Z) and `openai/gpt-image-2.6-flare` (created 23:35:51Z). Endpoint `/api/v1/images`, one provider: OpenAI.
- Parameters:
  - `aspect_ratio`: 1:1, 3:2, 2:3, 4:3, 3:4, 16:9, 9:16, 21:9, auto.
  - `quality`: auto/low/medium/high/xhigh/max.
  - `background`: auto/transparent/opaque.
  - `n` 1-10 and `input_references` 0-16.
  - `output_format`: png/jpeg/webp/gif (new compared with 2.5's list).
  - `output_compression` 0-100.
  - `allowed_passthrough_parameters`: `moderation`, `complexity`.
- No mask. Pricing: input image $8/M, input text $5/M, output image $30/M tokens.

**ToAPIs** (read: https://docs.toapis.com/llms.txt, https://docs.toapis.com/docs/en/api-reference/images/gpt-image-2.6-official/generation.md, https://toapis.com/api/pricing)
- Only an official channel exists for 2.6: `gpt-image-2.6-sunburst-official`, `gpt-image-2.6-flare-official`. There is no standard or VIP entry.
- Request: `POST /v1/images/generations`, async task.
  - `size`: a ratio name or WxH (×16, ≤3840, 655,360-8,294,400 px). `resolution` 1k/2k/4k takes precedence when set.
  - `quality` auto..max (default medium), `n` 1-4, `output_format` png/jpeg/webp/gif/svg, `background`, `moderation`, `complexity` (default high).
  - `image_urls` up to 16.
  - `mask_url`: "a PNG alpha mask whose size must match the first reference image"; requires image_urls. Scumble's 2.5 official variant has no mask.
  - `markup_url` / `markup`: excludes mask_url.
- Pricing JSON:
  - Sunburst official: "GPT Image 2.6 Sunburst via APIMart upstream. 官方价格 8 折计费", i.e. billed at 80% of the official price.
  - Flare official: "GPT Image 2.6 Flare via APIMart upstream. Pending pricing approval; disabled."
  - Both rows were created 2026-11-05T10:07Z.

**Comfy Cloud** (read: Comfy Cloud MCP `get_node OpenAIGPTImageNodeV2` with refresh, catalog refreshed 2026-11-06T02:54:38Z)
- The live node is still named "OpenAI GPT Image 2.5". Its model options: gpt-image-2.5-flare, gpt-image-2.5-sunburst, gpt-image-2, gpt-image-1.5. The MCP partner model `openai/images-generations` also names only 2.5.
- Comfy-Org/ComfyUI PR #17558 "[Partner Nodes] feat(OpenAI): add GPT Image 2.6 models" (https://github.com/Comfy-Org/ComfyUI/pull/17558) was merged 2026-11-06T01:46:26Z (`52a20aa7`). It keeps the same node id, renames the display name to "OpenAI GPT Image 2.6", and adds the options `gpt-image-2.6-flare` and `gpt-image-2.6-sunburst`. These carry the 2.5 inputs (sizes, Custom 480-3840, background auto/opaque/transparent, quality low..max, 16 images, mask) plus a combo `complexity` (low/medium/high, default "high"), which the node passes to OpenAI as `complexity`. Price badges equal 2.5's.
- The backport PR #17568 "ComfyUI backport release v0.44.1" (open) includes it. When Comfy Cloud deploys it is not stated.

**Comfy Router** (read: https://docs.comfy.org/llms.txt and https://docs.comfy.org/development/comfy-router/models.md)
- Only `openai/gpt-image-2`, `-2.5-flare`, `-2.5-sunburst` and `-1.5` are listed.
- `https://docs.comfy.org/router-schemas/openai/gpt-image-2.6-{sunburst,flare}.json` → 404, while 2.5-sunburst.json → 200.

**Oxen.ai** (read: https://hub.oxen.ai/api/ai/models)
- 230 models; the newest was created 2026-11-05T23:14Z.
- The GPT entries are `gpt-image-1-5`, `gpt-image-2`, `gpt-image-2-5-flare` and `gpt-image-2-5-sunburst`; there is no 2.6.

**Magnific** (read: https://storage.googleapis.com/fc-freepik-pro-rev1-eu-api-specs/magnific-api-v1-openapi.yaml, Last-Modified Thu, 05 Nov 2026 14:10:05 GMT)
- Paths: `/v1/ai/text-to-image/gpt-image-2(-edit)` and `gpt-image-2-5(-edit)`. The 2.5 `variant` enum is flare|sunburst only.
- Nothing mentions 2.6.

**Azure / Foundry** (no Scumble adapter): https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure names gpt-image-2, 2.5-flare and 2.5-sunburst only. ai.azure.com/catalog answers 200 for any id, even a made-up one, so it proves nothing.

### What the integration has to touch in Scumble (read in code)
1. `electron/main/providers/openai.js:33-37` `sizeRules()`: `/gpt-image-2\.5/` is tested first, then `/gpt-image-2/`. "gpt-image-2.6-flare" therefore gets GPT Image 2's rules: max 2048, no 3:1 cap, no 655,360 px floor. `comfyrouter.js:342-343` reuses `openai._common` and `openai._sizeFor`, so the same fix covers the Router.
2. `openai.js` `common()` (lines ~54-80) passes only quality, background, output_format, output_compression, moderation and input_fidelity. A `complexity` setting would be dropped until it is added there.
3. `comfycloud.js:68-76` `SHAPES.OpenAIGPTImageNodeV2` sets model.size, model.background and model.quality. The 2.6 options add `model.complexity`, which the prompt has to carry (inferred to be a required dynamic-combo sub-field). The existing `/gpt-image-2/` Custom-size branch already covers 2.6.
4. Field names differ by host. fal calls complexity `reasoning_effort`. WaveSpeed, Replicate, ToAPIs and OpenAI call it `complexity`. OpenRouter accepts it only as a passthrough.
5. Mask fields: fal `mask_url` (white = edit), WaveSpeed `mask_image` (white = edit, or transparent = edit), ToAPIs `mask_url` (alpha), OpenAI `mask` (alpha 0 = edit). Replicate and OpenRouter take no mask (instruction edit as in their 2.5 / 2.0 variants).

### Side findings (Scumble's 2.5 recipes look out of date)
- WaveSpeed `openai/gpt-image-2.5-sunburst/edit` now lists `mask_image` (llms.txt, read 2026-11-06). The 2.5 WaveSpeed note in `recipes/gpt_image_2_5_sunburst.json` says "no mask input".
- fal has had `openai/gpt-image-2.5/{flare,sunburst}/{edit,text-to-image}` since 2026-09-11, and Replicate has `openai/gpt-image-2.5-{flare,sunburst}` (HTTP 200). Scumble's 2.5 recipes have neither variant.
- ToAPIs' 2.6 rows say "via APIMart upstream". Scumble's 2.5 ToAPIs note calls the official channel "the vendor's own cloud".

Files read and downloaded for this are in C:/Users/SCHOEN~1/AppData/Local/Temp/claude/F--canvas/543d44fb-4d2d-4818-8804-974916d10a44/scratchpad/gpt26_providers (openapi.yaml, the fal_*.json schemas, rep_*.html, ws_*.txt, or_*.json, toapis_*.md/json, oxen_models.json, magnific.yaml, comfy_pr17558.diff, oai_text.txt).

## Facts

- [read] OpenAI's 'Introducing Images 2.6' page is dated November 4, 2026 and says GPT-Image-2.6 Sunburst and Flare are available in the API; it recommends low complexity for most editing tasks (https://openai.com/index/introducing-images-2-6/ (curl, read 2026-11-06))
- [read] API model ids are gpt-image-2.6-sunburst and gpt-image-2.6-flare; each model page lists only that one snapshot; both support v1/images/generations and v1/images/edits, not v1/responses or Batch (https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst and .../gpt-image-2.6-flare (read 2026-11-06))
- [read] OpenAI direct price per 1M tokens: text input $5 (cached $1.25), image input $8 (cached $2), image output $30 (https://developers.openai.com/api/docs/models/gpt-image-2.6-flare (read 2026-11-06))
- [read] The 2.6 ids entered OpenAI's OpenAPI spec in commit 5882fdd9 at 2026-11-05T01:32:39Z (gh api repos/openai/openai-openapi/commits (read 2026-11-06))
- [read] OpenAI edit schema: image up to 16, mask (alpha 0 = edit, applied to the first image), markup (supports 2.5 and 2.6, not with mask), complexity low/medium/high, quality low..max/auto, output_format png/webp/jpeg/gif/svg, n 1-10 (openai-openapi openapi.yaml main@9752a7f1, CreateImageEditRequest about lines 48270-48580 and schemas about 88133-88200)
- [inferred] 2.6 at OpenAI direct uses 2.5's size rules (x16, edge up to 3840, 655,360-8,294,400 px, 1:3-3:1) and accepts quality xhigh/max (OpenAI image-generation guide (offset 100000), fal 2.6 t2i schema, ToAPIs 2.6 doc, OpenRouter endpoint list)
- [read] fal lists openai/gpt-image-2.6/sunburst/edit, openai/gpt-image-2.6/flare/edit, openai/gpt-image-2.6/sunburst/text-to-image and openai/gpt-image-2.6/flare/text-to-image, all active (https://api.fal.ai/v1/models?q=gpt-image (read 2026-11-06))
- [read] fal 2.6 edit takes image_urls (max 16), mask_url (white = edit), markup_image_url, image_size (presets/{w,h}/auto), quality auto..max (default high) and reasoning_effort low/medium/high (= OpenAI complexity) (https://api.fal.ai/v1/models?endpoint_id=openai/gpt-image-2.6/sunburst/edit&expand=openapi-3.0)
- [read] fal 2.6 price is by tokens: text $5 input / $1.25 cached / $10 output, image $8 / $2 / $30 per 1M (https://fal.ai/models/openai/gpt-image-2.6/sunburst/edit/llms.txt)
- [read] Replicate has official models openai/gpt-image-2.6-sunburst (version created 2026-11-05T22:26Z) and openai/gpt-image-2.6-flare (2026-11-05T20:46Z) with input_images, aspect_ratio, quality, complexity, background and no mask field (https://replicate.com/openai/gpt-image-2.6-sunburst/api/schema (read 2026-11-06))
- [read] Replicate 2.6 price per output image: low $0.05, medium $0.09, high $0.128, xhigh $0.25, max $0.50, auto $0.25 (billingConfig in https://replicate.com/openai/gpt-image-2.6-sunburst)
- [read] WaveSpeed lists openai/gpt-image-2.6-sunburst/edit, openai/gpt-image-2.6-flare/edit and both /text-to-image; the edit takes images (max 16), mask_image, markup_image, aspect_ratio, resolution 1k/2k/4k, quality low..max (default medium), complexity (default high) (https://wavespeed.ai/models/openai/gpt-image-2.6-sunburst/edit/llms.txt)
- [inferred] WaveSpeed 2.6 price: medium 1k/2k/4k $0.05/$0.10/$0.18 (low .03/.06/.10, high .06/.12/.21, xhigh .11/.21/.38, max .25/.47/.85), plus $0.015 per input image and $0.015 for a mask or markup; the page says base price $0.0585 (90% discount rate) (price formula in the page JSON of https://wavespeed.ai/models/openai/gpt-image-2.6-sunburst/edit)
- [read] OpenRouter lists openai/gpt-image-2.6-sunburst and openai/gpt-image-2.6-flare (created 2026-11-04T23:35Z) on /api/v1/images with aspect_ratio (9 incl. auto), quality auto..max, background, n 1-10, input_references 0-16 and output_format png/jpeg/webp/gif; no mask; moderation and complexity are passthrough parameters (https://openrouter.ai/api/v1/images/models and /api/v1/images/models/openai/gpt-image-2.6-sunburst/endpoints)
- [read] ToAPIs documents gpt-image-2.6-sunburst-official and gpt-image-2.6-flare-official (official channel only) with mask_url (PNG alpha, size of the first image), markup_url, image_urls up to 16, complexity, quality auto..max and n 1-4 (https://docs.toapis.com/docs/en/api-reference/images/gpt-image-2.6-official/generation.md)
- [read] In ToAPIs' pricing list Sunburst official is billed at 80% of the official price (via APIMart upstream), and Flare official is marked 'Pending pricing approval; disabled.' (https://toapis.com/api/pricing (read 2026-11-06))
- [read] Comfy Cloud's live OpenAIGPTImageNodeV2 (display name 'OpenAI GPT Image 2.5') offers only gpt-image-2.5-flare, gpt-image-2.5-sunburst, gpt-image-2 and gpt-image-1.5 (Comfy Cloud MCP get_node with refresh, catalog 2026-11-06T02:54:38Z)
- [read] ComfyUI PR #17558 adds gpt-image-2.6-flare and -sunburst to OpenAIGPTImageNodeV2 with an extra complexity combo (low/medium/high, default high); merged 2026-11-06T01:46:26Z; the backport release v0.44.1 PR #17568 that includes it is open (https://github.com/Comfy-Org/ComfyUI/pull/17558 and /pull/17568 (gh, read 2026-11-06))
- [read] Comfy Router does not list GPT Image 2.6: its model list names only 2, 2.5 Flare/Sunburst and 1.5, and router-schemas/openai/gpt-image-2.6-*.json return 404 (https://docs.comfy.org/development/comfy-router/models.md, https://docs.comfy.org/llms.txt (read 2026-11-06))
- [read] Oxen.ai's public model list (230 models, newest created 2026-11-05T23:14Z) has gpt-image-2-5-flare / -sunburst but no 2.6 (https://hub.oxen.ai/api/ai/models (read 2026-11-06))
- [read] Magnific's OpenAPI spec (Last-Modified 2026-11-05 14:10 GMT) has gpt-image-2 and gpt-image-2-5 paths only; the 2.5 variant enum is flare|sunburst (https://storage.googleapis.com/fc-freepik-pro-rev1-eu-api-specs/magnific-api-v1-openapi.yaml)
- [read] Azure's 'models sold directly by Azure' page names gpt-image-2, 2.5-flare and 2.5-sunburst but no 2.6 (https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure (read 2026-11-06))
- [read] openai.js sizeRules tests /gpt-image-2\.5/ then /gpt-image-2/, so a 2.6 id would get GPT Image 2's rules (max 2048, no ratio cap, no pixel floor); comfyrouter.js reuses openai._sizeFor and _common (F:/canvas/electron/main/providers/openai.js:33-37, F:/canvas/electron/main/providers/comfyrouter.js:342-343)
- [read] openai.js common() whitelists quality, background, output_format, output_compression, moderation and input_fidelity, so a complexity setting would be dropped (F:/canvas/electron/main/providers/openai.js common() (~lines 54-80))
- [inferred] comfycloud.js SHAPES.OpenAIGPTImageNodeV2 sets model.size, model.background and model.quality but not model.complexity, which the 2.6 options add (F:/canvas/electron/main/providers/comfycloud.js:68-76 and the diff of PR #17558)
- [read] WaveSpeed's GPT Image 2.5 Sunburst edit now lists mask_image, while Scumble's 2.5 WaveSpeed note says 'no mask input' (https://wavespeed.ai/models/openai/gpt-image-2.5-sunburst/edit/llms.txt vs F:/canvas/recipes/gpt_image_2_5_sunburst.json (wavespeed note))
- [read] fal (since 2026-09-11) and Replicate host GPT Image 2.5 Flare/Sunburst, but Scumble's 2.5 recipes have no fal or replicate variant (https://api.fal.ai/v1/models?q=gpt-image, https://replicate.com/openai/gpt-image-2.5-sunburst (HTTP 200), F:/canvas/recipes/gpt_image_2_5_*.json)

## Open questions

- Does OpenAI direct accept a mask edit with gpt-image-2.6-*? The spec's mask field is generic and the guide's mask examples use 2.5; only a live run settles it (fal, WaveSpeed and ToAPIs do pass a mask to 2.6).
- Does OpenAI direct take quality xhigh/max for 2.6? The spec's quality text still names only 2.5; OpenRouter's OpenAI endpoint lists them.
- When does Comfy Cloud deploy PR #17558 (backport v0.44.1 still open)? Is model.complexity a required sub-field in the API-format prompt?
- When will Comfy Router, Oxen.ai, Magnific and ToAPIs' Flare (marked disabled pending pricing approval) list 2.6? Are the ids the expected openai/gpt-image-2.6-*, gpt-image-2-6-*, and a variant/path on Magnific?
- Which default complexity should Scumble use for edits: OpenAI recommends low for most edits, while every host defaults to high (the user's call)?
- Should the stale 2.5 bits be fixed alongside (WaveSpeed 2.5 mask_image, missing fal and Replicate 2.5 variants, ToAPIs 'official' now via APIMart)?
