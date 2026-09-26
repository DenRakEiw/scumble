# Nik 9 parity: depth masks and the rest - research and shape

**Status: brainstormed on 2026-09-25, not planned into sessions, not built.** CLAUDE.md "What comes next" item 22.
A multi-agent brainstorm (four research reports, three designs, two judges, a critic) produced what follows; the
code references were read on 2026-09-25 and will drift. Every time and every effort figure here is **inferred, not
measured**. What is measured is marked so.

## What the user asked and answered

The trigger: DxO Nik Collection 9's "Tiefenmasken" (https://www.dxo.com/de/nik-collection/whats-new/#depth-mask):
a depth map estimated from the photo, near / far sliders with their own feather, adjustments limited by distance.

The user's answers (2026-09-25):

- **What it is for:** "Bearbeiten des finalen Images nach Inpainting" - local adjustments of the finished picture
  by distance (grading, haze, halation), not selections for inpainting and not lens blur first.
- **Edges:** "besser richtig umsetzen" - the edge work belongs in the package, not a later maybe.
- **Scope:** "wenn dann alles" - the whole Nik 9 feature set that Scumble lacks, not depth alone.
- **The list:** an update of its own, not optional.

## What Nik 9 has, and where Scumble stands

| Nik 9 feature | Scumble today | Effort |
|---|---|---|
| Depth masks | **Missing.** No depth model in `electron/main/onnx/` (only `sam2.js`, `matting.js`) | see below |
| AI masks (click / box) | Object tool with SAM2 click; SAM2 takes a box (`sam2.js` ~92-94, `select_point` `box`) but a drag with the Object tool does nothing | 2-4 h for the drag |
| Mask overlays | Selection tint and quick mask exist; a layer mask shows only a "mask" label, no overlay, no black-and-white view | 0.5-1 d |
| Luminosity masks | Missing (the wand is a hard flood) | ~1 d, shares the range bar with depth |
| Colour masks | Partial (wand; `film.points` weights by colour distance) | +0.5 d on the same range bar |
| Control lines | Partial (the gradient tool writes pixels only) | 0.5-1 d as a line-shaped control point |
| Elliptical / polygonal control points | Missing (`film.points` has circles) | ellipse 0.5 d, polygon ~1 d |
| Control point diffusion | Missing (fixed falloff, `points.js` `sstep(0.25, 1.0, dist)`) | 2-3 h |
| 18 blend modes | 9 (`BLEND_MODES`, `inpaint_canvas.js:70`) | 5-7 d, core (below) |
| Halation | **Have** (`film.halation`, `film.look`) | - |
| Chromatic shift (offset-print plates) | Missing | 0.5-1 d, shader |
| Glass effect | Missing | 1.5-2 d, textures computed in the shader (no bitmap assets) |
| Colour grading wheel | Partial (the maths in `color_balance`, `film.split_tone`; no wheel, no global point) | 1.5-2 d |
| ClearView (dehaze) | Missing | ~2 d (dark channel + guided filter, haze colour from `wholeStats`) |
| HSL, 8 channels | Missing (`hue_sat` is global) | ~1 d |
| Preset hover preview | Partial (film looks thumbnails) | ~0.5 d |
| Copy / paste local adjustments | Partial (no "paste mask onto another layer") | ~0.5 d |

## The shape: four releases

The judges agreed on the order: the depth map belongs to the **document** from day one (not privately to a plugin),
so each release builds on the one before without a rewrite.

1. **Masks (about 13-16 days).** The depth helper and *Select by depth*; *Limit by depth* live on filter layers;
   luminosity and colour-range sources on the same range bar and the same post-stage; the new **Intersect** selection
   mode; the Object tool's box drag; the layer-mask overlay. This is the release that serves "editing the final
   picture".
2. **Edges and depth filters (about 8-13 days).** The detail pass and the full-resolution edge snap (the recipe
   below), haze by depth, dehaze; lens blur only on the user's word (it is where halos show most).
3. **Filters and control points (about 8-10 days).** HSL 8 channels, chromatic shift, the grading wheel, glass,
   elliptical / polygonal / line control points and their diffusion, preset hover preview, paste a mask.
4. **Blend modes (5-7 days).** The 18 missing modes, in three tiers.

**In all about 34 to 46 working days** - roughly two months, and this repository's record says first estimates
stretch with the gates, the mutation rounds, both backends, the manual sync and the blog post.

**A checkpoint on the user's pictures** after the model runs (release 1, about day 2): the raw map of DA V2 Small
on `docs/images/tutorial/scene.jpg`, `skin.jpg` and a 15k file, and if the user allows an export, DA3Mono-Large
beside it. That decides how much of release 2's edge work is needed.

## Depth: the model

