# Surface paint: painting on the picture's surfaces (item 72)

The user, 2026-11-13: "schau mal, können wir das nachbauen?" with Adobe's Project Deep Brush sneak (MAX 2026,
https://labs.adobe.com/sneaks/deep-brush), then "ok, mache einen umsetzungsplan und lass uns das entwickeln".
Branch `surface-paint` off `wasm-kernels` (after the 0.1.56 version commit); one release at the end, on the user's
word. Plans may name other products; public texts (manual, CHANGELOG, posts, README) describe what the feature does,
never whose it resembles.

Research of 2026-11-13 (two agents, web and code; their reports are summarised here, nothing was downloaded):
the model comparison in §2, the code anchors in §7.

## 1. What it does (the behaviour, in plain sentences)

- **Surface brush.** You paint colour on a *surface layer*. The colour lands as the surface's own colour: the
  picture's shadows, shading and highlights stay over it. Light paint in a shadow comes out dark, a highlight on a
  bottle stays a highlight. Where you have not painted, the picture is exactly as it was (byte for byte).
- **Light brush.** You paint where light should fall, then set its direction, colour and strength; the light follows
  the surface's orientation (a wall facing away gets less).
- **Wrap.** An image layer (a logo, a tattoo, a pattern) is wrapped onto a curved surface: it bends around an arm or
  a bottle, compresses towards the edges of a curve, and takes the surface's light like painted colour.
- **Masks.** The existing selection, colour range and layer masks keep the paint where it belongs (an eye, a strap).
- Everything runs on the user's machine after a one-time model download; nothing leaves it.

## 2. The decomposition: which model

What the brush needs from one photo: **shading S** (the light that falls on each pixel, colour, linear), **residual R**
(what is not diffuse: highlights, light sources, linear) and from those the albedo. Plus **normals N** for light and
wrap.

| Candidate | Licence (code / weights) | Outputs | Shape | Verdict |
|---|---|---|---|---|
| Marigold-IID-Lighting v1.1 (prs-eth) | Apache-2.0 / CreativeML Open RAIL++-M (commercial use allowed, use restrictions passed on) | albedo, colour diffuse shading, non-diffuse residual, linear | SD2 fine-tune 0.9B, DDIM, 1 step works per the paper; 768 px long side | **In-app route**: our own ONNX export (UNet + VAE), fp16 ~1.8 GB (estimate) |
| MoGe-2 normal ViT-S / ViT-B (Microsoft) | MIT / MIT | normals, points, depth, intrinsics | 35M / 104M, prebuilt ONNX (opset 14, dynamic H/W) | **Normals**, and its point map drives Wrap. Also relight's planned N1 |
| Careaga & Aksoy 2024 (compphoto/Intrinsic) | academic use only, patent pending | albedo, colour shading, residual | five CNNs, ~1 s, 1.78 GB | best on real photos (MAW, ARAP), **blocked by its licence** unless SFU licenses it |
| Marigold V2 albedo (huawei-bayerlab) | Apache-2.0 on Qwen-Image-Edit-2509 (20B) | albedo only | native in ComfyUI ≥ 0.36 | **ComfyUI route** (best albedo); S = I / A, R from a highlight estimate |
| Comfyui-marigold-intrinsics-PaGeR | Apache-2.0 code, fetches Marigold IID weights | all three | a node pack the user installs | ComfyUI route for the full split |
| RGB↔X, Intrinsic Image Diffusion, DSINE | non-commercial | | | out |

Newer one-step models (Ouroboros, FlowIID, LBM albedo) have no code or weights (2026-11-13).

