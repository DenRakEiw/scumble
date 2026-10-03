# RTX Video Super Resolution as an upscaler (part of item 14; the user, 2026-10-03)

**Status (2026-10-03):** researched once, on the list of later updates (the user: "erst das dlss auf die liste
späterer updates"); nothing built.

The user's ask: "nvidia dlss upscaling bzw. dlls plugin ... gibts auch ne dlss api? für i2i?"

## What was found (2026-10-03)

- **DLSS itself does not fit a picture.** DLSS Super Resolution reconstructs from several rendered frames and needs
  the game renderer's motion vectors, depth buffer and camera jitter (integrated through NVIDIA's Streamline SDK on
  DX11 / DX12 / Vulkan). A photo or a generated picture has none of them; no still-image mode and no cloud API was
  found.
- **RTX Video Super Resolution** (NVIDIA's video upscaler: compression artefacts out, edges sharpened, on the Tensor
  Cores) exists in three forms:
  - the ComfyUI node `RTXVideoSuperResolution` (pack `Comfy-Org/Nvidia_RTX_Nodes_ComfyUI`, Apache-2.0, version 0.1.3;
    it needs `nvidia-vfx`, NVIDIA's proprietary Python bindings of the Video Effects SDK, version 0.2.0.0 on PyPI).
    **Installed and loaded on the user's ComfyUI** (`/object_info/RTXVideoSuperResolution` read 2026-10-03): `images`
    IMAGE, `resize_type` a V3 dynamic combo (*scale by multiplier*: `scale` 1.0-4.0; *target dimensions*: `width` /
    `height` 64-8192, step 8), `quality` LOW / MEDIUM / HIGH / ULTRA (default ULTRA); it runs frame by frame, so a
    single picture works. The user's card is an RTX 5090.
  - the RTX Video SDK and the Video Effects SDK (C API, Windows and Linux, NVIDIA's proprietary licence);
  - the VSR NIM (a container for video streams over gRPC, Ada or later): no picture API.
- NVIDIA Image Scaling (open source) is a plain spatial filter without a model; not worth a recipe.
- What to expect: a video model, fast and clean, with no invented detail (unlike the generative upscalers); whether
  it beats 4x-UltraSharp on generated pictures is the first comparison to make.

## The shape (when it is picked up)

1. **A recipe `recipes/rtx_vsr_local.json`** beside `recipes/upscale_model_local.json`: `RTXVideoSuperResolution`
   instead of `ImageUpscaleWithModel`, Settings rows for the factor and the quality. Open: how the dynamic combo
   `resize_type` is written in an API-format prompt (read it from a workflow exported in API format). Today's local
   upscale route works on the selection only (a detail pass at the document's resolution), since the node's stitch
   cannot replace the base.
2. **The whole picture for local upscale recipes:** the answer fetched from ComfyUI and set as the new base with every
   layer scaled, as the API upscalers do (`renderer/editor/host.js` `runUpscale`, scope `document`); ESRGAN and
   UltraSharp gain the same. The node's limit is 8192 px.
3. **Not in the app itself:** the SDKs are proprietary (the app takes MIT / Apache / BSD / OFL dependencies only, and is
   GPL-3.0), and plugins are JavaScript without native addons. Through ComfyUI the licence stays out of Scumble: the
   app sends a workflow, the node and `nvidia-vfx` belong to the user's ComfyUI. The open in-app route is U3 of
   `docs/PLAN_0_1_24.md` (Real-ESRGAN and others through ONNX on DirectML).

Other users' ComfyUI sits elsewhere, or on another machine, and may lack the pack: the recipe lists
`RTXVideoSuperResolution` in `needs`, so the existing check against `/object_info` (and its offer to install through
the Manager) says so; nothing reads a ComfyUI folder. Without an RTX card the node cannot run; the recipe's note says
so. A test run on the user's ComfyUI only on the user's word (a production machine).
