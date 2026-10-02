# FLUX 3 in Scumble (prepared 2026-10-01, before the launch at 17:00 CEST)

## Status: built against the released API (2026-10-01)

Black Forest Labs released **FLUX 3 Image** on 2026-10-01 (release notes) with public docs (docs.bfl.ai/flux_3,
`https://api.bfl.ai/openapi.json`). The adapter was rebuilt against them the same day: one endpoint, no tiers,
`POST https://api.bfl.ai/v1/flux-3-image` with `{ prompt, images, aspect_ratio, resolution, safety_tolerance,
grounding }` under a strict schema (no `mode`, `seed`, `width` / `height`, `reference_images`, negative prompt or
`output_format`). The recipe is "FLUX 3 Image" (`refs.name` `image {n}`, Safety tolerance 0 to 4, a Grounding row on
by default, `text.sizes` 1024 / 2048 / 4096 for the 1k / 2k / 4k tiers, `limits` 2048 in 16s with `min` 608 and the
15 aspect presets). The released shape is described in `docs/RECIPES.md` "FLUX 3 Image" and in the header of
`electron/main/providers/flux3.js`; §2, §4, §5 and §7 below are the pre-release preparation and stay as its record
(the old body with `mode`, `reference_images`, pixel sizes and a seed would answer 422 now).

**Ran live on 2026-10-01 (22:20, the 0.1.36 exe, the user's key typed into the gate profile `rel36-exe`).** The node
pack's key was refused first ("Not authenticated" on `api.bfl.ai` and `api.isr.bfl.ai`: a review key). Through the
app, driven over CDP: an edit (a 640 × 560 selection on a 2048 × 1536 picture, widened to a 920 × 920 crop, one
reference layer) went as `1:1` / `2k` with `fit: stretch`, came back after 80 s for 10 credits, and stitched without a
seam; `@img1` went out as "image 2". Generate new with one reference at 4:3 / 1024 went as `4:3` / `1k`, came back
after 109 s (99 s of it the model's own `duration`) at 1184 × 880 for 4.8 credits; `@img1` went out as "image 1". No
422: the strict schema took both bodies. The expanded prompt (`result.prompt`, kept in `info`) shows FLUX 3 planning
the edit itself as JSON rows with `src_bbox` / `tgt_bbox`. The test's reference was the wrong picture (a paper
interior instead of the moth meant), so whether the model takes a subject from a reference was not judged; the user
will see that in their own runs. Runs take one to two minutes. The request shapes are also pinned by plain-Node tests
against a scripted fetch (`tools/flux3_test.js`, with the recipe in `recipes_test` and `refs_layout_test`).

**Boxes (2026-10-01 night):** BFL documents bounding boxes as JSON rows appended to the prompt (`bbox` for a layout;
`from` / `src_bbox` / `tgt_bbox` for an edit; `[top, left, bottom, right]` on a 0 to 1000 grid). The research and a
plan for the selection as a box and a box plugin for FLUX 3 and Ideogram 4 are in `docs/PLAN_BOXES.md`.

## 1. Sources

Read only, nothing copied but the shapes: the user's own ComfyUI node pack `custom_nodes/Flux_3_API` (branch `dev`:
`flux3_client.py`, `nodes.py`, `README.md`, `diag_headers.py`, `diag_hosts.py`, `skills/Flux3Director*.md`) and
`custom_nodes/FLux_3_Prompt` (the same skills and an OpenRouter prompter). The `.env` there was not read; its
variable names, from `.env.example`: `BFL_API_KEY`, `BFL_BASE_URL`, `BFL_IMAGE_BASE_URL`, `BFL_IMAGE_PUBLIC_URL`,
`BFL_API_KEY_REVIEW`, `OPENROUTER_API_KEY`. Scumble keeps its BFL key in the OS store as before (the existing
"Black Forest Labs" key row); no new key row is needed.

## 2. What FLUX 3 looks like (pre-release)

**Released before today, documented:** video only. `POST https://api.bfl.ai/v1/flux-3-video` (modes t2v, i2v, v2v,
draft_enhance; a strict schema, `additionalProperties: false` per branch) and `POST /v1/flux-tools/video-upscale-v1`.
Not for Scumble.

**Image (pre-release, the node's `Flux3Image`, two routes):**

- *public*: `POST https://api.bfl.ai/v1/flux-3-image`. On 2026-09-12 it was reachable but answered 403 to the
  user's keys ("needs a release / beta key"), with a reduced schema (t2i / i2i, **no `reference_images` yet**).
- *internal*: `POST /v1/flux-3-image-internal` on a BFL review deployment (host in the node's `flux3_client.py`,
  gated by a separate key; not for Scumble, never put that host in the app). Full schema below. Polled through
  `get_result_debug`, which is internal too.

**Auth:** header `x-key: <key>`, `accept: application/json`. 403 "Not authenticated" = the key is missing or has no
access to that route; an empty body `{}` answers 422 when the key and route are accepted (the node's `diag_hosts.py`
uses this as a free probe, no job is created).

**Task protocol (the same as FLUX.2):** submit answers `{ id, polling_url }` (the video route also `cost` in credits,
`input_mp`, `output_mp`); `GET polling_url` with the key until `status` is `Ready`, then `result.sample` is a signed
URL (expires about an hour after Ready; fetched **without** the key). Terminal failures: `Error`, `Task not found`,
`Request Moderated`, `Content Moderated`, with `details`. A failed task's poll can answer **HTTP 422 with a status
body** (`{ "status": "Error", "details": {...} }`), not a transport error; a 4xx without `status` is a validation
answer (FastAPI `{ "detail": [...] }`). Queues can be long on video (15+ min); image times are unknown. Retry only
GETs: a repeated POST submits (and bills) twice.

**Image body (internal full schema; the public one is a subset):**

| Field | Values | Notes |
|---|---|---|
| `prompt` | string, required | |
| `mode` | `t2i` \| `i2i` | i2i needs pictures |
| `reference_images` | base64 list, 1 to 10 | i2i only; the node sends PNG base64 without a data: prefix. "2+ are upsampled as mi2i; 1 = image-to-image" |
| `aspect_ratio` | `auto`, 21:9, 2:1, 16:9, 3:2, 7:5, 4:3, 5:4, 1:1, 4:5, 3:4, 5:7, 2:3, 9:16, 1:2, 9:21 | `auto`: closest to the first picture on i2i, else 1:1 |
| `resolution` | `768` (internal only), `1k` (default), `2k` | a bucket; overridden by width x height |
| `width`, `height` | 256 to 4096, multiples of 16, both or neither | |
| `seed` | 0 to 4294967295 | the node leaves it out at 0 (random) |
| `steps`, `guidance`, `alpha` | registry defaults 50, 4.0, 6.93 (timestep shift) | research knobs, probably not public |
| `safety_tolerance` | 0 to 5 | (video: 0 to 4, at most 2 with input media; FLUX.2: 0 to 6) |
| `negative_prompt` | string | sent only when not empty |
| `version` | `latest` | |
| `system_prompt_override` and stage switches | internal | the server runs its **own prompt upsampling** by default (and moderation, C2PA marking); an override replaces its system prompt |

No mask, no inpaint mode: FLUX 3 image is text-to-image and instruction editing with reference pictures, like
FLUX.2. No `output_format` in the schema; with a strict schema an extra field is refused (422), so the body must carry
only the fields the endpoint names.

**Clearly pre-release and likely to change:** the path (`flux-3-image` vs. something else, possibly several tiers),
whether `reference_images` exists on the public route and its name, whether `mode` stays, `negative_prompt`, the
`768` bucket, steps / guidance / alpha, `version`, every internal host, `get_result_debug`, and the stage switches.
The node's host list (a global host plus regional and two internal cluster domains; BFL's status page of 2026-08-25
advised the global or a regional endpoint) says the polling host can differ from the submit host.

