# onnx

## Summary

CK2 can be split into ONNX graphs, and two community exports already do it. In-app use is risky past about 1 MP of model input, and the main risk is DirectML, not the export.

- CK2 is five networks, not one. Corridor's ~665M-param keyer (stage 1 + stage 2) builds on three frozen feature models: C-RADIOv4-SO400M, the MoGe-2 ViT-B encoder only, and DeepMind's Recurrent Video MAE. RVM here is not Robust Video Matting, so RVM's official ONNX files do not apply. The weights are 5.07 GB in fp32 and about 2.43 GB in fp16. A still image is the single-frame case.
- Two community ONNX sets exist:
  - Nucito/corridorkey-web (Hugging Face, 2026-10-23): fp16, opset 17, fixed sizes up to 1024×1024, built for onnxruntime-web WebGPU.
  - MarcelineVPQ/corridorkey-desktop (GitHub): any size (multiples of 128), opset 23 with Microsoft's MultiHeadAttention op. Checked against PyTorch on CPU and CUDA only, never on DirectML or WebGPU, and the model files are not published.
- Scumble today: onnxruntime-node 1.29.0 has DirectML and an experimental WebGPU provider on Windows. It has no CUDA or TensorRT on Windows. Loading and running a model block the calling thread, so CK2 would have to run in its own process like LaMa. Scumble has already measured DirectML inflating main-process memory to 24.7 GB on one BiRefNet lite run. DirectML itself gets no new features any more.
- The scaling problem: global attention over the /16 token grid grows with the square of the pixel count. Without a fused attention kernel the score tensors alone are about 0.5 GB at 1024² and about 8.6 GB at 2048².
  - DirectML in ORT 1.29 registers MultiHeadAttention, but whether it is memory-efficient is unknown.
  - The WebGPU provider uses flash attention for that op (read in its source).
  - The opset-23 set would partly fall back to CPU on DirectML, whose kernels stop at version 21.
- Verdict: running in-app is plausible at a working size of about 1024 px. Native 4K and Scumble's 15k are not feasible in-app. CUDA or TensorRT would need a separate native helper program.
- The first spike must measure on this machine, in an Electron utility process, for DirectML, WebGPU and CPU: load success, which nodes fall back to CPU, load time, process memory, VRAM, run time at 1024², the stage-1+2 time for a hint change, a match against PyTorch output, and that release or kill gives the memory back.

## Report

## 1. Bottom line

CK2 can be exported to ONNX, and two community exports already do it. Running it in Scumble's in-app ONNX runtime is **plausible up to about 1 MP of model input, risky beyond that, and not feasible at native 4K or 15k**.

The hard parts are not the export:
- **DirectML.** It inflates memory, it is in maintenance mode, its kernels stop at opset 21, and its memory behaviour for fused attention is unknown.
- **The size scaling.** Global attention at /16 grows with the square of the pixel count.
- **Weight size.** About 2.4 GB fp16, or 4.9 GB fp32 for the CPU path.

Any build has to run in its own utility process, not in Electron's main process.

## 2. Scumble's runtime today (read in F:\canvas)

