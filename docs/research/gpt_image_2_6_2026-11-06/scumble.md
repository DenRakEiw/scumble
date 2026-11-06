# scumble

## Summary

Scumble can add a GPT Image 2.6 Flare / Sunburst pair as two recipe files, copied from `recipes/gpt_image_2_5_flare.json` and `_sunburst.json`. The two 2.5 files differ only in id, name, description, the per-host model ids and Magnific's `fixed.variant`. The new pair also needs one code fix, an optional new parameter, and edits to about a dozen tests that pin recipe sets.

**The one fix that must ship (inferred, not run):** `electron/main/providers/openai.js:35-37` `sizeRules` tests `/gpt-image-2\.5/`. `gpt-image-2.6-flare` fails that test and gets GPT Image 2's rules instead: 2048 px per edge at most, no 3:1 limit. A 3840x2160 crop would then go out as `size` 2048x1152, on OpenAI direct and on Comfy Router, which calls `openai._sizeFor` at `comfyrouter.js:343`. OpenAI's image guide (read 2026-11-06) gives the same size rules as for 2.5, but its scope is unclear, so this is an inference.

**Optional:** 2.6 has a new `complexity` parameter (low / medium / high, default high). `openai.js` `common()` (54-81) and OpenRouter's fixed `PARAMS` list (`openrouter.js:72`) would have to pass it on. SVG and GIF output must not be offered: raster layers only, and `common()` already turns unknown formats into PNG.

**No code change needed:** wavespeed, toapis and oxen take everything from the recipe. The list order and grouping follow `family` "OpenAI" and the name (`shell.js:439-466`). The prompt templates, the "via" label, `list_recipes` and the transparency switch are generic.

**Tests are the bulk of the work:** exact recipe-set lists in the openrouter, comfyrouter, oxen, toapis and magnific tests (JS and Python). In `recipes_test.js`: the `refs.name` WANT table, the TEXT_REFS table and the hard count `withRefs === 111`. Also the refs_layout test's UNDOCUMENTED table, the dates in the Oxen note test (2026-09-26 or 2026-10-03 only), and the saved host schemas under `tools/refs/`.

**Hosts checked today:** Comfy Cloud's partner node lists no 2.6 model. Comfy Router's 2.6 schemas answer 404. OpenAI's own model pages for both ids exist.

## Report

## 1. How 2.5 got in, and the template to copy

- `recipes/gpt_image_2_5_flare.json` and `_sunburst.json` were created in the first model line-up, `b798ad9` (2026-09-09, "Model recipes with a provider select, ... current model line-up"; `git log --diff-filter=A`). Each host's variant came later, one commit per host: `f33d25c` (WaveSpeed, Comfy Cloud), `8a94b43` (transparency), `6ff9666` / `ec7b032` (ToAPIs), `1656e46` (OpenRouter), `d216040` (Comfy Router), `7425173` (Magnific, Oxen), `eb07202` / `270bd7b` / `82c1809` (refs, text refs), `ad19457` (WaveSpeed text route).
- **The closest template for "one new model on many hosts at once" is Nano Banana 2.1:**
  - `1696909` (N1, the home API) touched CHANGELOG, CLAUDE.md, README, the plan, RECIPES.md, the adapter, the recipe, a new `tools/nanobanana21_test.js` and `tools/recipes_test.js`.
  - `72f29cf` (N2, the other hosts) touched CHANGELOG, CLAUDE.md, BUGS, RECIPES.md, `comfyrouter.js`, the recipe, and the comfyrouter, openrouter, recipes, refs_layout and toapis tests. It also saved the Router schema.
  - Both from `git show --stat`, read.
- **What differs between the two 2.5 files** (`diff`, read): only `id`, `name`, `description`, every host's model id, and Magnific's `fixed.variant` ("flare" / "sunburst").
- **Branch:** the provider recipe files and the 2.5-related tests are the same on `main`, `wasm-kernels` and `corridorkey` (`git diff --stat`, read). `corridorkey` changed only local recipes and `recipes.js` (LoRAs). The checklist therefore applies on any branch; which branch it goes on is the user's call (§7).

## 2. The recipe file, variant by variant (2.5 Flare, the source to copy)