## 3. FLUX.2 in Scumble, and the difference

`electron/main/providers/bfl.js`: `POST https://api.bfl.ai/v1/<recipe model>` with `x-key`; FLUX.2 bodies are
`{ prompt, output_format: "png", seed, input_image, input_image_2 .. input_image_8, width, height, safety_tolerance }`
(klein 4 pictures, pro / flex / max 8), FLUX.1 Fill `{ image, mask, ... }`; the poll follows `polling_url` until
`Ready` and downloads `result.sample`. `recipes/flux2_*.json` hold one `bfl` variant each (model = endpoint path,
`input: "edit"`, a Safety tolerance row, `text.refs: {}`, `limits.max` 1440) plus the aggregator variants.
`providers/index.js` registers `bfl` once (key row "Black Forest Labs"); `recipes.js` gives every variant its text
shape (`bfl` is in `TEXT_PROVIDERS`) and limits; `settings.js` only remembers the chosen provider per recipe.

FLUX 3 keeps the auth, the submit and the poll; it differs in the body: one picture list instead of numbered fields,
`mode`, up to 10 pictures, 4096 px edges, safety 0 to 5, no `output_format`, a strict schema. So it lives in bfl.js
(one key row, one poll loop) with its body in a helper of its own.

**Second path:** none of the aggregators in the app has a FLUX 3 id today, and none can be guessed. The likely ones,
by FLUX.2's history: **fal** (FLUX.2 was there on day one; a variant is a model id plus `/edit`), **Comfy Router**
(`api.comfy.org` proxies BFL endpoints as `bfl/<endpoint>`; its `bfl` dialect in `comfyrouter.js` builds FLUX.2
bodies today and would call `flux3.body()` for a FLUX 3 id), Replicate, WaveSpeed, OpenRouter. Add each as a variant
of `recipes/flux3.json` once its id is published (and its row in `tools/recipes_test.js` §4).

## 4. What was built (uncommitted)

- `electron/main/providers/flux3.js` (new, a helper like `refs.js`, not a provider): `isFlux3`, `body`, `layout`,
  `textLayout`, the constants. The body: `prompt`; `mode` (`i2i` with pictures, `t2i` without); the pictures as
  `reference_images` (an edit: the crop first, then the Original and the reference layers; Generate new: the
  reference layers alone); `width` x `height` from the crop (multiples of 16, 256 to 4096); then only the optional
  fields the variant's `options.accepts` names (`seed`, `safety_tolerance` by default; `negative_prompt`, `steps`,
  `guidance`, `aspect_ratio`, `resolution`, `prompt_upsampling`, `version` when listed). Never `output_format`, never
  a mask. A run past `max_images` is refused before anything is sent (index.js refuses it first through the layout).
- `electron/main/providers/bfl.js`: a FLUX 3 request (the variant's `options.schema: "flux3"`, or an endpoint named
  `flux-3...`) takes `flux3.body` / `layout` / `textLayout` and the host `FLUX3_BASE`; FLUX.2 and FLUX.1 Fill are
  byte for byte as before. The poll, for both: a `polling_url` is followed only when it is https on a `bfl.ai` host
  (the key goes with every poll), else `get_result` on the submit host; a poll answer with a status body on a 4xx
  (422 `Error`) ends the run with its details; 429 / 5xx without one are retried up to five times (the job is paid).
- `recipes/flux3.json`: "FLUX 3", family Black Forest Labs, one `bfl` variant: `model: "flux-3-image"`,
  `input: "edit"`, `options: { schema: "flux3", accepts: ["mode", "seed", "safety_tolerance"], max_images: 10 }`,
  Safety tolerance 0 to 5 (default 2), `text: { sizes: [1024, 1536, 2048], refs: {} }`, `limits: { max: 2048, step:
  16 }`, `refs.name: "reference image {n}"` (an `@img1` goes out as "reference image 2" on an edit, the crop being
  picture 1).
- `tools/flux3_test.js` (plain Node, 81 checks; rewritten to the released API on 2026-10-01): the recipe (limits min
  608 and the 15 aspects, text sizes 1024 / 2048 / 4096, refs.name "image {n}", the two rows), the edit and text
  bodies with 0 to 10 pictures (exactly prompt, images, aspect_ratio, resolution, safety_tolerance, grounding; no
  mode, seed, width / height), the preset within 3 % or auto on an edit and always a preset on a text run, the tiers
  by area (never 768sq / 1.5k), the blank-prompt, 256 px, 16 MP and 20 MB refusals before any request and the JPEG
  fallback through ctx.opaque / ctx.toJpeg, info (cost, input_mp, output_mp, aspect, resolution, fit,
  expanded_prompt, duration) and no seed, markers as "image 2" / "image 4", the poll (Pending / Reasoning /
  Generating, foreign / plain-http polling_url, 422 and 503 status bodies, 503 / 429 retries, the moderation
  wording, Task not found, a strict-schema refusal), every body sent against the schema, and FLUX.2 unchanged.
- `tools/recipes_test.js` (§3 flux3 takes the default refs.name, §4 its text.refs row, 98 -> 99) and
  `tools/refs_layout_test.js` (§12: a recipe added after 26f is not compared with the adapters of a608e8d) take the
  new recipe.