| Model | Licence | ONNX | Size | Note |
|---|---|---|---|---|
| **Depth Anything V2 Small** (default) | Apache-2.0; issue #320 (training data) open since 2026-04-13, no answer | yes | fp32 99.1 MB, fp16 49.6 MB, int8 27.3 MB | what DxO builds on (with its own trained edge network; secondary sources, dxo.com answers 403) |
| DA3Mono-Large (quality option) | Apache-2.0 | **none**; we would export and host it (running the export script is third-party code: the user's call) | ~0.7 GB fp16 | relative depth plus a sky mask |
| DA3-Small / DA3-Base | Apache-2.0 | onnx-community, external data, no preprocessor config | 105 / 412 MB | stand-in until our own export; unmeasured against DA2-S |
| DA3Metric-Large | Apache-2.0 | none | - | metric depth: ranges in metres would survive a recompute and transfer between pictures |
| DA2 Base / Large / Giant, DA3-Large(-1.1) / Giant / Nested, UniDepth | CC BY-NC 4.0 | - | - | only as the user's own download, like RMBG-2.0 |
| Depth Pro (Apple) | weights research-only (`apple-amlr`) | - | - | out, also as a download |
| MoGe-2 | weights licence unanswered (issue #98) | yes | 141 MB / 1.32 GB | second choice once answered |

**The repo trap:** `onnx-community/depth-anything-v2-small` is marked deprecated since 2026-04-14 (`new_version:
onnx-community/depth-anything-v2-small-ONNX`), and the new repo uses the **external-data format** (`model.onnx`
127 KB + `model.onnx_data` 98.8 MB). The helper registry (`electron/main/onnx/models.js`) keeps one file per role
and renames it, so either pin the old single-file repo at commit `4472b7362082ad9968fee890ca0f1e5aca36b93d` or teach
the registry a data file per model (DA3 exports need the same).

**Input and output:** `DPTImageProcessor`, short side 518, `keep_aspect_ratio`, `ensure_multiple_of: 14`, bicubic,
ImageNet mean / std. A 3:2 picture becomes 518 x 784 (777 / 14 = 55.5 rounds half-even to 56; take the rule from the
processor's code). The output is relative inverse depth (near = large); pick the output tensor by element count, as
`matting.js` does; settle its name and shape on the first real run. Start with fp32 (`docs/HELPERS.md` warns fp16
inputs were never checked); keep a few fixed input sizes in case DirectML recompiles per shape.

**The helper path:** `electron/main/onnx/depth.js` shaped like `matting.js` (a `(w, h)` normalise, since `sam2.js`'s
is square only), a `kind: "depth"` row in `models.js` (plus `SUBDIRS`, `ONNX_ALIASES`, `OTHER_WEIGHTS`), `depth` in
`index.js` `DEFAULTS` with its own image check (`checkImage` demands 1024²), IPC `helpers:depth`, a `host.depthInput`
modelled on `objectInput` (one `sampleRegionSettled` pass on tiles, no full flatten at 15k), `editor.helperUsed = true`.
A new `host` member also goes into the node's `js/host.js` and the `EditorHost` typedef, or `build_node.py --check`
and `npm run types` fail. **The model input leaves filter layers out** (plugin `doc.flatten` passes `forRun`, which
includes them), or a depth-limited haze feeds its own map.

## Depth: where the map lives

- The raw map (518 x 784 f32, ~1.6 MB) and a **working map up to 4096 px**, guided to the photo in a **pool or
  stitch worker** over the existing f32 `boxBlurs` kernel (`crates/px/src/maskf.rs`, `px/kernels.js` ~88) - never in
  Electron's main process, which would stall IPC, MCP and the assistant.
- Kept as a document resource, stale by input hash (compare, offer *Recompute*, never recompute by itself);
  persisted as a **u16 packed into the R / G of a PNG** mirror ref, following `layer.plate` (8-bit would band the far
  range). A full-resolution depth layer at 15k would be 600 MB of RGBA8 tiles: not the default.
- *Depth as a layer* only with the control-layer finding below fixed first.

## Depth: range to mask

- **Selection (release 1):** a soft selection through `applyTilesToSelection` (soft in replace mode only; `add`
  overwrites and `subtract` clears on any alpha today) or a regional band draw. `applyMaskToSelection` binarises and
  builds a W x H canvas: not usable. Decide the soft add rule once (`max(a, w)` or `a + w(1 - a)`) and test it on both
  paths. New **Intersect** mode (none exists).
- **Live on filter layers (release 1):** a pointwise post-stage in `applyFilter`, GL and CPU, `out = mix(in, out,
  w(depth))`, `info.depth` fed at both call sites (view and bands / program), the depth ref and the range in the
  filter cache key; the painted `maskPx` multiplies on top (a refine brush that survives slider moves). Paint and image
  layers keep the baked *Mask from selection* - live masks there would touch the compositor at many sites and cost
  dense RGBA8 stores per layer at 15k.
- **The range bar:** eyedropper and hover tint, a near-to-far bar with histogram, a range box and a feather handle
  at each end, *Show depth map*, invert. The same bar takes the luminosity and colour-distance sources.
- **MCP:** `depth_map` (with `depth_at`), `select_depth`, `sample_depth`, all AUTO in `policy.js` like `select_point`;
  the range as a param of `add_filter` / `set_filter`.

## Depth: the edge recipe (release 2)

DxO sharpens the depth with a trained network against the full-resolution photo; nothing under a clean licence
stands in for it. The classical stand-in:

1. The global pass at the model's resolution.
2. A detail pass for 4k to 15k: overlapping 518 px tiles (2x2 or 3x3), each fitted to the global pass by a
   least-squares scale and shift in disparity, low frequencies from the global map, high from the tiles, feathered
   overlaps; or DA2 at a long side of 1036 to 1400.
3. The mask by smoothstep in normalised disparity, evaluated in the shader so the sliders are live.
4. A colour guided filter on the **mask** at full resolution, with the photo as the guide, only inside a band where the
   depth changes (the distance transform `crates/px/src/edt.rs` bounds it).
5. Semantic snap: a SAM2 click replaces the depth inside the object with its median, so a cut never splits a person;
   BiRefNet's matte gives the hair edge inside the band.
6. A refine brush as the last resort.

Expected (inferred): close to DxO on landscapes and architecture; hair against a background at a similar depth,
see-through foliage and glass keep halos - the same complaint DxO and Adobe get. For grading by distance a soft
transition is what Nik users want anyway; halos show most under strong blur.

## Blend modes (release 4)

The 18 Photoshop modes Scumble lacks: dissolve, darker colour, colour burn, linear burn, lighter colour, colour dodge,
linear dodge (add), vivid light, linear light, pin light, hard mix, exclusion, subtract, divide, hue, saturation,
colour, luminosity (whether Nik's 18 are this set is not stated). Each touches the GL compositor (`BLEND_INDEX`,
`blend1`; hue / saturation / colour / luminosity need a vec3 path with SetLum / SetSat / ClipColor), the Rust kernel
(`crates/px/src/composite.rs`, one rounding) and its JS twin bit for bit, an ABI bump and both `.wasm` rebuilt, the
Canvas 2D backend (colour dodge / burn, exclusion and the four HSL modes exist there; 11 need an emulation), the PSD /
ORA maps (twice) and the reader, the tests (`composite_test.py`, `export_test.py`, `layered_test.js`, `px_test.js`),
`build_node.py` and `nodecopy`. Tiers: A colour dodge / burn / exclusion ~1.5 d, B the four HSL modes ~2 d, C the
other 11 ~3 d. It fixes a real gap: a PSD layer in linear dodge opens as normal today.

## Traps found on the way

- A soft selection meets hard thresholds in the run path (the crop box at alpha > 0.5, `stitch.js` ~231; the fill
  mask ~249; OpenAI's mask ~484). Not the user's stated use, but "replace the background by depth" at 15k would come
  back at the model's 2-4 MP.
- Relative depth is per picture: a range copied to another document or kept in a preset does not transfer (metric
  depth would).
- The ComfyUI route writes to the production server: `comfyui-depthanythingv2` auto-downloads a missing model (its
  default is a 1.3 GB non-commercial file that is not on disk). If ever built, name only files `/object_info` lists.
- DirectML inference competes with a running ComfyUI job on the same GPU.
- Not built by the brainstorm, and a separate cheap win: the depth source could be any grey layer or file (the user's
  own ComfyUI maps, glb's depth, a Z pass), and a desaturated copy as the source already is a luminosity mask.

## Side findings (read, not run; each has a task chip of 2026-09-25)

- **Control layers never reach a run:** `control_image` is sent only for a *visible* control layer
  (`inpaint_canvas.js` ~12098), a visible one is drawn over the view (~10328-10335), glb creates its depth layer
  hidden (`plugins/glb/main.js` ~114), and no shipped recipe wires `control_image`.
- **`film.points`:** its second sampler `u_blur` sits on unit 6, which `renderToTexture` binds above ~33 MP; and
  Resize / Upscale do not move filter-layer params, so its points (image pixels) stay behind.

## Sources

DxO: https://www.dxo.com/de/nik-collection/whats-new/ (read in the app's browser pane; WebFetch got 403),
https://www.dxo.com/en/news/grey-paper-depth-masks/ (search snippet only). Reviews:
https://petapixel.com/2026/04/21/dxo-nik-collection-9-has-ai-masking-more-filters-and-new-blending-modes/,
https://blog.thomasfitzgeraldphotography.com/blog/2026/4/dxo-releases-nik-collection-9-a-first-look-at-the-new-suite,
https://www.dpreview.com/news/6250392506/dxo-nik-collection-9-announcement/,
https://www.tocatlian.com/news/photography/dxo-photolab-10-depth-masks/,
https://fstoppers.com/education/depth-range-masking-camera-raw-adobes-most-useful-new-photoshop-feature-902214.
Models: https://huggingface.co/onnx-community/depth-anything-v2-small,
https://huggingface.co/onnx-community/depth-anything-v2-small-ONNX,
https://github.com/DepthAnything/Depth-Anything-V2/issues/320,
https://raw.githubusercontent.com/ByteDance-Seed/Depth-Anything-3/main/README.md,
https://huggingface.co/depth-anything/DA3MONO-LARGE, https://huggingface.co/apple/DepthPro/blob/main/LICENSE,
https://github.com/microsoft/MoGe/issues/98.
