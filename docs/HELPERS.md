# In-app helper models (phase 3)

The object tool (hover / click, key O) and layer cutouts run inside the app through
ONNX Runtime (`onnxruntime-node`), no ComfyUI needed. Selection by text (SAM3) still
runs as a ComfyUI helper prompt; when no in-app model is downloaded, objects and
cutouts fall back to the ComfyUI helper prompts too.

## Prompt upsampling through the provider keys (`electron/main/llm.js`)

Besides the ComfyUI language model nodes (Qwen3-VL, the Gemini API node), the
upsample select in the Prompt section lists API vision language models once their key
is stored under Settings › API providers: GPT-5.6 Luna / Terra (OpenAI key, Responses
API, `reasoning.effort: low`), Gemini 3.8 Flash / 3.5 Flash Lite (Google key,
`generateContent`, `thinkingLevel: low` on Gemini 3), Claude Opus 5 / Haiku 4.5
(Anthropic key, Messages API; Anthropic has no image model, so its key row exists for
this alone). The editor sends the same instruction and context crop it builds for the
ComfyUI path (`promptContextCanvas`, long side ≤ 1024, the selection outlined), the
answer lands in the prompt field like the helper prompt's `InpaintCanvasTextOut`
result. "Select by text" with an empty field and a prompt asks the same model for the
object name. Model ids checked on 2026-09-09; none of the three adapters has run
against a live key yet (the wiring was verified up to the providers' "invalid key"
answers). IPC `llm:list` / `llm:ask`, `host.upsampleBackends()`, `host.askLLM()`,
`host.upsampleInApp()`; the sync patches are listed in docs/SYNC.md.

## Modules (`electron/main/onnx/`)

| File | What |
|---|---|
| `runtime.js` | `Runtime`: one `InferenceSession` per model file, created on first use. Providers tried in order: Windows `dml` → `cpu`, Linux `cuda` → `cpu`, macOS `coreml` → `cpu`; `device: "cpu"` skips the GPU. DML sessions get `executionMode: sequential`, `enableMemPattern: false`. `free()` releases every session. `status()` reports what is loaded where and the last failure per provider. |
| `models.js` | The registry (below), lookup in the model folder and its `onnx/`, `sam2/`, `RMBG/`, `BiRefNet/`, `rembg/` subfolders, `Downloader` (Node `fetch`, `.part` files resumed with `Range`, progress events, `Authorization: Bearer <hf token>`, size check against the registry), `remove()`. No Electron imports: `node tools/helpers_test.js` uses it directly. |
| `sam2.js` | `Sam2`: `encode(rgba1024, key)` (cached per key, three embeddings), `decode()` for B prompts, `predict(points, box)` (best of three masks), `automask()`: the SAM2 automatic mask generator with crop_n_layers = 0 and the node's parameters (32 × 32 point grid, batches of 64, pred IoU ≥ 0.8, stability ≥ 0.92 with offset 1.0, box NMS 0.7, min area 0.02 %), masks kept as Int8 quantised logits, painted large to small (the smallest object under the cursor wins) into a `Uint16Array` label map at the requested size by bilinear sampling of the logits. |
| `matting.js` | `Matting`: one 1024 × 1024 RGB in with the model's mean / std, the output tensor of 1024² values (sigmoid applied when the range says it is a logit; RMBG-1.4 already outputs probabilities) → `Uint8Array` alpha. |
| `index.js` | The IPC facade: `status`, `configure({device, dir, sam2, matting})`, `browseDir`, `openFolder`, `download`, `cancel`, `remove`, `free`, `objects`, `segment`, `cutout`. Settings under `helpers` in `settings.json`, the Hugging Face token under `hf-token` in `keys.js`. |

