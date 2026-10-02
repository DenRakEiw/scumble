# Ideogram 4.5 in Scumble (researched 2026-10-02)

## Status: I0 + I1 + I2 built (2026-10-02), I3 open

**I2 as built (2026-10-02, one session):** `util.js` now also holds `tierFor` (Comfy Router's and Magnific's copies
gone), `checkRatio` and `withinBytes` (moved from `replicate.js`, the messages unchanged). `wavespeed.js`: a fill's
`fields.references` (unnumbered, `style`), `options.mask: "black"` (`ideogramMask`; no `mask_url` for a whole-crop
selection, `info.mask` says so), `max_ratio` / `max_bytes` before the first upload (the upload now carries the mime,
JPEG for an opaque picture over the cap), no `aspect_ratios` preset on a fill, a text run's `text_values` and
`tiers` (`resolution` by the asked long side), and the **allowlist**: `options.accepts` (a text run:
`options.text_accepts`, else `accepts`) keeps only `prompt`, the picture keys and the listed keys; with a list and
no `seed` in it the answer reports no seed. Variants without these options send what they sent before. Not §4's
shape in three places: `accepts` is split per route (`accepts` `quality`, `edit_precision`; `text_accepts`
`quality`, `aspect_ratio`, `resolution`, `enable_prompt_expansion`), because a new image gets the edit's Settings
rows, so *Edit precision* would reach the text route; `enable_prompt_expansion: false` is `text.fixed`, not a text
Settings row (text rows never reach a run, I1); `max_ratio` 6 and `max_bytes` 25 MB as on Replicate. Docs: RECIPES.md
(the variant-fields paragraph, the adapter paragraph, the caps table, "Ideogram 4.5"), CHANGELOG Unreleased,
`docs/PLAN_FLUX3.md` F4 (the allowlist built, `aspect_ratio` must be listed). Tests: `tools/ideogram45_test.js`
gains the WaveSpeed sections 7-14 (149 checks in all; a background agent wrote them against the stated API, and 8
mutations of `wavespeed.js` on a copy were all caught), `tools/recipes_test.js` takes-none, `tools/refs_layout_test.js`
reads the variant unchanged (663). Next: I3 (Comfy Router), then the README / MANUAL lines.

**I0 + I1 as built (2026-10-02, one session):** `util.js` holds `pngSize`, `seedOf`, `textShape`, `blackEditMask`
(answers `{ png, edits, pixels }`; Magnific's Ideogram Inpaint sends its `png` as before, unchanged) and
`ideogramMask` (null for a selection over the whole crop, a refusal when no pixel is at half strength or more), Magnific
imports them. `replicate.js` reads `options.mask: "black"`, `seed_max`, `negative: false`, `sizes` (a text run's
`size`, no `aspect_ratio`) and **`text_values`** (new, not in §5: a Generate new run's params come from the *edit*
Settings rows, `host.providerParams`, so the edit's `very_low` would reach the text route, which refuses it; the
variant maps it to `low`), and a fill's `fields.references` (unnumbered, `style: true`; the fill now checks its own
`max` before any upload). After the review: `options.max_ratio` 6 and `max_bytes` 25,000,000 (Ideogram's Precise
Edit page: aspects 1:6 .. 6:1, 25 MB a picture; an opaque picture over it goes as JPEG) and the recipe-level
`limits.ratio` 6, which the WaveSpeed and Router variants inherit; the crop info card's wording. The recipe `recipes/ideogram_4_5.json` has the Replicate variant only, without
`text.settings` (they are never sent, see above). The refusal for a named unnumbered reference says "without a number
(as style references or unnumbered references)" in `refs.js`, `index.js` and `host.js`. Docs: `docs/RECIPES.md`
"Ideogram 4.5" (after "FLUX 3 Image"), the variant-fields paragraph, the caps table, the drops list; CHANGELOG
Unreleased. Tests: `tools/recipes_test.js` takes-none, `tools/refs_layout_test.js` (the sweep decodes the inverted
mask for any `ideogram…4.5` route), `tools/magnific_test.js`'s wording, a new request-shape test
`tools/ideogram45_test.js` (the light tier, 67 checks). Next: I2 (WaveSpeed), I3 (Comfy Router), then the README / MANUAL lines.