Top level (`gpt_image_2_5_flare.json:1-8, 733-738`):
- `id`, `kind: "provider"`, `name`.
- `family: "OpenAI"`: this puts it in the OpenAI group, sorted by name (`renderer/shell.js:439-466`).
- `refs: { name: "Image {n}" }`.
- `description`, which must contain "Also on WaveSpeedAI. ... Also on Comfy Cloud. Also on ToAPIs. Also on OpenRouter. ... Also on Comfy Router. Also on Oxen.ai. Also on Magnific.". The tests check these sentences.
- `default: "openai"`.
- `limits {max 2048, step 16, pixels 8294400}`.
- Key order (the test-enforced order): toapis, openai, wavespeed, comfycloud, openrouter, comfyrouter, oxen, magnific.

| Variant | 2.5 Flare fields (lines) | How it differs from `gpt_image_2.json` |
|---|---|---|
| toapis (10-145) | model `gpt-image-2.5-flare-official`; input **edit** (no mask). options: size "pixels" with pixels {step 16, max 3840, minPixels 655360, maxPixels 8294400, maxRatio 3}, `transparent_only`. Channels: official / vip (`-vip`) / standard (plain id, size preset, 10 ratios, tiers 1K/2K/4K, tier_sizes for 5 ratios, drop quality). Rows: Channel, Quality (low..max), Background (auto/transparent). limits {2048, 16, 4194304, 655360}; text.sizes [1024, 2048, 3840] | GPT 2: input fill + `mask: true`, size "ratio", 13 tier_sizes, max_images 16 (standard 6), Resolution row |
| openai (146-264) | model `gpt-image-2.5-flare`, fill, max_images 16. Rows: Quality auto..max(1), Size(2), Background(5), File format(6), Compression(7), Moderation(8). limits {3840, 16, 8294400, 655360}; text.sizes [1024 ... 3840] | GPT 2: quality up to high, no limits/text sizes |
| wavespeed (265-329) | `openai/gpt-image-2.5-flare/edit`, edit; 15 aspect_ratios; Quality low..max, Resolution 1k/2k/4k; text.model `.../text-to-image`, text.refs.model `.../edit` | GPT 2: 10 ratios |
| comfycloud (330-357) | model `gpt-image-2.5-flare`, fill, node `OpenAIGPTImageNodeV2`, mask true; row `model.quality` low..max; no text | same shape |
| openrouter (358-428) | `openai/gpt-image-2.5-flare`, fill; accepts [aspect_ratio, quality, background, n]; 8 ratios; Quality, Background; limits {2048, 16, 0, 0}; text.sizes [1536]; note says "run against the live API since 2026-09-21" | GPT 2: no background, its note says "the adapter has run ... with GPT Image 2.5, this model not yet" |
| comfyrouter (429-547) | `openai/gpt-image-2.5-flare`, fill, max 16, the openai rows; limits 3840 / 8294400 / 655360; text.sizes up to 3840 | GPT 2: text.sizes to 2048 |
| oxen (548-665) | `gpt-image-2-5-flare`, fill; accepts +background, moderation; `mask: "alpha"`, `keep_auto [moderation]`, edit_aspect auto, 9 ratios, tiers; Moderation low/auto | GPT 2: `mask: "white"` |
| magnific (666-732) | `text-to-image/gpt-image-2-5-edit`, edit, `fixed.variant "flare"`; Quality, Background, Moderation; text.model `text-to-image/gpt-image-2-5`, refs `-edit` | GPT 2: Resolution row, `limits.aspects` |

GPT Image 2 also has `fal` and `replicate` variants (`gpt_image_2.json:299-366`); 2.5 has none. If fal or Replicate list 2.6, those two blocks are the template.

## 3. Adapter code a 2.6 pair touches

1. **Must change:** `electron/main/providers/openai.js:35-37`. `sizeRules` checks `/gpt-image-2\.5/` first; "gpt-image-2.6-flare" misses it and matches `/gpt-image-2/`, which gives `{max: 2048, minPixels: 0, maxRatio: 0}`.
   - What goes wrong: `fitPixels` (`util.js:68-96`) sends a 3840x2160 crop as `size: "2048x1152"`, so the answer comes back at about half size and the stitch scales it up. A 4000x500 crop goes out steeper than 3:1, which OpenAI refuses if 2.6 keeps 2.5's rules.
   - Comfy Router has the same problem: `comfyrouter.js:342-343` calls `openai._common` and `openai._sizeFor`.
   - Fix: `/gpt-image-2\.[56]/` (or `2\.\d+`), the comment at 29-33, and the header at 10-11.
   - OpenAI's image guide (read 2026-11-06): multiples of 16, ratio 1:3 to 3:1, no edge over 3840, 655,360 to 8,294,400 px. The guide's scope over 2.5 and 2.6 is unclear, so "same rules" is inferred.
