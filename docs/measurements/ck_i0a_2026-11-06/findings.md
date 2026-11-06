# I0a: the code check of pack A (marawan206/ComfyUI-CorridorKey2.0), 2026-11-06

Read only; nothing installed; the user's ComfyUI untouched. Clones beside this file: packA/, upstream/, exA (eeee7fa),
exN (c7662de), exU (upstream 485f5e9), cradio_code/. Line numbers at eeee7fa unless marked c7662de.

**Recommended commit: c7662de** (main's HEAD, 2026-11-02), pinned by SHA. Since eeee7fa: 1be825e (the auto window mirrors
upstream, an MPS path with an fp32 fallback, a Load Image Sequence node, a linear composite, workflows, a parity test)
and c7662de (`corridorkey/blocks.py:71, 92` cast rms_norm back to the input dtype, equal to upstream PR #6, open). No
safety-relevant change; requirements unchanged; on torch 2.10 / CUDA a still keys exactly as at eeee7fa. The new read-only
Load Image Sequence node reads any absolute folder path (the server listens on 127.0.0.1 only).

**Verdict: safe to install as is.** Keep it pinned (no Manager "Update All" on it); send auto_download false.

1. Repo: created 2026-10-22; 3 stars, 0 forks, 1 issue (closed); branch `improvements` = main.
2. Network: only in Load Model's execute (`nodes/model_nodes.py:56-64`); pinned revisions `ck_comfy/download.py:33-41`
   (CK2 cf44a8db = HF main today, C-RADIO c0457f5d, MoGe ca5f0e07); HF at `download.py:193-197, 237-241, 248-249`
   (the stored HF token to huggingface.co only); GCS RVM with MD5, resume, 60 s timeout `download.py:43-46, 125-169`.
   Vendored but unreached: MoGe utils/download.py, webfile.py, webzipfile.py; DINOv2 torch.hub
   (`moge/model/dinov2/hub/backbones.py:55-58`) not reached (`moge/model/modules.py:86` pretrained=False). No telemetry,
   no update check.
3. subprocess: vendored, never called (`corridorkey/video_io.py:662` the ffmpeg writer; the pack imports only
   taper_weights and window_starts, `ck_comfy/pipeline.py:41`; `moge/model/dinov2/utils/utils.py:50, 57`).
4. eval / exec / compile: none (only `.eval()` and exec_module of files on disk).
5. Downloaded code: C-RADIO's hf_model.py and 25 siblings run in-process (`ck_comfy/env.py:149-168`, as upstream
   `foundations.py:47-82`); the pinned revision excludes `*.pth.tar` (`download.py:238-241`); config pretrained false,
   initial_checkpoint null, adaptor_names null, so the open_clip / siglip2 / torch.hub paths are not reached; private
   module names and a temporary utils3d shim (`env.py:31-32, 87-116`).
6. Pickles: CK2 from safetensors (`corridorkey/runtime.py:224-234`; the `.pt` branch at :235, weights_only=False,
   unreachable: the combo lists only .safetensors, `paths.py:83-92`); stats from safetensors (`foundations.py:201-203`;
   `.pt` at :205 unreachable); MoGe `torch.load(weights_only=True)` (`moge/model/v2.py:99`, from `env.py:119-122`); RVM
   `np.load(allow_pickle=False)` (`rvm.py:475`); LoRAs from safetensors (`lora.py:120-142`).
7. Obfuscation: none (base64 only for the MD5 compare, `download.py:117-122`; JPGs end at EOI; workflows hold no URLs).
8. Writes: models/corridorkey2 (huggingface_hub's .cache metadata, an RVM .part; `download.py:184-255`); low-VRAM temp
   memmaps deleted in finally (`pipeline.py:374-405, 706-758`; `comfy_utils.py:148-151`); LoRA saves only from the
   Fine-Tune nodes, sanitised names, no overwrite (`train_nodes.py:62-83`, `paths.py:134-142`).
9. Environment: at import `video_io.py:13` setdefault OPENCV_IO_ENABLE_OPENEXR=1; during a download only
   HF_HUB_DISABLE_XET and a mock.patch, restored (`download.py:94-114`); upstream's HF_HUB_OFFLINE setdefault
   (`runtime.py:204-209`) never called (`loader.py:193-238` replaces load_model); ctypes reads GlobalMemoryStatusEx only
   (`comfy_utils.py:63-84`); no registry access.
10. At import: register_model_folders (`model_nodes.py:13`, `lora_nodes.py:11`, `train_nodes.py:20`, `paths.py:54-61`)
    adds keys in memory; the EXR variable; cv2 structuring elements (`matte_ops.py:32-33`).
11. Operational: auto_download default true (`model_nodes.py:42`); the pack evicts other models from VRAM before a key
    (`comfy_utils.py:102-109`, `keying.py:76-78`); the model back to RAM after a run unless keep_on_gpu
    (`loader.py:136-153`).
12. pip: nothing to install or change (all six `>=` pins met: safetensors 0.8.0, einops 0.8.1, timm 1.0.19, scipy 1.15.2,
    opencv-python 4.10.0.84, huggingface_hub 1.27.0); no install.py; transformers 5.15.0, av 17.1.0 present; no utils3d,
    no xformers; Python 3.12.9. Unverified, not a safety point: C-RADIO `extra_models.py:1` imports distutils.version
    (setuptools' shim on 3.12).
13. Licence: LICENSE byte-identical to upstream's (Corridor Key Licence 2.0); the pack code under the same licence
    (`THIRD_PARTY_NOTICES.md:17-20`; GitHub shows NOASSERTION).
14. Vendored diff: at eeee7fa `corridorkey/` (11 files), `third_party/MoGe/` (41 files) and LICENSE blob-identical to
    upstream 485f5e9; at c7662de only `blocks.py:71, 92` add `.to(x.dtype)` (no effect on torch 2.10).
15. Node table against the plan's §2.2: the loader and Basic match; Advanced has no despill / screen / rgba, a FLOAT
    hint_quality, and adds coarse_alpha and decision_matte outputs. Node files: loader `model_nodes.py:28-66`, Basic
    `keyer_basic.py:20-72`, Advanced `keyer_advanced.py:46-164` (unchanged by c7662de).
