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

**No live run yet.** A live call with the node pack's key was refused with "Not authenticated" on `api.bfl.ai` and
`api.isr.bfl.ai`, so nothing has been generated through FLUX 3 Image from Scumble; the live check (§8) waits for a key
that has access. Until then the request shapes are checked only by plain-Node tests against a scripted fetch
(`tools/flux3_test.js`, with the recipe in `recipes_test` and `refs_layout_test`).

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
