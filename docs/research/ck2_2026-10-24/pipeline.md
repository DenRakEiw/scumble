# pipeline

## Summary

CorridorKey 2.0 lives in its own repo, nikopueringer/CorridorKey2.0 (code made public 2026-10-13, commit 485f5e9, Python and PyTorch, CUDA only). The v1 repo nikopueringer/CorridorKey is GreenFormer only.

For one still, v2 needs all four model sets. Three are frozen feature models, all fed at /64 of the picture: C-RADIOv4-SO400M (1.72 GB), MoGe-2 ViT-B (0.42 GB, encoder only) and RVM. RVM here is Google DeepMind's Recurrent Video MAE, not Robust Video Matting (0.27 GB; on a still it runs once from a zero state). The fourth is CK2 itself: 665M parameters, 2.66 GB fp32, run under bf16 autocast. About 5.1 GB in all; nothing is gated.

What goes in and comes out:
- Input: display sRGB in [0,1], or scene-linear EXR. Internally it is converted to linear and then to a signed asinh code.
- Hint: optional. One channel in [0,1], with a trust value. Without a hint, quality is set to -1 and the model picks the subject.
- Output: alpha in [0,1] plus a straight, unpremultiplied foreground in scene-linear (unclamped). The official render adds a cutout (straight RGBA) and a checker preview.
- Resolution: always native. The picture is reflect-padded to multiples of 128, with no tiling. A non-native model_scale raises at render time.

The hint enters at the very first layer: a 4-channel patchify of RGB plus hint, and AdaLN in the first two blocks. So any hint change re-runs all of stage 1 and stage 2. Only the three feature models can be cached. On the Mac port's 1536x1024 still they are about 8% of 1.7 to 2.1 s; stage 2 is about 50 to 55%.

The official repo has no live-hint code. My estimate is 0.1 s or less per hint at about 1.5 MP on a fast RTX, about 0.5 s at 4K, and minutes at 15k. The quadratic full-spatial attention at /16 dominates.

There is no official ONNX export. A community one exists (Nucito/corridorkey-web): fp16, split into five graphs, static shape buckets up to 1024 px, aimed at the browser. v1 is far simpler for in-app use: one 4-channel graph, with ONNX fp16 at 512 to 2048 px already exported. But v1 squashes the whole frame to 2048x2048 and needs a hint.

## Report

# CorridorKey v2 (CK2.0) pipeline, read from source (2026-10-24)