Runs on 2026-10-01 (released API): `flux3_test` 81 / 81, `refs_layout_test` 659 / 659 (flux3 edit, cap and text route
swept with the rest), `recipes_test` 51 / 51; `ark, comfyrefs, comfyrouter, magnific, openrouter, oxen, platform,
secret_names, toapis, upscale` green; eslint on the changed files clean, `npm run types` green. No gate ran (the
`recipes` and `generate` gates should run once before the release).

No change was needed in `main.js`, `shell.js`, `renderer/editor/*`, `settings.js` or `index.js`: the recipe is picked
up from `recipes/`, listed in the "Black Forest Labs" family, and uses the existing key row.

## 5. Swap points when the final API is known

1. **The endpoint path / model id: `recipes/flux3.json`, `providers.bfl.model`** (today `"flux-3-image"`). This is
   the one place; no code names the path. Several tiers: one recipe per tier (copy the file, new `id`, `name`,
   `model`), as FLUX.2 has pro / flex / max.
2. **The host: `FLUX3_BASE` in `electron/main/providers/flux3.js`** (today `https://api.bfl.ai`), only if BFL serves
   FLUX 3 elsewhere. A host is never taken from a recipe. If it changes, `tools/refs_layout_test.js` §12's
   `ENDPOINT.bfl` needs the same host.
3. **The schema, all in the recipe's `options`:** `accepts` (the optional fields the endpoint takes; add
   `negative_prompt`, `steps`, `guidance` only where the docs list them; drop `mode` if it is gone), `max_images`
   (pictures per request, the crop included), `images_field` (if the list is not called `reference_images`),
   `sizing: "aspect"` (if the endpoint takes `aspect_ratio` + `resolution` instead of pixels; tiers in
   `FLUX3_TIERS`), and `limits` / `text.sizes` / the Safety row's range from the published limits.
4. Then `node tools/flux3_test.js` (its expectations follow the recipe; a changed default needs its check updated).

## 6. Prompting (what upsampling could use)

The Director skills are written for **video** (sections Overview, Setting, Cast, Action Timeline, Sound, Look; a
`mode:` line; timings). What carries over to images: FLUX 3 reads a prompt as a structured brief, not a wish:
structure beats length, the first sentences weigh most, each subject is described once (a tag like `[CHAR_A]` with
fixed attributes) and referenced after that, explicit statements beat omissions, film vocabulary for framing and
light, a closing Look line (realism, contrast, palette, grain). **Every attached picture must be named in the text by
number and role** ("Reference image 1 defines the face and clothing ..."): an unnamed attachment is ignored or
misapplied. That is why the recipe names pictures "reference image {n}", and it matches Scumble's `@img` rule (each
token becomes its picture's name). A Scumble template `prompts/flux3.md` (`for: flux3`, use both) could ask for the
section structure (Overview / Setting / Subjects / Look) without the video parts; not written, the user's call.
Note the server's **own** prompt upsampling (on by default in the pre-release schema): Scumble's upsampling on top
of it may be redundant or fight it; worth one A/B by eye.

## 7. Open questions for the user