Researched on 2026-10-02 by three readers (one per host), checked against the code on `main` (1298229 plus the
uncommitted working tree). **Nothing is built:** no recipe, adapter or test file changed; the only new file
besides this plan is the Router's schema `tools/refs/comfyrouter/ideogram_ideogram-4-5.json` (committed with this
plan, 2026-10-02). The user's word (2026-10-02): add Ideogram 4.5 for the next release, together with item 28, **built from
the providers' documentation only, no live test** ("nur über documentation hinzufügen, kein test nötig"). Hosts named
by the user: Replicate, Comfy Router, WaveSpeedAI. Not item 30 (Ideogram 4.0's own API, local recipe, JSON caption).

## 1. Sources (all read 2026-10-02)

- **Replicate:** https://replicate.com/ideogram-ai/ideogram-4-5 (page JSON, `/api/schema`, `/readme`; official model
  on CPU hardware, i.e. a proxy to Ideogram's API; backing version created 2026-09-30 19:12 UTC; 604 runs),
  https://replicate.com/ideogram-ai/ideogram-4-5-precise-edit (`/api/schema`, `/readme`; created 2026-09-30 18:41 UTC),
  https://replicate.com/ideogram-ai (only these two 4.5 models; no tiers, no remix), `/versions` (403, not read),
  https://replicate.com/docs/topics/predictions/input-files (URL, upload up to 100 MB, data URI under 1 MB).
- **Comfy Router:** https://docs.comfy.org/llms.txt (the id), https://docs.comfy.org/router-schemas/ideogram/ideogram-4-5.json
  (no auth; Last-Modified 2026-10-02 04:52 GMT, version e039966eaeb7; saved verbatim as the ref above),
  https://docs.comfy.org/development/comfy-router/models.md, `.../models/ideogram/ideogram-4-5/code.md` (endpoint,
  queue, answer example), `.../pricing.md` (4.5 "Not published"), `.../reference.md` (an input image switches to the
  edit operation, metered on its own rate). `api.comfy.org/v2/models/ideogram/ideogram-4-5[/openapi.json]`: 401.
- **WaveSpeedAI:** https://wavespeed.ai/models/ideogram-ai/ideogram-v4.5/edit and `/ideogram-v4.5` (README, price
  formula, created 2026-10-01 04:09 UTC), the schemas at
  `https://wavespeed.ai/center/default/api/v1/model_schema/ideogram-ai/ideogram-v4.5[/edit]` (OpenAPI,
  `additionalProperties: false`), the `llms.txt` of both, https://wavespeed.ai/docs/docs-api/ideogram-ai/ideogram-ai-ideogram-v4.5-edit
  and `...-ideogram-v4.5`; `/text-to-image`, `/remix`, `/reframe`: 404 (no such routes).
- **Ideogram (context only):** https://ideogram.ai/models/4.5/, https://developer.ideogram.ai/ideogram-api/api-overview.md,
  `.../api-reference/images/precise-edit/ideogram-4-5.md`, `.../images/generate/ideogram-4-5.md`, `.../generate/ideogram-4.md`.
- Two web searches for "Ideogram 4.5" found only 4.0 (too new for the index).

## 2. What Ideogram 4.5 is

Ideogram calls 4.5 "the most precise edit model": less drift (pixel shifts, colour changes, texture) over chained
edits, edits "at any resolution" (a 24.2 MP example), and an edited crop that keeps its edges "so you can stitch it
seamlessly back into the original", which is how Scumble works. Its API has **two operations**:

- **Generate:** text to image with the prompt alone, or with source images (`images`, the first edited, the rest
  references; up to 5, 4 with a mask) and an optional mask. `size` is `auto`, `source` or `WxH` (refused together
  with a mask); `magic_prompt` auto / on / off; `quality` very_low / low / medium / high (very_low only with source
  images); billed 1K up to 1024 x 1024 px and 2K above, `auto` as 2K. The prompt may be natural language or a
  structured Ideogram 4.0 JSON prompt (Ideogram's generate page; no host documents boxes for 4.5).
- **Precise Edit:** one `image`, up to 4 `reference_images` (3 with a mask), optional mask. The answer has the
  image's own size, and pixels the edit does not touch are copied unchanged. Too large an input is scaled down
  (threshold not documented); the aspect must be within 1:6 .. 6:1.
- **The mask:** black = edit, white = keep, the source's size, in-between values rounded, **both colours required**.
  Scumble's mask is the inverse (white = repaint): every variant has to invert it, as `magnific.js` does for
  Ideogram Inpaint, and a selection covering the whole crop inverts to all black, which Ideogram refuses.

Unlike 4.0 (open weights, non-commercial, June 2026; text to image and a mask-less image to image; rendering-speed
tiers; Scumble's `recipes/ideogram_4.json`), 4.5 edits with a mask and has one `quality` axis. **Unknown:** the
release date (first host listing 2026-09-30, Replicate), the licence and whether weights exist (no page says), the
output pixels of each size preset, the Precise Edit scale-down threshold, how a prompt names a reference picture.

## 3. The hosts

### Replicate (Replicate token; per output image)

| Model | Fields | Mask / pictures | Sizes | Price |
|---|---|---|---|---|
| `ideogram-ai/ideogram-4-5` (generate) | `prompt` (req.), `images` uri[] (<= 5), `mask`, `size`, `quality` (default medium), `num_images` 1-8, `seed` (<= 2147483647) | black = edit; mask only with `images`, then `size` ignored and the output is the source size | `source` (default) or 1024x1024, 1280x896, 896x1280, 1344x768, 768x1344, 1536x640, 640x1536 | text: low $0.03, medium $0.06, high $0.10 (no very_low); with images: very_low $0.008, low $0.03, medium $0.06, high $0.22 |
| `ideogram-ai/ideogram-4-5-precise-edit` | `prompt`, `image` (both req.), `mask`, `reference_images` uri[] (<= 4, 3 with a mask), `quality`, `num_images`, `seed` (<= 2147483647) | black = edit, the image's size | none: the output follows `image` | very_low $0.008, low $0.03, medium $0.06, high $0.22 |

Versionless route `POST /v1/models/<id>/predictions`; `output` is a list of replicate.delivery URLs; the seed shows
only in the logs ("Using seed: N"). Not exposed: magic prompt, negative prompt, style, aspect_ratio, output format.
**Unknown:** whether Replicate refuses keys the schema does not name; the real pixels of the size presets (the one
example at `source` returned a 6.0 MB PNG, maybe 2K-class); no pixel or byte cap is stated.

### Comfy Router (Comfy key, Comfy credits; `ideogram/ideogram-4-5`, one id, the body picks the operation)

| Operation | Selected by | Fields | Sizes |
|---|---|---|---|
| text to image | no picture field | `prompt` 1-10,000 chars, `quality` low / medium / high (default high; very_low refused), `size` auto / WxH, `magic_prompt`, `seed` 0-2147483647, `num_images` 1-8, `enable_copyright_detection` | `auto` (2K) or WxH; no list (Ideogram's 4.0 page lists 38 1K / 2K presets; whether 4.5 takes them: unknown) |
| generate with pictures | `images` (1-5, 4 with a mask) | as above plus `mask`; `size` auto / source / WxH, refused with a mask | with a mask: `images[0]`'s size |
| Precise Edit | `image` (with optional `reference_images` 1-4, 3 with a mask) | `prompt`, `image`, `reference_images`, `mask`, `quality` (default medium), `seed`, `num_images`; `size` and `magic_prompt` dropped | `image`'s size |

Pictures are data URIs (`data:image/(png|webp|jpeg);base64`) or Comfy's own signed asset URLs: Scumble sends data URIs
(25 MiB each, 64 MiB per request). Answer `{ data: [{ url, seed, resolution, prompt, is_image_safe }], generation_id,
seed }`. Unknown fields are dropped, not forwarded. **Price: not published** (2026-10-02).

### WaveSpeedAI (WaveSpeed key; both schemas `additionalProperties: false`)

| Route | Fields | Mask / pictures | Sizes | Price |
|---|---|---|---|---|
| `ideogram-ai/ideogram-v4.5/edit` | `image` uri (req.), `prompt` (req.), `reference_images` uri[] (<= 4, 3 with `mask_url`), `mask_url`, `aspect_ratio` (1:1, 4:3, 3:4, 16:9, 9:16; forbidden with a mask or precision high), `edit_precision` regular / high (default regular; "High restores unchanged pixels"), `quality` very_low .. high (default medium) | black = edit, the source's exact size, both colours required; all pictures as URLs (the media upload) | follows the source ("large inputs may be downscaled") | very_low $0.008, low $0.03, medium $0.06, high $0.22 |
| `ideogram-ai/ideogram-v4.5` | `prompt`, `resolution` 1k / 2k (default 1k, same price), `aspect_ratio` (1:1, 4:3, 3:4, 3:2, 2:3, 16:9, 9:16; default 1:1), `quality` low / medium / high, `enable_prompt_expansion` (default true) | none | 1k / 2k (pixels not documented) | low $0.03, medium $0.06, high $0.22 |

No seed, `output_format`, `negative_prompt` or `num_images` on either route. **Unknown:** whether WaveSpeed enforces
`additionalProperties: false` (the same open question as FLUX 3's F4, `docs/PLAN_FLUX3.md` "WaveSpeed"); whether
`edit_precision` high is Ideogram's Precise Edit and regular its generate operation (an inference from the aspect
rule, not documented); how grey mask values are read.

## 4. Decision proposal

**A new recipe `recipes/ideogram_4_5.json`, not variants in `ideogram_4.json`.** Every newer model version in
`recipes/` is a recipe of its own beside the older one: `flux3.json` beside the `flux2_*`, `seedream_5_lite` /
`_5_pro` beside `seedream_4_5`, `gpt_image_2_5_flare` / `_sunburst` beside `gpt_image_2`, `qwen_image_2_1` beside
`qwen_image_edit`. A recipe is "one model with one variant per provider" (`docs/RECIPES.md`); 4.5 is another model
with other fields and another kind of run (a masked edit), and `ideogram_4.json` stays the open-weight 4.0.

- **Generate = Precise Edit with the mask, on all three hosts** (Replicate `ideogram-4-5-precise-edit`, the Router's
  `image` body, WaveSpeed's edit route with Edit precision High): the crop as the picture, the selection as the
  inverted mask, the reference layers as `reference_images`. It answers at the crop's size and copies what the edit
  does not touch, the closest fit to crop-and-stitch; it has no magic prompt to rewrite the instruction. Replicate's
  generate-with-mask (`ideogram-4-5`, `images` + `mask`) costs the same and stays an alternative for a live A/B.
- **A whole-crop selection** (the inverted mask has no white pixel): send no mask, so the whole crop is edited and the
  stitch keeps the selection; the run's info says so. Never send an all-black mask.
- **References unnumbered** (the layout's `style: true`, as Magnific's Ideogram): no host documents how a prompt
  names them, so an `@img` token is refused with the existing message (its wording says "style references"; reword
  to "references, which have no number"). Numbered names later is a layout change after a live check.
- **Generate new = the text route** (Replicate `ideogram-4-5` with a WxH preset, the Router's text body with a WxH
  size, WaveSpeed `ideogram-v4.5` with an aspect preset and the 1k / 2k tier), the prompt alone: on every host a
  picture in the text call would become the picture edited, so `text.refs` stays off (the layouts declare the drop).
- **`default: "replicate"`**: Scumble has no Ideogram adapter (the home provider), Replicate's is the official partner
  listing, documents the most and publishes prices. Order per `docs/RECIPES.md`: replicate, wavespeed, comfyrouter.
- **No `limits`** (the conservative 2048 default) until a live run, **no `options.boxes`**, quality default medium.

```json
{
  "id": "ideogram_4_5", "kind": "provider", "name": "Ideogram 4.5", "family": "Ideogram",
  "description": "Ideogram 4.5, Ideogram's precise edit model: real mask inpainting (the selection goes as the mask, the answer comes back at the crop's size and what the edit does not touch is copied from it), strong at typography. Written from the providers' documentation (2026-10-02); not run against the live API yet. Also on WaveSpeedAI. Also on Comfy Router.",
  "default": "replicate",
  "providers": {
    "replicate": {
      "model": "ideogram-ai/ideogram-4-5-precise-edit", "input": "fill",
      "fields": { "image": "image", "mask": "mask", "references": "reference_images" },
      "options": { "mask": "black", "max_images": 4, "seed_max": 2147483647, "negative": false,
                   "sizes": ["1024x1024", "1280x896", "896x1280", "1344x768", "768x1344", "1536x640", "640x1536"] },
      "fixed": { "num_images": 1 },
      "settings": [{ "index": 1, "key": "quality", "label": "Quality", "spec": [["very_low", "low", "medium", "high"], { "default": "medium" }] }],
      "text": { "model": "ideogram-ai/ideogram-4-5", "sizes": [1024],
                "settings": [{ "index": 1, "key": "quality", "label": "Quality", "spec": [["low", "medium", "high"], { "default": "medium" }] }] },
      "note": "Runs on Replicate with the Replicate token; written from Replicate's schema (2026-10-02), not run against the live API yet. Generate: Ideogram's Precise Edit; the selection goes as the mask (inverted to Ideogram's black = edit), up to three reference layers as unnumbered references; the prompt cannot name them. Generate new: the prompt alone at the closest of seven sizes. Per image: Very low $0.008, Low $0.03, Medium $0.06, High $0.22; a new image $0.03 / $0.06 / $0.10 (Replicate, 2026-10-02)."
    },
    "wavespeed": {
      "model": "ideogram-ai/ideogram-v4.5/edit", "input": "fill",
      "fields": { "image": "image", "mask": "mask_url", "references": "reference_images" },
      "options": { "mask": "black", "max_images": 4, "negative": false, "tiers": { "1k": 1024, "2k": 2048 },
                   "accepts": ["quality", "edit_precision", "aspect_ratio", "resolution", "enable_prompt_expansion"],
                   "aspect_ratios": ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"] },
      "settings": [{ "index": 1, "key": "quality", "label": "Quality", "spec": [["very_low", "low", "medium", "high"], { "default": "medium" }] },
                   { "index": 2, "key": "edit_precision", "label": "Edit precision", "spec": [["regular", "high"], { "default": "high" }] }],
      "text": { "model": "ideogram-ai/ideogram-v4.5", "sizes": [1024, 2048],
                "settings": [{ "index": 1, "key": "quality", "label": "Quality", "spec": [["low", "medium", "high"], { "default": "medium" }] },
                             { "index": 2, "key": "enable_prompt_expansion", "label": "Prompt expansion", "spec": ["BOOLEAN", { "default": false }] }] },
      "note": "Runs on WaveSpeedAI with the WaveSpeed key; written from WaveSpeed's schema (2026-10-02), not run against the live API yet. The selection goes as the mask (inverted to black = edit); Edit precision High restores the pixels outside the change. Up to three reference layers, unnumbered. No seed: two runs differ. Generate new: one of seven aspects at 1k or 2k by the asked size, prompt expansion off so the prompt goes as written. $0.008 / $0.03 / $0.06 / $0.22 per image for Very low / Low / Medium / High; a new image Low / Medium / High (WaveSpeed, 2026-10-02)."
    },
    "comfyrouter": {
      "model": "ideogram/ideogram-4-5", "input": "fill",
      "options": { "max_images": 4, "max_ratio": 6, "resolutions": ["1024x1024", "896x1120", "1120x896", "...the 38 of Ideogram's 4.0 page...", "3072x1280"] },
      "settings": [{ "index": 1, "key": "quality", "label": "Quality", "spec": [["very_low", "low", "medium", "high"], { "default": "medium" }] }],
      "text": { "sizes": [1024, 2048],
                "settings": [{ "index": 1, "key": "quality", "label": "Quality", "spec": [["low", "medium", "high"], { "default": "medium" }] },
                             { "index": 2, "key": "magic_prompt", "label": "Magic Prompt", "spec": [["auto", "on", "off"], { "default": "off" }] }] },
      "note": "Runs on Comfy Router (api.comfy.org) with the Comfy Cloud key, billed in Comfy credits, no paid plan needed; written from the Router's published schema (2026-10-02), not run against the live API yet. Generate sends the crop as Ideogram's Precise Edit picture, the selection as its mask (black = edit) and up to three reference layers, inline. Generate new sends the prompt alone at the closest 1K / 2K size. Quality is also the billed rate; Comfy had not published the price on 2026-10-02."
    }
  }
}
```

The `resolutions` placeholder is the 38-size list in the Router reader's notes (17 1K and 21 2K sizes, Ideogram's 4.0
page); write it out in full when building, or send `auto` if a live run refuses one.

## 5. Adapter changes (lines as of 2026-10-02)

**I0, shared (`electron/main/providers/util.js`).** Move `invertedMask` (`magnific.js:250-268`, it uses that file's
`pngSize` at `:151`; exported as `_invertedMask` at `:767`) to `util.js` as `blackEditMask(mask, image, ctx, who)`,
returning `null` when no pixel is kept; Magnific keeps its behaviour (it refuses, as today). Move `seedOf`
(`magnific.js:205-208`, `(seed >>> 0) % (max + 1)`) beside it. The editor's seed is up to 0xffffffff
(`renderer/editor/inpaint_canvas.js:930`, `randomSeed`), Ideogram's cap 2147483647: sent as it is, about half the runs would be refused.

**I1, Replicate (`electron/main/providers/replicate.js`).**
1. `:52` the seed through `options.seed_max` (`seedOf`); `:161` reports what went.
2. `:79-82` the fill: with `options.mask === "black"` send `blackEditMask` (omit `mask` when it is null); with
   `fields.references` upload the references into that array (only when there are any).
3. `:111` the fill layout with `fields.references`: crop `input.image`, own `input.mask` and
   `input.reference_images[i]`, `style: true`, `max` from `options.max_images`, no drop.
4. `:94` the negative prompt only when `options.negative !== false` (as `wavespeed.js:102`).
5. `:53-56`, `:87-93` a text run with `options.sizes`: `input.size = closestSize(...)` (`util.js:39`; the shape from
   `req.aspect`, else width / height) and no `aspect_ratio`; import it at `:21`. `textLayout` (`:121`) already
   declares the drop for `fields.image` without `fields.images`.

**I2, WaveSpeed (`electron/main/providers/wavespeed.js`).**
1. `:93` the mask through `blackEditMask` under `options.mask: "black"`; null: no `mask_url`.
2. `options.accepts`: an allowlist applied to the finished input (rows `:97-100`, `seed` `:69`, `output_format`
   `:103`, `negative_prompt` `:102`, `aspect_ratio` `:101`); absent, nothing changes for the other variants. **This
   is the piece `docs/PLAN_FLUX3.md` F4 proposes: build it once here, F4 reuses it.** `:169` reports no seed when
   none went.
3. `:101` no `aspect_ratio` on the fill shape (the edit schema forbids it with a mask or precision high;
   `flux1_fill`, the only other WaveSpeed fill, has no `aspect_ratios`).
4. `:91-94` `fields.references` into its own array; `:118` the layout as in I1.3.
5. A text run with `options.tiers`: `resolution` by the asked long side (`tierFor`, `comfyrouter.js:266` /
   `magnific.js:224`; share it in `util.js`).

**I3, Comfy Router (`electron/main/providers/comfyrouter.js`).** The dialect is picked by the id's provider part
(`:654-656`, `:696-698`), so `ideogram/ideogram-4-5` lands in the v4-only `ideogram` dialect (`:486-501`: `edit:
false`, a `{ text_prompt, resolution }` body that 4.5 would answer with a missing `prompt`).
1. Branch on `model === "ideogram-4-5"` inside the dialect, as `bfl` does for `flux-pro-1.0-fill` (`:377`, `:395`).
2. `edit: false` per model: it is read as a dialect flag at `:661`, `:706`, `:716`.
3. The edit body: `{ prompt, image: uri(pics[0]), reference_images (only when any), mask, quality, seed (% 2147483648,
   as byteplus `:411`), num_images: 1 }`, no `size` or `magic_prompt`. The mask needs `ctx.bitmap` (on every ctx,
   `index.js:318`) but `body()` gets no ctx (`:673`): pass ctx as a fifth argument.
4. The layout: crop `image`, own `mask` and `reference_images[k]`, `style: true`, `max: picturesMax(o)` (`:247`).
5. The text body: `{ prompt, size, quality (very_low -> low), magic_prompt when set, seed, num_images: 1 }`, `size`
   the closest aspect among `options.resolutions` of the asked tier (area <= 1024 x 1024 = 1K, else 2K). Keep the
   text drop (`textLayoutOf`).
6. `read()` (`:496-500`) already fits; add `is_image_safe === false` -> `{ refused }`, and `generation_id` to info.
   `picturesFor` holds the 25 / 64 MiB caps and `max_ratio` (`:225-227`).

Not touched: `index.js` (fields and options pass through), `recipes.js` (`options` is `Record<string, any>`, `:97`),
`host.js` (`text.fixed` / `text.settings` already override the edit's, `:1670`, `recipes.js:266-267`).

## 6. Order (one step per session, then the hand-over)

I0 + I1 + the recipe with its Replicate variant; I2 + WaveSpeed; I3 + the Router and the ref file; then the docs
below. The CHANGELOG entry lands with I1 under Unreleased, beside item 28's, for the same release.

## 7. Tests (the user: no live test, "kein test nötig")

No live run and no new test file. Adding a built-in recipe makes the existing plain-Node sweeps fail until their
tables name it, so each step extends them: `tools/recipes_test.js:263` `TAKES_NONE` (`ideogram_4_5: ["replicate",
"wavespeed", "comfyrouter"]`), `tools/comfyrouter_test.js:265` (`ideogram_4_5: "ideogram/ideogram-4-5"`; `:822` still
holds, the text layout drops) and its mock answer (`:137`, `tools/comfyrouter_mock.py:397`), and
`tools/refs_layout_test.js` (its sweep reads every variant's layout and request). Then `lint` and `types`. If a later
session wants request-shape checks (the light tier), they would pin: the inverted mask (black where Scumble's is
white), no mask for a whole-crop selection, the seed under 2^31, `reference_images` only when there are references,
no `size` / `magic_prompt` / `aspect_ratio` / `negative_prompt` / `output_format` on an edit, a text run's WxH from
the lists and its tier, and WaveSpeed's `accepts` leaving the other WaveSpeed variants' bodies unchanged.

## 8. Docs to touch when built

- `docs/RECIPES.md`: the variant-fields paragraph (`:158-176`: Replicate's `options.mask`, `seed_max`, `sizes`,
  `negative`, `fields.references`; WaveSpeed's `accepts`, `mask`, `tiers`); the caps table (`:328-349`: the three
  rows, 4 with the crop, sources above); the Comfy Router section (`:1802`ff: "Sixteen recipes" becomes seventeen, the
  ideogram dialect's 4.5 branch); an "Ideogram 4.5" paragraph like "FLUX 3 Image"; the adapter header comments.
- `CHANGELOG.md` Unreleased: one entry (model, hosts, real mask inpainting, from the docs, not run live, prices).
  `README.md:28-32`: the model list. `docs/MANUAL.md` "Recipes" (`:130`ff): one sentence like FLUX 3's.
- `CLAUDE.md` at the hand-over: a list entry (a new number, or under item 30). `docs/COMMANDS.md`: nothing planned.

## 9. Open questions

1. Precise Edit or generate-with-mask for Generate (same price on Replicate; the docs name no quality difference)?
   The plan picks Precise Edit; a live A/B would settle it.
2. Which `default`: Replicate (proposed), WaveSpeed or Comfy Router (price unpublished)?
3. Defaults: Quality medium ($0.06) or high ($0.22 on an edit); Magic Prompt / prompt expansion off (proposed, the
   prompt goes as written, as Ideogram Inpaint on Magnific) or the hosts' default (auto / on).
4. How 4.5 wants a reference named in the prompt (until known: unnumbered, `@img` refused).
5. Whether Replicate and WaveSpeed refuse keys their schemas lack: the plan sends only keys the schemas name.
6. WaveSpeed: is `edit_precision` high Ideogram's Precise Edit, regular its generate operation? Default high either way.
7. The text sizes: the real pixels of Replicate's presets, whether the Router takes 4.0's 38 sizes for 4.5 (else
   `auto`), WaveSpeed's 1k / 2k pixels.
8. The largest crop each host takes (Ideogram: "any resolution"; Precise Edit scales an oversize input down): 2048.
9. Whether `prompt` carries a 4.0 JSON caption with boxes on any host (item 28 S5 / item 30): not planned here.
10. The licence of 4.5 and whether open weights (and so a local recipe) will exist: not stated anywhere.
11. WaveSpeed's 4.0 route (`ideogram-ai/ideogram-v4`, image to image) for `ideogram_4.json`: not asked; item 30.