2. **Optional, the new `complexity` parameter** (2.6 only per the guide: `low|medium|high`, default `high`, separate from quality):
   - Add a Settings row to the openai variant (free slots 3 / 4; the openai rows use 1, 2, 5, 6, 7, 8) and possibly the comfyrouter variant.
   - `openai.js` `common()` (54-81) forwards only quality, background, output_format, output_compression, moderation and input_fidelity. It would need `if (/gpt-image-2\.6/.test(model) && p.complexity) out.complexity = ...`.
   - OpenRouter: `openrouter.js:72` `PARAMS` is a fixed list, and `bodyFor` (393-396) drops any key outside it even when `accepts` names it.
   - Comfy Router: `comfyrouter_test.js` `validate` counts unknown fields as problems, so the saved Router schema must list `complexity`.
3. **Leave out:**
   - SVG and GIF output (the guide: `svg` only on generations with n=1, `gif` with `frame_count`). Scumble layers are raster, the `MIME` table at `openai.js:26` has png / jpeg / webp, and `common()` maps unknown formats to png (62-63). Do not add them to the File format row.
   - `markup` edits (2.5 and 2.6; cannot be combined with `mask`) and `prompt_rewriter`: leave for later.
4. **Magnific:** `magnific.js:102-105` `ROUTES` is an allowlist by route id, and the header table is at line 20.
   - If Magnific serves 2.6 under new routes, add `text-to-image/gpt-image-2-6(-edit)` rows (dialect gpt, `auto`?, `refs`, accepts with `variant`).
   - If it serves 2.6 on the 2.5 route with a wider `variant` enum, only the recipe's `fixed.variant` and the saved schema change. The saved 2.5 schema has `variant` enum ["flare", "sunburst"] (`tools/refs/magnific/text-to-image_gpt-image-2-5-edit.json`, read).
5. **Comfy Cloud:** `comfycloud.js:71` `/gpt-image-2/` already covers 2.6: custom size in [480, 3840] by 16, at least 655,360 px, at most 3:1. But the live node `OpenAIGPTImageNodeV2` (display name "OpenAI GPT Image 2.5") lists only `gpt-image-2.5-flare`, `-2.5-sunburst`, `gpt-image-2`, `gpt-image-1.5` (Comfy Cloud MCP `get_node`, catalog refreshed 2026-11-06T02:50Z, read). No comfycloud variant until the node lists 2.6; a run now would fail Comfy's validation.
6. **Recipe-driven, no code change:**
   - `wavespeed.js` (generic `EDIT_ROUTE`, line 51).
   - `toapis.js` (channels and `size: "pixels"` come from the recipe).
   - `oxen.js` (accepts, `mask: "alpha"`).
   - `recipes.js` `editLimits` (310-328) and `textModelOf` (387-391).
   - `renderer/shell.js` sort and group (`FAMILY_ORDER` 439; "GPT Image 2.6 ..." sorts after "2.5 Sunburst").
   - `prompts/transparent-asset.md:5` `for: gpt image, openai`.
   - `host.js` `viaLine` (236-241), `supportsTransparency` (by the Background row, 1754-1764), `list_recipes` (`renderer/commands.js:853`, generic).
7. **Comment-only updates:** `recipes.js:297`, `util.js:66`, `toapis.js:26`, `oxen.js:28-29`, `magnific.js:20`.

## 4. Tests that pin 2.5 and must take 2.6 (exact sets fail otherwise)

Plain Node:
- `tools/recipes_test.js`
  - :211, the `refs.name` WANT table: add `gpt_image_2_6_flare/_sunburst: "Image {n}"`. Without it a variant expects "image {n}" and fails.
  - :259-260, the TEXT_REFS table: one row per variant with a text shape, e.g. `wavespeed: { model: "openai/gpt-image-2.6-flare/edit" }`, `magnific: { model: "<-edit route>" }`, `{}` for the others.
  - :304, the hard `withRefs === 111`: add one per new text.refs entry, 14 if both recipes carry 2.5's seven hosts.
- `tools/openrouter_test.js`
  - :672, the exact `want` list and the "sixteen" in the check name.
  - :704, the `ranLive` array and its regexes: a not-yet-run 2.6 note must contain "the adapter has run against the live API with GPT Image 2.5, this model not yet".
  - It also checks: openrouter last before comfyrouter / oxen / magnific, toapis first, "Also on OpenRouter.", text.model equal to model, every row in `accepts`.
