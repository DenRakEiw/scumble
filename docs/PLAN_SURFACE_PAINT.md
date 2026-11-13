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

**The user's answers (2026-11-13):** 1 yes (the download in the app, with the licence text); 3 yes (SP0's
downloads); 4 **"Deep paint"** (the layer *Deep paint layer*, the brush *Deep paint brush*; not "Deep Brush", the
other product's project name); 5 in-app only. 2 (the HF repo) is asked at SP2.

## 6. As built

**SP0 done 2026-11-13: GO** (`docs/measurements/sp0_2026-11-13/summary.txt`; scripts in `tools/deeppaint/`, run
from a scratchpad venv with torch 2.11 cu128 and diffusers 0.43). Marigold-IID-Lighting v1.1 at one step is good
enough by eye (albedo even, shading plausible; the residual takes too much, so *Keep reflections* becomes a slider);
exported as three fp16 graphs with **float32 in and out** (onnxruntime-node 1.29 under Node 24 cannot feed a
Float16Array), the input **padded to a multiple of 64** (odd latent sides break the UNet's skip concats), the
empty-prompt embedding baked in; on the app's onnxruntime-node with DirectML within 0.04 of torch (mean 0.0005-0.0007),
0.75-2.8 s a run on a card another job held, CPU 49 s. MoGe-2 normal runs as Microsoft exported it (ViT-B 0.4 s on
DirectML, ViT-S 0.2 s, CPU 1.3-2.1 s, DirectML = CPU within 0.04 deg); ViT-B by default. The user's pictures and the
contact sheets stay out of the repo (scratchpad). Next: SP1 (colour maps), and the HF repo question (§5 point 2) before
SP2.

**SP1 done 2026-11-13: colour maps** (`renderer/editor/inpaint_maps.js`). A DocMap has an `enc` now (`MAP_ENC`):
`u16` (depth, as before; a map object without `enc` reads as u16), `rgb16` (three 16-bit values interleaved, for S and
R, linear 0..1) and `rgba8` (four bytes, for N and a mask). `makeMap(kind, w, h, data, xf, meta, guide, enc)` (the
encoding last, so every existing call is unchanged), `deriveMap` keeps the encoding and copies foreign data into the
map's type, `packMap` / `unpackMap` beside `packRG16` / `unpackRG16`, `sampleMapPx` (every channel, bilinear, edge
clamp, through `xf`; `sampleMap` of a colour map reads channel 0), `rg8View` answers null for a colour map. **The file:**
one PNG of `w` x `2h`, two opaque bands stacked (rgb16 the high bytes over the low bytes, rgba8 RGB over R = A), alpha
always 255, so no value ever passes through premultiplication and the file stays one `ref` (docfile, the mirror and
`referencedFileKeys` need nothing new); a u16 map writes exactly the descriptor of before (`enc: "u16rg"`, the same key
order). `mapFromJSON` reads `enc` and refuses an encoding it does not know without loading the file (no guess). `setMap`
uploads `packMap`. Undo, the geometry's `xf` follow-up and `memoryReport` were generic already. **The document:**
FEATURES row `maps-color`, `minReader` 7 (an older reader would load the two-band file as a u16 map and store it back as
`"u16rg"`; `since: "0.1.57"`, the release that ships it corrects it), so `READER_VERSION` is 7; a document with only a
depth map stays at reader 1. Tests: `tools/maps_test.js` §8c (every 16-bit value per channel and every alpha through pack
and unpack exact, the old descriptor byte-for-key, unknown encodings, deriveMap, sampleMapPx through a turned xf),
`tools/maps_test.py`'s third group "colour maps" in the app (set, undo, redo, a quarter turn and its undo, `.scumble`
save and open and the autosave restore exact with encoding and xf, the header 2 / 7), `tools/document_test.js` (reader
7, a depth map stays 1). Gates `sp1a` (maps, document, lint, types) PASS on both backends. Mutation round (`tools/mutation_round.py`, the
untouched copy green first): 9 of 9 killed (band order, alpha in the file's alpha, one band read, `enc` always u16rg,
one channel allocated, `deriveMap` dropping `enc`, `setMap` packing u16, the FEATURES test never matching, an unknown
encoding read as u16); `docs/measurements/sp1_2026-11-13/`. Next: SP2 (the helper), after the HF repo question (§5 point 2).
**For later sessions:** a normal map's vectors are in the map's own frame; a quarter turn or a mirror moves only `xf`,
so a consumer (SP6, SP7) turns the vector by `xf`'s linear part. The GPU has no 16-bit sampler here (`uploadSampler`
takes RGBA8 / RG8 / RGBA32F / R32F): SP4 uploads the file's two bands as two RGBA8 textures and joins them in the
shader as `(hi * 256 + lo) * 255 / 65535`; bilinear filtering is linear, so filtering the bands apart and joining them
equals filtering the 16-bit value up to the filter's weight precision (to be measured in SP4; an RGBA32F upload would
cost 200 MB at 4096 x 3072).