Clones (read only, nothing run):
- v1: `C:\Users\SCHOEN~1\AppData\Local\Temp\claude\F--canvas\543d44fb-4d2d-4818-8804-974916d10a44\scratchpad\ck_pipeline\repo` = nikopueringer/CorridorKey @ `97e55a4` (2026-05-28)
- v2: `C:\Users\SCHOEN~1\AppData\Local\Temp\claude\F--canvas\543d44fb-4d2d-4818-8804-974916d10a44\scratchpad\ck_pipeline\repo_v2` = nikopueringer/CorridorKey2.0 @ `485f5e9` (2026-10-15)
- Metadata I fetched: `...\ck_pipeline\meta\` (the CK2 safetensors **header only**, 81,768 bytes by an HTTP range request; the C-RADIO config; the Nucito manifest). No model was downloaded.

Below, "v2:file:line" means the v2 clone and "v1:file:line" the v1 clone. Each fact is tagged [read], [inferred] or [unverified].

## Corrections to what CLAUDE.md item 49 says (F:\canvas\CLAUDE.md:667-685)

- **v2 is not in the v1 repo.** It lives in its own repo, nikopueringer/CorridorKey2.0. The GitHub API says that repo was created 2026-07-15, but its first commit "CorridorKey 2.0" (`2648125`) and the Hugging Face model are dated **2026-10-13**. So the public release was October 2026, not July. [read: gh api commits; HF createdAt 2026-10-13T00:37:33Z]
- **"RVM" in v2 is Google DeepMind's *Recurrent Video MAE*** (representations4d), a video feature model. It is not Robust Video Matting. [read: v2:THIRD_PARTY_NOTICES.md:43-50; v2:corridorkey/rvm.py:1-29]
- The "about 5 GB" figure is right: 2.66 + 1.72 + 0.42 + 0.27 GB, about 5.08 GB. [read: HF / GCS sizes]
- "RTX 30 or newer" matches the README (v2:README.md:21). corridorkey.com lists RTX 20 as "beta". [read]
- The hint is optional, as item 49 says. [read]

## 1. Layout, entry points, config, versions

**v1** (branch `main`, no tags):
- `CorridorKeyModule/inference_engine.py` (`CorridorKeyEngine`), `core/model_transformer.py` (`GreenFormer`), `backend.py`
- `clip_manager.py` (wizard / run_inference), `corridorkey_cli.py`
- Optional hint generators: `gvm_core/`, `VideoMaMaInferenceModule/`, `BiRefNetModule/`
- `pyproject.toml` + `uv.lock` (uv), Dockerfile, install `.bat` / `.sh`, `docs/LLM_HANDOVER.md`

[read: file listing; v1:README.md:49-94]

**v2** (branches `master`, `docs/zac-credit`; no tags, no releases):
- Package `corridorkey/`:
  - `model.py`: `CorridorKeyV3`, exported as `CorridorKeyV2` in `__init__.py`
  - `stage1.py`, `stage2.py`, `blocks.py` (3.2k lines)
  - `foundations.py`, `rvm.py`, `rope.py`
  - `runtime.py` (the orchestration), `video_io.py`, `color_utils.py`
- Entry points:
  - `infer.py`, the CLI (v2:infer.py:46-178)
  - `run_interactive.py`, a terminal wizard with prompts only (no GUI)
  - `CorridorKey_DRAG_CLIPS_HERE.bat` / `.sh`
  - `scripts/download_weights.py`, `scripts/convert_to_safetensors.py`, `scripts/smoke_test_runtime.py`
- `third_party/MoGe` is vendored (MIT; includes DINOv2, Apache-2.0).
- `requirements.txt` (pip): numpy<2, opencv, transformers>=4.57,<5, timm>=1.0, safetensors, huggingface-hub, einops, scipy, pillow. Also `utils3d` installed from a pinned GitHub commit, so pip needs git. (v2:requirements.txt:1-11)

[read]

**Python API:**
- `RuntimePaths.from_package(root)` (v2:corridorkey/runtime.py:69-82)
- `load_model(paths, device="cuda")` (runtime.py:238-265)
- `run_inference(model, input, output_dir, InferenceConfig, WriterConfig, initial_hint_path=, hint_video_path=)` (runtime.py:733)
- Lower level: `model.foundations(...)`, `model.stage1(...)`, `model.stage2(rgb, baton)`.

[read]

**Config:** there is no config file. The architecture is stored in the safetensors header (`__metadata__.model_config`):
- d_16 512, d_64 1536, d_stage2 1280
- n_body_64 10, n_dec_16 6, stage2 10 blocks
- use_cradio true, rvm small

Header metadata: format `corridorkey_v2_runtime_checkpoint` v1, `public_model_name` "CorridorKey v2", `pre_recurrence` true, `shape_quantum` 128, `required_vfms` [C-RADIOv4-SO400M, MoGe-2-ViT-B, RVM-small]. Runtime knobs live in the `InferenceConfig` dataclass (runtime.py:98-129). [read: header + code]

## 2. Inference path for one still

**How a still gets in.** `infer.py` takes a video or a **frame directory**. A folder holding one PNG/JPG/EXR is a one-frame clip:
- `window_starts(1, chunk, stride)` returns `[0]` (v2:video_io.py:582-588).
- The Hann taper of a single window is all ones (video_io.py:591-604).
- RVM starts from a zero state (rvm.py:375-376).
- The MLX port runs stills through the same "single-frame path" (corridorkey-v2-mlx docs/BENCHMARKS.md).

[read; the one-frame folder path itself is inferred]

**Inputs:**
- **RGB.** The colour handling differs by input type:
  - PNG/JPG are read with `cv2.IMREAD_COLOR` and divided by 255 (v2:video_io.py:138-141). So a 16-bit PNG arrives as 8-bit [inferred from OpenCV semantics].
  - Frame folders are treated as display-coded sRGB. EXR with `--frame_dir_linear` is passed as scene-linear (README:509-532; video_io.py:247-255).
  - The model branch converts sRGB to linear (IEC piecewise), then applies the signed asinh code `asinh(x/0.008)/asinh(16/0.008)` (color_utils.py:4-5, 98-128; video_io.py:323-338).
  - The three feature models get an SDR proxy RGB in [0,1] (README:530-532).
  - No OCIO and no metadata-driven colour handling (README:534-541).
- **Hint.** One channel in [0,1]; white = subject.
  - Accepted as uint8, uint16 or float.
  - A 4-channel image gives its alpha channel; a 3-channel image gives channel 0, which is **B** in OpenCV's BGR order (video_io.py:144-156).
  - It must match the native size (or the model size), otherwise it is an error (video_io.py:479-499).
  - It is resized with Lanczos, center-padded and stored as bf16.
- **Hint quality.** The `hint_quality` scalar per frame goes through AdaLN:
  - 0.95 default (clean matte); 0.75 rough; 0.5 or less loose.
  - **No hint:** the hint is all zeros and quality is -1, meaning "the model decides the subject" (runtime.py:485-502; stage1.py:712-728, 741; README:99-115, 188-215).
  - There is no separate garbage or core matte input; any matte goes in as the hint (README:153-154). [read]

**Working resolution:**
- Native only. The frame is reflect-101 padded at the center to a multiple of **128** (runtime.py:105; video_io.py:103-112, 184-206); the model itself asserts multiples of 64 (model.py:207).
- `--model_scale` exists in the CLI, but the render raises for anything but 1.0 (runtime.py:587-592; infer.py:82-83). There is **no tiling and no maximum** in the code.
- The VRAM table is measured only up to **8.36 MP** and extrapolated linearly beyond that (runtime.py:132-170).
- C-RADIO is documented as "tested on input resolutions ranging from 256 to 2048" (HF model card). CK2 feeds it H/4, so pictures above about 8192 px on a side go past that (cpe_max_size 2048 in its config.json).

[read; the >8192 px consequence is inferred]

**Outputs** (model.py:13-22; runtime.py:642-730):
- Stage-2 `logits` with 4 channels: channel 0 is alpha (clamped to [0,1] at render), channels 1-3 are the foreground in the asinh code. Decoding gives **straight (unpremultiplied) scene-linear** colour that may exceed 1 or go negative.
- Stage 1 also gives `alpha_aux` / `fg_aux` at **/2** resolution.
- Rendered outputs:
  - `alpha`
  - `fg`: 16-bit sRGB on the video path, float linear in EXR
  - `cutout`: straight RGB + alpha, despilled; sRGB, or linear with `--cutout_linear`
  - `checker`
- The README says the cutout is "foreground multiplied by alpha", but the code writes straight RGB beside alpha (runtime.py:712-719). [read]
- **Despill** is a fixed green-limit formula, `g - (r+b)/2`, even for blue screens (runtime.py:604-614). [read]
- EXR output is half or float (README:316-354). The network's precision bounds accuracy to about 1-2 % relative error (README:351-354). [read]

## 3. The components

| Part | What it does | Input fed | Output to stage 1 | Size | Needed for a still |
|---|---|---|---|---|---|
| CK2 stage 1 | 4-ch patchify at /16 (RGB + hint, kernel 32, stride 16) → 2 full-spatial blocks at /16 with hint-quality AdaLN → downsample to /64 → fuse with features → 10 full spatio-temporal blocks at /64 (d=1536) with a /16 Swin detour → up to /16 → 6 Swin/CSwin blocks → **baton** (d=512 at /16), aux head at /2 | asinh RGB + hint | n/a | 463.6 M params | yes |
| CK2 stage 2 | baton + RGB patchify at /16 (d=1280): 8 blocks (2 full-spatial, 2 CSwin, 4 Swin), a gated late RGB skip, 2 Swin, depatchify ×16 → 4-ch logits at /1. **No hint input.** | asinh RGB + baton | n/a | 201.8 M params | yes |
| CK2 weights file | `corridorkey_v2.safetensors` (738 tensors, all **F32**) + `foundation_stats.safetensors` (feature mean/std) | | | 2,661,698,720 B + 18,864 B | yes |
| C-RADIOv4-SO400M (NVIDIA) | frozen semantic features (teachers: SigLIP2-g, DINOv3-7B, SAM3) | RGB [0,1] at H/4, patch 16 | 1152 ch at /64 | 431 M params; `model.safetensors` 1,724,986,512 B (fp32); the `_half.pth.tar` (1,205,920,113 B) is skipped | yes |
| MoGe-2 ViT-B normal (Microsoft) | frozen geometry features; **encoder only** | RGB at 7H/32, patch 14 | 768 ch at /64 | `model.pt` 419,110,160 B | yes |
| RVM small (DeepMind) | frozen recurrent video features (ViT-S + GRU-gated cross-attention state) | RGB [0,1] at H/4, bilinear, patch 16 | 384 ch at /64 + state | npz 270,086,372 B (67 M params; the port uses the 33 M encoder + rnn core) | yes; on a still it runs once from a zero state |

Sources:
- Stage 1: stage1.py:1-30, 340-376, 730-920
- Stage 2: stage2.py:1-25, 469-532
- Parameter split: from the header [read]
- Feature models: foundations.py:85-103, 160-162, 242-294; rvm.py:1-56, 352-382; runtime.py:283-292, 303-344
- Sizes: HF API / GCS HEAD
- Feature dims: logged in PR #7 (`cradio=1152, moge=768, rvm=384`)

**Why all three feature models are needed:**
- `RuntimePaths.validate` refuses to start when any asset is missing (runtime.py:84-95).
- Stage 1 asserts `rvm_feat` when `rvm_dim>0` (stage1.py:795-803).
- The fusion layer is sized for 2304 feature channels + 512 aux.

[read] Leaving one out would need zero-filled features, which is out of distribution [inferred]. Under CK2's frame-window ("Hann") mode, the parts that exist only for video are the multi-frame Hann window, the carry hint and RVM's state carry (runtime.py:538-549, 852-856). [read]

## 4. The "real-time alpha hint"

- **The official repo has no live or interactive hint code.** `run_interactive.py` is a text wizard; GUI PRs #5 (closed) and #8 (open) only shell out to `infer.py`. [read]
- **What re-runs when only the hint changes:**
  - The hint enters at the first layer, the stem patchify of RGB+hint (stage1.py:340-346, 755-758), and the AdaLN of the first two encoder blocks (stage1.py:365-376).
  - So **all of stage 1** re-runs. Stage 2 depends on the baton, so it re-runs too.
  - The **three feature models are hint-independent**: they are computed from the display RGB alone (runtime.py:512-521) and can be cached per picture (/64 grid, 2304 channels).
  - The official runtime already caches them to memmaps in low-VRAM mode (runtime.py:347-401). [read]
- **Measured split** (MLX port, M4 Pro, 1536×1024 still, fp32, optimised kernels; corridorkey-v2-mlx benchmarks/cli/summary.json):

  | Part | Time |
  |---|---|
  | RVM | about 0.02 s |
  | C-RADIO + MoGe | about 0.11-0.12 s |
  | Stage 1 | about 0.34 s |
  | Stage 2 | about 0.81-0.85 s |
  | Total | 1.7 s |

  So caching the features saves only about 8 %. [read]
- **Cheaper preview** [inferred]: stage 1's `alpha_aux` at /2 (it is already used as the carry hint, runtime.py:538-545) could serve as a fast preview while a stroke is going on, with stage 2 run when the stroke ends. Stage 1 is about 30 % of the still's time on M4 Pro.
- **Cost per hint change** [inferred, my FLOP count from the header's parameter split plus attention terms; T=1]:

  | Still | Stage 1+2 | Of which attention | Feature models |
  |---|---|---|---|
  | 1920×1080 | about 6 TFLOP | 1.2 | 0.6 |
  | 3840×2160 | about 34 TFLOP | 16 | 3 |
  | 6000×4000 | about 190 TFLOP | 137 | 13 |
  | 8192×5464 | about 550 TFLOP | 455 | 34 |
  | 15000×10000 | about 5,500 TFLOP | 5,200 | 290 |

  The quadratic full-spatial attention at /16 dominates large stills: 2 blocks at d=512 in stage 1 and 2 at d=1280 in stage 2 (blocks.py:2388-2462; stage2.py:114-124).
  - On a 4090-class card at about 50-80 effective bf16 TFLOPS that means:
    - about 0.1 s at 1080p
    - about 0.5 s at 4K
    - a few seconds at 24 MP
    - one to two minutes at 150 MP
  - So it can look "real time" at video sizes, but not at Scumble's 15k. [inferred]
- Whatever Neex meant by "real time" (the paid plugin, or simply this speed) is not visible in any public code. [unverified]

## 5. Runtime requirements

- **Precision:** weights are stored fp32; every pass runs under `torch.autocast("cuda", bfloat16)` (runtime.py:337, 386, 515, 531, 886; README:351-354).
  - Plain PyTorch SDPA everywhere. No flash-attn package, no xformers, no `torch.compile`, no TensorRT and no ONNX in the official code. [read: grep]
  - The RTX 30 requirement is presumably about native bf16 (Ampere and newer) [inferred].
  - PR #10 chose bf16 on MPS "to avoid FP16 overflow with scene-linear HDR inputs" [read: PR text].
- **Versions:**
  - Tested torch 2.9.1 / torchvision 0.24.1, cu128 (README:24-38).
  - On torch 2.14, `rms_norm` returns fp32 under autocast and the low-VRAM path crashes until PR #6 (open) [read: PRs #6, #11].
  - Python is not pinned. Reported working: 3.11 (PR #8), 3.14 (PRs #9, #11). [read]
- **Devices:**
  - `infer.py` refuses to run without CUDA (infer.py:120-121), and ffmpeg is required even for EXR output (infer.py:122).
  - CPU: no path; autocast is hard-wired to "cuda" [inferred].
  - AMD: ROCm on Linux only through unmerged PRs #6 / #7, reported on RX 9070 XT and Radeon 8060S [read]. No DirectML.
  - Mac: through the MLX port (peterteravskis/corridorkey-v2-mlx, Apache-2.0 code, fp32 / fp16 / Q8 weights at cdelta/CorridorKey-v2-MLX-*) and PR #10 (MPS, open). [read]
  - OS: Windows `.bat` and Linux `.sh` launchers; PR #8 tested Windows 11 + RTX 3080. [read]
- **VRAM:**
  - README table: 4 GB / 6 GB / 8 GB … by resolution, auto-chosen windows and low-VRAM mode (README:401-425).
  - Measured peaks (runtime.py:134-147), low-VRAM mode with a 1-frame window: 2.71 GiB at 0.98 MP, 3.25 GiB at 8.36 MP. Normal mode at 8 frames: 6.19-13.94 GiB.
  - PR #9 (open): storing Linear/Conv weights in bf16 cuts resident weights from 4.65 to 2.39 GiB with bit-identical output. [read]
- **Reported timings:**
  - RTX 5090, 94 frames at 2048×1152, low-VRAM window 80: 47 s (PR #11).
  - RTX 3080, 48 frames at 640×360 through a GUI: about 30 s (PR #8).
  - M4 Pro MLX, 1536×1024 still: 1.7-2.1 s warm (above).

  [read]

## 6. Weight hosting

None of these is gated. [read: HF API]

| Repo / URL | Files | Licence |
|---|---|---|
| `nikopueringer/CorridorKey2.0` (sha cf44a8d, 2026-10-13) | `corridorkey_v2.safetensors` 2,661,698,720 B; `foundation_stats.safetensors` 18,864 B; `LICENSE` 26,650 B | other "corridor-key-licence-2.0" |
| `nvidia/C-RADIOv4-SO400M` @ pinned `c0457f5` (download_weights.py:80-81) | snapshot including remote-code .py files | NVIDIA Open Model License |
| `Ruicheng/moge-2-vitb-normal` @ pinned `ca5f0e0` | `model.pt` | MIT |
| `https://storage.googleapis.com/representations4d/checkpoints/pretrain_rvm_small16_256_204031069.npz` (md5 pinned, download_weights.py:86-88) | npz | CC-BY 4.0 weights, Apache-2.0 code (THIRD_PARTY_NOTICES) |
| v1: `nikopueringer/CorridorKey_v1.0`, `nikopueringer/CorridorKeyBlue_1.0` | .pth 401,406,656 B; .safetensors 398,849,256 B (each) | cc-by-nc-sa-4.0 |

