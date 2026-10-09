# Relight: virtual lights on the picture (item 43)

**Status: researched 2026-10-09, not planned in sessions yet, nothing built.** The user's ask (2026-10-09): rebuild the
relight feature Photoshop's beta got on 2026-09-28, as an update after the Nik 9 parity block (`docs/PLAN_NIK9_BUILD.md`
releases 2 and 3, one block; release 4 independent). This file names other products: the rule of 2026-09-29 covers
CLAUDE.md, the posts, the CHANGELOG, the manual and the README, not the plans.

## 1. What the model feature does (Adobe's post of 2026-09-28, build 27.12.0)

- A **Relight layer** (Layer menu, Layers panel flyout) over a pixel or smart-object layer; the original pixels stay.
- Up to **three lights**, dragged anywhere on the canvas, also outside the picture; each with **position, intensity,
  colour, diffusion**, an eye to switch it off, delete. At least one light stays.
- An **Original lighting** slider (0-100 %): the feature first takes the picture's own light away, then lights it with
  its own lights; all lights off leaves the ambient remainder.
- A **low-resolution preview** while dragging; **Done** renders at full input resolution, server-side, 30 generative
  credits (about $0.30) per Done; needs the internet. Supports Actions and scripting.
- Users report: fine detail lost in the final render; the 3D placement of a light in front of / behind an object is
  clumsy; a light inside an object misbehaves; works best on a clear subject (a person, an interior), weak on
  landscapes ("a flashlight, not the sun"); only the active layer is processed, so composites suffer.
- Adobe does not say how it works. Project Light Touch (MAX Sneaks) was described as a virtual light "that accounts
  for depth and occlusion"; whether Relight is that model is not stated. It is generative (credits, server), not a
  shader.

Sources: https://community.adobe.com/announcements-698/relight-is-now-available-in-photoshop-beta-1644153,
https://fstoppers.com/photoshop/photoshop-can-now-move-light-your-photo-904920,
https://creativebloq.com/design/graphic-design/photoshops-newest-ai-tool-is-immediately-dividing-opinion.

## 2. The user's question: does the depth map help, or do we need normals?

Both, for different parts:

- **The depth map (release 1, `ed.maps.depth`) helps with everything about *where* a light is:** a light's distance
  falloff (how bright a pixel is lit depends on its distance to the light, which needs the pixel's depth), the
  light's place in the scene (in front of or behind an object: compare the light's depth with the pixel's), and
  **cast shadows** (a march along the ray from the pixel towards the light through the depth map: if a nearer
  surface blocks it, the pixel is in shadow). None of that needs normals. Depth also gives a **first normal
  estimate**: the gradient of the depth map (`n = normalize(-dz/dx, -dz/dy, 1)`), good for large shapes (a face, a
  body, a wall), noisy on fine detail and biased on relative depth (disparity, not metres).
- **Normals are what shading needs:** how much a surface faces the light (`max(0, n · l)`, Lambert) is the whole
  of "the left side of the face gets brighter". A proper normal model gives this per pixel at full detail. The
  candidate: **MoGe-2 ViT-S normal** (Microsoft, 35 M parameters, code MIT, weights `Ruicheng/moge-2-vits-normal`
  tagged MIT on Hugging Face, ONNX export documented in the repo's `docs/onnx.md`, about 60 ms on a 3090 for the
  ViT-L at fp16): it answers **normals, metric depth and the camera's FOV in one pass**, so it could later serve
  the depth tools too (one model instead of two; to be measured against Depth Anything V2 Small on the user's
  pictures before any switch). Sizes ViT-B 104 M, ViT-L 331 M.
- **The generative routes need neither.** IC-Light and Magnific take a **light map** (a picture: black = no light,
  bright = light; colour and shape of the sources) or a direction word; they infer the geometry themselves. The
  depth map still helps **to draw a better light map** (falloff and occlusion put into it before sending).

So: phase 1 uses the depth map alone (normals from its gradient, smoothed); phase 2 adds the normal model for the
local shading's detail. Neither phase needs normals for the API and ComfyUI routes.

## 3. The routes Scumble can offer

Scumble's pattern: the same feature on the user's ComfyUI, on API providers, and a fast in-app path where one exists.

| Route | What it takes | State | Notes |
|---|---|---|---|
| **In-app, physically based** (no model, instant) | the depth map (and later normals) | to build | shading = ambient + Σ lights (colour × intensity × Lambert × falloff × shadow), applied as a multiply / overlay onto the picture; the *live preview* of every route, and a usable result on its own for subtle work; keeps every pixel's detail |
| **Magnific relight** (API, €0.10 / run) | `POST /v1/ai/image-relight`: `image`, `prompt` or `transfer_light_from_reference_image` or **`transfer_light_from_lightmap`** (black = no light, brighter = light, its colour and shape), `light_transfer_strength` 0-100, `interpolate_from_original`, `change_background` (default true: **set false**), `style` (standard, darker_but_realistic, clean, smooth, brighter, contrasted_n_hdr, just_composition), `preserve_details`, advanced (`engine`, `transfer_light_a`, `transfer_light_b`, whites / blacks / brightness / contrast / saturation, `fixed_generation`); poll `GET .../{task-id}` (CREATED, IN_PROGRESS, COMPLETED, FAILED), `data.generated[]` URLs | adapter exists (`electron/main/providers/magnific.js`, the two upscalers) | **the best fit: the light map Scumble renders from its lights goes in as it is** |
| **fal `bria/fibo-edit/relight`** (API) | `image_url`, `light_direction` ∈ {front, side, bottom, top-down}, `light_type` ∈ {midday, blue hour light, low-angle sunlight, sunrise light, spotlight on subject, overcast light, soft overcast daylight lighting, cloud-filtered lighting, fog-diffused lighting, moonlight lighting, starlight nighttime, soft bokeh lighting, harsh studio lighting} | adapter exists (fal) | coarse: a direction word, no placement; a "presets" row |
| **fal `fal-ai/iclight-v2`** (API) | `image_url`, `prompt`, `initial_latent` ∈ {None, Left, Right, Top, Bottom}, `enable_hr_fix` | adapter exists (fal) | the IC-Light v2 (Flux) model as a hosted service; direction words only; also `fal-ai/lightx/relight` (not read) |
| **Any edit model by prompt** (Flux.2 / FLUX 3 / Nano Banana / Qwen on every host) | "relight with a warm light from the upper left, keep everything else" | exists today | no placement, no map; the fallback that needs no new code |
| **ComfyUI, IC-Light (SD 1.5 `iclight_sd15_fc`)** on the user's ComfyUI | kijai's `ComfyUI-IC-Light` (`LightSource` node: a gradient light map) or huchenlei's `ComfyUI-IC-Light-Native`; a recipe whose light-map input Scumble fills with **its own light map** | to build as a recipe | local and free; SD 1.5 quality (soft detail, 1024 px class); IC-Light v2 Flux has **no public local node pack** (2026-10-09; only fal's service) |
| Video / other | NVIDIA DiffusionRenderer (video, G-buffers, scripts only), LTX-2.3 Relight IC-LoRA (video), NVIDIA Maxine relighting NIM (faces, server) | not for pictures in the app | listed for completeness |

## 4. The shape in Scumble

- **A Relight dialog or pane over the active document**, like Upscale: lights listed with colour, intensity,
  diffusion (size / softness), an eye, delete; **drag the lights on the canvas** (a tool like the boxes tool X, a
  light is a handle with its colour; outside the picture allowed); an **Original light** slider; a **Shadows** switch
  (depth march); a route selector (In-app / ComfyUI recipe / API provider, like the Upscale dialog's list); *Apply*.
- **The preview is the in-app shading**, on the screen pass only, like the mask views of R1-S10 (never in an export
  until applied); the generative routes show the same preview while dragging and send on *Apply*.
- **The result is a new layer** over the picture, like the Realism Pass (a refiner, never a Generate result): the
  in-app route as a filter-like result layer the user can mask and fade; the generative routes as a pixel layer;
  one undo step; the lights kept in the document (`ed.maps`-style record, or a layer `params` block) so *Edit
  relight* reopens them.
- **The light map** Scumble renders for the API / ComfyUI routes: per light a radial falloff of its colour and
  intensity, diffusion as its radius, the depth map's distance falloff and occlusion folded in, ambient as the floor;
  the same map drawn as the preview's light term.
- **MCP:** `relight` (lights as a list `{x, y, z?, color, intensity, diffusion}`, `original`, `route`), `list_lights`
  / `set_light` if the lights live on the document; the assistant's policy rows (AUTO for the in-app route, ASK for a
  paid route, like `upscale`).