1. The final path and whether there are tiers (and which is the recipe's default).
2. Does the public route take `reference_images` (and up to how many) at launch? Without them FLUX 3 is text to image
   only: set the variant's `edit: false` and `text.refs` to `false`.
3. Is `negative_prompt` public? (Left out of `accepts` until the docs say so.) Steps / guidance?
4. The name for a picture in the prompt: "reference image {n}" (the skill's word) or "image {n}" (FLUX.2's)?
5. Should the crop go first (today) or last among the pictures? `aspect_ratio` `auto` follows the first picture, but
   Scumble sends width x height anyway.
6. Price per image and per megapixel (decides `limits.max` 2048 vs. higher; the API allows 4096 edges).
7. Does Scumble expose the server's prompt upsampling as a switch (if public), and is i2i capped at safety 2 as video
   is with input media?
8. Which aggregator (fal, Comfy Router, ...) to add on day one.

## 8. The live check at release (one cheap run, on the user's word)

1. Read the published docs page of the image endpoint; set the swap points (§5); `node tools/flux3_test.js`.
2. Free probe: `POST {FLUX3_BASE}/v1/<model>` with `{}` and the key: 422 = key and route accepted (no job is created),
   403 = the key has no access. Never print the key.
3. One run in a dev instance on its own profile (`--no-comfy`): select FLUX 3, *Generate new* at 1024 x 1024, no
   references, a fixed seed, Safety 2. Check the log record (`BFL generate ok`, seed, endpoint) and the submit's
   `cost` if it returns one.
4. Only if 3 worked and the user agrees: one edit with one reference layer and an `@img1` in the prompt; check
   `prompt_sent` names it "reference image 2" and the result stitches back.
5. Then the gates `recipes` and `generate` (`--offline`), and the release text.

## 9. At release, in files this preparation did not touch

- `CHANGELOG.md`: a bullet ("FLUX 3 from Black Forest Labs: text to image and edits with up to ten reference
  pictures, on the Black Forest Labs key").
- `docs/MANUAL.md` line 51: "Black Forest Labs' FLUX.2" -> "Black Forest Labs' FLUX.2 and FLUX 3".
- `docs/RECIPES.md`: a FLUX 3 paragraph (the body, `options.schema / accepts / max_images / images_field / sizing`,
  the 2048 limit), the text.refs table row; `docs/TESTING.md`: `tools/flux3_test.js`.
- `CLAUDE.md` "Unverified": FLUX 3 until the live check ran.
- Remove "pre-release" from the recipe's description once it ran live.

## FLUX 3 Image on other providers (researched 2026-10-02, not built)

**The ask (the user, 2026-10-02):** put on the plan that Scumble also supports the other FLUX 3 Image API providers,
with four links: fal (`fal.ai/models/blackforestlabs/flux-3/edit-image`), WaveSpeed
(`wavespeed.ai/models/black-forest-labs/flux-3/image-to-video`), OpenRouter (`openrouter.ai/black-forest-labs/flux-3-image`)
and Oxen.ai (the user's workbench, `oxen.ai/DenRakEiw/ai/workbench/playground?model=flux-3-image`).

**How this was researched:** public pages, `llms.txt` files and machine-readable schemas, all fetched without a key;
no request with a key, no login, nothing generated, no code changed. The WaveSpeed link is a **video** model
(`image-to-video`); WaveSpeed sells FLUX 3 Image as two other routes (below). The Oxen workbench link redirects to the
login and was not opened; Oxen's public model list and model page were read instead. This section replaces the guesses
of §3 "Second path" (fal's edit path is `edit-image`, not `/edit`). Comfy Router and Replicate, also named in §3, were
not looked at in this round.

**Which of Scumble's adapters ran live (README, 2026-10-02):** BFL (FLUX 3 Image) and OpenRouter (GPT Image 2.5).
fal, WaveSpeed and Oxen are written from docs and never ran against the live service.

### At a glance

| | BFL direct (built) | OpenRouter | fal | Oxen.ai | WaveSpeed |
|---|---|---|---|---|---|
| Route | `POST /v1/flux-3-image` | `POST /api/v1/images`, one id | two ids: `edit-image`, `text-to-image` | one id, `/images/edit` (and `/images/generate`) | two ids: `edit`, `text-to-image` |
| Pictures | `images`, base64, 1 to 10 | `input_references`, URL or data URL, 0 to 10 | `image_urls`, URL or data URI, 1 to 10 (edit only) | `input_image`, URL (data URL "not recommended"), up to 10 | `images`, URL or data URI, 1 to 10 (edit only) |
| Per picture | 256 px a side to 16 MP, 20 MB | not stated | 256 px a side to 4 MP | not stated | 256 px a side to 4 MP |
| Aspect | 15 presets + `auto` | 15 presets + `auto` | 14 presets (no `9:21`) + `auto` | 15 presets + `auto` | 14 presets (no `9:21`), no `auto` |
| Size | `resolution` 1k / 2k / 4k (768sq, 1.5k exist) | `resolution` "768" / "1K" / "1.5K" / "2K" / "4K" | `resolution` 512sq / 768sq / 1k / 2k / 4k | `resolution` 768sq / 1k / 2k / 4k | `resolution` 1k / 2k / 4k |
| Safety | `safety_tolerance` 0-4 | passthrough only, range not stated | `safety_tolerance` 0-4 | `safety_tolerance` 0-4 | none |
| Grounding | `grounding`, Scumble's row on | cannot be set | none | `grounding`, default **false** | none |
| Prompt expansion | always (no switch) | not stated | `enable_prompt_expansion`, default false | not stated | `enable_prompt_expansion`, default false |
| Seed | none | none | none | none | none |
| Answer | poll, signed URL; cost, MP, expanded prompt | sync, base64; `usage.cost` | fal queue, URL | sync, base64 or URL | queue + poll, URL |
| 1k / 2k / 4k | 4.8 / 10 credits seen (about $0.048 / $0.10 at $0.01 a credit, not checked) / not seen | $0.048 / $0.10 / $0.607 list, half that now | $0.024 now, $0.048 from Oct 8 / not stated / not stated | $0.0624 / $0.13 / $0.7891 | $0.05 / $0.12 / $0.65 |
| Key row in Scumble | Black Forest Labs | OpenRouter | fal | Oxen.ai | WaveSpeedAI |

All four number the pictures from 1 with the crop first (on an edit), then the Original, then the reference layers,
the same as BFL direct. So the recipe-level `refs.name: "image {n}"` fits every variant as it is: `@img1` goes out as
"image 2" on an edit (or "image 3" with the Original) and as "image 1" on Generate new. No variant needs its own
`refs.name`.

### OpenRouter

| | |
|---|---|
| Endpoints | One model id for edits and new images: `black-forest-labs/flux-3-image` (dated slug `black-forest-labs/flux-3-image-20261001`, listed 2026-10-01). `POST https://openrouter.ai/api/v1/images`, the route `openrouter.js` already uses. An edit is the same id with `input_references`. Public capability lists (no key): `GET /api/v1/images/models` and `GET /api/v1/images/models/black-forest-labs/flux-3-image/endpoints`. One host: Black Forest Labs (`provider_slug` `black-forest-labs`; the model page: OpenRouter "forwards every request to it directly"), `headquarters` null, `datacenters` [], so Scumble's China `provider.ignore` list does not touch it. No BYOK. The chat route lists the model too (`supported_parameters` `["seed"]`) but documents no image options for it: not used. |
| Pictures and references | `input_references`: 0 to 10 entries `{ "type": "image_url", "image_url": { "url": "https://..." \| "data:image/png;base64,..." } }`. Not stated: how the list maps onto BFL's `images` (order, re-encoding), per-picture limits, the body size limit (only "413 request body too large"). |
| Size | `resolution` enum "768" \| "1K" \| "1.5K" \| "2K" \| "4K" ("Concrete pixel dimensions are derived per provider"; the playground's 16:9 at 2K came back 2736 × 1536). `aspect_ratio`: BFL's 15 presets plus "auto"; what an absent `aspect_ratio` does is not stated. `n` 1..1. No width / height / `size`. |
| Seed, safety, grounding | No `seed` (FLUX.2 lists it, FLUX 3 does not). `safety_tolerance` only as passthrough (`allowed_passthrough_parameters: ["safety_tolerance"]`), sent as `provider: { options: { "black-forest-labs": { "safety_tolerance": n } } }`; its range is not stated (BFL: 0 to 4); unrecognised passthrough keys are "silently dropped". Grounding is neither a parameter nor a passthrough key: it cannot be set, and what OpenRouter sends BFL for it is not stated (BFL's default is on). Not listed, so not sent (an unlisted parameter answers 400): `output_format`, `size`, `quality`, `background`, `output_compression`, `stream`. |
| Response | Synchronous: `{ created, data: [{ b64_json, media_type }], usage: { prompt_tokens, completion_tokens, total_tokens, cost } }`; `media_type` "may be omitted". No URL, no seed, no expanded prompt, no megapixels. A failed upstream answers 502 and is not billed; 524 is an edge timeout (threshold not stated). Latency over 3 days: P50 43.8 s, P90 111 s, P99 206 s. Data policy: "Prompt training: No", "30 day retention". |
| Price | Per output image, list / now ("50% off", end not stated): 768 $0.041 / $0.0205, 1K $0.048 / $0.024, 1.5K $0.07 / $0.035, 2K $0.10 / $0.05, 4K $0.607 / $0.3035. No price for input pictures. `usage.cost` gives the charge in USD. |
| Sources | [model page](https://openrouter.ai/black-forest-labs/flux-3-image), [llms.txt](https://openrouter.ai/black-forest-labs/flux-3-image/llms.txt), [images/models](https://openrouter.ai/api/v1/images/models), [endpoints](https://openrouter.ai/api/v1/images/models/black-forest-labs/flux-3-image/endpoints), [providers](https://openrouter.ai/api/v1/providers), [image guide](https://openrouter.ai/docs/guides/overview/multimodal/image-generation.md), [API reference](https://openrouter.ai/docs/api/api-reference/images/generate-an-image.md) |

**What changes in Scumble.** A variant `providers.openrouter` in `recipes/flux3.json` (the last key, the OpenRouter
convention) runs today without code:

```json
"openrouter": { "model": "black-forest-labs/flux-3-image", "input": "edit",
  "options": { "accepts": ["resolution", "aspect_ratio", "n"],
    "ratios": ["21:9","2:1","16:9","3:2","7:5","4:3","5:4","1:1","4:5","3:4","5:7","2:3","9:16","1:2","9:21"],
    "tiers": { "1K": 1024, "2K": 2048, "4K": 4096 }, "max_images": 10 },
  "settings": [], "text": { "sizes": [1024, 2048, 4096], "refs": {} }, "note": "..." }
```

`layout()` puts the crop at `input_references[0]`; the recipe's `limits` (2048 in 16s, min 608, the 15 aspects) hold
for the variant; `openrouter` is in `TEXT_PROVIDERS`. Where it falls short of BFL direct, each fixed by an option in
`electron/main/providers/openrouter.js` (other recipes unchanged; most exist in `oxen.js` already):

1. **The prompt is wrapped.** `promptFor` puts `refs.instruction` around it ("Edit image 1 and keep its size and
   framing. ..."); BFL direct sends it as written. Option `options.prompt: "as_written"`. Until then the variant
   carries no `boxes` (the box rows would land inside the wrapper, not at the end).
2. **An edit sends no `aspect_ratio`** (`aspectFor` only runs for `req.kind === "text"`) and returns no `info.fit`.
   Option `options.edit_aspect: "preset_or_auto"`: the preset within 3 % of the crop with `info.fit: "stretch"`,
   else "auto" (set in code: `bodyFor` drops an "auto" param).
3. **The tier goes by long side** (`tierFor`: a 1344 × 768 crop goes as 2K, BFL direct sends 1k). Option
   `options.tier_unit: "area"` with FLUX 3's 15 % slack. Never "768" or "1.5K".
4. **No safety tolerance.** `bodyFor` builds `provider` with `ignore` / `only` only. Option
   `options.passthrough: { "black-forest-labs": ["safety_tolerance"] }`, the value rounded and clamped 0 to 4; then a
   Safety tolerance row `["INT", { "default": 2, "min": 0, "max": 4 }]`. No Grounding row; the note says grounding is
   BFL's default and cannot be switched off here.
5. **Picture rules.** `picturesFor` checks the count, `max_ratio` and the 18 MB inline total. Add `min_side` 256 /
   `max_pixels` 16,000,000, scaling reference layers through `ctx.resizePng` (as `flux3.js` does for BFL).
6. **Seed.** `run()` reports `req.seed` though none went out: report null when `accepts` lacks "seed".

After 1, the variant gets `"boxes": "flux3"` and the `selection_box` row (`bodyFor` sends only keys in `PARAMS` and
`accepts`, so the row never reaches OpenRouter). Tests: `tools/openrouter_test.js` (the FLUX 3 body is exactly
`model, prompt, input_references, resolution, aspect_ratio, n, provider { ignore, options }`; no `seed`, no
`output_format`), `tools/recipes_test.js` §4 (`flux3: { bfl: {}, openrouter: {} }`). Docs: the OpenRouter section of
`docs/RECIPES.md` (its recipe count), the FLUX 3 section, the recipe description ("Also on OpenRouter.").

### fal

| | |
|---|---|
| Endpoints | Under BFL's own namespace `blackforestlabs/`, not `fal-ai/`; both dated 2026-10-01. Edit: `blackforestlabs/flux-3/edit-image` (image-to-image). New image: `blackforestlabs/flux-3/text-to-image`. Queue `POST https://queue.fal.run/<id>`, then `GET .../requests/{request_id}/status`, `GET .../requests/{request_id}`, `PUT .../requests/{request_id}/cancel`; sync `POST https://fal.run/<id>`. No inpaint, fill or mask endpoint. The same prefix holds FLUX 3 **video** endpoints (`text-to-video`, `image-to-video`, ...): not for Scumble. Auth `Authorization: Key ...`. |
| Pictures and references | Edit: `image_urls` (required), 1 to 10, "Reference image URLs or data URIs, in image 1 through image 10 order. Each must be at least 256 pixels per dimension and at most 4 megapixels. The first controls auto aspect ratio." Whether "4 megapixels" is 4,000,000 or 4,194,304 is not stated. Text-to-image has **no picture field**: a new image with references goes to `edit-image`. |
| Size | `aspect_ratio`: "auto" (default) and 14 presets, **no "9:21"** ("Auto uses the first reference image when editing"; what auto does when image 1 is no preset is not stated). `resolution`: "512sq" \| "768sq" \| "1k" (default) \| "2k" \| "4k", no 1.5k; the sizes of 512sq / 768sq are not stated; "4k can take several minutes". No width / height / `image_size`. |
| Seed, safety, grounding | No `seed`. `safety_tolerance` integer 0 to 4, default 2. No grounding. `enable_prompt_expansion` boolean, default **false** (BFL direct always expands). Also `output_format` "jpeg" (default) \| "png", `sync_mode`, `version` "latest". No `mask`, `negative_prompt`, `num_images`. The schema does not set `additionalProperties: false`; whether unknown fields are refused is not stated. |
| Response | fal's queue (`IN_QUEUE`, `IN_PROGRESS`, `COMPLETED`); result `{ images: [{ url, content_type, file_name, file_size, width, height }] }`. No seed, cost or expanded prompt. CDN files are "available for at least 7 days by default" (`fal.js` downloads at once). |
| Price | "starting at $0.0205 per image. A 1K (1 MP) image costs $0.024", a 50 % launch rate: "The discount ends October 8, after which a 1K (1 MP) image will cost $0.048." Edit: "One flat price per image, whatever the number of references." 2k and 4k: not stated (`fal.ai/pricing` has no FLUX 3 row). |
| Sources | [edit-image](https://fal.ai/models/blackforestlabs/flux-3/edit-image), [text-to-image](https://fal.ai/models/blackforestlabs/flux-3/text-to-image), their `llms.txt`, OpenAPI [edit](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=blackforestlabs/flux-3/edit-image) / [text](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=blackforestlabs/flux-3/text-to-image), catalog `https://api.fal.ai/v1/models?q=flux-3`, [llms-full.txt](https://fal.ai/docs/llms-full.txt) (CDN lifetime) |

**What changes in Scumble.** A variant `providers.fal` plus four changes in `electron/main/providers/fal.js`:

- **The variant:** `"model": "blackforestlabs/flux-3/edit-image"`, `"input": "edit"`; `options`: `max_images` 10,
  `boxes` "flux3", `omit: ["num_images", "seed", "selection_box"]` (`fal.js` always sends `num_images: 1` and the
  seed, and passes every settings row by name, so the app-side `selection_box` row would reach fal), the new `sizing`
  "flux3", `aspect_ratios` the 14. Variant `limits` (they override the recipe's): `pixels` 4000000 (a 2048 × 2048
  crop is 4.19 MP) and `aspects` the 14. `settings`: Safety tolerance INT 0 to 4 default 2, `enable_prompt_expansion`
  BOOLEAN (default: open question 3), `selection_box`; no Grounding row. `text`: `"model":
  "blackforestlabs/flux-3/text-to-image"` named explicitly (`textModelOf` strips only `/(edit|inpaint|fill)$`),
  `sizes` [1024, 2048, 4096], `refs: { "model": "blackforestlabs/flux-3/edit-image", "options": { "aspect_ratios":
  [the 14] } }`, `settings` safety and expansion.
- **a) `textLayout`** tests `/\/edit$/`, which `.../edit-image` does not match: Generate new with references is
  refused today ("This text-to-image endpoint takes no reference images"). Accept `/\/edit(-image)?$/`, or any route
  named by `text.refs.model`.
- **b) Sizing.** With `sizing: "none"` an edit sends no `resolution` (fal's default 1k: a 2048 crop comes back at
  about 1 MP), a text run sends no size at all, and an agent's aspect ("5:3") goes out raw. A `sizing: "flux3"`
  branch: `resolution` the tier by area (FLUX 3's rule, 1k / 2k / 4k); a text run the nearest of the 14 always; an
  edit the preset within 3 % of the crop, else no `aspect_ratio` (auto).
- **c) Picture rules.** References and the Original go as they are; fal refuses one over 4 MP or under 256 px a side.
  Scale them through `ctx.resizePng` to the 4 MP cap. The crop is held by the variant's `limits.pixels`.
- **d) Seed.** `seed: num(out.seed, req.seed)` reports the editor's seed: none when `omit` holds "seed".

Unchanged: `index.js` (`checkPictures`, `resolveNames`, the boxes), the queue code, the stitch (fal returns no
`info.fit`; the stitch's own 1 % check applies unless b sets it), the key row. Tests: the fal layouts in
`tools/refs_layout_test.js` (edit and text route, the 10-picture cap), a body test against the saved OpenAPI schema,
`tools/recipes_test.js` §4 (`fal: { model: "blackforestlabs/flux-3/edit-image", options: { aspect_ratios: [...] } }`).

### Oxen.ai

| | |
|---|---|
| Endpoints | One id, `flux-3-image` (display name "FLUX 3 Image", developer `black_forest_labs`, `released_at` 2026-10-01; its list entry was created 2026-10-02 07:27 UTC). The public model page shows `POST https://hub.oxen.ai/api/ai/images/edit` for every call, even a text-only body; the model list gives `"endpoint": "/images/generate"`, as for every image model. Async: `POST https://hub.oxen.ai/api/ai/queue`, `GET .../queue/{id}` (not used by Scumble). No per-model docs page (`docs.oxen.ai/inference-api/reference/models/flux-3-image.md` answers 404). Auth `Authorization: Bearer ...`. |
| Pictures and references | `input_image`: an array of URI strings, nullable, maxItems 10, "image 1" first. URLs must be publicly downloadable; "Data URIs (data:image/...;base64,...) work as an alternative but aren't recommended for production". Per-picture limits and formats: not stated. The schema's prompt text says "Use @Image1, @Image2, etc."; `x-media-references` names the pattern "image {n}"; whether the API rewrites `@ImageN` itself is not stated. `x-bounding-boxes: { format: "flux", imageField: "input_image", aspectRatioField: "aspect_ratio" }`: Oxen's own UI writes BFL's box rows into the prompt. |
| Size | `aspect_ratio` "auto" (default) and BFL's 15 presets. `resolution` "768sq" \| "1k" (default) \| "2k" \| "4k". No width / height. |
| Seed, safety, grounding | No `seed`. `safety_tolerance` integer 0 to 4, default 2 (`x-hidden` in the workbench, listed as accepted on the model page). `grounding` boolean, default **false** (BFL's own default is true). Generic: `response_format` "url" \| "b64_json", `target_namespace`. Not in the schema: `negative_prompt`, `output_format`, mask, `num_images`. Whether unknown fields are refused: not stated. |
| Response | Synchronous: `{ model, created, images: [{ url } \| { b64_json }] }`; a URL is "a temporary link" (lifetime not stated). No cost, seed or expanded prompt. Oxen saves every result in the user's account. The docs' generic "typically 5-30 seconds" does not fit FLUX 3 (80 s and 109 s on BFL direct); `oxen.js` waits up to Node's 300 s for the answer's headers. |
| Price | Per image (`pricing.cost_per_image_grid.high`): 768sq $0.0533, 1k $0.0624, 2k $0.13, 4k $0.7891, about 1.3 × BFL direct. Whether pictures or grounding change it: not stated. |
| Sources | [model page](https://www.oxen.ai/ai/models/flux-3-image), `https://hub.oxen.ai/api/ai/models/flux-3-image` (no key), [image generation](https://docs.oxen.ai/inference-api/reference/image_generation.md), [image editing](https://docs.oxen.ai/inference-api/reference/image_editing.md), [async queue](https://docs.oxen.ai/inference-api/reference/async_queue.md), [llms-full.txt](https://docs.oxen.ai/llms-full.txt) |

**What changes in Scumble.** A variant `providers.oxen` (after `bfl`) runs edits, new images and new images with
references today:

```json
"oxen": { "model": "flux-3-image", "input": "edit",
  "options": { "accepts": ["aspect_ratio", "resolution", "safety_tolerance", "grounding"], "edit_aspect": "auto",
    "ratios": [the 15], "tiers": { "1k": 1048576, "2k": 4194304, "4k": 16777216 }, "tier_unit": "area",
    "numbers": ["safety_tolerance"], "max_images": 10 },
  "settings": [Safety tolerance INT 0-4 default 2, Grounding BOOLEAN default true],
  "text": { "sizes": [1024, 2048, 4096], "refs": {}, "settings": [the same two] }, "note": "..." }
```

`run()` sends an edit and a new image with references to `/images/edit`, a new image without them to
`/images/generate`; the pictures go as data URLs in `input_image` with the crop at [0]; the tier goes by area; no
seed or negative prompt goes out (not in `accepts`); `response_format: "b64_json"` always. The Grounding row keeps
Scumble's default (on), not Oxen's (open question 5). For parity, in `electron/main/providers/oxen.js`:

1. **Prompt as written.** `promptFor` wraps an edit through `openrouter.promptFor` and a new image with references
   through `instruction`: the same `options.prompt: "as_written"` as OpenRouter, checked in both places. Then
   `"boxes": "flux3"` and the `selection_box` row; `boxes.js` numbers `ref_image_k` from Oxen's layout as it is.
2. **App-side rows.** `bodyFor` skips keys not in `accepts`, so `selection_box` stays home; `tools/oxen_test.js`
   (:280-283) requires every settings key in `accepts` and needs an exemption for app-side rows.
3. **Aspect fit and tier slack (optional, plain "auto" works).** An `edit_aspect` mode "preset_or_auto" plus
   `info.fit`; the 15 % tier slack as an option, or the tiers × 1.15 in the recipe (1205862 / 4823449 / 19293798).
4. **Picture rules.** `picturesFor` has no 256 px minimum or 16 MP maximum; add them (the crop refused, references
   scaled through `ctx.resizePng`). Oxen states no limits, so BFL's are the working assumption.
5. **Seed.** `run()` reports `body.seed ?? req.seed`: null when `accepts` has no seed.
6. **Grounding words.** An agent's "on" / "off" goes out as a string today; coerce it as `flux3.js` does.

Tests: `tools/refs/oxen/flux-3-image.json` (the model entry `{ id, endpoint, pricing, request_schema }`, saved during
this research in the session scratchpad as `oxen/flux-3-image.json`; fetch it again from the public URL when
building), then `tools/oxen_test.js` §3 checks every body against it; `tools/recipes_test.js` §4 (`oxen: {}`).

### WaveSpeed

| | |
|---|---|
| Endpoints | The FLUX 3 collection (`wavespeed.ai/collections/flux-3`) has 12 models, two of them images: `black-forest-labs/flux-3/text-to-image` and `black-forest-labs/flux-3/edit`, each `POST https://api.wavespeed.ai/api/v3/<id>`; result `GET https://api.wavespeed.ai/api/v3/predictions/{id}/result`. The other ten (including the user's link, `image-to-video`) are video. `black-forest-labs/flux-3` alone does not exist. Schemas (OpenAPI 3.0, no key): `https://wavespeed.ai/center/default/api/v1/model_schema/black-forest-labs/flux-3/edit` and `.../text-to-image`. Auth `Authorization: Bearer ...`. Who runs the model behind WaveSpeed is not stated. |
| Pictures and references | Edit: `images` (required), 1 to 10, "URLs or data URIs", order matters ("Refer to input images by their order, such as image 1 or image 2"); each 256 px a side to 4 MP (4.0 or 4.19 MP not stated); a byte cap is not stated. Text-to-image has **no picture field**. |
| Size | `aspect_ratio`: 14 presets, **no "9:21" and no "auto"**; edit: no default (left out, it follows the first picture); text: default "1:1". `resolution` "1k" (default) \| "2k" \| "4k" ("4k can take several minutes"). No width / height / `size`. |
| Seed, safety, grounding | **None of the three** (the playground shows an "Enable Safety Checker" switch that is not in the schema). `enable_prompt_expansion` boolean, default **false**; `output_format` "jpeg" (default) \| "png". No `negative_prompt`, mask, `enable_sync_mode`, `enable_base64_output`. Both input schemas say `"additionalProperties": false`; whether the server enforces it is not stated. |
| Response | Submit answers `{ code, message, data: { id, model, status, urls, outputs: [], created_at } }`; poll about every 2 s (`created`, `processing`, `completed`; `failed`, `cancelled`, `timeout`, `deleted`); `data.outputs` are URLs ("generally expire within 7 days"), `data.timings.inference` in ms. No base64 option for this model, no cost, no expanded prompt. |
| Price | 1k $0.05, 2k $0.12, 4k $0.65 per image, the same on both routes, "based only on the selected resolution" (the page warns that listed prices may be outdated). |
| Sources | [edit](https://wavespeed.ai/models/black-forest-labs/flux-3/edit), [text-to-image](https://wavespeed.ai/models/black-forest-labs/flux-3/text-to-image), their `llms.txt`, [edit API](https://wavespeed.ai/docs/docs-api/black-forest-labs/black-forest-labs-flux-3-edit), [text API](https://wavespeed.ai/docs/docs-api/black-forest-labs/black-forest-labs-flux-3-text-to-image), [collection](https://wavespeed.ai/collections/flux-3), [data retention](https://wavespeed.ai/docs/data-retention-policy) |

**What changes in Scumble.** The adapter's protocol, upload path and `images` list (crop first) fit; a variant alone
is not enough because `electron/main/providers/wavespeed.js` sends fields FLUX 3 does not take:

- **The variant:** `"model": "black-forest-labs/flux-3/edit"`, `"input": "edit"`; `options`: `max_images` 10,
  `aspect_ratios` the 14, `negative` false, a new `accepts` list (`resolution`, `enable_prompt_expansion`,
  `output_format`), `boxes` "flux3" only once the rows are checked live. Variant `limits`: `aspects` the 14, `pixels`
  4000000. `settings`: `enable_prompt_expansion`, `selection_box` (with `boxes`); a Resolution row only if the tier
  code below is not built. `text`: `"model": "black-forest-labs/flux-3/text-to-image"` named explicitly (`textModelOf`
  strips "/edit" to `black-forest-labs/flux-3`, which does not exist), `refs: { "model":
  "black-forest-labs/flux-3/edit" }`, `settings` explicit (otherwise the variant's rows, `selection_box` included,
  are copied).
- **Seed** (`wavespeed.js:69`): `seed` goes out whenever the editor has one (no recipe has a `random_seed` row).
  An `options.accepts` allowlist, or `options.seed: false`; `:169` then reports no seed. The same latent problem
  sits in every WaveSpeed recipe whose schema has no `seed` (nano-banana-2/edit, seedream-v5.0-pro/edit,
  gpt-image-2/edit, all also `additionalProperties: false`): fixing it changes their bodies too, so the step runs
  `tools/refs_layout_test.js` over every WaveSpeed variant.
- **Param pass-through** (`:97-100`) sends every row that is not "" / null / "auto": the `accepts` list keeps
  `selection_box` and anything else out.
- **Picture rules:** 256 px to 4 MP, references scaled through `ctx.resizePng`.
- **Optional:** the tier by area instead of a Resolution row (a row left at "auto" sends nothing and WaveSpeed
  renders 1k); `info.fit: "stretch"` when the crop is within 3 % of the preset; an early refusal of a blank prompt
  (`minLength` 1).

Works as is: the closest of `aspect_ratios` (`:101`), no negative prompt with `negative: false`, `output_format`
"png", `layout` / `textLayout` (`EDIT_ROUTE` matches `.../flux-3/edit`, not `.../text-to-image`). Tests:
`tools/refs_layout_test.js` (WaveSpeed edit and text routes), a body test against the saved schema,
`tools/recipes_test.js` §4 (`wavespeed: { model: "black-forest-labs/flux-3/edit" }`).

### Shared pieces (F0, after item 28 is done with `flux3.js`)

- **FLUX 3's rules, reusable.** Every adapter above needs the tier by area with 15 % slack, the preset-within-3 %
  rule, safety rounded and clamped 0 to 4, grounding words as a boolean, and the picture rules. `flux3.js` exports
  `_tierOf` and `_shapeOf` today, but `_shapeOf` takes a request and BFL's 15 presets, and `FLUX3_PICTURE` is fixed
  at 16 MP; `safetyOf`, `groundingOf`, `rescaleOf` and the picture code are not exported. Export them with their
  limits as parameters (`shapeFor(w, h, kind, presets, { auto })`, `pictureOf(bytes, what, ctx, { minSide,
  maxPixels, maxBase64 })`), so fal and WaveSpeed pass 14 presets and 4 MP, OpenRouter and Oxen 15 and 16 MP. Not
  before the other session is done with `flux3.js` / `bfl.js`; copying small helpers into each adapter is the
  fallback.
- **App-side rows.** `selection_box` is read by the renderer (`host.js` "Selection as box") and reaches the adapter
  in `params` like any row. BFL and OpenRouter send only what they accept; fal and WaveSpeed pass rows by name. One
  place in `providers/index.js` that drops app-side rows before the adapter would replace four `omit` lists
  (coordinate with item 28, which owns the row).
- **`recipes/flux3.json`** is item 28's file too (it added `boxes` and `selection_box` in 1d81f06): add variants
  after that session's commits, one provider per step. `"default"` stays `"bfl"`. The description gains "Also on
  OpenRouter, fal.ai, Oxen.ai and WaveSpeedAI." as each lands.

### Order to build (one step per session, the light test tier: request shapes in plain Node, `lint`, `types`)

1. **F1 OpenRouter.** Best documented (a machine-readable parameter list and price list per endpoint), BFL is its
   only host and gets the request directly, the same 15 presets + "auto" and 10 pictures as BFL direct, and the
   only one of the four adapters that has run live. At list price it equals BFL direct; now half. The recipe-only
   variant first (boxes off), then options 1 to 6 and boxes on.
2. **F2 fal.** The same 1k price as OpenRouter ($0.024 until October 8, then $0.048) and a full OpenAPI schema; but
   4 MP per picture and 14 presets (variant limits of its own), no grounding, the prompt expansion off by default,
   four changes in `fal.js`, and `fal.js` never ran live.
3. **F3 Oxen.** Closest to BFL direct in its fields (grounding, safety, 15 presets + "auto", BFL's box format named in
   its own schema) and almost works recipe-only; but no per-model docs page, a route conflict, data URLs "not
   recommended", results stored in the account, about 1.3 × the price, and `oxen.js` never ran live.
4. **F4 WaveSpeed.** The fewest controls (no safety, grounding, "auto" or 9:21), 4 MP, the highest 2k / 4k prices
   after Oxen, an upstream it does not name, and a seed fix that changes every WaveSpeed recipe; never ran live.

F0 goes before whichever step first needs a rule that is not exported (F1's tier and aspect options can follow
`oxen.js`'s and do not need it).

### Open questions for the user

1. All four, or only some? OpenRouter and fal cost what BFL direct costs (or less while the launch discounts last);
   Oxen and WaveSpeed cost more and offer less. Which keys are stored in the app (the Oxen workbench link suggests an
   Oxen account)?
2. OpenRouter cannot switch grounding off (and does not say what it sends): acceptable, with a note in the variant?
3. fal and WaveSpeed: the prompt expansion row on by default (closer to BFL direct, which always expands) or off
   (the host's default)?
4. fal and WaveSpeed take at most 4 MP per picture. Their variants hold the crop to 4,000,000 px (a 2048 × 2048 crop
   becomes about 2000 × 2000, still the 2k tier, as on BFL direct, whose `max` 2048 keeps edits at 2k too) and scale
   larger reference layers down before sending. Fine until a live run shows whether 4.19 MP passes?
5. Oxen's grounding default: Scumble's (on, like the BFL row) or Oxen's (off)?
6. Selection as box on hosts where the rows were never seen to pass (fal, WaveSpeed, Oxen, OpenRouter): ship the row
   with the variant, or only after its live check?
7. Comfy Router and Replicate (named in §3) were not looked at: research them too?

### Live checks, with the user present (after each step, on the user's word)

The 0.1.36 way: a dev instance on its own profile (`--no-comfy`), the user types the provider's key into Settings,
driven over CDP; 1k only; about two runs per provider (roughly $0.05 to $0.20 each provider at today's prices).

- **Every provider:** one Generate new with one reference and `@img1` (the text route, the picture named "image 1"),
  one edit with one reference (the crop as image 1, `@img1` as "image 2", the aspect and tier sent, the stitch without
  a seam), and the result judged by eye against BFL direct. With boxes on: one edit with Selection as box (the rows
  pass and the change lands in the box).
- **OpenRouter:** the order of `input_references` upstream; what an edit with "auto" returns; the pixel sizes per
  tier; that the `safety_tolerance` passthrough is taken (no 400); `media_type`; `usage.cost` against the discount.
- **fal:** whether "4 megapixels" takes a 2048 × 2048 crop (keep `pixels` 4000000 until then); what "auto" does with a
  crop between presets; the 2k price on the fal dashboard; png comes back.
- **Oxen:** data URLs in `input_image` (never run live on Oxen for any model); `/images/edit` vs `/images/generate`
  for a new image without references; the time of a 2k edit against the 300 s header limit; that `grounding` is
  honoured both ways; the run appears in the user's Oxen account (privacy).
- **WaveSpeed:** whether `additionalProperties: false` is enforced (the body after the seed fix carries nothing
  extra; an older body with `seed` must not be sent deliberately); the 4 MP edge; that the box rows pass; the quality
  next to BFL direct, since the upstream is not named.

When a provider has run live: its line in `docs/RECIPES.md` and the README's "verified" sentence, `CLAUDE.md`
"Unverified", and the CHANGELOG bullet at its release.