**CK2 licence additional terms** (v2:LICENSE:27-114):
- 1a: any lawful use, including commercial image work.
- 2a: no repackaging or resale.
- 2b: no paid API.
- 2c: released derivatives "must be made available to the public free of charge".
- 2d: a commercial software package needs a written agreement.
- 3: organisations above US$20M revenue need seats.
- 4: keep the "CorridorKey" name.
- 5: share-alike under the same licence.
- 6: third-party parts keep their own licences.

[read]

## 7. Export, ONNX, issues

- **Official v2:** no export code. 12 issues/PRs total; nothing about ONNX, stills or Windows-specific problems.
  - Issue #2 (closed) argued against a CC licence for code.
  - Open PRs: #3 (Python requirements), #4 (natural-sort frame order), #6 / #7 (AMD), #8 (GUI), #9 (VRAM), #10 (MPS), #11 (auto-VRAM out-of-memory fix).
  - The repo has no Discussions.

  [read]
- **Community CK2 ONNX:** `Nucito/corridorkey-web` on HF (2026-10-23), "ONNX fp16 for ONNX Runtime Web (WebGPU)".
  - Five components with external weights: cradio 862 MB, moge 176 MB, rvm 66 MB, stage1 924 MB, stage2 404 MB.
  - Graphs have static shapes for 18 buckets from 384² up to **1024×1024**; stage 1 at t1, plus t8 for 8 small buckets.
  - Inputs: stage1 = `rgb, hint, hint_quality, moge, cradio, rvm` → `baton, aux`; stage2 = `rgb, baton` → `logits`; rvm = `frame, state` → `feat, new_state`.
  - Claimed "alpha max |diff| ≈ 0.002" against fp32.
  - Licence tag "corridorkey-license".

  [read: HF API + manifest.json; the accuracy claim is unverified] This split shows the export can be cut exactly at the hint boundary (cache the cradio / moge / rvm features, re-run stage1+stage2) [inferred].
  - Native-resolution graphs above 1024 px do not exist there.
  - fp16 (not bf16) under DirectML is untested. [unverified]