The renderer side is in `renderer/editor/host.js` (`findObjects`, `cutoutInApp`,
`selectPoint`, `segmentPoint`, `refreshHelpers`, `cutoutBackends`) and the editor
patches listed in `docs/SYNC.md`. The renderer scales the source to 1024 × 1024 with
Canvas 2D (squashed, like SAM2's own transform and the ComfyUI RMBG node), sends the
RGBA bytes over IPC, and scales the answer back: the label map comes at ≤ 2048 px long
side and is nearest-scaled to the image; the alpha comes at 1024² and is drawn onto the
layer with smoothing.

## Models (`models.js`)

| id | Files (folder names) | Source | Licence |
|---|---|---|---|
| `sam2_tiny` / `sam2_small` / `sam2_base_plus` / `sam2_large` | `sam2_hiera_<v>.encoder.onnx` + `.decoder.onnx` | `vietanhdev/segment-anything-2-onnx-models` (samexporter) | Apache-2.0 |
| `birefnet_lite` | `birefnet_lite.onnx` (224 MB) | `onnx-community/BiRefNet_lite-ONNX` | MIT |
| `birefnet` | `birefnet.onnx` (973 MB) | `onnx-community/BiRefNet-ONNX` | MIT |
| `rmbg14` | `rmbg14.onnx` (176 MB) | `briaai/RMBG-1.4` | BRIA, non-commercial |
| `rmbg2` | `rmbg2.onnx` (1.02 GB) | `briaai/RMBG-2.0` (gated: accept the licence, save a token) | CC BY-NC 4.0 |

SAM2 tensors: encoder `image` [1,3,1024,1024] (ImageNet mean / std) →
`high_res_feats_0` [1,32,256,256], `high_res_feats_1` [1,64,128,128], `image_embed`
[1,256,64,64]; decoder `point_coords` [B,N,2] in 1024 space, `point_labels` [B,N]
(1 foreground, 0 background, 2 / 3 box corners, -1 padding), `mask_input`
[B,1,256,256], `has_mask_input` [B] → `masks` [B,3,256,256] logits clamped to ±32,
`iou_predictions` [B,3]. All models are the fp32 files; fp16 variants exist on Hugging
Face but their input dtype was not checked.

The ComfyUI `models/sam2` folder holds PyTorch `.safetensors`, not ONNX, so a linked
ComfyUI folder only helps once the ONNX files are downloaded into its `onnx/`
subfolder (which the app does when the folder is a ComfyUI models folder, detected by
a `checkpoints` or `diffusion_models` subfolder).

## Settings › Helpers

Device (auto / GPU / CPU; changing it frees the sessions), the SAM2 model for the
object tool, the model folder (Change folder … / App folder / Open folder), one row per
model with Download (progress bar, Cancel; a `.part` resumes) or Remove, the Hugging
Face token, and a runtime line (ONNX Runtime version, providers tried, what is loaded
on which provider, failures). `host.refreshHelpers()` after a change refreshes the
cutout model lists in every open editor.

## Measured (RTX 5090, DirectML, 2026-09-08)

| Job | Cold (session creation) | Warm |
|---|---|---|
| SAM2 base+ objects, 512 × 384 image | 4.2 s | 1.2 s |
| SAM2 base+ point prompt | | 0.4 s |
| BiRefNet lite cutout | 10 s | 2.5 s |
| RMBG-1.4 cutout | | 0.9 s |

**VRAM pressure:** with ComfyUI holding Flux.2 Klein plus its helper models (29 of
32 GB in use) the same SAM2 run took 125 s: DirectML pages through system memory. After
Free VRAM (which also POSTs `/free` to the server) it was 3.1 s cold and 1.6 s warm.
The status line says so when a GPU run took more than 15 s (`host.slowHelperHint`).
The CPU path is the slow fallback: about 24 s for the SAM2 base+ object map.

`node tools/helpers_test.js [dir] [--sam2 id] [--matting id] [--cpu]` runs a synthetic
image (three shapes on grey) through automask, a point prompt and the matting model
and checks that the shapes come out as distinct objects.

## Not done / ideas

- fp16 model variants (half the download) once their input dtype is verified.
- Box prompts in the object tool (the decoder supports them, `segment` accepts `box`).
- The CUDA provider on Linux needs the CUDA 12 libraries that `onnxruntime-node`
  downloads at install time; untested.
- WebGPU EP (`webgpu`, experimental in onnxruntime-node) as a DirectML alternative.
