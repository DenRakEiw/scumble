# LR5's probe: where Comfy Cloud lists the LoRA files a key may name (2026-11-06)

Item 50, `docs/PLAN_LORAS.md` §3.5 and the LR5 row. Read-only: GETs only, no job, no upload, no import. The user's
Comfy key was typed by the user into a dev instance (port 9571, its own profile, `--no-comfy`); every request was made
inside that instance's main process by a temporary probe module (loaded through an environment variable, removed before
the commit), so the key never left it, and the written answers were scrubbed of it (0 occurrences). Recorded here:
status, shape, counts and model file names; no key, no auth header, no names of the account's uploads or outputs.
Times are one read each, from this machine.

## What each route answered

| Route (cloud.comfy.org) | Auth | Status | Answer |
|---|---|---|---|
| `GET /api/v2/assets` | X-API-Key | 401 | `unauthorized`: "Send 'Authorization: Bearer <your comfyui- key>'" (v2 takes the bearer only) |
| `GET /api/v2/assets` | Bearer | **405** | `Method Not Allowed`: the v2 contract (the SDK's `types.gen.d.ts`) has `POST /api/v2/assets` (upload), `/from-hash`, `HEAD /by-hash/{hash}`, `GET /{id}`, `/{id}/content`; **no list** |
| `GET /api/v2/assets?limit=5` | Bearer | 405 | the same |
| `GET /api/object_info` | X-API-Key | 200 | 11.0 MB, **3,871 classes**; `LoraLoaderModelOnly.input.required.lora_name` in the older form `[[names], {}]`, **652 names**, folders "" and `Wan22_FunReward`; `LoraLoader`'s combo the same 652; `strength_model` `FLOAT` −100 .. 100 step 0.01; output `["MODEL"]`; no `moss_*` name (§3.5 said so) |
| `GET /api/object_info/LoraLoaderModelOnly` | X-API-Key | 404 | Comfy Cloud has no single-node read (a local ComfyUI has one; host.refreshLoraNames' route does not exist there) |
| `GET /api/assets?include_tags=models&include_tags=loras&...` | X-API-Key | 400 | `BAD_REQUEST`: "parameter 'include_tags' is not exploded, but is specified multiple times" |
| `GET /api/assets?include_tags=loras&limit=5` | X-API-Key | 200 | `{ assets, total, has_more, next_cursor }`, **total 777**, tags `models,loras` (include_public's default true) |
| `GET /api/assets?include_tags=models,loras&limit=500&offset=0` / `offset=500` | X-API-Key | 200 / 200 | 500 + 277 = **777 LoRA assets**, 1.8 s and 1.5 s; every one `is_immutable: true` (Comfy's catalog) |
| `GET /api/assets?include_tags=models,loras&include_public=false&limit=500` | X-API-Key | 200 | **total 0**: the account has no imported LoRA |
| `GET /api/assets?include_tags=models&include_public=false&limit=500` | X-API-Key | 200 | total 0: no imported model of any kind |
| `GET /api/assets?include_public=false&limit=1` | X-API-Key | 200 | total 2,707, tags `output`: the account's own pictures (names not recorded) |
| `GET /api/assets?include_tags=models,lora&limit=1` | X-API-Key | 200 | total 0 (the folder tag is `loras`) |
| `GET /api/assets/tags/refine?include_tags=models` | X-API-Key | 200 | `tag_counts` over 100 tags: `models` 2,348, `diffusion_models` 409, **`loras` 777**, `text_encoders` 91, `checkpoints` 75, `vae` 53 |
| `GET /api/assets/tags/refine?include_tags=models&include_public=false` | X-API-Key | 200 | `{ "tag_counts": {} }` |
| `GET /api/experiment/models` | X-API-Key | 200 | 136 folders (`loras`, `animatediff_motion_lora` among them) |
| `GET /api/experiment/models/loras` | X-API-Key | 200 | 652 `{ name, pathIndex }`: exactly the node list's combo |

An asset's fields (a catalog LoRA): `id`, `name` (`p_q_image_2.1_6_steps_v0.2_comfyui_bf16.safetensors`),
`display_name`, `file_path` (`models/loras/<name>`), **`loader_path`** (the value a loader's `lora_name` takes; equal to
`name` on all 777), `hash`, `size`, `tags` (`models`, `loras`), `mime_type`, `is_immutable`, `metadata`, `user_metadata`
(`filename`, `model_type` `loras`, `name`, `source` `huggingface`, `source_url`), `created_at`, `updated_at`.

The asset list against the combo: all 652 combo names are among the 777 assets; **125 assets are not in the combo**,
among them `moss_image_edit_lora_rank_64_bf16.safetensors`, `moss_image_color_depth_control.safetensors`,
`moss_image_sft_lora_blocks_21_to_49_rank_512_bf16.safetensors`, `p-h3-image_lora_bf16.safetensors`,
`Qwen2.1_Anime_consistency.safetensors`, `Qwen2.1_Anything2RealCharacters.safetensors`, `QI2.1_AnyAngle.safetensors`,
`qwen-image-2.1-fix-1.0-comfy.safetensors`, the `ltx-2.5-*` IC LoRAs and one `wan22-14b-t2v-vintage_film_grain.zip`
(no loader file). Examples of the combo: `qwen-80s_fantasy_movie.safetensors`, `Qwen-Edit-2509-Multiple-angles.safetensors`,
`Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors`, `krea2_*` styles, `Flux2TurboComfyv2.safetensors`.

## What the docs say (read 2026-11-06)

- `https://docs.comfy.org/openapi-cloud.yaml`: **`GET /api/assets` "List user assets (paginated, filterable)"**:
  `include_tags` / `exclude_tags` (arrays, form style, `explode: false`: the comma form), `name_contains`,
  `metadata_filter`, `limit` 1-500 (default 20), `offset`, `sort`, `order`, **`include_public` (default true: "Whether
  to include public/shared assets in results")**; `POST /api/assets/download` starts an import from Hugging Face or
  Civitai; `GET /api/experiment/models/{folder}` lists a folder.
- `https://docs.comfy.org/cloud/import-models`: imports from Civitai and Hugging Face for a Creator subscription or
  higher, through the Models library's Import; "My Models" in its filter shows the user's own imports; imported models
  are private to the user; no upload from the computer.
- The SDK's generated v2 contract (`node_modules/@comfyorg/sdk/dist/low/generated/types.gen.d.ts`, 0.5.0): the v2
  asset routes are upload, from-hash, by-hash and read by id; no list (the 405 above agrees).

## The decision (§0: found -> the account's LoRAs in the picker; not found -> a typed name with the note)

**Found**: the documented account route `GET /api/assets` (the v1 API, X-API-Key, not v2) lists the LoRA files a key may
name, the account's own with `include_public=false` and Comfy's catalog with it (a superset of the node list's combo:
the `moss_*` and Qwen Image 2.1 LoRAs the combo lacks are there). So a Comfy Cloud recipe's picker lists **"Your
imports"** (the account's own, `include_public=false`) first and **Comfy's catalog** after it (the public LoRA assets,
then any combo name the assets lack), each by its `loader_path`.

**Not confirmed:** that an imported LoRA shows under `include_public=false`. The account has none (0 models of any kind),
and an import (Creator plan or higher, a Civitai or Hugging Face link, `POST /api/assets/download`) is the user's call;
none was made. So the picker also takes **a typed file name, sent as written** (the not-found branch's way in, kept
beside the list): an import the list does not show, or shows only later, still goes, and a wrong name ends with Comfy's
own message and the failure's note (`missingNote`). Nothing is refused on a name on Comfy Cloud.

## Also checked

- **`require(esm)` from inside an asar:** a CommonJS file in an archive packed with `@electron/asar` (`app.asar` holding
  `electron/main/providers/x.js` and `renderer/editor/loras.js`, the app's layout) under Electron 44.2.0's Node
  (`ELECTRON_RUN_AS_NODE=1`) requires `renderer/editor/loras.js` and splices through it: 28 exports, the chain right,
  `__filename` inside the asar. The packaged exe itself was not built here; the release's exe gates run it there.