- **Other CK2 ports:**
  - ComfyUI: marawan206/ComfyUI-CorridorKey2.0, hashu786/ComfyUI-CorridorKey2 (the latter vendors upstream `485f5e9` unmodified, IMAGE + MASK → fg / matte / processed / QC / cutout).
  - OBS: DeFlanko (near real time with lookahead delay), sneakyjoeru.
  - Browser: CorridorKeyWeb.github.io, a single HTML file that claims in-browser safetensors loading.

  [read: READMEs; whether they work is unverified]
- **v1 export:**
  - `alexandrealvaro/CorridorKey` (HF, cc-by-nc-sa-4.0): ONNX fp16 static at 512 / 1024 / 1536 / 2048 (145-200 MB), TensorRT context caches, INT8 at 512 / 768 / 1024 (79-101 MB), Torch-TensorRT engines, MLX.
  - The exporter (CorridorKey-Runtime tools/model_exporter/export_onnx.py) uses opset 16, input `input_rgb_hint` [1,4,S,S], outputs `alpha`, `fg`, and interpolates the position embedding per resolution.
  - CorridorKey-Runtime (CC BY-NC-SA, last push 2026-08-05, so v1 only) ships a "DirectML package" described as "not broadly validated".
  - v1 PR #250: FP32 ONNX at 512 on an x86 CPU takes about 3.5 s per frame.
  - KennyLowe/CorridorKey-OBS: v1 TensorRT, about 26 ms per frame at 1024×576 on an RTX 3060.

  [read]