**Version and providers**
- `onnxruntime-node` ^1.29.0, locked at 1.29.0 (`package.json:38`, `package-lock.json:4468-4469`). npm's latest stable is 1.30.0 (2026-09-14); 1.31 exists only as a dev build ([npm registry](https://registry.npmjs.org/onnxruntime-node)).
- Electron 44.2.0 (`package-lock.json:2416-2417`), which is Chromium 152.0.7977.76 and Node 24.20.0 ([releases.json](https://releases.electronjs.org/releases.json)).
- The prebuilt provider table in `node_modules/onnxruntime-node/README.md`:
  - Windows x64: CPU, DirectML, WebGPU (marked experimental).
  - Linux x64: CPU, WebGPU, CUDA 12. Its text says Linux x64 can also use TensorRT.
  - No CUDA and no TensorRT on Windows.
- The Windows binary ships `DirectML.dll` (18.5 MB), `dxcompiler.dll`/`dxil.dll` and a 28 MB `onnxruntime.dll`. That DLL contains "WebGpuExecutionProvider", Dawn and FlashAttention strings (read with strings), so the WebGPU provider appears to be compiled in.
- `runtime.js:19-24` tries `dml` (Windows), `cuda` (Linux) or `coreml` (macOS), then `cpu`. It never tries `webgpu`, although `PROVIDER_LABELS` lists it (`runtime.js:26`; HELPERS.md:391 lists WebGPU as an idea).

**Sessions**
- One `InferenceSession` per model file, created on first use from a **file path** (`runtime.js:50-71`).
- DirectML sessions use `executionMode: "sequential"` and `enableMemPattern: false`. CPU sessions use `enableCpuMemArena: false` (`runtime.js:54-58`).
- `release(file)` and `free()` dispose sessions (`runtime.js:74-88`). The matting model releases its GPU session after every run (`matting.js:43-44`).

**Threading**
- `createInferenceSessionHandler` and `run` are synchronous native calls wrapped in `setImmediate` (`node_modules/onnxruntime-node/dist/backend.js:44-53, 113-121, 132-138`). While one runs, the calling thread is blocked.
- Every helper except LaMa runs on the main-process thread (HELPERS.md:240-253).
- LaMa runs in an Electron `utilityProcess` (`lama.js:76-86`, `lama_process.js`), because a worker thread killed inside a native call crashed with 0xC0000409 (`lama.js:16-24`).

**Inputs and outputs**
- RGBA `Uint8Array` goes over IPC at the model size (1024² for SAM2 and matting, 512² for LaMa, multiples of 14 for depth). The answers are `Uint8Array` or `Float32Array` (`index.js:197-322`).
- A single IPC message of about 600 MB or more ended the renderer (CLAUDE.md:218, G2).

**Large models**
- Every model is fp32 (HELPERS.md:318-319); fp16 is an open item (HELPERS.md:385).
- There is no external-data model in the registry. Loading by path lets ORT resolve external data relative to the `.onnx` file. This is inferred from the path-based load; it was never run with external data in Scumble.
- `findFile` looks up each file independently across several subfolders (`models.js:78, 89-95`). A `.onnx` and its weights file could therefore be found in different folders, and ORT would then fail to find the weights (inferred).

**Downloader**
- `models.js:240-331`: `.part` file with a `Range` resume, a restart on 416, the Hugging Face token as Bearer, and a final **size check only** (`models.js:326-327`). There is **no sha256 check** in the code; the pinned hashes live only in comments and docs.

**Known DirectML problems**
- LaMa fails on DirectML with 0x80070057 on a MatMul of its Fourier unit (HELPERS.md:285-291).
- Private memory of the process (B5, `docs/BUGS.md:110-119`):

  | Provider | After session load | After first 1024² BiRefNet lite run |
  |---|---|---|
  | DirectML | 1.3 GB | 24.7 GB |
  | CPU with arena | | 9.3 GB (18.2 GB after two runs) |
  | CPU without arena | | 0.37 GB |

  So the "auto" device runs matting on the CPU.
- DirectML recompiles when shapes change. The depth tiles keep fixed sizes for that reason (HELPERS.md:311).

**VRAM next to ComfyUI**
- With ComfyUI holding 29 of 32 GB, SAM2 on DirectML took 125 s; after Free VRAM it took 3.1 s cold (HELPERS.md:370-374).

## 3. What CK2 actually is (corrections to CLAUDE.md item 49)

Source: [nikopueringer/CorridorKey2.0 @485f5e9](https://github.com/nikopueringer/CorridorKey2.0/tree/485f5e9ab759ead6138cc990776184b59d6ea971). The repo was created 2026-07-15 (GitHub API).

**Requirements**
- README:21: an NVIDIA RTX 30 series or newer card, at least 4 GB VRAM up to 1440p, 6 GB for 4K.

**Weights** (sizes from the Hugging Face tree API; parameter counts from the safetensors headers read by range request)

| Part | File | Size | Parameters | Licence |
|---|---|---|---|---|
| Corridor's model | `corridorkey_v2.safetensors` ([HF @cf44a8d](https://huggingface.co/nikopueringer/CorridorKey2.0)) | 2,661,698,720 B, all F32 | 665.4M: stage1 463.6M, stage2 201.8M | Corridor licence |
| C-RADIOv4-SO400M | `model.safetensors` ([HF @c0457f5](https://huggingface.co/nvidia/C-RADIOv4-SO400M)) | 1,724,986,512 B | 431.2M | NVIDIA Open Model License |
| MoGe-2 ViT-B | `model.pt` ([HF @ca5f0e0](https://huggingface.co/Ruicheng/moge-2-vitb-normal)) | 419,110,160 B | | MIT |
| RVM small | `.npz` ([GCS](https://storage.googleapis.com/representations4d/checkpoints/pretrain_rvm_small16_256_204031069.npz)) | 270,086,372 B | 67M in the file, 33M on the path CK2 uses | code Apache-2.0, weights CC-BY 4.0 |

The four together are about 5.07 GB. That **is** the README's "about 5 GB"; it is not 5 GB on top of the three feature models (README:32, `scripts/download_weights.py:28-37`).

**Corrections to item 49**
- **RVM is Recurrent Video MAE from Google DeepMind** ([representations4d](https://github.com/google-deepmind/representations4d)), not Robust Video Matting. The Robust Video Matting ONNX files (rvm_mobilenetv3/resnet50 fp16/fp32, [v1.0.0 release](https://github.com/PeterL1n/RobustVideoMatting/releases/tag/v1.0.0)) are irrelevant here.
  - CK2 carries a PyTorch port: a ViT-S encoder plus a recurrent core of 4 cross-attention blocks with GRU-style gates. Input is [0,1] RGB without normalisation; there is one state per frame (`corridorkey/rvm.py:1-60`, THIRD_PARTY_NOTICES.md).
- **MoGe-2 is ViT-B, and only its DINOv2 encoder is used** (`foundations.py:267-278`), not MoGe's point or normal heads.
- **v1 is 398.8 MB, not ~300 MB.** The safetensors file (HF CorridorKey_v1.0 tree) holds a Hiera base+ `GreenFormer`. It takes 4-channel input (RGB plus the alpha hint, which is required), squashed to 2048×2048 (`CorridorKeyModule/core/model_transformer.py:145-160`, `inference_engine.py:57,241` at [@97e55a4](https://github.com/nikopueringer/CorridorKey/tree/97e55a453060745bead1befd293f6e523c4b845c)).

**The pipeline for a still** (`model.py:1-23`, `runtime.py:283-292`)
1. The picture is reflect-padded to a multiple of 128 (`shape_quantum`, `runtime.py:105`).
2. C-RADIO gets H/4, MoGe gets 7H/32, RVM gets H/4. Each gives features on the /64 grid.
3. Stage 1 takes RGB (sRGB to linear, then signed asinh, `color_utils.py:98-129`), the hint, `hint_quality`, and the three feature maps. It returns a d=512 "baton" at /16 plus an auxiliary output at /2. `hint_quality` is -1 for "decide the subject", 0 for "no hint on this frame" and 1 for a perfect hint (`stage1.py:741`).
4. Stage 2 takes RGB and the baton and returns 4 channels at /1: alpha plus the foreground in asinh space.

A still is the 1/1 window ("each frame is keyed on its own", README:242-243).

**The size problem is in the architecture.** Full global attention over all /16 tokens appears in:
- stage 2: two `FullSpatialBlock2D`, d=1280, 16 heads (`stage2.py:116,120`);
- stage 1's encoder: `FullSpatialBlock3D`, d=512 (`stage1.py:366`; the class is `blocks.py:2388`).

There is an optional query-chunk path for low VRAM (`blocks.py:2442-2452`).

**Upstream VRAM peaks** for a single frame in low-VRAM mode, bf16, with stages swapped on and off the GPU (`runtime.py:134-146`): 2.71 GB at 0.98 MP, 2.80 at 2.21 MP, 2.92 at 3.93 MP, 3.25 GB at 8.36 MP.

**C-RADIO's limit.** It is tested from 256 to 2048 px (its HF README). CK2 feeds it H/4, so the native path tops out around an 8K side (inferred).

**"Real-time hint" (Neex).** The three feature models do not see the hint, so changing the hint re-runs only stage 1 and stage 2 (inferred from `model.py:219-278`). The public repo is CLI only; it has no interactive painting UI (`run_interactive.py`, `infer.py`).

## 4. Existing ONNX and TensorRT exports

| What | Where | Version | Format | Sizes | Notes |
|---|---|---|---|---|---|
| **CK2 web set** | [Nucito/corridorkey-web @1ae72ca](https://huggingface.co/Nucito/corridorkey-web) (2026-10-23) | v2, all 5 parts | fp16 weights, shared per component, as external data (`*.weights`); static-shape graphs per size bucket; **opset 17, default domain only** (read from the file tails); exported by PyTorch 2.9.1 | cradio.weights 862,480,006 B; moge 175,524,992; rvm 66,446,848; stage1 924,066,824; stage2 403,593,480; **about 2.43 GB of weights**; 18 buckets from 384² to 1024²; stage-1 graphs for 1 frame (and 8 frames up to 768) | For ORT-web WebGPU. Inputs/outputs in manifest.json; stage 2's logits come out as float32. README claims an alpha max diff of about 0.002 against PyTorch fp32 (unverified). The license follows Corridor's. With no fused attention op, the attention is decomposed (inferred). |
| **CK2 Rust/ORT engine** | [MarcelineVPQ/corridorkey-desktop @372f042](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/372f0423d29274765a2d1d1b5e84897c0fa440ed/docs/ONNX_EXPORT.md) | v2, all 5 parts | **dynamic** H, W (multiple of 128) and T; opset 23 plus `com.microsoft::MultiHeadAttention` (137 nodes); IR 10; their doc says "ORT ≥ 1.31" | fp32 set 4.87 GB, fp16 set 3.30 GB (C-RADIO keeps 1.72 GB of fp32 weights because pure fp16 failed) | Checked on CPU and CUDA (RTX 5080, Linux) only; **not on DirectML or WebGPU**. Model files are not published, only the export scripts (`engine-rs/export/*.py`). Patches it needed: mask-free shifted windows, every attention 4D, a C-RADIO position-grid fix for portrait inputs, a MoGe position-encoding patch, attention rewritten to MultiHeadAttention, and dropping `value_info` (it made ORT's memory planner hold about 4× the live set). Claimed CUDA fp16 times at 1280×1152: stage 2 53 ms, C-RADIO 4.3 ms/frame, MoGe 1.1, RVM 1.4. All numbers are that repo's claims. |
| v1 fp16 ladder plus TensorRT | [alexandrealvaro/CorridorKey @47c45ae](https://huggingface.co/alexandrealvaro/CorridorKey) | v1 | fp16 ONNX at 512/1024/1536/2048 (145-200 MB), `_ctx` versions, int8, TorchScript-TensorRT | | Ale Alvaro leads the official plugin (CK2 README:11). |
| v1 runtime | [alexandremendoncaalvaro/CorridorKey-Runtime](https://github.com/alexandremendoncaalvaro/CorridorKey-Runtime) (774 stars) | v1 | C++ on ORT: TensorRT RTX provider on RTX 30 and newer; **DirectML experimental**, "AMD: known errors in practice"; CPU rendering retired (help/SUPPORT_MATRIX.md:110-125, 221) | | Shows the official v1 product steered away from DirectML. |
| v1 fp32 | [RaidenOQ/CorridorKey_ONNX @6d365be](https://huggingface.co/RaidenOQ/CorridorKey_ONNX) | v1 | greenformer.onnx | 400.9 MB | |
| v1 OpenVINO | [daniil-lyakhov/CorridorKeyOpenVINO](https://github.com/daniil-lyakhov/CorridorKeyOpenVINO) | v1 | | | |

Feature models on their own:
- C-RADIOv4-SO400M: [ZumaInnovations/C-RADIOv4-SO400M-ONNX @f9d63ab](https://huggingface.co/ZumaInnovations/C-RADIOv4-SO400M-ONNX). fp32, 1.72 GB external data, opset 17, dynamic H and W, output `last_hidden_state` [B, N, 1152]. Not made by NVIDIA. Whether it has the same portrait bug MarcelineVPQ found is unverified.
- MoGe-2: official ONNX exports exist ([docs/onnx.md](https://github.com/microsoft/MoGe/blob/286873bdaa16fe05086ac2e081d6bc87b7523118/docs/onnx.md); `Ruicheng/moge-2-vitb-normal-onnx`, 419 MB). They output points, normal, mask and metric scale, **not the encoder features CK2 needs**, so CK2 needs its own encoder export. MoGe has an `onnx_compatible_mode` (vendored `moge/model/modules.py:100-121`).
- DeepMind RVM: no ONNX export found on Hugging Face or in representations4d. Both CK2 exports handle it; MarcelineVPQ lists it as needing no patch.

ComfyUI packs: `cnoellert/comfyui-corridorkey` and `SeanBRVFX/ComfyUI-CorridorKey` are v1-era. v2 packs exist: `hashu786/ComfyUI-CorridorKey2`, `marawan206/ComfyUI-CorridorKey2.0`, `KoLt-Real/ComfyUI-CorridorKeyV2` (GitHub search, not inspected).

## 5. Can each part be exported, and what breaks

**C-RADIO** (timm `vit_so400m_patch16`)
- In eval, CPE uses bilinear `F.interpolate`; `grid_sample` appears only in the training branch (`vit_patch_generator.py:207-263`).
- Export has been done three times (Zuma, Nucito, MarcelineVPQ).
- Pitfall: Python `if`s get baked in by the trace, which broke portrait inputs (MarcelineVPQ "Portrait").
- Exportable.

**MoGe encoder** (DINOv2 ViT-B)
- The position-encoding interpolation needs a patch for dynamic sizes, or fixed size buckets.
- Antialiased `Resize` is not supported by TensorRT (MarcelineVPQ). CK2 already feeds exactly token_rows×14, so the image resize is an identity (inferred).
- Exportable.

**RVM**
- Plain linear and attention layers plus a bicubic resize of the position table.
- Exportable; both community sets have it.

**Stage 1 and stage 2**
- Ops: Swin and CSwin windows with `torch.roll`, `unfold` halos, reflect pads chosen by a Python branch (sides of 128 px or less fail after export, MarcelineVPQ), RMSNorm, depthwise conv on q/k/v, PixelShuffle, and RoPE normalised to [-1,1] per axis (`rope.py:207-304`).
- Exportable with patches; done twice.
- Main risk: **attention memory.** Without a fused kernel the /16 score tensor grows with the square of the token count:

  | Model input | /16 tokens | Score tensor, stage 2 (16 heads, fp16) | Stage 1 encoder (8 heads) |
  |---|---|---|---|
  | 1024² | 4096 | about 0.54 GB, plus the softmax output | |
  | 2048² | 16,384 | about 8.6 GB | about 4.3 GB |

  These are inferred figures, and they are why the Nucito set stops at 1024 (inferred).
- MarcelineVPQ measured that ONNX `Attention`-23 runs unfused and upcasts in ORT 1.31 on CPU, while `MultiHeadAttention` runs fused.

**Execution providers on Windows**

DirectML:
- In ORT v1.29.0, DML registers `com.microsoft` `Attention` and `MultiHeadAttention` v1 ([OperatorRegistration.cpp:1137-1138](https://github.com/microsoft/onnxruntime/blob/v1.29.0/onnxruntime/core/providers/dml/DmlExecutionProvider/src/Operators/OperatorRegistration.cpp)).
- Its core kernels stop at version 21: Reshape, Squeeze, Transpose, Cast at 21, Shape at 21, which is also marked NotSupported in DML graphs (same file, :795-875, :1090-1109).
  - An **opset-23 graph** (the MarcelineVPQ set) would place version-23 nodes on the CPU (inferred). It would have to be re-exported at opset 21 or lower for DML.
- Whether DML's MultiHeadAttention avoids materialising the scores is unknown.
- An open bug shows DML attention (GroupQueryAttention and MultiHeadAttention) returning wrong logits on RDNA2 ([#29739](https://github.com/microsoft/onnxruntime/issues/29739)).
- DirectML is "in maintenance mode … no new functionality" ([microsoft/DirectML README](https://github.com/microsoft/DirectML)).

WebGPU provider in Node:
- In ORT 1.29 its `MultiHeadAttention` takes a FlashAttention path when `head_size % 4 == 0` ([multihead_attention.cc:116-117](https://github.com/microsoft/onnxruntime/blob/v1.29.0/onnxruntime/contrib_ops/webgpu/bert/multihead_attention.cc), [flash_attention.cc:837-841](https://github.com/microsoft/onnxruntime/blob/v1.29.0/onnxruntime/contrib_ops/webgpu/bert/flash_attention.cc)).
- CK2's head sizes are 64, 96, 80, 72, 64 and 48, all divisible by 4 (inferred from the configs).
- The Node binding has it, but marked experimental (README; maintainer reply in [#26216](https://github.com/microsoft/onnxruntime/issues/26216)).
- In ORT-web: wrong results in Electron on Intel integrated GPUs ([#24442](https://github.com/microsoft/onnxruntime/issues/24442), open), and long GPU-blocking first runs ([#25882](https://github.com/microsoft/onnxruntime/issues/25882)).

## 6. Size, memory and download

**Weights**
- fp32: about 4.9 GB. fp16: about 2.43 GB (Nucito), or 3.30 GB in MarcelineVPQ's set where C-RADIO stays fp32.
- Every graph needs external data: the protobuf limit is 2 GB, and C-RADIO fp32 and stage 1 fp32 are 1.72 and 1.85 GB of weights.
- fp16 on the CPU is slow and upcasts (MarcelineVPQ), so a CPU fallback means a second fp32 download (inferred).

**VRAM** (inferred unless noted)
- Run the parts one after another, as upstream does: foundations, then stage 1, then stage 2.
- Cache the feature maps per picture; they are small. At 2048², 32×32×(1152+768+384) floats is about 9.4 MB.
- For hint editing, keep only stage 1 and 2 loaded: about 1.33 GB of fp16 weights.
- Measured references: upstream PyTorch needs 2.7-3.3 GB for one frame. MarcelineVPQ's CUDA fp16 runs peaked at 5.5 GB for 720p with 8-frame windows (their claim).
- Next to the user's ComfyUI, the paging case above applies (125 s), so Free VRAM or `/free` comes first.

**Process memory**
- B5 measured DirectML in the calling process at about 20× the model's size after one run. With 2.4 GB of weights that could be tens of GB (inferred, unmeasured).
- This is the strongest reason for a utility process that can be killed to give the memory back.

**Load time**
- LaMa's 17k-node graph loads in 7-9 s on the CPU (HELPERS.md:288-290). CK2's graphs are large too: stage-1 graph files are 2.8-25 MB in the Nucito set, and MarcelineVPQ counts 1701 small nodes in stage 1. Expect multi-second loads (inferred).

**Download**
- The existing `Downloader` handles several files per model, resume and the Hugging Face token.
- It needs a sha256 check (Hugging Face tree API LFS oids are available, e.g. `c43596de…` for the CK2 checkpoint).
- The `.onnx` file and its weights file must be kept in the same folder (see the `findFile` per-subfolder lookup).

## 7. Alternatives inside the app

- **onnxruntime-web WebGPU in the renderer** (Chromium 152).
  - Nucito's set is built exactly for this.
  - Downsides: it shares the GPU and memory with the editor's WebGL tiles; the weights pass through the renderer and wasm heap (inferred); the first-run blocking and Intel-in-Electron issues apply; and it adds a renderer dependency (MIT).
  - Could run in a dedicated worker (inferred).
- **WebGPU provider in onnxruntime-node** in a utility process: native, so the weights are read from file, and it has flash MultiHeadAttention. Experimental and untried in Scumble.
- **CUDA or TensorRT through onnxruntime-node on Windows**: not available prebuilt (README table).
  - A realistic route would be a native helper program on the ORT C API with the TensorRT-RTX provider, as CorridorKey-Runtime does. That runtime ships 3.1 GB zips for v1.
  - Or a Linux-only CUDA path; Scumble's Linux build skips the CUDA provider (HELPERS.md:386-390).
  - Large engineering either way.

## 8. Verdicts

| Part | In-app ONNX verdict | Evidence |
|---|---|---|
| RVM-small (DeepMind) | **Feasible** | Plain ViT and GRU core; 66 MB fp16; both sets export it with no patch |
| MoGe-2 ViT-B encoder | **Feasible** | DINOv2 with an ONNX mode; re-export needed, the official ONNX lacks the features; 176/351 MB |
| C-RADIOv4-SO400M | **Feasible, mildly risky** | Exported three times; position-grid trace pitfall; 0.86-1.72 GB; fp16 error mean 1e-3 (MarcelineVPQ) |
| Stage 1 + 2 at ≤ about 1 MP | **Risky** | Exportable (two sets); DirectML untested; DML kernels stop at opset 21; DML memory blow-up measured in Scumble; decomposed attention about 1 GB of transients at 1024² |
| Stage 1 + 2 at 2-4 MP | **Risky to not feasible** | Needs fused attention: DirectML unknown, WebGPU flash in source (experimental) |
| Native 4K or 15k picture | **Not feasible in-app** | Quadratic attention plus C-RADIO's 2048 limit at H/4; would need downscale-and-refine or tiling, a product question |
| Whole pipeline | **Spike first.** Plausible at a working size of about 1024 px on DirectML or WebGPU in a utility process, about 2.4 GB fp16 download. CUDA/TensorRT not possible in-app on Windows. | above |

## 9. What the first spike must prove (a measurement session, no app code)

1. **The set to test.** Nucito's fp16 1024² bucket (about 2.43 GB of weights plus graphs; download only on the user's yes). Optionally a self-made opset ≤ 21 export with MultiHeadAttention, using MarcelineVPQ's `engine-rs/export` scripts on a torch machine.
2. **Per provider (dml, webgpu, cpu), in an Electron `utilityProcess` under Electron's Node:**
   - that the session is created at all, including DirectML or WebGPU device creation inside a utility process;
   - which nodes land on the CPU (ORT verbose placement log);
   - load seconds;
   - private bytes after load and after one run;
   - VRAM from nvidia-smi;
   - run time per part at 1024², T=1, with and without a hint.
3. **Parity** against a PyTorch reference of the same still and size. Suggested thresholds: alpha MAE ≤ 1e-3, max ≤ 0.02, no NaN or Inf.
4. **The hint loop**: stage 1 + 2 time with cached features, to test "pretty instant".
5. **Size ladder** 768 → 1024 → 1536 → 2048. Record how each step fails: out of memory, a device-removed error, or a CPU fallback.
6. **Release, kill and cancel** give the VRAM and private bytes back. Check this with the user's ComfyUI idle or after Free VRAM; it is a production machine.
7. **Go/no-go**: if DirectML fails or swells memory and WebGPU is not stable, the in-app route stops at "CPU at a small size" and the ComfyUI recipe route wins.

## Facts

- [read] Scumble pins onnxruntime-node ^1.29.0 (locked 1.29.0) and Electron ^44.2.0 (locked 44.2.0). (F:\canvas\package.json:38,44; F:\canvas\package-lock.json:2416-2417,4468-4469)
- [read] Electron 44.2.0 ships Chromium 152.0.7977.76 and Node 24.20.0. (https://releases.electronjs.org/releases.json)
- [read] onnxruntime-node's latest npm stable release is 1.30.0 (2026-09-14); 1.31 exists only as a dev tag. (https://registry.npmjs.org/onnxruntime-node)
- [read] The prebuilt onnxruntime-node table lists CPU, DirectML and WebGPU (experimental) on Windows x64, and CUDA only on Linux x64; its text says Linux x64 can also use TensorRT. There is no CUDA or TensorRT on Windows. (F:\canvas\node_modules\onnxruntime-node\README.md (EP table and GPU Support section))
- [inferred] The Windows onnxruntime.dll of 1.29.0 contains WebGpuExecutionProvider, Dawn and FlashAttention strings, so the WebGPU EP appears compiled in. (F:\canvas\node_modules\onnxruntime-node\bin\napi-v6\win32\x64\onnxruntime.dll (strings))
- [read] Scumble's Runtime tries dml (Windows), cuda (Linux) or coreml (macOS), then cpu; it never tries webgpu although PROVIDER_LABELS lists it. (F:\canvas\electron\main\onnx\runtime.js:19-26)
- [read] DirectML sessions get executionMode sequential and enableMemPattern false; CPU sessions get enableCpuMemArena false; sessions are created from a file path. (F:\canvas\electron\main\onnx\runtime.js:50-71)
- [read] onnxruntime-node's session creation and run are synchronous native calls wrapped in setImmediate, so they block the calling thread. (F:\canvas\node_modules\onnxruntime-node\dist\backend.js:44-53,113-121,132-138; docs/HELPERS.md:240-247)
- [read] All helpers except LaMa run on the main-process thread; LaMa runs in an Electron utilityProcess because killing a worker thread inside a native ORT call crashed with 0xC0000409. (F:\canvas\docs\HELPERS.md:240-253; F:\canvas\electron\main\onnx\lama.js:16-24,76-86)
- [read] Scumble's Downloader resumes .part files with Range, restarts on 416, sends the HF token as Bearer, and verifies only the file size; there is no sha256 check in code. (F:\canvas\electron\main\onnx\models.js:292-331)
- [read] On DirectML, one 1024x1024 BiRefNet lite run grew the process's private bytes from 1.3 GB to 24.7 GB; on the CPU without the arena it stayed at 0.37 GB. (F:\canvas\docs\BUGS.md:110-119)
- [read] LaMa fails on DirectML (onnxruntime-node 1.29) at a MatMul of its Fourier unit with 0x80070057 and runs CPU-only. (F:\canvas\docs\HELPERS.md:285-291; electron/main/onnx/lama.js:11-14)
- [read] With ComfyUI holding 29 of 32 GB of VRAM, a SAM2 run on DirectML took 125 s; after Free VRAM it took 3.1 s cold. (F:\canvas\docs\HELPERS.md:370-374)
- [read] The CK2 repo is nikopueringer/CorridorKey2.0 (created 2026-07-15, last commit 485f5e9 on 2026-10-15); it needs an RTX 30-series or newer card with at least 4 GB of VRAM up to 1440p and 6 GB for 4K. (https://github.com/nikopueringer/CorridorKey2.0/blob/485f5e9ab759ead6138cc990776184b59d6ea971/README.md#L21-L23; GitHub API repo metadata)
- [read] corridorkey_v2.safetensors is 2,661,698,720 bytes, all F32, with 665.4M parameters (stage1 463.6M, stage2 201.8M); its metadata lists the required VFMs C-RADIOv4-SO400M, MoGe-2-ViT-B and RVM-small, shape_quantum 128. (https://huggingface.co/nikopueringer/CorridorKey2.0 (tree API, safetensors header via range request, revision cf44a8db3f024bb49fd59daa408848ccf05f7477))
- [read] The foundation weights are C-RADIOv4-SO400M model.safetensors 1,724,986,512 B (431.2M params), MoGe-2 ViT-B model.pt 419,110,160 B, and RVM small npz 270,086,372 B; with CK2's checkpoint they total about 5.07 GB. (HF tree API for nvidia/C-RADIOv4-SO400M@c0457f5 and Ruicheng/moge-2-vitb-normal@ca5f0e0; HEAD of storage.googleapis.com/representations4d/checkpoints/pretrain_rvm_small16_256_204031069.npz)
- [read] CK2's 'RVM' is Google DeepMind's Recurrent Video MAE from representations4d, not Robust Video Matting; CK2 carries a PyTorch port (ViT-S encoder plus a 4-block gated cross-attention recurrent core). (https://github.com/nikopueringer/CorridorKey2.0/blob/485f5e9ab759ead6138cc990776184b59d6ea971/THIRD_PARTY_NOTICES.md; corridorkey/rvm.py:1-60)
- [read] Robust Video Matting (PeterL1n) has official ONNX releases (mobilenetv3 and resnet50, fp16 and fp32), which do not apply to CK2. (https://github.com/PeterL1n/RobustVideoMatting/releases/tag/v1.0.0)
- [read] CK2 uses only MoGe-2's DINOv2 encoder features (moge.encoder), not MoGe's point or normal heads. (https://github.com/nikopueringer/CorridorKey2.0/blob/485f5e9ab759ead6138cc990776184b59d6ea971/corridorkey/foundations.py#L267-L278)
- [read] C-RADIO gets an H/4 input, MoGe 7H/32 and RVM H/4; all three give /64 features; inputs are reflect-padded to a multiple of 128. (corridorkey/model.py:1-23, runtime.py:105,283-292 at nikopueringer/CorridorKey2.0@485f5e9)
- [read] Stage 2 contains two FullSpatialBlock2D (global attention over all /16 tokens, d=1280, 16 heads), and stage 1's encoder uses FullSpatialBlock3D at /16. (corridorkey/stage2.py:116,120; stage1.py:366; blocks.py:2388-2462 at nikopueringer/CorridorKey2.0@485f5e9)
- [read] Upstream single-frame low-VRAM peak VRAM is 2.71 GB at 0.98 MP, rising to 3.25 GB at 8.36 MP (bf16, phased GPU swapping). (corridorkey/runtime.py:134-146 at nikopueringer/CorridorKey2.0@485f5e9)
- [read] hint_quality is -1 for 'decide the subject', 0 for 'no frame hint' and 1 for a perfect hint. (corridorkey/stage1.py:741 at nikopueringer/CorridorKey2.0@485f5e9)
- [inferred] A hint change needs only stage 1 and stage 2 re-run; the three foundation features can be cached per picture. (corridorkey/model.py:219-278 (foundations take RGB only))
- [inferred] C-RADIOv4-SO400M is only tested at 256-2048 px inputs, so CK2's native path (C-RADIO at H/4) is bounded near an 8K side. (https://huggingface.co/nvidia/C-RADIOv4-SO400M README (lines 66, 231); CK2 foundations.py)
- [read] Nucito/corridorkey-web (2026-10-23) publishes a full CK2 fp16 ONNX set for ONNX Runtime Web WebGPU: per-component .weights (cradio 862,480,006 B, moge 175,524,992, rvm 66,446,848, stage1 924,066,824, stage2 403,593,480; about 2.43 GB) and static graphs per bucket from 384x384 to 1024x1024, including 1-frame stage-1 graphs. (https://huggingface.co/Nucito/corridorkey-web (revision 1ae72ca7270b4fb2f64e98b5c3cc6e6ee4103957, README.md, manifest.json, tree API))
- [read] Nucito's graphs were produced by PyTorch 2.9.1, import only the default ONNX domain at opset 17, and have float32 graph outputs (logits, feat). (Head and tail bytes (range requests) of stage2_512x512.onnx, stage1_512x512_t1.onnx and cradio_512x512.onnx at Nucito/corridorkey-web@1ae72ca)
- [unverified] Nucito's README claims an fp16 vs PyTorch fp32 alpha max diff of about 0.002 on a real plate. (https://huggingface.co/Nucito/corridorkey-web README.md)
- [read] MarcelineVPQ/corridorkey-desktop documents a dynamic-shape CK2 ONNX set (opset 23 plus com.microsoft MultiHeadAttention, 137 nodes; fp32 4.87 GB, fp16 3.30 GB with C-RADIO weights kept fp32), checked against PyTorch on CPU and CUDA (RTX 5080, Linux) only. The files are not published; the export scripts are in engine-rs/export. (https://github.com/MarcelineVPQ/corridorkey-desktop/blob/372f0423d29274765a2d1d1b5e84897c0fa440ed/docs/ONNX_EXPORT.md)
- [unverified] MarcelineVPQ reports that ONNX Attention-23 runs unfused (and upcasts fp16) in ORT 1.31 on CPU, while com.microsoft MultiHeadAttention runs fused; and that the exporter's value_info made ORT's memory-reuse planner hold about 4x the live set. (corridorkey-desktop docs/ONNX_EXPORT.md 'Attention memory' @372f042)
- [unverified] MarcelineVPQ reports CUDA fp16 GPU times at 1280x1152: stage 2 53.4 ms per frame, C-RADIO 4.3 ms per frame, MoGe 1.1, RVM 1.4; and a peak of 5478 MiB VRAM for 720p 8/4 windows. (corridorkey-desktop docs/ENGINE_RUST.md and docs/ONNX_EXPORT.md @372f042)
- [read] Exporting CK2 needed patches: mask-free shifted windows, 4D SDPA only, a C-RADIO position-grid fix (portrait inputs failed), a MoGe position-encoding patch; a 128 px side still fails stage 1's reflect pad after export. (corridorkey-desktop docs/ONNX_EXPORT.md (Portrait, Per-network export notes) @372f042)
- [read] MoGe-2 has official ONNX exports (vits/vitb/vitl, fp32, dynamic resolution), but they output points, normal, mask and metric_scale, not the encoder features CK2 needs. (https://github.com/microsoft/MoGe/blob/286873bdaa16fe05086ac2e081d6bc87b7523118/docs/onnx.md; https://huggingface.co/Ruicheng/moge-2-vitb-normal-onnx (419,411,850 B))
- [read] A third-party C-RADIOv4-SO400M ONNX exists: fp32, 1,724,948,928 B external data, opset 17, dynamic H and W, output last_hidden_state [B,N,1152]. (https://huggingface.co/ZumaInnovations/C-RADIOv4-SO400M-ONNX (revision f9d63ab9566d9eb534fc3f15820ab7197930f04c))
- [read] C-RADIO's eval position-embedding path uses bilinear interpolate; grid_sample appears only in the training branch. (https://huggingface.co/nvidia/C-RADIOv4-SO400M/blob/c0457f5dc26ca145f954cd4fc5bb6114e5705ad8/vit_patch_generator.py (lines 207-263))
- [read] In ORT v1.29.0 the DirectML EP registers com.microsoft Attention and MultiHeadAttention v1, but its core kernels such as Reshape, Squeeze, Transpose and Cast are registered only up to version 21. (https://github.com/microsoft/onnxruntime/blob/v1.29.0/onnxruntime/core/providers/dml/DmlExecutionProvider/src/Operators/OperatorRegistration.cpp (lines 795-875, 1090-1094, 1137-1138))
- [inferred] An opset-23 graph would put its version-23 nodes on the CPU EP under DirectML; a DML-targeted export should use opset 21 or lower. (DML OperatorRegistration.cpp v1.29.0 plus the ONNX opset 23 op version bumps)
- [read] The ORT 1.29 WebGPU EP's MultiHeadAttention uses FlashAttention when the QKV are not packed, head sizes match and head_size % 4 == 0. (https://github.com/microsoft/onnxruntime/blob/v1.29.0/onnxruntime/contrib_ops/webgpu/bert/multihead_attention.cc#L116-L117; flash_attention.cc#L837-L841)
- [read] DirectML is in maintenance mode: no new features, only security and compliance fixes; Windows ML is recommended on Windows 11 24H2 or later. (https://github.com/microsoft/DirectML (README))
- [read] A maintainer confirmed the WebGPU EP is supported in onnxruntime-node. (https://github.com/microsoft/onnxruntime/issues/26216)
- [read] ORT-web WebGPU gave wrong predictions in Electron on Intel integrated GPUs (issue open). (https://github.com/microsoft/onnxruntime/issues/24442)
- [read] The DirectML EP gave wrong attention (GQA/MHA) logits on an RDNA2 Xbox Series S while the CPU EP was correct. (https://github.com/microsoft/onnxruntime/issues/29739)
- [read] The v1-based CorridorKey-Runtime ships TensorRT RTX EP as its official Windows path; DirectML is experimental with 'known errors in practice' on AMD; CPU rendering is retired. (https://github.com/alexandremendoncaalvaro/CorridorKey-Runtime/blob/main/help/SUPPORT_MATRIX.md (lines 110-125, 221))
- [read] v1 (GreenFormer) is a Hiera base+ model of 398,849,256 B (safetensors), taking a 4-channel RGB plus alpha-hint input squashed to 2048x2048. (https://huggingface.co/nikopueringer/CorridorKey_v1.0 tree API; nikopueringer/CorridorKey@97e55a4 CorridorKeyModule/core/model_transformer.py:145-160, inference_engine.py:57,241)
- [inferred] Without a fused attention kernel the /16 score tensors are about 0.54 GB at 1024² and about 8.6 GB at 2048² for stage 2 (16 heads, fp16), so a decomposed-attention export is practically capped near 1 MP. (Arithmetic from CK2 config (d_stage2 1280, 16 heads, /16 tokens))
- [inferred] Running CK2's 2.4-4.9 GB of weights in Electron's main process would block IPC for seconds and risks the DirectML private-memory blow-up, so a utilityProcess like LaMa's is required. (backend.js sync calls; BUGS.md:110-119; lama.js:16-24)

## Open questions

- Does a DirectML session (and a WebGPU EP session) get created at all inside an Electron utilityProcess with onnxruntime-node 1.29 or 1.30?
- How much private memory and VRAM does the DirectML EP hold for CK2's parts? Is it many times the weight size, as with BiRefNet lite (B5)?
- Does DirectML's MultiHeadAttention kernel avoid materialising the score matrix, i.e. how large a model input does DirectML reach before it runs out of memory or the device is removed?
- Which nodes of Nucito's opset-17 graphs fall back to the CPU on DirectML, and how long do the session loads take?
- Does the experimental WebGPU EP in onnxruntime-node run the full CK2 set correctly (parity with PyTorch) on the user's RTX card and on non-NVIDIA cards?
- Do MarcelineVPQ's opset-23 files load in onnxruntime-node 1.29/1.30 at all? Their doc says ORT >= 1.31, which is not a stable npm release.
- Should Scumble use Nucito's third-party fp16 set (fixed sizes up to 1024, licence 'other') or build and host its own export (MarcelineVPQ's scripts, opset <= 21, MultiHeadAttention, dynamic or bucketed shapes)? Hosting converted weights must keep Corridor's licence terms, NVIDIA's Open Model License notice and DeepMind's CC-BY attribution.
- What working resolution is acceptable for the product, given Scumble's 15k documents (CK2 at reduced size plus an alpha/fg upscale or refinement, versus tiling, which breaks the global attention)?
- Is 'the alpha hint works in real time' (Neex) true on DirectML or WebGPU at about 1 MP, i.e. what does a stage-1+2 re-run cost with cached foundation features?
- A CPU fallback needs the fp32 set (4.87 GB). Is a second download acceptable, and how many seconds per megapixel does it take on the user's 24-thread CPU?
- Should the downloader gain a sha256 check (Hugging Face LFS oids are available) before multi-GB model files are added?