**The trap to measure first (lesson of CorridorKey's Stop A, 2026-11-06):** DirectML refused a stage of CK2 at one
MatMul. A UNet export can fail the same way, and one-step quality on real photos is only "qualitatively enough" in the
paper. SP0 measures both before any app code.

## 3. The design

### 3.1 The maps

The decomposition is a **document analysis like the depth map** (`ed.maps.depth`, a DocMap): made once per picture
on demand, stored in the document, one undo step, a staleness fingerprint. Kept: **S** (shading) and **R** (residual)
as RGB maps at the work size (≤ 4096 long side, as depth), and **N** (normals) as an RGBA8 map. DocMaps hold u16 only
today (`inpaint_maps.js` `makeMap`, `mapToJSON` hard-codes `enc: "u16rg"`), so SP1 adds a colour encoding.

The model runs at 768 px. Up to the work size: S by the guided filter with the picture as guide (the low-frequency
light, `guidedFilterRatio` in `inpaint_relight.js`), R upsampled the same way, then **R made exact**:
`R = I_lin - A_up * S_up` with `A_up = clamp((I_lin - R_up) / S_up)`. With that, `A * S + R` gives the picture
back exactly, and every formula below is the identity where nothing is painted.

### 3.2 The surface layer

One formula carries the brush, in linear light, with B the composite below, P the painted colour, α its alpha:

    out = mix(B, P * S + R, α)

(the painted pixel takes the picture's light S and keeps its highlights R; α = 0 leaves B). The light brush adds ΔS
to the shading: `out = B + A * ΔS` with `A = (B - R) / S` and `ΔS = m * intensity * colour * wrap(N · L)`, m the
painted light mask.

**How it composites (SP4 decides, recommended first):** a surface layer is a **paint layer with `surface: true`**,
composited as a filter step that reads its own pixels (P, α) and the maps S, R, N as samplers. Strokes, brush tips,
pressure, layer masks, undo and persistence stay the paint layer's; the filter machinery gives the GPU shader, the CPU
twin, map samplers (`registerHazeGL`'s pattern: `rg8View`, `passToMap`), tiles and bands (reach 0) and exports. The
alternative, a blend mode `surface` in the compositor, would put two colour maps into every blend path (the GLSL
compositor, Rust `composite_tile`, PSD emulation): more risk for the same pixels. PSD / ORA export bakes the layer
(a plain pixel layer in Normal), as filter layers export today.

**Light** on the same layer: a second channel of the layer (its light mask, painted with the light brush) and one
light per surface layer (sun or point, relight's `lightToMap` and handle), or a relight filter layer that reads S when
present. SP6 picks after SP4 is built; relight's in-app route already fits a pseudo-albedo (`shadePixel`'s
`gain = 1 / S_fit`), and a true S makes it better too.

### 3.3 Wrap

From MoGe-2's point map (or the depth map with the camera's guess), every pixel gets surface coordinates around the
decal's centre c by arc length: `u(x, y) = Σ |P(x+1, y) - P(x, y)|` along the row from c, `v` along the column, in
document pixels of the surface. The decal's pixel for (x, y) is `decal((u, v) / scale, rotated)`; outside the surface
region (a selection or a depth-edge cut) nothing. The decal goes into the surface layer's pixels as P (so it takes S
and R), previewed live while it is moved, scaled and turned, baked on Enter. A cylinder unwraps exactly; a strongly
curved double surface (a face) gets a distortion that shows, which the manual states.

### 3.4 Where it runs

- In-app: the intrinsic set (our ONNX export) and MoGe-2 normal through the helpers' process (`engine.js` jobs,
  `helpers_process.js` `JOBS`), DirectML on Windows, CUDA / CPU on Linux; downloaded from a pinned commit with a
  sha256 per file (`models.js`, `fromSetCatalogue` as CK2's set).
- Fallback: the user's ComfyUI (Marigold V2 albedo natively, or the PaGeR pack for the full split), as CorridorKey's
  Route B; only if SP0 says no-go or the user wants both.
- Normals without MoGe-2: relight's `height_normals` from the depth map (exists), coarser.

## 4. Sessions

One session each, a commit and the hand-over in this file's §6 after each. Tiers by risk (CLAUDE.md Working rules).

| # | What | Tier | Done when |
|---|---|---|---|
| SP0 | **Spike, Stop A.** A dev venv (scratchpad, never shipped): Marigold-IID-Lighting v1.1 in diffusers on 6 of the user's pictures at 1 and 4 steps (quality by eye: albedo flat, shading smooth, highlights in R), timings at 768 on the 5090; ONNX export of the UNet and VAE (fp16), onnxruntime DirectML and CPU against torch (max abs error, time); MoGe-2 ViT-S / ViT-B normal ONNX on DirectML. `docs/measurements/sp0_<date>/` | measure | go / no-go and the user's look at the pictures |
| SP1 | **Colour maps.** DocMap `enc: "rgb16"` (and `rgba8` for N), `mapToJSON` / `mapFromJSON`, persistence, FEATURES `maps-color`, undo, a reader of an older document unchanged | Full | maps gate + document round trip both backends, mutation round |
| SP2 | **The helper.** Registry rows (intrinsic set, MoGe-2 normal), `onnx/intrinsic.js` (VAE encode, UNet one step, VAE decode per target), `onnx/normals.js`, engine jobs, IPC, Settings › Helpers rows; our ONNX hosted at a pinned commit (the user's HF repo, §5) | Normal | helpers_test with the real model, byte-equal in and out of the process |
| SP3 | **Decompose.** `computeSurfaceMaps` (picture input at 768, guided upsample, R made exact, the identity checked), staleness, *Image › Surface maps*, *Show maps* for S / R / N, MCP `surface_maps` | Normal | identity within 1 level on 4 pictures, 15k timing |
| SP4 | **The surface layer.** `surface: true` paint layers composited by the formula, GLSL + CPU twin (+ a Rust kernel if the CPU band needs it: both builds), bands, export bake, undo, `.scumble` | Full | composite / export gates both backends, mutation round, a 15k pan |
| SP5 | **Surface brush UX.** *New surface layer*, the brush picks the albedo with the eyedropper (`(B - R) / S`), colour mask and selection limit, MCP `add_surface_layer` / `set_brush` | Normal | gate step, a look by the user |
| SP6 | **Light brush.** The light channel or relight on S (§3.2), one light with its handle, MCP | Normal | gate step, a look |
| SP7 | **Wrap.** Arc-length unwrap (worker; Rust if slow), place / scale / turn / bake, MCP `wrap_layer` | Normal | a cylinder test exact within 1 px, a look |
| SP8 | Docs (manual chapter, HELPERS, CHANGELOG, COMMANDS), the user's live test, release prep | Light | the user's word |
| (SP9) | ComfyUI route, only on SP0's no-go or the user's wish | Normal | |

About 9-12 sessions (inferred), SP0 decides the rest.

## 5. Questions for the user

1. **Licence of the in-app model:** Marigold-IID-Lighting's weights are Open RAIL++-M (commercial use allowed, with
   use restrictions the app passes on in its terms text, as SAM2's and CK2's notices). Fine for a download in the
   app? Suggested: yes.
2. **Hosting our ONNX export:** RAIL allows redistribution with the licence attached; a Hugging Face repo of yours
   (e.g. `DenRakEiw/scumble-intrinsic-onnx`) at a pinned commit. Suggested: yes, created by you, uploaded by Claude
   with your token only if you say so.
3. **SP0's downloads into the scratchpad:** a Python venv with torch and diffusers (~3-4 GB), the Marigold-IID-
   Lighting v1.1 checkpoint from `prs-eth/marigold-iid-lighting-v1-1` (~3.6 GB fp32, estimate) and MoGe-2 ViT-S / ViT-B
   normal ONNX from `Ruicheng/moge-2-vits-normal-onnx` / `-vitb-` (sizes read at download). Nothing on your ComfyUI.
4. **The name in the app:** "Surface layer" / "Surface brush" / "Wrap" (suggested), or your own.
5. **ComfyUI route too** (SP9), or in-app only? Suggested: in-app only unless SP0 fails.

## 6. As built

(empty)

## 7. Code anchors (read 2026-11-13 at `e0ff04cd`)

- Helpers: `electron/main/onnx/models.js` `MODELS` :73 (`da2_small` :122), `fromSetCatalogue` :44, `Downloader` :411;
  `engine.js` `depth` :142, `checkDepth` :26; `depth.js` `Depth.run` :26 (the runner shape); `helpers_process.js`
  `JOBS` :21; `index.js` `DEFAULTS` :21, `MISSING` :169, `depth` :277; IPC `main.js:1328`, `preload.js:208`; Settings
  label `renderer/shell_settings.js:658`; renderer `host_helpers.js` `pictureInput` :312, `depthInApp` :534.
- Maps: `inpaint_ed_depth.js` `computeDepthMap` :47, `setMap` :565, `mapStale` :844; `inpaint_maps.js` `makeMap` :43,
  `rg8View` :219, `mapToJSON` :256, `passToMap` :332, `SAMPLE_GLSL` :663; persistence `inpaint_ed_persist.js:85`, :327;
  `docfile.js` `FEATURES` :54.
- Normals and light: `crates/px/src/relight.rs` `height_normals` :26; `inpaint_ed_relight.js` `ensureRelightMaps` :293;
  `inpaint_relight.js` `lightToMap` :663, `shadePixel` :956, `RELIGHT_GLSL` :1720, `guidedFilterRatio` :2138,
  `detailRatio` :2191; MoGe-2's plan `docs/PLAN_RELIGHT_BUILD.md` §5.12 N1.
- Filters: `inpaint_filters.js` `FILTERS`, `applyFilter` :1456, haze :1224; `inpaint_filters_gl.js` `registerGLFilter`
  :962, `uploadSampler` :1039; `inpaint_depthfx.js` `registerHazeGL` :230 (the map-sampler pattern);
  `inpaint_ed_filters.js` `filterInfo` :526, `filteredCanvas` :593; bands `inpaint_ed_stack.js` `stackPlan` :150.
- Strokes: `inpaint_ed_strokes.js` `layerStroke` :94, `commitStroke` :433, `liveMask` :602; rule brushes
  `inpaint_ed_tips.js` `smudgeDab` :247; press `inpaint_ed_pointer.js:463`; `dodgeBurnLayer` / `frequencySeparation`
  (`inpaint_ed_filters.js` :224 / :171) as layer set-ups.
- Wrap: `inpaint_mesh.js` `drawMesh` :69; transform `inpaint_ed_geometry.js` :16-147; glb's three.js
  `plugins/glb/render.js` :187.
- Commands: a `*CommandsPart` (`renderer/commands_depth.js` :12), `POLICY` in `electron/main/assistant/policy.js` :47,
  `tools/commands_doc.py` `GROUPS` :19, the tool count in `docs/MCP.md:486` and `README.md:84`.
- Found on the way: `tools/run_gates.sh depth` names `tools/depth_test.py`, which does not exist (TESTING.md :299);
  the glb plugin's role `"control"` is not in `ROLES` (`inpaint_consts.js:121`).