- v1 issue #214 asks for image support (open); one commenter has a private Photoshop plugin for stills larger than 2048. [read]

## 8. v1 (GreenFormer) for comparison

- **Network:** Hiera Base+ (`hiera_base_plus_224.mae_in1k_ft_in1k`, timm) with the first conv patched to 4 input channels, an MLP decoder head, and a CNN refiner (7 ch in: RGB + coarse alpha/fg; 64 hidden; dilated residual blocks) that adds logit deltas. Sigmoid outputs: `alpha` and `fg` in [0,1], fg being straight sRGB. (v1:CorridorKeyModule/core/model_transformer.py:99-297)
- **Preprocessing:** the **whole frame is resized to 2048×2048** (bilinear, aspect not kept), then ImageNet-normalised sRGB is joined with the hint as a 4th channel. Output is Lanczos4-resized back to native size. (v1:inference_engine.py:216-243, 245-263)
- **Hint:** required ("requires two inputs", v1:README.md:97-99).
- **Checkpoints:** separate green and blue, about 99.7 M params (398.8 MB fp32) [inferred from file size].
- **Runtime:** fp16 autocast, optional torch.compile (inference_engine.py:53-110, 177-208).
- **Compared with v2:** one graph and one input tensor, ONNX already available, about 145-200 MB fp16. That is much simpler to run in-app on Scumble's onnxruntime-node 1.29 (F:\canvas\package.json:38; DirectML on Windows, F:\canvas\electron\main\onnx\runtime.js:20).
  - Scumble has documented DirectML trouble before: LaMa MatMul (F:\canvas\electron\main\onnx\lama.js:11), BiRefNet memory (F:\canvas\electron\main\onnx\matting.js:24). So v1 at 2048² under DirectML still needs a test.
  - Quality cost: no native resolution (2048² squash), no hint-free mode, no temporal or HDR path. v2 in-app would mean five graphs, about 2.4 GB fp16 and native-size dynamic shapes; nothing public covers that above 1024 px.

  [inferred]