- `tools/comfyrouter_test.js`
  - :299-307, `VARIANTS` (recipe id to Router model id) and the "nineteen" at :668.
  - :680-683, the note's opening ("not run against the live API yet.") and "passes them to".
  - Bodies are checked against `tools/refs/comfyrouter/openai_gpt-image-2.6-*.json`, read by `schemaOf` (:90-93). It throws if the file is missing. `https://docs.comfy.org/router-schemas/openai/gpt-image-2.6-flare.json` and `-sunburst.json` answer **404** (curl, 2026-11-06); `-2.5-flare.json` answers 200.
- `tools/oxen_test.js`
  - :562, `WANT` and "twenty_one".
  - :567, the `OPEN` regex allows only the dates `2026-09-26|2026-10-03`. A note written today with 2026-11-06 fails unless the regex is widened.
  - :576, the privacy sentence `PRIV`.
  - :277-279, `tools/refs/oxen/<model>.json` is read for every variant (accepts against the schema's properties).
- `tools/toapis_test.js`
  - :429-430, the `want` list and "twelve"; :432, the `homes` map (`openai`).
  - :437, the note must contain `files.toapis.com` and "not run against the live API"; "Also on ToAPIs.".
  - :160-175 holds 2.5-only body checks; adding 2.6 there is optional.
- `tools/magnific_test.js`
  - :676, `VARIANTS` and :678 "eight".
  - :718, `withTextRefs`.
  - :721 (2.5's background row).
  - `schema(x, route)` reads `tools/refs/magnific/`.
- `tools/refs_layout_test.js` :519-532, `UNDOCUMENTED`. Each ToAPIs channel with no `max_images` needs an entry (`gpt_image_2_6_*/toapis:official|vip|standard`); :1543 flags "no max, and not on the undocumented list", and :1377 flags stale entries.
- `tools/wavespeed_text_test.js` :35-37 holds automatically if the text route is `<id>/text-to-image`.

Python gates (they need an app; exact lists, run them at release or now with `--offline`):
- `tools/comfyrouter_test.py:52` `RECIPES` (compared exactly at :109).
- `tools/oxen_test.py:45` `RECIPES` (:106 exact).
- `tools/magnific_test.py:48, 51` `VARIANTS` / `TEXT`.
- `tools/toapis_test.py:38` `HOMES`.
- `tools/transparent_test.py:31-51` (`_sizeFor` cases; add `gpt-image-2.6-flare`, which is the regression test for §3.1) and :183-200 (`REAL_RECIPES` loops).

## 5. Docs that list 2.5 (anchors)

- `README.md:214-215`, the model list ("GPT Image 2.5 Flare / Sunburst and GPT Image 2"). :195 is the "ran live" list: change it only after a live run.
- `docs/MANUAL.md` names no versions (:58 "OpenAI's GPT Image"): no change.
- `docs/RECIPES.md`, rows to add or extend:
  - :602 `limits` (§576).
  - :746-747, :771 picture caps / ToAPIs undocumented (§627).
  - :886-887 transparency, "On OpenRouter only the two GPT Image 2.5 variants" (§857).
  - :977 the Generate new hosts table (§897).
  - :1540, :1548 the ToAPIs table (§1481).
  - :1648 "15 recipes" and :1883, :1905 (§1645 OpenRouter).
  - :2481 Comfy Router (§2445).
  - :2701, :2750 Magnific (§2679).
  - :2892, :2946 Oxen (§2870).
- `CHANGELOG.md` "## Unreleased" of the target branch. Model entries: 1805-1822 (the 0.1.7 entries for 2.5).
- `CLAUDE.md`: a new item on "the list", the "Unverified" line, the hand-over.

## 6. What to run (CLAUDE.md Light tier: providers built from docs)

1. Plain Node:
   ```
   node tools/recipes_test.js
   node tools/refs_layout_test.js
   node tools/openrouter_test.js
   node tools/comfyrouter_test.js
   node tools/toapis_test.js
   node tools/oxen_test.js
   node tools/magnific_test.js
   node tools/wavespeed_text_test.js
   ```
   Also `node tools/comfycloud_v2_test.js` if the cloud shape changes.
2. `npx eslint .` and `npx tsc --noEmit -p tsconfig.check.json` (gates `lint`, `types`).
3. App gates, `--offline`, one instance on 9555:
   ```
   bash tools/run_gates.sh gpt26 --offline --tiles on recipes transparent size toapis openrouter comfyrouter oxen magnific
   ```
   Only the gates of the hosts that got a variant are needed; otherwise the release's exe gates cover them.
4. One look in the app at *Settings › Recipes* (the OpenAI group).
5. No mutation round, no 15k measurement, no paid run.

## 7. What the web said today (only where the checklist depends on it)

- OpenAI's announcement page answered 403 to WebFetch.
- The developer model pages exist (read 2026-11-06):
  - `gpt-image-2.6-flare` and `gpt-image-2.6-sunburst`, one snapshot each, on `v1/images/generations` and `v1/images/edits`.
  - $5 / $8 / $30 per 1M tokens for text in / image in / image out.
  - Features: "complexity setting, markup-guided edits, SVG output, and animated GIF output".
  - Sources: [gpt-image-2.6-flare](https://developers.openai.com/api/docs/models/gpt-image-2.6-flare.md), [gpt-image-2.6-sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst.md), [image generation guide](https://developers.openai.com/api/docs/guides/image-generation.md). The guide's code samples still use `gpt-image-2.5-sunburst`.
- Older third-party pages (WaveSpeed blog, 2026-11-01; EvoLink, 2026-10-29) still said 2.6 had no API id. OpenAI's model pages above replace them:
  - [WaveSpeed: GPT Image 2.6, what is confirmed](https://wavespeed.ai/blog/ai-news/gpt-image-2-6-what-we-know/)
  - [EvoLink](https://evolink.ai/fr/gpt-image-2-6)
  - [DataLearner](https://www.datalearner.com/ai-models/pretrained-models/gpt-image-2-6)
  - [OpenAI GPT-Image-2](https://developers.openai.com/api/docs/models/gpt-image-2.md)
  - [getimg.ai](https://getimg.ai/developers/ai-image-generator-api)
  - [Product Builder](https://productbuilder.net/models/gpt-image-2)
  - [framia](https://framia.converge.ai/page/id-ID/news/gpt-image-2-api-panduan-developer)
- Which other hosts list 2.6 is the other agents' part. From my side: Comfy Cloud no (live node catalog), Comfy Router no published schema (404).

Scratch: C:/Users/SCHOEN~1/AppData/Local/Temp/claude/F--canvas/543d44fb-4d2d-4818-8804-974916d10a44/scratchpad/gpt26_scumble (the live Router 2.5 schema; it now also lists `stream` and `partial_images`, which the saved copy lacks).

## Facts

- [read] The two 2.5 recipe files differ only in id, name, description, every host's model id and Magnific's fixed.variant (flare/sunburst) (diff recipes/gpt_image_2_5_flare.json recipes/gpt_image_2_5_sunburst.json)
- [read] Both 2.5 recipes were created in b798ad9 (2026-09-09, the first model line-up); each host's variant was added in later per-host commits (git log --diff-filter=A and git log -- recipes/gpt_image_2_5_flare.json)
- [read] The Nano Banana 2.1 commits 1696909 (N1) and 72f29cf (N2) are the template for one new model on many hosts: recipe, adapter, CHANGELOG, CLAUDE.md, README, RECIPES.md, the per-host tests and the saved Router schema (git show --stat 1696909 72f29cf)
- [read] openai.js sizeRules tests /gpt-image-2\.5/ and then /gpt-image-2/; a 'gpt-image-2.6-*' id gets GPT Image 2's rules (max 2048, minPixels 0, maxRatio 0) (electron/main/providers/openai.js:35-37)
- [inferred] With those rules a 3840x2160 crop would be sent as size 2048x1152 on OpenAI direct and on Comfy Router (util.js:68-96 fitPixels; comfyrouter.js:342-343 uses openai._sizeFor and openai._common)
- [read] openai.js common() forwards only quality, background, output_format, output_compression, moderation and input_fidelity, so 2.6's 'complexity' would not be sent (electron/main/providers/openai.js:54-81)
- [read] OpenRouter sends only keys in its fixed PARAMS list (resolution, aspect_ratio, quality, background, output_format, output_compression), even when accepts names others (electron/main/providers/openrouter.js:72, 393-396)
- [read] Magnific's ROUTES table is an allowlist by route id; GPT 2.5 has text-to-image/gpt-image-2-5(-edit) with a 'variant' key whose saved enum is [flare, sunburst] (electron/main/providers/magnific.js:102-105; tools/refs/magnific/text-to-image_gpt-image-2-5-edit.json)
- [read] Comfy Cloud's OpenAIGPTImageNodeV2 lists only gpt-image-2.5-flare, gpt-image-2.5-sunburst, gpt-image-2, gpt-image-1.5 (no 2.6) (Comfy Cloud MCP get_node, live catalog refreshed 2026-11-06T02:50Z)
- [read] comfycloud.js's /gpt-image-2/ branch would already cover a 2.6 model id (custom size 480-3840 by 16, at least 655,360 px, at most 3:1) (electron/main/providers/comfycloud.js:68-79)
- [read] Comfy Router publishes no schema for openai/gpt-image-2.6-flare or -sunburst (404); the 2.5-flare schema answers 200 (curl https://docs.comfy.org/router-schemas/openai/<model>.json, 2026-11-06)
- [read] OpenAI's API ids are gpt-image-2.6-flare and gpt-image-2.6-sunburst, each with one snapshot, on v1/images/generations and v1/images/edits, priced $5/$8/$30 per 1M tokens (text in / image in / image out) (https://developers.openai.com/api/docs/models/gpt-image-2.6-flare.md and -sunburst.md, read 2026-11-06)
- [read] 2.6 adds 'complexity' (low/medium/high, default high), SVG output (generations only, n=1) and GIF output; markup edits apply to 2.5 and 2.6 and cannot be combined with mask (https://developers.openai.com/api/docs/guides/image-generation.md, read 2026-11-06)
- [inferred] 2.6 keeps 2.5's size rules (multiples of 16, at most 3840 per edge, 655,360-8,294,400 px, 1:3 to 3:1) (image-generation guide size section (model scope unclear on the page))
- [read] Recipe order and grouping come from family and name alone (FAMILY_ORDER includes OpenAI; names sorted with localeCompare), so a 'GPT Image 2.6 ...' name sorts after 2.5 Sunburst (renderer/shell.js:439-466)
- [read] recipes_test.js hard-codes withRefs === 111 and holds per-recipe refs.name (WANT) and text.refs (TEXT_REFS) tables (tools/recipes_test.js:211, 259-260, 304)
- [read] oxen_test.js allows only the dates 2026-09-26 or 2026-10-03 in each Oxen note's opening sentence (tools/oxen_test.js:567)
- [read] Exact recipe-set lists sit in openrouter_test.js:672, comfyrouter_test.js:299-307/668, oxen_test.js:562, toapis_test.js:429, magnific_test.js:676/718, and the Python gates comfyrouter_test.py:52, oxen_test.py:45, magnific_test.py:48/51, toapis_test.py:38 (the named files and lines)
- [read] refs_layout_test.js requires an UNDOCUMENTED entry for every edit variant without a max (the 2.5 ToAPIs channels have six) (tools/refs_layout_test.js:519-532, 1543)
- [read] The provider recipe files and the 2.5 tests are identical on main, wasm-kernels and corridorkey (git diff --stat main corridorkey / main wasm-kernels)
- [read] The latest release is 0.1.51 (2026-10-24) (gh release list --repo DenRakEiw/scumble)

## Open questions

- Which branch and release: main as a short 0.1.52 on its own, the corridorkey branch (already planned as 0.1.52, with LoRAs now on it), or wasm-kernels (one release at the end)? The user decides.
- Which hosts list 2.6 today, with their exact ids: ToAPIs (official / vip / standard?), WaveSpeed (openai/gpt-image-2.6-*/edit and /text-to-image?), OpenRouter (openai/gpt-image-2.6-*?), Oxen (gpt-image-2-6-*?), Magnific (new routes or a wider variant enum?), fal, Replicate? This is the other agents' part; each needs its schema or page saved under tools/refs/ for the tests.
- Does 2.6 keep 2.5's size rules exactly? The guide's size section does not name its models. If not, openai.js sizeRules needs its own 2.6 entry rather than the shared regex.
- Should Scumble expose 2.6's new 'complexity' (low/medium/high, default high) as a Settings row? That means openai.js common(), maybe openrouter.js PARAMS, and the hosts' schemas.
- Does gpt-image-2.6 take a mask on /v1/images/edits as 2.5 does (input 'fill')? The guide only says the general mask rules apply; the model pages say nothing about masks.
- Comfy Cloud and Comfy Router have no 2.6 yet (node catalog and router-schemas 404 on 2026-11-06): ship without those variants and add them later, or wait?