**SP2 done 2026-11-13: the helper** (main side only; the renderer calls come with SP3). **The hosting repo:** the user
asked Claude to create it ("kannst du es für mich anlegen?"): `huggingface.co/DenRakEiw/scumble-intrinsic-onnx`, made
with the stored HF login, **private and empty** (only `.gitattributes`); the upload of the four files (with a README
and the Open RAIL++-M licence text, which the licence requires beside the weights) and making it public wait for the
user's word. Until then the set is in the registry without URLs (`electron/main/onnx/intrinsic.json`, sizes and sha256
of SP0's export; `base` gets the repo's resolve URL at the upload's commit) and not offered; files put into
`onnx/intrinsic/` by hand are used, and `describeAll` lists a set whose files are in place so it can be removed.
**Registry:** `intrinsic` (kind `intrinsic`, a set of `vae_encoder.onnx`, `unet.onnx`, `vae_decoder.onnx`,
`scheduler.json`, its terms text with the licence's use restrictions for the pre-download dialog), `moge2_vitb_normal`
(the default) and `moge2_vits_normal` (kind `normals`, Microsoft's ONNX pinned to commits, a sha256 each, `moge/`
searched, the snapshot layout linked by a scan). **Runners:** `onnx/intrinsic.js` (the one-step formula of SP0 in JS,
the padding, the seeded noise; the decoder's three targets as one batch; answers three interleaved linear RGB
`Float32Array`s, sides 16-768) and `onnx/normals.js` (normal, points, mask, scale at the picture's size, sides
14-2,048). **Engine jobs** `intrinsic` / `normals` in `engine.js` and `helpers_process.js` `JOBS`; `index.js`
`intrinsic(req)` / `normals(req)`, DEFAULTS `intrinsic`, `normals`, the missing-model sentences; IPC
`helpers:intrinsic` / `helpers:normals`, preload `scumble.helpers.intrinsic` / `.normals`; Settings › Helpers names
the two kinds (no picker for ViT-B / ViT-S yet: the default, else whichever is present). **Found:** a lone shaded ball
on a plain wall reads to MoGe-2 as a dish lit from the other side (its normals' x and y run against the ball's,
Pearson -0.94 / -0.77), the old convex / concave ambiguity; on SP0's photos the normals were right. The test checks the
frame against the model's own points instead (mean cos 0.93 to dP/dy × dP/dx, x right 99 %, y down 99.5 %, z > 0
everywhere), so SP6 / SP7 can rely on x right, y down, z away and a seen normal with z < 0. **Tests:**
`tools/deeppaint_helpers_test.js <modelsDir>` PASS on DirectML and on the CPU (`docs/measurements/sp2_2026-11-13/`):
the albedo of the ball even (cv 0.062 against the picture's 0.212), its shading following the light (Pearson 0.995),
its albedo red, every answer byte for byte the same in the helpers' process and on main's thread, the same seed the same
bytes, another seed 0.004 apart on average, 301 x 227 back at its size, the refusals. Timings at 512 x 384 with the card
mostly free: DirectML 2.7 s for the three sessions' load, then 0.1 s a run (encode 13, UNet 24, decode 50 ms), MoGe-2
ViT-B 1.4 s cold; the CPU 19 s a run. In the dev app (own profile, `--no-comfy`): the two IPC calls answered through the
helpers' process on DirectML, a side of 1,000 refused with the sentence, the three rows in Settings › Helpers.
`download_test` 72 / 72, `scan_test`, `helpers_test --process`, lint, types green.
**The upload (the user, the same day: "ja, mache den upload"):** `DenRakEiw/scumble-intrinsic-onnx` commit `17a90768`:
the four files (Hugging Face's LFS sha256 equal to the registry's), `LICENSE-MODEL.txt` unchanged from
`github.com/prs-eth/Marigold` @ `2bfbdeae` (Marigold's own Open RAIL++-M of 2024-11-22, Copyright PRS, ETH Zürich; its
Attachment A holds only the template's "[insert use restrictions]", so the terms paragraph names paragraph 5 and no list;
the first draft had listed restrictions this licence does not carry), and a README (the licence's Section III, 4: the
files marked as converted, the notices kept, the licence included; the graphs, the step, the sha256, the citation).
The repo was private for the upload (a run without the token got 401) and **public since 2026-11-13** (the user:
"ja, schalte public"; `scheduler.json` fetched without a token, its sha256 equal). `intrinsic.json`'s `base` is the resolve URL at `17a90768`, so the set is offered. **Found with
it:** the app's `Downloader` was built without `termsAccepted`, so a model with terms could never download in the app
(CK2 was a placeholder, so nobody hit it): the terms dialog in Settings › Helpers and `helpers.terms[id]` (HELPERS.md
"Downloads"); run in the dev app: refused without the yes and with a wrong version, Cancel downloads nothing, Accept
starts it and stores version 1, the next Download asks no more. The full download through `Downloader` into an empty
folder with the token: sizes and sha256 checked (`docs/measurements/sp2_2026-11-13/download.txt`). Next: SP3
(decompose).

**SP3 done 2026-11-13: the surface maps** (the user: "ja, schalte public und baue weiter"). `renderer/editor/
inpaint_surface.js` (plain functions, in the node build's FILES): `surfaceMaps` = §3.1 at last as built: the joint
least-squares fit `I ~ a A S + b R` on the model's size in linear light (`fitScale`), S' and R' up to the work size by a
bilinear step and an unclamped guided filter (guide: the work picture's grey, r = the upsampling factor, at least 2;
eps 1e-3), S' stored as S / `sScale` (its largest value, so light above 1 is kept in a 0..1 16-bit map), then **R made
exact against the stored S**: `A_up = clamp((I - R_up) / S_q)`, `R = I - A_up S_q` (R in [0, I]); `packNormals` (MoGe's
vectors (n + 1) / 2, the mask in A); `surfaceModelSize` (long side 768). The pool's worker op `surface_maps`.
**The editor** (`inpaint_ed_depth.js`): `computeSurfaceMaps({ recompute })` (the picture without filter layers on grey,
as depth, at 768 -> `host.surfaceAnalysis` (the decomposition, then the normals, in the helpers' process) -> the job at
the work size -> three maps: `shading` and `residual` rgb16 at the work size, `normals` rgba8 at the model's size, all
with the document's `xf`; a fresh set (the 64 x 64 fingerprint) is kept), `setMaps` (several maps in **one undo step**:
`inpaint_ed_history.js` reads a `maps` step with `maps: { kind: prev }` beside the one-map form), `hasSurfaceMaps`,
`surfaceMapsInfo`, `setSurfaceView` / `surfaceProxy` (the screen shows the light, the reflections or the normals in place
of the picture through `mapView`, never in an export). *Image › Surface Maps* (Compute, Show Light / Reflections /
Normals / the Picture), the MCP command **`surface_maps`** (`force`, `view`; AUTO in the assistant's policy, 900 s;
120 tools, 100 core). Host members `surfaceModels`, `surfaceAnalysis` (`host_helpers.js`); **the node's `js/host.js`
needs two stubs at the next node build** (`surfaceModels() { return null; }`, `async surfaceAnalysis() { throw new
Error("Deep paint is a Scumble feature"); }`), or `build_node.py --check` refuses (not run here: it reads the user's live
node folder). **Found, and the design changed:** an "excess" residual (the light's scale from the low-residual half,
R = what A S does not explain) looked better by its numbers (A at 0 on 8-11 % instead of 23-41 % on two pictures) but
was wrong to the eye: the model's albedo is blurred and its colour a little off, so that R held the albedo's error in the
complementary colour (the orange car's residual teal, a purple face paint's blue; the contact sheet of the portrait and
the cafe scene, `docs/measurements/sp3_2026-11-13/`, kept out of the repo as SP0's: the user's pictures). The model's own
residual is colourless (highlights, sparkle, fine texture), so the joint fit is the default and "excess" stays as
`surfaceMaps(..., mode: "excess")` for the comparison. Where b R' reaches the picture A clamps at 0 (paint there would
add light, not cover: 3 % of the portrait's channel values, 14-41 % of the three street pictures', mostly where by eye
the model calls sky, glass and openings residual; not measured where): **SP5's "Keep reflections" must scale R in the
brush's formula** (`P S + k R`). **Tests:** `tools/surface_test.js` (synthetic: the fit finds a = 2, b = 2.5; a picture
made as A S + R back within 0 levels at two sizes; black; the normals' pack; the model's size; with the models and
SP0's four pictures prepared as raw RGBA: the identity within 0.025 levels at 1,500 x 2,000 and 2,048 wide, the maps'
job about 1 s there in plain Node) PASS (`docs/measurements/sp3_2026-11-13/surface_test.txt`). In the dev app (own
profile, `--no-comfy`, the portrait 1,500 x 2,000): `surface_maps` in 10.5 s cold (sessions' load included), a second
call 18 ms (kept), one undo step takes all three and redo brings the same data, a `.scumble` saved and opened in a new
tab gives the same samples and meta, the three views looked at (light grey and smooth, reflections, normals). Gates
`sp3-t` (maps, document, commands, mcp, lint, types) PASS on tiles. **Not done in SP3:** the 15k timing (next), a
gate step in `maps_test.py` for the surface maps (they need the 1.9 GB set: a stand-in for `host.surfaceAnalysis`
would test the rest), staleness shown in a panel (the fingerprint is kept; `mapStale("shading")` answers), the
`albedo` view (it needs the picture: (I - R) / S). Next: the 15k timing and the gate step, then SP4.

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