## Facts

- [read] CorridorKey 2.0 lives in a separate repo nikopueringer/CorridorKey2.0 (default branch master, no tags or releases); v1 repo nikopueringer/CorridorKey contains only GreenFormer (last commit 97e55a4, 2026-05-28). (gh api repos/nikopueringer/CorridorKey2.0 (+/branches,/tags,/releases); clone repo_v2 @485f5e9; clone repo @97e55a4)
- [read] CK2 was made public on 2026-10-13 (first commit 2648125 'CorridorKey 2.0', HF model createdAt 2026-10-13); the GitHub repo object was created 2026-07-15. (gh api repos/nikopueringer/CorridorKey2.0/commits; HF API nikopueringer/CorridorKey2.0 createdAt)
- [read] RVM in CK2 is Google DeepMind's Recurrent Video MAE (representations4d), not Robust Video Matting; a PyTorch port of the representation path (33M of 67M params) with GRU-gated recurrent state. (v2:THIRD_PARTY_NOTICES.md:43-50; v2:corridorkey/rvm.py:1-56)
- [read] CK2 own weights: corridorkey_v2.safetensors 2,661,698,720 bytes, 738 tensors all F32, 665.4M params (stage1 463.6M, stage2 201.8M), plus foundation_stats.safetensors 18,864 bytes; not gated. (HF API nikopueringer/CorridorKey2.0?blobs=true; safetensors header read by range request)
- [read] Foundation models: C-RADIOv4-SO400M model.safetensors 1,724,986,512 B (431M params, NVIDIA Open Model License, pinned c0457f5), MoGe-2 ViT-B normal model.pt 419,110,160 B (MIT, pinned ca5f0e0), RVM small npz 270,086,372 B from storage.googleapis.com (CC-BY 4.0, md5 pinned). (v2:scripts/download_weights.py:77-88; HF API; GCS HEAD; v2:THIRD_PARTY_NOTICES.md)
- [read] All three foundation models are required even for a single still: validate() refuses missing assets and Stage1 asserts rvm_feat when rvm_dim>0; feature dims cradio 1152, moge 768, rvm 384 at the /64 grid. (v2:corridorkey/runtime.py:84-95; v2:corridorkey/stage1.py:785-803; PR #7 log)
- [read] The hint enters stage 1 at the very first layer (4-channel RGB+hint patchify) and as hint_quality AdaLN in the first two /16 encoder blocks; stage 2 takes only rgb and baton; the foundation features are computed from display RGB only, so a hint change re-runs stage 1 and stage 2 while C-RADIO/MoGe/RVM features can be cached. (v2:corridorkey/stage1.py:340-376, 754-758; v2:corridorkey/stage2.py:469-492; v2:corridorkey/runtime.py:512-536)
- [read] No hint is valid: the hint becomes zeros and hint_quality -1, meaning the model decides the subject; hint_quality default 0.95, range clamped to [-1,1]. (v2:corridorkey/runtime.py:485-502; v2:corridorkey/stage1.py:712-728; v2:README.md:99-115,188-215)
- [read] Input colour: display-coded RGB [0,1] is converted sRGB to linear then to a signed asinh code (knee 0.008, ref 16) for the model; foundation models get SDR RGB [0,1]; linear EXR is supported with --frame_dir_linear; no OCIO or metadata handling. (v2:corridorkey/color_utils.py:4-5,98-138; v2:corridorkey/video_io.py:247-255,323-338; v2:README.md:509-541)
- [inferred] PNG/JPG frames are read with cv2.IMREAD_COLOR and divided by 255, so 16-bit PNG input is reduced to 8-bit. (v2:corridorkey/video_io.py:126-141)
- [read] Outputs: alpha clamped [0,1] and foreground decoded from asinh to straight (unpremultiplied) scene-linear RGB that may exceed 1; stage 1 also yields alpha_aux/fg_aux at /2; rendered outputs alpha, fg, cutout (straight RGB + alpha, despilled), checker. (v2:corridorkey/model.py:13-22; v2:corridorkey/runtime.py:642-730)
- [read] The runtime's despill is a fixed green-limit formula g-(r+b)/2 applied regardless of screen colour. (v2:corridorkey/runtime.py:604-614)
- [read] Working resolution is always native: reflect-101 center padding to multiples of 128, no tiling, no maximum; model_scale other than 1.0 raises at render. (v2:corridorkey/runtime.py:105,581-592; v2:corridorkey/video_io.py:103-112,184-206; v2:corridorkey/model.py:207)
- [read] The VRAM peak table is measured only up to 8.36 MP (low-VRAM 1-frame window: 2.71 GiB at 0.98 MP, 3.25 GiB at 8.36 MP) and extrapolated linearly beyond. (v2:corridorkey/runtime.py:132-170)
- [inferred] C-RADIOv4 is documented as tested on 256-2048 px inputs; CK2 feeds it H/4, so stills above about 8192 px per side exceed the tested range. (HF nvidia/C-RADIOv4-SO400M README and config.json (max_resolution 2048, cpe_max_size 2048); v2:corridorkey/runtime.py:283-292)
- [read] Inference runs under torch.autocast('cuda', bfloat16) with plain PyTorch SDPA; no flash-attn package, torch.compile, TensorRT or ONNX in the official v2 code; infer.py requires CUDA and ffmpeg. (v2:corridorkey/runtime.py:337,386,515,531,886; v2:corridorkey/blocks.py (grep); v2:infer.py:120-122; v2:README.md:351-354)
- [read] Tested with torch 2.9.1/torchvision 0.24.1 cu128; on torch 2.14 the low-VRAM path crashes with a dtype error until PR #6 (open). (v2:README.md:24-38; PRs #6, #11)
- [read] AMD runs only via unmerged ROCm PRs on Linux (#6, #7); Apple via the MLX port peterteravskis/corridorkey-v2-mlx and open MPS PR #10; no CPU or DirectML path. (gh api pulls 6,7,10; corridorkey-v2-mlx README)
- [read] MLX port on an M4 Pro, 1536x1024 still, fp32 with its optimised kernels enabled: RVM about 0.02 s, foundations about 0.11-0.12 s, stage1 about 0.34 s, stage2 about 0.81-0.85 s, total about 1.7 s (2.1 s with reference kernels). (github peterteravskis/corridorkey-v2-mlx benchmarks/cli/summary.json and docs/BENCHMARKS.md)
- [inferred] Caching the hint-independent foundation features saves under 10% of a still's time; full-spatial attention at /16 makes stage 1+2 cost roughly 6 TFLOP at 1080p, 34 at 4K, 550 at 8192x5464 and about 5,500 at 15000x10000. (own FLOP estimate from the header parameter split and v2:corridorkey/stage1.py, stage2.py, blocks.py:2388-2462)
- [read] There is no live or interactive hint GUI in the official CK2 repo; run_interactive.py is a terminal wizard and the GUI PRs #5/#8 shell out to infer.py. (v2:run_interactive.py (grep); gh api pulls 5, 8)
- [read] A community CK2 ONNX fp16 export exists (Nucito/corridorkey-web, 2026-10-23): five components (cradio 862 MB, moge 176 MB, rvm 66 MB, stage1 924 MB, stage2 404 MB weights), static graphs in 18 buckets up to 1024x1024, stage1 inputs rgb/hint/hint_quality/moge/cradio/rvm, aimed at ONNX Runtime Web WebGPU. (HF API Nucito/corridorkey-web; its manifest.json and README.md)
- [unverified] The Nucito export's fp16 accuracy (alpha max diff about 0.002 against fp32) is claimed by its author, not checked. (HF Nucito/corridorkey-web README.md)
- [read] v1 ONNX exists: alexandrealvaro/CorridorKey hosts fp16 static ONNX at 512/1024/1536/2048 (about 145-200 MB), TensorRT ctx caches, INT8 at 512/768/1024; input 'input_rgb_hint' [1,4,S,S], outputs alpha, fg, opset 16. (HF API alexandrealvaro/CorridorKey; github alexandremendoncaalvaro/CorridorKey-Runtime tools/model_exporter/export_onnx.py)
- [read] v1 resizes the whole frame to 2048x2048 (bilinear, aspect not kept), uses ImageNet-normalised sRGB + hint as 4 channels, requires a hint, outputs sigmoid alpha and straight sRGB fg, and Lanczos4-resizes back. (v1:CorridorKeyModule/inference_engine.py:216-263; v1:CorridorKeyModule/core/model_transformer.py:242-297; v1:README.md:97-99)
- [read] CK2 licence: any lawful use incl. commercial image work; no resale/repackaging; no paid API; released derivatives must be free of charge, same licence, keep the CorridorKey name; commercial software packages need a written agreement; organisations above US$20M revenue need seats. (v2:LICENSE:27-114; HF nikopueringer/CorridorKey2.0 README)
- [read] PR #9 (open) stores Linear/Conv weights in bf16 and cuts resident weights from 4.65 to 2.39 GiB with bit-identical output. (gh api repos/nikopueringer/CorridorKey2.0/pulls/9)
- [read] Scumble's in-app runtime is onnxruntime-node ^1.29 with DirectML on Windows, with documented DirectML problems for LaMa and BiRefNet. (F:\canvas\package.json:38; F:\canvas\electron\main\onnx\runtime.js:20; F:\canvas\electron\main\onnx\lama.js:11; F:\canvas\electron\main\onnx\matting.js:24)

## Open questions

- What did Neex mean by 'the alpha hint works in real time': the paid plugin (corridorkey.com, closed source as far as public repos show), or the model's speed at video resolutions? Worth asking in the reply.
- Is CK2 validated on stills above 4K, or above about 8192 px where C-RADIO's input passes its tested 2048 px? Should Scumble cap the input (downscale, key, upscale alpha/fg) and at what size? Worth asking Corridor.
- Is a native-resolution (dynamic-shape) ONNX export of stage1/stage2 feasible? Full-spatial attention at /16, region-id masks and index_copy have not been tried through torch.onnx; and do fp16 graphs run correctly under DirectML in onnxruntime-node 1.29? (PR #10 chose bf16 on MPS because fp16 overflowed on HDR inputs.)
- Would Corridor consider Scumble's planned use (a free GPL-3.0 app that downloads the weights at runtime and runs them in-app or via the user's ComfyUI) covered by Neex's 'as long as the software is free' answer, given LICENSE 2d (commercial software integration) and 5 (share-alike) and the paid Microsoft Store listing of a free app? This is for the licence angle, not settled by the code.
- Does the green-only despill formula matter for blue screens in practice, i.e. does Scumble apply its own despill to the straight fg?
- Is v1 (squashes the frame to 2048x2048, needs a hint, ready ONNX) good enough for stills as a quick in-app path while v2 goes through ComfyUI or a Python helper? Needs a quality comparison on the user's material.
