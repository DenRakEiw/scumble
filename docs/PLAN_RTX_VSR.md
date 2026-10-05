# RTX Video Super Resolution as an upscaler (part of item 14; the user, 2026-10-03)

**Status (2026-10-03):** researched once, on the list of later updates (the user: "erst das dlss auf die liste
späterer updates"); nothing built.
**2026-10-04 (the user):** RTX VSR as an upscaler on both sides: "den können wir als lokalen upscaler und cloud.comfy
upscaler nutzen". **Comfy Cloud has the node** (`RTXVideoSuperResolution`, pack `comfyui_nvidia_rtx_nodes`, read
through Comfy Cloud's MCP `get_node` 2026-10-04), so a Comfy Cloud upscale recipe (LoadImage -> RTX VSR -> SaveImage
on the Comfy key) joins the local one. The API form of the dynamic combo is now known: `resize_type` ("scale by
multiplier" / "target dimensions") with dotted sub-fields `resize_type.scale` (1-4, default 2) or `resize_type.width`
/ `resize_type.height` (64-8192), and `quality` LOW / MEDIUM / HIGH / ULTRA (default ULTRA); flat sub-fields fail with
required_input_missing. The cloud side needs the detached-graph run (`comfycloud.js` buildDetached) to take an upscale
(today it runs edit and text recipes; upscale goes through the partner-node SHAPES).

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

## DLSS 5 Neural Rendering on pictures (the user, 2026-10-04: "es geht nicht um super resolution ... sondern um DLSS5")

Not super resolution: the user wants DLSS 5's neural rendering look (skin, hair, fabric, light) on a picture, ideally an
on / off switch in the Generate pane, and integrated because NVIDIA people sit in the Comfy Dev Platform Challenge's
jury. The way found by the user: the community pack `Blueforcer/ComfyUI-DLSS5-Enhancer` (MIT code, created 2026-09-02,
270 stars): nodes *DLSS5 Settings* and *DLSS5 Enhance Images* (category image/upscaling; `upscaling_mode` 1x (DLAA /
native) up to 3x, `nr_style` Default / Natural / Cinematic, `nr_intensity`, local structure / tone strengths, an
automatic skin mask and its strength, `dlss_model_preset`). It drives NGX feature 18 through a **community runtime**
(`Merserk/dlss5-visual-enhancer` release 3.0, about 467 MB: NVIDIA's proprietary DLSS libraries, ReShade, the RenoDX
DLSS 5 add-on, a worker exe that must be named `nvngx.dll`, flagged by Defender); motion vectors from optical flow,
`motion = none` for single pictures; Windows, RTX 30 / 40 / 50; on a 5090 about 4 s worker start, then ~10 frames/s.
Its own README: "Install only components you are authorised to use".

**Decided (the user, 2026-10-04):** the feature is the **Realism Pass**, labelled **"Realism Pass (Windows only, RTX
only)"** in the recipe and the UI; it is the fix for the waxy "plastic skin" of generated pictures (the user's own
tests with the pack); **no Comfy Cloud alternative** ("kein anderes comfy cloud rezept"); it is **the next feature**
(0.1.42, `docs/PLAN_0_1_42.md`). Not on Linux or a server: the pack's worker is Windows-only (D3D12, ReShade, RenoDX),
and NVIDIA's public DLSS SDK (310.9.1, 2026-09-08) has Linux libraries for Super Resolution, Ray Reconstruction and
Frame Generation only, no Neural Rendering (checked 2026-10-04); a Linux port would wait for NVIDIA (or a question to
NVIDIA, whose people sit in the Comfy challenge's jury). The pack's `install_runtime.py` default URL is broken (tag
`3.0`, the release is `v3.0`): `--url .../releases/download/v3.0/DLSS.5.Visual.Enhancer.v3.0.zip`; the runtime is
searched on every run, no ComfyUI restart needed.

Status: **installed on the user's ComfyUI by the user** (2026-10-04, the runtime through the `--url` workaround); the
user's own runs worked ("der ideale fix für das plastic skin problem"). Claude does not
download or run the runtime (an unofficial binary source); the user installs the pack and runs `install_runtime.py`
themselves. Proposed (not decided): a "post-pass" switch that sends each result through a picture-in / picture-out
workflow of the user's ComfyUI (DLSS 5 at 1x, style and intensity in a small menu), plus "DLSS 5 on the active layer"
as a new layer; hidden when the connected ComfyUI lacks the nodes. Raised with the user: in front of NVIDIA judges an
unofficial runtime around NVIDIA's libraries may read as a licence problem; the official RTX nodes are the clean
showcase; the user may ask Comfy whether a DLSS 5 integration through the pack is welcome. First step after the
user's install: one test picture without, Natural and Cinematic, on the user's ComfyUI when it is free.

## OpenDLSS-NR and the other open reimplementations: parked (the user, 2026-10-05)

The user asked whether github.com/maanHimself/OpenDLSS-NR brings DLSS 5 Neural Rendering to every system. Checked
2026-10-05, read only (the repo and its issues through `gh api`, licence texts, news; nothing cloned, built or run).
**Decided: parked until there is a cleaner way** (the user: "geparkt ... bis es eine sauberere lösung gibt").

**What it is.** MIT code only (4 commits on 2026-09-20/21, nothing since, no releases): the 71-block NR network of
build 310.8.0, once in Vulkan (GLSL and PTX kernels) and once as a WebGPU port (`ports/browser-webgpu`, ES modules and
WGSL). No weights and nothing that makes them ("Nothing in this repository produces such a directory"); everyone who
runs it extracts the 141 MiB from NVIDIA's `nvngx_dlssnr.dll` 310.8.0 (a PE resource, not encrypted). That DLL first
turned up in NBA 2K27's early-access build and is in no public NVIDIA SDK (310.9.1 has `nvngx_dlss`, `nvngx_dlssd` and
`nvngx_dlssg` only).