- **Settings:** the route's default, the Magnific style and `preserve_details`, the IC-Light recipe's model.

## 5. Open questions for the user (before the sessions)

- R-D1: Which routes first? Suggested: in-app + Magnific (the light map fits) + the ComfyUI IC-Light recipe; fal's
  two as presets later.
- R-D2: Does the in-app route ship as a result layer (pixels) or as a live filter layer (a `relight` filter with the
  lights in its params, re-rendered like any filter, maskable, undoable per change)? The filter is the better
  object (it follows the Nik release's filter limits and mask views), the pixel layer the simpler build.
- R-D3: The normal model (MoGe-2) in phase 2, or straight away? Suggested: phase 2, after the depth-gradient
  normals have been seen on the user's pictures.
- R-D4: Shadows in phase 1? A depth march is cheap in a shader (the WebGL path exists); the quality on relative depth
  is the unknown; suggested: build it behind a switch, judge by eye.
- R-D5: Lights in the document format: a `relight` map or layer params → a reader bump (F1's `FEATURES`).

## 6. Sessions (inferred, not measured)

Phase 1 (about 6-8 sessions):
- L1: the light model and the light map renderer (pure module, Node tests): lights → light map at a given size,
  with the depth map's falloff and occlusion, ambient floor; normals from the depth gradient (smoothed at the
  guide's radius).
- L2: the shader: ambient + lights × Lambert × falloff (× shadow march behind a switch), GL and CPU twins, on the
  filter infrastructure (F6 / F7 of the Nik plan: pass context, scratch unit); the in-app result as a filter
  (R-D2) or a baked layer.
- L3: the dialog / pane and the canvas tool (drag the lights, colour, intensity, diffusion, eye, delete, Original
  light); the screen-only preview; Apply as one undo step; the lights saved with the document.
- L4: the Magnific relight adapter call (the light map in, `change_background` false, style and details settings),
  the result as a layer; a Node test of the request shape; the provider's readiness in the dialog.
- L5: the ComfyUI recipe on kijai's IC-Light nodes (the light map through the recipe's image input; `/object_info`
  check for the node pack; the hint when it is missing); no live run unless the user frees ComfyUI.
- L6: MCP commands, the assistant's rows, the manual, the CHANGELOG line; the gate `relight` (the light map's
  bytes for a known light on a known depth ramp; the preview never in an export; undo; the request shapes).
Phase 2 (about 4-5 sessions): the normal model (MoGe-2 ViT-S normal: registry row, ONNX on the `Runtime`, a
`normals` map on `ed.maps`, the shading reads it when present), shadows if not in L2, light presets (fal's
direction and type words as presets on the in-app lights), a 15k measurement (the shading in tiles like the
filters).

## 7. Risks

- Relative depth: Depth Anything answers disparity, not metres; falloff and shadows from it are plausible, not
  right; a slider for the depth scale, judged by eye. MoGe-2's metric depth would fix it (phase 2).
- The generative routes change pixels beyond the light (texture, faces): `preserve_details` on Magnific, the Original
  light slider, and the user's mask on the result layer; the Realism Pass's lesson (a refiner over the picture).
- IC-Light v2 (Flux) locally: no public node pack; the SD 1.5 model is what runs locally today.
- The Magnific relight endpoint is documented, never run (the two upscalers are the only Magnific calls that ran).