**Systems.**
- Vulkan: Windows and NVIDIA RTX 40 / 50 only (the device always enables NVIDIA-only extensions; FP8 E4M3; PTX for
  sm_89). Narrower than today's path, which also serves RTX 30.
- WebGPU: the only vendor-neutral part, and it would run inside Scumble's renderer (Electron 44.2 / Chromium 152 has
  WebGPU on by default on Windows and macOS; Linux needs switches). It needs `shader-f16`, 32 KB of workgroup storage
  and 512 invocations per workgroup. Measured on one RTX 4070 SUPER only (73 ms at 512 x 512, about 465 ms at
  1904 x 929); no run on AMD, Intel or Apple found. The ViT kernel's workgroup arrays cap it at about 15-16 MP, below
  the Realism Pass's 27.9 MP, and tiles change the result (the bottom stage attends over the whole picture).
- Other projects come closer to "every system": MLX-DLSS (Apple Silicon and PyTorch, a picture CLI), the
  OpenDLSS-NR-AMD fork (RDNA4), dlss-nr-on-intel (Intel Xe2), forks with a `dlss5vk image` command, taowen/dlss5-onnx
  (fixed 256 x 256, and it redistributes the weights: never link it). All of them need the same extracted weights.

**Why parked.**
- The weights: Scumble can neither ship them nor point to a source. NVIDIA's RTX SDK licence forbids reverse
  engineering and limits DLSS to NVIDIA GPUs (whether it governs the NR DLL at all is open; the game's terms forbid
  reverse engineering too; a lawyer's question). The Comfy Dev Platform Challenge's rules bar unlicensed IP, and
  NVIDIA sits on the jury.
- No upscaling: only NR is rebuilt, no DLSS-SR, so the Realism Pass Upscale cannot run on it; the presets J / K / L / M
  have no counterpart.
- Upstream's CLI has no picture command (bench, profile, parity, verify, shaderinfo); issue #3 reports almost pure red
  output from the default fused route on an RTX 4080 Laptop; the parity fixtures are not in the repo.
- What it would have given: no ComfyUI, no Defender-flagged worker, MIT code (fits GPL-3.0); the controls mostly map
  (tone, structure, skin, style and the auto-mask are network inputs; intensity and the Natural / Cinematic grade are a
  small step after it).

**What counts as cleaner.** NVIDIA's own Neural Rendering in a public SDK, under terms that allow still pictures in a
GPL-3.0 app (none yet; RTX 40 support was announced for "later this fall"), or a written yes from NVIDIA or Comfy.
Then look at the routes above again. OpenDLSS-NR loads the 310.8.0 network only and refuses any other.

**Found on the way about today's path** (the user's disk, read only, 2026-10-05):
- `custom_nodes/ComfyUI-DLSS5-Enhancer/runtime/nvngx_dlssnr.dll` is version **310.8.SF.0 and not signed**: a
  community-modified build, not NVIDIA's file; only `nvngx_dlss.dll` (310.8.0) carries NVIDIA's signature. So the
  Realism Pass already runs a modified NVIDIA binary on every card, the user's RTX 5090 included, and its worker is
  named `nvngx.dll` to pass NVIDIA's signed-caller check. `docs/MANUAL.md` (the Realism Pass's requirements: "holds
  NVIDIA's proprietary DLSS libraries") does not say that the NR library is a modified build.
- Merserk's runtime changed its licence after v3.0 (MIT then; the proprietary "Merserk Source License 1.0" since
  2026-09-17, no redistribution without permission; current release v14.0): a runtime update brings those terms.
- Before the challenge entry shows the Realism Pass, ask Comfy whether a pass on this runtime is welcome (raised before,
  more pressing now).
- RTX 40 / 30: `docs/BUGS.md` "The Realism Pass on RTX 40 and 30 is not proven to change pixels".
